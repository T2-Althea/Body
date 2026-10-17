# Body HUD

A SillyTavern extension that keeps track of what has physically happened to the
characters in a scene (wounds, missing limbs, being soaked and freezing, exhaustion)
and will remind the AI with a short note before each reply.

**Status: early development (M5).** You record conditions by hand in the HUD, and
a short status note is sent to the AI before each reply. Automatic detection comes
later. See `docs/concept.md` for the plan.

## Install
SillyTavern → Extensions → Install extension → paste this repository's URL.
Requires SillyTavern 1.19.0 or newer.

## Using it
- A small tab with a person icon sits on the edge of the screen. Click it to open
  the HUD in the empty space beside the chat. A red dot on the tab means someone
  in the scene has a condition.
- The HUD hides while SillyTavern's own panel on that side is open (the character
  list on the right; AI Response Configuration or World Info on the left) and
  comes back when it closes. On phones it opens over the chat.
- Pick a character at the top. The mannequin shows front and back; regions are
  tinted by their worst condition (yellow minor → dark red critical), missing parts
  are dashed. Hover a region for its conditions; click it to zoom into its parts,
  and press **+** next to any part to add a condition there.
- **+ Condition** adds anything on a body part (wounds, numbness, rashes,
  swelling…), a missing part, a whole-body state (wet, cold, exhausted…;
  optionally limited to an area like "left foot"), or a mental condition.
  **Temperature** sets body temperature.
- Changes you make by hand are saved on the latest message. Deleting that message
  removes them; swiping between replies keeps them.
- Detected changes belong to the exact reply they were read from: swipe to
  another reply and they go away, swipe back and they return. Regenerating a
  reply never shows the new attempt the wounds the old one caused. Editing a
  message drops what was read from the old text and checks the new text.
  Branches keep everything up to the branch point.

## Automatic detection
After each message that mentions something physical (wounds, blood, falling, cold,
wet, hunger…), a small separate request asks a model what changed. Messages without
such words are skipped, so most messages cost nothing.

- **Ask me** (default): proposals appear at the top of the HUD. Apply ✓, edit ✎
  then apply, or reject ✗. If the story doesn't say left or right, you pick.
- **Apply automatically**: changes apply straight away. **Recent automatic
  changes** in the HUD lists them, each with undo.
- **Only when I press Scan**: nothing runs on its own. **Scan last message** checks on demand.
- **Off.**

Changes are stored on the message that caused them: delete that message and
they go with it. Pick a cheap model for this under **Model** (any saved
Connection Profile), or leave it on the chat's model.

## ✨ Suggestions
In the condition form, ✨ next to Effect, Details or Cause asks the model to write
that field from what you've filled in plus the recent story. **Fill empty** fills
only the empty ones, so text you typed is kept.

## What the AI sees
Before each reply (including swipes and regenerations) the extension adds one
short note, for example:

```
[Body status — in effect right now]
User (user):
- Abdomen: stab wound, severe. Hidden: others don't know; it only shows in behavior.
Seraphina:
- Left thigh: arrow wound, moderate, arrowhead still in, moderate bleeding. Can't run; limps.
- Whole body: wet, cold; temperature 35.2 °C (low).
```

- Nothing is sent when nobody is affected.
- Worst conditions come first. Minor healing or scarred wounds with no effect are left out.
- Only the current note is ever in the prompt. It is replaced, not added, each time.
- The bottom of the HUD panel shows the exact text, with its approximate token count.
- Muted group members are left out.

## Settings (Extensions → Body HUD)
- Panel side (right or left), °C or °F, show or hide the mannequin, hide
  sensitive parts from the part list and zoomed views.
- Note: on/off; where it goes (in chat at a depth, default just above your latest
  message; or before or after the main prompt); sent as system, user or assistant;
  max length in tokens (default 200; the least important lines are cut first);
  temperature always or only when abnormal.
- Detection: mode, model (Connection Profile), max reply tokens (default 2000;
  reasoning models think before answering, so if detection or ✨ come back empty,
  raise it), check your own messages too, skip messages with no injury/state
  words, include the previous message for context.

## Body templates
`templates/human.json` defines the parts tree and the mannequin drawing. Parts
marked `"sided": true` get left and right copies automatically; so do mannequin
shapes, which are drawn once and mirrored.
