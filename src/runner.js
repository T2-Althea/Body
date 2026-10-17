// Runs detection after messages and the ✨ fill requests. Requests run one at a
// time; a result is only used if its message is unchanged when it comes back.

import { buildDetectPrompt, buildFillPrompt, mightMatter, parseDetection } from './detect.js';
import { callModel, describeFailure, extractJson } from './llm.js';
import { fingerprint } from './model.js';
import { addPending, buildBodies, getSceneMembers, meterContext, pruneStale, writeDetectedOps } from './store.js';

const ctx = () => SillyTavern.getContext();

let opts;          // { getSettings, getIndex, getMeterDefs, onChange, openPanel }
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

// Reasoning models spend part of this thinking before they answer, so it's generous;
// a non-reasoning model only uses what the short answer needs.
function maxTokens() {
    return Math.max(200, Number(opts.getSettings().taskMaxTokens) || 2000);
}

function setBusy(delta) {
    busy += delta;
    opts.onChange?.();
}

/** Called for MESSAGE_SENT / MESSAGE_RECEIVED / MESSAGE_EDITED. */
export async function onNewMessage(index, type) {
    const msg = ctx().chat[index];
    // A regenerated swipe inherits the previous swipe's data, and an edited
    // message keeps data read from its old text: clear what no longer matches.
    if (msg && await pruneStale(msg)) opts.onChange?.();
    const s = opts.getSettings();
    if (!s.enabled || s.detectMode === 'off' || s.detectMode === 'manual') return;
    if (type === 'first_message') return;
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
    // A fresh reply has no swipe_id until SillyTavern sets it to 0 a moment later.
    const swipe = msg.swipe_id ?? 0;
    const members = getSceneMembers();
    const meters = meterContext(opts.getMeterDefs?.() || [], opts.getSettings().profiles);
    const prev = opts.getSettings().detectContext ? c.chat.slice(0, i).reverse().find(m => !m.is_system) : null;
    const { system, user, ids } = buildDetectPrompt({
        members,
        bodies: buildBodies(),
        index,
        message: { name: msg.name, text: msg.mes },
        previous: prev ? { name: prev.name, text: prev.mes } : null,
        meters,
    });

    setBusy(1);
    let raw;
    try {
        raw = await callModel(modelChoice(), system, user, maxTokens());
    } catch (e) {
        console.error('[Body HUD] detection request failed', e);
        toastr.warning(describeFailure(e), 'Body HUD: detection failed', { timeOut: 10000 });
        return;
    } finally {
        setBusy(-1);
    }

    const json = extractJson(raw);
    if (!json) {
        console.warn('[Body HUD] detection reply was not JSON:', raw);
        toastr.warning('The model\'s answer was cut off or not in the expected format. Raising "Max reply tokens" in the settings usually helps.', 'Body HUD: detection failed', { timeOut: 10000 });
        return;
    }
    // The message may have been deleted, edited or swiped while we waited.
    if (!c.chat.includes(msg) || fingerprint(msg.mes) !== fp || (msg.swipe_id ?? 0) !== swipe) return;

    const { proposals, skipped } = parseDetection(json, { members, index, ids, allowNpcs: opts.getSettings().detectNpcs !== false, meters });
    if (skipped.length) console.debug('[Body HUD] detection skipped:', skipped);
    if (!proposals.length) {
        if (manual) toastr.info('Body HUD: no body changes found in that message.');
        return;
    }

    if (opts.getSettings().detectMode === 'auto') {
        // A time skip always waits for its preview; unknown sides wait for a pick.
        const ready = proposals.filter(p => !p.needsSide && p.op.t !== 'timeskip');
        const unsure = proposals.filter(p => p.needsSide || p.op.t === 'timeskip');
        // A new NPC's proposal brings them into the scene first.
        if (ready.length) await writeDetectedOps(msg, ready.flatMap(p => (p.npc ? [{ t: 'npc_add', who: p.npc.who, name: p.npc.name }, p.op] : [p.op])), fp);
        if (unsure.length) await addPending(msg, unsure, fp);
        toastr.info(
            `${ready.length ? `Applied ${ready.length} change${ready.length > 1 ? 's' : ''}` : ''}${ready.length && unsure.length ? '; ' : ''}${unsure.length ? `${unsure.length} waiting for you in the HUD` : ''}. Undo in the HUD.`,
            'Body HUD', { onclick: () => opts.openPanel() },
        );
    } else {
        await addPending(msg, proposals, fp);
        toastr.info(`${proposals.length} body change${proposals.length > 1 ? 's' : ''} to review. Click to open the HUD.`, 'Body HUD', { onclick: () => opts.openPanel() });
    }
    opts.onChange?.();
}

/**
 * Asks the model for some fields of a condition. Returns the suggestion object.
 * @param {{ characterName: string, cond: object, partLabel: string, fields: string[], category: string }} input
 */
export async function suggestFields({ characterName, cond, partLabel, fields, category }) {
    const chat = ctx().chat.filter(m => !m.is_system).slice(-4);
    const recentChat = chat.map(m => `${m.name}: ${String(m.mes).slice(0, 700)}`).join('\n\n');
    const { system, user } = buildFillPrompt({ characterName, cond, partLabel, recentChat, fields, category });
    setBusy(1);
    try {
        const raw = await callModel(modelChoice(), system, user, maxTokens());
        return extractJson(raw) || {};
    } finally {
        setBusy(-1);
    }
}
