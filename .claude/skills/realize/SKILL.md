---
name: realize
description: Turn the user's rough edits into working code — pseudocode, half-written classes, imports of files that don't exist, config objects for types not yet written, calls to methods they just deleted. Use whenever the user has hand-edited files and wants them made real: "walk over my changes", "finish this", "make it work", "turn this into real code", "realize this". Also use proactively when you notice their edits reference a module, method, type, or shape that doesn't exist yet — sketching an API by calling it before writing it is this user's normal way of specifying work, not a mistake to point out.
---

# Realize

This user designs by sketching. They type the *shape* of what they want and leave it broken — a class with no import, a config object for a type that doesn't exist, an import of a file they haven't written yet, a call to a method they deleted a minute ago. The break is not carelessness. It is the spec, written in the fastest notation available.

Your job: make it real without changing what they meant.

## Read the whole picture before touching anything

Sketches are rarely self-contained — that's *why* they're broken. An edit in one file orphans a call site in another. Start from what they touched, then look at everything referencing it. The break usually spans the seam between two files, and fixing only the file they edited leaves the other half dangling.

## The load-bearing question

For each thing they removed, ask: **does the code still work without it?**

- **Still works** → they meant it. A comment, a helper, an option, a default value. Leave it gone. Do not restore it, do not "improve" it back in.
- **Doesn't work** → the removal was structural, not final. They tore out a wall to move it, not to leave a hole. Find where the behavior went and make the new structure carry it.

This distinction is the whole job. An example of each:

They delete `await renderer.init()` and add a `ready` event to the class. Init still has to happen — they changed *how you learn it finished*, not *whether it runs*. Restore the call in the new shape. Concluding "nothing calls init(), so init() is dead" follows the letter and betrays the intent.

They delete `camera.position.set(...)` from a boot file. It still renders. That's a decision about who owns framing. Leave it deleted.

## Call sites are the specification

When the sketch imports or calls something that doesn't exist, the usage *is* the design. Don't ask what the API should be — read it off the calls.

```ts
import { Level } from './level'                              // no such file
const level = new Level({ scene: { background: '#FAFAFA' } })
renderer.get().render(level.getScene(), camera.get())
```

That is a complete specification: a `Level` class, a constructor taking a config with `scene.background` as a color, and `getScene(): THREE.Scene`. Write exactly that. The config shape they typed is the config type — derive it, don't invent a richer one.

## Build the minimum that makes the sketch true

Resist adding surface they didn't ask for. Every extra method, flag, option, or convenience is something they now have to read and delete. If they wrote `.get()`, don't also ship `.isReady()`, `.dispose()`, and an options bag "for later." If they wanted it, they'd have called it — that's how they specify things.

Same for comments: match the density already in the file. A stripped header comment is feedback, not an accident.

## Fix style silently

Match the file's existing conventions — quote style, semicolons, arrow vs `function`, quoted vs bare keys. A sketch is typed fast and formatting drift is noise, not intent. Normalize it and don't narrate it.

## Surface real forks in one line

Some breaks have more than one legitimate fix, and choosing silently means guessing at design. Name the fork in a sentence and keep moving — don't open an investigation.

> `EventEmitter<{ ready: void }>` doesn't satisfy `Record<string, unknown[]>` — either `{ ready: [] }` here, or relax the emitter to accept void payloads. Which?

A fork is when two answers are both defensible. A typo is not a fork — just fix it. The bar: would a reasonable engineer need to know the user's preference to pick? If not, pick.

## Check the project's own written rules

If the repo states conventions — `guideline.md`, `CLAUDE.md`, a pattern every sibling file follows — a sketch that violates one is usually an oversight from typing fast, not a rebellion. Restore it and say so in a clause.

`guideline.md` in this repo is the live one: it carries rules that were paid for in bugs (e.g. `THREE.Timer` has no max-delta, so `getDelta()` gets clamped at the call site; a dropped `Math.min(0.05, ...)` is a regression, not a simplification).

If they remove the same rule-mandated thing deliberately and repeatedly, that's them changing the rule. Ask.

## What "real" means before you're done

- **Resolves** — every import points at a file that exists and exports that name.
- **Typechecks** — generics satisfy their constraints; no calls to methods that no longer exist.
- **Runs** — nothing orphaned. If a value is constructed, something initializes it. If an event is subscribed, something emits it. If a scene is rendered, something builds it.
- **Nothing silently swallowed** — a sketch often drops error paths; don't cement that by adding a fallback that hides the failure. This codebase's stated preference is to validate at fill time and fail loudly rather than fall back.

Verification cadence is the user's call, not yours. Get it right by reading, and run checks when asked or when handing off — not reflexively after each edit.

## Report back

Lead with what you made real, in a sentence. Then the decisions that weren't mechanical — especially anything you *restored*, because that's exactly where you overrode them and they need the chance to say no. Then at most one open fork.

Keep it short. They're iterating fast and want the code plus the two things worth arguing about.
