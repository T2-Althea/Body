#!/bin/bash
# Starts SillyTavern + the fake backend, runs the unit tests and every e2e test,
# then stops both servers. Run in the foreground: background jobs in the cloud
# sandbox are killed after about two hours.
#
# Usage: dev/run-all.sh [screenshot-dir]
#   TESTS="e2e-m4 e2e-m7" dev/run-all.sh   run only some e2e tests
#   FILTER="PASS|FAIL|passed" dev/run-all.sh   choose which output lines to show
# Expects SillyTavern at $ST (default /home/user/st/SillyTavern); see dev/README.md.
HERE="$(cd "$(dirname "$0")" && pwd)"
ST="${ST:-/home/user/st/SillyTavern}"
LOG="$(dirname "$ST")/requests.jsonl"
SHOTS="${1:-$(dirname "$ST")/shots}"
mkdir -p "$SHOTS"
(cd "$ST" && node server.js --port 8000 > ../st.log 2>&1) & STPID=$!
node "$HERE/fake-llm.cjs" 5001 "$LOG" > "$(dirname "$ST")/fake.log" 2>&1 & FKPID=$!
trap 'kill $STPID $FKPID 2>/dev/null; pkill -P $STPID 2>/dev/null' EXIT
for i in $(seq 1 60); do curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8000/ | grep -q 200 && break; sleep 1; done
echo "== unit"; node --test "$HERE"/../tests/*.test.mjs 2>&1 | grep -E "^# (pass|fail)|^not ok"
cd "$(dirname "$ST")"
ALL=$(ls "$HERE"/e2e-*.cjs | xargs -n1 basename | sed 's/\.cjs$//' | sort -V)
for t in ${TESTS:-$ALL}; do
    echo "== $t"
    SHOT="$SHOTS/$t.png" NODE_PATH="$(npm root -g)" timeout 500 node "$HERE/$t.cjs" http://127.0.0.1:8000/ "$LOG" "$SHOTS" 2>&1 | grep -E "${FILTER:-FAIL|passed|Error}"
done
