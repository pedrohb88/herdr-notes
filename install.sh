#!/usr/bin/env bash
# Installs herdr-notes into the Herdr desktop app (Linux and macOS).
#
#   ./install.sh               copy the mod, add the panel to the layout on
#                              screen (under Agents) and bind ctrl-shift-y
#   ./install.sh --uninstall   take the panel out of every layout, unbind the
#                              key and remove the mod (the data file stays)
#
# Run it again to upgrade the mod in place. The Herdr app must be running.
# Herdr's own layouts (main, terminals, win98) can't be edited: duplicate one
# first (Command palette → Duplicate layout) and switch to it.
set -euo pipefail

usage() { sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; }
case "${1:-}" in
  "" | --uninstall) ;;
  -h | --help) usage; exit 0 ;;
  *) usage >&2; exit 1 ;;
esac

here=$(cd "$(dirname "$0")" && pwd)
home=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
mod=herdr-notes
block='{"type": "block", "id": "herdr-notes", "size": {"weight": 1.2}, "min": 140, "content": {"mod": "herdr-notes"}}'
key=ctrl-shift-y
action="layout.toggle:herdr-notes"

die() { echo "herdr-notes: $*" >&2; exit 1; }
say() { echo "herdr-notes: $*"; }

command -v herdr-app >/dev/null || die "herdr-app is not on PATH"
python3 -c 'import json' 2>/dev/null || die "python3 is needed to edit the layout and keys files"
herdr-app status >/dev/null 2>&1 || die "open the Herdr app first"

# Ours: installed by this script, or by an agent from this repo.
ours() {
  [ -f "$1/.herdr-notes" ] || head -n 1 "$1/main.js" 2>/dev/null | grep -q '^// herdr-notes:'
}

# Edits a JSON file with a Python snippet that gets `d` and the arguments.
edit_json() {
  local file=$1 code=$2; shift 2
  python3 -I - "$file" "$code" "$@" <<'EOF'
import json, sys
path, code, args = sys.argv[1], sys.argv[2], sys.argv[3:]
with open(path) as f:
    d = json.load(f)
env = {"d": d, "args": args, "changed": False, "json": json}
exec(code, env)
if env["changed"]:
    with open(path + ".tmp", "w") as f:
        json.dump(env["d"], f, indent=2, ensure_ascii=False)
        f.write("\n")
    import os
    os.replace(path + ".tmp", path)
print(env.get("result", ""))
EOF
}

tree='
root = d.get("root", d)
def ours(n):
    return n.get("id") == "herdr-notes" and (n.get("content") or {}).get("mod") == "herdr-notes"
def path_to(n, i, up=()):
    if n.get("id") == i:
        return up + (n,)
    for c in n.get("children", []):
        r = path_to(c, i, up + (n,))
        if r:
            return r
    return None
'

if [ "${1:-}" = --uninstall ]; then
  for f in "$home"/layouts/*.json; do
    [ -f "$f" ] || continue
    r=$(edit_json "$f" "$tree"'
def drop(n):
    global changed
    kids = n.get("children", [])
    keep = [c for c in kids if not ours(c)]
    if len(keep) != len(kids):
        n["children"] = keep
        changed = True
    for c in keep:
        drop(c)
drop(root)
result = "removed" if changed else ""
')
    [ -z "$r" ] || say "layout $(basename "$f" .json): panel removed"
  done
  if [ -f "$home/keys.json" ]; then
    r=$(edit_json "$home/keys.json" '
g = d.get("global", {})
if g.get(args[0]) == args[1]:
    del g[args[0]]
    changed = True
result = "unbound" if changed else "not ours, left alone"
' "$key" "$action")
    say "key $key: $r"
  fi
  if [ ! -e "$home/mods/$mod" ]; then
    say "no mod at $home/mods/$mod"
  elif ours "$home/mods/$mod"; then
    rm -rf "${home:?}/mods/$mod"
    say "mod removed"
  else
    say "$home/mods/$mod is not herdr-notes; left alone"
  fi
  say "uninstalled (your data file stays: ~/.herdr-notes/data.json, or the block's \"file\" prop)"
  exit 0
fi

layout=$(herdr-app status | python3 -c 'import json,sys; print(json.load(sys.stdin)["layout"])')
case $layout in main|terminals|win98) die "the layout on screen ($layout) is one of Herdr's own; duplicate it (Command palette → Duplicate layout), switch to the copy and run this again" ;; esac
layout_file=$home/layouts/$layout.json
[ -f "$layout_file" ] || die "no layout file at $layout_file"

# 1. The mod, checked before anything else changes.
[ ! -e "$home/mods/$mod" ] || ours "$home/mods/$mod" ||
  die "$home/mods/$mod exists and is not herdr-notes; move it away first"
stage=$home/mods/.$mod.new
rm -rf "$stage"
mkdir -p "$stage/$mod"
cp "$here/mods/$mod/main.js" "$here/mods/$mod/model.js" "$here/mods/$mod/mod.json" "$stage/$mod/"
echo "Installed by herdr-notes/install.sh" > "$stage/$mod/.herdr-notes"
herdr-app check "$stage/$mod" || { rm -rf "$stage"; die "herdr-app check failed; nothing changed"; }
rm -rf "${home:?}/mods/$mod"
mv "$stage/$mod" "$home/mods/$mod"
rmdir "$stage"
say "mod installed in $home/mods/$mod"

stamp=$(mktemp)
trap 'rm -f "$stamp"' EXIT

# 2. The panel, under Agents (after the stack Agents sits in, if any, so it
#    doesn't become a hidden tab).
r=$(edit_json "$layout_file" "$tree"'
block = json.loads(args[0])
mine = path_to(root, "herdr-notes")
if mine:
    result = "already there" if ours(mine[-1]) else "CLASH"
else:
    p = path_to(root, "agents")
    if not p or len(p) < 2:
        result = "NO_AGENTS"
    else:
        anchor, parent = p[-1], p[-2]
        if parent.get("type") == "stack" and len(p) >= 3:
            anchor, parent = parent, p[-3]
        kids = parent["children"]
        kids.insert(kids.index(anchor) + 1, block)
        changed = True
        result = "added under Agents"
' "$block")
case $r in
  CLASH) die "the mod is installed, but layout $layout has a block with id herdr-notes showing something else; rename that block and run this again" ;;
  NO_AGENTS) die "the mod is installed, but layout $layout has no agents block to put the panel under. Add this block where you want it in $layout_file:
  $block" ;;
esac
say "layout $layout: panel $r"

# 3. The key, only if free. No keys.json yet: Herdr writes it on start, and a
#    file with only this key could stand in for the whole table.
keys=$home/keys.json
if [ ! -f "$keys" ]; then
  say "key $key: no $keys yet; restart Herdr and run this again, or bind $action yourself"
else
  r=$(edit_json "$keys" '
g = d.setdefault("global", {})
k, a = args
if g.get(k) == a:
    result = "already bound"
elif k in g:
    result = "taken by " + str(g[k]) + "; left alone (bind " + a + " yourself)"
else:
    g[k] = a
    changed = True
    result = "bound to show/hide the panel"
' "$key" "$action")
  say "key $key: $r"
fi

# Herdr writes *.error when it rejects a file; only errors newer than our edits count.
sleep 1
for f in "$home/layout.error" "$home/keys.error"; do
  if [ -s "$f" ] && [ "$f" -nt "$stamp" ]; then
    cat "$f" >&2
    die "Herdr rejected an edit (see above)"
  fi
done
say "done"
