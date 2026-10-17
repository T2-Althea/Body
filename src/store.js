// Reads and writes body records in the chat. Records live on messages
// (message.extra.body_hud) so they follow deletions and branches; a chat with no
// messages yet keeps them in chat metadata as a baseline.

import { fingerprint, guessSex, newId, replay } from './model.js';

export const EXTRA_KEY = 'body_hud';
export const USER_KEY = 'user';

const ctx = () => SillyTavern.getContext();

/**
 * The bodies shown for the current chat: the user's persona, the character, or
 * every group member.
 * @returns {{ key: string, name: string, isUser: boolean, muted?: boolean }[]}
 */
export function getSceneMembers({ bodies = null } = {}) {
    const c = ctx();
    const members = [{ key: USER_KEY, name: c.name1 || 'You', isUser: true }];
    if (c.groupId) {
        const group = c.groups.find(g => g.id === c.groupId);
        for (const avatar of group?.members || []) {
            const ch = c.characters.find(x => x.avatar === avatar);
            // Muted members stay editable but are left out of the AI's note.
            const muted = !!group.disabled_members?.includes(avatar);
            if (ch) members.push({ key: 'c:' + avatar, name: ch.name, isUser: false, muted });
        }
    } else if (c.characterId !== undefined && c.characters[c.characterId]) {
        const ch = c.characters[c.characterId];
        members.push({ key: 'c:' + ch.avatar, name: ch.name, isUser: false });
    }
    // NPCs currently in the scene.
    for (const [key, body] of bodies || buildBodies()) {
        if (body.npc?.present) members.push({ key, name: body.npc.name, isUser: false, npc: true, sex: body.npc.sex, features: body.npc.features });
    }
    return members;
}

/** NPCs who have left the scene (can be brought back). */
export function getAwayNpcs(bodies = buildBodies()) {
    return [...bodies].filter(([, b]) => b.npc && !b.npc.present).map(([key, b]) => ({ key, name: b.npc.name }));
}

export function hasOpenChat() {
    const c = ctx();
    return !!c.getCurrentChatId();
}

function baseline() {
    const meta = ctx().chatMetadata;
    return meta?.[EXTRA_KEY]?.ops || [];
}

// Detected changes carry the fingerprint of the text they were read from. If the
// message now says something else (edited, or a regenerated swipe that inherited
// the old swipe's data), they no longer apply. Manual changes have no
// fingerprint and always apply.
const isLive = (item, text) => !item.fp || item.fp === fingerprint(text);

/**
 * All records in chat order.
 * @param {{ skipDetectedAt?: number }} [options] ignore detected changes on this
 *   message (the reply being regenerated must not see wounds it caused itself)
 */
export function collectRecords({ skipDetectedAt = -1 } = {}) {
    const records = [{ index: -1, ops: baseline() }];
    ctx().chat.forEach((m, i) => {
        const rec = m?.extra?.[EXTRA_KEY];
        if (!rec || !Array.isArray(rec.ops) || !rec.ops.length) return;
        const ops = rec.ops.filter(op => isLive(op, m.mes) && !(op.fp && i === skipDetectedAt));
        if (ops.length) records.push({ index: i, ops });
    });
    return records;
}

/**
 * Who wrote each message (body keys), for "ends after N replies" durations. A
 * reply being regenerated (skipAt) doesn't count: it's about to be replaced.
 */
export function collectSpeakers({ skipAt = -1 } = {}) {
    const c = ctx();
    const solo = c.characterId !== undefined ? c.characters[c.characterId]?.avatar : null;
    const out = [];
    c.chat.forEach((m, index) => {
        if (!m || m.is_system || index === skipAt) return;
        const avatar = m.original_avatar || solo;
        out.push({ index, who: m.is_user ? USER_KEY : avatar ? 'c:' + avatar : 'ai' });
    });
    return out;
}

export function buildBodies(options) {
    return replay(collectRecords(options), collectSpeakers({ skipAt: options?.skipDetectedAt ?? -1 }));
}

function pushOps(extra, ops, mes) {
    const rec = extra[EXTRA_KEY] || (extra[EXTRA_KEY] = { v: 1, ops: [] });
    rec.ops.push(...structuredClone(ops));
    rec.fp = fingerprint(mes);
}

/**
 * Records manual edits on the latest message. Manual edits are copied into every
 * swipe of that message, so switching swipes doesn't undo what the user set by hand.
 */
export async function writeManualOps(ops, src = 'manual') {
    const c = ctx();
    const stamped = ops.map(op => ({ ...op, src, oid: newId() }));
    if (!c.chat.length) {
        const meta = c.chatMetadata;
        meta[EXTRA_KEY] = meta[EXTRA_KEY] || { ops: [] };
        meta[EXTRA_KEY].ops.push(...stamped);
        await c.saveMetadata();
        return;
    }
    const msg = c.chat[c.chat.length - 1];
    msg.extra = msg.extra || {};
    pushOps(msg.extra, stamped, msg.mes);
    if (Array.isArray(msg.swipe_info)) {
        msg.swipe_info.forEach((info, i) => {
            if (!info || info.extra === msg.extra) return;
            info.extra = info.extra || {};
            pushOps(info.extra, stamped, msg.swipes?.[i]);
        });
    }
    await c.saveChat();
}

// ---------- detection results ----------
// Detected changes belong to one specific reply, so they go on the current swipe
// only (message.extra plus its swipe_info copy), never on the other swipes.

function currentCopies(msg) {
    msg.extra = msg.extra || {};
    const copies = [msg.extra];
    const info = Array.isArray(msg.swipe_info) ? msg.swipe_info[msg.swipe_id ?? 0] : null;
    if (info && info.extra !== msg.extra) {
        info.extra = info.extra || {};
        copies.push(info.extra);
    }
    return copies.map(extra => extra[EXTRA_KEY] || (extra[EXTRA_KEY] = { v: 1, ops: [] }));
}

