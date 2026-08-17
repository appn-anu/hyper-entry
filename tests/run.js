'use strict';

// node tests/run.js            run everything
// node tests/run.js --update   rewrite the golden outputs from current behaviour
//
// Golden files are byte-compared, same pattern as the SVC QC pipeline corpus.
// Regenerate them deliberately and read the diff - that diff is the review.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { loadCore } = require('./core.js');

const FIXTURES = path.join(__dirname, 'fixtures');
const GOLDEN = path.join(__dirname, 'golden');
const REAL_DATA = path.join(__dirname, '..', 'real-data');
const UPDATE = process.argv.indexOf('--update') !== -1;

let passed = 0;
let failed = 0;
let updated = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ok    ' + name);
  } catch (err) {
    failed += 1;
    console.log('  FAIL  ' + name);
    console.log(String(err.stack || err).split('\n').slice(0, 8)
      .map(function (l) { return '        ' + l; }).join('\n'));
  }
}

function section(name) { console.log('\n' + name); }

function fixtureText(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

function session(Core, fixture, opts) {
  opts = opts || {};
  const parsed = Core.parseCSV(fixtureText(fixture));
  return Core.createSession({
    fileName: fixture,
    parsed: parsed,
    config: opts.config,
    meta: opts.meta
  });
}

// ------------------------------------------------------------------ CSV ----

section('CSV');

test('round-trips a plain fixture byte for byte', function () {
  const Core = loadCore();
  ['plan-a.csv', 'plan-b.csv', 'plan-c.csv', 'plan-partial.csv'].forEach(function (name) {
    const text = fixtureText(name);
    const parsed = Core.parseCSV(text);
    const out = Core.serializeCSV(parsed.header, parsed.rows, {
      eol: parsed.eol,
      trailingNewline: parsed.trailingNewline
    });
    assert.equal(out, text, name + ' did not round-trip');
  });
});

test('preserves CRLF and LF as found', function () {
  const Core = loadCore();
  assert.equal(Core.parseCSV(fixtureText('plan-a.csv')).eol, '\r\n');
  assert.equal(Core.parseCSV(fixtureText('plan-c.csv')).eol, '\n');
});

test('parses quoted fields, embedded commas, quotes and newlines', function () {
  const Core = loadCore();
  const parsed = Core.parseCSV(fixtureText('plan-odd.csv'));
  assert.equal(parsed.rows.length, 3);
  assert.equal(parsed.rows[0].comments, 'leaf was wet, wiped it');
  assert.equal(parsed.rows[0].notes_from_agronomist, 'said "check the tips", then left');
  assert.equal(parsed.rows[1].comments, 'line one\nline two');
  assert.equal(parsed.rows[2].glasshouse_bay, 'Bay 4, north end');
});

test('a comment with commas, quotes and newlines survives export and re-import', function () {
  const Core = loadCore();
  const state = session(Core, 'plan-a.csv');
  const nasty = 'wind gust, "maybe"\nre-scanned after';
  Core.setComment(state, nasty);
  const out = Core.exportPlanCSV(state);
  const back = Core.parseCSV(out);
  assert.equal(back.rows[0].comments, nasty);
  assert.deepEqual(back.header, state.header);
});

test('always quotes comments on output', function () {
  const Core = loadCore();
  const state = session(Core, 'plan-a.csv');
  Core.setComment(state, 'plain');
  const line = Core.exportPlanCSV(state).split('\r\n')[1];
  assert.ok(line.indexOf('"plain"') !== -1, 'comment was not quoted: ' + line);
});

test('keeps an unknown column verbatim through export', function () {
  const Core = loadCore();
  const state = session(Core, 'plan-odd.csv');
  Core.confirm(state);
  const out = Core.parseCSV(Core.exportPlanCSV(state));
  assert.ok(out.header.indexOf('glasshouse_bay') !== -1);
  assert.equal(out.rows[2].glasshouse_bay, 'Bay 4, north end');
  assert.equal(out.rows[0].notes_from_agronomist, 'said "check the tips", then left');
});

test('tolerates a BOM and a short final row', function () {
  const Core = loadCore();
  const parsed = Core.parseCSV('﻿FileNum,Date,Prefix,Subfolder,BCN\n,,,,41207\n,,,\n');
  assert.deepEqual(parsed.header, ['FileNum', 'Date', 'Prefix', 'Subfolder', 'BCN']);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[1].BCN, '');
});

