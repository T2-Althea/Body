// Automatic detection: builds the request for a small model that reads one new
// message and proposes body changes, and turns its JSON reply into ops.
// Pure: no SillyTavern access, so prompt building and parsing are unit-tested.

import { BLEEDING, BODY_PART, BODY_STATES, INTENSITY_LABELS, KINDS, MIND_PART, PAIN_LEVELS, SEVERITIES, STATUSES, newId, npcKey } from './model.js';
import { formatDuration } from './timeskip.js';
import { meterStateText, resolveLevel } from './meters.js';

export const DETECT_TAG = '[BODY_HUD_TASK:detect]';
export const FILL_TAG = '[BODY_HUD_TASK:fill]';

// Cheap first pass: messages without any of these words are never sent to the model.
// Word starts, with lookaheads where a prefix would catch everyday words
// ("numb" in number, "sever" in several, "pain" in paint, "cut" in cute).
const TRIGGER = new RegExp([
    'wound', 'blood', 'bleed', 'cut(?!e)', 'stab', 'slash', 'arrow', 'bolt', 'bullet', 'shot', 'shoot',
    'hit', 'punch', 'kick', 'struck', 'strike', 'slam', 'bruis', 'break', 'broke', 'fractur', 'crack(?!er)',
    'sprain', 'twist', 'dislocat', 'burn', 'scald', 'frost', 'freez', 'cold', 'shiver', 'wet', 'soak',
    'drench', 'rain(?!bow)', 'mud', 'fall', 'fell', 'trip', 'bite', 'bitten', 'claw', 'scratch', 'pain(?!t)', 'hurt',
    'injur', 'limp', 'wince', 'ache', 'sore', 'numb(?!er)', 'swell', 'swoll', 'faint', 'dizz', 'nause', 'vomit',
    'drunk', 'poison', 'drug', 'fever', 'sweat(?!er)', 'exhaust', 'tired', 'weak', 'heal', 'bandag', 'stitch',
    'splint', 'treat', 'medic', 'potion', 'recover', 'scar(?!f|ce|ci)', 'sever(?!al)', 'amputat', 'missing', 'panic',
    'terrif', 'griev', 'sob(?!er)', 'trembl', 'shak', 'hungry', 'thirst', 'starv', 'overheat', 'heatstroke',
    'sunburn', 'concuss', 'unconscious', 'gash', 'graze', 'pierc', 'impal', 'choke', 'strangl', 'drown',
    // Meters: eating, drinking, sleeping, exertion, magic.
    'eat', 'ate\\b', 'meal', 'food', 'drink', 'drank', 'sip', 'sleep', 'slept', 'asleep', 'nap\\b', 'rested', 'resting',
    'ran\\b', 'running', 'sprint', 'fight', 'fought', 'spell', 'cast(?!le)', 'mana\\b', 'yawn',
    // Time skips.
    '(hours|days|weeks|months|years|a day|a week|a month|a year) (later|passed|pass|went by|go by)',
    'the next (morning|day|evening|week)', 'time passe', 'after (a|an|two|three|several|many|a few) (hours|days|weeks|months)',
].map(w => `\\b${w}`).join('|'), 'i');

export function mightMatter(text) {
    return TRIGGER.test(String(text ?? ''));
}

/**
 * Compact part guide, one line per region: "Left/right leg*: thigh, knee, ..."
 * A "*" marks parts that need a left_ or right_ prefix.
 */
export function partGuide(index) {
    const lines = [];
    const seen = new Set();
    for (const id of index.order) {
        const p = index.parts.get(id);
        if (!p.region) continue;
        const sided = id.startsWith('left_') || id.startsWith('right_');
        const base = sided ? id.replace(/^(left|right)_/, '') : id;
        if (seen.has(base)) continue;
        seen.add(base);
        const kids = p.children
            .filter(k => !index.parts.get(k).region)
            .map(k => k.replace(/^(left|right)_/, '') + (!sided && /^(left|right)_/.test(k) ? '*' : ''));
        const subregions = p.children.filter(k => index.parts.get(k).region).map(k => k.replace(/^(left|right)_/, ''));
        const uniq = [...new Set(kids)];
        lines.push(`${base}${sided ? '*' : ''}: ${uniq.join(', ')}${subregions.length ? ` (also: ${subregions.join(', ')})` : ''}`);
    }
    return lines.join('\n');
}

