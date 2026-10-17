// Runs detection after messages and the ✨ fill requests. Requests run one at a
// time; a result is only used if its message is unchanged when it comes back.

import { buildDetectPrompt, buildFillPrompt, mightMatter, parseDetection } from './detect.js';
import { callModel, extractJson } from './llm.js';
import { fingerprint } from './model.js';
import { addPending, buildBodies, getSceneMembers, writeDetectedOps } from './store.js';

const ctx = () => SillyTavern.getContext();

let opts;          // { getSettings, getIndex, onChange, openPanel }
let queue = Promise.resolve();
let busy = 0;

export function initRunner(options) {
    opts = options;
}

export const isBusy = () => busy > 0;

function modelChoice() {
    const s = opts.getSettings();
    return s.modelProfile ? { source: 'profile', profileId: s.modelProfile } : { source: 'main' };
}

function setBusy(delta) {
    busy += delta;
    opts.onChange?.();
}

/** Called for MESSAGE_SENT / MESSAGE_RECEIVED. */
export function onNewMessage(index, type) {
    const s = opts.getSettings();
    if (!s.enabled || s.detectMode === 'off' || s.detectMode === 'manual') return;
    if (type === 'first_message') return;
    const msg = ctx().chat[index];
    if (!msg || msg.is_system) return;
    if (msg.is_user && !s.detectUser) return;
    if (s.detectPrefilter && !mightMatter(msg.mes)) return;
    enqueue(() => detect(msg, { manual: false }));
}

/** The "Scan last message" button. */
export function scanLatest() {
    const chat = ctx().chat;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i] && !chat[i].is_system) {
            const msg = chat[i];
            enqueue(() => detect(msg, { manual: true }));
            return;
        }
    }
    toastr.info('No message to scan.');
}

function enqueue(job) {
    queue = queue.then(job).catch(e => console.error('[Body HUD] detection failed', e));
}

async function detect(msg, { manual }) {
    const c = ctx();
    const index = opts.getIndex();
    if (!index) return;
    const i = c.chat.indexOf(msg);
    if (i < 0) return;
    const fp = fingerprint(msg.mes);
    const swipe = msg.swipe_id;
    const members = getSceneMembers();
    const prev = opts.getSettings().detectContext ? c.chat.slice(0, i).reverse().find(m => !m.is_system) : null;
    const { system, user, ids } = buildDetectPrompt({
        members,
        bodies: buildBodies(),
        index,
        message: { name: msg.name, text: msg.mes },
        previous: prev ? { name: prev.name, text: prev.mes } : null,
    });

    setBusy(1);
    let raw;
    try {
        raw = await callModel(modelChoice(), system, user, 700);
    } catch (e) {
        console.error('[Body HUD] detection request failed', e);
        toastr.warning('Body HUD: the detection request failed. See the browser console for details.');
        return;
    } finally {
        setBusy(-1);
    }

    const json = extractJson(raw);
    if (!json) {
        console.warn('[Body HUD] detection reply was not JSON:', raw);
        if (manual) toastr.warning('Body HUD: the model did not reply with usable data.');
        return;
    }
    // The message may have been deleted, edited or swiped while we waited.
    if (!c.chat.includes(msg) || fingerprint(msg.mes) !== fp || msg.swipe_id !== swipe) return;

    const { proposals, skipped } = parseDetection(json, { members, index, ids });
    if (skipped.length) console.debug('[Body HUD] detection skipped:', skipped);
    if (!proposals.length) {
        if (manual) toastr.info('Body HUD: no body changes found in that message.');
        return;
    }

    if (opts.getSettings().detectMode === 'auto') {
        const ready = proposals.filter(p => !p.needsSide);
        const unsure = proposals.filter(p => p.needsSide);
        if (ready.length) await writeDetectedOps(msg, ready.map(p => p.op), fp);
        if (unsure.length) await addPending(msg, unsure, fp);
        toastr.info(
            `${ready.length ? `Applied ${ready.length} change${ready.length > 1 ? 's' : ''}` : ''}${ready.length && unsure.length ? '; ' : ''}${unsure.length ? `${unsure.length} need${unsure.length > 1 ? '' : 's'} a side picked` : ''}. Undo in the HUD.`,
            'Body HUD', { onclick: () => opts.openPanel() },
        );
    } else {
        await addPending(msg, proposals, fp);
        toastr.info(`${proposals.length} body change${proposals.length > 1 ? 's' : ''} to review. Click to open the HUD.`, 'Body HUD', { onclick: () => opts.openPanel() });
    }
    opts.onChange?.();
}

/**
 * Asks the model for effect/details/cause. Returns the suggestion object.
 * @param {{ characterName: string, cond: object, partLabel: string }} input
 */
export async function suggestFields({ characterName, cond, partLabel }) {
    const chat = ctx().chat.filter(m => !m.is_system).slice(-4);
    const recentChat = chat.map(m => `${m.name}: ${String(m.mes).slice(0, 700)}`).join('\n\n');
    const { system, user } = buildFillPrompt({ characterName, cond, partLabel, recentChat });
    setBusy(1);
    try {
        const raw = await callModel(modelChoice(), system, user, 250);
        return extractJson(raw) || {};
    } finally {
        setBusy(-1);
    }
}
