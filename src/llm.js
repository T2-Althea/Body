// One-off background requests: detection and the ✨ fill buttons.
// Uses either the current main model or a chosen Connection Profile.

const ctx = () => SillyTavern.getContext();

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
        return typeof res === 'string' ? res : String(res?.content ?? '');
    }
    return await c.generateRaw({ systemPrompt: system, prompt: user, responseLength: maxTokens, trimNames: false });
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
