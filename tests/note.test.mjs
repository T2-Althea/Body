// Run: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { expandTemplate, replay } from '../src/model.js';
import { buildNote, estimateTokens, NOTE_HEADER } from '../src/note.js';

const index = expandTemplate(JSON.parse(readFileSync(new URL('../templates/human.json', import.meta.url))));
const members = [{ key: 'user', name: 'Aren', isUser: true }, { key: 'c:mira.png', name: 'Mira', isUser: false }];
const opts = { budget: 200, tempUnit: 'C', tempInNote: 'abnormal' };
const add = (who, cond, index = 1) => ({ index, ops: [{ t: 'add', who, cond: { id: Math.random().toString(36), ...cond } }] });

test('healthy scene produces no note', () => {
    const note = buildNote(members, replay([]), index, opts, estimateTokens);
    assert.equal(note.text, '');
});

test('concept example renders worst first, grouped by character', () => {
    const bodies = replay([
        add('c:mira.png', { kind: 'injury', part: 'left_thigh', type: 'Arrow wound', severity: 'moderate', status: 'fresh', details: 'Arrowhead still in', bleeding: 'moderate', effect: "Can't run; limps" }),
        add('c:mira.png', { kind: 'state', part: '_body', type: 'Wet', severity: 'minor', effect: 'Hands clumsy from the cold' }),
        add('c:mira.png', { kind: 'state', part: '_body', type: 'Cold', severity: 'moderate' }),
        { index: 2, ops: [{ t: 'temp', who: 'c:mira.png', value: 35.8 }] },
        add('user', { kind: 'missing', part: 'left_hand', type: 'Missing', cause: 'Old injury', effect: 'One-handed only' }),
        add('user', { kind: 'injury', part: 'right_ribs', type: 'Bruise', severity: 'minor', status: 'fresh', effect: 'Pain when twisting or lifting' }),
    ]);
    const { text } = buildNote(members, bodies, index, opts, estimateTokens);
    const lines = text.split('\n');
    assert.equal(lines[0], NOTE_HEADER);
    assert.equal(lines[1], 'Aren (user):');
    assert.equal(lines[2], '- Left hand missing (old injury). One-handed only.');
    assert.equal(lines[3], '- Right ribs: bruise, minor. Pain when twisting or lifting.');
    assert.equal(lines[4], 'Mira:');
    assert.equal(lines[5], "- Left thigh: arrow wound, moderate, arrowhead still in, moderate bleeding. Can't run; limps.");
    assert.equal(lines[6], '- Whole body: wet, cold; temperature 35.8 °C (low). Hands clumsy from the cold.');
});

test('trivial leftovers drop off; normal temperature stays out', () => {
    const bodies = replay([
        add('user', { kind: 'injury', part: 'nose', type: 'Scratch', severity: 'minor', status: 'scarred' }),
        { index: 1, ops: [{ t: 'temp', who: 'user', value: 36.8 }] },
    ]);
    assert.equal(buildNote(members, bodies, index, opts, estimateTokens).text, '');
});

test('states limited to an area name it', () => {
    const bodies = replay([
        add('user', { kind: 'state', part: 'left_foot', type: 'Wet', severity: 'minor' }),
        add('user', { kind: 'state', part: '_body', type: 'Cold', severity: 'minor' }),
    ]);
    assert.match(buildNote(members, bodies, index, opts, estimateTokens).text, /- States: wet \(left foot\), cold\./);
});

test('hidden conditions are marked', () => {
    const bodies = replay([add('c:mira.png', { kind: 'injury', part: 'abdomen', type: 'Stab wound', severity: 'severe', hidden: true })]);
    assert.match(buildNote(members, bodies, index, opts, estimateTokens).text, /abdomen: stab wound, severe\. Hidden: others don't know/i);
});

test('budget keeps the most important lines', () => {
    const recs = [];
    for (let i = 0; i < 30; i++) recs.push(add('c:mira.png', { kind: 'injury', part: 'left_thigh', type: `Cut number ${i}`, severity: 'minor', status: 'fresh' }));
    recs.push(add('c:mira.png', { kind: 'injury', part: 'heart', type: 'Stab wound', severity: 'critical', bleeding: 'heavy' }));
    const note = buildNote(members, replay(recs), index, { ...opts, budget: 80 }, estimateTokens);
    assert.ok(note.text.includes('Heart: stab wound, critical'));
    assert.ok(note.omitted > 0);
    assert.ok(estimateTokens(note.text) <= 80, `got ${estimateTokens(note.text)}`);
});
