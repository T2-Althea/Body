// The side panel: an edge tab that opens a panel in the empty space beside the
// chat. Hides itself while SillyTavern's own drawer on the same side is open.

import {
    BLEEDING, BODY_PART, BODY_STATES, KINDS, MIND_PART, SEVERITIES, STATUSES,
    isAffected, missingParts, newId, severityRank,
} from './model.js';
import { withSide } from './detect.js';
import { renderMannequin } from './mannequin.js';
import { isBusy, scanLatest, suggestFields } from './runner.js';
import {
    buildBodies, collectPending, getSceneMembers, hasOpenChat, recentDetected, resolvePending, undoOp, writeManualOps,
} from './store.js';

const INJURY_TYPES = [
    'Cut', 'Stab wound', 'Arrow wound', 'Gunshot wound', 'Bite', 'Claw marks', 'Bruise',
    'Burn', 'Frostbite', 'Fracture', 'Dislocation', 'Sprain', 'Concussion', 'Puncture',
];

// Drawers that occupy each side of the screen.
const SIDE_DRAWERS = {
    right: ['#right-nav-panel'],
    left: ['#left-nav-panel', '#WorldInfo'],
};

let opts;            // { getSettings, saveSettings, getIndex, getNote, onStateChange }
let selected = null; // member key currently shown
let form = null;     // null | { mode: 'add'|'edit'|'temp'|'review', id?, part?, draft?, index?, pid?, who?, cond? }
let zoom = null;     // region id being inspected, or null for the whole body
let observer = null;

const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[ch]));
const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : '';

function toUnit(c) {
    return opts.getSettings().tempUnit === 'F' ? Math.round((c * 9 / 5 + 32) * 10) / 10 : c;
}
function fromUnit(v) {
    return opts.getSettings().tempUnit === 'F' ? Math.round(((v - 32) * 5 / 9) * 10) / 10 : v;
}
const unitLabel = () => (opts.getSettings().tempUnit === 'F' ? '°F' : '°C');

export function initPanel(options) {
    opts = options;
    $('body').append(`
        <div id="body_hud_root">
            <div id="body_hud_tab" title="Body HUD">
                <i class="fa-solid fa-person"></i>
                <span class="bh-dot"></span>
            </div>
            <div id="body_hud_panel">
                <div class="bh-header">
                    <b>Body HUD</b>
                    <span id="body_hud_busy" class="fa-solid fa-spinner fa-spin" title="Checking the latest message…"></span>
                    <div id="body_hud_close" class="fa-solid fa-xmark bh-iconbtn" title="Close"></div>
                </div>
                <div class="bh-members"></div>
                <div class="bh-content"></div>
            </div>
        </div>`);

    $('#body_hud_tab').on('click', () => setOpen(true));
    $('#body_hud_close').on('click', () => setOpen(false));
    $('#body_hud_panel')
        .on('click', '.bh-member', function () { selected = $(this).attr('data-key'); form = null; zoom = null; render(); })
        .on('click', '.bh-m-region', function () { zoom = this.getAttribute('data-region'); render(); })
        .on('click', '[data-act]', onAction)
        .on('change', '#bh_f_kind', () => updateFormFields());
    // 'toggle' doesn't bubble, so listen in the capture phase.
    document.getElementById('body_hud_panel').addEventListener('toggle', e => {
        if (!e.target.classList?.contains('bh-note')) return;
        opts.getSettings().notePreviewOpen = e.target.open;
        opts.saveSettings();
    }, true);

    applyLayout();
    render();
}

export function applyLayout() {
    const s = opts.getSettings();
    const root = $('#body_hud_root');
    root.toggleClass('bh-left', s.side === 'left').toggleClass('bh-right', s.side !== 'left');
    root.toggleClass('bh-open', !!s.panelOpen);
    root.toggleClass('bh-disabled', !s.enabled);
    watchDrawers();
}

function setOpen(open) {
    opts.getSettings().panelOpen = open;
    opts.saveSettings();
    applyLayout();
}

function watchDrawers() {
    observer?.disconnect();
    const side = opts.getSettings().side === 'left' ? 'left' : 'right';
    const els = SIDE_DRAWERS[side].map(sel => document.querySelector(sel)).filter(Boolean);
    const update = () => {
        const covered = els.some(el => el.classList.contains('openDrawer'));
        $('#body_hud_root').toggleClass('bh-covered', covered);
    };
    observer = new MutationObserver(update);
    els.forEach(el => observer.observe(el, { attributes: true, attributeFilter: ['class'] }));
    update();
}

