// Run: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { expandTemplate, replay, missingParts, isAffected } from '../src/model.js';

const tpl = JSON.parse(readFileSync(new URL('../templates/human.json', import.meta.url)));
const index = expandTemplate(tpl);

test('sided parts expand with prefixed descendants', () => {
    assert.equal(index.parts.get('left_arm').name, 'Left arm');
    assert.equal(index.parts.get('left_thumb').name, 'Left thumb');
    assert.equal(index.parts.get('left_thumb').parentId, 'left_hand');
    assert.equal(index.parts.get('right_eye').regionId, 'head');
    assert.equal(index.parts.get('left_thumb').regionId, 'left_hand');
    assert.ok(!index.parts.has('arm'));
    assert.equal(new Set(index.order).size, index.order.length, 'ids are unique');
});

test('replay applies add, edit, remove and temp in order', () => {
    const bodies = replay([
        { index: -1, ops: [{ t: 'add', who: 'user', cond: { id: 'a', kind: 'missing', part: 'left_hand' } }] },
        { index: 3, ops: [{ t: 'add', who: 'c:mira.png', cond: { id: 'b', kind: 'injury', part: 'left_thigh', type: 'Arrow wound', severity: 'moderate' } }] },
        { index: 5, ops: [{ t: 'edit', who: 'c:mira.png', id: 'b', changes: { status: 'treated' } }, { t: 'temp', who: 'c:mira.png', value: 35.8 }] },
    ]);
    const mira = bodies.get('c:mira.png');
    assert.equal(mira.conditions.get('b').status, 'treated');
    assert.equal(mira.conditions.get('b').since, 3);
    assert.equal(mira.temp, 35.8);
    const after = replay([
        { index: 3, ops: [{ t: 'add', who: 'x', cond: { id: 'b', kind: 'injury', part: 'nose' } }] },
        { index: 4, ops: [{ t: 'remove', who: 'x', id: 'b' }] },
    ]);
    assert.equal(isAffected(after.get('x')), false);
    const lost = missingParts(bodies.get('user'), index);
    assert.ok(lost.has('left_hand') && lost.has('left_little_finger') && !lost.has('left_forearm'));
});

test('mannequin: sided shapes map to the right side per view, regions get worst severity', async () => {
    const { viewShapes, mirrorPath, regionStatus } = await import('../src/mannequin.js');
    assert.equal(mirrorPath('M70 41 C74 43 75 49 75 57 Z'), 'M30 41 C26 43 25 49 25 57 Z');
    const front = viewShapes(index.mannequin, 'front');
    const back = viewShapes(index.mannequin, 'back');
    const frontLeftArm = front.find(s => s.region === 'left_arm');
    const backLeftArm = back.find(s => s.region === 'left_arm');
    assert.ok(frontLeftArm.d.startsWith('M70'), 'front: character left is on the viewer right');
    assert.ok(backLeftArm.d.startsWith('M30'), 'back: character left is on the viewer left');
    for (const s of [...front, ...back]) assert.ok(index.parts.has(s.region), `shape region ${s.region} exists`);
    const body = replay([
        { index: 1, ops: [{ t: 'add', who: 'u', cond: { id: '1', kind: 'injury', part: 'left_thumb', type: 'Cut', severity: 'minor' } }] },
        { index: 2, ops: [{ t: 'add', who: 'u', cond: { id: '2', kind: 'injury', part: 'left_palm', type: 'Burn', severity: 'severe' } }] },
        { index: 3, ops: [{ t: 'add', who: 'u', cond: { id: '3', kind: 'missing', part: 'right_foot' } }] },
        { index: 4, ops: [{ t: 'add', who: 'u', cond: { id: '4', kind: 'missing', part: 'left_ring_finger' } }] },
    ]).get('u');
    const st = regionStatus(body, index);
    assert.equal(st.get('left_hand').worst, 'severe');
    assert.equal(st.get('left_hand').partlyMissing, true);
    assert.equal(st.get('right_foot').missing, true);
    assert.equal(st.get('left_arm'), undefined);
});
