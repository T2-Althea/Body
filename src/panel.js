// The side panel: an edge tab that opens a panel in the empty space beside the
// chat. Hides itself while SillyTavern's own drawer on the same side is open.

import {
    BLEEDING, BODY_PART, BODY_STATES, CATEGORIES, INTENSITY_LABELS, MARK_DURATIONS, MIND_PART, PAIN_LEVELS, SEVERITIES, SEXES, STATUSES,
    bodySubOf, categoryOf, isAffected, missingParts, newId, npcKey, parseNaturalStates, partShown, repliesLeft, severityRank,
} from './model.js';
import { withSide } from './detect.js';
import { describeFailure } from './llm.js';
import { tempLabel } from './note.js';
import { renderMannequin } from './mannequin.js';
import { activeMeters, meterLevel, meterRatio } from './meters.js';
import { MOODS, MOOD_EMOJI, moodWord } from './mood.js';
import { SLOTS, cleanItems, slotWearable } from './clothing.js';
import { isBusy, scanLatest, suggestFields } from './runner.js';
import { UNITS, daysLeft, daysToNextStage, formatDuration, planTimeSkip } from './timeskip.js';
import {
    buildBodies, collectPending, getAwayNpcs, getSceneMembers, hasOpenChat, memberFeatures, memberMeters, memberSex, meterContext, profileKey, recentDetected, resolvePending,
    undoOp, undoSkip, writeManualOps,
} from './store.js';

const MARK_TYPES = ['Tattoo', 'Body paint', 'War paint', 'Brand', 'Birthmark', 'Scar', 'Henna', 'Rune'];

const INJURY_TYPES = [
    'Cut', 'Stab wound', 'Arrow wound', 'Gunshot wound', 'Bite', 'Claw marks', 'Bruise',
    'Burn', 'Frostbite', 'Fracture', 'Dislocation', 'Sprain', 'Concussion', 'Puncture',
];

const MIND_TYPES = [
    'Panicked', 'Afraid', 'Anxious', 'Grieving', 'Furious', 'Ashamed', 'Dazed', 'Confused',
    'In shock', 'Traumatized', 'Nightmares', 'Phobia', 'Amnesia',
];

const EFFECT_TYPES = [
    'Poisoned', 'Drugged', 'Sedated', 'Painkillers', 'Stimulant', 'Side effects', 'Allergic reaction',
    'Hangover', 'Healing potion', 'Blessed', 'Cursed', 'Hexed', 'Charmed', 'Weakened',
    'Enhanced strength', 'Enhanced speed', 'Night vision', 'Strain warning',
];

// "Ends" choices in the progress block.
const END_UNITS = { hours: 1 / 24, days: 1, weeks: 7 };

// Drawers that occupy each side of the screen.
const SIDE_DRAWERS = {
    right: ['#right-nav-panel'],
    left: ['#left-nav-panel', '#WorldInfo'],
};

