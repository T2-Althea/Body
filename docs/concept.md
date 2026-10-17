# Body HUD — SillyTavern Extension (Concept)

## The problem
LLMs forget physical state within a few messages. A character takes an arrow to
the thigh, and ten messages later "she sprints across the courtyard." Wounds,
missing limbs, illness, exhaustion, being soaked and freezing: none of it survives
unless something keeps reminding the model.

## The idea in one sentence
A body-awareness HUD: every character in the scene has a body, the user sees it as
an interactive mannequin, and the AI sees it as a short, plain-text status note
injected before each reply.

The mannequin is for the user. The text note is for the AI. Same data, two views.

## Design principles
- **Awareness, not a game.** No HP bars, no numbers to grind. Severity is described
  in words (minor / moderate / severe / critical), and effects are described as
  what the character can and can't do.
- **Story first, not real life 2.0.** The tracker remembers what happened; it does not
  invent new problems. Nothing worsens, spreads, or gets infected on its own unless
  the user turns on that level of realism.
- **Constraints beat descriptions.** The AI follows "can't run; limps" far more
  reliably than "arrow wound in left thigh." Every condition carries a short
  effect line written as a capability limit.
- **Quiet when nothing is wrong.** A healthy character injects nothing at all.
- **The user always has the final word.** Anything the extension detects
  automatically can be reviewed, edited, or undone.

## What a body is

### Three zoom levels
1. **Body**: the full mannequin, front and back views. Shows regions and a few
   whole-body indicators.
2. **Region**: head, neck, chest, abdomen, pelvis/groin, upper back, lower back,
   each arm, hand, leg, foot. Clicking one zooms in.
3. **Part / organ**: inside a region. For example, the abdomen holds stomach, liver,
   intestines, kidneys, spleen; the head holds brain, eyes, ears, jaw, nose. Hands
   hold individual fingers.

Genitalia are part of the pelvis region, handled clinically like any other part.
The user can hide that region from the mannequin display without removing it
from tracking.

### Body templates
Each body is built from a template that defines its parts tree.
- A default human template ships with the extension.
- The user can create custom templates for non-human species: wings, tails, horns,
  extra limbs, different organs, prosthetics, or anything their setting needs.
- Templates are plain files the user can edit and share.

### Who gets a body
- The user's persona: one body.
- The AI character: one body.
- Group chats: one per character.
- Temporary NPCs ("the guard," "the wolf"): added on the fly from the panel, or
  suggested automatically when a named NPC gets hurt. They can be removed when they
  leave the scene.

## What gets tracked

### Conditions on parts
Each condition is attached to a specific part or organ and has:

| Field | Example |
|---|---|
| Type | Stab wound, arrow wound, burn, fracture, bruise, bite, frostbite, amputation |
| Severity | Minor / moderate / severe / critical |
| Details | "Arrowhead still lodged" |
| Bleeding | None / light / moderate / heavy |
| Status | Fresh → treated → healing → scarred / permanent |
| Effect | "Can't run; limps; pain when putting weight on it" |
| Cause | "Bandit's arrow, ambush on the north road" |
| Since | The message where it happened |
| Who knows | Hidden from other characters, or visible / known |

"Who knows" matters for roleplay: a character hiding a wound shouldn't have the
other character comment on it, but the AI still knows to make them wince.

### Missing parts
A missing part is greyed out on the mannequin, and all parts below it in the
tree are greyed out with it (no hand means no fingers). Its effect line is
permanent ("left hand missing; one-handed only").

### Whole-body states
Shown as small icons around the mannequin, not on a body part:
- Environmental: wet, cold, overheated, muddy, bloody.
- Physical: exhausted, hungry, thirsty, drunk, drugged, nauseous, in pain.
- **Body temperature**: a small number on the HUD (e.g. 38.9 °C), shown only when
  it matters (fever, hypothermia) or always, as the user prefers. Celsius or
  Fahrenheit in settings.