/** Short ids (c1, c2…) for existing conditions, so the model can refer to them cheaply. */
export function shortIds(members, bodies) {
    const toShort = new Map();
    const toReal = new Map();
    let n = 0;
    for (const m of members) {
        for (const c of bodies.get(m.key)?.conditions.values() || []) {
            const s = `c${++n}`;
            toShort.set(`${m.key}|${c.id}`, s);
            toReal.set(s, { who: m.key, id: c.id });
        }
    }
    return { toShort, toReal };
}

function describeCondition(c, partName) {
    const where = c.part && c.part !== BODY_PART ? partName(c.part) + ': ' : '';
    const bits = [c.kind, c.severity, c.stage, c.status, c.bleeding && c.bleeding !== 'none' ? `bleeding ${c.bleeding}` : null, c.pain && c.pain !== 'none' ? `pain ${c.pain}` : null].filter(Boolean);
    return `${where}${c.type || 'missing'} (${bits.join(', ')})`;
}

/**
 * @param {{ members, bodies, index, message: { name, text }, previous?: { name, text }, meters?: { defs, enabled: (key) => string[] } }} input
 * @returns {{ system: string, user: string, ids: ReturnType<typeof shortIds> }}
 */
export function buildDetectPrompt({ members, bodies, index, message, previous, meters = null }) {
    const partName = id => index.parts.get(id)?.name || id;
    const ids = shortIds(members, bodies);
    const state = members.map(m => {
        const body = bodies.get(m.key);
        const conds = [...(body?.conditions.values() || [])].map(c => `  [${ids.toShort.get(`${m.key}|${c.id}`)}] ${describeCondition(c, partName)}`);
        if (body?.temp != null) conds.push(`  temperature ${body.temp} °C`);
        const meterText = meters ? meterStateText(meters.defs, meters.enabled(m.key), body) : '';
        if (meterText) conds.push(`  meters: ${meterText}`);
        return `${m.name}${m.isUser ? ' (the user)' : ''}:\n${conds.length ? conds.join('\n') : '  (nothing)'}`;
    }).join('\n');

    const system = `${DETECT_TAG}
You track physical state in a roleplay. Read the NEW MESSAGE and report only changes to characters' bodies that it actually describes as happening.

Rules:
- Ignore figurative language ("my heart broke", "dead tired", "that killed me"), threats, plans, hypotheticals, dreams and flashbacks.
- Don't repeat conditions already listed under CURRENT STATE; use "update" to change them (e.g. bandaged → status treated, bleeding none) or "remove" when fully gone.
- Make sure who got hurt is right. Use the names listed; for anyone else (a guard, a wolf, a named stranger) use the name or description the story uses, consistently.
- Only report other people when something physical happens to them.
- If the text doesn't say left or right, give the part WITHOUT the left_/right_ prefix; never guess a side.
- Effects are short capability limits ("can't run; limps"), not descriptions.
- If the message explicitly skips time ("three days later", "after a week of rest"), add one {"action": "time_passes", "days": <number>}; hours are fractions of a day. Don't report healing yourself for a time skip.
- Forcing a physical feat past one's limits costs an injury (torn muscle, cracked bone…): add it.
${meters?.defs.length ? `- Meters (listed per character) change only when the message shows it: eating or drinking, sleeping or resting, running or fighting (stamina), casting (mana). Use the level names given below; move one or two levels at a time unless the text says more.
` : ''}- Most messages change nothing. Then return {"changes": []}.

Reply with JSON only:
{"changes": [
 {"action": "add", "character": "<name>", "kind": "injury|missing|state|effect|natural|mind_lasting|mind_current|mark", "part": "<part id>", "type": "<what, e.g. Arrow wound>", "severity": "minor|moderate|severe|critical", "bleeding": "none|light|moderate|heavy", "status": "fresh|treated|healing|scarred|permanent", "pain": "none|mild|moderate|severe|agonizing", "details": "", "effect": "", "cause": "", "hidden": false},
 {"action": "update", "character": "<name>", "id": "<c1…>", "changes": {"status": "treated", "bleeding": "none"}},
 {"action": "remove", "character": "<name>", "id": "<c1…>"},
 {"action": "temperature", "character": "<name>", "celsius": 38.5},${meters?.defs.length ? '\n {"action": "meter", "character": "<name>", "meter": "<meter id>", "level": "<level name>"},' : ''}
 {"action": "time_passes", "days": 3}
]}
kind "mark" = tattoos, body paint, brands (status "permanent" or "temporary"); kind "injury" = anything else on a body part; "state" = whole-body states (${BODY_STATES.join(', ').toLowerCase()}…), part optional; "effect" = poison, drugs, medicine and its side effects, magic enhancements or curses (severity = intensity), no part; "natural" = period, pregnancy, heat and similar natural body states, no part; mind kinds need no part. "pain" is optional.

${meters?.defs.length ? `Meter levels, comfortable first:\n${meters.defs.map(d => `${d.id}: ${d.levels.map(l => l.name.toLowerCase()).join(' → ')}`).join('\n')}\n\n` : ''}Part ids. * = needs a left_ or right_ prefix; a * on a region (before the colon) applies to every part on that line, e.g. leg* → left_thigh, right_knee:
${partGuide(index)}`;

    const user = `CHARACTERS AND CURRENT STATE:
${state}
${previous ? `\nPREVIOUS MESSAGE (context only) — ${previous.name}:\n${previous.text}\n` : ''}
NEW MESSAGE — ${message.name}:
${message.text}`;
    return { system, user, ids };
}