// ---------- rendering ----------

export function render() {
    if (!opts) return;
    const index = opts.getIndex();
    const panel = $('#body_hud_panel');
    const content = panel.find('.bh-content');
    const membersEl = panel.find('.bh-members');

    if (!hasOpenChat() || !index) {
        membersEl.empty();
        content.html('<div class="bh-empty">Open a chat to see bodies.</div>');
        $('#body_hud_tab').removeClass('bh-alert');
        return;
    }

    // Keep what's typed in an open form across re-renders.
    if (form && form.key && $('#body_hud_panel .bh-form').attr('data-key') === form.key) form.draft = rawForm();
    $('#body_hud_busy').toggle(isBusy());

    const bodies = buildBodies();
    const members = getSceneMembers();
    if (!members.some(m => m.key === selected)) selected = members[members.length - 1]?.key;

    $('#body_hud_tab').toggleClass('bh-alert', members.some(m => isAffected(bodies.get(m.key))));
    membersEl.html(members.map(m => `
        <div class="bh-member menu_button ${m.key === selected ? 'bh-active' : ''}" data-key="${esc(m.key)}">
            ${esc(m.name)}${m.isUser ? ' <small>(you)</small>' : ''}${m.muted ? ' <small>(muted)</small>' : ''}${isAffected(bodies.get(m.key)) ? '<span class="bh-dot"></span>' : ''}
        </div>`).join(''));

    const body = bodies.get(selected) || { conditions: new Map(), temp: null };
    let html = renderPending(members);
    if (zoom && index.parts.has(zoom)) html += renderZoom(body, index);
    else if (opts.getSettings().showMannequin) {
        zoom = null;
        html += renderMannequin(index.mannequin, body, index);
    }
    if (form) html += renderForm(body, index);

    const conds = [...body.conditions.values()];
    const states = conds.filter(c => c.kind === 'state');
    const mind = conds.filter(c => c.kind === 'mind_lasting' || c.kind === 'mind_current');
    const injuries = conds.filter(c => c.kind === 'injury' || !c.kind);
    const missing = conds.filter(c => c.kind === 'missing');

    html += '<div class="bh-section"><div class="bh-chips">';
    if (body.temp !== null) {
        html += `<span class="bh-chip" data-act="temp" title="Body temperature">🌡 ${toUnit(body.temp)} ${unitLabel()}</span>`;
    }
    for (const c of states) {
        const area = c.part && c.part !== BODY_PART ? ` · ${partName(index, c.part)}` : '';
        html += `<span class="bh-chip bh-sev-${esc(c.severity)}" data-act="edit" data-id="${esc(c.id)}" title="${esc(c.effect || '')}">${esc(c.type)}${esc(area)}${c.hidden ? ' 🙈' : ''}</span>`;
    }
    html += '</div></div>';

    if (mind.length) html += section('Mind', mind.map(c => condRow(c, index)).join(''));

    if (injuries.length) {
        const byRegion = new Map();
        for (const c of injuries.sort((a, b) => severityRank(b.severity) - severityRank(a.severity))) {
            const regionId = index.parts.get(c.part)?.regionId || c.part;
            if (!byRegion.has(regionId)) byRegion.set(regionId, []);
            byRegion.get(regionId).push(c);
        }
        html += section('On the body', [...byRegion.entries()].map(([rid, list]) => `
            <div class="bh-region">${esc(index.parts.get(rid)?.name || rid)}</div>
            ${list.map(c => condRow(c, index)).join('')}`).join(''));
    }

    if (missing.length) {
        const lost = missingParts(body, index);
        html += section('Missing', missing.map(c => {
            const below = [...lost].filter(id => id !== c.part && isDescendant(index, id, c.part)).length;
            return condRow(c, index, below ? `includes ${below} part${below > 1 ? 's' : ''} below it` : '');
        }).join(''));
    }

    if (!conds.length && body.temp === null) {
        html += '<div class="bh-empty">No conditions. Nothing is sent to the AI for this character.</div>';
    }

    const scan = opts.getSettings().detectMode !== 'off'
        ? '<div class="menu_button" data-act="scan" title="Ask the model to check the latest message for body changes"><i class="fa-solid fa-magnifying-glass"></i> Scan last message</div>'
        : '';
    html += `<div class="bh-actions">
        <div class="menu_button" data-act="add"><i class="fa-solid fa-plus"></i> Condition</div>
        <div class="menu_button" data-act="temp"><i class="fa-solid fa-temperature-half"></i> Temperature</div>
        ${scan}
    </div>`;
    html += renderLog(members, index);

    html += renderNotePreview();

    content.html(html);
    if (form && form.mode !== 'temp') updateFormFields();
    if (form?.scroll) {
        form.scroll = false;
        content.find('.bh-form')[0]?.scrollIntoView({ block: 'nearest' });
    }
}

