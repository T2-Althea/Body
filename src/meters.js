// Meters: hunger, thirst, sleep, stamina, mana… Pure: no SillyTavern access.
//
// A meter is a list of named levels; level 0 is the comfortable one. Levels are
// set by 'meter' ops (manual, detection, time skips) and replayed like
// everything else. The AI only ever sees words, never numbers, and only for
// meters that aren't at the comfortable level.

const lc = s => (s ? s.charAt(0).toLowerCase() + s.slice(1) : '');
const endDot = s => (/[.!?]$/.test(s) ? s : s + '.');

/**
 * Checks a meter file ({ meters: [...] }) and fills in defaults.
 * @returns {{ meters: object[] }} throws an Error with a readable message when invalid
 */
export function normalizeMeters(file) {
    const list = Array.isArray(file) ? file : file?.meters;
    if (!Array.isArray(list)) throw new Error('Expected {"meters": [ ... ]}.');
    const seen = new Set();
    const meters = list.map((m, i) => {
        const where = `Meter ${i + 1}${m?.name ? ` (${m.name})` : ''}`;
        if (!m || typeof m !== 'object') throw new Error(`${where} is not an object.`);
        const id = String(m.id || m.name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        if (!id) throw new Error(`${where} needs a name.`);
        if (seen.has(id)) throw new Error(`Two meters have the id "${id}".`);
        seen.add(id);
        const levels = (Array.isArray(m.levels) ? m.levels : []).map(l => (typeof l === 'string' ? { name: l, effect: '' } : l))
            .filter(l => l && String(l.name || '').trim())
            .map(l => ({ name: String(l.name).trim(), effect: String(l.effect || '').trim() }));
        if (levels.length < 2) throw new Error(`${where} needs at least two levels.`);
        const hours = Number(m.recoverHours);
        return { id, name: String(m.name || id).trim(), default: m.default !== false, recoverHours: hours > 0 ? hours : 1, levels };
    });
    return { meters };
}

/** Current level index of a meter on a body (0 when never set). */
export function meterLevel(body, id, def) {
    const v = Number(body?.meters?.[id] ?? 0);
    return Math.max(0, Math.min((def?.levels.length ?? 99) - 1, Number.isFinite(v) ? v : 0));
}

/** 0 (comfortable) … 1 (worst level). */
export function meterRatio(def, level) {
    return def.levels.length > 1 ? level / (def.levels.length - 1) : 0;
}

/** Meters a body uses, in file order. */
export function activeMeters(defs, enabledIds) {
    return defs.filter(d => enabledIds.includes(d.id));
}

/** Note lines for one body: one per meter off its comfortable level. */
export function meterNoteLines(defs, enabledIds, body) {
    const out = [];
    for (const def of activeMeters(defs, enabledIds)) {
        const level = meterLevel(body, def.id, def);
        if (level === 0) continue;
        const l = def.levels[level];
        out.push({
            prio: 25 + Math.round(meterRatio(def, level) * 40),
            text: `${def.name}: ${lc(l.name)}.${l.effect ? ' ' + endDot(l.effect) : ''}`,
        });
    }
    return out;
}

/**
 * Time passing lets meters recover (people eat, drink and sleep during a skip):
 * one level per `recoverHours`, or all the way in cinematic mode.
 * @returns {{ op: object, summary: string, group: 'heal'|'clear' }[]}
 */
export function planMeterRecovery(defs, enabledIds, body, key, days, realism) {
    const hours = days * 24;
    const out = [];
    for (const def of activeMeters(defs, enabledIds)) {
        const level = meterLevel(body, def.id, def);
        if (level === 0) continue;
        const steps = realism === 'cinematic' ? level : Math.floor(hours / def.recoverHours + 1e-9);
        if (steps <= 0) continue;
        const next = Math.max(0, level - steps);
        out.push({
            op: { t: 'meter', who: key, id: def.id, level: next },
            summary: `${lc(def.name)} ${lc(def.levels[level].name)} → ${lc(def.levels[next].name)}`,
            group: next === 0 ? 'clear' : 'heal',
        });
    }
    return out;
}

/** "hunger fed, mana low" for the detection prompt. */
export function meterStateText(defs, enabledIds, body) {
    return activeMeters(defs, enabledIds).map(d => `${d.id} ${lc(d.levels[meterLevel(body, d.id, d)].name)}`).join(', ');
}

/** Resolves a level from the model: a level name or an index. */
export function resolveLevel(def, raw) {
    const s = String(raw ?? '').trim().toLowerCase();
    const i = def.levels.findIndex(l => l.name.toLowerCase() === s);
    if (i >= 0) return i;
    const n = Number(s);
    return Number.isInteger(n) && n >= 0 && n < def.levels.length ? n : null;
}
