// Time skips: what happens to bodies when time passes. Pure: no SillyTavern access.
//
// Realism levels (docs/concept.md):
// - cinematic: quick healing, nothing gets worse on its own;
// - grounded (default): realistic healing times; untreated wounds heal slower
//   and still-bleeding untreated wounds are flagged in the note;
// - simulation (opt-in): untreated wounds can get infected and worse, and heavy
//   bleeding leaves the character weak from blood loss.

import { BODY_PART, SEVERITIES, newId } from './model.js';

export const REALISM = {
    cinematic: 'Cinematic: quick healing, nothing worsens on its own',
    grounded: 'Grounded: realistic healing; untreated bleeding is flagged',
    simulation: 'Simulation: untreated wounds can get infected and worse',
};

// Days a wound spends in each stage before moving on (grounded speed).
const TO_HEALING = { minor: 1, moderate: 3, severe: 7, critical: 14 };   // fresh/treated → healing
const TO_HEALED = { minor: 7, moderate: 21, severe: 60, critical: 120 }; // healing → gone / scarred
const SPEED = { cinematic: 4, grounded: 1, simulation: 1 };
const UNTREATED_SLOWDOWN = 2; // grounded/simulation: an untreated wound takes twice as long to start healing

// Whole-body states and how long until they wear off (days).
const STATE_FADE = {
    wet: 0.25, cold: 0.25, overheated: 0.25, muddy: 0.25, bloody: 0.25,
    exhausted: 1, hungry: 1, thirsty: 1, drunk: 1, drugged: 1, nauseous: 1, 'in pain': 1,
};
const MIND_FADE = { cinematic: 0.25, grounded: 1, simulation: 1 };
const TEMP_FADE = 0.25;
const MARK_FADE = 3; // temporary marks (body paint, henna…) fade in a few days

export const UNITS = { hours: 1 / 24, days: 1, weeks: 7, months: 30 };

const sevIndex = s => Math.max(0, SEVERITIES.indexOf(s));

/** Days left until the wound's next stage, or null if it doesn't progress. */
export function daysToNextStage(c, realism = 'grounded') {
    if (c.kind && c.kind !== 'injury') return null;
    const sev = SEVERITIES[sevIndex(c.severity)];
    const speed = SPEED[realism] || 1;
    let need;
    if (c.status === 'fresh' || !c.status) {
        need = TO_HEALING[sev] * (realism === 'cinematic' ? 1 : UNTREATED_SLOWDOWN);
    } else if (c.status === 'treated') {
        need = TO_HEALING[sev];
    } else if (c.status === 'healing') {
        need = TO_HEALED[sev];
    } else {
        return null; // scarred / permanent
    }
    return Math.max(0, need / speed - (c.progress || 0));
}

/** Days left of a set duration, or null. */
export function daysLeft(c) {
    return c.endDays > 0 && c.kind !== 'injury' ? Math.max(0, c.endDays - (c.progress || 0)) : null;
}

const fmtDays = d => {
    if (d < 1) return `${Math.round(d * 24)} h`;
    if (d < 14) return `${Math.round(d)} day${Math.round(d) === 1 ? '' : 's'}`;
    if (d < 60) return `${Math.round(d / 7)} weeks`;
    return `${Math.round(d / 30)} months`;
};
export const formatDuration = fmtDays;

/** Where a wound ends up after healing finishes. */
function healedResult(c) {
    const sev = sevIndex(c.severity);
    if (sev === 0) return { remove: true };
    // Moderate wounds leave a mark; severe ones may leave a lasting limitation,
    // so their effect line is kept for the user to trim.
    return { changes: { status: 'scarred', severity: 'minor', bleeding: 'none', progress: 0, effect: sev >= 2 ? c.effect : '' } };
}

/**
 * Works out every change that `days` of time would bring.
 * @param {Map} bodies replayed bodies
 * @param {string[]} who body keys to include
 * @param {number} days
 * @param {'cinematic'|'grounded'|'simulation'} realism
 * @param {(key: string) => string} nameOf for summaries
 * @param {(partId: string) => string} partName for summaries
 * @returns {{ id: string, who: string, op: object, summary: string, group: string }[]}
 */
