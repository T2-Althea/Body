// The races & features editor: the user's own races (named sets of features)
// and features (a part attached to the body, optionally with a borrowed drawing).
// Saved in extension settings as { features: [...], presets: [...] }.

import { newId } from './model.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[ch]));

// Where a custom feature can attach (base template part ids).
const ATTACH = {
    head: 'Head', neck: 'Neck', chest: 'Chest', upper_back: 'Upper back', abdomen: 'Abdomen',
    lower_back: 'Lower back', pelvis: 'Pelvis', arm: 'Arm', hand: 'Hand', leg: 'Leg', foot: 'Foot',
};

let draft = null;   // { features, presets } being edited
let builtin = null; // templates/addons.json

export function openFeatureEditor({ getSettings, saveSettings, builtin: getBuiltin, onSaved }) {
    const { callGenericPopup, POPUP_TYPE, POPUP_RESULT } = SillyTavern.getContext();
    builtin = getBuiltin() || { features: [], presets: [] };
    draft = structuredClone(getSettings().customFeatures || { features: [], presets: [] });
    draft.features = draft.features || [];
    draft.presets = draft.presets || [];

    const root = document.createElement('div');
    root.className = 'bh-editor';
    root.addEventListener('click', e => onClick(e, root));
    renderEditor(root);

    callGenericPopup(root, POPUP_TYPE.CONFIRM, '', {
        okButton: 'Save',
        cancelButton: 'Cancel',
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        onClosing: popup => {
            if (popup.result !== POPUP_RESULT.AFFIRMATIVE) return true;
            readDom(root);
            const problem = validate();
            if (problem) {
                toastr.warning(problem, 'Body HUD');
                return false;
            }
            getSettings().customFeatures = draft;
            saveSettings();
            onSaved?.();
            toastr.success('Races and features saved.', 'Body HUD');
            return true;
        },
    });
}

function allFeatures() {
    return [...(builtin.features || []), ...draft.features.filter(f => f.name)];
}

