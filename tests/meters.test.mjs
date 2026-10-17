// Run: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { expandTemplate, isAffected, replay } from '../src/model.js';
import { meterLevel, meterNoteLines, normalizeMeters, planMeterRecovery, resolveLevel } from '../src/meters.js';
import { buildNote, estimateTokens } from '../src/note.js';
import { planTimeSkip } from '../src/timeskip.js';
import { buildDetectPrompt, parseDetection } from '../src/detect.js';

const index = expandTemplate(JSON.parse(readFileSync(new URL('../templates/human.json', import.meta.url))));
const { meters: defs } = normalizeMeters(JSON.parse(readFileSync(new URL('../templates/meters.json', import.meta.url))));
const MIRA = 'c:mira.png';
const set = (who, id, level, at = 1) => ({ index: at, ops: [{ t: 'meter', who, id, level }] });
const ctx = enabled => ({ defs, enabled: () => enabled });

test('built-in meters load; mana is off by default', () => {
    assert.deepEqual(defs.map(d => d.id), ['hunger', 'thirst', 'sleep', 'stamina', 'mana', 'mana_saturation']);
    assert.equal(defs.find(d => d.id === 'mana').default, false);
    assert.equal(defs.find(d => d.id === 'stamina').levels.length, 5);
});

test('meter file validation', () => {
    assert.throws(() => normalizeMeters({}), /meters/);
    assert.throws(() => normalizeMeters({ meters: [{ name: 'Rage', levels: ['Calm'] }] }), /two levels/);
    assert.throws(() => normalizeMeters({ meters: [{ name: 'A', levels: ['x', 'y'] }, { id: 'a', levels: ['x', 'y'] }] }), /Two meters/);
    const { meters } = normalizeMeters({ meters: [{ name: 'Blood thirst', levels: ['Sated', { name: 'Craving', effect: 'Stares at necks' }] }] });
    assert.equal(meters[0].id, 'blood_thirst');
    assert.equal(meters[0].levels[1].effect, 'Stares at necks');
    assert.equal(meters[0].default, true);
});

test('meter levels replay from the chat', () => {
    const bodies = replay([set(MIRA, 'hunger', 2), set(MIRA, 'hunger', 1, 3), set(MIRA, 'mana', 3, 3)]);
    const mira = bodies.get(MIRA);
    assert.equal(meterLevel(mira, 'hunger'), 1);
    assert.equal(meterLevel(mira, 'thirst'), 0);
    assert.ok(isAffected(mira));
    assert.ok(!isAffected(replay([set(MIRA, 'hunger', 0)]).get(MIRA)), 'comfortable meters alone don\'t count');
});

test('note: words only, only off the comfortable level, only enabled meters', () => {
    const body = replay([set(MIRA, 'hunger', 2), set(MIRA, 'mana', 3), set(MIRA, 'thirst', 0)]).get(MIRA);
    const lines = meterNoteLines(defs, ['hunger', 'thirst', 'mana'], body).map(l => l.text);
    assert.deepEqual(lines, [
        'Hunger: hungry. Stomach growls; harder to focus.',
        'Mana: the ring. Muffled hearing, tunnel vision and a ringing in the ears: the body\'s warning that the mana is nearly gone.',
    ]);
    assert.equal(meterNoteLines(defs, ['thirst'], body).length, 0, 'disabled meters stay out');
    assert.ok(!lines.join(' ').match(/\d/), 'no figures');
    const note = buildNote([{ key: MIRA, name: 'Mira' }], replay([set(MIRA, 'mana', 4)]), index,
        { budget: 300, tempUnit: 'C', tempInNote: 'abnormal', meters: ctx(['mana']) }, estimateTokens);
    assert.match(note.text, /- Mana: depleted\. Mana sickness/);
});

test('time skips let meters recover by realism', () => {
    const body = replay([set('m', 'sleep', 3), set('m', 'stamina', 4), set('m', 'hunger', 1)]).get('m');
    const grounded = planMeterRecovery(defs, ['sleep', 'stamina', 'hunger'], body, 'm', 6 / 24, 'grounded');
    const byId = Object.fromEntries(grounded.map(r => [r.op.id, r.op.level]));
    assert.equal(byId.sleep, 1, '6 h: two levels of sleep (3 h each)');
    assert.equal(byId.stamina, 0, 'stamina recovers fully');
    assert.equal(byId.hunger, 0);
    assert.equal(planMeterRecovery(defs, ['sleep'], body, 'm', 1 / 24, 'grounded').length, 0, 'an hour isn\'t enough sleep');
    assert.equal(planMeterRecovery(defs, ['sleep'], body, 'm', 1 / 24, 'cinematic')[0].op.level, 0);
    const plan = planTimeSkip(new Map([['m', body]]), ['m'], 1, 'grounded', () => 'Mira', id => id, { meters: ctx(['sleep']) });
    assert.ok(plan.some(x => x.op.t === 'meter' && x.summary === 'Mira: sleep barely functioning → rested' && x.group === 'clear'));
});

test('detection sees meters and proposes level changes', () => {
    const members = [{ key: MIRA, name: 'Mira', isUser: false }];
    const bodies = replay([set(MIRA, 'hunger', 2)]);
    const meters = ctx(['hunger', 'mana']);
    const { system, user, ids } = buildDetectPrompt({ members, bodies, index, message: { name: 'Mira', text: 'She eats.' }, meters });
    assert.match(user, /meters: hunger hungry, mana full/);
    assert.match(system, /"action": "meter"/);
    assert.match(system, /mana: full → drawn on → low → the ring → depleted/);
    const { proposals, skipped } = parseDetection({ changes: [
        { action: 'meter', character: 'Mira', meter: 'hunger', level: 'Fed' },
        { action: 'meter', character: 'Mira', meter: 'mana', level: 'low' },
        { action: 'meter', character: 'Mira', meter: 'sleep', level: 'tired' },
        { action: 'meter', character: 'Mira', meter: 'mana', level: 'empty-ish' },
    ] }, { members, index, ids, meters });
    assert.deepEqual(proposals.map(p => [p.op.id, p.op.level]), [['hunger', 0], ['mana', 2]]);
    assert.equal(proposals[0].summary, 'Mira: hunger → fed');
    assert.equal(skipped.length, 2, 'a meter she doesn\'t use and an unknown level are skipped');
    assert.equal(resolveLevel(defs[0], '3'), 3);
});
