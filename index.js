// Body HUD — SillyTavern extension entry point.
// Everything goes through SillyTavern.getContext() so the extension works no
// matter which folder it is installed into.

import { expandTemplate } from './src/model.js';
import { buildNote, estimateTokens } from './src/note.js';
import { applyLayout, initPanel, render } from './src/panel.js';
import { buildBodies, getSceneMembers, hasOpenChat } from './src/store.js';

const MODULE = 'body_hud';

const defaultSettings = Object.freeze({
    enabled: true,
    side: 'right',
    panelOpen: false,
    tempUnit: 'C',
    hideSensitive: false,
    // The note the AI sees.
    inject: true,
    position: 1,      // 1 = in chat at depth, 0 = after the main prompt, 2 = before it
    depth: 1,         // 1 = just above the latest message
    role: 0,          // 0 = system, 1 = user, 2 = assistant
    budget: 200,      // tokens
    tempInNote: 'abnormal',
    notePreviewOpen: false,
});

let templateIndex = null;

function ctx() {
    return SillyTavern.getContext();
}

function getSettings() {
    const all = ctx().extensionSettings;
    all[MODULE] = Object.assign({}, defaultSettings, all[MODULE]);
    return all[MODULE];
}

function saveSettings() {
    ctx().saveSettingsDebounced();
}

async function loadTemplate() {
    const res = await fetch(new URL('./templates/human.json', import.meta.url));
    templateIndex = expandTemplate(await res.json());
}

/** The note for the current chat, or an empty one. */
function computeNote() {
    const s = getSettings();
    if (!s.enabled || !templateIndex || !hasOpenChat()) return { text: '', tokens: 0, omitted: 0 };
    const members = getSceneMembers().filter(m => !m.muted);
    return buildNote(members, buildBodies(), templateIndex, {
        budget: Number(s.budget) || 200,
        tempUnit: s.tempUnit,
        tempInNote: s.tempInNote,
    }, estimateTokens);
}

// Sets (or clears) the note. It occupies one slot that is replaced every time,
// so only the current note is ever in the prompt.
function updateInjection() {
    const s = getSettings();
    const text = s.inject ? computeNote().text : '';
    ctx().setExtensionPrompt(MODULE, text, Number(s.position), Number(s.depth), false, Number(s.role));
}

// Called by SillyTavern right before every generation (manifest: generate_interceptor).
globalThis.bodyHudInterceptor = async function () {
    try {
        updateInjection();
    } catch (e) {
        console.error('[Body HUD] failed to build the status note', e);
    }
};

