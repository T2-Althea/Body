// Clothing and accessories: one item per slot, no pictures. Pure: no SillyTavern access.
//
// What someone wears is set by 'wear' (one slot) and 'outfit' (every slot at
// once) ops and replayed from the chat like everything else. Named outfits are
// saved per character and in a shared library (extension settings).

// `part` ties a slot to the body: a slot whose part is entirely missing is left
// out of the note (no shoes on a missing foot). `-` = left_/right_ pair.
export const SLOTS = [
    { id: 'head', name: 'Head', part: 'head', examples: ['Hood', 'Hat', 'Helmet', 'Hair ribbon', 'Circlet'] },
    { id: 'ears', name: 'Ears', part: '-ear', examples: ['Earrings', 'Ear cuffs'] },
    { id: 'face', name: 'Face / piercings', part: 'face', examples: ['Glasses', 'Mask', 'Veil', 'Nose ring', 'Lip piercing'] },
    { id: 'neck', name: 'Neck', part: 'neck', examples: ['Necklace', 'Scarf', 'Choker', 'Amulet'] },
    { id: 'top', name: 'Top', part: 'chest', examples: ['Shirt', 'Blouse', 'Tunic', 'Dress', 'Robe', 'Corset'] },
    { id: 'outerwear', name: 'Outerwear', part: 'chest', examples: ['Cloak', 'Coat', 'Jacket', 'Armor', 'Cape'] },
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

/** Cleans an items map ({ slot: { item, desc } }), dropping empty and unknown slots. */
export function cleanItems(items) {
    const out = {};
    for (const s of SLOTS) {
        const it = items?.[s.id];
        const item = String(it?.item ?? '').trim();
        if (item) out[s.id] = { item, desc: String(it?.desc ?? '').trim() };
    }
    return out;
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
    return SLOTS.filter(s => clothes?.[s.id] && slotWearable(s, missing))
        .map(s => `${lc(clothes[s.id].item)}${clothes[s.id].desc ? ` (${lc(clothes[s.id].desc)})` : ''}`)
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
