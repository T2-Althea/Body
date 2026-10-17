# Dev harness

Runs the extension inside a real SillyTavern with a fake AI backend, so features
can be tested end to end without a paid model.

```bash
git clone --depth 1 https://github.com/SillyTavern/SillyTavern.git st && (cd st && npm ci)
(cd st && node server.js --port 8000 &)          # first start creates data/default-user
ln -sfn "$PWD/Body" st/data/default-user/extensions/Body
node Body/dev/configure-st.cjs st                 # point ST at the fake backend
node Body/dev/fake-llm.cjs 5001 requests.jsonl &
node Body/dev/e2e-m0.cjs http://127.0.0.1:8000/ requests.jsonl   # needs playwright
node Body/dev/e2e-m1.cjs http://127.0.0.1:8000/ requests.jsonl [screenshot-dir]
node Body/dev/e2e-m2.cjs http://127.0.0.1:8000/ requests.jsonl [screenshot-dir]
node Body/dev/e2e-m3.cjs http://127.0.0.1:8000/ requests.jsonl [screenshot-dir]
node Body/dev/e2e-m4.cjs http://127.0.0.1:8000/ requests.jsonl [screenshot-dir]
node Body/dev/e2e-m5.cjs http://127.0.0.1:8000/ requests.jsonl
node Body/dev/e2e-m6.cjs http://127.0.0.1:8000/ requests.jsonl [screenshot-dir]
node Body/dev/e2e-body.cjs http://127.0.0.1:8000/ requests.jsonl [screenshot-dir]
node Body/dev/e2e-m7.cjs http://127.0.0.1:8000/ requests.jsonl [screenshot-dir]
node --test Body/tests/*.test.mjs                                # unit tests, no ST needed
```
