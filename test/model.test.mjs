import { test } from "node:test";
import assert from "node:assert/strict";
import * as M from "../mods/herdr-notes/model.js";

const base = () => {
  let d = M.empty();
  d = M.apply(d, M.addTask("t-a", "a", "todo"));
  d = M.apply(d, M.addTask("t-b", "b", "todo"));
  d = M.apply(d, M.addTask("t-c", "c", "doing"));
  d = M.apply(d, M.addTask("t-d", "d", "done"));
  return d;
};
const ids = (d, s) => M.tasksIn(d, s).map((t) => t.id);

test("parse: missing or empty file is an empty list", () => {
  assert.deepEqual(M.parse(null), M.empty());
  assert.deepEqual(M.parse("  "), M.empty());
});

test("parse: keeps unknown fields, drops malformed items, fixes bad status", () => {
  const d = M.parse(JSON.stringify({ extra: 1, tasks: [{ id: "t-x", text: "x", status: "weird", mine: true }, { text: "no id" }], notes: [{ id: "n-1", title: 3 }] }));
  assert.equal(d.extra, 1);
  assert.equal(d.tasks.length, 1);
  assert.equal(d.tasks[0].status, "todo");
  assert.equal(d.tasks[0].mine, true);
  assert.equal(d.notes[0].title, "3");
  assert.equal(d.notes[0].body, "");
});

test("parse: rejects invalid JSON and non-objects", () => {
  assert.throws(() => M.parse("{"));
  assert.throws(() => M.parse("[]"));
});

test("apply does not mutate the original", () => {
  const d = base();
  const before = JSON.stringify(d);
  M.apply(d, M.deleteTask("t-a"));
  assert.equal(JSON.stringify(d), before);
});

test("moveTask: to another status, at the end or before a task", () => {
  let d = M.apply(base(), M.moveTask("t-a", "doing", null));
  assert.deepEqual(ids(d, "doing"), ["t-c", "t-a"]);
  assert.equal(d.tasks.find((t) => t.id === "t-a").status, "doing");
  d = M.apply(base(), M.moveTask("t-d", "todo", "t-b"));
  assert.deepEqual(ids(d, "todo"), ["t-a", "t-d", "t-b"]);
});

test("moveTask: into an empty status goes to the end", () => {
  let d = M.apply(base(), M.moveTask("t-c", "done", null));
  d = M.apply(d, M.moveTask("t-d", "doing", null));
  assert.deepEqual(ids(d, "doing"), ["t-d"]);
});

test("shiftStatus moves one step and stops at the ends", () => {
  let d = M.apply(base(), M.shiftStatus("t-a", 1));
  assert.equal(d.tasks.find((t) => t.id === "t-a").status, "doing");
  d = M.apply(base(), M.shiftStatus("t-a", -1));
  assert.equal(d.tasks.find((t) => t.id === "t-a").status, "todo");
  d = M.apply(base(), M.shiftStatus("t-d", 1));
  assert.equal(d.tasks.find((t) => t.id === "t-d").status, "done");
});

test("reorder swaps within the status", () => {
  let d = M.apply(base(), M.reorder("t-b", -1));
  assert.deepEqual(ids(d, "todo"), ["t-b", "t-a"]);
  d = M.apply(d, M.reorder("t-b", 1));
  assert.deepEqual(ids(d, "todo"), ["t-a", "t-b"]);
  d = M.apply(d, M.reorder("t-a", -1));
  assert.deepEqual(ids(d, "todo"), ["t-a", "t-b"]);
});

test("toggleDone: to Done, and back to Todo", () => {
  let d = M.apply(base(), M.toggleDone("t-c"));
  assert.equal(d.tasks.find((t) => t.id === "t-c").status, "done");
  d = M.apply(d, M.toggleDone("t-c"));
  assert.equal(d.tasks.find((t) => t.id === "t-c").status, "todo");
});

test("changes reapply on top of a newer version (outside edit merge)", () => {
  const ops = [M.updateTask("t-a", "a2"), M.moveTask("t-b", "done", null)];
  // Meanwhile the file got a task from outside.
  let disk = M.apply(base(), M.addTask("t-z", "from outside", "todo"));
  const merged = ops.reduce(M.apply, disk);
  assert.equal(merged.tasks.find((t) => t.id === "t-a").text, "a2");
  assert.equal(merged.tasks.find((t) => t.id === "t-b").status, "done");
  assert.ok(merged.tasks.find((t) => t.id === "t-z"));
  // A change to something deleted outside is a no-op.
  disk = M.apply(base(), M.deleteTask("t-a"));
  assert.equal(ops.reduce(M.apply, disk).tasks.find((t) => t.id === "t-a"), undefined);
});

test("notes: search and order by last edit", () => {
  let d = M.empty();
  d = M.apply(d, M.addNote("n-1"));
  d = M.apply(d, M.updateNote("n-1", "Deploy", "check the cache"));
  d.notes[0].updated = "2026-01-01T00:00:00.000Z";
  d = M.apply(d, M.addNote("n-2"));
  d = M.apply(d, M.updateNote("n-2", "Ideas", "PR panel"));
  assert.deepEqual(M.notesFor(d, "").map((n) => n.id), ["n-2", "n-1"]);
  assert.deepEqual(M.notesFor(d, "CACHE").map((n) => n.id), ["n-1"]);
  assert.equal(M.noteTitle({ title: "  " }), "Untitled");
  assert.equal(M.notePreview({ body: "\n\n first line \nsecond" }), "first line");
});

test("serialize round-trips", () => {
  const d = base();
  assert.deepEqual(M.parse(M.serialize(d)), d);
});