export function planTimeSkip(bodies, who, days, realism, nameOf, partName) {
    const out = [];
    const push = (w, op, summary, group) => out.push({ id: newId(), who: w, op, summary: `${nameOf(w)}: ${summary}`, group });
    const speed = SPEED[realism] || 1;

    for (const key of who) {
        const body = bodies.get(key);
        if (!body) continue;
        let bloodLoss = null;
        let infected = false;

        for (const c of body.conditions.values()) {
            const label = c.part && c.part !== BODY_PART && !String(c.kind).startsWith('mind') ? `${partName(c.part)} ${c.type ? c.type.toLowerCase() : ''}`.trim() : c.type;

            // A set duration ("wears off after 3 days") beats the defaults below.
            // Wounds heal by their own stages instead.
            if (c.endDays > 0 && c.kind && c.kind !== 'injury') {
                const total = (c.progress || 0) + days;
                if (total >= c.endDays) push(key, { t: 'remove', who: key, id: c.id }, `${label} has worn off`, 'clear');
                else push(key, { t: 'edit', who: key, id: c.id, changes: { progress: total } }, `${label}: time towards wearing off`, 'progress');
                continue;
            }
            if (c.kind === 'state') {
                const fade = STATE_FADE[String(c.type).toLowerCase()];
                if (fade !== undefined && days >= fade / speed) push(key, { t: 'remove', who: key, id: c.id }, `no longer ${c.type.toLowerCase()}`, 'clear');
                continue;
            }
            if (c.kind === 'mind_current') {
                if (days >= MIND_FADE[realism]) push(key, { t: 'remove', who: key, id: c.id }, `${c.type.toLowerCase()} has passed`, 'clear');
                continue;
            }
            if (c.kind === 'mark') {
                if (c.status === 'temporary' && days >= MARK_FADE / speed) push(key, { t: 'remove', who: key, id: c.id }, `${label} has faded`, 'clear');
                continue;
            }
            if (c.kind && c.kind !== 'injury') continue; // missing parts, lasting mind conditions

            const untreated = c.status === 'fresh' || !c.status;
            const sev = sevIndex(c.severity);
            const bleeding = ['none', 'light', 'moderate', 'heavy'].indexOf(c.bleeding || 'none');

            // Simulation: untreated wounds that are more than minor fester instead of healing.
            if (realism === 'simulation' && untreated && sev >= 1 && days >= TO_HEALING[SEVERITIES[sev]]) {
                const worse = SEVERITIES[Math.min(3, sev + 1)];
                const details = /infect/i.test(c.details || '') ? c.details : [c.details, 'infected'].filter(Boolean).join(', ');
                push(key, { t: 'edit', who: key, id: c.id, changes: { severity: worse, details } }, `${label} gets infected and worse (${worse})`, 'worsen');
                infected = true;
                if (bleeding >= 2) bloodLoss = Math.max(bloodLoss ?? 0, bleeding);
                continue;
            }
            if (realism === 'simulation' && untreated && bleeding >= 2 && days >= 1) bloodLoss = Math.max(bloodLoss ?? 0, bleeding);

            // Walk through stages with the time available, keeping leftover progress.
            let left = days;
            let cur = { ...c };
            const steps = [];
            let removed = false;
            for (let guard = 0; guard < 4; guard++) {
                const need = daysToNextStage(cur, realism);
                if (need === null || left < need) {
                    if (need !== null) cur.progress = (cur.progress || 0) + left;
                    break;
                }
                left -= need;
                if (cur.status === 'healing') {
                    const r = healedResult(cur);
                    if (r.remove) { removed = true; break; }
                    cur = { ...cur, ...r.changes };
                    steps.push('scarred');
                    break;
                }
                cur = { ...cur, status: 'healing', bleeding: 'none', progress: 0 };
                steps.push('healing');
            }
            if (removed) {
                push(key, { t: 'remove', who: key, id: c.id }, `${label} has healed`, 'heal');
                continue;
            }
            const changes = {};
            for (const k of ['status', 'severity', 'bleeding', 'effect']) {
                if ((cur[k] ?? null) !== (c[k] ?? null)) changes[k] = cur[k];
            }
            // A stage change resets progress by itself (see applyOp); store leftovers only.
            if ((cur.progress || 0) !== (c.progress || 0) && (cur.progress || 0) > 0) changes.progress = cur.progress;
            if (!Object.keys(changes).length) continue;
            const what = steps.includes('scarred') ? 'healed, leaving a scar' : steps.includes('healing') ? 'is healing' : null;
            // Progress alone isn't worth a line in the preview, but is still applied.
            push(key, { t: 'edit', who: key, id: c.id, changes }, what ? `${label} ${what}` : `${label}: time towards healing`, what ? 'heal' : 'progress');
        }

        if (bloodLoss !== null) {
            const sev = bloodLoss >= 3 ? 'severe' : 'moderate';
            const already = [...body.conditions.values()].some(c => c.kind === 'state' && /blood loss/i.test(c.type));
            if (!already) {
                push(key, { t: 'add', who: key, cond: { id: newId(), kind: 'state', part: BODY_PART, type: 'Weak from blood loss', severity: sev, effect: 'Dizzy, slow, tires quickly', details: '', cause: 'Untreated bleeding', hidden: false } }, 'weak from blood loss', 'worsen');
            }
        }
        if (realism === 'simulation' && infected) {
            push(key, { t: 'temp', who: key, value: 38.9 }, 'fever (38.9 °C) from infection', 'worsen');
        } else if (body.temp !== null && days >= TEMP_FADE) {
            push(key, { t: 'temp', who: key, value: null }, 'body temperature back to normal', 'clear');
        }
    }
    return out;
}
