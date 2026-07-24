---
name: new-components
description: Add a components to the game inventory — bake its animations into one GLB and create the inventory entry. Use when asked to create/add/import a components or character ("create a components of X", "add X to the inventory", "new components X"). Sources are rigged GLBs with sibling FBX animations under resources/models.
---

# New model

Turns a raw source model into an inventory entry: `resources/models/<name>/` → `inventory/items/models/<id>/`.

## Locate the source — a gate, not a formality

`resources/models/<name>/index.glb` must exist. Match the requested name loosely against the folders there ("pilot zombie" → `pilot-zombie/`); if nothing matches confidently, list what's available and ask. Never bake a guess.

Inside a source folder:

- `index.glb` — the rigged model with its own textures
- `*.fbx` — one animation each; the basename is the clip name (`Zombie Walk.fbx` → clip `Zombie Walk`)
- `src/` — raw working files, ignore

## Make the entry

1. `id` = snake_case of the source folder name (`pilot-zombie` → `pilot_zombie`). Entry dir: `inventory/items/models/<id>/`.
2. Bake: `npx tsx inventory/scripts/bake-gltf.ts resources/models/<name> inventory/items/models/<id>/index.baked.glb` — normalizes the GLB and merges every sibling FBX into it in the entry dir (the FBX set becomes the model's entire clip list, printed at the end). `resources/` is the raw shelf; never write back into it.
3. Doc: `<id>.json` beside the GLB. The format is `inventory/schemas/model.schema.ts` — read it and follow it exactly, every time: only fields it declares, valid against it (`parseModelDeclaration` is the arbiter). Fill the required fields — `id`, `file` (doc-relative: `"index.baked.glb"`) — and leave tuning absent: no invented `dismember` or `animationProfile`. Those are authored by hand afterward.

## Report

The entry path and the clip names that went into the bake — that list is what the animation profile gets written against.
