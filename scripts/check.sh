#!/usr/bin/env bash
# Quality gate. Every task must leave this green:  bash scripts/check.sh   (--fast skips validate; --public checks export)
set -uo pipefail
cd "$(dirname "$0")/.."
to_unix_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -u "$1"; else printf '%s\n' "$1"; fi; }
to_host_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s\n' "$1"; fi; }
pwd_host() { pwd -W 2>/dev/null || pwd; }
default_cache_base() {
  if [ -n "${LOCALAPPDATA:-}" ]; then printf '%s\n' "$LOCALAPPDATA"
  elif [ -n "${XDG_CACHE_HOME:-}" ]; then printf '%s\n' "$XDG_CACHE_HOME"
  else printf '%s\n' "${HOME:-/tmp}/.cache"
  fi
}
CACHE_DIR="$(to_unix_path "${FLOWCANVAS_CACHE:-$(default_cache_base)/hermes/cache/flowcanvas-dev}")"
mkdir -p "$CACHE_DIR"
fail=0
step() { echo; echo "== $1"; }

step "python unit tests"
bash scripts/hpy scripts/run_tests.py 2>&1 | tail -15
[ "${PIPESTATUS[0]}" -eq 0 ] || fail=1

step "desktop/plugin.js syntax"
cp desktop/plugin.js "$CACHE_DIR/plugin.check.mjs" && node --check "$(to_host_path "$CACHE_DIR/plugin.check.mjs")" && echo ok || fail=1

step "js unit tests"
node tests/js/run.mjs || fail=1

if [ "${1:-}" != "--fast" ]; then
  step "hermes plugins validate"
  # no warnings allowed, except the single approved raw-bridge line for openWindow
  hermes plugins validate "$(pwd_host)" --json 2>&1 | node scripts/validate_gate.mjs || fail=1
fi

if [ "${1:-}" = "--public" ] && [ -f scripts/export_public.py ]; then
  step "public export check"
  PUBLIC_DIR="$CACHE_DIR/public-export-$$"
  rm -rf "$PUBLIC_DIR"
  PUBLIC_W="$(to_host_path "$PUBLIC_DIR")"
  if bash scripts/hpy scripts/export_public.py "$PUBLIC_W"; then
    bash scripts/hpy "$(to_host_path "$PUBLIC_DIR/scripts/run_tests.py")" 2>&1 | tail -5
    [ "${PIPESTATUS[0]}" -eq 0 ] || fail=1
    node "$(to_host_path "$PUBLIC_DIR/tests/js/run.mjs")" > /dev/null || fail=1
    hermes plugins validate "$PUBLIC_W" --json 2>&1 | node "$(to_host_path "$PUBLIC_DIR/scripts/validate_gate.mjs")" || fail=1
  else
    fail=1
  fi
  rm -rf "$PUBLIC_DIR"
fi

echo
if [ $fail -eq 0 ]; then echo "CHECK: PASS"; else echo "CHECK: FAIL"; fi
exit $fail
