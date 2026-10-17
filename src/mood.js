// Mood: one current emotion per character. Pure: no SillyTavern access.
//
// Labels are the 28 of SillyTavern's Expressions extension, so its classifier
// can feed this directly. The AI only hears about strong moods, or mild ones
// that matter for how a character acts (fear, anger, grief…).

export const MOODS = [
    'admiration', 'amusement', 'anger', 'annoyance', 'approval', 'caring', 'confusion', 'curiosity',
    'desire', 'disappointment', 'disapproval', 'disgust', 'embarrassment', 'excitement', 'fear',
    'gratitude', 'grief', 'joy', 'love', 'nervousness', 'optimism', 'pride', 'realization', 'relief',
    'remorse', 'sadness', 'surprise', 'neutral',
];

// How the note phrases each label.
const WORDS = {
    admiration: 'admiring', amusement: 'amused', anger: 'angry', annoyance: 'annoyed', approval: 'approving',
    caring: 'caring', confusion: 'confused', curiosity: 'curious', desire: 'full of desire',
    disappointment: 'disappointed', disapproval: 'disapproving', disgust: 'disgusted', embarrassment: 'embarrassed',
    excitement: 'excited', fear: 'afraid', gratitude: 'grateful', grief: 'grieving', joy: 'happy', love: 'loving',
    nervousness: 'nervous', optimism: 'hopeful', pride: 'proud', realization: 'struck by a realization',
    relief: 'relieved', remorse: 'remorseful', sadness: 'sad', surprise: 'surprised', neutral: 'calm',
};

// Mild moods that still change how a character behaves.
const RELEVANT = new Set(['anger', 'fear', 'grief', 'sadness', 'disgust', 'nervousness', 'embarrassment', 'remorse', 'desire']);

export const MOOD_EMOJI = {
    admiration: '🤩', amusement: '😄', anger: '😠', annoyance: '😒', approval: '👍', caring: '🤗', confusion: '😕',
    curiosity: '🤔', desire: '😍', disappointment: '😞', disapproval: '👎', disgust: '🤢', embarrassment: '😳',
    excitement: '🤗', fear: '😨', gratitude: '🙏', grief: '😭', joy: '😊', love: '🥰', nervousness: '😬',
    optimism: '🌤', pride: '😌', realization: '💡', relief: '😮‍💨', remorse: '😔', sadness: '😢', surprise: '😮', neutral: '😐',
};

export const moodWord = label => WORDS[label] || label;

/** Normalizes a label from a model or the Expressions extension; null if unknown. */
export function normalizeMood(raw) {
    const s = String(raw ?? '').trim().toLowerCase();
    if (MOODS.includes(s)) return s;
    const byWord = Object.entries(WORDS).find(([, w]) => w === s);
    return byWord ? byWord[0] : null;
}

/** Note line for a body's mood, or null when it isn't worth mentioning. */
export function moodNoteLine(mood) {
    if (!mood?.label || mood.label === 'neutral') return null;
    const strong = mood.intensity === 'strong';
    if (!strong && !RELEVANT.has(mood.label)) return null;
    return { prio: strong ? 42 : 30, text: `Mood: ${strong ? 'very ' : ''}${moodWord(mood.label)}.` };
}