// -------------------------------------------------------------- loading ----

section('Loading');

test('rejects a file missing a required column', function () {
  const Core = loadCore();
  const parsed = Core.parseCSV('row,BCN,Date,Prefix,Subfolder\n1,41207,,,\n');
  assert.throws(function () {
    Core.createSession({ parsed: parsed });
  }, function (err) {
    return err.code === 'MISSING_COLUMNS' && err.missing.join() === 'FileNum';
  });
});

test('starts the counter at config.startFileNum on a fresh plan', function () {
  const Core = loadCore();
  const state = session(Core, 'plan-a.csv', { config: { startFileNum: 85 } });
  assert.equal(state.nextFileNum, 85);
  assert.equal(state.cursor, 0);
  assert.equal(state.needsReconcile, false);
});

test('resumes a partly-filled plan after the highest number, and asks to reconcile', function () {
  const Core = loadCore();
  const state = session(Core, 'plan-partial.csv');
  assert.equal(state.nextFileNum, 104);
  assert.equal(state.cursor, 3);
  assert.equal(state.needsReconcile, true, 'a partly-filled load must prompt a reconcile');
  // Meta and WR standing above the cursor are picked up, not rewritten.
  assert.equal(state.meta.Prefix, 'KLN300');
  assert.equal(state.meta.Date, '2026-08-14');
  assert.equal(state.currentWR, 100);
});

test('does not rewrite tracked values that already stand above the cursor', function () {
  const Core = loadCore();
  const state = session(Core, 'plan-partial.csv');
  Core.confirm(state);
  assert.equal(state.plan[3].Prefix, '', 'Prefix was rewritten where it had not changed');
  assert.equal(state.plan[3].WRNum, '', 'WRNum was rewritten where it had not changed');
  assert.equal(state.plan[3].FileNum, '104');
});

// -------------------------------------------------------------- actions ----

section('Actions');

test('confirm assigns the displayed number and advances to the next unfilled row', function () {
  const Core = loadCore();
  const state = session(Core, 'plan-a.csv', {
    config: { startFileNum: 85 },
    meta: { Date: '2026-08-18', Prefix: 'KLN300', Subfolder: 'day1' }
  });
  Core.confirm(state);
  assert.equal(state.plan[0].FileNum, '85');
  assert.equal(state.nextFileNum, 86);
  assert.equal(state.cursor, 1);
  // Session-start meta lands on the first captured row.
  assert.equal(state.plan[0].Date, '2026-08-18');
  assert.equal(state.plan[0].Prefix, 'KLN300');
  Core.confirm(state);
  assert.equal(state.plan[1].FileNum, '86');
  // ...and nowhere else. Downstream forward-fills.
  assert.equal(state.plan[1].Date, '');
  assert.equal(state.plan[1].Prefix, '');
});

test('confirm refuses a filled row', function () {
  const Core = loadCore();
  const state = session(Core, 'plan-a.csv');
  Core.confirm(state);
  Core.jumpTo(state, 0);
  assert.throws(function () { Core.confirm(state); }, function (e) { return e.code === 'ROW_FILLED'; });
});

test('discard burns a number and leaves the cursor alone', function () {
  const Core = loadCore();
  const state = session(Core, 'plan-a.csv', { config: { startFileNum: 85 } });
  Core.discard(state, 'bad scan');
  assert.equal(state.nextFileNum, 86);
  assert.equal(state.cursor, 0);
  assert.equal(state.plan[0].FileNum, '');
  const ev = state.events[state.events.length - 1];
  assert.equal(ev.action, 'discard');
  assert.equal(ev.file_num, '85');
  assert.equal(ev.note, 'bad scan');
});

test('discard as the very first action of a session', function () {
  const Core = loadCore();
  const state = session(Core, 'plan-a.csv', { config: { startFileNum: 0 } });
  Core.discard(state, '');
  Core.confirm(state);
  assert.equal(state.plan[0].FileNum, '1');
  assert.equal(state.events.length, 2);
});

