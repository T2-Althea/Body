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
- A healthy character injects nothing. The note has a token budget.
- Test changes end to end with the harness in `dev/` before pushing.

## Milestones
- [x] M0 Orientation: extension system, `message.extra` and swipes, injection.
- [ ] M1 Data model and templates; manual editing in a list view.
- [ ] M2 Injection: the status note.
- [ ] M3 Mannequin view.
- [ ] M4 Automatic detection, review queue, undo.
- [ ] M5 Swipe/branch handling (fingerprints, regen clearing).
- [ ] M6 Time skips and realism levels.
- [ ] M7 Template editor and NPC bodies.
