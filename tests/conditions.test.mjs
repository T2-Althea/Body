// Run: node --test tests/*.test.mjs
// Condition form redesign: categories, natural states, pain, status effects, durations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    DEFAULT_NATURAL_STATES, bodySubOf, categoryOf, expandTemplate, nextStage, parseNaturalStates, repliesLeft, replay,
} from '../src/model.js';
import { buildNote, estimateTokens } from '../src/note.js';
import { daysLeft, planTimeSkip } from '../src/timeskip.js';
import { buildFillPrompt, parseDetection, shortIds } from '../src/detect.js';

const index = expandTemplate(JSON.parse(readFileSync(new URL('../templates/human.json', import.meta.url))));
const MIRA = 'c:mira.png';
const add = (who, cond, at = 1) => ({ index: at, ops: [{ t: 'add', who, cond: { part: '_body', ...cond } }] });
// Messages alternate user / Mira from index 0.
const talk = n => Array.from({ length: n }, (_, i) => ({ index: i, who: i % 2 ? MIRA : 'user' }));

test('old kinds map onto the four categories', () => {
    assert.equal(categoryOf({ kind: 'injury' }), 'body');
    assert.equal(categoryOf({}), 'body');
    assert.equal(categoryOf({ kind: 'state' }), 'body');
    assert.equal(categoryOf({ kind: 'missing' }), 'body');
    assert.equal(categoryOf({ kind: 'natural' }), 'body');
    assert.equal(categoryOf({ kind: 'mind_lasting' }), 'mind');
    assert.equal(categoryOf({ kind: 'mind_current' }), 'mind');
    assert.equal(categoryOf({ kind: 'effect' }), 'effect');
    assert.equal(categoryOf({ kind: 'mark' }), 'mark');
    assert.equal(bodySubOf({ kind: 'missing' }), 'missing');
    assert.equal(bodySubOf({ kind: 'natural' }), 'natural');
    assert.equal(bodySubOf({ kind: 'state' }), 'part');
});

test('natural states list parses names, sex and stages', () => {
    const list = parseNaturalStates(DEFAULT_NATURAL_STATES);
    const preg = list.find(n => n.name === 'Pregnancy');
    assert.equal(preg.sex, 'female');
    assert.deepEqual(preg.stages.slice(0, 2), ['First trimester', 'Second trimester']);
    assert.equal(list.find(n => n.name === 'Andropause').sex, 'male');
    assert.equal(list.find(n => n.name === 'Heat').sex, null);
    assert.deepEqual(parseNaturalStates('Moulting\n\n  Egg laying (Female): Early, Late  '), [
        { name: 'Moulting', sex: null, stages: [] },
        { name: 'Egg laying', sex: 'female', stages: ['Early', 'Late'] },
    ]);
});

test('ends after N replies from the affected character', () => {
    const records = [add(MIRA, { id: 'p', kind: 'effect', type: 'Poisoned', severity: 'moderate', endReplies: 2 }, 1)];
    // Message 1 is where it was added; Mira speaks at 3 and 5.
    let mira = replay(records, talk(5)).get(MIRA);
    assert.equal(repliesLeft(mira.conditions.get('p')), 1, 'one of Mira\'s replies (3) counted; user messages don\'t');
    mira = replay(records, talk(6)).get(MIRA);
    assert.ok(!mira.conditions.has('p'), 'gone after her second reply');
    // Deleting the last messages brings it back: it's derived from the chat.
    assert.ok(replay(records, talk(4)).get(MIRA).conditions.has('p'));
});

test('a reply duration can heal one stage instead', () => {
    const records = [add(MIRA, { id: 'w', kind: 'injury', part: 'left_thigh', type: 'Cut', severity: 'moderate', status: 'fresh', bleeding: 'light', endReplies: 1, endThen: 'heal' }, 1)];
    const w = replay(records, talk(4)).get(MIRA).conditions.get('w');
    assert.equal(w.status, 'healing');
    assert.equal(w.bleeding, 'none');
    assert.equal(repliesLeft(w), null, 'the duration is used up');
    assert.equal(nextStage({ status: 'healing', severity: 'minor' }), null);
    assert.equal(nextStage({ status: 'healing', severity: 'severe' }).status, 'scarred');
});

