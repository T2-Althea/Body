// The mannequin: front and back silhouettes built from the template's shapes,
// each region tinted by its worst condition. Pure apart from producing HTML.

import { SEVERITIES, missingParts, severityRank } from './model.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[ch]));

/** Mirrors an absolute-coordinate path (M/L/C/Q/Z) across the vertical centre line. */
export function mirrorPath(d, width = 100) {
    let isX = true;
    return d.replace(/[A-Za-z]|-?\d*\.?\d+/g, tok => {
        if (/[A-Za-z]/.test(tok)) { isX = true; return tok; }
        const out = isX ? String(Math.round((width - Number(tok)) * 100) / 100) : tok;
        isX = !isX;
        return out;
    });
}

/**
 * Resolves template shapes for one view into concrete region ids.
 * Sided shapes are drawn on the viewer's right: that's the character's left
 * from the front and their right from the back.
 */
export function viewShapes(mannequin, view, variant = null, features = []) {
    const width = Number(String(mannequin.viewBox || '0 0 100 215').split(/\s+/)[2]) || 100;
    const out = [];
    // A variant (e.g. "feminine") replaces the base shape of each region it draws.
    const overrides = new Map((mannequin.variants?.[variant]?.[view] || []).map(s => [s.region, s]));
    // Feature shapes only for bodies with that feature; "under" ones (wings) behind the body.
    const list = (mannequin[view] || []).filter(s => !s.addon || features.includes(s.addon));
    const ordered = [...list.filter(s => s.under), ...list.filter(s => !s.under)];
    for (const base of ordered) {
        const s = base.addon ? base : (overrides.get(base.region) || base);
        if (s.sided && s.keepRegion) {
            out.push({ region: s.region, d: s.d });
            out.push({ region: s.region, d: mirrorPath(s.d, width) });
            continue;
        }
        if (!s.sided) {
            out.push({ region: s.region, d: s.d });
            continue;
        }
        const drawnSide = view === 'front' ? 'left' : 'right';
        const otherSide = drawnSide === 'left' ? 'right' : 'left';
        out.push({ region: `${drawnSide}_${s.region}`, d: s.d });
        out.push({ region: `${otherSide}_${s.region}`, d: mirrorPath(s.d, width) });
    }
    return out;
}

/** Physical conditions shown on the mannequin (not mind or general states). */
const isPhysical = c => c.kind === 'injury' || c.kind === 'missing' || !c.kind;

/**
 * Per-region summary: worst severity, missing status, and the conditions inside.
 * @returns {Map<string, { worst: string|null, missing: boolean, partlyMissing: boolean, conds: object[] }>}
 */
export function regionStatus(body, index) {
    const map = new Map();
    const get = id => {
        if (!map.has(id)) map.set(id, { worst: null, missing: false, partlyMissing: false, conds: [] });
        return map.get(id);
    };
    if (!body) return map;
    const lost = missingParts(body, index);
    for (const id of lost) {
        const p = index.parts.get(id);
        if (!p) continue;
        if (p.region) get(id).missing = true;
        else if (p.regionId) get(p.regionId).partlyMissing = true;
    }
    for (const c of body.conditions.values()) {
        if (!isPhysical(c)) continue;
        const p = index.parts.get(c.part);
        if (!p) continue;
        const r = get(p.regionId || p.id);
        r.conds.push(c);
        if (c.kind === 'missing') continue;
        if (r.worst === null || severityRank(c.severity) > severityRank(r.worst)) r.worst = c.severity || SEVERITIES[0];
    }
    return map;
}

function tooltip(regionName, st, partName) {
    const lines = [regionName];
    if (st?.missing) lines.push('Missing');
    for (const c of st?.conds || []) {
        lines.push(c.kind === 'missing'
            ? `• ${partName(c.part)}: missing`
            : `• ${partName(c.part)}: ${c.type}${c.severity ? ` (${c.severity})` : ''}`);
    }
    if (lines.length === 1) lines.push('No conditions. Click to see its parts.');
    return lines.join('\n');
}

/** HTML for the front and back figures side by side. */
export function renderMannequin(mannequin, body, index, { selectedRegion = null, variant = null, features = [] } = {}) {
    if (!mannequin) return '';
    const status = regionStatus(body, index);
    const partName = id => index.parts.get(id)?.name || id;
    const figure = (view, label) => {
        const shapes = viewShapes(mannequin, view, variant, features).filter(s => index.parts.has(s.region));
        const paths = shapes.map(s => {
            const st = status.get(s.region);
            const cls = ['bh-m-region'];
            if (st?.missing) cls.push('bh-m-missing');
            else if (st?.worst) cls.push(`bh-m-${st.worst}`);
            if (st?.partlyMissing && !st.missing) cls.push('bh-m-partly');
            if (s.region === selectedRegion) cls.push('bh-m-selected');
            return `<path class="${cls.join(' ')}" data-region="${esc(s.region)}" d="${esc(s.d)}"><title>${esc(tooltip(partName(s.region), st, partName))}</title></path>`;
        }).join('');
        return `<figure class="bh-m-figure">
            <svg viewBox="${esc(mannequin.viewBox || '0 0 100 215')}" role="img" aria-label="${label} view">${paths}</svg>
            <figcaption>${label}</figcaption>
        </figure>`;
    };
    return `<div class="bh-mannequin">${figure('front', 'Front')}${figure('back', 'Back')}</div>`;
}
