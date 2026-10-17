# Body HUD — project notes

SillyTavern UI extension that tracks characters' physical state (wounds, missing
parts, whole-body states, mind) and injects a short status note before each reply.
Full concept: `docs/concept.md`. SillyTavern facts and gotchas: `docs/m0-orientation.md`.

## Ground rules
- Target: latest SillyTavern release (1.19.0 at time of writing). Check behaviour
  in ST's source rather than relying on memory; the API moves.
- Repo root = extension root (installed from the GitHub URL). Plain ES modules,
  no build step. Access ST only via `SillyTavern.getContext()`.
- Body state is derived by replaying per-message records in `message.extra.body_hud`
  from the start of the chat. Never keep a separate "current state" that can
  drift from the chat. Records carry a fingerprint of their source message text
  (swipes inherit `extra`; see orientation doc §3).
- Manual edits are written to the latest message *and all its swipes* (so
  switching swipes doesn't undo them); with no messages they go to
  `chatMetadata.body_hud` as a baseline. The user's body key is `user`;
  characters are `c:<avatar filename>`.
- Code layout: `src/model.js` (pure: templates, ops, replay; unit-tested),
  `src/note.js` (pure: the AI's note; unit-tested), `src/mannequin.js` (pure: SVG
  figures, region status; unit-tested), `src/store.js` (chat read/write),
  `src/panel.js` (side panel UI), `index.js` (wiring, settings, injection).
- The side panel uses viewport units (`dvh`), not `%`: ST's mobile layout
  transforms `<html>`, which breaks `%`-based fixed positioning.
- A healthy character injects nothing. The note has a token budget.
- The fake backend (`dev/fake-llm.cjs`) answers detection/fill requests with
  canned JSON and logs them to `<log>.tasks`, separate from roleplay requests.
- Test changes end to end with the harness in `dev/` before pushing, plus
  `node --test tests/*.test.mjs`.

## Milestones
- [x] M0 Orientation: extension system, `message.extra` and swipes, injection.
- [x] M1 Data model and templates; manual editing in a list view (in the side panel).
- [x] M2 Injection: the status note (`src/note.js`, set on every state change and
      in the `bodyHudInterceptor` generate interceptor before each generation).
- [x] M3 Mannequin view (`src/mannequin.js`; shapes live in the template's
      `mannequin` block). Zoom = parts list per region with "+" per part.
      Also: "Injury" kind relabelled "On a body part"; states take an optional area.
- [x] M4 Automatic detection, review queue, undo, ✨ fill buttons.
      `src/detect.js` (pure: prefilter, prompt, JSON → proposals; unit-tested),
      `src/llm.js` (main model via generateRaw or a Connection Profile; JSON
      extraction), `src/runner.js` (event wiring, one request at a time; result
      dropped if its message changed meanwhile). Proposals live in
      `extra.body_hud.pending` on the source message; detected ops carry
      `src: 'detect'|'review'`, `fp` and `oid` (undo removes by oid). Detected ops
      go on the current swipe only; manual ops on all swipes. Greeting
      (`first_message`) is never auto-checked.
- [ ] M5 Swipe/branch handling: ignore detected ops/pending whose `fp` doesn't
      match the message text (edits, inherited swipes); clear them on regen.
- [ ] M6 Time skips and realism levels.
- [ ] M7 Template editor and NPC bodies.

## Extras (user requests, after M7)
- **Emotions / mood:** a Mood line per character with a quick picker (builds on
  "Mind: current state"). Auto source options: read SillyTavern's Expressions
  extension (28 labels; `/expression-last` returns a character's last one) or
  report mood from the M4 detection call. Note only includes strong/relevant moods.
- **Hunger / thirst:** stepped levels (e.g. fed → peckish → hungry → starving),
  no numbers. Set manually, by M4 detection (eating/drinking), or by M6 time
  skips (Grounded/Simulation only). In the note only when it matters.
- **Clothing & accessories (no visuals):** slots per character (head, ears,
  face/piercings, neck, top, outerwear, arms, wrists, hands, fingers, underwear,
  pants, legwear, leg accessories, shoes), item + short description; slots can
  attach to template parts. Named outfits per character, plus a shared outfit
  library usable across characters. One compact "Wearing:" line in the note
  only when relevant. Later ties: wet clothing → wet state, armor covers regions,
  missing parts can't wear items. M4 detection can propose clothing changes.
