# SVC Field Notes - single-file web app spec (draft)

Draft brief for a phone/tablet app that replaces the Excel field-notes sheet used to
record SVC spectroradiometer file numbers against a pre-planned measurement list.

Status: first-pass spec, expect to argue with it.

---

## 1. Problem

An operator walks a fixed, pre-planned list of scan targets (one row per target) and
records which SVC file number corresponds to each row.

- File numbers are *usually* the previous number plus one.
- The sequence breaks when a scan is discarded (bad scan, operator error), and when a
  white reference is taken (a WR writes its own .sig file in the current workflow - we
  use it downstream to confirm file alignment when off-by-one errors happen).
- Current tooling: an Excel sheet on a phone. Faster than paper, but scrolling and
  tapping into the right cell on a small screen is slow and error-prone, and a
  mis-tapped cell is silent - nothing catches it until the QC pipeline does, or nothing
  catches it at all.

The app's job is not "be a nicer spreadsheet". It is: **the operator should almost never
type a file number.** The app tracks the counter; the operator confirms, or tells it what
went wrong.

## 2. Non-goals

- No accounts, no cloud, no sync, no server. Never makes a network request.
- Not a general spreadsheet editor. It fills specific columns and nothing else.
- Not an instrument driver. It does not talk to the SVC over Bluetooth; it is a
  manually-maintained log on a separate device.
- No build step, no npm, no bundler, no CDN. One .html file, opened from local storage.

## 3. Input and output contract

### Input: plan CSV

Loaded via `<input type="file">`. Example: `WGA300-Day1.csv`. Example columns:

```
row,range,rep,tech_rep,FileNum,WRNum,comments,Date,Day,Prefix,Subfolder,
BCN,trial,treatment,plate,Q2_pos,order
```

Required columns: `FileNum`, `Date`, `Prefix`, `Subfolder`. Everything else is optional.
A missing required column is a hard load error; anything else missing just means less
on the target card.

Column roles:

| Role | Columns | Behaviour |
|---|---|---|
| Per-row capture | `FileNum`, `comments` | Filled by the app on every captured row |
| Change-tracked values | `WRNum`, `Date`, `Prefix`, `Subfolder` | Written only on the row where the value changes, blank everywhere else - downstream imputes by forward-fill |
| Target identity (read-only) | Everything else | Displayed when present and non-empty, never edited. `BCN` gets the layout prominence when present - it is the field a mis-tap corrupts invisibly |

The identity set varies per project: `WGA5101` has no `treatment`; `WGA-N30` has no
`plate`, `Q2_pos`, or `order`, adds `ecotype`, and its `tech_rep` is present but
entirely empty. The app must not key any behaviour on an identity column by name -
it renders whatever the file has.

Rules:

- Do not assume the column set beyond the required four. Read the header, keep unknown
  columns verbatim, pass them through to output untouched.
- Row order in the file is the walk order. Do not re-sort. `order` is a within-plate
  index, not a global one, and `row` is not monotonic (see plate 3 in the sample file:
  11, 15, 17, 19, 23, 24, 27...).
- Rows may arrive with `FileNum` already populated (resuming a partly-done day). Treat
  those as already captured, place the cursor on the first empty `FileNum`, and start
  the counter after the highest filled number - then prompt a reconcile immediately
  (see section 5), because trailing discards or WRs from the earlier session are
  invisible in the CSV.
- CSV handling must be real CSV: quoted fields, embedded commas, embedded newlines.
  No `split(',')`. On output, always quote `comments` and preserve any newlines in it.

### Output: same CSV, plus a log

1. **Plan CSV** - identical header and row order to the input, with the capture columns
   filled and the change-tracked columns written sparsely (only where they change).
   This drops straight into the existing QC pipeline with no changes. `FileNum` is
   always the bare integer, in the CSV and on screen - no padding anywhere.
2. **Event log CSV** - audit trail, one row per action:
   `timestamp,action,file_num,plan_row_index,note`
   (identity fields logged when present). `action` is one of
   `confirm | discard | white_ref | overwrite | undo | redo | comment | meta | reconcile`.
   This is the bit Excel never gave us: discarded file numbers become data instead of
   folklore. Append-only, with one exception: Undo removes the entry it reverses
   (see section 4).
