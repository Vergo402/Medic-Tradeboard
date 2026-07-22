#!/usr/bin/env bash
# scripts/ci/gate.sh — CI / commit gate for the Medic Tradeboard extension: lint,
# slop, the committed-manifest key guard, a tracked-capture guard, then the node
# tests. Runnable locally or in CI. Every step runs even if an earlier one fails,
# so one invocation surfaces every problem; exits nonzero if ANY step failed.
#
#   bash scripts/ci/gate.sh          # everything (pre-push + CI)
#   bash scripts/ci/gate.sh --fast   # instant checks only: lint, slop, guards
#                                    # (pre-commit — skips the node suite)
set -uo pipefail

FAST=0; [ "${1:-}" = "--fast" ] && FAST=1
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

STEPS=(); RESULTS=(); DURS=()
run_step() {
    local name="$1"; shift
    echo; echo "=== $name ==="
    local start=$SECONDS
    if "$@"; then RESULTS+=("PASS"); else RESULTS+=("FAIL"); fi
    DURS+=("$((SECONDS - start))s"); STEPS+=("$name")
}

eslint_step() { npx --yes eslint@9 core/*.js; }

# The COMMITTED manifest.json must carry no "key" field — a key pins the extension
# id, and this repo is public. Checks HEAD, NOT the working tree (which legitimately
# holds a local dev key). tools/check-no-key.sh guards the staged copy at commit
# time; this is the CI / push backstop.
manifest_key_guard() {
    git show HEAD:manifest.json 2>/dev/null | node -e '
      let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
        let m; try{m=JSON.parse(s)}catch{process.exit(0)}
        if("key" in m){console.error("committed manifest.json has a \"key\" field");process.exit(1)}
        console.log("committed manifest: no key field")});'
}

# No raw board capture may be tracked (they hold real coworker names). Scrubbed
# fixtures are named board-*.anon.html and are fine.
capture_guard() {
    local bad
    bad=$(git ls-files | grep -E '(^|/)(tb_|drop_|trade_|mysched_|td_)[^/]*\.html$|_capture\.html$' || true)
    if [ -n "$bad" ]; then echo "tracked raw capture(s):"; echo "$bad"; return 1; fi
    echo "no raw captures tracked"
}

run_step "[1/5] eslint core/*.js"            eslint_step
run_step "[2/5] slopcheck"                   node scripts/ci/slopcheck.js
run_step "[3/5] manifest key guard"          manifest_key_guard
run_step "[4/5] capture guard"               capture_guard
if [ "$FAST" -eq 0 ]; then
    run_step "[5/5] node --test test/*.test.js"  node --test test/*.test.js
fi

echo; echo "=== summary ==="
FAIL=0
for i in "${!STEPS[@]}"; do
    printf "  %-36s %-4s (%s)\n" "${STEPS[$i]}" "${RESULTS[$i]}" "${DURS[$i]}"
    [ "${RESULTS[$i]}" = FAIL ] && FAIL=1
done
echo
if [ "$FAIL" -eq 0 ]; then echo "GATE: PASS"; else echo "GATE: FAIL"; fi
exit "$FAIL"
