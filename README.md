# SVC Field Notes

A single-file web app for recording SVC spectroradiometer file numbers against a
pre-planned measurement list.

The point of it: **the operator should almost never type a file number.** The app
tracks the counter, the operator confirms or says what went wrong.

## Using it

Copy `svc-fieldnotes.html` onto the phone or tablet and open it from local
storage.

1. Load the day's plan CSV. It needs `FileNum`, `Date`, `Prefix`, `Subfolder` and
   `comments` columns - a missing one is the app's only hard stop.
2. Enter the date, prefix, subfolder, and the first file number the instrument
   will write.
3. Walk the plan. **CONFIRM** assigns the big number on screen to the current
   row and moves on.

| Button | When |
|---|---|
| CONFIRM | The scan you just took belongs to this row |
| OVERWRITE | Same button on a row that already has a number - reassigns it deliberately |
| WR | White reference taken. Confirm which file number it is - that step is the reconcile |
| DISCARD | The scan was junk. One tap: burns the number, stays on the row |
| NOTE | Free text into the `comments` column |
| UNDO / REDO | At least 20 actions deep, and undo leaves no trace in the log |
| PREV / NEXT | Move the cursor only - for skipping a row and coming back |
| NEXT FILE (the big number) | Tap to reconcile against the instrument any time |

Dark mode is on the opening screen and in the ☰ menu mid-session. Light is the
default in sunlight, and the choice is remembered separately from the session.

Set the device's screen timeout to never before a session.

### Reconcile

The highest-value thing in the app after CONFIRM. Read the next file number off
the instrument, type it in. If it matches, that is two seconds well spent. If it
does not, the app shows the gap in words and offers to log the missing numbers
as discards and resynchronise.

It prompts whenever a part-filled plan is loaded, and taking a white reference
is itself a reconcile - the app asks which file number the WR is rather than
assuming, since WRs get re-taken too. Anything skipped on the way is logged as
discards.

### Getting the data out

The ☰ menu holds Export. It writes three files, always with a fresh
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