const pick = (v, allowed, fallback) => (allowed.includes(String(v ?? '').toLowerCase()) ? String(v).toLowerCase() : fallback);
const str = v => (v == null ? '' : String(v).trim());

/** Resolves a part name from the model: exact id, side-less base, or a part name. */
export function resolvePart(raw, index) {
    const s = str(raw).toLowerCase().replace(/\s+/g, '_');
    if (!s) return { id: null };
    if (index.parts.has(s)) return { id: s };
    if (index.parts.has('left_' + s) && index.parts.has('right_' + s)) return { id: null, base: s };
    for (const [id, p] of index.parts) {
        if (p.name.toLowerCase().replace(/\s+/g, '_') === s) return { id };
    }
    return { id: null };
}

/**
 * Turns the model's reply into proposals. Each proposal is { pid, who, op, summary }
 * plus `needsSide: base` when the side must be chosen before it can be applied.
 */
export function parseDetection(json, { members, index, ids, allowNpcs = true, meters = null }) {
    const out = [];
    const skipped = [];
    const byName = name => members.find(m => m.name.toLowerCase() === str(name).toLowerCase());
    const partName = id => index.parts.get(id)?.name || id;
    for (const ch of Array.isArray(json?.changes) ? json.changes : []) {
        if (str(ch.action).toLowerCase() === 'time_passes') {
            const days = Number(ch.days);
            if (!isFinite(days) || days <= 0 || days > 3650) { skipped.push('implausible time skip'); continue; }
            out.push({ pid: newId(), who: null, op: { t: 'timeskip', days }, summary: `Time passes: ${formatDuration(days)}` });
            continue;
        }
        let m = byName(ch.character);
        let npc = null;
        if (!m) {
            // Someone not in the scene yet: offer them as a new NPC (for additions only).
            const name = str(ch.character);
            const key = npcKey(name);
            if (!allowNpcs || str(ch.action).toLowerCase() !== 'add' || !name || key === 'n:' || /^(the )?user$|^you$/i.test(name)) {
                skipped.push(`unknown character "${name}"`);
                continue;
            }
            const display = name.charAt(0).toUpperCase() + name.slice(1);
            npc = { who: key, name: display };
            m = { key, name: display, isUser: false, npc: true };
        }
        const action = str(ch.action).toLowerCase();
        if (action === 'add') {
            const kind = pick(ch.kind, Object.keys(KINDS), 'injury');
            let part = null;
            let needsSide = null;
            if (kind === 'injury' || kind === 'missing' || kind === 'mark') {
                const r = resolvePart(ch.part, index);
                if (!r.id && !r.base) { skipped.push(`unknown part "${str(ch.part)}"`); continue; }
                part = r.id;
                needsSide = r.base || null;
            } else if (kind === 'state') {
                part = resolvePart(ch.part, index).id || BODY_PART;
            } else if (kind === 'effect' || kind === 'natural') {
                part = BODY_PART;
            } else {
                part = MIND_PART;
            }
            const type = kind === 'missing' ? 'Missing' : str(ch.type);
            if (!type) { skipped.push('add without a type'); continue; }
            const cond = {
                id: newId(),
                kind,
                part,
                type,
                severity: kind === 'missing' || kind === 'mark' || kind === 'natural' ? null : pick(ch.severity, SEVERITIES, 'moderate'),
                bleeding: kind === 'injury' ? pick(ch.bleeding, BLEEDING, 'none') : null,
                status: kind === 'injury' || kind === 'missing' ? pick(ch.status, STATUSES, kind === 'missing' ? 'permanent' : 'fresh')
                    : kind === 'mark' ? pick(ch.status, ['permanent', 'temporary'], 'permanent') : null,
                details: str(ch.details),
                effect: str(ch.effect),
                cause: str(ch.cause),
                hidden: ch.hidden === true,
            };
            const pain = pick(ch.pain, PAIN_LEVELS, null);
            if (pain && kind !== 'mark') cond.pain = pain;
            const where = needsSide ? `${needsSide.replace(/_/g, ' ')} (side?)` : part === BODY_PART ? 'whole body' : partName(part);
            out.push({
                pid: newId(), who: m.key, needsSide, ...(npc ? { npc } : {}),
                op: { t: 'add', who: m.key, cond },
                summary: `${npc ? 'New NPC ' : ''}${m.name}: ${kind === 'missing' ? `${where} missing` : `${type} — ${where}`}${cond.severity ? ` (${cond.severity})` : ''}`,
            });
        } else if (action === 'update' || action === 'remove') {
            const ref = ids.toReal.get(str(ch.id));
            if (!ref || ref.who !== m.key) { skipped.push(`unknown condition id "${str(ch.id)}"`); continue; }
            if (action === 'remove') {
                out.push({ pid: newId(), who: m.key, op: { t: 'remove', who: m.key, id: ref.id }, summary: `${m.name}: remove ${str(ch.id)}` });
                continue;
            }
            const changes = {};
            const c = ch.changes || {};
            if (c.severity) changes.severity = pick(c.severity, SEVERITIES, undefined);
            if (c.bleeding) changes.bleeding = pick(c.bleeding, BLEEDING, undefined);
            if (c.status) changes.status = pick(c.status, STATUSES, undefined);
            if (c.pain) changes.pain = pick(c.pain, PAIN_LEVELS, undefined);
            for (const k of ['details', 'effect', 'cause', 'type']) if (c[k] != null) changes[k] = str(c[k]);
            if (typeof c.hidden === 'boolean') changes.hidden = c.hidden;
            Object.keys(changes).forEach(k => changes[k] === undefined && delete changes[k]);
            if (!Object.keys(changes).length) { skipped.push('update without changes'); continue; }
            const what = Object.entries(changes).map(([k, v]) => `${k} → ${v}`).join(', ');
            out.push({ pid: newId(), who: m.key, op: { t: 'edit', who: m.key, id: ref.id, changes }, summary: `${m.name}: ${what}` });
        } else if (action === 'meter') {
            const def = meters?.defs.find(d => d.id === str(ch.meter).toLowerCase() || d.name.toLowerCase() === str(ch.meter).toLowerCase());
            if (!def || !meters.enabled(m.key).includes(def.id)) { skipped.push(`meter "${str(ch.meter)}" not used by ${m.name}`); continue; }
            const level = resolveLevel(def, ch.level);
            if (level === null) { skipped.push(`unknown level "${str(ch.level)}" for ${def.id}`); continue; }
            out.push({ pid: newId(), who: m.key, op: { t: 'meter', who: m.key, id: def.id, level }, summary: `${m.name}: ${def.name.toLowerCase()} → ${def.levels[level].name.toLowerCase()}` });
        } else if (action === 'temperature') {
            const v = Number(ch.celsius);
            if (!isFinite(v) || v < 20 || v > 45) { skipped.push('implausible temperature'); continue; }
            out.push({ pid: newId(), who: m.key, op: { t: 'temp', who: m.key, value: Math.round(v * 10) / 10 }, summary: `${m.name}: temperature ${v} °C` });
        } else {
            skipped.push(`unknown action "${action}"`);
        }
    }
    return { proposals: out, skipped };
}

