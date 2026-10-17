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
};
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
            if (op.cond?.id) body.conditions.set(op.cond.id, { ...op.cond, since: messageIndex });
            break;
        case 'edit': {
            const c = body.conditions.get(op.id);
            if (!c) break;
            const next = { ...c, ...op.changes, id: c.id, since: c.since };
            // Healing progress counts days in the current stage; a new stage starts at zero.
            if (op.changes.status && op.changes.status !== c.status && !('progress' in op.changes)) next.progress = 0;
            body.conditions.set(op.id, next);
            break;
        }
        case 'remove':
            body.conditions.delete(op.id);
            break;
        case 'temp':
            body.temp = typeof op.value === 'number' && isFinite(op.value) ? op.value : null;
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

/**
 * Rebuilds every body from scratch.
 * @param {{ index: number, ops: object[] }[]} records in chat order (index -1 = chat baseline)
 */
export function replay(records) {
    const bodies = new Map();
    for (const { index, ops } of records) {
        for (const op of ops || []) applyOp(bodies, op, index);
    }
    return bodies;
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
    return !!body && (body.conditions.size > 0 || body.temp !== null);
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
