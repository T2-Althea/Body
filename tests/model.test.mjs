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