### Mind
Mind conditions attach to the brain, split into two kinds that should never be
confused:
- **Permanent conditions** (e.g. Alzheimer's, a phobia, a curse on the mind): stay
  until the user removes them. Each has an effect line ("forgets recent names;
  confused when tired").
- **Current mental state** (panicked, grieving, furious, dissociating): temporary,
  fades when the scene moves on.

A concussion is a wound on the brain, not a mental condition.

## How the AI sees it
Before each reply, the extension injects a compact note close to the end of the
prompt, where the AI pays the most attention:

```
[Body status — in effect right now]
Mira:
- Left thigh: arrow wound, arrowhead still in, moderate bleeding. Can't run; limps.
- Whole body: soaked from the rain, shivering (35.8 °C). Hands clumsy from the cold.
Aren (user):
- Left hand missing (old injury). One-handed only.
- Ribs, right side: bruised. Pain when twisting or lifting.
```

Rules for the note:
- Only characters in the current scene.
- Order: worst first. Trivial things (a scratch from three days ago) drop off.
- Permanent conditions shrink to one line.
- Hidden conditions are marked so the AI keeps them in the character's behavior
  without other characters noticing them.
- A hard length budget (default ~200 tokens) so it never crowds out the story.

## How the state gets updated
This is the hardest part of the whole extension, more than the visuals.

### Three ways, used together
1. **Automatic detection**: after each message, a small, cheap LLM call reads the
   new message and returns proposed changes as structured data ("add: Mira, left
   thigh, arrow wound, moderate, bleeding moderate"). The user picks which model
   runs it, so it can be a cheap one.
2. **Manual editing**: click any part on the mannequin to add, change, or remove a
   condition.
3. **Time skips**: a button (or detection) for "a week passes," which advances
   healing: fresh wounds become treated or healing, temporary states clear.

### Review modes
- **Ask me**: proposed changes show as a small notification to approve or reject.
- **Auto-apply**: changes apply immediately, with a visible log and one-click undo.

### Known traps the detector must avoid
- **Figurative language**: "my heart broke," "I'm dead tired," "that killed me."
  These aren't injuries.
- **Duplicates**: the same wound described again in a later message.
- **Left vs right**: when the story doesn't say, ask or mark it unknown instead
  of guessing.
- **Wrong character**: who got hurt, especially in group chats.
- **Hypotheticals and threats**: "I'll break your arm" isn't a broken arm.

### Swipes, edits, and branches
The body state must follow the chat. If the user swipes, regenerates, deletes, or
edits a message, the wounds from that message must disappear with it. Each change
is tied to the message that caused it, so going back in the chat restores the
earlier body.

## Realism levels
One setting that controls how much the extension does on its own:
- **Cinematic**: tracks what happened, nothing worsens on its own, healing is
  quick on time skips. Good for adventure RP.
- **Grounded** (default): wounds heal on realistic timescales across time skips,
  untreated bleeding is flagged in the note so the AI doesn't forget it.
- **Simulation**: untreated wounds can worsen and get infected, blood loss
  causes weakness. Opt-in only.

## The mannequin (user view)
- Front and back silhouette.
- Damaged regions tinted by severity; hover for a tooltip listing conditions.
- Click a region to zoom in to its parts and organs.
- Missing parts greyed out.
- Whole-body state icons and temperature around the figure.
- One tab or selector per character in the scene.
- A history list per character: what happened, when, and from which message.

## Out of scope for now
- Clothing, armor, and equipment (a natural later extension: "soaked" could come
  from clothing, armor could reduce wounds).
- Combat mechanics, dice, damage numbers.
- Medical treatment minigames.

## Open questions
- Should the AI ever be allowed to write body changes directly into its own reply
  (e.g. a hidden tag), instead of the separate detection call? Cheaper, but makes
  the roleplay model do bookkeeping, which can hurt the writing.
- How should NPC bodies be saved: per chat only, or reusable across chats?
- Should healing on time skips be automatic or only proposed?

## Possible milestones (if this becomes a CLAUDE.md)
- M0 Orientation: study SillyTavern's extension system, how chat messages store
  extra data (needed for swipe/branch handling), and prompt injection.
- M1 Data model and templates: the parts tree, conditions, the default human
  template. Manual editing in a simple list view (no mannequin yet).
- M2 Injection: the text note before each reply.
- M3 Mannequin: the visual view, zoom levels, tooltips.
- M4 Automatic detection with review queue and undo.
- M5 Swipe/branch handling.
- M6 Time skips and realism levels.
- M7 Custom templates editor and NPC bodies.