function renderSettings() {
    const s = getSettings();
    const sel = (v, cur) => (String(v) === String(cur) ? 'selected' : '');
    const html = `
    <div class="body-hud-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Body HUD</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label">
                    <input type="checkbox" id="body_hud_enabled" ${s.enabled ? 'checked' : ''}>
                    <span>Enabled</span>
                </label>
                <div class="bh-setting-row">
                    <span>Panel side</span>
                    <select id="body_hud_side" class="text_pole">
                        <option value="right" ${sel('right', s.side)}>Right</option>
                        <option value="left" ${sel('left', s.side)}>Left</option>
                    </select>
                </div>
                <div class="bh-setting-row">
                    <span>Temperature</span>
                    <select id="body_hud_unit" class="text_pole">
                        <option value="C" ${sel('C', s.tempUnit)}>°C</option>
                        <option value="F" ${sel('F', s.tempUnit)}>°F</option>
                    </select>
                </div>
                <label class="checkbox_label" title="Still tracked; just left out of the part picker.">
                    <input type="checkbox" id="body_hud_sensitive" ${s.hideSensitive ? 'checked' : ''}>
                    <span>Hide sensitive parts from the part list</span>
                </label>
                <hr>
                <b>Note sent to the AI</b>
                <label class="checkbox_label">
                    <input type="checkbox" id="body_hud_inject" ${s.inject ? 'checked' : ''}>
                    <span>Send the status note</span>
                </label>
                <div class="bh-setting-row">
                    <span>Where</span>
                    <select id="body_hud_position" class="text_pole">
                        <option value="1" ${sel(1, s.position)}>In chat, at a depth</option>
                        <option value="0" ${sel(0, s.position)}>After the main prompt</option>
                        <option value="2" ${sel(2, s.position)}>Before the main prompt</option>
                    </select>
                </div>
                <div class="bh-setting-row" title="0 = after the latest message, 1 = just above it, and so on.">
                    <span>Depth</span>
                    <input id="body_hud_depth" class="text_pole" type="number" min="0" max="50" value="${s.depth}">
                </div>
                <div class="bh-setting-row">
                    <span>Sent as</span>
                    <select id="body_hud_role" class="text_pole">
                        <option value="0" ${sel(0, s.role)}>System</option>
                        <option value="1" ${sel(1, s.role)}>User</option>
                        <option value="2" ${sel(2, s.role)}>Assistant</option>
                    </select>
                </div>
                <div class="bh-setting-row" title="Least important lines are left out when the note would be longer than this.">
                    <span>Max length (tokens)</span>
                    <input id="body_hud_budget" class="text_pole" type="number" min="40" max="2000" step="10" value="${s.budget}">
                </div>
                <div class="bh-setting-row">
                    <span>Temperature in note</span>
                    <select id="body_hud_tempnote" class="text_pole">
                        <option value="abnormal" ${sel('abnormal', s.tempInNote)}>Only when abnormal</option>
                        <option value="always" ${sel('always', s.tempInNote)}>Always</option>
                    </select>
                </div>
                <small class="body-hud-muted">The note's exact text is shown at the bottom of the HUD panel.</small>
            </div>
        </div>
    </div>`;
    $('#extensions_settings2').append(html);

    const bind = (selector, key, read) => $(selector).on('change', function () {
        getSettings()[key] = read(this);
        saveSettings();
        applyLayout();
        refresh();
    });
    const num = (min, max) => el => Math.min(max, Math.max(min, Number(el.value) || 0));
    bind('#body_hud_enabled', 'enabled', el => el.checked);
    bind('#body_hud_side', 'side', el => el.value);
    bind('#body_hud_unit', 'tempUnit', el => el.value);
    bind('#body_hud_sensitive', 'hideSensitive', el => el.checked);
    bind('#body_hud_inject', 'inject', el => el.checked);
    bind('#body_hud_position', 'position', el => Number(el.value));
    bind('#body_hud_depth', 'depth', num(0, 50));
    bind('#body_hud_role', 'role', el => Number(el.value));
    bind('#body_hud_budget', 'budget', num(40, 2000));
    bind('#body_hud_tempnote', 'tempInNote', el => el.value);
}

function refresh() {
    render();
    updateInjection();
}

let refreshQueued = false;
function queueRefresh() {
    if (refreshQueued) return;
    refreshQueued = true;
    setTimeout(() => { refreshQueued = false; refresh(); }, 50);
}

jQuery(async () => {
    const { eventSource, eventTypes } = ctx();
    getSettings();
    renderSettings();
    try {
        await loadTemplate();
    } catch (e) {
        console.error('[Body HUD] failed to load template', e);
        toastr.error('Body HUD could not load its body template.');
    }
    initPanel({
        getSettings,
        saveSettings,
        getIndex: () => templateIndex,
        getNote: computeNote,
        onStateChange: updateInjection,
    });
    updateInjection();

    for (const ev of [
        eventTypes.CHAT_CHANGED, eventTypes.CHAT_LOADED, eventTypes.MESSAGE_SENT, eventTypes.MESSAGE_RECEIVED,
        eventTypes.MESSAGE_EDITED, eventTypes.MESSAGE_DELETED, eventTypes.MESSAGE_SWIPED,
        eventTypes.MESSAGE_SWIPE_DELETED, eventTypes.GROUP_UPDATED, eventTypes.PERSONA_CHANGED,
    ]) {
        if (ev) eventSource.on(ev, queueRefresh);
    }
    console.log('[Body HUD] loaded');
});