// Zoomed-in region: every part inside it with its conditions, and a "+" per part.
// Nested regions (the hand inside the arm) appear as links to zoom further.
function renderZoom(body, index) {
    const region = index.parts.get(zoom);
    const lost = missingParts(body, index);
    const hideSensitive = opts.getSettings().hideSensitive;
    const condsOn = id => [...body.conditions.values()].filter(c => c.part === id && c.kind !== 'state');
    const parentRegion = region.parentId ? index.parts.get(region.parentId)?.regionId : null;

    const rows = [];
    const visit = (id, depth) => {
        const p = index.parts.get(id);
        if (!p) return;
        if (id !== zoom && p.region) {
            rows.push(`<div class="bh-zrow bh-zlink ${lost.has(id) ? 'bh-zmissing' : ''}" style="padding-left:${depth * 12}px" data-act="zoom" data-region="${esc(id)}">
                ${esc(p.name)} <i class="fa-solid fa-chevron-right"></i></div>`);
            return;
        }
        const conds = condsOn(id);
        if (hideSensitive && p.sensitive && !conds.length) return;
        const chips = conds.map(c => `<span class="bh-zchip bh-sev-${esc(c.kind === 'missing' ? 'missing' : c.severity)}" data-act="edit" data-id="${esc(c.id)}">${esc(c.kind === 'missing' ? 'missing' : c.type)}</span>`).join('');
        rows.push(`<div class="bh-zrow ${lost.has(id) ? 'bh-zmissing' : ''}" style="padding-left:${depth * 12}px">
            <span class="bh-zname">${esc(id === zoom ? `${p.name} (general)` : p.name)}</span>${chips}
            <span class="fa-solid fa-plus bh-iconbtn bh-zadd" data-act="add-on" data-part="${esc(id)}" title="Add a condition here"></span>
        </div>`);
        if (id === zoom) p.children.forEach(ch => visit(ch, 1));
        else p.children.forEach(ch => visit(ch, depth + 1));
    };
    visit(zoom, 0);

    return `<div class="bh-zoom">
        <div class="bh-zoom-head">
            <span class="fa-solid fa-arrow-left bh-iconbtn" data-act="zoom" data-region="${esc(parentRegion || '')}" title="Back"></span>
            <b>${esc(region.name)}</b>
        </div>
        ${rows.join('')}
    </div>`;
}

// Proposals from detection waiting for the user's decision.
function renderPending(members) {
    const pending = collectPending();
    if (!pending.length) return '';
    const name = key => members.find(m => m.key === key)?.name || key;
    const rows = pending.map(p => {
        const ref = `data-index="${p.index}" data-pid="${esc(p.pid)}"`;
        const buttons = p.needsSide
            ? `<div class="menu_button bh-small" data-act="side" data-side="left" ${ref}>Left</div>
               <div class="menu_button bh-small" data-act="side" data-side="right" ${ref}>Right</div>`
            : `<div class="fa-solid fa-check bh-iconbtn" data-act="approve" ${ref} title="Apply"></div>
               ${p.op.t === 'add' ? `<div class="fa-solid fa-pen bh-iconbtn" data-act="review-edit" ${ref} title="Edit, then apply"></div>` : ''}`;
        const extra = p.op.t === 'add' && p.op.cond.effect ? `<div class="bh-cond-effect">${esc(p.op.cond.effect)}</div>` : '';
        return `<div class="bh-cond bh-pending">
            <div class="bh-cond-main">
                <div>${esc(p.summary)}</div>${extra}
                <div class="bh-cond-meta">from message #${p.index}${p.needsSide ? ' · which side?' : ''}${p.who !== selected ? ` · ${esc(name(p.who))}` : ''}</div>
            </div>
            <div class="bh-cond-btns">${buttons}
                <div class="fa-solid fa-xmark bh-iconbtn" data-act="reject" ${ref} title="Reject"></div>
            </div>
        </div>`;
    }).join('');
    return `<div class="bh-review bh-section">
        <div class="bh-section-title">Proposed changes (${pending.length})</div>
        ${rows}
        <div class="bh-actions">
            <div class="menu_button bh-small" data-act="approve-all">Apply all</div>
            <div class="menu_button bh-small" data-act="reject-all">Reject all</div>
        </div>
    </div>`;
}

