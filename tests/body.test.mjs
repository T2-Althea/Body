// Run: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { expandTemplate, guessSex, partShown, replay } from '../src/model.js';
import { viewShapes } from '../src/mannequin.js';
import { buildNote, estimateTokens } from '../src/note.js';
import { planTimeSkip } from '../src/timeskip.js';

const tpl = JSON.parse(readFileSync(new URL('../templates/human.json', import.meta.url)));
const index = expandTemplate(tpl);

test('nipples and sex-specific parts exist and inherit sensitivity', () => {
    assert.equal(index.parts.get('left_nipple').name, 'Left nipple');
    assert.equal(index.parts.get('left_nipple').parentId, 'left_breast');
    assert.equal(index.parts.get('vulva').sex, 'female');
    assert.equal(index.parts.get('right_testicle').sex, 'male');
    assert.equal(index.parts.get('vulva').sensitive, true, 'children of genitals are sensitive');
});

test('partShown filters by sex and sensitivity', () => {
    const vulva = index.parts.get('vulva');
    const penis = index.parts.get('penis');
    assert.equal(partShown(vulva, { sex: 'female' }), true);
    assert.equal(partShown(penis, { sex: 'female' }), false);
    assert.equal(partShown(penis, { sex: 'unspecified' }), true);
    assert.equal(partShown(vulva, { sex: 'female', hideSensitive: true }), false);
    assert.equal(partShown(index.parts.get('left_thigh'), { sex: 'male', hideSensitive: true }), true);
});

test('guessSex from pronouns', () => {
    assert.equal(guessSex('She is a healer. Her magic is gentle and she loves her forest.'), 'female');
    assert.equal(guessSex('He is a knight. His sword is old and he guards him.'), 'male');
    assert.equal(guessSex('A wandering spirit of the woods.'), 'unspecified');
    assert.equal(guessSex('She met him; he and she talked.'), 'unspecified');
});

test('feminine variant replaces its regions and keeps the rest', () => {
    const base = viewShapes(tpl.mannequin, 'front');
    const fem = viewShapes(tpl.mannequin, 'front', 'feminine');
    assert.equal(fem.length, base.length);
    const d = (list, r) => list.find(s => s.region === r).d;
    assert.notEqual(d(fem, 'chest'), d(base, 'chest'));
    assert.notEqual(d(fem, 'left_arm'), d(base, 'left_arm'));
    assert.equal(d(fem, 'head'), d(base, 'head'));
    assert.ok(viewShapes(tpl.mannequin, 'back', 'feminine').some(s => s.region === 'upper_back'));
});

const marked = () => replay([{ index: 1, ops: [
    { t: 'add', who: 'u', cond: { id: 't', kind: 'mark', part: 'left_forearm', type: 'Dragon tattoo', status: 'permanent', details: 'Black ink' } },
    { t: 'add', who: 'u', cond: { id: 'p', kind: 'mark', part: 'face', type: 'War paint', status: 'temporary' } },
] }]);

test('marks: one low-priority line in the note, optional', () => {
    const members = [{ key: 'u', name: 'Aren', isUser: true }];
    const opts = { budget: 200, tempUnit: 'C', tempInNote: 'abnormal' };
    const text = buildNote(members, marked(), index, opts, estimateTokens).text;
    assert.match(text, /- Marks: dragon tattoo \(black ink\) on the left forearm; war paint on the face\./);
    assert.equal(buildNote(members, marked(), index, { ...opts, marksInNote: false }, estimateTokens).text, '');
});

test('marks: temporary ones fade with time, permanent ones stay', () => {
    const plan = planTimeSkip(marked(), ['u'], 3, 'grounded', () => 'Aren', id => index.parts.get(id).name);
    assert.deepEqual(plan.map(p => p.op.id), ['p']);
    assert.equal(planTimeSkip(marked(), ['u'], 1, 'grounded', () => 'Aren', id => id).length, 0);
});

test('features: merged into the template, shown only for bodies that have them', async () => {
    const { withFeatures } = await import('../src/model.js');
    const features = JSON.parse(readFileSync(new URL('../templates/addons.json', import.meta.url)));
    const full = expandTemplate(withFeatures(tpl, features));
    assert.equal(full.parts.get('left_horn').addon, 'horns');
    assert.equal(full.parts.get('tail_tip').addon, 'tail', 'children inherit the feature');
    assert.equal(full.parts.get('tail').parentId, 'pelvis');
    assert.equal(full.parts.get('right_wing').regionId, 'right_wing');
    assert.equal(partShown(full.parts.get('left_horn'), {}), false);
    assert.equal(partShown(full.parts.get('left_horn'), { features: ['horns'] }), true);
    assert.equal(partShown(full.parts.get('left_thigh'), {}), true);
    assert.ok(full.presets.some(p => p.id === 'draconic' && p.features.includes('wings')));

    const m = withFeatures(tpl, features).mannequin;
    const plain = viewShapes(m, 'back');
    const dragon = viewShapes(m, 'back', null, ['horns', 'tail', 'wings']);
    assert.equal(plain.some(s => /horn|tail|wing/.test(s.region)), false);
    assert.equal(dragon[0].region.endsWith('wing'), true, 'wings are drawn behind the body');
    assert.ok(dragon.some(s => s.region === 'tail') && dragon.some(s => s.region === 'left_horn'));
    const elf = viewShapes(m, 'front', null, ['pointed_ears']).filter(s => s.region === 'head');
    assert.equal(elf.length, 3, 'two ear shapes belong to the head itself');
});
