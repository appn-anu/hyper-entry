'use strict';
// Drives a real session through the UI script on a stub DOM: load a plan,
// start, confirm, undo, redo, white reference, reconcile a mismatch, discard,
// jump, export.
//
// This is a stub, not a browser. It proves the wiring runs and the handlers do
// what they say - not that anything renders, or that a thumb can reach it. The
// layout still needs a real device. Run on its own, or via tests/run.js, which
// spawns it in its own process so its global stubs stay out of everything else.

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(REPO, 'svc-fieldnotes.html'), 'utf8');

// ---- tiny DOM ----------------------------------------------------------
let nodes = new Map();

function makeNode(id, tag) {
  const node = {
    id: id || '', tagName: (tag || 'div').toUpperCase(),
    children: [], attrs: {}, _text: '', className: '', value: '',
    listeners: {}, files: null, style: {}, offsetTop: 0, firstChild: null,
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); this.children = []; this.firstChild = null; },
    set innerHTML(v) { this._text = String(v); },
    appendChild(child) { this.children.push(child); this.firstChild = this.children[0]; return child; },
    removeChild(child) {
      this.children = this.children.filter(c => c !== child);
      this.firstChild = this.children[0] || null;
      return child;
    },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    removeAttribute(k) { delete this.attrs[k]; },
    hasAttribute(k) { return k in this.attrs; },
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    dispatchEvent(ev) {
      (this.listeners[ev.type] || []).forEach(fn => fn(ev));
    },
    click() { this.dispatchEvent({ type: 'click', target: this }); },
    focus() {}, select() {}, setSelectionRange() {}
  };
  return node;
}

// Every id in the markup becomes a node.
const idRe = /\sid="([^"]+)"/g;
let m;
while ((m = idRe.exec(html)) !== null) {
  if (m[1] === 'core' || m[1] === 'ui') { continue; }
  nodes.set(m[1], makeNode(m[1]));
}
// #sheet ships hidden.
['sheet', 'screen-main', 'resume-box', 'start-error', 'card-wr', 'card-filled', 'card-comment']
  .forEach(id => nodes.get(id).setAttribute('hidden', ''));

const docEl = makeNode('html', 'html');
global.document = {
  documentElement: docEl,
  getElementById: id => nodes.get(id) || null,
  createElement: tag => makeNode('', tag),
  createTextNode: t => ({ _text: t, textContent: t }),
  execCommand: () => true
};

const store = {};
global.window = {
  addEventListener: () => {},
  localStorage: {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; }
  },
  URL: { createObjectURL: () => 'blob:fake' },
  matchMedia: () => ({ matches: false }),
  location: { reload: () => { throw new Error('reload called'); } }
};
global.Blob = function (parts) { this.parts = parts; };
global.setTimeout = (fn) => fn();

// FileReader that hands back whatever text we queue up.
let queuedText = '';
global.FileReader = function () {
  this.readAsText = function () {
    this.result = queuedText;
    if (this.onload) { this.onload(); }
  };
};

// ---- load the two scripts ----------------------------------------------
const core = html.match(/<script id="core">([\s\S]*?)<\/script>/)[1];
const ui = html.match(/<script id="ui">([\s\S]*?)<\/script>/)[1];
new Function('module', 'globalThis', core)({ exports: {} }, global.window);
new Function(ui)();

// ---- drive it -----------------------------------------------------------
function check(label, condition, detail) {
  if (condition) { console.log('  ok    ' + label); return true; }
  console.log('  FAIL  ' + label + (detail ? ' -> ' + detail : ''));
  process.exitCode = 1;
  return false;
}

queuedText = fs.readFileSync(path.join(REPO, 'tests/fixtures/plan-a.csv'), 'utf8');
const fileInput = nodes.get('file-input');
fileInput.files = [{ name: 'plan-a.csv' }];
fileInput.dispatchEvent({ type: 'change', target: fileInput });