// Changes made by detection, newest first, each with an undo.
function renderLog(members, index) {
    const items = recentDetected(10);
    if (!items.length) return '';
    const name = key => members.find(m => m.key === key)?.name || key;
    const describe = op => {
        switch (op.t) {
            case 'add': return `${op.cond.type}${op.cond.part && index.parts.has(op.cond.part) ? ` — ${partName(index, op.cond.part)}` : ''}`;
            case 'edit': return Object.entries(op.changes).map(([k, v]) => `${k} → ${v}`).join(', ');
            case 'remove': return 'removed a condition';
            case 'temp': return op.value === null ? 'temperature cleared' : `temperature ${op.value} °C`;
            default: return op.t;
        }
    };
    const rows = items.map(({ index: i, op }) => `<div class="bh-logrow">
        <span>${esc(name(op.who))}: ${esc(describe(op))} <small>(#${i}${op.src === 'review' ? ', reviewed' : ''})</small></span>
        <span class="fa-solid fa-rotate-left bh-iconbtn" data-act="undo" data-index="${i}" data-oid="${esc(op.oid)}" title="Undo"></span>
    </div>`).join('');
    return `<details class="bh-log bh-section"><summary class="bh-section-title">Recent automatic changes</summary>${rows}</details>`;
}

// Exactly what will be sent before the next reply, for every body in the scene.
function renderNotePreview() {
    const s = opts.getSettings();
    const note = opts.getNote();
    let inner;
    if (!s.inject) inner = '<div class="bh-empty">Sending is turned off in the extension settings.</div>';
    else if (!note.text) inner = '<div class="bh-empty">Nothing. Everyone in the scene is fine, so no note is sent.</div>';
    else {
        inner = `<pre class="bh-note-text">${esc(note.text)}</pre>`;
        if (note.omitted) inner += `<div class="bh-cond-meta">${note.omitted} less important line${note.omitted > 1 ? 's' : ''} left out to stay within the length limit.</div>`;
    }
    const size = s.inject && note.text ? ` <small>(~${note.tokens} tokens)</small>` : '';
    return `<details class="bh-note bh-section" ${s.notePreviewOpen ? 'open' : ''}>
        <summary class="bh-section-title">What the AI sees${size}</summary>${inner}
    </details>`;
}

function isDescendant(index, id, ancestor) {
    let p = index.parts.get(id)?.parentId;
    while (p) {
        if (p === ancestor) return true;
        p = index.parts.get(p)?.parentId;
    }
    return false;
}

function section(title, inner) {
    return `<div class="bh-section"><div class="bh-section-title">${title}</div>${inner}</div>`;
}

function partName(index, id) {
    if (id === BODY_PART) return 'Whole body';
    return index.parts.get(id)?.name || id;
}

function condRow(c, index, note = '') {
    const meta = [
        c.kind === 'injury' || !c.kind ? cap(c.severity) : null,
        c.bleeding && c.bleeding !== 'none' ? `bleeding: ${c.bleeding}` : null,
        c.status ? cap(c.status) : null,
        c.kind === 'mind_current' ? 'current' : c.kind === 'mind_lasting' ? 'lasting' : null,
        c.since >= 0 ? `since #${c.since}` : 'before the chat',
        note || null,
    ].filter(Boolean).join(' · ');
    const title = c.kind === 'missing' ? partName(index, c.part)
        : c.kind?.startsWith('mind') ? c.type
            : `${partName(index, c.part)}: ${c.type}`;
    return `
        <div class="bh-cond bh-sev-${esc(c.severity || (c.kind === 'missing' ? 'missing' : ''))}">
            <div class="bh-cond-main">
                <div class="bh-cond-title">${esc(title)}${c.hidden ? ' <span title="Hidden from other characters">🙈</span>' : ''}</div>
                ${c.effect ? `<div class="bh-cond-effect">${esc(c.effect)}</div>` : ''}
                ${c.details ? `<div class="bh-cond-meta">${esc(c.details)}</div>` : ''}
                <div class="bh-cond-meta">${esc(meta)}</div>
            </div>
            <div class="bh-cond-btns">
                <div class="fa-solid fa-pen bh-iconbtn" data-act="edit" data-id="${esc(c.id)}" title="Edit"></div>
                <div class="fa-solid fa-trash-can bh-iconbtn" data-act="remove" data-id="${esc(c.id)}" title="Remove"></div>
            </div>
        </div>`;
}

