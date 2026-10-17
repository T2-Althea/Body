// Points a local SillyTavern install at the fake backend (dev/fake-llm.cjs).
// Usage: node dev/configure-st.cjs <path-to-SillyTavern> [fakePort]
const fs = require('fs');
const path = require('path');
const root = process.argv[2];
const port = Number(process.argv[3] || 5001);
const file = path.join(root, 'data/default-user/settings.json');
const s = JSON.parse(fs.readFileSync(file, 'utf8'));
s.main_api = 'openai';
s.oai_settings = Object.assign(s.oai_settings || {}, {
    chat_completion_source: 'custom',
    custom_url: `http://127.0.0.1:${port}/v1`,
    custom_model: 'fake-model',
    stream_openai: false,
});
s.power_user = Object.assign(s.power_user || {}, { welcome_screen: false });
fs.writeFileSync(file, JSON.stringify(s, null, 4));
console.log('configured', file);