function renderEditor(root) {
    const features = allFeatures();
    const featureBoxes = (preset) => features.map(f => `<label class="bh-feature"><input type="checkbox" data-pfeature="${esc(f.id)}" ${preset.features?.includes(f.id) ? 'checked' : ''}> ${esc(f.name)}</label>`).join('');

    const nameOf = id => features.find(f => f.id === id)?.name.toLowerCase() || id;
    const builtinRows = `<div class="bh-e-builtin">${(builtin.presets || []).map(p => `<div><b>${esc(p.name)}</b>: ${esc(p.features.length ? p.features.map(nameOf).join(', ') : 'no extra features')}</div>`).join('')}</div>`;
    const customRows = draft.presets.map((p, i) => `
        <div class="bh-e-row" data-preset="${i}">
            <input class="text_pole bh-e-pname" value="${esc(p.name)}" placeholder="Race name, e.g. Erune">
            <span class="bh-features">${featureBoxes(p)}</span>
            <span class="fa-solid fa-trash-can bh-iconbtn" data-e="del-preset" data-i="${i}" title="Delete"></span>
        </div>`).join('');

    const drawings = [['', 'No drawing (listed only)'], ...(builtin.features || []).map(f => [f.id, `Like ${f.name.toLowerCase()}`])];
    const featureRows = draft.features.map((f, i) => `
        <div class="bh-e-row bh-e-feature" data-feature="${i}">
            <label>Name <input class="text_pole bh-e-fname" value="${esc(f.name)}" placeholder="e.g. Antenna"></label>
            <label>Attached to <select class="text_pole bh-e-fparent">${Object.entries(ATTACH).map(([k, v]) => `<option value="${k}" ${f.parent === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
            <label class="checkbox_label"><input type="checkbox" class="bh-e-fsided" ${f.sided ? 'checked' : ''}> <span>Left and right</span></label>
            <label>Parts (comma-separated, optional) <input class="text_pole bh-e-fparts" value="${esc((f.parts || []).join(', '))}" placeholder="e.g. Base, Tip"></label>
            <label>Drawing <select class="text_pole bh-e-fdrawing">${drawings.map(([k, v]) => `<option value="${esc(k)}" ${f.drawing === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
            <span class="fa-solid fa-trash-can bh-iconbtn" data-e="del-feature" data-i="${i}" title="Delete"></span>
        </div>`).join('');

    root.innerHTML = `
        <h3>Races</h3>
        <p class="bh-e-help">A race is a set of features. Built-in races can't be changed, but you can add your own.</p>
        ${builtinRows}
        ${customRows}
        <div class="menu_button" data-e="add-preset"><i class="fa-solid fa-plus"></i> Add race</div>

        <h3>Your features</h3>
        <p class="bh-e-help">A feature adds a body part (with its own smaller parts) wherever you attach it. Borrow a drawing from a built-in feature to show it on the mannequin, or leave it as a listed part. Renaming a part later loses the conditions recorded on it.</p>
        ${featureRows || '<p class="bh-e-help"><i>None yet.</i></p>'}
        <div class="menu_button" data-e="add-feature"><i class="fa-solid fa-plus"></i> Add feature</div>

        <h3>Share</h3>
        <p class="bh-e-help">Copy this text to keep or share your races and features. Paste someone else's and press Load.</p>
        <textarea class="text_pole bh-e-json" rows="5">${esc(JSON.stringify(draft))}</textarea>
        <div class="menu_button" data-e="import"><i class="fa-solid fa-file-import"></i> Load from text</div>`;
}

// Reads every input back into the draft (before re-rendering or saving).
function readDom(root) {
    root.querySelectorAll('[data-feature]').forEach(row => {
        const f = draft.features[Number(row.getAttribute('data-feature'))];
        f.name = row.querySelector('.bh-e-fname').value.trim();
        f.parent = row.querySelector('.bh-e-fparent').value;
        f.sided = row.querySelector('.bh-e-fsided').checked;
        f.parts = row.querySelector('.bh-e-fparts').value.split(',').map(s => s.trim()).filter(Boolean);
        f.drawing = row.querySelector('.bh-e-fdrawing').value;
    });
    root.querySelectorAll('[data-preset]').forEach(row => {
        const p = draft.presets[Number(row.getAttribute('data-preset'))];
        p.name = row.querySelector('.bh-e-pname').value.trim();
        p.features = [...row.querySelectorAll('[data-pfeature]:checked')].map(b => b.getAttribute('data-pfeature'));
    });
}

function validate() {
    for (const f of draft.features) if (!f.name) return 'Every feature needs a name (or delete the empty one).';
    for (const p of draft.presets) if (!p.name) return 'Every race needs a name (or delete the empty one).';
    const names = draft.presets.map(p => p.name.toLowerCase()).concat((builtin.presets || []).map(p => p.name.toLowerCase()));
    if (new Set(names).size !== names.length) return 'Two races have the same name.';
    return null;
}

function onClick(e, root) {
    const btn = e.target.closest('[data-e]');
    if (!btn) return;
    readDom(root);
    const i = Number(btn.getAttribute('data-i'));
    switch (btn.getAttribute('data-e')) {
        case 'add-preset': draft.presets.push({ id: 'cp_' + newId(), name: '', features: [] }); break;
        case 'del-preset': draft.presets.splice(i, 1); break;
        case 'add-feature': draft.features.push({ id: 'c_' + newId(), name: '', parent: 'head', sided: false, parts: [], drawing: '' }); break;
        case 'del-feature': {
            const id = draft.features[i].id;
            draft.features.splice(i, 1);
            draft.presets.forEach(p => { p.features = (p.features || []).filter(x => x !== id); });
            break;
        }
        case 'import': {
            try {
                const data = JSON.parse(root.querySelector('.bh-e-json').value);
                if (!Array.isArray(data.features) || !Array.isArray(data.presets)) throw new Error('shape');
                draft = { features: data.features, presets: data.presets };
                toastr.info('Loaded. Press Save to keep it.', 'Body HUD');
            } catch {
                toastr.warning('That text isn\'t a saved set of races and features.', 'Body HUD');
                return;
            }
            break;
        }
    }
    renderEditor(root);
}
