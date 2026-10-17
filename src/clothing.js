// Clothing and accessories, no pictures. Pure: no SillyTavern access.
//
// A slot holds a list of items (a blouse under a bodice, two rings). What
// someone wears is set by ops replayed from the chat like everything else:
//   { t: 'wear', slot, item, desc, add: true, was? }  put on (or update the item
//       named `was`, or one with the same name); without `add` (old records) it
//       replaces the whole slot, and an empty item clears it
//   { t: 'unwear', slot, item? }   take off one item, or the whole slot
//   { t: 'outfit', items }         replace everything
// Named outfits are saved per character and in a shared library (extension settings).

// `part` ties a slot to the body: a slot whose part is entirely missing is left
// out of the note (no shoes on a missing foot). `-` = left_/right_ pair.
export const SLOTS = [
    { id: 'head', name: 'Head', part: 'head', examples: ['Hood', 'Hat', 'Helmet', 'Hair ribbon', 'Circlet'] },
    { id: 'ears', name: 'Ears', part: '-ear', examples: ['Earrings', 'Ear cuffs'] },
    { id: 'face', name: 'Face / piercings', part: 'face', examples: ['Glasses', 'Mask', 'Veil', 'Nose ring', 'Lip piercing'] },
    { id: 'neck', name: 'Neck', part: 'neck', examples: ['Necklace', 'Scarf', 'Choker', 'Amulet'] },
    { id: 'top', name: 'Top', part: 'chest', examples: ['Shirt', 'Blouse', 'Tunic', 'Dress', 'Robe', 'Vest'] },
    { id: 'waist', name: 'Waist', part: 'abdomen', examples: ['Bodice', 'Corset', 'Belt', 'Sash', 'Obi'] },
    { id: 'outerwear', name: 'Outerwear', part: 'chest', examples: ['Cloak', 'Capelet', 'Cape', 'Coat', 'Jacket', 'Armor', 'Shawl'] },
    { id: 'back', name: 'Back', part: 'upper_back', examples: ['Backpack', 'Quiver', 'Sheathed sword', 'Satchel'] },
    { id: 'arms', name: 'Arms', part: '-arm', examples: ['Arm guards', 'Sleeves', 'Arm band'] },
    { id: 'wrists', name: 'Wrists', part: '-wrist', examples: ['Bracelet', 'Bracers', 'Watch'] },
    { id: 'hands', name: 'Hands', part: '-hand', examples: ['Gloves', 'Gauntlets'] },
    { id: 'fingers', name: 'Fingers', part: '-hand', examples: ['Ring', 'Signet ring'] },
    { id: 'underwear', name: 'Underwear', part: 'pelvis', examples: ['Underwear', 'Bra', 'Loincloth'] },
    { id: 'pants', name: 'Pants / skirt', part: 'pelvis', examples: ['Trousers', 'Skirt', 'Shorts', 'Leggings'] },
    { id: 'legwear', name: 'Legwear', part: '-leg', examples: ['Stockings', 'Socks', 'Tights'] },
    { id: 'leg_acc', name: 'Leg accessories', part: '-leg', examples: ['Garter', 'Knee guards', 'Anklet', 'Thigh holster'] },
    { id: 'shoes', name: 'Shoes', part: '-foot', examples: ['Boots', 'Sandals', 'Shoes', 'Heels'] },
];

const lc = s => (s ? s.charAt(0).toLowerCase() + s.slice(1) : '');
const clean = it => ({ item: String(it?.item ?? '').trim(), desc: String(it?.desc ?? '').trim() });
const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

/** Items in a slot as a list (old records stored a single { item, desc }). */
export function slotItems(clothes, slot) {
    const v = clothes?.[slot];
    return (Array.isArray(v) ? v : v ? [v] : []).map(clean).filter(it => it.item);
}

/** Cleans an items map ({ slot: [{ item, desc }] }), dropping empty and unknown slots. */
export function cleanItems(items) {
    const out = {};
    for (const s of SLOTS) {
        const list = slotItems(items, s.id);
        if (list.length) out[s.id] = list;
    }
    return out;
}

/** Applies a wear / unwear / outfit op; returns the new clothes map. */
export function applyClothesOp(clothes, op) {
    if (op.t === 'outfit') return cleanItems(op.items);
    if (!op.slot) return clothes || {};
    const next = cleanItems(clothes);
    let list = slotItems(next, op.slot);
    const item = clean(op);
    if (op.t === 'unwear') {
        list = op.item ? list.filter(it => !same(it.item, op.item)) : [];
    } else if (!op.add) {
        list = item.item ? [item] : [];
    } else if (item.item) {
        const i = list.findIndex(it => same(it.item, op.was ?? item.item));
        if (i >= 0) list[i] = item;
        else list.push(item);
        // A renamed item may now duplicate another one in the slot.
        list = list.filter((it, j) => j === list.indexOf(list.find(x => same(x.item, it.item))));
    }
    if (list.length) next[op.slot] = list;
    else delete next[op.slot];
    return next;
}

/** Whether a slot can be worn: its part (both sides for a pair) isn't entirely missing. */
export function slotWearable(slot, missing) {
    if (!slot.part || !missing) return true;
    if (slot.part.startsWith('-')) {
        const base = slot.part.slice(1);
        return !(missing.has('left_' + base) && missing.has('right_' + base));
    }
    return !missing.has(slot.part);
}

/** "white blouse (silk), leather boots" */
export function describeClothes(clothes, missing = null) {
    return SLOTS.filter(s => slotWearable(s, missing))
        .flatMap(s => slotItems(clothes, s.id))
        .map(it => `${lc(it.item)}${it.desc ? ` (${lc(it.desc)})` : ''}`)
        .join(', ');
}

/**
 * The "Wearing:" note line, or null.
 * @param {'always'|'recent'|'off'} mode recent = only for `recentWindow` messages after a change
 */
export function clothesNoteLine(body, { mode = 'recent', chatLength = 0, recentWindow = 10, missing = null } = {}) {
    if (mode === 'off' || !body?.clothes) return null;
    if (mode === 'recent' && !(chatLength - (body.clothesAt ?? -Infinity) <= recentWindow)) return null;
    const text = describeClothes(body.clothes, missing);
    if (!text) return null;
    return { prio: 8, text: `Wearing: ${text}.` };
}