/** Applies detected ops to the message that caused them. */
export async function writeDetectedOps(msg, ops, fp, src = 'detect') {
    const stamped = ops.map(op => ({ ...op, src, fp, oid: newId() }));
    for (const rec of currentCopies(msg)) rec.ops.push(...structuredClone(stamped));
    await ctx().saveChat();
}

/** Stores proposals awaiting review on the message that caused them. */
export async function addPending(msg, proposals, fp) {
    for (const rec of currentCopies(msg)) {
        rec.pending = (rec.pending || []).concat(structuredClone(proposals.map(p => ({ ...p, fp }))));
    }
    await ctx().saveChat();
}

/** All proposals waiting for review, oldest first. */
export function collectPending() {
    const out = [];
    ctx().chat.forEach((m, index) => {
        for (const p of m?.extra?.[EXTRA_KEY]?.pending || []) {
            if (isLive(p, m.mes)) out.push({ index, ...p });
        }
    });
    return out;
}

/** Approves (op or list of ops given) or rejects (null) one proposal. */
export async function resolvePending(index, pid, op) {
    const msg = ctx().chat[index];
    if (!msg) return;
    // Already applied or rejected elsewhere: don't write it a second time.
    if (!(msg.extra?.[EXTRA_KEY]?.pending || []).some(x => x.pid === pid)) return;
    let fp = null;
    for (const rec of currentCopies(msg)) {
        const p = (rec.pending || []).find(x => x.pid === pid);
        if (p) fp = p.fp;
        rec.pending = (rec.pending || []).filter(x => x.pid !== pid);
    }
    const ops = Array.isArray(op) ? op : op ? [op] : [];
    if (ops.length) await writeDetectedOps(msg, ops, fp, 'review');
    else await ctx().saveChat();
}

/**
 * Most recent automatic changes, newest first: detected/approved ops one by one,
 * and each time skip as one entry ({ skip, ops }).
 */
export function recentDetected(limit = 10) {
    const out = [];
    const skips = new Map();
    const chat = ctx().chat;
    for (let i = chat.length - 1; i >= 0 && out.length < limit; i--) {
        const ops = (chat[i]?.extra?.[EXTRA_KEY]?.ops || []).filter(op => isLive(op, chat[i].mes));
        for (let j = ops.length - 1; j >= 0 && out.length < limit; j--) {
            const op = ops[j];
            if (op.skip) {
                if (!skips.has(op.skip)) {
                    const entry = { index: i, skip: op.skip, days: op.skipDays, ops: [] };
                    skips.set(op.skip, entry);
                    out.push(entry);
                }
                skips.get(op.skip).ops.push(op);
            } else if (op.src === 'detect' || op.src === 'review') {
                out.push({ index: i, op });
            }
        }
    }
    return out;
}

/** Undoes a whole time skip, wherever its ops were written (all swipes included). */
export async function undoSkip(skipId) {
    for (const m of ctx().chat) {
        const extras = [m?.extra, ...(Array.isArray(m?.swipe_info) ? m.swipe_info.map(s => s?.extra) : [])];
        for (const extra of extras) {
            const rec = extra?.[EXTRA_KEY];
            if (rec?.ops) rec.ops = rec.ops.filter(o => o.skip !== skipId);
        }
    }
    await ctx().saveChat();
}

/** Removes one recorded op (by oid) from a message: undo. */
export async function undoOp(index, oid) {
    const msg = ctx().chat[index];
    if (!msg) return;
    for (const rec of currentCopies(msg)) rec.ops = rec.ops.filter(o => o.oid !== oid);
    await ctx().saveChat();
}

/**
 * Drops detected changes and proposals that no longer match the message's text
 * (current swipe only; other swipes keep their own). Manual changes stay.
 * @returns {Promise<boolean>} whether anything was removed
 */
export async function pruneStale(msg) {
    if (!msg?.extra?.[EXTRA_KEY]) return false;
    let changed = false;
    for (const rec of currentCopies(msg)) {
        const ops = rec.ops.filter(op => isLive(op, msg.mes));
        const pending = (rec.pending || []).filter(p => isLive(p, msg.mes));
        if (ops.length !== rec.ops.length || pending.length !== (rec.pending || []).length) changed = true;
        rec.ops = ops;
        rec.pending = pending;
    }
    if (changed) await ctx().saveChat();
    return changed;
}

// ---------- body profiles ----------
// Sex/body shape is a property of the character (or persona), not of a chat, so
// it lives in extension settings: profiles['c:<avatar>'] or profiles['u:<persona name>'].

export function profileKey(member) {
    return member.isUser ? `u:${ctx().name1}` : member.key;
}

function descriptionOf(member) {
    const c = ctx();
    if (member.isUser) return c.powerUserSettings?.persona_description || '';
    const ch = c.characters.find(x => 'c:' + x.avatar === member.key);
    return [ch?.description, ch?.personality, ch?.data?.description].filter(Boolean).join('\n');
}

/** { sex, guessed } for a scene member: the saved choice, or a guess from their description. */
export function memberSex(member, profiles = {}) {
    if (member.npc) return { sex: member.sex || 'unspecified', guessed: false };
    const saved = profiles[profileKey(member)]?.sex;
    if (saved) return { sex: saved, guessed: false };
    return { sex: guessSex(descriptionOf(member)), guessed: true };
}

/** Body features (horns, tail…) a scene member has. */
export function memberFeatures(member, profiles = {}) {
    if (member.npc) return member.features || [];
    return profiles[profileKey(member)]?.features || [];
}