test('white reference consumes a number and stamps WRNum on the next confirm only', function () {
  const Core = loadCore();
  const state = session(Core, 'plan-a.csv', { config: { startFileNum: 85 } });
  Core.whiteRef(state);
  assert.equal(state.currentWR, 85);
  assert.equal(state.nextFileNum, 86);
  Core.confirm(state);
  assert.equal(state.plan[0].WRNum, '85');
  Core.confirm(state);
  assert.equal(state.plan[1].WRNum, '', 'WRNum should only be written where it changes');
});

test('wrConsumesFileNumber:false leaves the counter alone', function () {
  const Core = loadCore();
  const state = session(Core, 'plan-a.csv', {
    config: { startFileNum: 85, wrConsumesFileNumber: false }
  });
  Core.whiteRef(state);
  assert.equal(state.nextFileNum, 85);
  assert.equal(state.currentWR, null);
  Core.confirm(state);
  assert.equal(state.plan[0].FileNum, '85');
  assert.equal(state.plan[0].WRNum, '');
});

test('white reference immediately followed by a discard', function () {
  const Core = loadCore();
  const state = session(Core, 'plan-a.csv', { config: { startFileNum: 85 } });
  Core.whiteRef(state);
  Core.discard(state, 'shutter');
  Core.confirm(state);
  assert.equal(state.plan[0].FileNum, '87');
  assert.equal(state.plan[0].WRNum, '85');
  assert.deepEqual(state.events.map(function (e) { return e.action; }),
    ['white_ref', 'discard', 'confirm']);
});

test('overwrite reassigns a filled row and logs the number it displaced', function () {
  const Core = loadCore();
  const state = session(Core, 'plan-a.csv', { config: { startFileNum: 85 } });
  Core.confirm(state);
  Core.confirm(state);
  Core.jumpTo(state, 0);
  Core.overwrite(state);
  assert.equal(state.plan[0].FileNum, '87');
  assert.equal(state.nextFileNum, 88);
  const ev = state.events[state.events.length - 1];
  assert.equal(ev.action, 'overwrite');
  assert.equal(ev.note, 'discarded 85');
  // Cursor lands on the next unfilled row, not back where it started.
  assert.equal(state.cursor, 2);
});

test('overwrite refuses an empty row', function () {
  const Core = loadCore();
  const state = session(Core, 'plan-a.csv');
  assert.throws(function () { Core.overwrite(state); }, function (e) { return e.code === 'ROW_EMPTY'; });
});

test('comment lands on the current row and is logged', function () {
  const Core = loadCore();
  const state = session(Core, 'plan-a.csv');
  Core.setComment(state, 'aphids on the flag leaf');
  assert.equal(state.plan[0].comments, 'aphids on the flag leaf');
  assert.equal(state.cursor, 0);
  assert.equal(state.events[0].action, 'comment');
});

test('a mid-session meta change lands on the current row only', function () {
  const Core = loadCore();
  const state = session(Core, 'plan-c.csv', {
    config: { startFileNum: 10 },
    meta: { Date: '2026-08-18', Prefix: 'TLN30', Subfolder: 'block1' }
  });
  Core.confirm(state);
  Core.confirm(state);
  Core.setMeta(state, { Subfolder: 'block2' });
  Core.confirm(state);
  assert.equal(state.plan[0].Subfolder, 'block1');
  assert.equal(state.plan[1].Subfolder, '');
  assert.equal(state.plan[2].Subfolder, 'block2');
  assert.equal(state.plan[3].Subfolder, '');
  // Date and Prefix did not change, so they stay where they were first written.
  assert.equal(state.plan[2].Prefix, '');
  assert.equal(state.plan[0].Prefix, 'TLN30');
});