3. **Session JSON** - full app state, for resume or for moving to another device.

Export mechanism, in order of preference, with fallbacks because old WebViews are bad
at this:

- `Blob` + `URL.createObjectURL` + `<a download>`.
- If that fails, a `data:` URI link.
- Always also offer a plain `<textarea>` containing the CSV text, pre-selected, so the
  operator can copy-paste it out via any share sheet. This fallback is not optional -
  it is the thing that saves the day on the old tablets.

## 4. Core model

State:

```
plan[]          ordered array of row objects, from the CSV
cursor          index into plan[] of the current target
nextFileNum     the file number the instrument will write next
currentWR       file number of the most recent white reference
meta            current Date, Prefix, Subfolder
undoStack       at least 20 actions deep
redoStack       undone actions, re-appliable until any new action clears it
events[]        the log
config          see section 8
```

Invariant: `nextFileNum` is the single source of truth for numbering. Every action that
consumes a file number on the instrument must increment it, whether or not that number
lands on a plan row. This is what makes discards and white references self-correcting.
Confirm always uses the displayed `nextFileNum`, then increments it - there is no
separate "type a number" path outside the reconcile box.

### Actions

| Action | Effect on `nextFileNum` | Effect on `cursor` | Notes |
|---|---|---|---|
| **Confirm** | +1 | next unfilled row | Only on unfilled rows. Assigns `nextFileNum` to `plan[cursor].FileNum`. Stamps `WRNum` only if `currentWR` changed since the last written row. 300ms debounce against double-taps. |
| **Overwrite** | +1 | next unfilled row | Only on filled rows (the Confirm button relabels). The row's old `FileNum` goes to the log as a discard note; the row is reassigned the displayed number. |
| **Discard** ("bad scan") | +1 | unchanged | The file exists on the instrument but is junk. Optional reason. |
| **White reference** | +1 if `config.wrConsumesFileNumber` else 0 | unchanged | Sets `currentWR`; the next Confirm stamps it into `WRNum`. Triggers the reconcile prompt (section 5). |
| **Undo** | restore | restore | Reverses the last action exactly, removes its log entry, and pushes it onto `redoStack`. |
| **Redo** | re-apply | re-apply | Re-applies the top of `redoStack` exactly. Any new action clears `redoStack` and disables Redo. |
| **Next/Last row** | unchanged | +1 / -1 | Cursor navigation only - for skipping a row (or several) and coming back. Touches no file numbers. Not the same as Undo. |
| **Jump** | unchanged | to chosen row | Opens the full-screen row list (section 6). |
| **Comment** | unchanged | unchanged | Free text on the current row. Always quoted in output, newlines preserved. |
| **Edit meta** | unchanged | unchanged | Set or change `Date`, `Prefix`, `Subfolder`. Written on the current row only; other rows stay blank for downstream imputation. |

No "confirm and stay" variant for the tech_rep pairs: the walk order in the plan
matches the physical sampling pattern, so plain sequential confirms are correct, and
Next/Last row covers the exceptions.

### Undo/redo must be real stacks