let opts;            // { getSettings, saveSettings, getIndex, getNote, onStateChange, editFeatures, getMeterDefs, editMeters }
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
        .on('click', '.bh-member:not([data-act])', function () { selected = $(this).attr('data-key'); form = null; zoom = null; render(); })
        .on('click', '.bh-m-region', function () { zoom = this.getAttribute('data-region'); render(); })
        .on('click', '[data-act]', onAction)
        .on('change', '#bh_p_sex', async function () {
            const m = selectedMember();
            if (!m) return;
            // An NPC belongs to this chat, so its body is stored in the chat like everything else.
            if (m.npc) {
                await writeManualOps([{ t: 'npc_update', who: m.key, changes: { sex: this.value } }]);
                render();
                return;
            }
            const s = opts.getSettings();
            s.profiles = s.profiles || {};
            s.profiles[profileKey(m)] = { ...(s.profiles[profileKey(m)] || {}), sex: this.value };
            opts.saveSettings();
            render();
        })
        .on('change', '#bh_p_race', function () {
            const preset = opts.getIndex()?.presets.find(p => p.id === this.value);
            if (preset) saveFeatures([...preset.features]);
        })
        .on('change', '#bh_w_slot', function () {
            const slot = SLOTS.find(s => s.id === this.value);
            $('#bh_w_items').html((slot?.examples || []).map(x => `<option value="${esc(x)}">`).join(''));
        })
        .on('change', '.bh-meter-pick input', function () {
            const have = new Set(currentMeters());
            if (this.checked) have.add(this.getAttribute('data-meter')); else have.delete(this.getAttribute('data-meter'));
            saveMeters((opts.getMeterDefs?.() || []).map(d => d.id).filter(id => have.has(id)));
        })
        .on('change', '.bh-feature input', function () {
            const have = new Set(currentFeatures());
            if (this.checked) have.add(this.getAttribute('data-feature')); else have.delete(this.getAttribute('data-feature'));
            saveFeatures([...have]);
        })
        .on('change', '#bh_f_part, #bh_f_ends, #bh_f_type', () => updateFormFields())
        .on('change', '#bh_s_amount, #bh_s_unit, #bh_s_scope', () => {
            if (form?.mode !== 'skip') return;
            form.amount = $('#bh_s_amount').val();
            form.unit = $('#bh_s_unit').val();
            form.scope = $('#bh_s_scope').val();
            // The preview no longer matches; drop it without re-rendering, so the
            // click that caused this blur (often on Preview) still lands.
            form.plan = null;
            $('#body_hud_panel .bh-skip-preview, #body_hud_panel [data-act="skip-apply"]').remove();
        })
        .on('change', '.bh-skip-item input', function () {
            const id = this.getAttribute('data-change');
            if (this.checked) form.off.delete(id); else form.off.add(id);
        });
    // 'toggle' doesn't bubble, so listen in the capture phase.
    document.getElementById('body_hud_panel').addEventListener('toggle', e => {
        const key = e.target.classList?.contains('bh-note') ? 'notePreviewOpen' : e.target.classList?.contains('bh-clothing') ? 'clothesOpen' : null;
        if (!key || opts.getSettings()[key] === e.target.open) return;
        opts.getSettings()[key] = e.target.open;
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
    const members = getSceneMembers({ bodies });
    if (!members.some(m => m.key === selected)) selected = members.find(m => !m.isUser && !m.npc)?.key || members[members.length - 1]?.key;

    $('#body_hud_tab').toggleClass('bh-alert', members.some(m => isAffected(bodies.get(m.key))));
    const away = getAwayNpcs(bodies);
    membersEl.html(members.map(m => `
        <div class="bh-member menu_button ${m.key === selected ? 'bh-active' : ''} ${m.npc ? 'bh-npc' : ''}" data-key="${esc(m.key)}">
            ${esc(m.name)}${m.isUser ? ' <small>(you)</small>' : ''}${m.npc ? ' <small>(NPC)</small>' : ''}${m.muted ? ' <small>(muted)</small>' : ''}${isAffected(bodies.get(m.key)) ? '<span class="bh-dot"></span>' : ''}
        </div>`).join('')
        + '<div class="bh-member menu_button bh-addnpc" data-act="npc-new" title="Add someone who isn\'t a SillyTavern character: the guard, a wolf…"><i class="fa-solid fa-plus"></i> NPC</div>'
        + (away.length ? `<div class="bh-away">Left the scene: ${away.map(a => `<span class="bh-link" data-act="npc-return" data-key="${esc(a.key)}" data-name="${esc(a.name)}" title="Bring back">${esc(a.name)} ↩</span>`).join(', ')}</div>` : '')
        + renderProfile(members));

    // A form editing a proposal (or previewing a story time skip) closes once that
    // proposal has been applied or rejected some other way.
    const proposalForm = form?.mode === 'review' ? form : form?.origin ? { index: form.origin.index, pid: form.origin.pid } : null;
    if (proposalForm && !collectPending().some(p => p.index === proposalForm.index && p.pid === proposalForm.pid)) form = null;

    const body = bodies.get(selected) || { conditions: new Map(), temp: null };
    let html = renderPending(members);
    if (zoom && index.parts.has(zoom)) html += renderZoom(body, index);
    else if (opts.getSettings().showMannequin) {
        zoom = null;
        html += renderMannequin(index.mannequin, body, index, { variant: currentSex() === 'female' ? 'feminine' : null, features: currentFeatures() });
    }
    if (form) html += renderForm(body, index);

    const conds = [...body.conditions.values()];
    const states = conds.filter(c => c.kind === 'state');
    const natural = conds.filter(c => c.kind === 'natural');
    const effects = conds.filter(c => c.kind === 'effect');
    const mind = conds.filter(c => c.kind === 'mind_lasting' || c.kind === 'mind_current');
    const injuries = conds.filter(c => c.kind === 'injury' || !c.kind);
    const missing = conds.filter(c => c.kind === 'missing');
    const marks = conds.filter(c => c.kind === 'mark');

    html += '<div class="bh-section"><div class="bh-chips">';
    // Temperature is always shown; unset means normal.
    html += body.temp !== null
        ? `<span class="bh-chip bh-temp" data-act="temp" title="Body temperature (click to change)">🌡 ${toUnit(body.temp)} ${unitLabel()} · ${tempLabel(body.temp)}</span>`
        : `<span class="bh-chip bh-temp bh-chip-muted" data-act="temp" title="Normal (not set). Click to set it.">🌡 ${toUnit(37)} ${unitLabel()} · normal</span>`;
    for (const c of states) {
        const area = c.part && c.part !== BODY_PART ? ` · ${partName(index, c.part)}` : '';
        html += `<span class="bh-chip bh-sev-${esc(c.severity)}" data-act="edit" data-id="${esc(c.id)}" title="${esc(c.effect || 'Click to edit')}">${esc(c.type)}${esc(area)}${c.hidden ? ' 🙈' : ''}<span class="fa-solid fa-xmark bh-chip-x" data-act="remove" data-id="${esc(c.id)}" title="Remove"></span></span>`;
    }
    html += '</div>';
    html += renderMeters(body);
    html += renderMood(body);
    html += '</div>';

    if (effects.length) html += section('Status effects', effects.sort((a, b) => severityRank(b.severity) - severityRank(a.severity)).map(c => condRow(c, index)).join(''));
    if (mind.length) html += section('Mind', mind.map(c => condRow(c, index)).join(''));
    if (natural.length) html += section('Natural', natural.map(c => condRow(c, index)).join(''));

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
            const below = [...lost].filter(id => id !== c.part && isDescendant(index, id, c.part) && partShown(index.parts.get(id), { sex: currentSex(), features: currentFeatures() })).length;
            return condRow(c, index, below ? `includes ${below} part${below > 1 ? 's' : ''} below it` : '');
        }).join(''));
    }

    if (marks.length) html += section('Marks', marks.map(c => condRow(c, index)).join(''));
    html += renderClothing(body, index);

    if (!isAffected(body)) {
        html += '<div class="bh-empty">No conditions. Nothing is sent to the AI for this character.</div>';
    }

    const scan = opts.getSettings().detectMode !== 'off'
        ? '<div class="menu_button" data-act="scan" title="Ask the model to check the latest message for body changes"><i class="fa-solid fa-magnifying-glass"></i> Scan last message</div>'
        : '';
    html += `<div class="bh-actions">
        <div class="menu_button" data-act="add"><i class="fa-solid fa-plus"></i> Condition</div>
        <div class="menu_button" data-act="skip" title="Let time pass: wounds heal, states wear off"><i class="fa-solid fa-hourglass-half"></i> Time passes</div>
        ${scan}
    </div>`;
    html += renderLog(members, index);

    html += renderNotePreview();

    content.html(html);
    if (form && form.mode !== 'temp' && form.mode !== 'skip') updateFormFields();
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
            if (!partShown(p, { sex: currentSex(), features: currentFeatures() })) return;
            rows.push(`<div class="bh-zrow bh-zlink ${lost.has(id) ? 'bh-zmissing' : ''}" style="padding-left:${depth * 12}px" data-act="zoom" data-region="${esc(id)}">
                ${esc(p.name)} <i class="fa-solid fa-chevron-right"></i></div>`);
            return;
        }
        const conds = condsOn(id);
        if (!partShown(p, { sex: currentSex(), hideSensitive, features: currentFeatures() }) && !conds.length) return;
        const chipClass = c => c.kind === 'missing' ? 'missing' : c.kind === 'mark' ? 'mark' : c.severity;
        const chips = conds.map(c => `<span class="bh-zchip bh-sev-${esc(chipClass(c))}" data-act="edit" data-id="${esc(c.id)}">${esc(c.kind === 'missing' ? 'missing' : c.type)}</span>`).join('');
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
        const buttons = p.op.t === 'timeskip'
            ? `<div class="menu_button bh-small" data-act="skip-from" ${ref} title="See what this time skip would change">Preview</div>`
            : p.needsSide
            ? `<div class="menu_button bh-small" data-act="side" data-side="left" ${ref}>Left</div>
               <div class="menu_button bh-small" data-act="side" data-side="right" ${ref}>Right</div>`
            : `<div class="fa-solid fa-check bh-iconbtn" data-act="approve" ${ref} title="Apply"></div>
               ${p.op.t === 'add' ? `<div class="fa-solid fa-pen bh-iconbtn" data-act="review-edit" ${ref} title="Edit, then apply"></div>` : ''}`;
        const extra = p.op.t === 'add' && p.op.cond.effect ? `<div class="bh-cond-effect">${esc(p.op.cond.effect)}</div>` : '';
        return `<div class="bh-cond bh-pending">
            <div class="bh-cond-main">
                <div>${esc(p.summary)}</div>${extra}
                <div class="bh-cond-meta">from message #${p.index}${p.needsSide ? ' · which side?' : ''}${p.who && p.who !== selected && !p.npc ? ` · ${esc(name(p.who))}` : ''}</div>
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
            case 'wear': return op.item ? `wears ${op.item}` : `takes off (${op.slot})`;
            case 'mood': return `mood → ${op.label}${op.intensity === 'strong' ? ' (strong)' : ''}`;
            case 'meter': return `${op.id} → level ${op.level}`;
            default: return op.t;
        }
    };
    const rows = items.map(item => item.skip
        ? `<div class="bh-logrow">
            <span>Time skip: ${esc(formatDuration(item.days || 0))} (${item.ops.length} change${item.ops.length === 1 ? '' : 's'}) <small>(#${item.index})</small></span>
            <span class="fa-solid fa-rotate-left bh-iconbtn" data-act="undo-skip" data-skip="${esc(item.skip)}" title="Undo the whole time skip"></span>
        </div>`
        : `<div class="bh-logrow">
            <span>${esc(name(item.op.who))}: ${esc(describe(item.op))} <small>(#${item.index}${item.op.src === 'review' ? ', reviewed' : ''})</small></span>
            <span class="fa-solid fa-rotate-left bh-iconbtn" data-act="undo" data-index="${item.index}" data-oid="${esc(item.op.oid)}" title="Undo"></span>
        </div>`).join('');
    return `<details class="bh-log bh-section"><summary class="bh-section-title">Recent changes</summary>${rows}</details>`;
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

// "about 2 weeks until healed", from the time-skip rules.
function healingHint(c) {
    const d = daysToNextStage(c, opts.getSettings().realism);
    if (d === null) return null;
    const next = c.status === 'healing' ? 'until healed' : 'until it starts healing';
    return `~${formatDuration(Math.max(d, 1 / 24))} ${next}`;
}

// "ends in 2 replies from Seraphina", "~3 days left"
function durationHint(c) {
    const n = repliesLeft(c);
    if (n !== null) {
        const what = c.endThen === 'heal' ? 'next stage in' : 'ends in';
        return `${what} ${n} repl${n === 1 ? 'y' : 'ies'}${selected?.startsWith('n:') ? '' : ` from ${selectedMember()?.name || 'them'}`}`;
    }
    const d = daysLeft(c);
    return d === null ? null : `~${formatDuration(Math.max(d, 1 / 24))} left`;
}

function condRow(c, index, note = '') {
    const meta = [
        c.kind === 'injury' || !c.kind || c.kind?.startsWith('mind') ? cap(c.severity) : null,
        c.kind === 'effect' && c.severity ? INTENSITY_LABELS[c.severity] : null,
        c.kind === 'mark' ? (c.status === 'temporary' ? 'Temporary' : 'Permanent') : null,
        c.bleeding && c.bleeding !== 'none' ? `bleeding: ${c.bleeding}` : null,
        c.pain && c.pain !== 'none' ? `pain: ${c.pain}` : null,
        c.status && c.kind !== 'mark' ? cap(c.status) : null,
        healingHint(c),
        durationHint(c),
        c.kind === 'mind_current' ? 'current' : c.kind === 'mind_lasting' ? 'lasting' : null,
        c.since >= 0 ? `since #${c.since}` : 'before the chat',
        note || null,
    ].filter(Boolean).join(' · ');
    const title = c.kind === 'missing' ? partName(index, c.part)
        : c.kind?.startsWith('mind') || c.kind === 'effect' ? c.type
            : c.kind === 'natural' ? `${c.type}${c.stage ? ` (${c.stage.toLowerCase()})` : ''}`
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

function renderSkipForm(members) {
    const s = opts.getSettings();
    const sel = members.find(m => m.key === selected);
    const unitOpts = Object.keys(UNITS).map(u => `<option value="${u}" ${u === form.unit ? 'selected' : ''}>${u}</option>`).join('');
    let preview = '';
    if (form.plan) {
        const visible = form.plan.filter(x => x.group !== 'progress');
        const progress = form.plan.filter(x => x.group === 'progress');
        const groups = { worsen: 'Gets worse', heal: 'Healing', clear: 'Wears off' };
        preview = visible.length || progress.length
            ? Object.entries(groups).map(([g, title]) => {
                const items = visible.filter(x => x.group === g);
                if (!items.length) return '';
                return `<div class="bh-region">${title}</div>` + items.map(x => `
                    <label class="checkbox_label bh-skip-item"><input type="checkbox" data-change="${esc(x.id)}" ${form.off?.has(x.id) ? '' : 'checked'}> <span>${esc(x.summary)}</span></label>`).join('');
            }).join('') + (progress.length ? `<div class="bh-cond-meta">${progress.length} other wound${progress.length > 1 ? 's' : ''} move${progress.length > 1 ? '' : 's'} closer to healing.</div>` : '')
            : '<div class="bh-empty">Nothing would change in that time.</div>';
        preview = `<div class="bh-skip-preview">${preview}</div>`;
    }
    return `<div class="bh-form">
        <div class="bh-section-title">Time passes${form.origin ? ' (from the story)' : ''}</div>
        <div class="bh-row">
            <label>Amount <input id="bh_s_amount" class="text_pole" type="number" min="0.1" step="any" value="${esc(form.amount)}"></label>
            <label>Unit <select id="bh_s_unit" class="text_pole">${unitOpts}</select></label>
        </div>
        <label>Who <select id="bh_s_scope" class="text_pole">
            <option value="all" ${form.scope === 'all' ? 'selected' : ''}>Everyone in the scene</option>
            <option value="one" ${form.scope === 'one' ? 'selected' : ''}>Only ${esc(sel?.name || 'this character')}</option>
        </select></label>
        <div class="bh-cond-meta">Realism: ${esc(cap(s.realism))} (change it in the extension settings)</div>
        ${preview}
        <div class="bh-actions">
            <div class="menu_button" data-act="skip-preview">${form.plan ? 'Update preview' : 'Preview'}</div>
            ${form.plan && form.plan.length ? '<div class="menu_button" data-act="skip-apply">Apply</div>' : ''}
            ${form.plan && !form.plan.length && form.origin ? '<div class="menu_button" data-act="skip-dismiss" title="Nothing to change: mark this story time skip as handled">OK</div>' : ''}
            <div class="menu_button" data-act="cancel">Cancel</div>
        </div>
    </div>`;
}

function renderForm(body, index) {
    if (form.mode === 'skip') return renderSkipForm(getSceneMembers());
    if (form.mode === 'meter') return renderMeterForm(body);
    if (form.mode === 'mood') return renderMoodForm(body);
    if (form.mode === 'wear') return renderWearForm(body);
    if (form.mode === 'outfit-save') return renderOutfitSaveForm();
    if (form.mode === 'npc') {
        return `<div class="bh-form">
            <div class="bh-section-title">New NPC</div>
            <label>Name <input id="bh_n_name" class="text_pole" placeholder="e.g. The guard, Grey wolf"></label>
            <label>Body <select id="bh_n_sex" class="text_pole">${Object.entries(SEXES).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
            ${index.presets?.length ? `<label>Race <select id="bh_n_race" class="text_pole">${index.presets.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label>` : ''}
            <div class="bh-cond-meta">NPCs belong to this chat. They're in the AI's note while they're in the scene.</div>
            <div class="bh-actions">
                <div class="menu_button" data-act="npc-save">Add</div>
                <div class="menu_button" data-act="cancel">Cancel</div>
            </div>
        </div>`;
    }
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
    const base = c || { kind: 'injury', part: form.part || '', type: '', severity: 'moderate', bleeding: 'none', status: 'fresh', pain: '', effect: '', details: '', cause: '', hidden: false };
    const v = { ...base, ...(form.draft || {}) };
    if (!form.cat) {
        form.cat = categoryOf(base);
        form.sub = form.cat === 'body' ? bodySubOf(base) : form.cat === 'mind' ? (base.kind === 'mind_lasting' ? 'lasting' : 'current') : null;
        form.origKind = c?.kind || null;
    }
    const fill = field => `<span class="fa-solid fa-wand-magic-sparkles bh-fill" data-act="fill" data-field="${field}" title="Suggest this from the condition and the recent story"></span>`;
    const hideSensitive = opts.getSettings().hideSensitive;
    const partOpts = index.order
        .filter(id => partShown(index.parts.get(id), { sex: currentSex(), hideSensitive, features: currentFeatures() }) || id === v.part)
        .map(id => {
            const p = index.parts.get(id);
            return `<option value="${esc(id)}" ${id === v.part ? 'selected' : ''}>${'  '.repeat(p.depth)}${esc(p.name)}</option>`;
        }).join('');

    // Duration: stored as endReplies / endDays; the form shows a choice plus an amount.
    const ends = v.ends ?? (v.endReplies > 0 ? 'replies' : v.endDays > 0 ? 'time' : '');
    const unit = v.endUnit ?? (v.endDays > 0 && v.endDays < 1 ? 'hours' : v.endDays >= 7 && v.endDays % 7 === 0 ? 'weeks' : 'days');
    const amount = v.endN ?? (v.endReplies > 0 ? v.endReplies : v.endDays > 0 ? Math.round(v.endDays / END_UNITS[unit] * 100) / 100 : '');
    const who = getSceneMembers().find(m => m.key === (form.mode === 'review' ? form.who : selected));
    const repliesFrom = who?.npc ? 'AI replies' : `replies from ${who?.name || 'them'}`;
    const catButtons = Object.entries(CATEGORIES).map(([k, label]) => `<div class="menu_button bh-cat" data-act="cat" data-cat="${k}">${esc(label)}</div>`).join('');
    const subButtons = (cat, subs) => `<div class="bh-subs" data-for="${cat}">${Object.entries(subs).map(([k, label]) => `<div class="menu_button bh-small bh-sub" data-act="sub" data-sub="${k}">${esc(label)}</div>`).join('')}</div>`;

    return `<div class="bh-form" data-key="${form.key}">
        <div class="bh-section-title">${form.mode === 'review' ? 'Edit proposed change' : c ? 'Edit condition' : 'New condition'}</div>
        <div class="bh-cats">${catButtons}</div>
        ${subButtons('body', { part: 'On the body', missing: 'Missing part', natural: 'Natural' })}
        ${subButtons('mind', { current: 'Current (passes)', lasting: 'Lasting' })}
        <label class="bh-f-part"><span class="bh-f-part-label">Part</span> <select id="bh_f_part" class="text_pole"><option value="">— choose —</option>${partOpts}</select></label>
        <label class="bh-f-type">What ${fill('type')}<input id="bh_f_type" class="text_pole" list="bh_types" value="${esc(v.type)}" placeholder="e.g. Arrow wound"></label>
        <datalist id="bh_types"></datalist>
        <label class="bh-f-stage">Stage (optional) <input id="bh_f_stage" class="text_pole" list="bh_stages" value="${esc(v.stage || '')}" placeholder="e.g. Second trimester"></label>
        <datalist id="bh_stages"></datalist>
        <fieldset class="bh-progress">
            <legend>Progress</legend>
            <div class="bh-row">
                <label class="bh-f-sev"><span class="bh-f-sev-label">Severity</span> <select id="bh_f_sev" class="text_pole">${options(SEVERITIES, v.severity || 'moderate')}</select></label>
                <label class="bh-f-bleed">Bleeding <select id="bh_f_bleed" class="text_pole">${options(BLEEDING, v.bleeding || 'none')}</select></label>
                <label class="bh-f-status">Status <select id="bh_f_status" class="text_pole">${options(STATUSES, v.status || 'fresh')}</select></label>
            </div>
            <label class="bh-f-pain">Pain ${fill('pain')}<select id="bh_f_pain" class="text_pole"><option value="">— not set —</option>${options(PAIN_LEVELS, v.pain || '')}</select></label>
            <label class="bh-f-ends">Ends <select id="bh_f_ends" class="text_pole">
                <option value="" ${ends === '' ? 'selected' : ''}>Until removed</option>
                <option value="replies" ${ends === 'replies' ? 'selected' : ''}>After a number of replies (experimental)</option>
                <option value="time" ${ends === 'time' ? 'selected' : ''}>After a time (counted on time skips)</option>
            </select></label>
            <div class="bh-row bh-f-endrow">
                <label class="bh-f-endn">After <input id="bh_f_endn" class="text_pole" type="number" min="1" step="any" value="${esc(amount)}"></label>
                <label class="bh-f-endunit">Unit <select id="bh_f_endunit" class="text_pole">${options(Object.keys(END_UNITS), unit)}</select></label>
                <label class="bh-f-endwho"><span>&nbsp;</span><span class="bh-f-endwho-text">${esc(repliesFrom)}</span></label>
                <label class="bh-f-endthen">Then <select id="bh_f_endthen" class="text_pole">${options(['clear', 'heal'], v.endThen || 'heal', ['Clears', 'Heals a stage'])}</select></label>
            </div>
        </fieldset>
        <label class="bh-f-lasts">Lasts <select id="bh_f_lasts" class="text_pole">${options(Object.keys(MARK_DURATIONS), v.kind === 'mark' ? (v.lasts || v.status || 'permanent') : 'permanent', Object.values(MARK_DURATIONS))}</select></label>
        <label>Effect (what they can't do) ${fill('effect')}<input id="bh_f_effect" class="text_pole" value="${esc(v.effect)}" placeholder="e.g. Can't run; limps"></label>
        <label>Details ${fill('details')}<input id="bh_f_details" class="text_pole" value="${esc(v.details)}" placeholder="e.g. Arrowhead still lodged"></label>
        <label>Cause ${fill('cause')}<input id="bh_f_cause" class="text_pole" value="${esc(v.cause)}" placeholder="e.g. Bandit's arrow"></label>
        <label class="checkbox_label"><input id="bh_f_hidden" type="checkbox" ${v.hidden ? 'checked' : ''}> <span>Hidden from other characters</span></label>
        <div class="bh-actions">
            <div class="menu_button" data-act="save">${form.mode === 'review' ? 'Apply' : 'Save'}</div>
            <div class="menu_button" data-act="cancel">Cancel</div>
            ${form.mode === 'edit' ? `<div class="menu_button" data-act="remove" data-id="${esc(form.id)}" title="Remove this condition"><i class="fa-solid fa-trash-can"></i> Remove</div>` : ''}
            <div class="menu_button" data-act="fill" data-field="" title="Suggest every empty field (What included) from the recent story"><i class="fa-solid fa-wand-magic-sparkles"></i> Fill empty</div>
        </div>
    </div>`;
}

/** Natural states offered for the selected body (by sex). */
function naturalStates() {
    const sex = currentSex();
    return parseNaturalStates(opts.getSettings().naturalStates).filter(n => !n.sex || sex === 'unspecified' || n.sex === sex);
}

const isBodyStateName = type => BODY_STATES.some(t => t.toLowerCase() === String(type || '').trim().toLowerCase());

/** The stored kind for what the form currently shows. */
function formKind() {
    switch (form?.cat) {
        case 'mind': return form.sub === 'lasting' ? 'mind_lasting' : 'mind_current';
        case 'effect': return 'effect';
        case 'mark': return 'mark';
    }
    if (form?.sub === 'missing') return 'missing';
    if (form?.sub === 'natural') return 'natural';
    const part = $('#bh_f_part').val();
    if (!part || part === BODY_PART) return 'state';
    // A body state (wet, cold…) limited to an area stays a state; anything else on a part is an injury.
    return form?.origKind === 'state' || isBodyStateName($('#bh_f_type').val()) ? 'state' : 'injury';
}

// Shows only the fields that make sense for the chosen category.
function updateFormFields() {
    if (!form?.cat) return;
    const { cat, sub } = form;
    const kind = formKind();
    const onBody = cat === 'body' && sub === 'part';
    const isMissing = kind === 'missing';
    const isNatural = kind === 'natural';
    const isMark = kind === 'mark';
    const onPart = kind === 'injury' || (kind === 'state' && $('#bh_f_part').val());
    $('.bh-cat').each(function () { $(this).toggleClass('bh-active', this.getAttribute('data-cat') === cat); });
    $('.bh-subs').each(function () { $(this).toggle(this.getAttribute('data-for') === cat); });
    $('.bh-sub').each(function () { $(this).toggleClass('bh-active', this.getAttribute('data-sub') === sub); });

    $('.bh-f-part').toggle(onBody || isMissing || isMark);
    $('.bh-f-part-label').text(onBody ? 'Where' : 'Part');
    $('#bh_f_part option[value=""]').text(onBody ? 'Whole body' : '— choose —');
    $('.bh-f-type').toggle(!isMissing);
    $('.bh-f-stage').toggle(isNatural);
    $('.bh-progress').toggle(!isMark);
    $('.bh-f-lasts').toggle(isMark);
    $('.bh-f-sev').toggle(onBody || cat === 'mind' || cat === 'effect');
    $('.bh-f-sev-label').text(cat === 'effect' ? 'Intensity' : 'Severity');
    $('#bh_f_sev option').each(function () { this.textContent = cat === 'effect' ? INTENSITY_LABELS[this.value] : cap(this.value); });
    $('.bh-f-bleed').toggle(kind === 'injury');
    $('.bh-f-status').toggle(kind === 'injury' || isMissing);
    $('.bh-f-pain').toggle(cat !== 'mind' && !isMark);
    if (isMissing && form.mode === 'add' && !form.draft) $('#bh_f_status').val('permanent');

    // Wounds heal through time skips on their own, so "after a time" is for the rest.
    $('.bh-f-ends').toggle(!isMissing);
    $('#bh_f_ends option[value="time"]').toggle(kind !== 'injury');
    if (kind === 'injury' && $('#bh_f_ends').val() === 'time') $('#bh_f_ends').val('');
    const ends = isMissing ? '' : $('#bh_f_ends').val();
    $('.bh-f-endrow').toggle(!!ends);
    $('.bh-f-endunit').toggle(ends === 'time');
    $('.bh-f-endwho').toggle(ends === 'replies');
    $('.bh-f-endthen').toggle(ends === 'replies' && kind === 'injury');

    const naturals = naturalStates();
    const list = onBody ? (onPart ? [...INJURY_TYPES, ...BODY_STATES] : BODY_STATES)
        : isNatural ? naturals.map(n => n.name)
            : cat === 'mind' ? MIND_TYPES : cat === 'effect' ? EFFECT_TYPES : isMark ? MARK_TYPES : [];
    $('#bh_types').html(list.map(t => `<option value="${esc(t)}">`).join(''));
    $('#bh_f_type').attr('placeholder', { body: isNatural ? 'e.g. Period' : onPart ? 'e.g. Arrow wound' : 'e.g. Wet, Exhausted', mind: 'e.g. Panicked', effect: 'e.g. Poisoned', mark: 'e.g. Dragon tattoo' }[cat]);
    const type = String($('#bh_f_type').val() || '').trim().toLowerCase();
    const stages = naturals.find(n => n.name.toLowerCase() === type)?.stages || [];
    $('#bh_stages').html(stages.map(t => `<option value="${esc(t)}">`).join(''));
}

// Current form values without validation (for drafts and the fill buttons).
function rawForm() {
    return {
        kind: formKind(),
        part: $('#bh_f_part').val(),
        type: String($('#bh_f_type').val() ?? ''),
        stage: String($('#bh_f_stage').val() ?? ''),
        severity: $('#bh_f_sev').val(),
        bleeding: $('#bh_f_bleed').val(),
        status: $('#bh_f_status').val(),
        pain: $('#bh_f_pain').val() || '',
        ends: $('#bh_f_ends').val() || '',
        endN: String($('#bh_f_endn').val() ?? ''),
        endUnit: $('#bh_f_endunit').val(),
        endThen: $('#bh_f_endthen').val(),
        lasts: $('#bh_f_lasts').val(),
        effect: String($('#bh_f_effect').val() ?? ''),
        details: String($('#bh_f_details').val() ?? ''),
        cause: String($('#bh_f_cause').val() ?? ''),
        hidden: $('#bh_f_hidden').is(':checked'),
    };
}

/** The part a condition of this kind is stored on. */
function storedPart(kind, part) {
    if (kind === 'state') return part || BODY_PART;
    if (kind === 'mind_lasting' || kind === 'mind_current') return MIND_PART;
    if (kind === 'effect' || kind === 'natural') return BODY_PART;
    return part;
}

function readForm() {
    const r = rawForm();
    const kind = r.kind;
    const part = storedPart(kind, r.part);
    // Every field is written, so switching category doesn't leave stale values behind.
    let endReplies = null, endThen = null, endDays = null;
    const n = Number(r.endN);
    if (kind !== 'missing' && kind !== 'mark' && r.ends) {
        if (!(n > 0)) return { error: r.ends === 'replies' ? 'Enter after how many replies it ends.' : 'Enter after how long it ends.' };
        if (r.ends === 'replies') {
            endReplies = Math.max(1, Math.round(n));
            endThen = kind === 'injury' ? r.endThen : 'clear';
        } else if (kind !== 'injury') {
            endDays = n * (END_UNITS[r.endUnit] || 1);
        }
    }
    const cond = {
        kind,
        part,
        type: kind === 'missing' ? 'Missing' : r.type.trim(),
        stage: kind === 'natural' ? r.stage.trim() : null,
        severity: kind === 'missing' || kind === 'mark' || kind === 'natural' ? null : r.severity,
        bleeding: kind === 'injury' ? r.bleeding : null,
        status: kind === 'injury' || kind === 'missing' ? r.status : kind === 'mark' ? r.lasts : null,
        pain: kind === 'mark' || kind.startsWith('mind') ? null : (r.pain || null),
        endReplies,
        endThen,
        endDays,
        effect: r.effect.trim(),
        details: r.details.trim(),
        cause: r.cause.trim(),
        hidden: r.hidden,
    };
    if ((kind === 'missing' || kind === 'mark') && !cond.part) return { error: 'Choose a body part.' };
    if (kind !== 'missing' && !cond.type) return { error: 'Describe what it is (the "What" field), or let ✨ suggest something.' };
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
        case 'approve': { const p = findPending(); if (p) await afterStore(resolvePending(pIndex, pid, opsFor(p, p.op))); return; }
        case 'side': { const p = findPending(); if (p) await afterStore(resolvePending(pIndex, pid, opsFor(p, withSide(p, $(this).attr('data-side')).op))); return; }
        case 'npc-new': form = { mode: 'npc', scroll: true }; render(); return;
        case 'edit-features': opts.editFeatures?.(); return;
        case 'edit-meters': opts.editMeters?.(); return;
        case 'meter': form = { mode: 'meter', id: $(this).attr('data-id'), scroll: true }; render(); return;
        case 'wear-new': form = { mode: 'wear', scroll: true }; render(); return;
        case 'wear-edit': form = { mode: 'wear', slot: $(this).attr('data-slot'), scroll: true }; render(); return;
        case 'wear-remove':
            await afterStore(writeManualOps([{ t: 'wear', who: selected, slot: $(this).attr('data-slot'), item: '' }]));
            return;
        case 'wear-save': {
            const slot = $('#bh_w_slot').val();
            const item = String($('#bh_w_item').val() || '').trim();
            if (!item) { toastr.warning('Name the item (or remove it with the trash button).'); return; }
            const ops = [{ t: 'wear', who: selected, slot, item, desc: String($('#bh_w_desc').val() || '').trim() }];
            if (form.slot && form.slot !== slot) ops.unshift({ t: 'wear', who: selected, slot: form.slot, item: '' });
            form = null;
            await afterStore(writeManualOps(ops));
            return;
        }
        case 'outfit-clear':
            await afterStore(writeManualOps([{ t: 'outfit', who: selected, items: {} }]));
            return;
        case 'outfit-wear': {
            const outfit = findOutfit($('#bh_outfit').val());
            if (!outfit) { toastr.info('Pick an outfit first.'); return; }
            await afterStore(writeManualOps([{ t: 'outfit', who: selected, items: cleanItems(outfit.items), outfit: outfit.name }]));
            return;
        }
        case 'outfit-delete': {
            const ref = String($('#bh_outfit').val() || '');
            const outfit = findOutfit(ref);
            if (!outfit) { toastr.info('Pick an outfit first.'); return; }
            const list = outfitList(ref.startsWith('lib:') ? 'lib' : 'own', false);
            list.splice(list.indexOf(outfit), 1);
            opts.saveSettings();
            toastr.info(`Outfit "${outfit.name}" deleted.`, 'Body HUD');
            render();
            return;
        }
        case 'outfit-save-form':
            if (!Object.keys(cleanItems(buildBodies().get(selected)?.clothes)).length) { toastr.info('Nothing is worn yet: add some items first.'); return; }
            form = { mode: 'outfit-save', scroll: true };
            render();
            return;
        case 'outfit-save': {
            const name = String($('#bh_o_name').val() || '').trim();
            if (!name) { toastr.warning('Give the outfit a name.'); return; }
            const shared = $('#bh_o_shared').is(':checked') || selectedMember()?.npc;
            const list = outfitList(shared ? 'lib' : 'own', true);
            const items = cleanItems(buildBodies().get(selected)?.clothes);
            const existing = list.find(o => o.name.toLowerCase() === name.toLowerCase());
            if (existing) existing.items = items; else list.push({ name, items });
            opts.saveSettings();
            form = null;
            toastr.success(`Outfit "${name}" saved${shared ? ' in the shared library' : ''}.`, 'Body HUD');
            render();
            return;
        }
        case 'mood': form = { mode: 'mood', intensity: buildBodies().get(selected)?.mood?.intensity || 'mild', scroll: true }; render(); return;
        case 'mood-intensity':
            form.intensity = $(this).attr('data-intensity');
            $('.bh-mood-int').each(function () { $(this).toggleClass('bh-active', this.getAttribute('data-intensity') === form.intensity); });
            return;
        case 'mood-set': {
            const label = $(this).attr('data-mood');
            const intensity = form?.intensity || 'mild';
            form = null;
            await afterStore(writeManualOps([{ t: 'mood', who: selected, label, intensity }]));
            return;
        }
        case 'meter-set': {
            const level = Number($(this).attr('data-level'));
            const meterId = $(this).attr('data-id');
            form = null;
            await afterStore(writeManualOps([{ t: 'meter', who: selected, id: meterId, level }]));
            return;
        }
        case 'npc-save': {
            const name = String($('#bh_n_name').val() || '').trim();
            if (!name) { toastr.warning('Give the NPC a name.'); return; }
            const key = npcKey(name);
            if (key === 'n:' || getSceneMembers().some(m => m.key === key || m.name.toLowerCase() === name.toLowerCase())) {
                toastr.warning('Someone with that name is already in the scene.');
                return;
            }
            form = null;
            selected = key;
            const preset = opts.getIndex()?.presets.find(p => p.id === $('#bh_n_race').val());
            await afterStore(writeManualOps([{ t: 'npc_add', who: key, name, sex: $('#bh_n_sex').val(), features: preset ? [...preset.features] : [] }]));
            return;
        }
        case 'npc-return':
            selected = $(this).attr('data-key');
            await afterStore(writeManualOps([{ t: 'npc_add', who: selected, name: $(this).attr('data-name') }]));
            return;
        case 'npc-leave': {
            const m = selectedMember();
            if (!m?.npc) return;
            selected = null;
            await afterStore(writeManualOps([{ t: 'npc_leave', who: m.key }]));
            toastr.info(`${m.name} left the scene. Their body is kept: bring them back from "Left the scene".`, 'Body HUD');
            return;
        }
        case 'reject': await afterStore(resolvePending(pIndex, pid, null)); return;
        case 'approve-all':
        case 'reject-all':
            await afterStore((async () => {
                for (const p of collectPending()) {
                    if (act === 'approve-all' && (p.needsSide || p.op.t === 'timeskip')) continue;
                    await resolvePending(p.index, p.pid, act === 'approve-all' ? opsFor(p, p.op) : null);
                }
            })());
            return;
        case 'review-edit': {
            const p = findPending();
            if (!p) return;
            selected = p.who;
            form = { mode: 'review', index: p.index, pid: p.pid, who: p.who, cond: p.op.cond, npc: p.npc, scroll: true };
            render();
            return;
        }
        case 'undo': await afterStore(undoOp(pIndex, $(this).attr('data-oid'))); return;
        case 'undo-skip': await afterStore(undoSkip($(this).attr('data-skip'))); return;
        case 'skip':
            form = { mode: 'skip', amount: 1, unit: 'days', scope: 'all', plan: null, off: new Set(), scroll: true };
            render();
            return;
        case 'skip-from': {
            const p = findPending();
            if (!p) return;
            form = { mode: 'skip', amount: p.op.days, unit: 'days', scope: 'all', plan: null, off: new Set(), origin: { index: p.index, pid: p.pid }, scroll: true };
            form.plan = planSkip();
            render();
            return;
        }
        case 'skip-preview':
            form.amount = $('#bh_s_amount').val();
            form.unit = $('#bh_s_unit').val();
            form.scope = $('#bh_s_scope').val();
            form.plan = planSkip();
            form.off = new Set();
            render();
            return;
        case 'skip-dismiss': {
            const origin = form.origin;
            form = null;
            await afterStore(resolvePending(origin.index, origin.pid, null));
            return;
        }
        case 'skip-apply': {
            const skipId = newId();
            const days = skipDays();
            const ops = form.plan.filter(x => !form.off.has(x.id)).map(x => ({ ...x.op, skip: skipId, skipDays: days }));
            const origin = form.origin;
            form = null;
            if (!ops.length) { render(); return; }
            await afterStore(origin ? resolvePending(origin.index, origin.pid, ops) : writeManualOps(ops, 'timeskip'));
            toastr.success(`Time skip applied: ${ops.length} change${ops.length === 1 ? '' : 's'}. Undo it under "Recent changes".`, 'Body HUD');
            return;
        }
        case 'scan': scanLatest(); return;
        case 'fill': await fillFields($(this).attr('data-field')); return;
        case 'cat': {
            const cat = $(this).attr('data-cat');
            if (form?.cat === cat) return;
            form.cat = cat;
            form.sub = cat === 'body' ? 'part' : cat === 'mind' ? 'current' : null;
            updateFormFields();
            return;
        }
        case 'sub':
            form.sub = $(this).attr('data-sub');
            updateFormFields();
            return;
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
                const form0 = form;
                const { index: i, pid: rpid, who, cond: orig } = form;
                form = null;
                await afterStore(resolvePending(i, rpid, opsFor(form0, { t: 'add', who, cond: { ...orig, ...cond } })));
                return;
            }
            const old = form.mode === 'edit' ? buildBodies().get(selected)?.conditions.get(form.id) : null;
            // A new duration starts counting from now.
            if (old && (old.endDays ?? null) !== cond.endDays && old.kind !== 'injury') cond.progress = 0;
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
    const kind = raw.kind;
    const painShown = kind !== 'mark' && !kind.startsWith('mind');
    if (field && field !== 'type' && kind !== 'missing' && !raw.type.trim()) {
        toastr.info('Fill in "What" first (✨ next to it suggests something), so there is something to describe.');
        return;
    }
    const targets = field ? [field] : [
        ...(kind !== 'missing' && !raw.type.trim() ? ['type'] : []),
        ...['effect', 'details', 'cause'].filter(f => !raw[f].trim()),
        ...(painShown && !raw.pain ? ['pain'] : []),
    ];
    if (!targets.length) { toastr.info('Nothing empty to fill.'); return; }
    const who = form?.mode === 'review' ? form.who : selected;
    const member = getSceneMembers().find(m => m.key === who);
    const part = storedPart(kind, raw.part);
    const partLabel = kind.startsWith('mind') ? 'mind' : part === BODY_PART ? 'whole body' : part ? partName(index, part) : 'any body part (pick one)';
    const category = form.cat === 'body' ? (form.sub === 'part' ? 'body' : form.sub) : form.cat;
    const myForm = form;
    $('.bh-fill, [data-act="fill"]').addClass('bh-working');
    try {
        const suggestion = await suggestFields({
            characterName: member?.name || 'Character',
            cond: { ...raw, type: kind === 'missing' ? 'Missing' : raw.type },
            partLabel,
            fields: targets,
            category,
        });
        if (form !== myForm) return;
        let filled = 0;
        for (const f of targets) {
            const val = String(suggestion?.[f] ?? '').trim();
            if (!val) continue;
            if (f === 'pain') {
                if (!PAIN_LEVELS.includes(val.toLowerCase())) continue;
                $('#bh_f_pain').val(val.toLowerCase());
            } else {
                $(`#bh_f_${f}`).val(val);
            }
            filled++;
        }
        if (targets.includes('type')) updateFormFields();
        if (!filled) toastr.warning('The model\'s answer was cut off or empty. Try again, or raise "Max reply tokens" in the settings.', 'Body HUD');
    } catch (e) {
        console.error('[Body HUD] fill failed', e);
        toastr.warning(describeFailure(e), 'Body HUD: suggestion failed', { timeOut: 10000 });
    } finally {
        $('.bh-fill, [data-act="fill"]').removeClass('bh-working');
    }
}

// ---------- time skips ----------

function skipDays() {
    return Math.max(0, Number(form.amount) || 0) * (UNITS[form.unit] || 1);
}

function planSkip() {
    const index = opts.getIndex();
    const members = getSceneMembers();
    const who = form.scope === 'one' ? [selected] : members.map(m => m.key);
    const nameOf = key => members.find(m => m.key === key)?.name || key;
    return planTimeSkip(buildBodies(), who, skipDays(), opts.getSettings().realism, nameOf, id => partName(index, id), {
        meters: meterContext(opts.getMeterDefs?.() || [], opts.getSettings().profiles),
    });
}

// ---------- body profile (sex / shape) ----------

function selectedMember() {
    return getSceneMembers().find(m => m.key === selected) || null;
}

/** Body features (horns, tail…) of the selected character. */
function currentFeatures() {
    const m = selectedMember();
    return m ? memberFeatures(m, opts.getSettings().profiles) : [];
}

// Race: a preset picks a set of features; the checkboxes fine-tune it.
function renderRace(m) {
    const index = opts.getIndex();
    if (!index?.features?.length) return '';
    const have = memberFeatures(m, opts.getSettings().profiles);
    const same = (a, b) => a.length === b.length && a.every(x => b.includes(x));
    const preset = index.presets.find(p => same(p.features, have));
    const presetOpts = index.presets.map(p => `<option value="${esc(p.id)}" ${preset?.id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')
        + `<option value="" ${preset ? '' : 'selected'}>Custom</option>`;
    const boxes = index.features.map(f => `<label class="bh-feature"><input type="checkbox" data-feature="${esc(f.id)}" ${have.includes(f.id) ? 'checked' : ''}> ${esc(f.name)}</label>`).join('');
    return `<div class="bh-profile bh-race">
        <span>Race</span>
        <select id="bh_p_race" class="text_pole">${presetOpts}</select>
        <span class="fa-solid fa-pen bh-iconbtn" data-act="edit-features" title="Make your own races and features"></span>
        <span class="bh-features">${boxes}</span>
    </div>`;
}

async function saveFeatures(features) {
    const m = selectedMember();
    if (!m) return;
    if (m.npc) {
        await writeManualOps([{ t: 'npc_update', who: m.key, changes: { features } }]);
    } else {
        const s = opts.getSettings();
        s.profiles = s.profiles || {};
        s.profiles[profileKey(m)] = { ...(s.profiles[profileKey(m)] || {}), features };
        opts.saveSettings();
    }
    zoom = null;
    render();
}

/** The selected character's body sex: saved choice or a guess from their description. */
function currentSex() {
    const m = selectedMember();
    return m ? memberSex(m, opts.getSettings().profiles).sex : 'unspecified';
}

function renderProfile(members) {
    const m = members.find(x => x.key === selected);
    if (!m) return '';
    const { sex, guessed } = memberSex(m, opts.getSettings().profiles);
    const choices = Object.entries(SEXES).map(([k, label]) => `<option value="${k}" ${k === sex ? 'selected' : ''}>${label}</option>`).join('');
    const where = m.npc ? 'NPC, saved in this chat' : `saved for this ${m.isUser ? 'persona' : 'character'} in every chat`;
    return `<div class="bh-profile" title="Sets the mannequin's shape and which sex-specific parts are listed (${where}).">
        <span>Body</span>
        <select id="bh_p_sex" class="text_pole">${choices}</select>
        ${guessed ? '<small class="bh-guess">guessed from the description</small>' : ''}
        ${m.npc ? '<span class="bh-link bh-leave" data-act="npc-leave" title="Takes them out of the scene and the AI\'s note; their body is kept">Leaves the scene</span>' : ''}
    </div>${renderRace(m)}${renderMeterPicker(m)}`;
}

// ---------- meters ----------

/** Meter ids the selected character uses. */
function currentMeters() {
    const m = selectedMember();
    return m ? memberMeters(m, opts.getSettings().profiles, opts.getMeterDefs?.() || []) : [];
}

async function saveMeters(meters) {
    const m = selectedMember();
    if (!m) return;
    if (m.npc) {
        await writeManualOps([{ t: 'npc_update', who: m.key, changes: { meters } }]);
    } else {
        const s = opts.getSettings();
        s.profiles = s.profiles || {};
        s.profiles[profileKey(m)] = { ...(s.profiles[profileKey(m)] || {}), meters };
        opts.saveSettings();
    }
    render();
    opts.onStateChange?.();
}

// Which meters this character has (mana only for casters…).
function renderMeterPicker(m) {
    const defs = opts.getMeterDefs?.() || [];
    if (!defs.length) return '';
    const have = memberMeters(m, opts.getSettings().profiles, defs);
    const boxes = defs.map(d => `<label class="bh-feature bh-meter-pick"><input type="checkbox" data-meter="${esc(d.id)}" ${have.includes(d.id) ? 'checked' : ''}> ${esc(d.name)}</label>`).join('');
    return `<div class="bh-profile bh-race">
        <span>Meters</span>
        <span class="fa-solid fa-pen bh-iconbtn" data-act="edit-meters" title="Edit meters and their levels"></span>
        <span class="bh-features">${boxes}</span>
    </div>`;
}

// A small bar per meter: full = comfortable, empty = worst level.
function renderMeters(body) {
    const meters = activeMeters(opts.getMeterDefs?.() || [], currentMeters());
    if (!meters.length) return '';
    const rows = meters.map(def => {
        const level = meterLevel(body, def.id, def);
        const ratio = meterRatio(def, level);
        const steps = def.levels.length - 1;
        const tone = level === 0 ? 'ok' : ratio <= 0.34 ? 'minor' : ratio <= 0.67 ? 'moderate' : 'severe';
        const segs = Array.from({ length: steps }, (_, i) => `<span class="bh-seg ${i < steps - level ? 'bh-seg-on' : ''}"></span>`).join('');
        const l = def.levels[level];
        return `<div class="bh-meter bh-tone-${tone}" data-act="meter" data-id="${esc(def.id)}" title="${esc(`${def.name}: ${l.name}${l.effect ? ' — ' + l.effect : ''}. Click to change.`)}">
            <span class="bh-meter-name">${esc(def.name)}</span>
            <span class="bh-meter-bar">${segs}</span>
            <span class="bh-meter-level">${esc(l.name)}</span>
        </div>`;
    }).join('');
    return `<div class="bh-meters">${rows}</div>`;
}

// ---------- clothing ----------

/** The selected character's own outfits ('own') or the shared library ('lib'). */
function outfitList(which, create) {
    const s = opts.getSettings();
    if (which === 'lib') {
        if (!s.outfitLibrary && create) s.outfitLibrary = [];
        return s.outfitLibrary || [];
    }
    const m = selectedMember();
    if (!m || m.npc) return [];
    s.profiles = s.profiles || {};
    const key = profileKey(m);
    if (!s.profiles[key]?.outfits && create) s.profiles[key] = { ...(s.profiles[key] || {}), outfits: [] };
    return s.profiles[key]?.outfits || [];
}

function findOutfit(ref) {
    const [which, i] = String(ref || '').split(':');
    return which === 'own' || which === 'lib' ? outfitList(which, false)[Number(i)] || null : null;
}

function renderClothing(body, index) {
    const clothes = body.clothes || {};
    const missing = missingParts(body, index);
    const worn = SLOTS.filter(s => clothes[s.id]);
    const rows = worn.map(s => `<div class="bh-cloth">
        <span class="bh-cloth-slot">${esc(s.name)}</span>
        <span class="bh-cloth-item">${esc(clothes[s.id].item)}${clothes[s.id].desc ? ` <small>— ${esc(clothes[s.id].desc)}</small>` : ''}${slotWearable(s, missing) ? '' : ' <small title="That part is missing, so this is left out of the note">(missing part)</small>'}</span>
        <span class="fa-solid fa-pen bh-iconbtn" data-act="wear-edit" data-slot="${s.id}" title="Edit"></span>
        <span class="fa-solid fa-trash-can bh-iconbtn" data-act="wear-remove" data-slot="${s.id}" title="Take off"></span>
    </div>`).join('');
    const m = selectedMember();
    const own = outfitList('own', false);
    const lib = outfitList('lib', false);
    const optsHtml = (list, which) => list.map((o, i) => `<option value="${which}:${i}">${esc(o.name)}</option>`).join('');
    const picker = own.length || lib.length
        ? `<select id="bh_outfit" class="text_pole"><option value="">— outfit —</option>
            ${own.length ? `<optgroup label="${esc(m?.name || '')}'s outfits">${optsHtml(own, 'own')}</optgroup>` : ''}
            ${lib.length ? `<optgroup label="Shared library">${optsHtml(lib, 'lib')}</optgroup>` : ''}
           </select>
           <div class="menu_button bh-small" data-act="outfit-wear" title="Put this outfit on (replaces what's worn)">Wear</div>
           <div class="fa-solid fa-trash-can bh-iconbtn" data-act="outfit-delete" title="Delete this saved outfit"></div>`
        : '<span class="bh-cond-meta">No saved outfits yet.</span>';
    return `<details class="bh-clothing bh-section" ${opts.getSettings().clothesOpen ? 'open' : ''}>
        <summary class="bh-section-title">Clothing${worn.length ? ` (${worn.length})` : ''}</summary>
        ${rows || '<div class="bh-empty">Nothing recorded.</div>'}
        <div class="bh-outfits">${picker}</div>
        <div class="bh-cond-meta" title="SillyTavern swaps the placeholder for the current clothes when it sends the description; the card itself doesn't change.">Tip: write <code>{{outfit}}</code> in a character's description (or <code>{{user_outfit}}</code> in your persona) to put the current clothes there.</div>
        <div class="bh-actions">
            <div class="menu_button bh-small" data-act="wear-new"><i class="fa-solid fa-plus"></i> Item</div>
            <div class="menu_button bh-small" data-act="outfit-save-form" title="Save what's worn now as a named outfit">Save as outfit</div>
            ${worn.length ? '<div class="menu_button bh-small" data-act="outfit-clear" title="Remove every item">Take all off</div>' : ''}
        </div>
    </details>`;
}

function renderWearForm(body) {
    const cur = form.slot ? body.clothes?.[form.slot] : null;
    const slotId = form.slot || SLOTS.find(s => !body.clothes?.[s.id])?.id || SLOTS[0].id;
    const slot = SLOTS.find(s => s.id === slotId);
    return `<div class="bh-form">
        <div class="bh-section-title">${cur ? 'Edit item' : 'Add an item'}</div>
        <label>Slot <select id="bh_w_slot" class="text_pole">${SLOTS.map(s => `<option value="${s.id}" ${s.id === slotId ? 'selected' : ''}>${esc(s.name)}${body.clothes?.[s.id] && s.id !== form.slot ? ' (replaces what\'s there)' : ''}</option>`).join('')}</select></label>
        <label>Item <input id="bh_w_item" class="text_pole" list="bh_w_items" value="${esc(cur?.item || '')}" placeholder="e.g. ${esc(slot.examples[0])}"></label>
        <datalist id="bh_w_items">${slot.examples.map(x => `<option value="${esc(x)}">`).join('')}</datalist>
        <label>Description (optional) <input id="bh_w_desc" class="text_pole" value="${esc(cur?.desc || '')}" placeholder="e.g. Black leather, worn at the heels"></label>
        <div class="bh-actions">
            <div class="menu_button" data-act="wear-save">Save</div>
            <div class="menu_button" data-act="cancel">Cancel</div>
        </div>
    </div>`;
}

function renderOutfitSaveForm() {
    const npc = selectedMember()?.npc;
    return `<div class="bh-form">
        <div class="bh-section-title">Save as outfit</div>
        <label>Name <input id="bh_o_name" class="text_pole" placeholder="e.g. Travelling clothes"></label>
        <label class="checkbox_label"><input id="bh_o_shared" type="checkbox" ${npc ? 'checked disabled' : ''}> <span>Put it in the shared library (any character can wear it)</span></label>
        <div class="bh-actions">
            <div class="menu_button" data-act="outfit-save">Save</div>
            <div class="menu_button" data-act="cancel">Cancel</div>
        </div>
    </div>`;
}

// "😊 Mood: happy", click for the picker.
function renderMood(body) {
    const m = body.mood;
    if (!m) return '<div class="bh-mood bh-chip-muted" data-act="mood" title="No particular mood. Click to set one.">😐 Mood: calm</div>';
    return `<div class="bh-mood" data-act="mood" title="Click to change">${MOOD_EMOJI[m.label] || ''} Mood: ${esc(moodWord(m.label))}${m.intensity === 'strong' ? ' <b>(strong)</b>' : ''}</div>`;
}

function renderMoodForm(body) {
    const current = body.mood?.label || 'neutral';
    const grid = MOODS.map(label => `<div class="menu_button bh-mood-opt ${label === current ? 'bh-active' : ''}" data-act="mood-set" data-mood="${label}" title="${esc(moodWord(label))}">${MOOD_EMOJI[label] || ''} ${esc(label === 'neutral' ? 'calm (none)' : label)}</div>`).join('');
    const int = ['mild', 'strong'].map(i => `<div class="menu_button bh-small bh-sub bh-mood-int ${form.intensity === i ? 'bh-active' : ''}" data-act="mood-intensity" data-intensity="${i}">${cap(i)}</div>`).join('');
    return `<div class="bh-form">
        <div class="bh-section-title">Mood</div>
        <div class="bh-subs">${int}</div>
        <div class="bh-mood-grid">${grid}</div>
        <div class="bh-cond-meta">The AI is told about strong moods, and mild ones that change behaviour (fear, anger, grief…).</div>
        <div class="bh-actions"><div class="menu_button" data-act="cancel">Cancel</div></div>
    </div>`;
}

// Quick picker: one button per level, with what it means.
function renderMeterForm(body) {
    const def = (opts.getMeterDefs?.() || []).find(d => d.id === form.id);
    if (!def) { form = null; return ''; }
    const current = meterLevel(body, def.id, def);
    const levels = def.levels.map((l, i) => `<div class="bh-level menu_button ${i === current ? 'bh-active' : ''}" data-act="meter-set" data-id="${esc(def.id)}" data-level="${i}">
        <b>${esc(l.name)}</b>${l.effect ? `<small>${esc(l.effect)}</small>` : '<small>Fine: nothing is sent to the AI</small>'}
    </div>`).join('');
    return `<div class="bh-form">
        <div class="bh-section-title">${esc(def.name)}</div>
        <div class="bh-levels">${levels}</div>
        <div class="bh-actions"><div class="menu_button" data-act="cancel">Cancel</div></div>
    </div>`;
}

// A proposal about a new NPC also brings that NPC into the scene.
function opsFor(p, op) {
    return p?.npc ? [{ t: 'npc_add', who: p.npc.who, name: p.npc.name }, op] : op;
}
