// Body HUD — SillyTavern extension.
// M0 scaffold: settings panel, and a diagnostic probe that exercises the two
// SillyTavern mechanisms the real extension depends on:
//   1. prompt injection (setExtensionPrompt) — the note the AI will see;
//   2. per-message storage (message.extra) — where body changes will live so
//      they follow swipes, edits, deletions and branches.
// Everything goes through SillyTavern.getContext() so the extension works no
// matter which folder it is installed into.

const MODULE = 'body_hud';
const PROBE_KEY = 'body_hud_probe';

const defaultSettings = Object.freeze({
    enabled: true,
    probeInjection: false,
});

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

// The probe note is re-set before every generation and cleared when off, so it
// never accumulates in the chat — only the current value is ever in the prompt.
function updateProbeInjection() {
    const { setExtensionPrompt } = ctx();
    const s = getSettings();
    const text = s.enabled && s.probeInjection
        ? '[Body HUD probe — injection is working. Ignore this line.]'
        : '';
    // position 1 = in-chat, depth 1 = just above the latest message, role 0 = system
    setExtensionPrompt(MODULE, text, 1, 1, false, 0);
}

function stampLastMessage() {
    const { chat, saveChat } = ctx();
    if (!chat.length) {
        toastr.info('No messages in this chat.');
        return '';
    }
    const id = chat.length - 1;
    const msg = chat[id];
    msg.extra = msg.extra || {};
    msg.extra[PROBE_KEY] = { swipe: msg.swipe_id ?? 0, at: Date.now() };
    saveChat();
    toastr.success(`Stamped message #${id}.`);
    return '';
}

function reportStamps() {
    const { chat } = ctx();
    const lines = [];
    chat.forEach((m, i) => {
        const p = m.extra?.[PROBE_KEY];
        if (p) lines.push(`#${i} (now on swipe ${m.swipe_id ?? 0}): stamped on swipe ${p.swipe}`);
    });
    const out = lines.length ? lines.join('\n') : 'No stamped messages in this chat.';
    toastr.info(out.replace(/\n/g, '<br>'), 'Body HUD probe', { escapeHtml: false });
    return out;
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
                <hr>
                <small class="body-hud-muted">Diagnostics (early development build)</small>
                <label class="checkbox_label" title="Adds a one-line test note to every prompt. Check it in the Prompt Itemizer.">
                    <input type="checkbox" id="body_hud_probe" ${s.probeInjection ? 'checked' : ''}>
                    <span>Probe: inject a test note</span>
                </label>
                <small class="body-hud-muted">Slash commands: <code>/bodyhud-stamp</code> marks the last message, <code>/bodyhud-check</code> lists marked messages.</small>
            </div>
        </div>
    </div>`;
    $('#extensions_settings2').append(html);

    $('#body_hud_enabled').on('change', function () {
        getSettings().enabled = this.checked;
        saveSettings();
        updateProbeInjection();
    });
    $('#body_hud_probe').on('change', function () {
        getSettings().probeInjection = this.checked;
        saveSettings();
        updateProbeInjection();
    });
}

function registerCommands() {
    const { SlashCommandParser, SlashCommand } = ctx();
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'bodyhud-stamp',
        callback: stampLastMessage,
        helpString: 'Body HUD diagnostics: store a marker on the last message.',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'bodyhud-check',
        callback: reportStamps,
        helpString: 'Body HUD diagnostics: list messages carrying a marker.',
    }));
}

jQuery(() => {
    const { eventSource, eventTypes } = ctx();
    getSettings();
    renderSettings();
    registerCommands();
    updateProbeInjection();
    eventSource.on(eventTypes.CHAT_CHANGED, updateProbeInjection);
    console.log('[Body HUD] loaded');
});