test('back-filling a skipped row does not rewrite what the rows below it impute', function () {
  const Core = loadCore();
  const state = session(Core, 'plan-a.csv', {
    config: { startFileNum: 85 },
    meta: { Date: '2026-08-18', Prefix: 'KLN300', Subfolder: 'day1' }
  });
  Core.whiteRef(state);            // WR 85
  Core.confirm(state);             // row 0 <- 86, WRNum 85
  Core.moveCursor(state, 1);       // skip row 1, come back later
  Core.confirm(state);             // row 2 <- 87, still under WR 85
  Core.whiteRef(state);            // WR 88
  Core.confirm(state);             // row 3 <- 89, WRNum 88
  Core.jumpTo(state, 1);
  Core.confirm(state);             // back-fill row 1 <- 90, under WR 88

  assert.equal(state.plan[1].WRNum, '88');
  // Row 2 was captured under WR 85 and must still read that way after the
  // back-fill, not inherit 88 from the row above it.
  assert.equal(state.plan[2].WRNum, '85', 'row 2 lost the WR it was captured under');
  assert.equal(state.plan[3].WRNum, '88');
});

test('a meta change while walking forward stays sparse', function () {
  const Core = loadCore();
  const state = session(Core, 'plan-a.csv', {
    config: { startFileNum: 85 },
    meta: { Date: '2026-08-18', Prefix: 'KLN300', Subfolder: 'day1' }
  });
  Core.confirm(state);
  Core.confirm(state);
  Core.setMeta(state, { Subfolder: 'day1b' });
  Core.confirm(state);
  Core.confirm(state);
  // Only the first row and the row where it changed carry a value.
  assert.deepEqual(state.plan.map(function (r) { return r.Subfolder; }),
    ['day1', '', 'day1b', '', '', '', '', '']);
});

test('navigation moves the cursor without touching numbers or the log', function () {
  const Core = loadCore();
  const state = session(Core, 'plan-a.csv', { config: { startFileNum: 85 } });
  Core.moveCursor(state, 1);
  Core.moveCursor(state, 1);
  Core.moveCursor(state, -1);
  assert.equal(state.cursor, 1);
  assert.equal(state.nextFileNum, 85);
  assert.equal(state.events.length, 0);
  assert.equal(state.undoStack.length, 0);
  Core.moveCursor(state, -50);
  assert.equal(state.cursor, 0);
  Core.moveCursor(state, 500);
  assert.equal(state.cursor, state.plan.length - 1);
});

// ---------------------------------------------------------- undo / redo ----

section('Undo and redo');

test('undo reverses a confirm completely, log entry included', function () {
  const Core = loadCore();
  const state = session(Core, 'plan-a.csv', {
    config: { startFileNum: 85 },
    meta: { Date: '2026-08-18', Prefix: 'KLN300', Subfolder: 'day1' }
  });
  Core.confirm(state);
  Core.undo(state);
  assert.equal(state.plan[0].FileNum, '');
  assert.equal(state.plan[0].Date, '', 'the stamped meta should be reversed too');
  assert.equal(state.nextFileNum, 85);
  assert.equal(state.cursor, 0);
  assert.equal(state.events.length, 0, 'an undone action leaves no log entry');
});

test('redo re-applies exactly and restores the log entry', function () {
  const Core = loadCore();
  const state = session(Core, 'plan-a.csv', { config: { startFileNum: 85 } });
  Core.confirm(state);
  const before = Core.exportPlanCSV(state);
  Core.undo(state);
  Core.redo(state);
  assert.equal(Core.exportPlanCSV(state), before);
  assert.equal(state.nextFileNum, 86);
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].action, 'confirm');
});

test('a new action clears the redo stack', function () {
  const Core = loadCore();
  const state = session(Core, 'plan-a.csv', { config: { startFileNum: 85 } });
  Core.confirm(state);
  Core.confirm(state);
  Core.undo(state);
  assert.equal(Core.canRedo(state), true);
  Core.discard(state, 'thumb');
  assert.equal(Core.canRedo(state), false);
  assert.equal(Core.redo(state), null);
});

test('overwrite then undo restores the displaced number', function () {
  const Core = loadCore();
  const state = session(Core, 'plan-a.csv', { config: { startFileNum: 85 } });
  Core.confirm(state);
  Core.confirm(state);
  Core.jumpTo(state, 0);
  const before = Core.exportPlanCSV(state);
  Core.overwrite(state);
  Core.undo(state);
  assert.equal(Core.exportPlanCSV(state), before);
  assert.equal(state.plan[0].FileNum, '85');
  assert.equal(state.nextFileNum, 87);
  assert.equal(state.events.length, 2);
});

