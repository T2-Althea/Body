# Dev harness

Runs the extension inside a real SillyTavern with a fake AI backend, so features
can be tested end to end without a paid model.

## One-time setup (a fresh cloud session starts without SillyTavern)
```bash
mkdir -p /home/user/st && cd /home/user/st
git clone --depth 1 https://github.com/SillyTavern/SillyTavern.git && (cd SillyTavern && npm ci)
(cd SillyTavern && timeout 40 node server.js --port 8000)   # first start creates data/default-user, then stops
ln -sfn /home/user/Body SillyTavern/data/default-user/extensions/Body
node /home/user/Body/dev/configure-st.cjs SillyTavern     # point ST at the fake backend
```
Playwright and Chromium are preinstalled in the cloud sandbox; scripts need
`NODE_PATH=$(npm root -g)` to find Playwright (run-all.sh sets it).

## Running tests
```bash
dev/run-all.sh                       # unit tests + every dev/e2e-*.cjs, servers started and stopped for you
TESTS="e2e-m7 e2e-editor" dev/run-all.sh
node --test tests/*.test.mjs         # unit tests only, no SillyTavern needed
```
Each e2e script prints PASS/FAIL per check and saves screenshots (third argument).

## Pieces
- `fake-llm.cjs`: OpenAI-compatible fake backend. Roleplay replies are "Fake reply
  number N" (or an arrow-wound reply when the user message contains ARROW_REPLY);
  Body HUD detection/✨ requests get canned JSON from keywords, logged to
  `<log>.tasks`; "think too long" imitates a reasoning model running out of tokens.
- `configure-st.cjs`: points a local ST at the fake backend.
- `st-page.cjs`: shared Playwright setup (first-run popup, connect, reset profiles).
- `e2e-*.cjs`: one per milestone/feature.
