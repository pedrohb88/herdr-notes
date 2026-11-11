# herdr-notes: design and plan

A tasks and notes panel for the Herdr desktop app, in the left sidebar
under Agents: a mouse-and-keyboard alternative to a text file kept open in
another terminal.

Written on 2026-11-10, before the first build.

## Goals

- Tasks in three statuses, **Todo → Doing → Done**, easy to move between.
- General notes, kept apart from tasks, in a tab of their own.
- Normal mouse and keyboard use (no vim modes).

## Out of scope (for now)

- Agents reading or updating the list. Later; the plain JSON file keeps the
  door open.
- Importing from other formats.
- A "Daily" section.
- Per-project or per-space lists: there is one global list.

## Decisions

- **Tasks tab, layout A:** stacked Todo, Doing and Done sections, each
  collapsible with a count. Dragging an item to another section changes its
  status.
- **Notes tab, layout B:** a list of notes with title, preview and search.
  Clicking opens the whole note for editing; an arrow goes back.
- **Storage:** a JSON file of the person's, outside Herdr.
- Its own repository, in English.

## Defaults (can change)

- Data file: `~/.herdr-notes/data.json`; the block's `file` prop picks another.
- Done starts collapsed.
- A task is one line of text, wrapped on display.
- A note is a title plus a plain-text body (Markdown is not rendered); the
  list shows the most recently edited first.
- Saves on every change; a note's body saves 600 ms after the last keystroke
  and when leaving the note.
- Deleting asks for confirmation inline.
- Global key `ctrl-shift-y` shows or hides the panel (`layout.toggle:herdr-notes`).
- The open tab and collapsed sections live in the mod's `localStorage`.

## File format

```json
{
  "version": 1,
  "tasks": [
    { "id": "t-…", "text": "…", "status": "todo|doing|done", "created": "ISO", "updated": "ISO" }
  ],
  "notes": [
    { "id": "n-…", "title": "…", "body": "…", "created": "ISO", "updated": "ISO" }
  ]
}
```

Task order within a status is array order. Unknown fields are kept.

## Staying consistent with outside edits

- Every change is a pure function over the data that finds its target by id.
- Writes use `writeTextFile(path, text, expected)`. If the file changed
  outside, the API refuses: the panel rereads the disk, reapplies the pending
  changes on top of it and writes again (one attempt).
- `watchFolder` on the file's folder rereads it on any change there. A note being
  edited is not overwritten by a reload.
- Invalid JSON on disk: the panel shows the error and **does not write**
  until the file is valid again, so its content is never destroyed.

Accepted risk: two writes racing within the reread-and-rewrite window lose
one of them. The panel is meant for one person, with outside edits being
occasional.

## Interaction

**Tasks**
- Click selects; double-click (or Enter/F2) edits; Enter saves, Esc cancels.
- The box on the left marks Done (in Done, it goes back to Todo).
- Drag: to another section changes status; within a section, reorders.
- On the selected row: edit and delete buttons.
- "+ New task" at the end of each section; Enter adds and keeps the field
  open for the next one.
- Keyboard (panel focused): ↑/↓ select, Shift+←/→ change status,
  Shift+↑/↓ reorder, Space toggles Done, `n` new task, Delete deletes
  (Enter confirms).

**Notes**
- Search on top (title and body); `/` focuses it.
- ↑/↓ and Enter open; `n` new note; Delete deletes (confirm).
- Inside a note: editable title and body; ← or Esc goes back.

## Plan

1. Mod `herdr-notes` (`mods/herdr-notes/main.js`, `model.js`, `mod.json`): data,
   persistence, Tasks tab, Notes tab, keyboard.
2. `install.sh`: copies the mod to `~/.config/herdr-app/mods/herdr-notes`, runs
   `herdr-app check`, places the block in the personal layout (under
   `agents` in `sidebar-lists`) and adds the key if it is free.
   `--uninstall` undoes it.
3. Verify: `herdr-app check`, unit tests for `model.js`, and a try on
   screen.
