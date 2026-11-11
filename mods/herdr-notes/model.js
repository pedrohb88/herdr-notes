// The panel's data: tasks and notes, and the changes made to them.
//
// Every change is a pure function `(data) => data` that finds its target by
// id, so when the file changed outside, the same change can be reapplied on
// top of the newer version on disk (main.js, persist).

export const STATUSES = ["todo", "doing", "done"];
export const LABELS = { todo: "Todo", doing: "Doing", done: "Done" };

export const empty = () => ({ version: 1, tasks: [], notes: [] });

const now = () => new Date().toISOString();

export function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

const clone = (d) => JSON.parse(JSON.stringify(d));

// Reads the file's text. Null (no file yet) is an empty list. Unknown fields
// are kept; malformed items are dropped.
export function parse(text) {
  if (text === null || text === undefined || text.trim() === "") return empty();
  const d = JSON.parse(text);
  if (!d || typeof d !== "object" || Array.isArray(d)) throw new Error("the file is not a JSON object");
  const tasks = (Array.isArray(d.tasks) ? d.tasks : [])
    .filter((t) => t && typeof t.id === "string" && typeof t.text === "string")
    .map((t) => ({ ...t, status: STATUSES.includes(t.status) ? t.status : "todo" }));
  const notes = (Array.isArray(d.notes) ? d.notes : [])
    .filter((n) => n && typeof n.id === "string")
    .map((n) => ({ ...n, title: String(n.title ?? ""), body: String(n.body ?? "") }));
  return { ...d, version: 1, tasks, notes };
}

export const serialize = (d) => JSON.stringify(d, null, 2) + "\n";

// Applies a change to a copy.
export const apply = (d, op) => op(clone(d));

export const tasksIn = (d, status) => d.tasks.filter((t) => t.status === status);

// ---- tasks --------------------------------------------------------------------

export const addTask = (id, text, status) => (d) => {
  d.tasks.push({ id, text, status, created: now(), updated: now() });
  return d;
};

export const updateTask = (id, text) => (d) => {
  const t = d.tasks.find((x) => x.id === id);
  if (t && t.text !== text) { t.text = text; t.updated = now(); }
  return d;
};

export const deleteTask = (id) => (d) => {
  d.tasks = d.tasks.filter((x) => x.id !== id);
  return d;
};

// Puts the task in `status`, before `beforeId` (same status) or at its end.
export const moveTask = (id, status, beforeId) => (d) => {
  const i = d.tasks.findIndex((x) => x.id === id);
  if (i === -1 || id === beforeId) return d;
  const [t] = d.tasks.splice(i, 1);
  if (t.status !== status) { t.status = status; t.updated = now(); }
  let at = beforeId ? d.tasks.findIndex((x) => x.id === beforeId) : -1;
  if (at === -1) {
    // After the last task in that status; with none, at the very end.
    let last = -1;
    d.tasks.forEach((x, k) => { if (x.status === status) last = k; });
    at = last === -1 ? d.tasks.length : last + 1;
  }
  d.tasks.splice(at, 0, t);
  return d;
};

// The neighbouring status (delta -1 or +1), at the end of that section.
export const shiftStatus = (id, delta) => (d) => {
  const t = d.tasks.find((x) => x.id === id);
  if (!t) return d;
  const k = STATUSES.indexOf(t.status) + delta;
  if (k < 0 || k >= STATUSES.length) return d;
  return moveTask(id, STATUSES[k], null)(d);
};

// Swaps places with the task above (-1) or below (+1) in the same status.
export const reorder = (id, delta) => (d) => {
  const t = d.tasks.find((x) => x.id === id);
  if (!t) return d;
  const same = tasksIn(d, t.status);
  const k = same.findIndex((x) => x.id === id) + delta;
  if (k < 0 || k >= same.length) return d;
  if (delta < 0) return moveTask(id, t.status, same[k].id)(d);
  const after = same[k + 1];
  return moveTask(id, t.status, after ? after.id : null)(d);
};

// The checkbox: Done goes back to Todo; anything else goes to Done.
export const toggleDone = (id) => (d) => {
  const t = d.tasks.find((x) => x.id === id);
  if (!t) return d;
  return moveTask(id, t.status === "done" ? "todo" : "done", null)(d);
};

// ---- notes ----------------------------------------------------------------------

export const addNote = (id) => (d) => {
  d.notes.push({ id, title: "", body: "", created: now(), updated: now() });
  return d;
};

export const updateNote = (id, title, body) => (d) => {
  const n = d.notes.find((x) => x.id === id);
  if (n && (n.title !== title || n.body !== body)) { n.title = title; n.body = body; n.updated = now(); }
  return d;
};

export const deleteNote = (id) => (d) => {
  d.notes = d.notes.filter((x) => x.id !== id);
  return d;
};

// Notes matching the search (title or body), most recently edited first.
export function notesFor(d, query) {
  const q = (query ?? "").trim().toLowerCase();
  return d.notes
    .filter((n) => !q || n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q))
    .sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
}

export const noteTitle = (n) => n.title.trim() || "Untitled";

export function notePreview(n) {
  const line = n.body.split("\n").map((l) => l.trim()).find(Boolean);
  return line ?? "";
}
