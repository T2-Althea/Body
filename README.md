# Body HUD

A SillyTavern extension that keeps track of what has physically happened to the
characters in a scene (wounds, missing limbs, being soaked and freezing, exhaustion)
and reminds the AI with a short note before each reply.

**Status: early development (M0).** This build has no body tracking yet. It only
contains a settings panel and diagnostics used to verify the SillyTavern
mechanisms the extension relies on. See `docs/concept.md` for the plan.

## Install
SillyTavern → Extensions → Install extension → paste this repository's URL.
Requires SillyTavern 1.19.0 or newer.

## Diagnostics in this build
- **Probe: inject a test note** (settings checkbox) adds a one-line note to every
  prompt. Open the Prompt Itemizer on a reply to see it.
- `/bodyhud-stamp` stores a marker on the last message. `/bodyhud-check` lists
  marked messages. Use them to see how markers behave when you swipe.
