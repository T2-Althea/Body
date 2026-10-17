// Pure data model: templates, conditions and replay. No SillyTavern access here,
// so this file can be tested in plain Node.

export const SEVERITIES = ['minor', 'moderate', 'severe', 'critical'];
export const BLEEDING = ['none', 'light', 'moderate', 'heavy'];
export const STATUSES = ['fresh', 'treated', 'healing', 'scarred', 'permanent'];

// Condition kinds. `part` is a template part id, or BODY_PART for whole-body states.
export const KINDS = {
    injury: 'On a body part',
    missing: 'Missing part',
    state: 'Whole-body state',
    mind_lasting: 'Mind: lasting condition',
    mind_current: 'Mind: current state',
    mark: 'Mark (tattoo, body paint, brand…)',
    natural: 'Natural body state',
    effect: 'Status effect',
};

// The condition form groups kinds into four categories. Old records keep their
// kind; categoryOf() maps them, so nothing needs migrating.
export const CATEGORIES = {
    body: 'Body',
    mind: 'Mind',
    effect: 'Status effect',
    mark: 'Mark',
};
export function categoryOf(c) {
    const kind = c?.kind;
    if (kind === 'mind_lasting' || kind === 'mind_current') return 'mind';
    if (kind === 'effect') return 'effect';
    if (kind === 'mark') return 'mark';
    return 'body';
}
/** Within Body: 'part' (on a part or whole body), 'missing' or 'natural'. */
export function bodySubOf(c) {
    return c?.kind === 'missing' ? 'missing' : c?.kind === 'natural' ? 'natural' : 'part';
}

export const PAIN_LEVELS = ['none', 'mild', 'moderate', 'severe', 'agonizing'];
// Status effects use the severity scale, under friendlier names.
export const INTENSITY_LABELS = { minor: 'Mild', moderate: 'Moderate', severe: 'Strong', critical: 'Overwhelming' };

// Natural / cyclical states offered in the form. Editable in the settings, one per line:
//   Name (female|male|any): stage, stage…
export const DEFAULT_NATURAL_STATES = [
    'Period (female): Light, Heavy',
    'Ovulation (female)',
    'Pregnancy (female): First trimester, Second trimester, Third trimester, In labor',
    'Lactation (female)',
    'Menopause (female)',
    'Andropause (male)',
    'Heat (any)',
    'Rut (any)',
].join('\n');

