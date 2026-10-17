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
- [x] M5 Swipe/branch handling. Detected ops/pending only count while their `fp`
      matches the message text (`isLive` in store.js); `pruneStale` clears the
      rest on MESSAGE_RECEIVED/SENT/EDITED; an edited message is re-checked. The
      generate interceptor skips the last message's detected ops for `swipe` (and
      `regenerate` of an AI message) so a replacement reply doesn't see wounds the
      replaced one caused. Branches copy messages (and their extra) but not chat
      metadata, so the no-messages baseline in chatMetadata doesn't carry over.
- [x] M6 Time skips and realism levels. `src/timeskip.js` (pure, unit-tested):
      stage durations by severity × realism speed; untreated ×2 (not cinematic);
      leftover days kept in `cond.progress` (reset by applyOp when status changes);
      simulation festers untreated moderate+ wounds, adds blood loss and fever.
      Panel "Time passes" form → preview with checkboxes → ops tagged `skip`/
      `skipDays` (manual: src 'timeskip' on all swipes; from the story: the
      detection `time_passes` proposal, written to its message as 'review').
      `undoSkip` removes a whole skip. Grounded+ flags untreated bleeding in the note.
- [x] Body profile + marks (between M6 and M7, user request): per-character/persona
      sex (Female/Male/Unspecified) saved in `settings.profiles` (`profileKey`),
      guessed from description pronouns until set. Drives the mannequin variant
      (`mannequin.variants.feminine`) and part filtering (`part.sex`, `partShown`).
      Template v2 adds nipples and sex-specific genital parts (sensitive, inherited).
      New kind `mark` (tattoo/paint/brand; status permanent|temporary; temporary
      fades in 3 days on time skips; one low-priority "Marks:" note line, optional).
