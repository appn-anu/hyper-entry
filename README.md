# SVC Field Notes

A single-file web app for recording SVC spectroradiometer file numbers against a
pre-planned measurement list. Replaces the Excel field-notes sheet.

The point of it: **the operator should almost never type a file number.** The app
tracks the counter, the operator confirms or says what went wrong.

See [`svc-fieldnotes-spec.md`](svc-fieldnotes-spec.md) for the reasoning behind
every decision here. This file is just how to run it.

## Using it

Copy `svc-fieldnotes.html` onto the phone or tablet and open it from local
storage. No server, no network, no install. It never makes a network request.

1. Load the day's plan CSV. It needs `FileNum`, `Date`, `Prefix` and `Subfolder`
   columns - a missing one is the app's only hard stop.
2. Enter the date, prefix, subfolder, and the first file number the instrument
   will write.
3. Walk the plan. **CONFIRM** assigns the big number on screen to the current
   row and moves on.

| Button | When |
|---|---|
| CONFIRM | The scan you just took belongs to this row |
| OVERWRITE | Same button on a row that already has a number - reassigns it deliberately |
| WR | White reference taken. Burns a file number and asks you to reconcile |
| DISCARD | The scan was junk. Burns the number, stays on the row |
| NOTE | Free text into the `comments` column |
| UNDO / REDO | At least 20 actions deep, and undo leaves no trace in the log |
| LAST / NEXT | Move the cursor only - for skipping a row and coming back |
| NEXT FILE (the big number) | Tap to reconcile against the instrument any time |

Set the device's screen timeout to never before a session.

### Reconcile

The highest-value thing in the app after CONFIRM. Read the next file number off
the instrument, type it in. If it matches, that is two seconds well spent. If it
does not, the app shows the gap in words and offers to log the missing numbers
as discards and resynchronise.

It prompts automatically at every white reference and whenever a part-filled
plan is loaded, because those are where numbering goes wrong.

### Getting the data out

The `[=]` menu holds Export. It writes three files, always with a fresh
timestamped name so nothing ever overwrites anything:

- **Plan CSV** - the input file with `FileNum` and `comments` filled in, and
  `WRNum`/`Date`/`Prefix`/`Subfolder` written only where they change. Drops
  straight into the QC pipeline.
- **Event log CSV** - one row per action, including every discarded number.
- **Session file** - full state, to resume on another device.

Each of those offers a download link *and* a plain text box. On old tablets the
text box is the one that works - select it, copy, share it out however you can.

The app autosaves to `localStorage` after every action and offers Resume or
Start Fresh next time it opens. It never resumes or discards silently. Still,
export at the end of each plate: the OS can clear local storage whenever it
likes, and the app nags for exactly this reason.

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
2. CSS custom properties (`var(--…)`) - would need inlining.
3. `clamp()` in font sizes - already written with a plain fallback declared
   first, so a parser that does not understand it keeps a usable size.
4. `env(safe-area-inset-bottom)` - degrades to zero padding on its own.

Do not pre-emptively downgrade any of these. Test on the oldest tablet in the
cupboard first and fix only what actually breaks.
