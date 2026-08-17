## Working on it

The app is one file. The core - CSV parse/serialise plus the action state
machine - lives in `<script id="core">` and is DOM-free. The test harness pulls
that block out of the HTML and runs it in Node, so the tests exercise the exact
bytes that ship rather than a copy that could drift.

```
node tests/run.js            # run everything
node tests/run.js --update   # rewrite the golden outputs, then read the diff
```

No dependencies, no install step. `--update` is deliberate: the diff it produces
is the review.

- `tests/fixtures/` - small synthetic plans, one per real plan shape, with
  invented BCNs and site codes. Together they pin down that no behaviour is
  keyed on an optional column by name.
- `tests/golden/*.json` - scripted action sequences. Each produces a plan CSV
  and an event log CSV that are byte-compared.
- `real-data/` - the real day files, untracked. When present, the harness also
  loads and walks each one as a smoke test. When absent it skips silently.
- `tests/smoke-ui.js` - drives a whole session through the UI script on a stub
  DOM: load, start, confirm, undo, redo, white reference, reconcile a mismatch,
  discard, jump, export. `run.js` spawns it in its own process. It is a stub and
  not a browser, so it proves the wiring runs, not that anything renders or that
  a thumb can reach it.

### If a tablet fails

Built for current Chrome on Android. The shipped file already avoids arrow
functions, `const`/`let`, template literals, optional chaining, `async`, `fetch`
and CSS grid, so most of the fallback list in the spec is already satisfied.

What is left, in the order worth suspecting if an old device misbehaves:

1. `Object.assign` - the one ES2015 library function used. A guarded shim is
   about five lines.
2. CSS custom properties (`var(--…)`) - would need inlining, and dark mode is
   built on them, so it would have to go or be rebuilt as a second stylesheet.
3. `clamp()` in font sizes - already written with a plain fallback declared
   first, so a parser that does not understand it keeps a usable size.
4. `env(safe-area-inset-bottom)` - degrades to zero padding on its own.

Do not pre-emptively downgrade any of these. Test on the oldest tablet in the
cupboard first and fix only what actually breaks.
