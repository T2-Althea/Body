// Run: node --test tests/*.test.mjs
// Mood and clothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { expandTemplate, replay } from '../src/model.js';
import { moodNoteLine, normalizeMood } from '../src/mood.js';
import { SLOTS, cleanItems, clothesNoteLine, describeClothes, slotWearable } from '../src/clothing.js';
import { buildNote, estimateTokens } from '../src/note.js';
import { buildDetectPrompt, mightMatter, parseDetection, shortIds } from '../src/detect.js';

const index = expandTemplate(JSON.parse(readFileSync(new URL('../templates/human.json', import.meta.url))));
const MIRA = 'c:mira.png';
const op = (o, at = 1) => ({ index: at, ops: [{ who: MIRA, ...o }] });
const members = [{ key: MIRA, name: 'Mira', isUser: false }];
const noteOf = (bodies, extra = {}) => buildNote(members, bodies, index, { budget: 300, tempUnit: 'C', tempInNote: 'abnormal', ...extra }, estimateTokens).text;

test('mood replays; neutral clears it', () => {
    assert.deepEqual(replay([op({ t: 'mood', label: 'fear', intensity: 'strong' })]).get(MIRA).mood, { label: 'fear', intensity: 'strong' });
    assert.equal(replay([op({ t: 'mood', label: 'fear' }), op({ t: 'mood', label: 'neutral' }, 2)]).get(MIRA).mood, null);
    assert.equal(normalizeMood('Anger'), 'anger');
    assert.equal(normalizeMood('afraid'), 'fear');
    assert.equal(normalizeMood('hangry'), null);
});

test('note: strong moods, and mild ones that change behaviour', () => {
    assert.equal(moodNoteLine({ label: 'joy', intensity: 'mild' }), null, 'mild joy stays out');
    assert.equal(moodNoteLine({ label: 'joy', intensity: 'strong' }).text, 'Mood: very happy.');
    assert.equal(moodNoteLine({ label: 'fear', intensity: 'mild' }).text, 'Mood: afraid.');
    assert.match(noteOf(replay([op({ t: 'mood', label: 'anger', intensity: 'strong' })])), /- Mood: very angry\./);
    assert.equal(noteOf(replay([op({ t: 'mood', label: 'anger', intensity: 'strong' })]), { moodInNote: false }), '');
});

test('clothing: wear, take off, outfits', () => {
    let b = replay([
        op({ t: 'wear', slot: 'top', item: 'White blouse', desc: 'Silk' }),
        op({ t: 'wear', slot: 'shoes', item: 'Boots' }, 2),
        op({ t: 'wear', slot: 'top', item: '' }, 3),
    ]).get(MIRA);
    assert.deepEqual(Object.keys(b.clothes), ['shoes']);
    assert.equal(b.clothesAt, 3);
    b = replay([op({ t: 'wear', slot: 'top', item: 'Shirt' }), op({ t: 'outfit', items: { outerwear: { item: 'Cloak', desc: '' } } }, 4)]).get(MIRA);
    assert.deepEqual(b.clothes, { outerwear: { item: 'Cloak', desc: '' } });
    assert.deepEqual(cleanItems({ top: { item: ' Tunic ' }, shoes: { item: '' }, wings: { item: 'Harness' } }), { top: { item: 'Tunic', desc: '' } });
});

test('Wearing line: recent or always; missing parts wear nothing', () => {
    const b = replay([op({ t: 'wear', slot: 'top', item: 'White blouse', desc: 'Silk' }, 2), op({ t: 'wear', slot: 'shoes', item: 'Boots' }, 2)]).get(MIRA);
    assert.equal(clothesNoteLine(b, { mode: 'recent', chatLength: 5 }).text, 'Wearing: white blouse (silk), boots.');
    assert.equal(clothesNoteLine(b, { mode: 'recent', chatLength: 40 }), null, 'long after the change');
    assert.ok(clothesNoteLine(b, { mode: 'always', chatLength: 40 }));
    assert.equal(clothesNoteLine(b, { mode: 'off', chatLength: 3 }), null);
    const shoes = SLOTS.find(s => s.id === 'shoes');
    assert.ok(slotWearable(shoes, new Set(['left_foot'])), 'one foot left');
    assert.ok(!slotWearable(shoes, new Set(['left_foot', 'right_foot'])));
    assert.equal(describeClothes(b.clothes, new Set(['left_foot', 'right_foot'])), 'white blouse (silk)');
    assert.match(noteOf(new Map([[MIRA, b]]), { clothesInNote: 'recent', chatLength: 3 }), /- Wearing: white blouse \(silk\), boots\./);
});

test('detection: clothing and mood', () => {
    const bodies = replay([op({ t: 'wear', slot: 'top', item: 'Shirt' })]);
    const { system, user, ids } = buildDetectPrompt({ members, bodies, index, message: { name: 'Mira', text: 'x' }, clothes: true, mood: true });
    assert.match(user, /wearing: top=Shirt/);
    assert.match(user, /mood: neutral/);
    assert.match(system, /"action": "wear"/);
    assert.match(system, /"action": "mood"/);
    const plain = buildDetectPrompt({ members, bodies, index, message: { name: 'Mira', text: 'x' } });
    assert.doesNotMatch(plain.system, /"action": "mood"|"action": "wear"/);
    const { proposals } = parseDetection({ changes: [
        { action: 'wear', character: 'Mira', slot: 'outerwear', item: 'Red cloak', description: 'Wool' },
        { action: 'wear', character: 'Mira', slot: 'top', item: '' },
        { action: 'wear', character: 'Mira', slot: 'tail', item: 'Bow' },
        { action: 'mood', character: 'Mira', mood: 'Fear', intensity: 'strong' },
    ] }, { members, index, ids: shortIds(members, bodies) });
    assert.deepEqual(proposals.map(p => p.summary), ['Mira: wears Red cloak (outerwear)', 'Mira: takes off (top)', 'Mira: mood → fear (strong)']);
    assert.ok(mightMatter('She pulls on her boots.'));
    assert.ok(!mightMatter('She smiles warmly.'));
    assert.ok(mightMatter('She smiles warmly.', { mood: true }));
});