function options(values, current, labels = null) {
    return values.map((v, i) => `<option value="${esc(v)}" ${v === current ? 'selected' : ''}>${esc(labels ? labels[i] : cap(v))}</option>`).join('');
}

function renderForm(body, index) {
    if (form.mode === 'temp') {
        const v = body.temp === null ? '' : toUnit(body.temp);
        return `<div class="bh-form">
            <div class="bh-section-title">Body temperature</div>
            <label>Value (${unitLabel()}) <input id="bh_f_temp" class="text_pole" type="number" step="0.1" value="${v}"></label>
            <div class="bh-actions">
                <div class="menu_button" data-act="save-temp">Save</div>
                <div class="menu_button" data-act="clear-temp">Clear</div>
                <div class="menu_button" data-act="cancel">Cancel</div>
            </div>
        </div>`;
    }

    form.key = form.key || newId();
    const c = form.mode === 'edit' ? body.conditions.get(form.id) : form.mode === 'review' ? form.cond : null;
    const base = c || { kind: 'injury', part: form.part || '', type: '', severity: 'moderate', bleeding: 'none', status: 'fresh', effect: '', details: '', cause: '', hidden: false };
    const v = { ...base, ...(form.draft || {}) };
    const fill = field => `<span class="fa-solid fa-wand-magic-sparkles bh-fill" data-act="fill" data-field="${field}" title="Suggest this from the condition and the recent story"></span>`;
    const hideSensitive = opts.getSettings().hideSensitive;
    const partOpts = index.order
        .filter(id => !(hideSensitive && index.parts.get(id).sensitive) || id === v.part)
        .map(id => {
            const p = index.parts.get(id);
            return `<option value="${esc(id)}" ${id === v.part ? 'selected' : ''}>${'  '.repeat(p.depth)}${esc(p.name)}</option>`;
        }).join('');

    return `<div class="bh-form" data-key="${form.key}">
        <div class="bh-section-title">${form.mode === 'review' ? 'Edit proposed change' : c ? 'Edit condition' : 'New condition'}</div>
        <label>Kind <select id="bh_f_kind" class="text_pole">${options(Object.keys(KINDS), v.kind || 'injury', Object.values(KINDS))}</select></label>
        <label class="bh-f-part"><span class="bh-f-part-label">Part</span> <select id="bh_f_part" class="text_pole"><option value="">— choose —</option>${partOpts}</select></label>
        <label class="bh-f-type">What <input id="bh_f_type" class="text_pole" list="bh_types" value="${esc(v.type)}" placeholder="e.g. Arrow wound"></label>
        <datalist id="bh_types"></datalist>
        <div class="bh-row">
            <label class="bh-f-sev">Severity <select id="bh_f_sev" class="text_pole">${options(SEVERITIES, v.severity)}</select></label>
            <label class="bh-f-bleed">Bleeding <select id="bh_f_bleed" class="text_pole">${options(BLEEDING, v.bleeding || 'none')}</select></label>
            <label class="bh-f-status">Status <select id="bh_f_status" class="text_pole">${options(STATUSES, v.status || 'fresh')}</select></label>
        </div>
        <label>Effect (what they can't do) ${fill('effect')}<input id="bh_f_effect" class="text_pole" value="${esc(v.effect)}" placeholder="e.g. Can't run; limps"></label>
        <label>Details ${fill('details')}<input id="bh_f_details" class="text_pole" value="${esc(v.details)}" placeholder="e.g. Arrowhead still lodged"></label>
        <label>Cause ${fill('cause')}<input id="bh_f_cause" class="text_pole" value="${esc(v.cause)}" placeholder="e.g. Bandit's arrow"></label>
        <label class="checkbox_label"><input id="bh_f_hidden" type="checkbox" ${v.hidden ? 'checked' : ''}> <span>Hidden from other characters</span></label>
        <div class="bh-actions">
            <div class="menu_button" data-act="save">${form.mode === 'review' ? 'Apply' : 'Save'}</div>
            <div class="menu_button" data-act="cancel">Cancel</div>
            <div class="menu_button" data-act="fill" data-field="" title="Suggest Effect, Details and Cause where they're empty"><i class="fa-solid fa-wand-magic-sparkles"></i> Fill empty</div>
        </div>
    </div>`;
}

