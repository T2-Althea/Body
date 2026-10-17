// Builds the plain-text status note the AI sees. Pure: no SillyTavern access.
//
// Rules (docs/concept.md, "How the AI sees it"):
// - only characters in the scene; nothing at all when nobody is affected;
// - worst first; trivial things drop off;
// - permanent things are one line;
// - hidden conditions are marked so others don't notice them;
// - a hard token budget, cutting the least important lines first.

import { BODY_PART, severityRank } from './model.js';

export const NOTE_HEADER = '[Body status — in effect right now]';

const lc = s => (s ? s.charAt(0).toLowerCase() + s.slice(1) : '');
const endDot = s => (/[.!?]$/.test(s) ? s : s + '.');

export function formatTemp(c, unit) {
    return unit === 'F' ? `${Math.round((c * 9 / 5 + 32) * 10) / 10} °F` : `${c} °C`;
}

export function isAbnormalTemp(c) {
    return c < 36 || c > 37.5;
}

export function tempLabel(c) {
    if (c < 35) return 'hypothermic';
    if (c < 36) return 'low';
    if (c >= 39.5) return 'high fever';
    if (c >= 38) return 'fever';
    if (c > 37.5) return 'slightly raised';
    return 'normal';
}

/** Trivial: cosmetic leftovers that don't change what the character can do. */
export function isTrivial(c) {
    if (c.effect) return false;
    return c.kind === 'injury' && c.severity === 'minor' && (c.status === 'scarred' || c.status === 'healing');
}

function hiddenTag(c) {
    return c.hidden ? ' Hidden: others don\'t know; it only shows in behavior.' : '';
}

/** One line of text plus a priority (higher = more important). */
function conditionLine(c, partName) {
    switch (c.kind) {
        case 'missing':
            return {
                prio: 60,
                text: `${partName(c.part)} missing${c.cause ? ` (${lc(c.cause)})` : ''}.${c.effect ? ' ' + endDot(c.effect) : ''}${hiddenTag(c)}`,
            };
        case 'mind_lasting':
            return { prio: 55, text: `Mind (lasting): ${lc(c.type)}.${c.effect ? ' ' + endDot(c.effect) : ''}${hiddenTag(c)}` };
        case 'mind_current':
            return { prio: 45 + severityRank(c.severity) * 5, text: `Mind (right now): ${lc(c.type)}.${c.effect ? ' ' + endDot(c.effect) : ''}${hiddenTag(c)}` };
        default: {
            const bits = [lc(c.type)];
            if (c.severity) bits.push(c.severity);
            if (c.status && c.status !== 'fresh') bits.push(c.status);
            if (c.details) bits.push(lc(c.details));
            if (c.bleeding && c.bleeding !== 'none') bits.push(`${c.bleeding} bleeding`);
            const sev = Math.max(0, severityRank(c.severity));
            const bleed = ['none', 'light', 'moderate', 'heavy'].indexOf(c.bleeding || 'none');
            const healed = c.status === 'scarred' || c.status === 'healing' ? -15 : 0;
            return {
                prio: 50 + sev * 12 + Math.max(0, bleed) * 6 + healed,
                text: `${partName(c.part)}: ${bits.join(', ')}.${c.effect ? ' ' + endDot(c.effect) : ''}${hiddenTag(c)}`,
            };
        }
    }
}

/** Whole-body states and temperature collapse into a single line. */
function wholeBodyLine(states, temp, opts, partName) {
    const showTemp = temp !== null && (opts.tempInNote === 'always' || isAbnormalTemp(temp));
    if (!states.length && !showTemp) return null;
    const local = s => s.part && s.part !== BODY_PART;
    const names = states.map(s => lc(s.type) + (local(s) ? ` (${lc(partName(s.part))})` : '') + (s.hidden ? ' (hidden)' : ''));
    const parts = [];
    if (names.length) parts.push(names.join(', '));
    if (showTemp) parts.push(`temperature ${formatTemp(temp, opts.tempUnit)} (${tempLabel(temp)})`);
    // "Whole body" only when nothing is limited to an area.
    let text = (states.some(local) ? 'States: ' : 'Whole body: ') + parts.join('; ') + '.';
    const effects = states.map(s => s.effect).filter(Boolean).map(endDot);
    if (effects.length) text += ' ' + effects.join(' ');
    const worst = Math.max(0, ...states.map(s => severityRank(s.severity)));
    const tempPrio = showTemp && (temp < 35 || temp > 39) ? 30 : 0;
    return { prio: 40 + worst * 10 + tempPrio, text };
}

/**
 * @param {{ key, name, isUser }[]} members scene members, in display order
 * @param {Map} bodies from replay()
 * @param {{ parts: Map }} index expanded template
 * @param {{ budget: number, tempUnit: 'C'|'F', tempInNote: 'abnormal'|'always' }} opts
 * @param {(text: string) => number} countTokens
 * @returns {{ text: string, tokens: number, omitted: number }}
 */
export function buildNote(members, bodies, index, opts, countTokens) {
    const partName = id => (id === BODY_PART ? 'Whole body' : index.parts.get(id)?.name || id);

    // Candidate lines per member.
    const candidates = [];
    members.forEach((m, mi) => {
        const body = bodies.get(m.key);
        if (!body) return;
        const conds = [...body.conditions.values()].filter(c => !isTrivial(c));
        const states = conds.filter(c => c.kind === 'state');
        for (const c of conds.filter(c => c.kind !== 'state')) {
            candidates.push({ mi, ...conditionLine(c, partName) });
        }
        const wb = wholeBodyLine(states, body.temp, opts, partName);
        if (wb) candidates.push({ mi, ...wb });
    });
    if (!candidates.length) return { text: '', tokens: 0, omitted: 0 };

    // Greedy fill by priority within the budget.
    const headerCost = countTokens(NOTE_HEADER);
    const nameCost = new Map();
    let used = headerCost;
    const chosen = [];
    const sorted = [...candidates].sort((a, b) => b.prio - a.prio);
    for (const cand of sorted) {
        const line = `- ${cand.text}`;
        const cost = countTokens(line) + (nameCost.has(cand.mi) ? 0 : countTokens(members[cand.mi].name + ' (user):'));
        if (used + cost > opts.budget && chosen.length) continue;
        used += cost;
        nameCost.set(cand.mi, true);
        chosen.push({ ...cand, line });
    }

    // Lay out by member (scene order), worst first within each.
    const out = [NOTE_HEADER];
    members.forEach((m, mi) => {
        const lines = chosen.filter(c => c.mi === mi).sort((a, b) => b.prio - a.prio);
        if (!lines.length) return;
        out.push(`${m.name}${m.isUser ? ' (user)' : ''}:`);
        lines.forEach(l => out.push(l.line));
    });
    const text = out.join('\n');
    return { text, tokens: countTokens(text), omitted: candidates.length - chosen.length };
}

/** Rough token estimate, used when no tokenizer is available. */
export function estimateTokens(text) {
    return Math.ceil(String(text).length / 3.6);
}
