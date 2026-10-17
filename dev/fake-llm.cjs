// Minimal OpenAI-compatible backend for local testing. Replies with a numbered
// line and records every request it receives, so tests can check exactly what
// SillyTavern sent (e.g. whether an injected note is in the prompt).
// Usage: node dev/fake-llm.cjs [port] [logFile]
const http = require('http');
const fs = require('fs');
const port = Number(process.argv[2] || 5001);
const logFile = process.argv[3] || 'fake-llm-requests.jsonl';
let n = 0;
// If the user's message contains ARROW_REPLY, the first reply to it describes an
// arrow wound (so detection fires on the AI's message) and later swipes don't.
const arrowReplied = new Set();
function chatReply(messages, n) {
    const lastUser = [...(messages || [])].reverse().find(m => m.role === 'user');
    const text = String(lastUser?.content ?? '');
    if (text.includes('ARROW_REPLY') && !arrowReplied.has(text)) {
        arrowReplied.add(text);
        return 'An arrow hits Seraphina in the left thigh.';
    }
    return `Fake reply number ${n}.`;
}

// Canned answers for Body HUD's detection and ✨ fill requests (null = normal chat).
function taskReply(all) {
    if (all.includes('[BODY_HUD_TASK:fill]')) {
        return '```json\n{"effect": "Can\'t put weight on it", "details": "Deep puncture", "cause": "Ambush on the road"}\n```';
    }
    if (!all.includes('[BODY_HUD_TASK:detect]')) return null;
    const text = (all.split(/NEW MESSAGE — [^\n]*:\n/)[1] || '').toLowerCase();
    const who = 'Seraphina';
    const changes = [];
    if (text.includes('heart broke')) return '{"changes": []}';
    if (text.includes('arrow') && text.includes('thigh')) {
        changes.push({ action: 'add', character: who, kind: 'injury', part: 'left_thigh', type: 'Arrow wound', severity: 'moderate', bleeding: 'moderate', status: 'fresh', details: 'Arrowhead still in', effect: "Can't run; limps", cause: 'Ambush', hidden: false });
    }
    if (/bites?\b.*\bleg/.test(text)) changes.push({ action: 'add', character: who, kind: 'injury', part: 'leg', type: 'Bite', severity: 'minor', bleeding: 'light' });
    if (text.includes('bandag')) {
        const id = (all.match(/\[(c\d+)\]/) || [])[1];
        if (id) changes.push({ action: 'update', character: who, id, changes: { status: 'treated', bleeding: 'none' } });
    }
    if (text.includes('soak')) changes.push({ action: 'add', character: who, kind: 'state', type: 'Wet', severity: 'minor' });
    if (text.includes('fever')) changes.push({ action: 'temperature', character: who, celsius: 38.9 });
    return 'Here you go:\n' + JSON.stringify({ changes });
}
http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url.endsWith('/models')) {
            return res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] }));
        }
        if (req.url.endsWith('/chat/completions')) {
            const data = JSON.parse(body || '{}');
            const all = (data.messages || []).map(m => String(m.content)).join('\n');
            const task = taskReply(all);
            // Extension background tasks go to a separate log, so tests reading the
            // roleplay requests aren't confused by them.
            fs.appendFileSync(task ? logFile + '.tasks' : logFile, JSON.stringify({ messages: data.messages, max_tokens: data.max_tokens }) + '\n');
            n++;
            // Imitates a reasoning model that used its whole allowance thinking.
            const newMessage = all.split(/NEW MESSAGE — [^\n]*:\n/)[1] || '';
            const exhausted = task !== null && newMessage.includes('think too long');
            return res.end(JSON.stringify({
                id: 'fake-' + n, object: 'chat.completion', model: 'fake-model',
                choices: [{ index: 0, finish_reason: exhausted ? 'length' : 'stop', message: { role: 'assistant', content: exhausted ? '' : (task ?? chatReply(data.messages, n)) } }],
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            }));
        }
        res.statusCode = 404;
        res.end('{}');
    });
}).listen(port, '127.0.0.1', () => console.log(`fake LLM on ${port}`));