/** Fills in a side for a proposal that needed one. */
export function withSide(proposal, side) {
    const p = structuredClone(proposal);
    p.op.cond.part = `${side}_${p.needsSide}`;
    p.needsSide = null;
    return p;
}

const FILL_HELP = {
    type: 'type: what the condition is, a short name (e.g. "Arrow wound", "Poisoned", "Panicked"). Invent one that fits the category, the place on the body and the recent story; prefer something the story suggests, otherwise pick a plausible one at random.',
    effect: 'effect: what the character can\'t do or does differently, as short capability limits (e.g. "Can\'t run; limps"). Max ~12 words.',
    details: 'details: one concrete physical detail (e.g. "Arrowhead still lodged"). Max ~10 words.',
    cause: 'cause: what caused it, from the story if known (e.g. "Bandit\'s arrow during the ambush"). Max ~10 words.',
    pain: `pain: how much it hurts right now, the logical level for this condition: one of ${PAIN_LEVELS.join(', ')}.`,
};
const CATEGORY_HELP = {
    body: 'something physical on the body (a wound, a whole-body state like wet or exhausted)',
    missing: 'a missing body part',
    natural: 'a natural body state (period, pregnancy, heat…)',
    mind: 'a mental condition',
    effect: 'a status effect (poison, drugs or medicine and their side effects, a magic enhancement or curse)',
    mark: 'a mark on the skin (tattoo, body paint, brand…)',
};

