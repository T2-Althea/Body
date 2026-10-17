// Run: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOp, replay } from '../src/model.js';
import { daysToNextStage, planTimeSkip } from '../src/timeskip.js';

const add = (cond) => ({ index: 1, ops: [{ t: 'add', who: 'm', cond: { id: cond.id || Math.random().toString(36), kind: 'injury', part: 'left_thigh', ...cond } }] });
const nameOf = () => 'Mira';
const partName = id => id.replace(/_/g, ' ');
const plan = (bodies, days, realism = 'grounded') => planTimeSkip(bodies, ['m'], days, realism, nameOf, partName);
// Applies a plan and returns the body, to chain skips.
const apply = (bodies, changes) => { for (const c of changes) applyOp(bodies, c.op, 5); return bodies; };

test('treated moderate wound: healing after 3 days, scar after 3 weeks more', () => {
    const b = replay([add({ id: 'w', type: 'Arrow wound', severity: 'moderate', status: 'treated', bleeding: 'moderate', effect: "Can't run" })]);
    let p = plan(b, 3);
    assert.equal(p.length, 1);
    assert.deepEqual(p[0].op.changes, { status: 'healing', bleeding: 'none' });
    apply(b, p);
    p = plan(b, 21);
    assert.equal(p[0].op.changes.status, 'scarred');
    assert.equal(p[0].op.changes.severity, 'minor');
    assert.equal(p[0].op.changes.effect, '', 'moderate wounds leave no lasting limitation');
});

test('progress carries over between skips', () => {
    const b = replay([add({ id: 'w', type: 'Cut', severity: 'moderate', status: 'treated' })]);
    apply(b, plan(b, 2));
    assert.equal(b.get('m').conditions.get('w').status, 'treated');
    assert.equal(daysToNextStage(b.get('m').conditions.get('w')), 1);
    apply(b, plan(b, 1));
    assert.equal(b.get('m').conditions.get('w').status, 'healing');
});

test('minor wounds disappear; untreated heal slower in grounded', () => {
    const b = replay([add({ id: 'a', type: 'Scratch', severity: 'minor', status: 'healing' })]);
    assert.equal(plan(b, 7)[0].op.t, 'remove');
    const u = replay([add({ id: 'u', type: 'Cut', severity: 'moderate', status: 'fresh' })]);
    assert.notEqual(plan(u, 3)[0]?.op.changes?.status, 'healing');
    assert.equal(plan(u, 6)[0].op.changes.status, 'healing');
});

test('cinematic is four times faster and never worsens', () => {
    const b = replay([add({ id: 'w', type: 'Stab wound', severity: 'severe', status: 'fresh', bleeding: 'heavy' })]);
    const p = plan(b, 20, 'cinematic');
    assert.equal(p[0].op.changes.status, 'scarred');
    assert.equal(p[0].op.changes.severity, 'minor');
    assert.ok(!p.some(x => x.group === 'worsen'));
});

test('simulation: untreated wounds fester, blood loss and fever follow', () => {
    const b = replay([add({ id: 'w', type: 'Stab wound', severity: 'moderate', status: 'fresh', bleeding: 'heavy' })]);
    const p = plan(b, 4, 'simulation');
    const edit = p.find(x => x.op.t === 'edit');
    assert.equal(edit.op.changes.severity, 'severe');
    assert.match(edit.op.changes.details, /infected/);
    assert.ok(p.some(x => x.op.t === 'add' && x.op.cond.type === 'Weak from blood loss'));
    assert.ok(p.some(x => x.op.t === 'temp' && x.op.value === 38.9));
    // Treated wounds heal normally in simulation too.
    const t = replay([add({ id: 't', type: 'Cut', severity: 'moderate', status: 'treated' })]);
    assert.equal(plan(t, 3, 'simulation')[0].op.changes.status, 'healing');
});

test('states and moods fade; missing parts and lasting conditions stay', () => {
    const b = replay([
        add({ id: 's1', kind: 'state', part: '_body', type: 'Wet' }),
        add({ id: 's2', kind: 'state', part: '_body', type: 'Exhausted' }),
        add({ id: 's3', kind: 'state', part: '_body', type: 'Cursed glow' }),
        add({ id: 'm1', kind: 'mind_current', part: 'brain', type: 'Panicked' }),
        add({ id: 'm2', kind: 'mind_lasting', part: 'brain', type: 'Fear of fire' }),
        add({ id: 'x', kind: 'missing', part: 'left_hand', type: 'Missing' }),
        { index: 2, ops: [{ t: 'temp', who: 'm', value: 35.1 }] },
    ]);
    const six = plan(b, 0.25);
    assert.deepEqual(six.filter(x => x.op.t === 'remove').map(x => x.op.id), ['s1']);
    assert.ok(six.some(x => x.op.t === 'temp' && x.op.value === null));
    const day = plan(b, 1).filter(x => x.op.t === 'remove').map(x => x.op.id).sort();
    assert.deepEqual(day, ['m1', 's1', 's2']);
});

test('manual status change resets progress', () => {
    const b = replay([add({ id: 'w', type: 'Cut', severity: 'moderate', status: 'fresh', progress: 5 })]);
    applyOp(b, { t: 'edit', who: 'm', id: 'w', changes: { status: 'treated' } }, 3);
    assert.equal(b.get('m').conditions.get('w').progress, 0);
});