test('undo across a plate boundary', function () {
  const Core = loadCore();
  const state = session(Core, 'plan-a.csv', { config: { startFileNum: 85 } });
  for (let i = 0; i < 5; i++) { Core.confirm(state); }
  assert.equal(state.plan[4].plate, 'Plate 2');
  assert.equal(state.cursor, 5);
  Core.undo(state);
  assert.equal(state.plan[4].FileNum, '');
  assert.equal(state.cursor, 4);
  assert.equal(Core.progress(state).label, 'Plate 2');
  assert.equal(Core.progress(state).done, 0);
});

test('undo depth holds at least 20 actions', function () {
  const Core = loadCore();
  const state = session(Core, 'plan-c.csv', { config: { startFileNum: 0 } });
  for (let i = 0; i < 25; i++) { Core.discard(state, 'noise ' + i); }
  assert.ok(state.undoStack.length >= 20, 'undo stack too shallow: ' + state.undoStack.length);
  for (let j = 0; j < 20; j++) { Core.undo(state); }
  assert.equal(state.nextFileNum, 5);
});

// ------------------------------------------------------------ reconcile ----

section('Reconciliation');

test('a matching reconcile just logs and clears the flag', function () {
  const Core = loadCore();
  const state = session(Core, 'plan-partial.csv');
  const check = Core.reconcileCheck(state, 104);
  assert.equal(check.match, true);
  Core.reconcile(state, 104, 'accept');
  assert.equal(state.needsReconcile, false);
  assert.equal(state.events[0].action, 'reconcile');
  assert.equal(state.events[0].note, 'match');
});

test('an unaccounted gap becomes N discards plus a resync', function () {
  const Core = loadCore();
  const state = session(Core, 'plan-a.csv', { config: { startFileNum: 186 } });
  const check = Core.reconcileCheck(state, 189);
  assert.deepEqual(
    { gap: check.gap, kind: check.kind },
    { gap: 3, kind: 'unaccounted' }
  );
  Core.reconcile(state, 189, 'accept');
  assert.equal(state.nextFileNum, 189);
  const actions = state.events.map(function (e) { return e.action; });
  assert.deepEqual(actions, ['discard', 'discard', 'discard', 'reconcile']);
  assert.deepEqual(state.events.slice(0, 3).map(function (e) { return e.file_num; }),
    ['186', '187', '188']);
});

test('the app running ahead of the instrument is reported, not silently fixed', function () {
  const Core = loadCore();
  const state = session(Core, 'plan-a.csv', { config: { startFileNum: 190 } });
  assert.equal(Core.reconcileCheck(state, 188).kind, 'app_ahead');
  Core.reconcile(state, 188, 'note');
  assert.equal(state.nextFileNum, 190, 'note must not move the counter');
  assert.ok(state.events[0].note.indexOf('not resynced') !== -1);
});

test('a reconcile is one undoable action, discards and all', function () {
  const Core = loadCore();
  const state = session(Core, 'plan-a.csv', { config: { startFileNum: 186 } });
  Core.reconcile(state, 189, 'accept');
  Core.undo(state);
  assert.equal(state.nextFileNum, 186);
  assert.equal(state.events.length, 0);
});

// ----------------------------------------------------------- validation ----

section('Validation');

test('flags duplicates, backwards numbers and blanks', function () {
  const Core = loadCore();
  const state = session(Core, 'plan-a.csv', { config: { startFileNum: 85 } });
  Core.confirm(state);
  Core.confirm(state);
  state.plan[1].FileNum = '85';           // duplicate, and backwards
  const codes = Core.validate(state).map(function (w) { return w.code; });
  assert.ok(codes.indexOf('duplicate_file_num') !== -1, codes.join());
  assert.ok(codes.indexOf('non_monotonic') !== -1, codes.join());
  assert.ok(codes.indexOf('blank_file_num') !== -1, codes.join());
});