// Shows only the fields that make sense for the chosen kind.
function updateFormFields() {
    const kind = $('#bh_f_kind').val();
    const isInjury = kind === 'injury';
    const isState = kind === 'state';
    $('.bh-f-part').toggle(isInjury || kind === 'missing' || isState);
    $('.bh-f-part-label').text(isState ? 'Area (optional)' : 'Part');
    $('#bh_f_part option[value=""]').text(isState ? 'Whole body' : '— choose —');
    $('.bh-f-type').toggle(kind !== 'missing');
    $('.bh-f-bleed').toggle(isInjury);
    $('.bh-f-sev').toggle(kind !== 'missing');
    $('.bh-f-status').toggle(isInjury || kind === 'missing');
    if (kind === 'missing' && form?.mode === 'add') $('#bh_f_status').val('permanent');
    const list = kind === 'state' ? BODY_STATES : isInjury ? INJURY_TYPES : [];
    $('#bh_types').html(list.map(t => `<option value="${esc(t)}">`).join(''));
}

// Current form values without validation (for drafts and the fill buttons).
function rawForm() {
    return {
        kind: $('#bh_f_kind').val(),
        part: $('#bh_f_part').val(),
        type: String($('#bh_f_type').val() ?? ''),
        severity: $('#bh_f_sev').val(),
        bleeding: $('#bh_f_bleed').val(),
        status: $('#bh_f_status').val(),
        effect: String($('#bh_f_effect').val() ?? ''),
        details: String($('#bh_f_details').val() ?? ''),
        cause: String($('#bh_f_cause').val() ?? ''),
        hidden: $('#bh_f_hidden').is(':checked'),
    };
}

function readForm() {
    const kind = $('#bh_f_kind').val();
    let part = $('#bh_f_part').val();
    if (kind === 'state') part = part || BODY_PART;
    if (kind === 'mind_lasting' || kind === 'mind_current') part = MIND_PART;
    const cond = {
        kind,
        part,
        type: kind === 'missing' ? 'Missing' : String($('#bh_f_type').val()).trim(),
        severity: kind === 'missing' ? null : $('#bh_f_sev').val(),
        bleeding: kind === 'injury' ? $('#bh_f_bleed').val() : null,
        status: kind === 'injury' || kind === 'missing' ? $('#bh_f_status').val() : null,
        effect: String($('#bh_f_effect').val()).trim(),
        details: String($('#bh_f_details').val()).trim(),
        cause: String($('#bh_f_cause').val()).trim(),
        hidden: $('#bh_f_hidden').is(':checked'),
    };
    if ((kind === 'injury' || kind === 'missing') && !cond.part) return { error: 'Choose a body part.' };
    if (kind !== 'missing' && !cond.type) return { error: 'Describe what it is (the "What" field).' };
    return { cond };
}

