// Minimal OpenAI-compatible backend for local testing. Replies with a numbered
// line and records every request it receives, so tests can check exactly what
// SillyTavern sent (e.g. whether an injected note is in the prompt).
// Usage: node dev/fake-llm.cjs [port] [logFile]
const http = require('http');
const fs = require('fs');
const port = Number(process.argv[2] || 5001);
const logFile = process.argv[3] || 'fake-llm-requests.jsonl';
let n = 0;
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
            fs.appendFileSync(logFile, JSON.stringify({ messages: data.messages }) + '\n');
            n++;
            return res.end(JSON.stringify({
                id: 'fake-' + n, object: 'chat.completion', model: 'fake-model',
                choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: `Fake reply number ${n}.` } }],
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            }));
        }
        res.statusCode = 404;
        res.end('{}');
    });
}).listen(port, '127.0.0.1', () => console.log(`fake LLM on ${port}`));
