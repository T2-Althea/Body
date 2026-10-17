# Body HUD

A SillyTavern extension that keeps track of what has physically happened to the
characters in a scene (wounds, missing limbs, being soaked and freezing, exhaustion)
and will remind the AI with a short note before each reply.

**Status: early development (M1).** You can open the HUD and record conditions by
hand. Nothing is sent to the AI yet (that's M2). See `docs/concept.md` for the plan.

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

## Settings (Extensions → Body HUD)
- Panel side (right or left), °C or °F, hide sensitive parts from the part list.
- Diagnostics → **Probe: inject a test note**: adds a one-line test note to every
  prompt (check it in the Prompt Itemizer). Temporary, until M2.

## Body templates
`templates/human.json` defines the parts tree. Parts marked `"sided": true` get
left and right copies automatically.