test('flags meta that was never set, and stops once it is', function () {
  const Core = loadCore();
  const state = session(Core, 'plan-a.csv');
  let codes = Core.validate(state).map(function (w) { return w.code; });
  assert.ok(codes.indexOf('meta_never_set') !== -1);
  Core.setMeta(state, { Date: '2026-08-18', Prefix: 'KLN300', Subfolder: 'day1' });
  codes = Core.validate(state).map(function (w) { return w.code; });
  assert.equal(codes.indexOf('meta_never_set'), -1);
});

test('a clean full walk produces no warnings', function () {
  const Core = loadCore();
  const state = session(Core, 'plan-a.csv', {
    config: { startFileNum: 85 },
    meta: { Date: '2026-08-18', Prefix: 'KLN300', Subfolder: 'day1' }
  });
  for (let i = 0; i < state.plan.length; i++) { Core.confirm(state); }
  assert.deepEqual(Core.validate(state), []);
});

test('plate row counts are only checked when a plate column exists', function () {
  const Core = loadCore();
  const withPlate = session(Core, 'plan-a.csv');
  withPlate.plan.pop();                    // Plate 2 now has 3 rows, Plate 1 has 4
  const codes = Core.validate(withPlate).map(function (w) { return w.code; });
  assert.ok(codes.indexOf('plate_row_count') !== -1, codes.join());

  const noPlate = session(Core, 'plan-c.csv');
  const codes2 = Core.validate(noPlate).map(function (w) { return w.code; });
  assert.equal(codes2.indexOf('plate_row_count'), -1);
});

// -------------------------------------------------------- view helpers ----

section('View helpers');

test('progress is per-plate when a plate column exists, global otherwise', function () {
  const Core = loadCore();
  const plated = session(Core, 'plan-a.csv', { config: { startFileNum: 85 } });
  Core.confirm(plated);
  const p = Core.progress(plated);
  assert.deepEqual({ label: p.label, done: p.done, total: p.total, scoped: p.scoped },
    { label: 'Plate 1', done: 1, total: 4, scoped: true });

  const flat = session(Core, 'plan-c.csv', { config: { startFileNum: 0 } });
  Core.confirm(flat);
  const q = Core.progress(flat);
  assert.deepEqual({ label: q.label, done: q.done, total: q.total, scoped: q.scoped },
    { label: '', done: 1, total: 5, scoped: false });
});

test('row and range lead the card, and BCN sits in the key=value block', function () {
  const Core = loadCore();
  const state = session(Core, 'plan-a.csv');
  const id = Core.rowIdentity(state, 4);
  assert.deepEqual(id.lead.map(function (p) { return p.key + ' ' + p.value; }),
    ['row 11', 'range 1']);
  const keys = id.fields.map(function (f) { return f.key; });
  assert.ok(keys.indexOf('BCN') !== -1, keys.join());
  assert.equal(keys.indexOf('FileNum'), -1, 'capture columns are not identity');
  assert.equal(keys.indexOf('Prefix'), -1, 'tracked columns are not identity');
});

test('empty identity values are omitted', function () {
  const Core = loadCore();
  const state = session(Core, 'plan-c.csv');
  const keys = Core.rowIdentity(state, 0).fields.map(function (f) { return f.key; });
  assert.equal(keys.indexOf('tech_rep'), -1, 'tech_rep is empty throughout this plan shape');
  assert.ok(keys.indexOf('ecotype') !== -1, keys.join());
});

test('a plan with no row or range column still gets a lead field', function () {
  const Core = loadCore();
  const parsed = Core.parseCSV('FileNum,Date,Prefix,Subfolder,BCN\n,,,,41207\n');
  const state = Core.createSession({ parsed: parsed });
  const id = Core.rowIdentity(state, 0);
  assert.deepEqual(id.lead.map(function (p) { return p.key; }), ['BCN']);
});

// ------------------------------------------------------------ event log ----

section('Event log');

