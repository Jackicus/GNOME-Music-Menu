#!/usr/bin/env bash
# The gate every change passes before it is committed: JS parses, Python
# compiles, the schema compiles and the backend tests pass. No shell needed.
set -u
cd "$(dirname "$0")/.."
fail=0
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
for f in src/*.js src/lib/*.js; do
    cp "$f" "$tmp/x.mjs"
    node --check "$tmp/x.mjs" 2>"$tmp/err" || { echo "JS syntax: $f"; sed 's/^/    /' "$tmp/err"; fail=1; }
done
node tests/js/test_bridge.js || fail=1
# The GJS tests get a cache directory of their own: GLib settles the user's
# at start-up, so it has to be in the environment before gjs runs.
for t in tests/js/test_player_state.js tests/js/test_library.js; do
    XDG_CACHE_HOME="$tmp/cache" gjs -m "$t" >"$tmp/out" 2>&1 || { echo "gjs: $t"; sed 's/^/    /' "$tmp/out"; fail=1; }
done
python3 -m py_compile src/backend/*.py scripts/*.py || fail=1
glib-compile-schemas --strict --dry-run src/schemas || { echo "schema does not compile"; fail=1; }
python3 -m unittest discover -s tests -q || fail=1
[ $fail = 0 ] && echo "check: OK" || { echo "check: FAILED"; exit 1; }
