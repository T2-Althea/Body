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
- [ ] M4 Automatic detection, review queue, undo. Also planned here (user request):
      ✨ buttons in the condition form that fill Effect/Details/Cause from the
      filled fields + recent chat, plus a "fill all empty" button; same model/
      Connection Profile picker as detection; never overwrite typed text.
- [ ] M5 Swipe/branch handling (fingerprints, regen clearing).
- [ ] M6 Time skips and realism levels.
- [ ] M7 Template editor and NPC bodies.
