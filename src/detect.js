// Automatic detection: builds the request for a small model that reads one new
// message and proposes body changes, and turns its JSON reply into ops.
// Pure: no SillyTavern access, so prompt building and parsing are unit-tested.

import { BLEEDING, BODY_PART, BODY_STATES, KINDS, MIND_PART, SEVERITIES, STATUSES, newId } from './model.js';
import { formatDuration } from './timeskip.js';

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
    const bits = [c.kind, c.severity, c.status, c.bleeding && c.bleeding !== 'none' ? `bleeding ${c.bleeding}` : null].filter(Boolean);
    return `${where}${c.type || 'missing'} (${bits.join(', ')})`;
}

/**
 * @param {{ members, bodies, index, message: { name, text }, previous?: { name, text } }} input
 * @returns {{ system: string, user: string, ids: ReturnType<typeof shortIds> }}
 */
export function buildDetectPrompt({ members, bodies, index, message, previous }) {
    const partName = id => index.parts.get(id)?.name || id;
    const ids = shortIds(members, bodies);
    const state = members.map(m => {
        const body = bodies.get(m.key);
        const conds = [...(body?.conditions.values() || [])].map(c => `  [${ids.toShort.get(`${m.key}|${c.id}`)}] ${describeCondition(c, partName)}`);
        if (body?.temp != null) conds.push(`  temperature ${body.temp} °C`);
        return `${m.name}${m.isUser ? ' (the user)' : ''}:\n${conds.length ? conds.join('\n') : '  (nothing)'}`;
    }).join('\n');

    const system = `${DETECT_TAG}
You track physical state in a roleplay. Read the NEW MESSAGE and report only changes to characters' bodies that it actually describes as happening.

Rules:
- Ignore figurative language ("my heart broke", "dead tired", "that killed me"), threats, plans, hypotheticals, dreams and flashbacks.
- Don't repeat conditions already listed under CURRENT STATE; use "update" to change them (e.g. bandaged → status treated, bleeding none) or "remove" when fully gone.
- Only the characters listed. Make sure who got hurt is right.
- If the text doesn't say left or right, give the part WITHOUT the left_/right_ prefix; never guess a side.
- Effects are short capability limits ("can't run; limps"), not descriptions.
- If the message explicitly skips time ("three days later", "after a week of rest"), add one {"action": "time_passes", "days": <number>}; hours are fractions of a day. Don't report healing yourself for a time skip.
- Most messages change nothing. Then return {"changes": []}.

Reply with JSON only:
{"changes": [
 {"action": "add", "character": "<name>", "kind": "injury|missing|state|mind_lasting|mind_current", "part": "<part id>", "type": "<what, e.g. Arrow wound>", "severity": "minor|moderate|severe|critical", "bleeding": "none|light|moderate|heavy", "status": "fresh|treated|healing|scarred|permanent", "details": "", "effect": "", "cause": "", "hidden": false},
 {"action": "update", "character": "<name>", "id": "<c1…>", "changes": {"status": "treated", "bleeding": "none"}},
 {"action": "remove", "character": "<name>", "id": "<c1…>"},
 {"action": "temperature", "character": "<name>", "celsius": 38.5},
 {"action": "time_passes", "days": 3}
]}
kind "mark" = tattoos, body paint, brands (status "permanent" or "temporary"); kind "injury" = anything else on a body part; "state" = whole-body states (${BODY_STATES.join(', ').toLowerCase()}…), part optional; mind kinds need no part.

Part ids. * = needs a left_ or right_ prefix; a * on a region (before the colon) applies to every part on that line, e.g. leg* → left_thigh, right_knee:
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
export function parseDetection(json, { members, index, ids }) {
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
        const m = byName(ch.character);
        if (!m) { skipped.push(`unknown character "${str(ch.character)}"`); continue; }
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
                severity: kind === 'missing' || kind === 'mark' ? null : pick(ch.severity, SEVERITIES, 'moderate'),
                bleeding: kind === 'injury' ? pick(ch.bleeding, BLEEDING, 'none') : null,
                status: kind === 'injury' || kind === 'missing' ? pick(ch.status, STATUSES, kind === 'missing' ? 'permanent' : 'fresh')
                    : kind === 'mark' ? pick(ch.status, ['permanent', 'temporary'], 'permanent') : null,
                details: str(ch.details),
                effect: str(ch.effect),
                cause: str(ch.cause),
                hidden: ch.hidden === true,
            };
            const where = needsSide ? `${needsSide.replace(/_/g, ' ')} (side?)` : part === BODY_PART ? 'whole body' : partName(part);
            out.push({
                pid: newId(), who: m.key, needsSide,
                op: { t: 'add', who: m.key, cond },
                summary: `${m.name}: ${kind === 'missing' ? `${where} missing` : `${type} — ${where}`}${cond.severity ? ` (${cond.severity})` : ''}`,
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
            for (const k of ['details', 'effect', 'cause', 'type']) if (c[k] != null) changes[k] = str(c[k]);
            if (typeof c.hidden === 'boolean') changes.hidden = c.hidden;
            Object.keys(changes).forEach(k => changes[k] === undefined && delete changes[k]);
            if (!Object.keys(changes).length) { skipped.push('update without changes'); continue; }
            const what = Object.entries(changes).map(([k, v]) => `${k} → ${v}`).join(', ');
            out.push({ pid: newId(), who: m.key, op: { t: 'edit', who: m.key, id: ref.id, changes }, summary: `${m.name}: ${what}` });
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

/** Prompt for the ✨ buttons: suggest effect/details/cause for one condition. */
export function buildFillPrompt({ characterName, cond, partLabel, recentChat }) {
    const system = `${FILL_TAG}
You help fill in a body-condition record for a roleplay. Using the condition and the recent story, suggest short values.
- effect: what the character can't do or does differently, as short capability limits (e.g. "Can't run; limps"). Max ~12 words.
- details: one concrete physical detail (e.g. "Arrowhead still lodged"). Max ~10 words.
- cause: what caused it, from the story if known (e.g. "Bandit's arrow during the ambush"). Max ~10 words.
Reply with JSON only: {"effect": "", "details": "", "cause": ""}`;
    const known = Object.entries({
        kind: KINDS[cond.kind] || cond.kind, part: partLabel, what: cond.type, severity: cond.severity,
        bleeding: cond.bleeding, status: cond.status, details: cond.details, effect: cond.effect, cause: cond.cause,
    }).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n');
    const user = `CHARACTER: ${characterName}
CONDITION:
${known}

RECENT STORY:
${recentChat || '(none)'}`;
    return { system, user };
}