/** @returns {{ name: string, sex: 'female'|'male'|null, stages: string[] }[]} */
export function parseNaturalStates(text) {
    const out = [];
    for (const line of String(text ?? '').split('\n')) {
        const m = line.trim().match(/^([^(:]+?)\s*(?:\(\s*(female|male|any)\s*\))?\s*(?::\s*(.*))?$/i);
        if (!m || !m[1]) continue;
        const sex = (m[2] || 'any').toLowerCase();
        out.push({
            name: m[1].trim(),
            sex: sex === 'any' ? null : sex,
            stages: String(m[3] || '').split(',').map(x => x.trim()).filter(Boolean),
        });
    }
    return out;
}
// How long a mark lasts.
export const MARK_DURATIONS = { permanent: 'Permanent', temporary: 'Temporary (fades in a few days)' };
export const SEXES = { unspecified: 'Unspecified', female: 'Female', male: 'Male' };
export const BODY_PART = '_body';
export const MIND_PART = 'brain';

export const BODY_STATES = [
    'Wet', 'Cold', 'Overheated', 'Muddy', 'Bloody',
    'Exhausted', 'Hungry', 'Thirsty', 'Drunk', 'Drugged', 'Nauseous', 'In pain',
];

/**
 * Expands a template into a flat index. Sided parts become left_/right_ copies,
 * with every descendant prefixed the same way.
 * @returns {{ parts: Map<string, object>, order: string[], mannequin: object|null }}
 */
export function expandTemplate(template) {
    const parts = new Map();
    const order = [];

    function visit(node, parentId, prefix, depth, regionId, parentSensitive = false, parentAddon = null) {
        const sides = node.sided && !prefix ? ['left', 'right'] : [null];
        for (const side of sides) {
            const p = side ? `${side}_` : prefix;
            const id = p + node.id;
            const sideWord = p === 'left_' ? 'Left ' : p === 'right_' ? 'Right ' : '';
            const name = sideWord ? sideWord + node.name.charAt(0).toLowerCase() + node.name.slice(1) : node.name;
            const region = node.region ? id : regionId;
            parts.set(id, {
                id, name, parentId, depth,
                region: !!node.region,
                regionId: region,
                sensitive: !!node.sensitive || parentSensitive,
                sex: node.sex || null,
                addon: node.addon || parentAddon,
                children: [],
            });
            order.push(id);
            if (parentId && parts.has(parentId)) parts.get(parentId).children.push(id);
            for (const child of node.children || []) visit(child, id, p, depth + 1, region, !!node.sensitive || parentSensitive, node.addon || parentAddon);
        }
    }
    for (const root of template.parts || []) visit(root, null, '', 0, null);
    return { parts, order, mannequin: template.mannequin || null, features: template.features || [], presets: template.presets || [] };
}

export function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function emptyBody() {
    return { conditions: new Map(), temp: null };
}

/**
 * Applies one op to the bodies map. Ops:
 *   { t: 'add', who, cond }          cond.id required
 *   { t: 'edit', who, id, changes }
 *   { t: 'remove', who, id }
 *   { t: 'temp', who, value }        number in °C, or null to clear
 */
export function applyOp(bodies, op, messageIndex) {
    if (!op || !op.who) return;
    if (!bodies.has(op.who)) bodies.set(op.who, emptyBody());
    const body = bodies.get(op.who);
    switch (op.t) {
        case 'add':
            if (op.cond?.id) body.conditions.set(op.cond.id, { ...op.cond, since: messageIndex, endCount: 0 });
            break;
        case 'edit': {
            const c = body.conditions.get(op.id);
            if (!c) break;
            const next = { ...c, ...op.changes, id: c.id, since: c.since };
            // Healing progress counts days in the current stage; a new stage starts at zero.
            if (op.changes.status && op.changes.status !== c.status && !('progress' in op.changes)) next.progress = 0;
            // A new reply count starts over.
            if ('endReplies' in op.changes && (op.changes.endReplies ?? null) !== (c.endReplies ?? null)) next.endCount = 0;
            body.conditions.set(op.id, next);
            break;
        }
        case 'remove':
            body.conditions.delete(op.id);
            break;
        case 'temp':
            body.temp = typeof op.value === 'number' && isFinite(op.value) ? op.value : null;
            break;
        // Meters (hunger, mana…): a level index, 0 = comfortable.
        case 'meter':
            if (op.id && Number.isInteger(op.level) && op.level >= 0) body.meters = { ...(body.meters || {}), [op.id]: op.level };
            break;
        // NPCs: someone who isn't a SillyTavern character. They join and leave the
        // scene through ops too, so they follow swipes, deletions and branches.
        case 'npc_add':
            body.npc = { ...(body.npc || {}), name: op.name || body.npc?.name || 'Someone', present: true };
            if (op.sex) body.npc.sex = op.sex;
            if (op.features) body.npc.features = op.features;
            break;
        case 'npc_update':
            if (body.npc) body.npc = { ...body.npc, ...op.changes, present: body.npc.present };
            break;
        case 'npc_leave':
            if (body.npc) body.npc = { ...body.npc, present: false };
            break;
    }
}

/** The next healing stage, or null when the condition is gone. */
export function nextStage(c) {
    if (c.status === 'healing') return severityRank(c.severity) <= 0 ? null : { status: 'scarred', severity: 'minor', bleeding: 'none' };
    if (!c.status || c.status === 'fresh' || c.status === 'treated') return { status: 'healing', bleeding: 'none' };
    return null; // scarred, permanent
}

// Whether a message by `speaker` counts towards a body's reply durations. NPCs
// don't write messages, so every AI reply counts for them.
const countsFor = (bodyKey, speaker) => speaker === bodyKey || (bodyKey.startsWith('n:') && speaker !== 'user');

/** One message was written: advance "ends after N replies" counters. */
function tick(bodies, speaker) {
    for (const [key, body] of bodies) {
        if (!countsFor(key, speaker)) continue;
        for (const c of [...body.conditions.values()]) {
            if (!(c.endReplies > 0)) continue;
            c.endCount = (c.endCount || 0) + 1;
            if (c.endCount < c.endReplies) continue;
            const next = c.endThen === 'heal' ? nextStage(c) : null;
            if (next) body.conditions.set(c.id, { ...c, ...next, progress: 0, endReplies: null, endCount: 0, endThen: null });
            else body.conditions.delete(c.id);
        }
    }
}

/**
 * Rebuilds every body from scratch.
 * @param {{ index: number, ops: object[] }[]} records in chat order (index -1 = chat baseline)
 * @param {{ index: number, who: string }[]} [speakers] who wrote each message, in
 *   chat order; drives the "ends after N replies" durations
 */
export function replay(records, speakers = []) {
    const bodies = new Map();
    const opsAt = new Map();
    for (const r of records) opsAt.set(r.index, [...(opsAt.get(r.index) || []), ...(r.ops || [])]);
    const indexes = [...new Set([...records.map(r => r.index), ...speakers.map(s => s.index)])].sort((a, b) => a - b);
    const speakerAt = new Map(speakers.map(s => [s.index, s.who]));
    for (const index of indexes) {
        // The message counts first: what is recorded on it happened after it was written.
        if (speakerAt.has(index)) tick(bodies, speakerAt.get(index));
        for (const op of opsAt.get(index) || []) applyOp(bodies, op, index);
    }
    return bodies;
}

/** Replies left before a condition ends, or null without a reply duration. */
export function repliesLeft(c) {
    return c.endReplies > 0 ? Math.max(0, c.endReplies - (c.endCount || 0)) : null;
}

/** Ids of parts that are missing, directly or because an ancestor is. */
export function missingParts(body, index) {
    const missing = new Set();
    const mark = id => {
        if (missing.has(id)) return;
        missing.add(id);
        for (const c of index.parts.get(id)?.children || []) mark(c);
    };
    for (const c of body.conditions.values()) {
        if (c.kind === 'missing' && index.parts.has(c.part)) mark(c.part);
    }
    return missing;
}

/** True when the body has anything worth showing (drives the tab's warning dot). */
export function isAffected(body) {
    return !!body && (body.conditions.size > 0 || body.temp !== null || Object.values(body.meters || {}).some(l => l > 0));
}

export function severityRank(sev) {
    const i = SEVERITIES.indexOf(sev);
    return i < 0 ? -1 : i;
}

/** Small stable hash of a message's text (used to tie records to the text they came from). */
export function fingerprint(text) {
    let h = 2166136261;
    const s = String(text ?? '');
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
}

/**
 * Whether a part is shown for a body: parts for the other sex, and parts from
 * features (horns, tail…) the body doesn't have, are hidden.
 */
export function partShown(part, { sex = 'unspecified', hideSensitive = false, features = [] } = {}) {
    if (!part) return false;
    if (hideSensitive && part.sensitive) return false;
    if (part.addon && !features.includes(part.addon)) return false;
    return !part.sex || sex === 'unspecified' || part.sex === sex;
}

/**
 * Guesses a body's sex from pronouns in a character or persona description.
 * Returns 'unspecified' unless one set clearly dominates.
 */
export function guessSex(text) {
    const s = String(text ?? '');
    const count = re => (s.match(re) || []).length;
    const she = count(/\b(she|her|hers|herself)\b/gi);
    const he = count(/\b(he|him|his|himself)\b/gi);
    if (she >= 3 && she >= he * 2) return 'female';
    if (he >= 3 && he >= she * 2) return 'male';
    return 'unspecified';
}

/** A stable body key for an NPC name: "The Guard" → "n:the_guard". */
export function npcKey(name) {
    return 'n:' + String(name ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/**
 * Adds every feature (horns, tail, wings…) to a copy of the template, tagging
 * its parts and shapes with the feature id. The result describes every
 * possible body; each character only shows the features they have (partShown,
 * viewShapes).
 */
export function withFeatures(template, featureFile) {
    const t = structuredClone(template);
    const find = (nodes, id) => {
        for (const n of nodes || []) {
            if (n.id === id) return n;
            const hit = find(n.children, id);
            if (hit) return hit;
        }
        return null;
    };
    for (const f of featureFile?.features || []) {
        for (const { parent, part } of f.parts || []) {
            const host = find(t.parts, parent);
            if (!host) continue;
            host.children = host.children || [];
            host.children.push({ ...structuredClone(part), addon: f.id });
        }
        if (t.mannequin) {
            for (const s of f.shapes || []) {
                (t.mannequin[s.view] = t.mannequin[s.view] || []).push({ ...s, addon: f.id });
            }
        }
    }
    t.features = (featureFile?.features || []).map(f => ({ id: f.id, name: f.name }));
    t.presets = featureFile?.presets || [];
    return t;
}

const slug = s => String(s ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/**
 * Turns the user's custom features (from the editor) into the same format as
 * templates/addons.json. A custom feature is
 *   { id, name, parent, sided, parts: ['Base', 'Tip'], drawing: '<built-in feature id>' | '' }
 * and borrows the drawing of a built-in feature.
 */
export function customFeatureFile(custom, builtin) {
    const features = (custom?.features || []).filter(f => f.id && f.name && f.parent).map(f => {
        const children = (f.parts || []).map(p => String(p).trim()).filter(Boolean)
            .map(p => ({ id: `${f.id}_${slug(p)}`, name: p }));
        const source = (builtin?.features || []).find(b => b.id === f.drawing);
        const shapes = (source?.shapes || []).map(s => s.keepRegion
            ? { ...s }
            : { ...s, region: f.id, sided: !!f.sided });
        return {
            id: f.id,
            name: f.name,
            parts: [{ parent: f.parent, part: { id: f.id, name: f.name, sided: !!f.sided, region: true, children } }],
            shapes,
        };
    });
    return { features, presets: (custom?.presets || []).filter(p => p.id && p.name) };
}

/** Built-in features and presets followed by the user's own. */
export function mergeFeatureFiles(...files) {
    return {
        features: files.flatMap(f => f?.features || []),
        presets: files.flatMap(f => f?.presets || []),
    };
}
