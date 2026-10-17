// Reads and writes body records in the chat. Records live on messages
// (message.extra.body_hud) so they follow deletions and branches; a chat with no
// messages yet keeps them in chat metadata as a baseline.

import { fingerprint, replay } from './model.js';

export const EXTRA_KEY = 'body_hud';
export const USER_KEY = 'user';

const ctx = () => SillyTavern.getContext();

/**
 * The bodies shown for the current chat: the user's persona, the character, or
 * every group member.
 * @returns {{ key: string, name: string, isUser: boolean, muted?: boolean }[]}
 */
export function getSceneMembers() {
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
    return members;
}

export function hasOpenChat() {
    const c = ctx();
    return !!c.getCurrentChatId();
}

function baseline() {
    const meta = ctx().chatMetadata;
    return meta?.[EXTRA_KEY]?.ops || [];
}

/** All records in chat order. */
export function collectRecords() {
    const records = [{ index: -1, ops: baseline() }];
    ctx().chat.forEach((m, i) => {
        const rec = m?.extra?.[EXTRA_KEY];
        if (rec && Array.isArray(rec.ops) && rec.ops.length) records.push({ index: i, ops: rec.ops });
    });
    return records;
}

export function buildBodies() {
    return replay(collectRecords());
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
export async function writeManualOps(ops) {
    const c = ctx();
    const stamped = ops.map(op => ({ ...op, src: 'manual' }));
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
