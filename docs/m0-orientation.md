# M0 — Orientation findings

Studied against **SillyTavern 1.19.0** (release branch, commit `06bde93`, 2026-09-14).
Every "verified" item below was confirmed by `dev/e2e-m0.cjs` running a real
SillyTavern server with a fake backend, not just by reading code.

## 1. Extension basics
- An extension is a folder with `manifest.json`, a JS entry (ES module) and
  optional CSS. Installing from a GitHub URL clones the repo, so **the repo root is
  the extension root**.
- User installs land in `data/<user>/extensions/<RepoName>/` and are served as
  `/scripts/extensions/third-party/<RepoName>/`. The folder name depends on the
  repo name, so the code reaches SillyTavern only through
  `SillyTavern.getContext()` and never through relative imports into ST's own files.
- Useful manifest fields: `display_name`, `loading_order`, `js`, `css`,
  `requires`, `optional`, `dependencies`, `minimum_client_version`, `auto_update`,
  `generate_interceptor` (name of a global function called before each
  generation with `(chat, contextSize, abort, type)`), `hooks` (`install`,
  `update`, `delete`, `enable`, `disable`, `activate`, each naming an exported
  function), `i18n`.
- Settings go in `extensionSettings[<key>]`, saved with `saveSettingsDebounced()`.
  The settings UI is appended to `#extensions_settings2` as an `inline-drawer`.
- Slash commands: `SlashCommandParser.addCommandObject(SlashCommand.fromProps({...}))`.
  **Verified.**

## 2. Prompt injection (the note the AI sees)
`setExtensionPrompt(key, text, position, depth, scan, role, filter)`
- position: `-1` none, `0` in prompt, `1` in chat at `depth`, `2` before prompt.
- role: `0` system, `1` user, `2` assistant.
- One slot per `key`; setting it again replaces it, and an empty string removes it.
- **Verified:** with position 1, depth 1 and role system, the note sits directly
  above the newest user message. It appears exactly once per request, never piles
  up across replies, and disappears from the very next request when cleared.
- Plan: recompute the note on `GENERATION_STARTED` / `CHAT_CHANGED` / after state
  changes. Depth and role will be user settings.

## 3. Per-message storage (swipes, edits, branches)
- Each chat message has `extra` (an object). Extensions can add their own key.
  It is saved with the chat and never sent to the model.
- Each swipe keeps its own copy in `swipe_info[i].extra`. SillyTavern copies
  `message.extra` into the current swipe before swiping away
  (`syncMesToSwipe`) and restores it when swiping back (`syncSwipeToMes`).
  **Verified:** swiping back to swipe 0 restores swipe 0's data.
- ⚠️ **Gotcha, verified:** when you swipe right to *generate* a new swipe, ST clears
  only its own known keys (`clearMessageData`), so **our data from the previous
  swipe is copied into the new swipe**. Without handling, the new reply would
  inherit wounds the old reply caused.
  → Fix for M5: every record stores a fingerprint of the message text it was
  derived from. On replay, records whose fingerprint doesn't match the current
  text are ignored. The same rule handles edited messages. As a second guard,
  clear our key on `GENERATION_STARTED` when `type === 'swipe'`.
- Deleting messages simply removes their `extra`. Branches (new chat file from a
  message) copy messages with their `extra` (verified in e2e-m5), but start with
  fresh chat metadata (`{ main_chat, integrity }`), so nothing stored only in
  `chatMetadata` survives a branch. So **rebuilding the body by
  replaying `extra` records from message 0 to the end** naturally follows
  delete, swipe, edit and branch. That is the core design decision for M1/M5.
- Relevant events: `MESSAGE_SENT`, `MESSAGE_RECEIVED`, `MESSAGE_EDITED`,
  `MESSAGE_UPDATED`, `MESSAGE_DELETED`, `MESSAGE_SWIPED`, `MESSAGE_SWIPE_DELETED`,
  `CHAT_CHANGED`, `CHAT_LOADED`, `GENERATION_STARTED`, `GENERATION_ENDED`,
  `GROUP_UPDATED`, `PERSONA_CHANGED`, `CHARACTER_MESSAGE_RENDERED`,
  `USER_MESSAGE_RENDERED`.
- Persist changes with `saveChat()`. Chat-wide data (NPC list, manual baseline
  edits) can go in `chatMetadata` + `saveMetadataDebounced()`.

## 4. Detection on a separate (cheap) model
- `ConnectionManagerRequestService.sendRequest(profileId, prompt, maxTokens, opts)`
  sends a one-off request through any saved **Connection Profile** (chat or text
  completion), independent of the model used for roleplay. It needs the built-in
  Connection Manager extension enabled.
- `ConnectionManagerRequestService.handleDropdown(selector, ...)` renders ST's own
  profile picker, so the settings panel can offer the same dropdown users know.
- Fallbacks: `generateRaw` / `generateQuietPrompt` use the current main model.
- Not exercised yet (M4).

## 5. Who is in the scene
- `name1` = user persona name, `name2` = current character name,
  `characterId`, `groupId`, `groups` (group members are avatar filenames),
  `characters`. Messages carry `name`, `is_user`, `is_system`.
- Per-character body identity should key on avatar filename (stable across
  renames), with the persona keyed on its avatar too.

## 6. Test harness (in `dev/`)
- `fake-llm.cjs`: OpenAI-compatible fake backend that logs every request.
- `configure-st.cjs`: points a local ST at it.
- `e2e-m0.cjs`: Playwright run of the checks above. Current result: **10/10 pass**.

See `dev/README.md` for how to run it.