- [x] M7 Template editor and NPC bodies.
      - [x] NPCs: ops `npc_add` / `npc_update` / `npc_leave` (body.npc = {name,
        present, sex, features}), keys `n:<slug>` (`npcKey`). Present NPCs are scene
        members (note, time skips, detection). Detection turns an unknown hurt
        character into a proposal with `npc` set; approving prepends `npc_add`.
      - [x] Race features (`templates/addons.json`): features add parts and shapes
        to one superset template (`withFeatures`, tagged `addon`); `partShown` and
        `viewShapes` hide what a body doesn't have. Presets = named feature sets.
        Per character/persona in `profiles[key].features`, per NPC in body.npc.
      - [x] Races & features editor (`src/editor.js`, ST popup): custom races and
        custom features ({id, name, parent, sided, parts, drawing} borrowing a
        built-in feature's shapes), share/import as JSON. Stored in
        `settings.customFeatures`; `customFeatureFile` + `mergeFeatureFiles` turn
        them into addons format; index.js `rebuildTemplate()` after saving.

## Extras (user requests, after M7)
- **Emotions / mood:** a Mood line per character with a quick picker (builds on
  "Mind: current state"). Auto source options: read SillyTavern's Expressions
  extension (28 labels; `/expression-last` returns a character's last one) or
  report mood from the M4 detection call. Note only includes strong/relevant moods.
- **Meters (hunger, thirst, mana, stamina, sleep…):** one generic feature.
  A meter = named stepped levels, each with a short effect line; shown as a small
  bar per character in the HUD, sent to the AI as words only, and only when not
  at the comfortable level. Per-character on/off (e.g. mana only for casters).
  Meter sets are editable JSON files like body templates, shipped presets:
  - Hunger: fed → peckish → hungry → starving. Thirst likewise.
  - Sleep: rested → tired → sleep-deprived → barely functioning.
  - Stamina (user's martial codex, COS-022): fresh → winded → tired → exhausted
    → spent. Optional "strain warning" state (tremor, numbness, or sudden calm
    before forcing a feat past one's limit); forcing a feat should lead detection
    to propose the injury it costs (torn muscle, cracked bone…).
  - Mana (user's mana codex, COS-001): full → drawn on → low → "the ring"
    (~5%: muffled hearing, tunnel vision, ringing = Depletion Threshold Warning)
    → depleted (Mana Sickness: paralysis, hallucinations, heavy nosebleed, then
    Depletion Coma, unwakeable until ~25% returns, 1–3 h in normal ambient).
    Separate state "Mana saturation" (dungeons: tingling extremities, headache,
    edge-of-vision disturbance, disorientation; risk of crystallization). The
    codex forbids figures in fiction, so the note uses words, never percentages.
  Moved by: manual, M4 detection (eating, casting, fighting, sleeping), and M6
  time skips (recovery/drift by realism level).
- **Clothing & accessories (no visuals):** slots per character (head, ears,
  face/piercings, neck, top, outerwear, arms, wrists, hands, fingers, underwear,
  pants, legwear, leg accessories, shoes), item + short description; slots can
  attach to template parts. Named outfits per character, plus a shared outfit
  library usable across characters. One compact "Wearing:" line in the note
  only when relevant. Later ties: wet clothing → wet state, armor covers regions,
  missing parts can't wear items. M4 detection can propose clothing changes.

## Condition form redesign (done, after M7; user request)
- Form picks a category first (`CATEGORIES`: Body / Mind / Status effect / Mark),
  then shows only its fields (`updateFormFields` in panel.js). Body has sub-tabs
  On the body / Missing part / Natural; Mind has Current / Lasting. Stored kinds
  are unchanged for old records (`categoryOf`, `bodySubOf` map them); new kinds
  `effect` (status effect, whole body, severity shown as Intensity Mild…
  Overwhelming) and `natural` (period, pregnancy…, optional `stage`, no
  severity/bleeding/status). Body "On the body": empty Where → `state`; a part →
  `injury`, unless the type is a BODY_STATES name or it was already a state.
- Progress block: severity, bleeding, status, `pain` (PAIN_LEVELS, optional), and
  Ends: `endReplies` (+ `endThen` 'clear'|'heal' for wounds) or `endDays` (not
  for wounds; time skips use `progress` towards it, `daysLeft`).
- Reply durations are derived in `replay(records, speakers)`: store.js
  `collectSpeakers` gives who wrote each message; a message counts before the ops
  recorded on it; counts only the affected body's own messages (NPCs: every
  non-user message). Changing `endReplies` restarts the count (`endCount`). The
  interceptor's skipDetectedAt also skips that message's count.
- Natural states list: `settings.naturalStates` text, "Name (female|male|any):
  stage, stage" (`parseNaturalStates`), filtered by the body's sex.
- ✨ What (`fields: ['type']`) invents a fitting condition; ✨ pain picks a level;
  "Fill empty" includes What and pain. `buildFillPrompt` asks only for the
  requested fields; the fake backend answers only those.
- e2e: `dev/e2e-form.cjs`; unit: `tests/conditions.test.mjs`.

## How we work (user's workflow)
- The user plays on their own SillyTavern; this repo is installed there from the
  GitHub URL. Work happens in the cloud sandbox: set up SillyTavern + the fake
  backend per `dev/README.md`, build, then verify with `dev/run-all.sh` (unit +
  every e2e) before pushing. Add an e2e script (or extend one) for new features.
- Look at real screenshots of the UI (the e2e scripts save them) and send the
  relevant ones to the user with each update; they like seeing results.
- Commit and push to the session's designated branch; the user updates the
  extension in SillyTavern and tests with their real model, then reports back.
  No PRs unless asked.
- Report plainly what changed, what was tested (counts), what couldn't be tested
  here (real model behaviour), and what to try. The user isn't a programmer:
  explain SillyTavern/LLM concepts briefly when they come up.
- Run servers in the foreground (run-all.sh does): background jobs get killed
  after ~2 h. The user's model is a reasoning model at times (DeepSeek thinking):
  keep background request token allowances generous.