check('file loads and enables start', nodes.get('btn-start').disabled === false);
check('summary mentions the row count',
  /8 rows/.test(nodes.get('file-summary').textContent), nodes.get('file-summary').textContent);

nodes.get('in-start').value = '85';
nodes.get('in-date').value = '2026-08-18';
nodes.get('in-prefix').value = 'KLN300';
nodes.get('in-subfolder').value = 'day1';
nodes.get('in-wr-consumes').checked = true;
nodes.get('btn-start').click();

check('main screen shown', !nodes.get('screen-main').hasAttribute('hidden'));
check('next file shows the start number', nodes.get('next-file-num').textContent === '85',
  nodes.get('next-file-num').textContent);
check('status strip shows the plate and progress',
  nodes.get('status-plate').textContent === 'Plate 1' &&
  nodes.get('status-progress').textContent === '0/4',
  nodes.get('status-plate').textContent + ' ' + nodes.get('status-progress').textContent);
check('card leads with row and range',
  /row/.test(nodes.get('card-lead').children.map(c => c._text || c.textContent).join('')),
  JSON.stringify(nodes.get('card-lead').children.map(c => c._text)));
check('next-up line rendered', /next up:/.test(nodes.get('next-up').textContent),
  nodes.get('next-up').textContent);

// Confirm is debounced at 300ms, so drive it with the clock moved on.
let clock = 100000;
const realNow = Date.now;
Date.now = () => (clock += 500);

nodes.get('btn-confirm').click();
check('confirm advances the counter', nodes.get('next-file-num').textContent === '86',
  nodes.get('next-file-num').textContent);
check('progress moves', nodes.get('status-progress').textContent === '1/4',
  nodes.get('status-progress').textContent);
check('undo became available', nodes.get('btn-undo').disabled === false);
check('autosave wrote a session', !!store['svc-fieldnotes.session.v1']);

nodes.get('btn-undo').click();
check('undo puts the number back', nodes.get('next-file-num').textContent === '85',
  nodes.get('next-file-num').textContent);
check('redo became available', nodes.get('btn-redo').disabled === false);
nodes.get('btn-redo').click();
check('redo re-applies', nodes.get('next-file-num').textContent === '86',
  nodes.get('next-file-num').textContent);

// White reference asks which file it actually is - that step is the reconcile.
nodes.get('btn-wr').click();
check('WR opens a sheet', !nodes.get('sheet').hasAttribute('hidden'));
check('sheet asks about the white reference',
  nodes.get('sheet-title').textContent === 'White reference',
  nodes.get('sheet-title').textContent);
const wrBody = nodes.get('sheet-body');
const wrInput = wrBody.children.find(c => c.className === 'big-input');
check('WR prefills the expected number', wrInput && wrInput.value === '86',
  wrInput && wrInput.value);

// The WR was re-taken twice, so it is really 88 - 86 and 87 are unaccounted.
wrInput.value = '88';
wrBody.children.find(c => c.textContent === 'CONFIRM WR').click();
check('confirming the WR moves the counter past it',
  nodes.get('next-file-num').textContent === '89', nodes.get('next-file-num').textContent);
check('sheet closed after the WR', nodes.get('sheet').hasAttribute('hidden'));
check('no reconcile prompt follows the WR', nodes.get('sheet').hasAttribute('hidden'));

// Discard is one tap now.
nodes.get('btn-discard').click();
check('discard burns a number without asking',
  nodes.get('next-file-num').textContent === '90', nodes.get('next-file-num').textContent);
check('discard opened no sheet', nodes.get('sheet').hasAttribute('hidden'));

// Reconcile is still available on demand from the big number. There is no
// CHECK step: the verdict and the resync button follow the field as it types.
nodes.get('next-file').click();
check('tapping NEXT FILE opens reconcile',
  nodes.get('sheet-title').textContent === 'Reconcile', nodes.get('sheet-title').textContent);