test('changing the reply count restarts it; other edits don\'t', () => {
    const base = add(MIRA, { id: 'p', kind: 'effect', type: 'Drugged', severity: 'minor', endReplies: 3 }, 1);
    const editOther = { index: 4, ops: [{ t: 'edit', who: MIRA, id: 'p', changes: { severity: 'severe', endReplies: 3 } }] };
    assert.equal(repliesLeft(replay([base, editOther], talk(6)).get(MIRA).conditions.get('p')), 1);
    const editCount = { index: 4, ops: [{ t: 'edit', who: MIRA, id: 'p', changes: { endReplies: 2 } }] };
    assert.equal(repliesLeft(replay([base, editCount], talk(6)).get(MIRA).conditions.get('p')), 1, 'only reply 5 counts after the edit at 4');
});

test('NPCs count every AI reply; the user\'s own conditions count the user\'s messages', () => {
    const records = [
        add('n:guard', { id: 'g', kind: 'mind_current', part: 'brain', type: 'Dazed', endReplies: 2 }, 0),
        add('user', { id: 'u', kind: 'state', type: 'Wet', endReplies: 1 }, 0),
    ];
    const bodies = replay(records, talk(4));
    assert.ok(!bodies.get('n:guard').conditions.has('g'));
    assert.ok(!bodies.get('user').conditions.has('u'));
    assert.ok(replay(records, talk(2)).get('n:guard').conditions.has('g'));
});

test('time durations wear off on time skips, with leftover progress', () => {
    const bodies = replay([
        add('m', { id: 'e', kind: 'effect', type: 'Blessed', severity: 'moderate', endDays: 2 }),
        add('m', { id: 'n', kind: 'natural', type: 'Period', endDays: 5 }),
        add('m', { id: 'c', kind: 'effect', type: 'Cursed', severity: 'severe' }),
    ]);
    const p = planTimeSkip(bodies, ['m'], 3, 'grounded', () => 'Mira', id => id);
    assert.deepEqual(p.filter(x => x.op.t === 'remove').map(x => x.op.id), ['e']);
    const prog = p.find(x => x.op.id === 'n');
    assert.equal(prog.op.changes.progress, 3);
    assert.equal(prog.group, 'progress');
    assert.ok(!p.some(x => x.op.id === 'c'), 'no duration: a curse stays');
    assert.equal(daysLeft({ kind: 'natural', endDays: 5, progress: 3 }), 2);
});

test('the note has status effects, natural states and pain', () => {
    const members = [{ key: MIRA, name: 'Mira', isUser: false }];
    const bodies = replay([
        add(MIRA, { id: 'a', kind: 'effect', type: 'Poisoned', severity: 'severe', effect: 'Dizzy' }),
        add(MIRA, { id: 'b', kind: 'natural', type: 'Pregnancy', stage: 'Second trimester' }),
        add(MIRA, { id: 'c', kind: 'injury', part: 'left_thigh', type: 'Cut', severity: 'moderate', pain: 'severe' }),
        add(MIRA, { id: 'd', kind: 'natural', type: 'Period', pain: 'mild' }),
    ]);
    const { text } = buildNote(members, bodies, index, { budget: 300, tempUnit: 'C', tempInNote: 'abnormal' }, estimateTokens);
    assert.match(text, /- Effect: poisoned, strong\. Dizzy\./);
    assert.match(text, /- Natural: pregnancy, second trimester\./);
    assert.match(text, /- Natural: period, mild pain\./);
    assert.match(text, /- Left thigh: cut, moderate, severe pain\./);
});

test('detection accepts effects, natural states and pain', () => {
    const members = [{ key: MIRA, name: 'Mira', isUser: false }];
    const ids = shortIds(members, new Map());
    const { proposals } = parseDetection({ changes: [
        { action: 'add', character: 'Mira', kind: 'effect', type: 'Poisoned', severity: 'severe', pain: 'Moderate' },
        { action: 'add', character: 'Mira', kind: 'natural', type: 'Period', severity: 'severe' },
    ] }, { members, index, ids });
    assert.equal(proposals[0].op.cond.part, '_body');
    assert.equal(proposals[0].op.cond.pain, 'moderate');
    assert.equal(proposals[1].op.cond.kind, 'natural');
    assert.equal(proposals[1].op.cond.severity, null);
});

test('fill prompt asks only for the requested fields, What included', () => {
    const { system, user } = buildFillPrompt({
        characterName: 'Mira', cond: { kind: 'injury', type: '' }, partLabel: 'Left thigh', recentChat: 'x', fields: ['type', 'pain'], category: 'body',
    });
    assert.match(system, /"type": "", "pain": ""/);
    assert.doesNotMatch(system, /"effect"/);
    assert.match(user, /part: Left thigh/);
    assert.match(user, /category: something physical/);
});