/**
 * Prompt for the ✨ buttons: suggest some fields of one condition.
 * @param {{ characterName, cond, partLabel, recentChat, fields?: string[], category?: string }} input
 */
export function buildFillPrompt({ characterName, cond, partLabel, recentChat, fields = ['effect', 'details', 'cause'], category = '' }) {
    const asked = fields.filter(f => FILL_HELP[f]);
    const system = `${FILL_TAG}
You help fill in a body-condition record for a roleplay. Using the condition and the recent story, suggest short values.
${asked.map(f => `- ${FILL_HELP[f]}`).join('\n')}
Reply with JSON only: {${asked.map(f => `"${f}": ""`).join(', ')}}`;
    const known = Object.entries({
        category: CATEGORY_HELP[category] || '', kind: category ? '' : (KINDS[cond.kind] || cond.kind), part: partLabel, what: cond.type,
        stage: cond.stage, [cond.kind === 'effect' ? 'intensity' : 'severity']: cond.kind === 'effect' ? INTENSITY_LABELS[cond.severity] : cond.severity,
        bleeding: cond.bleeding !== 'none' ? cond.bleeding : '', status: cond.status, pain: cond.pain, details: cond.details, effect: cond.effect, cause: cond.cause,
    }).filter(([k, v]) => v && !asked.includes(k === 'what' ? 'type' : k)).map(([k, v]) => `${k}: ${v}`).join('\n');
    const user = `CHARACTER: ${characterName}
CONDITION:
${known}

RECENT STORY:
${recentChat || '(none)'}`;
    return { system, user };
}