Depth of at least 20 actions. Field mistakes are noticed one or two beats late ("hang on,
that last one was the wrong plant"), and an operator who cannot cleanly undo will start
typing numbers by hand, which is the failure mode this whole app exists to prevent.

Undo exists for accidental Confirms and reverses completely, log entry included. That is
safe here precisely because the app is a manual log on a separate device - nothing on
the instrument is being un-done, and any real divergence gets caught at the next
reconcile. After an undo, any new action (including Overwrite) clears the redo stack.

## 5. Reconciliation

The highest-value feature after Confirm. The operator reads the actual next file number
off the instrument and types it into the Reconcile box.

Reconcile is prompted:

- **At every white reference.** WRs are where numbering most often goes sideways, and a
  WR is the first thing captured before any actual data - catching drift there costs
  minutes instead of a plate.
- **Immediately after loading a partly-filled CSV** without session JSON (section 3).
- **On demand**, by tapping the big `NEXT FILE` display.

Outcomes:

- Match: green tick, log a `reconcile` event, carry on. Two seconds.
- Mismatch: show the gap explicitly ("instrument says 189, app expects 186 - 3 files
  unaccounted for") and offer: log the gap as N anonymous discards and resynchronise
  `nextFileNum` to the entered value, or open the event log to correct it.

An error caught at the next white reference costs a few scans of uncertainty. The same
error caught in the QC pipeline three weeks later costs the day.

## 6. Screen layout

One screen, no scrolling to reach the primary action, usable one-handed in bright light.
Portrait first, landscape supported.

```
+------------------------------------------+
| WGA300-Day1   Plate 2   12/44      [=]   |  status strip, small
+------------------------------------------+
|                                          |
|            NEXT FILE                     |
|               8 7                        |  very large, tappable to reconcile
|                                          |
+------------------------------------------+
|  row 5  range 7                          |  largest text on the card
|  BCN = 52489, Q2_pos = C3, plate = 2,    |
|  ORDER = 11, rep = 1, tech_rep = 1       | 
|  WR 81                                   |
+------------------------------------------+
|  next up:  row 5 / range 8  /  Q2Pos C4  |  greyed, one line
+------------------------------------------+
| [ LAST ]                      [ NEXT ]   |  cursor nav, >=48dp targets
+------------------------------------------+
|                                          |
|             C O N F I R M                |  ~25% of screen height, thumb zone
|                                          |
+------------------------------------------+
| WR | DISCARD | REDO | NOTE | UNDO        |  secondary row, >=48dp targets
+------------------------------------------+
```

Notes on the layout:

- The card renders the row's identity fields as key=value lines, whatever they happen
  to be; empty values are omitted. Same for the "next up" preview line.
- The status strip shows plate and within-plate progress when a `plate` column exists
  (`Plate 2  12/44`), plain global progress otherwise (`156/360`).
- The "next up" preview line is cheap and catches "am I standing at the right plant"
  before the scan, not after.
- `NEXT FILE` is deliberately huge so it can be eyeballed against the instrument's own
  display between reconcile prompts. Bare integer, no padding - easier to read at a
  glance.
- LAST/NEXT move the cursor without touching `nextFileNum` - for skipping a row (or
  several) and coming back. They sit apart from the secondary row so they are never
  confused with Undo.
- The Confirm button relabels to OVERWRITE when the cursor sits on an already-filled
  row (after a Jump or Last), so re-assigning a row is deliberate, not accidental.
- Undo sits next to the destructive-ish buttons on purpose. It should be the easiest
  recovery in the app.
- The `[=]` menu holds Jump, Edit meta, export, and session management.
- No quick-tag comment chips: common comments change from project to project, so the
  keyboard stays.

### Jump list

Jump opens a second, full-screen, scrollable view of the whole plan: one line per row
(identity fields plus captured `FileNum` if any), each with a **Jump button fixed to
the left edge** so the thumb always knows where it is. Filled rows are visually
distinct from unfilled ones. Tapping a row's Jump button sets the cursor and returns
to the main screen.

## 7. Persistence and robustness

- Autosave the whole state to `localStorage` after every action. The app must survive
  a browser kill, a phone reboot, and a flat battery mid-plate.
- `localStorage` is the right store here: a full session is tens of KB, far under the
  ~5 MB cap, and it is the most reliable storage API on older WebViews. The real risk
  is the OS clearing it under pressure - mitigate by nagging for export at the end of
  each plate and at session end.
- On load, if a saved session exists, offer Resume or Start Fresh. Never silently
  resume, and never silently discard.
- A before-unload warning is best-effort only: mobile browsers fire it unreliably.
  Autosave is the actual protection; do not rely on the warning.
- Every export is additive - never overwrite, always a new timestamped filename.

## 8. Config

A small object at the top of the file, or a settings panel, whichever is easier to keep
correct:

- `wrConsumesFileNumber` (bool, default true) - true for the current workflow, where a
  WR writes its own .sig file. Set false if the workflow moves to SVCScan, where
  reference scans do not appear to write their own file. This one flag is the
  difference between the two instrument workflows.
- `startFileNum` (int, default 0) - first expected file number of the session.
- No padding, anywhere: file numbers display and export as bare integers - easier for
  a human to read, and disambiguated downstream. The app never composes .sig
  filenames - that is derived downstream too.
- Initial `Date`, `Prefix`, `Subfolder` - entered at session start, written on the
  first row. Changed mid-session via Edit meta (e.g. at instrument battery swaps).

## 9. Validation

Warn, do not block. The operator is in a glasshouse and knows things the app does not.
(The one hard stop is a missing required column at load time - without `FileNum` there
is nothing to fill.)

- Duplicate `FileNum` assigned to two rows.
- `FileNum` sequence non-monotonic.
- Export attempted with blank `FileNum` values - list which rows.
- Row count per plate not matching the modal count (only if a `plate` column is
  present).
- `Date`, `Prefix`, `Subfolder` never set.

## 10. Target platforms

Build for **current Chrome on Android** (ES2017 is fine) and test on the oldest tablet
available. Only downgrade what actually breaks if a real device fails - the tablets in
the cupboard are not old enough to justify writing ES5 blind. If one does fail, the
constraints are: no `async`/`await`, no optional chaining, no `fetch`; flexbox only in
its widely-supported form, no grid, no custom properties.

Other constraints:

- Must work from `file://`. No local server, no service worker required.
- No external fonts, no external anything. Single self-contained file.
- Set the device's screen timeout to never before a session. Do not fight the OS on this.

## 11. Build order

1. **M1** - Load CSV, render the target card, Confirm, export plan CSV. This alone
   replaces the spreadsheet. Ship it and use it for one plate before building anything
   else.
2. **M2** - Autosave + resume, Discard, White reference with reconcile prompt,
   Overwrite, Undo/Redo stacks, comments, event log export. (Autosave is early because
   losing a plate to a browser kill is the exact failure mode this app exists to
   prevent.)
3. **M3** - Validation warnings, the jump list, Edit meta for mid-session
   Prefix/Subfolder changes, session JSON export/import.
4. **M4** - Layout polish, oldest-tablet test pass, downgrading only what breaks.

## 12. Testing

- Fixtures: all three plan CSVs, because they pin down the genericness:
  - `WGA300-Day1.csv` (176 rows, 4 plates of 44, non-contiguous `row` values in
    plate 3, `tech_rep` pairs at the start of each plate, non-numeric `BCN` values
    `V1` and `V3`).
  - `WGA5101-Day1.csv` (same shape but no `treatment` column, `Com*` BCNs).
  - `WGA-N30-Day1.csv` (360 rows, no `plate`/`Q2_pos`/`order`, an `ecotype` column,
    `tech_rep` present but entirely empty, `row` resetting at block boundaries).
  Together: no behaviour may be keyed on an optional column by name, and do not
  assume `BCN` parses as an integer.
- Harness: the no-build constraint applies to the shipped file, not the tests. Structure
  the file so the core logic (CSV parse/serialise + the action state machine) is
  DOM-free and loadable in Node; the golden-file harness lives outside the artifact.
- Golden-file regression: a scripted sequence of actions in, an expected output CSV out,
  byte-compared. Same approach as the SVC QC pipeline corpus - reuse the pattern.
- Edge cases worth explicit tests:
  - Discard as the very first action of a session.
  - White reference immediately followed by a discard.
  - Undo across a plate boundary; undo followed by a new action clears the redo stack.
  - Overwrite a filled row, then undo the overwrite.
  - Resume from a session saved mid-plate, then export.
  - Input CSV with a column the app has never seen, present in the output unchanged.
  - Input CSV with `FileNum` already partly filled, reconcile prompted on load.
  - A comment containing commas, quotes, and newlines round-trips through export and
    re-import.
  - A mid-session Prefix/Subfolder change lands on the current row only, with all other
    rows left blank.
