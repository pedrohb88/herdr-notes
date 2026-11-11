// herdr-notes: a tasks and notes panel for the sidebar.
//
// Two tabs. Tasks: Todo, Doing and Done stacked, each collapsible; drag a
// task to another section to change its status. Notes: a searchable list;
// a note opens in place for editing.
//
// The data lives in one JSON file of the person's (this.file), saved on every
// change. Changes are pure functions (model.js); when the file changed
// outside meanwhile, the pending ones are reapplied on top of the disk's
// version (persist).

import { View, div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, Textarea, TextareaState } from "gpui-base";
import { home, props, readTextFile, writeTextFile, watchFolder, exec, theme, notify } from "herdr";
import * as M from "./model.js";

// The block's props can pick another file: { "file": "~/somewhere/tasks.json" }.
// The folder is made with `mkdir -p`, which Windows lacks: there it must exist.
const DEFAULT_FILE = "~/.herdr-notes/data.json";
const dataFile = () => {
  const f = String(props()?.file || DEFAULT_FILE);
  return f === "~" || f.startsWith("~/") || f.startsWith("~\\") ? home() + f.slice(1) : f;
};
const NOTE_SAVE_MS = 600;
const NARROW = 140; // below this (the sidebar's rail), the panel draws nothing

const stored = (key, fallback) => {
  try { const v = localStorage.getItem(`herdr-notes.${key}`); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
};
const store = (key, value) => {
  try { localStorage.setItem(`herdr-notes.${key}`, JSON.stringify(value)); } catch {}
};

export default class Notes extends View {
  init(_props, cx) {
    this.file = dataFile();
    const cut = Math.max(this.file.lastIndexOf("/"), this.file.lastIndexOf("\\"));
    this.dir = cut > 0 ? this.file.slice(0, cut) : this.file.slice(0, cut + 1) || ".";
    this.data = M.empty();
    this.snapshot = null; // the file's text as last read or written; null: no file
    this.loaded = false;
    this.broken = null; // why the file can't be read; nothing is written meanwhile
    this.pending = []; // changes not on disk yet
    this.flushing = false;

    this.tab = stored("tab", "tasks");
    this.collapsed = stored("collapsed", { todo: false, doing: false, done: true });
    this.width = 999;

    this.sel = null; // selected task id
    this.edit = null; // { id, input }: a task being edited
    this.adding = null; // { status, input }: a new task being typed
    this.confirm = null; // id of a task or note waiting for delete confirmation
    this.press = null; // { id, moved }: mouse down on a task
    this.drop = null; // { status, before }: where a dragged task would land

    this.noteSel = null; // selected note id in the list
    this.note = null; // { id, title: InputState, body: TextareaState }: the open note
    this.noteTimer = null;
    this.searching = false;
    this.search = InputState.new({ placeholder: "Search notes" });
    this.search.on("change", (_e, cx) => { this.noteSel = null; cx.notify(); });
    this.search.on("focus", (_e, cx) => { this.searching = true; cx.notify(); });
    this.search.on("blur", (_e, cx) => { this.searching = false; cx.notify(); });

    this.handle = cx.focus_handle();

    cx.spawn(async (cx) => {
      await exec("mkdir", ["-p", this.dir]).catch(() => null);
      await this.reload(cx);
      this.watch(cx);
    });
  }

  // ---- persistence -------------------------------------------------------------

  async reload(cx) {
    let text;
    try { text = await readTextFile(this.file); } catch (e) { this.broken = `Cannot read ${this.file}: ${e}`; cx.notify(); return; }
    this.loaded = true;
    if (text === this.snapshot && !this.broken) return;
    if (this.flushing || this.pending.length) return; // the write will see the change and merge
    try {
      this.data = M.parse(text);
      this.snapshot = text;
      this.broken = null;
    } catch (e) {
      this.broken = `${this.file} is not valid JSON (${e.message ?? e}). Fix it; nothing is saved until then.`;
    }
    cx.notify();
  }

  watch(cx) {
    cx.spawn(async (cx) => {
      for (;;) {
        try { await watchFolder(this.dir); } catch {
          // Not watchable: poll gently instead.
          for (;;) { await cx.sleep(5000); await this.reload(cx); }
        }
        // Any change in the folder rereads the file: paths reported by the
        // watcher may not match ours (symlinks, separators), and an unchanged
        // file costs one read.
        await this.reload(cx);
      }
    });
  }

  // Applies a change now and saves it. Changes made while a write is in
  // flight queue up and go in the next one.
  change(op, cx) {
    if (this.broken) {
      notify({ title: "herdr-notes", body: "Not saved: the data file can't be read. See the panel.", level: "warning" });
      return;
    }
    this.data = M.apply(this.data, op);
    this.pending.push(op);
    cx.notify();
    if (this.flushing) return;
    this.flushing = true;
    cx.spawn(async (cx) => {
      try {
        while (this.pending.length) {
          const ops = this.pending.splice(0);
          await this.persist(ops);
        }
      } catch (e) {
        notify({ title: "herdr-notes", body: `Could not save: ${e?.message ?? e}`, level: "error" });
      } finally {
        this.flushing = false;
        cx.notify();
      }
    });
  }

  async persist(ops) {
    const text = M.serialize(this.data);
    try {
      await writeTextFile(this.file, text, this.snapshot);
      this.snapshot = text;
      return;
    } catch {}
    // Refused: the file changed (or its folder went). Reapply everything not
    // on disk yet on top of what is there now, and write once more.
    await exec("mkdir", ["-p", this.dir]).catch(() => null);
    const disk = await readTextFile(this.file);
    let base;
    try { base = M.parse(disk); } catch (e) {
      this.broken = `${this.file} is not valid JSON (${e.message ?? e}). Fix it; nothing is saved until then.`;
      throw new Error("the data file became invalid JSON; your last change is only on screen");
    }
    this.data = [...ops, ...this.pending].reduce(M.apply, base);
    const merged = M.serialize(this.data);
    await writeTextFile(this.file, merged, disk);
    this.snapshot = merged;
  }

  // ---- tasks -------------------------------------------------------------------

  visibleTasks() {
    return M.STATUSES.flatMap((s) => (this.collapsed[s] ? [] : M.tasksIn(this.data, s)));
  }

  setCollapsed(status, value) {
    this.collapsed = { ...this.collapsed, [status]: value };
    store("collapsed", this.collapsed);
  }

  startEdit(task, cx) {
    this.cancelInputs();
    const input = InputState.new({ value: task.text });
    const commit = (cx) => {
      if (this.edit?.input !== input) return;
      const text = input.value().trim();
      this.edit = null;
      if (text) this.change(M.updateTask(task.id, text), cx);
      this.handle.focus();
      cx.notify();
    };
    input.on("submit", (_e, cx) => commit(cx));
    input.on("blur", (_e, cx) => commit(cx));
    this.edit = { id: task.id, input };
    this.sel = task.id;
    input.focus();
    cx.notify();
  }

  startAdd(status, cx) {
    this.cancelInputs();
    if (this.collapsed[status]) this.setCollapsed(status, false);
    const input = InputState.new({ placeholder: "New task — Enter adds, Esc closes" });
    input.on("submit", (_e, cx) => {
      const text = input.value().trim();
      if (!text) return;
      const id = M.newId("t");
      this.change(M.addTask(id, text, status), cx);
      this.sel = id;
      input.set_value("");
      cx.notify();
    });
    input.on("blur", (_e, cx) => {
      if (this.adding?.input !== input) return;
      const text = input.value().trim();
      if (text) { const id = M.newId("t"); this.change(M.addTask(id, text, status), cx); this.sel = id; }
      this.adding = null;
      cx.notify();
    });
    this.adding = { status, input };
    input.focus();
    cx.notify();
  }

  // Drops whatever is being typed (Esc).
  cancelInputs() {
    this.edit?.input.release();
    this.adding?.input.release();
    this.edit = null;
    this.adding = null;
  }

  finishDrag(cx) {
    const press = this.press, drop = this.drop;
    this.press = null;
    this.drop = null;
    if (press?.moved && drop) this.change(M.moveTask(press.id, drop.status, drop.before), cx);
    cx.notify();
  }

  // While dragging, the pointer over `target` ({status, before}).
  dragOver(target, cx) {
    if (!this.press || this.press.id === target.before) return;
    if (this.drop?.status === target.status && this.drop?.before === target.before) return;
    this.press.moved = true;
    this.drop = target;
    cx.notify();
  }

  // ---- notes -------------------------------------------------------------------

  openNote(id, cx) {
    this.closeNote(cx);
    const n = this.data.notes.find((x) => x.id === id);
    if (!n) return;
    const title = InputState.new({ placeholder: "Title", value: n.title });
    const body = TextareaState.new({ placeholder: "Write here…", value: n.body });
    body.set_soft_wrap(true);
    const later = (_e, cx) => {
      this.noteTimer?.cancel();
      this.noteTimer = cx.timer.after(NOTE_SAVE_MS, (cx) => this.saveNote(cx));
    };
    title.on("change", later);
    body.on("change", later);
    title.on("submit", (_e, _cx) => body.focus());
    this.note = { id, title, body };
    this.noteSel = id;
    (n.title ? body : title).focus();
    cx.notify();
  }

  saveNote(cx) {
    this.noteTimer?.cancel();
    this.noteTimer = null;
    const note = this.note;
    if (!note) return;
    const n = this.data.notes.find((x) => x.id === note.id);
    const title = note.title.value(), body = note.body.value();
    if (n && (n.title !== title || n.body !== body)) this.change(M.updateNote(note.id, title, body), cx);
  }

  closeNote(cx) {
    if (!this.note) return;
    this.saveNote(cx);
    const { id, title, body } = this.note;
    this.note = null;
    title.release();
    body.release();
    // A note left empty is not kept.
    const n = this.data.notes.find((x) => x.id === id);
    if (n && !n.title.trim() && !n.body.trim()) this.change(M.deleteNote(id), cx);
    this.handle.focus();
    cx.notify();
  }

  newNote(cx) {
    const id = M.newId("n");
    this.change(M.addNote(id), cx);
    this.openNote(id, cx);
  }

  // ---- keyboard ----------------------------------------------------------------

  typing() {
    return Boolean(this.edit || this.adding || this.note || this.searching);
  }

  onKey(e, cx) {
    const k = e.key, shift = e.modifiers?.shift;
    if (k === "escape") {
      if (this.confirm) this.confirm = null;
      else if (this.edit || this.adding) { this.cancelInputs(); this.handle.focus(); }
      else if (this.note) this.closeNote(cx);
      else if (this.searching) { this.search.set_value(""); this.handle.focus(); }
      cx.notify();
      return;
    }
    if (this.typing()) {
      // From the search box, ↓ and Enter go to the results.
      if (this.searching && (k === "down" || k === "enter")) {
        const list = M.notesFor(this.data, this.search.value());
        if (k === "enter" && list[0]) this.openNote(this.noteSel ?? list[0].id, cx);
        else if (list[0]) { this.noteSel = list[0].id; this.handle.focus(); }
        cx.notify();
      }
      return;
    }
    if (this.confirm) {
      if (k === "enter") this.doDelete(this.confirm, cx);
      return;
    }
    if (this.tab === "tasks") this.taskKey(k, shift, cx);
    else this.noteKey(k, cx);
  }

  taskKey(k, shift, cx) {
    const list = this.visibleTasks();
    const i = list.findIndex((t) => t.id === this.sel);
    const cur = list[i];
    if (k === "n") { this.startAdd(cur?.status ?? "todo", cx); return; }
    if (!cur) {
      if ((k === "down" || k === "up") && list.length) { this.sel = list[k === "down" ? 0 : list.length - 1].id; cx.notify(); }
      return;
    }
    if (shift && (k === "left" || k === "right")) this.change(M.shiftStatus(cur.id, k === "right" ? 1 : -1), cx);
    else if (shift && (k === "up" || k === "down")) this.change(M.reorder(cur.id, k === "down" ? 1 : -1), cx);
    else if (k === "down" || k === "up") { const j = i + (k === "down" ? 1 : -1); if (list[j]) this.sel = list[j].id; }
    else if (k === "enter" || k === "f2") { this.startEdit(cur, cx); return; }
    else if (k === "space") this.change(M.toggleDone(cur.id), cx);
    else if (k === "delete" || k === "backspace") this.confirm = cur.id;
    else return;
    // A task moved into a collapsed section stays visible.
    const now = this.data.tasks.find((t) => t.id === cur.id);
    if (now && this.collapsed[now.status]) this.setCollapsed(now.status, false);
    cx.notify();
  }

  noteKey(k, cx) {
    const list = M.notesFor(this.data, this.search.value());
    const i = list.findIndex((n) => n.id === this.noteSel);
    if (k === "n") this.newNote(cx);
    else if (k === "/") this.search.focus();
    else if (k === "down" || k === "up") {
      const j = i === -1 ? (k === "down" ? 0 : list.length - 1) : i + (k === "down" ? 1 : -1);
      if (list[j]) this.noteSel = list[j].id;
    } else if (k === "enter" && list[i]) { this.openNote(list[i].id, cx); return; }
    else if ((k === "delete" || k === "backspace") && list[i]) this.confirm = list[i].id;
    else return;
    cx.notify();
  }

  doDelete(id, cx) {
    this.confirm = null;
    if (id.startsWith("t-")) {
      const list = this.visibleTasks(), i = list.findIndex((t) => t.id === id);
      this.sel = (list[i + 1] ?? list[i - 1])?.id ?? null;
      this.change(M.deleteTask(id), cx);
    } else {
      if (this.note?.id === id) { this.note.title.release(); this.note.body.release(); this.note = null; }
      this.change(M.deleteNote(id), cx);
    }
    this.handle.focus();
    cx.notify();
  }

  setTab(tab, cx) {
    if (this.tab === tab) return;
    this.cancelInputs();
    if (this.note) this.closeNote(cx);
    this.confirm = null;
    this.tab = tab;
    store("tab", tab);
    cx.notify();
  }

  // ---- drawing -----------------------------------------------------------------

  render(cx) {
    const t = theme();
    const root = v_flex().id("herdr-notes").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(12.5)
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.onKey(e, cx))
      .on_mouse_up("left", (_e, cx) => { if (this.press) this.finishDrag(cx); })
      .on_size_change((size, cx) => { if (Math.abs(size.width - this.width) > 1) { this.width = size.width; cx.notify(); } });
    if (this.width < NARROW) return root;
    return root
      .child(this.tabs(t))
      .when(Boolean(this.broken), (el) => el.child(div().mx(8).mb(6).p(8).rounded(6).bg(`${t.ansi1}22`).text_size(11.5).text_color(t.foreground).child(this.broken)))
      .child(this.tab === "tasks" ? this.tasksView(t) : this.notesView(t));
  }

  tabs(t) {
    const tab = (id, label, count) => h_flex().id(`tab-${id}`).h(24).px(10).gap(6).items_center().rounded(6).cursor_pointer()
      .text_size(12).bg(this.tab === id ? t.raised : t.background).text_color(this.tab === id ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.setTab(id, cx); this.handle.focus(); })
      .child(label)
      .when(count > 0, (el) => el.child(div().text_size(10.5).text_color(t.dim).child(String(count))));
    const open = this.data.tasks.filter((x) => x.status !== "done").length;
    return h_flex().flex_none().px(8).pt(8).pb(6).gap(4).items_center().border_t(1).border_color(t.border)
      .child(tab("tasks", "Tasks", open))
      .child(tab("notes", "Notes", this.data.notes.length))
      .child(div().flex_1())
      .when(!this.loaded, (el) => el.child(div().text_size(10.5).text_color(t.dim).child("loading…")));
  }

  statusColor(status, t) {
    return status === "todo" ? t.ansi4 : status === "doing" ? t.ansi3 : t.ansi2;
  }

  tasksView(t) {
    const out = [];
    for (const status of M.STATUSES) {
      const list = M.tasksIn(this.data, status);
      const closed = this.collapsed[status];
      const color = this.statusColor(status, t);
      const dropEnd = this.press?.moved && this.drop?.status === status && !this.drop.before;
      out.push(h_flex().id(`sec-${status}`).flex_none().h(26).px(10).mt(out.length ? 6 : 0).gap(6).items_center().cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { if (!this.press?.moved) { this.setCollapsed(status, !closed); cx.notify(); } })
        .on_mouse_move((_e, cx) => this.dragOver({ status, before: null }, cx))
        .child(div().w(10).text_size(10).text_color(t.dim).child(closed ? "▸" : "▾"))
        .child(div().text_size(11).font_semibold().text_color(color).child(M.LABELS[status].toUpperCase()))
        .child(div().px(6).rounded(8).bg(t.raised).text_size(10.5).text_color(t.muted).child(String(list.length)))
        .child(div().flex_1())
        .child(div().id(`add-${status}`).px(6).rounded(5).text_size(13).text_color(t.dim).hover((s) => s.bg(t.raised).text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); this.startAdd(status, cx); })
          .child("+"))
        .when(Boolean(dropEnd && closed), (el) => el.bg(`${color}22`)));
      if (closed) continue;
      for (const task of list) out.push(this.taskRow(task, color, t));
      if (this.adding?.status === status) {
        out.push(div().flex_none().mx(6).my(2).child(Input.new(this.adding.input)));
      } else {
        out.push(div().id(`new-${status}`).flex_none().mx(6).my(2).px(8).py(4).rounded(6).cursor_pointer()
          .text_size(12).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.muted))
          .when(Boolean(dropEnd), (el) => el.border_t(2).border_color(color))
          .on_mouse_move((_e, cx) => this.dragOver({ status, before: null }, cx))
          .on_click((_e, cx) => this.startAdd(status, cx))
          .child("+ New task"));
      }
    }
    return v_flex().id("tasks").flex_1().min_h(0).overflow_y_scrollbar().pb(8).children(out)
      .when(!this.data.tasks.length && this.loaded && !this.adding, (el) => el.child(
        div().px(14).py(6).text_size(11.5).text_color(t.dim).child("No tasks yet. Press n or click + New task.")));
  }

  taskRow(task, color, t) {
    const id = task.id;
    const selected = this.sel === id;
    const dragging = this.press?.moved && this.press.id === id;
    const dropHere = this.press?.moved && this.drop?.before === id;
    if (this.edit?.id === id) return div().flex_none().mx(6).my(1).child(Input.new(this.edit.input));
    if (this.confirm === id) return this.confirmRow(id, task.text, t);
    const done = task.status === "done";
    return h_flex().id(`task-${id}`).relative().flex_none().mx(6).my(1).px(8).py(5).gap(8).items_start().rounded(6)
      .bg(selected ? t.raised : t.background).hover((s) => s.bg(selected ? t.raised : t.hover))
      .when(Boolean(dragging), (el) => el.opacity(0.45))
      .when(Boolean(dropHere), (el) => el.child(div().absolute().top(-2).left(0).right(0).h(2).bg(color)))
      .on_mouse_down("left", (e, cx) => {
        this.handle.focus();
        this.confirm = null;
        this.sel = id;
        if (e.click_count === 2) { this.press = null; this.startEdit(task, cx); return; }
        this.press = { id, moved: false };
        cx.notify();
      })
      .on_mouse_move((_e, cx) => this.dragOver({ status: task.status, before: id }, cx))
      .on_mouse_up("left", (_e, cx) => this.finishDrag(cx))
      .child(div().id(`box-${id}`).mt(2).size(13).flex_none().rounded(3).border(1.5)
        .border_color(done ? color : task.status === "doing" ? color : t.dim)
        .bg(done ? color : t.background).cursor_pointer()
        .flex().items_center().justify_center().text_size(9).text_color(t.background)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); this.change(M.toggleDone(id), cx); })
        .child(done ? "✓" : ""))
      .child(div().flex_1().min_w(0).text_color(done ? t.dim : t.foreground).when(done, (el) => el.line_through()).child(task.text))
      .when(selected, (el) => el.child(h_flex().flex_none().gap(2)
        .child(this.iconButton(`edit-${id}`, "✎", t, (cx) => this.startEdit(task, cx)))
        .child(this.iconButton(`del-${id}`, "×", t, (cx) => { this.confirm = id; cx.notify(); }))));
  }

  iconButton(id, label, t, action) {
    return div().id(id).w(18).h(18).flex().items_center().justify_center().rounded(4).text_size(12).text_color(t.dim)
      .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
      .child(label);
  }

  confirmRow(id, text, t) {
    const btn = (key, label, danger, action) => div().id(`${key}-${id}`).px(8).py(2).rounded(5).text_size(11.5).cursor_pointer()
      .bg(danger ? `${t.ansi1}33` : t.raised).hover((s) => s.bg(danger ? `${t.ansi1}55` : t.hover))
      .on_click((_e, cx) => action(cx)).child(label);
    return v_flex().flex_none().mx(6).my(1).px(8).py(6).gap(6).rounded(6).bg(t.raised)
      .child(div().text_size(12).text_color(t.muted).truncate().child(`Delete “${text || "Untitled"}”?`))
      .child(h_flex().gap(6)
        .child(btn("yes", "Delete", true, (cx) => this.doDelete(id, cx)))
        .child(btn("no", "Cancel", false, (cx) => { this.confirm = null; this.handle.focus(); cx.notify(); }))
        .child(div().text_size(10.5).text_color(t.dim).child("Enter / Esc")));
  }

  notesView(t) {
    if (this.note) return this.noteEditor(t);
    const list = M.notesFor(this.data, this.search.value());
    const rows = list.map((n) => {
      if (this.confirm === n.id) return this.confirmRow(n.id, M.noteTitle(n), t);
      const selected = this.noteSel === n.id;
      return v_flex().id(`note-${n.id}`).flex_none().mx(6).my(1).px(8).py(6).gap(1).rounded(6).cursor_pointer()
        .bg(selected ? t.raised : t.background).hover((s) => s.bg(selected ? t.raised : t.hover))
        .on_click((_e, cx) => this.openNote(n.id, cx))
        .on_mouse_down("left", () => { this.noteSel = n.id; this.handle.focus(); })
        .child(h_flex().gap(6).items_center()
          .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(n.title.trim() ? t.foreground : t.muted).child(M.noteTitle(n)))
          .when(selected, (el) => el.child(this.iconButton(`ndel-${n.id}`, "×", t, (cx) => { this.confirm = n.id; cx.notify(); }))))
        .child(div().truncate().text_size(11.5).text_color(t.dim).child(M.notePreview(n) || " "));
    });
    const query = this.search.value().trim();
    return v_flex().flex_1().min_h(0)
      .child(div().flex_none().mx(8).mb(6).child(Input.new(this.search)))
      .child(v_flex().id("notes").flex_1().min_h(0).overflow_y_scrollbar().pb(8).children(rows)
        .when(!rows.length && this.loaded, (el) => el.child(div().px(14).py(6).text_size(11.5).text_color(t.dim)
          .child(query ? "No notes match." : "No notes yet. Press n or click + New note.")))
        .child(div().id("new-note").flex_none().mx(6).my(2).px(8).py(4).rounded(6).cursor_pointer()
          .text_size(12).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.muted))
          .on_click((_e, cx) => this.newNote(cx))
          .child("+ New note")));
  }

  noteEditor(t) {
    return v_flex().flex_1().min_h(0).px(8).pb(8).gap(6)
      .child(h_flex().flex_none().gap(6).items_center()
        .child(div().id("note-back").w(22).h(22).flex().items_center().justify_center().rounded(5).cursor_pointer()
          .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => this.closeNote(cx)).child("←"))
        .child(div().flex_1().min_w(0).child(Input.new(this.note.title))))
      .child(Textarea.new(this.note.body).flex_1().min_h(0));
  }
}