const recBody = nodes.get('sheet-body');
const recInput = recBody.children.find(c => c.className === 'big-input');
const recActions = recBody.children[recBody.children.length - 1];
check('opens on the expected number as a match',
  !!recActions.children.find(c => c.textContent === 'BACK TO WORK'),
  recBody.children.map(c => c.textContent).join(' | ') +
    ' :: ' + recActions.children.map(c => c.textContent).join(' | '));
recInput.value = '93';
recInput.dispatchEvent({ type: 'input', target: recInput });
const resyncBtn = recActions.children.find(c => /LOG 3 DISCARDS/.test(c.textContent));
check('typing a different number offers to log the gap on the spot', !!resyncBtn,
  recActions.children.map(c => c.textContent).join(' | '));
resyncBtn.click();
check('resync moves the counter', nodes.get('next-file-num').textContent === '93',
  nodes.get('next-file-num').textContent);

// Jump list.
nodes.get('btn-menu').click();
nodes.get('sheet-body').children.find(c => c.textContent === 'Jump to a row').click();
const jumpRows = nodes.get('sheet-body').children.filter(c => /jump-row/.test(c.className));
check('jump list has one row per plan row', jumpRows.length === 8, String(jumpRows.length));
check('jump button is the first child of a row',
  jumpRows[0].children[0].textContent === 'GO');
jumpRows[5].children[0].click();
check('jumping moves the cursor',
  /15/.test(nodes.get('card-lead').children.map(c => c._text).join('')),
  JSON.stringify(nodes.get('card-lead').children.map(c => c._text)));

// Export.
nodes.get('btn-menu').click();
nodes.get('sheet-body').children.find(c => c.textContent === 'Export').click();
const blocks = nodes.get('sheet-body').children.filter(c => c.className === 'export-block');
check('export offers three files', blocks.length === 3, String(blocks.length));
const planText = blocks[0].children.find(c => c.tagName === 'TEXTAREA').value;
// Row 0 was confirmed as 85 (the start number); the counter then moved on.
check('exported plan carries the confirmed number',
  planText.split('\n')[1].split(',')[4] === '85',
  planText.split('\n')[1]);
check('exported plan stamps meta on the captured row only',
  planText.split('\n')[1].indexOf('KLN300') !== -1 &&
  planText.split('\n')[2].indexOf('KLN300') === -1,
  planText.split('\n').slice(1, 3).join(' || '));
check('every export block has a download and a text box',
  blocks.every(b => b.children.some(c => c.className && /dl/.test(c.className)) &&
                    b.children.some(c => c.tagName === 'TEXTAREA')));
check('filenames are timestamped',
  blocks.every(b => /_\d{8}-\d{6}\./.test(b.children.find(c => c.attrs && c.attrs.download).attrs.download)),
  blocks.map(b => (b.children.find(c => c.attrs && c.attrs.download) || {}).attrs.download).join(' '));

// Dark mode: start-screen checkbox and the in-session menu toggle drive the
// same setting, and it persists apart from the session.
check('theme starts light', docEl.getAttribute('data-theme') === null,
  docEl.getAttribute('data-theme'));
nodes.get('in-dark').checked = true;
nodes.get('in-dark').dispatchEvent({ type: 'change', target: nodes.get('in-dark') });
check('dark mode sets the theme attribute', docEl.getAttribute('data-theme') === 'dark');
check('dark mode persists', store['svc-fieldnotes.theme'] === 'dark');

nodes.get('btn-menu').click();
const themeBtn = nodes.get('sheet-body').children.find(c => /Dark mode:/.test(c.textContent));
check('menu shows the current theme', themeBtn.textContent === 'Dark mode: ON',
  themeBtn.textContent);
themeBtn.click();
check('menu toggle turns it back off', docEl.getAttribute('data-theme') === null &&
  themeBtn.textContent === 'Dark mode: OFF', themeBtn.textContent);
nodes.get('btn-sheet-close').click();

Date.now = realNow;
console.log(process.exitCode ? '\nsmoke test FAILED' : '\nsmoke test passed');
