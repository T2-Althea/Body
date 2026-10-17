# Body HUD

A SillyTavern extension that keeps track of what has physically happened to the
characters in a scene (wounds, missing limbs, being soaked and freezing, exhaustion)
and will remind the AI with a short note before each reply.

**Status: early development (M2).** You record conditions by hand in the HUD, and
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
- Pick a character at the top, then **+ Condition** to add an injury, a missing
  part, a whole-body state (wet, cold, exhausted…), or a mental condition.
  **Temperature** sets body temperature.
- Changes are saved on the latest message. Deleting that message removes them;
  swiping between replies keeps them.

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
- Panel side (right or left), °C or °F, hide sensitive parts from the part list.
- Note: on/off; where it goes (in chat at a depth, default just above your latest
  message; or before or after the main prompt); sent as system, user or assistant;
  max length in tokens (default 200; the least important lines are cut first);
  temperature always or only when abnormal.

## Body templates
`templates/human.json` defines the parts tree. Parts marked `"sided": true` get
left and right copies automatically.