test('the log carries identity columns alongside each action', function () {
  const Core = loadCore();
  const state = session(Core, 'plan-a.csv', { config: { startFileNum: 85 } });
  Core.confirm(state);
  const header = Core.eventLogHeader(state);
  assert.deepEqual(header.slice(0, 5),
    ['timestamp', 'action', 'file_num', 'plan_row_index', 'note']);
  assert.ok(header.indexOf('BCN') !== -1);
  const parsed = Core.parseCSV(Core.exportEventsCSV(state));
  assert.equal(parsed.rows[0].action, 'confirm');
  assert.equal(parsed.rows[0].file_num, '85');
  assert.equal(parsed.rows[0].plan_row_index, '0');
  assert.equal(parsed.rows[0].BCN, '41207');
});

// -------------------------------------------------------------- session ----

section('Session JSON');

test('a session round-trips through JSON', function () {
  const Core = loadCore();
  const state = session(Core, 'plan-a.csv', { config: { startFileNum: 85 } });
  Core.confirm(state);
  Core.whiteRef(state);
  Core.setComment(state, 'quoted, "thing"\nnewline');
  const restored = Core.importSessionJSON(Core.exportSessionJSON(state));
  assert.equal(Core.exportPlanCSV(restored), Core.exportPlanCSV(state));
  assert.equal(Core.exportEventsCSV(restored), Core.exportEventsCSV(state));
  assert.equal(restored.nextFileNum, state.nextFileNum);
  assert.equal(restored.currentWR, state.currentWR);
});

test('resume mid-plate, then keep working and export', function () {
  const Core = loadCore();
  const state = session(Core, 'plan-a.csv', {
    config: { startFileNum: 85 },
    meta: { Date: '2026-08-18', Prefix: 'KLN300', Subfolder: 'day1' }
  });
  Core.confirm(state);
  Core.confirm(state);
  const saved = Core.exportSessionJSON(state);

  const resumed = Core.importSessionJSON(saved);
  Core.confirm(resumed);
  Core.undo(resumed);
  Core.confirm(resumed);
  assert.equal(resumed.plan[2].FileNum, '87');
  assert.equal(resumed.nextFileNum, 88);
  assert.equal(resumed.events.length, 3);
});

test('a session from another version is refused', function () {
  const Core = loadCore();
  assert.throws(function () { Core.importSessionJSON('{"version":99}'); },
    function (e) { return e.code === 'BAD_SESSION'; });
});

// ------------------------------------------------------------ UI wiring ----

// The UI script cannot be unit-tested without a DOM, but the failure that
// actually bites - a getElementById id that no longer exists in the markup -
// is catchable statically, and silently breaks the app when it happens.

section('UI wiring');

test('every element the UI reaches for exists in the markup', function () {
  const html = fs.readFileSync(path.join(__dirname, '..', 'svc-fieldnotes.html'), 'utf8');
  const ui = html.match(/<script id="ui">([\s\S]*?)<\/script>/);
  assert.ok(ui, 'no <script id="ui"> block');

  const ids = new Set();
  const idRe = /\$\('([^']+)'\)/g;
  let m;
  while ((m = idRe.exec(ui[1])) !== null) { ids.add(m[1]); }
  assert.ok(ids.size > 10, 'suspiciously few element lookups: ' + ids.size);

  const declared = new Set();
  const declRe = /\sid="([^"]+)"/g;
  while ((m = declRe.exec(html)) !== null) { declared.add(m[1]); }

  const missing = [...ids].filter(function (id) { return !declared.has(id); });
  assert.deepEqual(missing, [], 'UI looks up ids that are not in the markup');
});

