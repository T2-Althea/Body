// Run: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { expandTemplate, replay } from '../src/model.js';
import { buildDetectPrompt, mightMatter, parseDetection, resolvePart, withSide } from '../src/detect.js';
import { extractJson } from '../src/llm.js';

const index = expandTemplate(JSON.parse(readFileSync(new URL('../templates/human.json', import.meta.url))));
const members = [{ key: 'user', name: 'Aren', isUser: true }, { key: 'c:mira.png', name: 'Mira', isUser: false }];

test('prefilter', () => {
    assert.equal(mightMatter('She smiles and pours the tea.'), false);
    assert.equal(mightMatter('An arrow takes her in the thigh.'), true);
    assert.equal(mightMatter('Rain soaks them both.'), true);
    for (const calm of ['Fake reply number 1.', 'Several cute rainbows.', 'She paints a scarf.', 'A sober sweater and crackers.']) {
        assert.equal(mightMatter(calm), false, calm);
    }
    for (const hurt of ['Her hand goes numb.', 'The blade severs a finger.', 'Pain shoots up her arm.', 'A deep cut.']) {
        assert.equal(mightMatter(hurt), true, hurt);
    }
});

test('extractJson tolerates fences and chatter', () => {
    assert.deepEqual(extractJson('Sure!\n```json\n{"changes": [{"a": "x}"}]}\n```'), { changes: [{ a: 'x}' }] });
    assert.equal(extractJson('no json here'), null);
});

test('resolvePart', () => {
    assert.deepEqual(resolvePart('left_thigh', index), { id: 'left_thigh' });
    assert.deepEqual(resolvePart('thigh', index), { id: null, base: 'thigh' });
    assert.deepEqual(resolvePart('Left thigh', index), { id: 'left_thigh' });
    assert.deepEqual(resolvePart('heart', index), { id: 'heart' });
    assert.deepEqual(resolvePart('tail', index), { id: null });
});

test('prompt lists current conditions with short ids', () => {
    const bodies = replay([{ index: 1, ops: [{ t: 'add', who: 'c:mira.png', cond: { id: 'real1', kind: 'injury', part: 'left_thigh', type: 'Arrow wound', severity: 'moderate', status: 'fresh', bleeding: 'moderate' } }] }]);
    const { user, ids } = buildDetectPrompt({ members, bodies, index, message: { name: 'Mira', text: 'She bandages it.' } });
    assert.match(user, /\[c1\] Left thigh: Arrow wound \(injury, moderate, fresh, bleeding moderate\)/);
    assert.deepEqual(ids.toReal.get('c1'), { who: 'c:mira.png', id: 'real1' });
});

test('parseDetection maps actions to ops and flags unknown sides', () => {
    const bodies = replay([{ index: 1, ops: [{ t: 'add', who: 'c:mira.png', cond: { id: 'real1', kind: 'injury', part: 'left_thigh', type: 'Arrow wound' } }] }]);
    const { ids } = buildDetectPrompt({ members, bodies, index, message: { name: 'Mira', text: 'x' } });
    const { proposals, skipped } = parseDetection({ changes: [
        { action: 'add', character: 'mira', kind: 'injury', part: 'left_forearm', type: 'Cut', severity: 'MINOR', bleeding: 'light' },
        { action: 'add', character: 'Aren', kind: 'injury', part: 'knee', type: 'Bruise', severity: 'bogus' },
        { action: 'add', character: 'Guard', kind: 'injury', part: 'nose', type: 'Broken nose' },
        { action: 'update', character: 'Mira', id: 'c1', changes: { status: 'treated', bleeding: 'none' } },
        { action: 'temperature', character: 'Mira', celsius: 38.6 },
        { action: 'add', character: 'Mira', kind: 'state', type: 'Wet' },
    ] }, { members, index, ids });
    assert.equal(proposals.length, 6);
    assert.equal(proposals[0].op.cond.part, 'left_forearm');
    assert.equal(proposals[0].op.cond.severity, 'minor');
    assert.equal(proposals[1].needsSide, 'knee');
    assert.equal(proposals[1].op.cond.severity, 'moderate');
    assert.equal(withSide(proposals[1], 'right').op.cond.part, 'right_knee');
    // Someone not in the scene becomes a proposed NPC.
    assert.deepEqual(proposals[2].npc, { who: 'n:guard', name: 'Guard' });
    assert.equal(proposals[2].op.who, 'n:guard');
    assert.match(proposals[2].summary, /^New NPC Guard: Broken nose/);
    assert.deepEqual(proposals[3].op, { t: 'edit', who: 'c:mira.png', id: 'real1', changes: { status: 'treated', bleeding: 'none' } });
    assert.equal(proposals[4].op.value, 38.6);
    assert.equal(proposals[5].op.cond.part, '_body');
    assert.equal(skipped.length, 0);
    const off = parseDetection({ changes: [{ action: 'add', character: 'Guard', kind: 'injury', part: 'nose', type: 'Broken nose' }] }, { members, index, ids, allowNpcs: false });
    assert.equal(off.proposals.length, 0);
    assert.ok(off.skipped.some(s => s.includes('Guard')));
});

test('npc ops: join, update, leave', async () => {
    const { replay: rp, npcKey } = await import('../src/model.js');
    assert.equal(npcKey('The Old Guard!'), 'n:the_old_guard');
    const b = rp([
        { index: 1, ops: [{ t: 'npc_add', who: 'n:wolf', name: 'Wolf', sex: 'male' }, { t: 'add', who: 'n:wolf', cond: { id: 'w', kind: 'injury', part: 'left_leg', type: 'Bite' } }] },
        { index: 2, ops: [{ t: 'npc_update', who: 'n:wolf', changes: { sex: 'female' } }, { t: 'npc_leave', who: 'n:wolf' }] },
    ]);
    const wolf = b.get('n:wolf');
    assert.deepEqual(wolf.npc, { name: 'Wolf', present: false, sex: 'female' });
    assert.equal(wolf.conditions.size, 1, 'leaving keeps the body');
});

test('time skips', () => {
    assert.equal(mightMatter('Three days later, they reach the city.'), true);
    assert.equal(mightMatter('The next morning she wakes early.'), true);
    const { proposals } = parseDetection({ changes: [{ action: 'time_passes', days: 3 }, { action: 'time_passes', days: -1 }] }, { members, index, ids: { toReal: new Map() } });
    assert.equal(proposals.length, 1);
    assert.deepEqual(proposals[0].op, { t: 'timeskip', days: 3 });
    assert.equal(proposals[0].summary, 'Time passes: 3 days');
});
