// One-off background requests: detection and the ✨ fill buttons.
// Uses either the current main model or a chosen Connection Profile.

const ctx = () => SillyTavern.getContext();

// Thrown when the model returned no answer text. Usually a reasoning model that
// spent the whole token allowance thinking (finish_reason "length").
export class EmptyReplyError extends Error {
    constructor() {
        super('The model returned no answer text');
        this.name = 'EmptyReplyError';
    }
}

/** A user-facing explanation for a failed request. */
export function describeFailure(e) {
    if (e instanceof EmptyReplyError) {
        return 'The model returned no answer. If it is a reasoning model, it probably used the whole allowance thinking: raise "Max reply tokens" in the Body HUD settings, or pick a non-reasoning model.';
    }
    return 'The request failed. Details are in the SillyTavern server window and the browser console (F12).';
}

/**
 * @param {{ source: 'main'|'profile', profileId?: string }} model
 * @param {string} system
 * @param {string} user
 * @param {number} maxTokens
 * @returns {Promise<string>} the raw text reply
 */
export async function callModel(model, system, user, maxTokens) {
    const c = ctx();
    if (model.source === 'profile' && model.profileId) {
        const res = await c.ConnectionManagerRequestService.sendRequest(
            model.profileId,
            [{ role: 'system', content: system }, { role: 'user', content: user }],
            maxTokens,
            { stream: false, extractData: true, includePreset: true, includeInstruct: true },
        );
        const text = typeof res === 'string' ? res : String(res?.content ?? '');
        if (!text.trim()) throw new EmptyReplyError();
        return text;
    }
    try {
        const text = await c.generateRaw({ systemPrompt: system, prompt: user, responseLength: maxTokens, trimNames: false });
        if (!String(text ?? '').trim()) throw new EmptyReplyError();
        return text;
    } catch (e) {
        // generateRaw throws this when the reply had no text.
        if (/No message generated/i.test(String(e?.message))) throw new EmptyReplyError();
        throw e;
    }
}

/** Pulls the first JSON object out of a model reply (tolerates code fences and chatter). */
export function extractJson(text) {
    const s = String(text ?? '');
    const start = s.indexOf('{');
    if (start < 0) return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < s.length; i++) {
        const ch = s[i];
        if (inStr) {
            if (esc) esc = false;
            else if (ch === '\\') esc = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) {
            try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
        }
    }
    return null;
}