test('the shipped file is self-contained', function () {
  const html = fs.readFileSync(path.join(__dirname, '..', 'svc-fieldnotes.html'), 'utf8');
  const external = html.match(/(src|href)\s*=\s*"(?!#)[^"]*"/g) || [];
  assert.deepEqual(external, [], 'external reference in a single-file app');
  assert.equal(/\bfetch\s*\(/.test(html), false, 'no network requests, ever');
  assert.equal(/@import|url\(\s*http/.test(html), false, 'external CSS reference');
});

// --------------------------------------------------------------- golden ----

section('Golden files');

const ACTIONS = {
  confirm: function (C, s) { return C.confirm(s); },
  overwrite: function (C, s) { return C.overwrite(s); },
  discard: function (C, s, reason) { return C.discard(s, reason); },
  whiteRef: function (C, s) { return C.whiteRef(s); },
  comment: function (C, s, text) { return C.setComment(s, text); },
  meta: function (C, s, meta) { return C.setMeta(s, meta); },
  reconcile: function (C, s, actual, choice) { return C.reconcile(s, actual, choice); },
  undo: function (C, s) { return C.undo(s); },
  redo: function (C, s) { return C.redo(s); },
  next: function (C, s) { return C.moveCursor(s, 1); },
  last: function (C, s) { return C.moveCursor(s, -1); },
  jump: function (C, s, index) { return C.jumpTo(s, index); }
};

function runScript(script) {
  const Core = loadCore();
  const state = session(Core, script.fixture, {
    config: script.config,
    meta: script.meta
  });
  script.actions.forEach(function (step, i) {
    const name = step[0];
    const fn = ACTIONS[name];
    if (!fn) { throw new Error('unknown action "' + name + '" at step ' + i); }
    fn.apply(null, [Core, state].concat(step.slice(1)));
  });
  return { Core: Core, state: state };
}

function goldenCompare(name, suffix, actual) {
  const file = path.join(GOLDEN, name + suffix);
  if (UPDATE || !fs.existsSync(file)) {
    fs.writeFileSync(file, actual);
    updated += 1;
    return;
  }
  const expected = fs.readFileSync(file, 'utf8');
  if (expected !== actual) {
    const eLines = expected.split(/\r?\n/);
    const aLines = actual.split(/\r?\n/);
    let at = 0;
    while (at < eLines.length && eLines[at] === aLines[at]) { at += 1; }
    throw new Error(
      name + suffix + ' differs at line ' + (at + 1) + '\n' +
      '  expected: ' + JSON.stringify(eLines[at]) + '\n' +
      '  actual:   ' + JSON.stringify(aLines[at])
    );
  }
}

const scripts = fs.readdirSync(GOLDEN)
  .filter(function (f) { return /\.json$/.test(f); })
  .sort();

if (!scripts.length) {
  console.log('  (no golden scripts found in ' + GOLDEN + ')');
}

scripts.forEach(function (file) {
  const name = file.replace(/\.json$/, '');
  test(name, function () {
    const script = JSON.parse(fs.readFileSync(path.join(GOLDEN, file), 'utf8'));
    const run = runScript(script);
    goldenCompare(name, '.plan.csv', run.Core.exportPlanCSV(run.state));
    goldenCompare(name, '.events.csv', run.Core.exportEventsCSV(run.state));
  });
});

// ---------------------------------------------------------- real data ----

section('Real plan files (skipped when real-data/ is absent)');

if (fs.existsSync(REAL_DATA)) {
  fs.readdirSync(REAL_DATA)
    .filter(function (f) { return /\.csv$/i.test(f); })
    .sort()
    .forEach(function (file) {
      test(file + ' loads and walks', function () {
        const Core = loadCore();
        const text = fs.readFileSync(path.join(REAL_DATA, file), 'utf8');
        const parsed = Core.parseCSV(text);
        assert.deepEqual(Core.missingRequired(parsed.header), [],
          'missing required columns');
        const state = Core.createSession({
          fileName: file,
          parsed: parsed,
          config: { startFileNum: 1 },
          meta: { Date: '2026-08-18', Prefix: 'X', Subfolder: 'y' }
        });
        assert.ok(state.plan.length > 0);
        // Untouched, the plan must come back out exactly as it went in.
        assert.equal(Core.exportPlanCSV(state), text);
        for (let i = 0; i < state.plan.length; i++) { Core.confirm(state); }
        assert.deepEqual(Core.validate(state), []);
        assert.equal(state.nextFileNum, state.plan.length + 1);
      });
    });
} else {
  console.log('  skip  real-data/ not present');
}

// ---------------------------------------------------------------- done ----

console.log('\n' + passed + ' passed, ' + failed + ' failed' +
  (updated ? ', ' + updated + ' golden file(s) written' : ''));
process.exit(failed ? 1 : 0);
