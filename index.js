// Body HUD — SillyTavern extension entry point.
// Everything goes through SillyTavern.getContext() so the extension works no
// matter which folder it is installed into.

import { expandTemplate } from './src/model.js';
import { applyLayout, initPanel, render } from './src/panel.js';

const MODULE = 'body_hud';

const defaultSettings = Object.freeze({
    enabled: true,
    side: 'right',
    panelOpen: false,
    tempUnit: 'C',
    hideSensitive: false,
    probeInjection: false,
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

// Diagnostic from M0, kept until M2 replaces it with the real status note.
function updateProbeInjection() {
    const s = getSettings();
    const text = s.enabled && s.probeInjection
        ? '[Body HUD probe — injection is working. Ignore this line.]'
        : '';
    ctx().setExtensionPrompt(MODULE, text, 1, 1, false, 0);
}

function renderSettings() {
    const s = getSettings();
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
                        <option value="right" ${s.side !== 'left' ? 'selected' : ''}>Right</option>
                        <option value="left" ${s.side === 'left' ? 'selected' : ''}>Left</option>
                    </select>
                </div>
                <div class="bh-setting-row">
                    <span>Temperature</span>
                    <select id="body_hud_unit" class="text_pole">
                        <option value="C" ${s.tempUnit !== 'F' ? 'selected' : ''}>°C</option>
                        <option value="F" ${s.tempUnit === 'F' ? 'selected' : ''}>°F</option>
                    </select>
                </div>
                <label class="checkbox_label" title="Still tracked; just left out of the part picker.">
                    <input type="checkbox" id="body_hud_sensitive" ${s.hideSensitive ? 'checked' : ''}>
                    <span>Hide sensitive parts from the part list</span>
                </label>
                <hr>
                <small class="body-hud-muted">Diagnostics</small>
                <label class="checkbox_label" title="Adds a one-line test note to every prompt. Check it in the Prompt Itemizer.">
                    <input type="checkbox" id="body_hud_probe" ${s.probeInjection ? 'checked' : ''}>
                    <span>Probe: inject a test note</span>
                </label>
            </div>
        </div>
    </div>`;
    $('#extensions_settings2').append(html);

    const bind = (sel, key, read) => $(sel).on('change', function () {
        getSettings()[key] = read(this);
        saveSettings();
        applyLayout();
        updateProbeInjection();
        render();
    });
    bind('#body_hud_enabled', 'enabled', el => el.checked);
    bind('#body_hud_side', 'side', el => el.value);
    bind('#body_hud_unit', 'tempUnit', el => el.value);
    bind('#body_hud_sensitive', 'hideSensitive', el => el.checked);
    bind('#body_hud_probe', 'probeInjection', el => el.checked);
}

let renderQueued = false;
function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    setTimeout(() => { renderQueued = false; render(); }, 50);
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
    initPanel({ getSettings, saveSettings, getIndex: () => templateIndex });
    updateProbeInjection();

    for (const ev of [
        eventTypes.CHAT_CHANGED, eventTypes.CHAT_LOADED, eventTypes.MESSAGE_SENT, eventTypes.MESSAGE_RECEIVED,
        eventTypes.MESSAGE_EDITED, eventTypes.MESSAGE_DELETED, eventTypes.MESSAGE_SWIPED,
        eventTypes.MESSAGE_SWIPE_DELETED, eventTypes.GROUP_UPDATED, eventTypes.PERSONA_CHANGED,
    ]) {
        if (ev) eventSource.on(ev, queueRender);
    }
    eventSource.on(eventTypes.CHAT_CHANGED, updateProbeInjection);
    console.log('[Body HUD] loaded');
});
