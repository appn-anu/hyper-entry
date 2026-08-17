'use strict';

// Loads the core straight out of the shipped HTML file.
//
// The no-build rule applies to the artifact, not to the tests: rather than
// keeping a second copy of the logic in a .js file that could drift, we pull
// the <script id="core"> block out of svc-fieldnotes.html and evaluate it.
// The tests therefore exercise the exact bytes that ship.
//
// It runs as a Function in this realm rather than in a vm context, so the
// arrays and objects it returns are the same intrinsics the assertions use -
// cross-realm values fail deepStrictEqual even when they match. `Date` and
// `globalThis` come in as parameters, which shadows the real ones: that is how
// the clock gets stubbed without touching the host global.

const fs = require('node:fs');
const path = require('node:path');

const HTML_PATH = path.join(__dirname, '..', 'svc-fieldnotes.html');
const CORE_RE = /<script id="core">([\s\S]*?)<\/script>/;

const RealDate = Date;

// Timestamps have to be deterministic or the golden event logs never match.
// One fake second per instantiation, from a fixed epoch.
function makeFakeDate(epochMs) {
  let ticks = 0;
  function FakeDate() {
    const ms = epochMs + ticks * 1000;
    ticks += 1;
    const real = new RealDate(ms);
    this.toISOString = function () { return real.toISOString(); };
    this.getTime = function () { return ms; };
    this.valueOf = function () { return ms; };
  }
  FakeDate.now = function () { return epochMs + ticks * 1000; };
  return FakeDate;
}

function readCoreSource() {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const match = html.match(CORE_RE);
  if (!match) {
    throw new Error('No <script id="core"> block found in ' + HTML_PATH);
  }
  return match[1];
}

// Each call returns a fresh module with a fresh clock, so tests cannot leak
// state into one another. The Function body is this repo's own HTML file - the
// artifact under test - and nothing is interpolated into it.
function loadCore(opts) {
  opts = opts || {};
  const epoch = opts.epoch === undefined ? RealDate.UTC(2026, 7, 18, 6, 0, 0) : opts.epoch;
  const factory = new Function('module', 'Date', 'globalThis', readCoreSource());
  const shim = { module: { exports: {} }, root: {} };
  factory(shim.module, makeFakeDate(epoch), shim.root);
  return shim.module.exports;
}

module.exports = { loadCore, readCoreSource, HTML_PATH };