async function onAction(e) {
    e.stopPropagation();
    const act = $(this).attr('data-act');
    const id = $(this).attr('data-id');
    const pIndex = Number($(this).attr('data-index'));
    const pid = $(this).attr('data-pid');
    const findPending = () => collectPending().find(p => p.index === pIndex && p.pid === pid);
    const afterStore = async promise => {
        await promise;
        render();
        opts.onStateChange?.();
    };
    switch (act) {
        case 'approve': { const p = findPending(); if (p) await afterStore(resolvePending(pIndex, pid, p.op)); return; }
        case 'side': { const p = findPending(); if (p) await afterStore(resolvePending(pIndex, pid, withSide(p, $(this).attr('data-side')).op)); return; }
        case 'reject': await afterStore(resolvePending(pIndex, pid, null)); return;
        case 'approve-all':
        case 'reject-all':
            await afterStore((async () => {
                for (const p of collectPending()) {
                    if (act === 'approve-all' && p.needsSide) continue;
                    await resolvePending(p.index, p.pid, act === 'approve-all' ? p.op : null);
                }
            })());
            return;
        case 'review-edit': {
            const p = findPending();
            if (!p) return;
            selected = p.who;
            form = { mode: 'review', index: p.index, pid: p.pid, who: p.who, cond: p.op.cond, scroll: true };
            render();
            return;
        }
        case 'undo': await afterStore(undoOp(pIndex, $(this).attr('data-oid'))); return;
        case 'scan': scanLatest(); return;
        case 'fill': await fillFields($(this).attr('data-field')); return;
    }
    let ops = null;
    switch (act) {
        case 'add': form = { mode: 'add', scroll: true }; break;
        case 'add-on': form = { mode: 'add', part: $(this).attr('data-part'), scroll: true }; break;
        case 'zoom': zoom = $(this).attr('data-region') || null; break;
        case 'edit': form = { mode: 'edit', id, scroll: true }; break;
        case 'temp': form = { mode: 'temp' }; break;
        case 'cancel': form = null; break;
        case 'remove':
            ops = [{ t: 'remove', who: selected, id }];
            if (form?.id === id) form = null;
            break;
        case 'save': {
            const { cond, error } = readForm();
            if (error) { toastr.warning(error); return; }
            if (form.mode === 'review') {
                const { index: i, pid: rpid, who, cond: orig } = form;
                form = null;
                await afterStore(resolvePending(i, rpid, { t: 'add', who, cond: { ...orig, ...cond } }));
                return;
            }
            ops = form.mode === 'edit'
                ? [{ t: 'edit', who: selected, id: form.id, changes: cond }]
                : [{ t: 'add', who: selected, cond: { id: newId(), ...cond } }];
            form = null;
            break;
        }
        case 'save-temp': {
            const raw = parseFloat(String($('#bh_f_temp').val()));
            if (!isFinite(raw)) { toastr.warning('Enter a number, or use Clear.'); return; }
            ops = [{ t: 'temp', who: selected, value: fromUnit(raw) }];
            form = null;
            break;
        }
        case 'clear-temp':
            ops = [{ t: 'temp', who: selected, value: null }];
            form = null;
            break;
    }
    // writeManualOps updates the chat synchronously before saving, so render
    // straight away; the save finishing later can't clobber a form opened meanwhile.
    const saving = ops ? writeManualOps(ops) : null;
    render();
    if (ops) opts.onStateChange?.();
    await saving;
}

// ✨ buttons: one field (replaces it) or every empty field.
async function fillFields(field) {
    const index = opts.getIndex();
    const raw = rawForm();
    if (raw.kind !== 'missing' && !raw.type.trim()) {
        toastr.info('Fill in "What" first, so there is something to describe.');
        return;
    }
    const who = form?.mode === 'review' ? form.who : selected;
    const member = getSceneMembers().find(m => m.key === who);
    const part = raw.kind === 'state' ? (raw.part || BODY_PART) : raw.kind.startsWith('mind') ? MIND_PART : raw.part;
    const targets = field ? [field] : ['effect', 'details', 'cause'].filter(f => !raw[f].trim());
    if (!targets.length) { toastr.info('Nothing empty to fill.'); return; }
    const myForm = form;
    $('.bh-fill, [data-act="fill"]').addClass('bh-working');
    try {
        const suggestion = await suggestFields({
            characterName: member?.name || 'Character',
            cond: { ...raw, type: raw.kind === 'missing' ? 'Missing' : raw.type },
            partLabel: part === BODY_PART ? 'whole body' : partName(index, part),
        });
        if (form !== myForm) return;
        let filled = 0;
        for (const f of targets) {
            const val = String(suggestion?.[f] ?? '').trim();
            if (val) { $(`#bh_f_${f}`).val(val); filled++; }
        }
        if (!filled) toastr.warning('The model had no suggestion. Try again or type it yourself.');
    } catch (e) {
        console.error('[Body HUD] fill failed', e);
        toastr.warning('Body HUD: the suggestion request failed.');
    } finally {
        $('.bh-fill, [data-act="fill"]').removeClass('bh-working');
    }
}
