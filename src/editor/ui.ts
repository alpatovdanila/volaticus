// DOM panels. Pure view layer — all behavior arrives via callbacks from main.ts.
import { resolveTexturePath } from '../inventory/materials'
import type { Inventory, Item, ItemKind } from '../inventory/registry'

export const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector(sel) as T

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

// ---------------------------------------------------------------------------
// left panel: item list

export interface ListCallbacks {
  onSelect(kind: ItemKind, id: string): void
}

const CATEGORY_ORDER = ['prop', 'pickup', 'enemy', 'character', 'levelpart']

export function renderItemList(inv: Inventory, filter: string, selected: string | null, cb: ListCallbacks): void {
  const list = $('#item-list')
  list.innerHTML = ''
  const match = (id: string, name?: string) =>
    !filter || id.includes(filter.toLowerCase()) || (name ?? '').toLowerCase().includes(filter.toLowerCase())

  const section = (title: string) => {
    const h = el('div', 'list-section', title)
    list.appendChild(h)
  }
  const row = (kind: ItemKind, item: Item<unknown>, label: string) => {
    const r = el('div', 'list-item' + (selected === kind + ':' + item.id ? ' selected' : ''))
    r.appendChild(el('span', 'list-label', label))
    if (item.issues.length) {
      const dot = el('span', 'issue-dot', '●')
      dot.title = item.issues.join('\n')
      r.appendChild(dot)
    }
    r.onclick = () => cb.onSelect(kind, item.id)
    list.appendChild(r)
  }

  for (const cat of CATEGORY_ORDER) {
    const items = [...inv.entities.values()]
      .filter((i) => (i.doc?.category ?? 'prop') === cat && match(i.id, i.doc?.name))
      .sort((a, b) => a.id.localeCompare(b.id))
    if (!items.length) continue
    section(cat + 's')
    for (const i of items) row('entity', i, i.doc?.name ?? i.id)
  }
  const effects = [...inv.effects.values()].filter((i) => match(i.id, i.doc?.name)).sort((a, b) => a.id.localeCompare(b.id))
  if (effects.length) {
    section('effects')
    for (const i of effects) row('effect', i, i.doc?.name ?? i.id)
  }
  const sfx = [...inv.sfx.values()].filter((i) => match(i.id)).sort((a, b) => a.id.localeCompare(b.id))
  if (sfx.length) {
    section('sfx')
    for (const i of sfx) row('sfx', i, i.id)
  }
}

// ---------------------------------------------------------------------------
// right panel: material slots + texture browser

// per-key override state for an inheriting slot (item 34): true = the key is
// set on THIS slot (an override → gets a ↺ reset), false = inherited (ghosted)
export type OverridableKey = 'material' | 'tint' | 'uvMode' | 'uvScale' | 'uvRot' | 'uvProject'

export interface SlotInfo {
  slot: string
  texture: string // catalog color-map path for the chip thumbnail (RESOLVED material)
  material: string // catalog material id (shown on the chip) — RESOLVED
  tint: string | null // '#rrggbb' multiplier or null (white/off) — RESOLVED
  uvMode: 'tile' | 'fit' | 'stretch'
  uvScale: number
  uvRot: number // degrees (item 35: any angle; the dropdown offers 15° steps)
  uvProject: '' | 'box' | 'planar' | 'sphere' // per-slot projection override ('' = material/authored)
  // geometry generation for this part (null = no shaped nodes → row hidden).
  // craft/sub are the part's stored values; has = generated geometry.
  gen: { craft: number | null; sub: number | null; has: boolean } | null
  // item 34: persisted inheritance ------------------------------------------
  inherit: string | null // raw inherit target (null = standalone slot)
  lastInherit: string | null // former parent (pre-freeze) — re-check re-binds to it
  own: Record<OverridableKey, boolean> // which keys are set on THIS slot (overrides)
  inheritOptions: string[] // legal parent choices (cycle-free, not self)
  depth: number // indent level in the inherit tree (chip list grouping)
  groupParent: boolean // has inheriting children → collapse toggle
  groupKnob: boolean // no geometry references — a pure group knob (visually marked)
  collapsed: boolean // children currently hidden (state lives in main.ts)
  childCount: number // direct + nested children (collapsed label)
}

export interface FxTextureInfo {
  key: string // encoded pick key ("fx:<json path>")
  label: string // e.g. "fx · destroyed"
  texture?: string // resolved: explicit texture, or the inherited slot's texture
  tint?: string // resolved tint (explicit, or the inherited slot's) — thumbnail preview
  inheritSlot?: string // set when the effect inherits from a material slot
  uvRot: number // explicit-mode texture direction, degrees (15° dropdown steps)
}

export interface SlotCallbacks {
  onPick(key: string): void
  onParam(slot: string, param: 'uvMode' | 'uvRot' | 'uvScale' | 'tint' | 'uvProject', value: string): void
  // live tint while dragging the color picker — applies the color to the built
  // material directly (cheap, no rebuild). onParam still commits on 'change'.
  onTintLive(slot: string, value: string): void
  onFxInherit(key: string, slot: string | null): void
  onFxRot(key: string, deg: string): void
  onGenCraft(slot: string, value: number): void
  onGenSub(slot: string, value: number | null): void
  onRegen(slot: string): void
  onEditMaterial(slot: string): void // #14: right-click preview → edit the slot's material
  // item 34: inheritance row + per-key override resets + group collapse
  onInherit(slot: string, parent: string | null): void // check/uncheck + parent choice
  onResetParam(slot: string, param: OverridableKey): void // ↺ — delete the override key
  onToggleCollapse(slot: string): void
  onShowInPicker(slot: string): void // item 38: chip menu → reveal in the picker
}

// ---------------------------------------------------------------------------
// #24: the craft ("musher") controls live INLINE in the chip (below the apply
// options), as a vertical stack: the wide full-range slider + bound number
// input, the subdivide selector, and ⟲ regen. (#5: the quality presets and the
// UV-projection selector were removed — UV projection is a per-slot apply option
// on the chip itself.) No popup / fixed-positioned panel any more.

// #14: right-click a chip's material preview → a small context menu → "Edit
// material" opens the Material Manager focused on that slot's material.
function closeChipMenus(): void {
  for (const m of document.querySelectorAll('.chip-menu')) m.remove()
}
document.addEventListener('pointerdown', (e) => {
  if (!(e.target as Element | null)?.closest?.('.chip-menu')) closeChipMenus()
})
document.addEventListener('scroll', () => closeChipMenus(), true)

// generic item list — the chip preview offers Edit material + Show in picker
// (#38); a picker tile offers Edit material (#37).
function openChipMenu(x: number, y: number, items: { label: string; action(): void }[]): void {
  closeChipMenus()
  const menu = el('div', 'chip-menu')
  for (const it of items) {
    const b = el('button', 'chip-menu-item', it.label)
    b.onclick = (e) => {
      e.stopPropagation()
      closeChipMenus()
      it.action()
    }
    menu.appendChild(b)
  }
  document.body.appendChild(menu)
  const w = menu.offsetWidth
  const h = menu.offsetHeight
  const vw = Math.max(window.innerWidth, x + w + 8)
  const vh = Math.max(window.innerHeight, y + h + 8)
  menu.style.left = Math.max(8, Math.min(vw - w - 8, x)) + 'px'
  menu.style.top = Math.max(8, Math.min(vh - h - 8, y)) + 'px'
}

// #27: a compact searchable resource-texture picker for the alpha-mask control.
// A fixed-positioned popup anchored under the button; a search box filters a grid
// of thumbnails; clicking one commits the path via onPick. Closes on outside click.
function closeTexPickers(): void {
  for (const p of document.querySelectorAll('.tex-picker')) p.remove()
}
document.addEventListener('pointerdown', (e) => {
  const t = e.target as Element | null
  if (t && (t.closest('.tex-picker') || t.closest('.alpha-pick'))) return
  closeTexPickers()
})
document.addEventListener('scroll', () => closeTexPickers(), true)

function openTexturePicker(anchor: HTMLElement, textures: string[], onPick: (path: string | null) => void): void {
  closeTexPickers()
  const pop = el('div', 'tex-picker')
  const search = el('input', 'tex-picker-search') as HTMLInputElement
  search.type = 'text'
  search.placeholder = 'search textures…'
  pop.appendChild(search)
  // #29: upload your own image from disk (e.g. a canopy holes mask) — saved to
  // resources/user-textures/ and assigned immediately.
  const up = el('button', 'tex-upload', '⬆ upload from computer…') as HTMLButtonElement
  const fileIn = el('input') as HTMLInputElement
  fileIn.type = 'file'
  fileIn.accept = 'image/png,image/jpeg'
  fileIn.style.display = 'none'
  up.onclick = () => fileIn.click()
  fileIn.onchange = () => {
    const f = fileIn.files?.[0]
    if (!f) return
    up.textContent = 'uploading…'
    const reader = new FileReader()
    reader.onload = async () => {
      try {
        const res = await fetch('/__inv/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: f.name, dataBase64: String(reader.result) }),
        })
        const json = await res.json()
        if (json.path) {
          onPick(json.path)
          closeTexPickers()
        } else {
          up.textContent = 'upload failed'
        }
      } catch {
        up.textContent = 'upload failed'
      }
    }
    reader.readAsDataURL(f)
  }
  pop.appendChild(up)
  pop.appendChild(fileIn)
  const grid = el('div', 'tex-picker-grid')
  pop.appendChild(grid)
  const render = () => {
    grid.innerHTML = ''
    const q = search.value.trim().toLowerCase()
    let shown = 0
    const MAX = 300
    for (const path of textures) {
      if (q && !path.toLowerCase().includes(q)) continue
      if (shown++ >= MAX) break
      const tile = el('div', 'tex-tile')
      const img = el('img') as HTMLImageElement
      img.src = '/' + encodeURI(resolveTexturePath(path))
      img.loading = 'lazy'
      tile.title = path
      tile.appendChild(img)
      tile.onclick = () => {
        onPick(path)
        closeTexPickers()
      }
      grid.appendChild(tile)
    }
    if (!shown) grid.appendChild(el('div', 'hint', 'no matches'))
  }
  search.oninput = () => render()
  render()
  document.body.appendChild(pop)
  const r = anchor.getBoundingClientRect()
  const w = pop.offsetWidth
  const h = pop.offsetHeight
  const vw = Math.max(window.innerWidth, r.right + 8)
  const vh = Math.max(window.innerHeight, r.bottom + 8)
  pop.style.left = Math.max(8, Math.min(vw - w - 8, r.left)) + 'px'
  pop.style.top = (r.bottom + h + 8 > vh ? Math.max(8, r.top - h - 4) : r.bottom + 4) + 'px'
  search.focus()
}

// #24: build the inline geometry ("craft") controls for a chip — a vertical
// stack appended into the chip's meta column, below the apply-options row. Wraps
// the full-range slider + bound number (craft), the subdivide selector and ⟲.
function buildGenControls(s: SlotInfo, cb: SlotCallbacks): HTMLElement {
  const g = s.gen!
  const box = el('div', 'slot-gen')
  box.onclick = (e) => e.stopPropagation() // don't re-pick the slot when tuning

  const craftRow = el('div', 'gen-row')
  craftRow.appendChild(el('span', 'gen-label', 'craft'))
  const slider = el('input') as HTMLInputElement
  slider.type = 'range'
  // slider spans 0.4 → 1 (values below 0.4 are unusably crooked); the number
  // input still accepts any 0..1 value the user types.
  slider.min = '0.4'
  slider.max = '1'
  slider.step = '0.01'
  slider.value = String(Math.max(0.4, Math.min(1, g.craft ?? 1)))
  slider.title = 'craftsmanship: 1 = machine-perfect (off), 0.4 = crooked hand-hewn'
  const num = el('input') as HTMLInputElement
  num.type = 'number'
  num.min = '0'
  num.max = '1'
  num.step = '0.01'
  num.value = g.craft === null ? '' : String(g.craft)
  slider.oninput = () => (num.value = parseFloat(slider.value).toFixed(2))
  slider.onchange = () => cb.onGenCraft(s.slot, parseFloat(slider.value)) // commit on release
  num.onchange = () => {
    const v = Math.min(1, Math.max(0, parseFloat(num.value)))
    if (!Number.isFinite(v)) return
    slider.value = String(Math.max(0.4, v)) // slider clamps to its 0.4 floor
    cb.onGenCraft(s.slot, v)
  }
  craftRow.appendChild(slider)
  craftRow.appendChild(num)
  box.appendChild(craftRow)

  const row2 = el('div', 'gen-row')
  const subSel = el('select', 'slot-select') as HTMLSelectElement
  const subNone = el('option', undefined, 'sub: —') as HTMLOptionElement
  subNone.value = ''
  subSel.appendChild(subNone)
  for (const n of [1, 2, 3]) {
    const o = el('option', undefined, 'sub: ' + n) as HTMLOptionElement
    o.value = String(n)
    subSel.appendChild(o)
  }
  subSel.value = g.sub === null || g.sub === 0 ? '' : String(g.sub)
  subSel.title = 'subdivision before jitter (4× triangles per step) — for flat/coarse shapes'
  subSel.onchange = () => cb.onGenSub(s.slot, subSel.value === '' ? null : parseInt(subSel.value, 10))
  row2.appendChild(subSel)
  const regen = el('button', 'btn-regen', '⟲') as HTMLButtonElement
  regen.disabled = !g.has
  regen.title = g.has
    ? 'regenerate this part with a new stored seed'
    : 'nothing generated here — lower craft first'
  regen.onclick = (e) => {
    e.stopPropagation()
    cb.onRegen(s.slot)
  }
  row2.appendChild(regen)
  box.appendChild(row2)
  return box
}

export function renderSlotChips(
  slots: SlotInfo[],
  fx: FxTextureInfo[],
  picked: string | null,
  cb: SlotCallbacks,
  allSlotNames?: string[], // item 34: fx dropdowns list EVERY slot, even collapsed-away ones
): void {
  const wrap = $('#slot-chips')
  wrap.innerHTML = ''
  if (!slots.length && !fx.length) {
    wrap.appendChild(el('div', 'hint', 'no model parts'))
    return
  }
  for (const s of slots) {
    const chip = el('div', 'slot-chip' + (picked === s.slot ? ' selected' : ''))
    chip.dataset.slot = s.slot // item 39: viewport pick scrolls this chip into view
    if (s.depth) chip.style.marginLeft = Math.min(s.depth, 4) * 14 + 'px' // item 34: children indent under their parent
    const inheriting = !!s.inherit
    // item 34: ghost/↺ per control — inherited values render dimmed; an override
    // gets a small ↺ that deletes the key (re-binds live to the parent value).
    const decorate = (ctl: HTMLElement, key: OverridableKey, into: HTMLElement) => {
      into.appendChild(ctl)
      if (!inheriting) return
      if (s.own[key]) {
        const rst = el('button', 'ovr-reset', '↺') as HTMLButtonElement
        rst.title = `"${key}" is overridden on this part — reset to the inherited value`
        rst.onclick = (e) => {
          e.stopPropagation()
          cb.onResetParam(s.slot, key)
        }
        into.appendChild(rst)
      } else {
        ctl.classList.add('ghosted')
      }
    }
    // thumbnail shows the RESULT: texture × tint (multiply blend over the tint color)
    // #2: bigger + top-aligned (CSS). #3: the material name shows only on hover
    // (title attr). #14: right-click the preview → context menu → Edit material.
    const thumb = el('div', 'slot-thumb')
    thumb.style.background = s.tint ?? '#ffffff'
    thumb.title =
      s.material +
      (s.tint ? ` · tinted ${s.tint}` : '') +
      (inheriting && !s.own.material ? ` (inherited from ${s.inherit})` : '')
    const img = el('img') as HTMLImageElement
    img.src = '/' + encodeURI(resolveTexturePath(s.texture))
    img.loading = 'lazy'
    thumb.appendChild(img)
    // item 34: an inheriting slot that OVERRIDES the material shows ↺ on the
    // thumb itself (the chip's "material row") — resets back to the parent's.
    if (inheriting && s.own.material) {
      const rst = el('button', 'thumb-reset', '↺') as HTMLButtonElement
      rst.title = 'material is overridden on this part — reset to the inherited material'
      rst.onclick = (e) => {
        e.stopPropagation()
        cb.onResetParam(s.slot, 'material')
      }
      thumb.appendChild(rst)
    }
    thumb.oncontextmenu = (e) => {
      e.preventDefault()
      e.stopPropagation()
      openChipMenu(e.clientX, e.clientY, [
        { label: 'Edit material', action: () => cb.onEditMaterial(s.slot) },
        { label: 'Show in picker', action: () => cb.onShowInPicker(s.slot) }, // #38
      ])
    }
    chip.appendChild(thumb)
    const meta = el('div', 'slot-meta')
    // item 34: name row — collapse toggle for group parents + group-knob badge
    const nameRow = el('div', 'slot-name-row')
    if (s.groupParent) {
      const tgl = el('button', 'grp-toggle', s.collapsed ? '▸' : '▾') as HTMLButtonElement
      tgl.title = s.collapsed
        ? `expand — ${s.childCount} part${s.childCount === 1 ? '' : 's'} inherit from this slot`
        : 'collapse this group'
      tgl.onclick = (e) => {
        e.stopPropagation()
        cb.onToggleCollapse(s.slot)
      }
      nameRow.appendChild(tgl)
    }
    nameRow.appendChild(el('div', 'slot-name', s.slot))
    if (s.groupKnob) {
      const badge = el('span', 'grp-badge', 'group')
      badge.title = 'group knob — no geometry uses this slot directly; parts inheriting from it follow its values'
      nameRow.appendChild(badge)
    }
    if (s.groupParent && s.collapsed) nameRow.appendChild(el('span', 'grp-count', `+${s.childCount}`))
    meta.appendChild(nameRow)
    // #22 (refines #3): the material name is NOT revealed on chip hover — it shows
    // ONLY as the native tooltip on the preview image (thumb.title, set above).
    // item 34: "inherit from [✓][parent]" row (fx-chip pattern). Unchecking
    // freezes the resolved values as own keys; re-checking re-binds.
    if (s.inheritOptions.length) {
      const inhRow = el('div', 'slot-controls')
      const inhLabel = el('label', 'fx-inherit')
      const inhBox = el('input') as HTMLInputElement
      inhBox.type = 'checkbox'
      inhBox.checked = inheriting
      const inhSel = el('select', 'slot-select') as HTMLSelectElement
      for (const name of s.inheritOptions) {
        const o = el('option', undefined, name) as HTMLOptionElement
        o.value = name
        inhSel.appendChild(o)
      }
      // item 34 fix: after a freeze, re-checking must re-bind to the FORMER
      // parent, not the first candidate — prefer inherit, then lastInherit
      // (only if still a legal choice), then the first option.
      const remembered =
        s.inherit ?? (s.lastInherit && s.inheritOptions.includes(s.lastInherit) ? s.lastInherit : null)
      inhSel.value = remembered ?? s.inheritOptions[0]
      inhSel.disabled = !inhBox.checked
      inhSel.title = 'the parent slot this part inherits every unset property from'
      inhBox.title = inheriting
        ? 'uncheck to detach: freezes the current resolved values as this part’s own'
        : 'check to inherit from a parent slot (existing values stay as overrides)'
      inhBox.onclick = (e) => e.stopPropagation()
      inhBox.onchange = () => cb.onInherit(s.slot, inhBox.checked ? inhSel.value || null : null)
      inhSel.onclick = (e) => e.stopPropagation()
      inhSel.onchange = () => cb.onInherit(s.slot, inhSel.value)
      inhLabel.appendChild(inhBox)
      inhLabel.appendChild(document.createTextNode(' inherit from'))
      inhLabel.onclick = (e) => e.stopPropagation()
      inhRow.appendChild(inhLabel)
      inhRow.appendChild(inhSel)
      meta.appendChild(inhRow)
    }
    const controls = el('div', 'slot-controls')
    const uvSel = el('select', 'slot-select') as HTMLSelectElement
    for (const m of ['tile', 'fit', 'stretch']) {
      const o = el('option', undefined, m) as HTMLOptionElement
      o.value = m
      uvSel.appendChild(o)
    }
    uvSel.value = s.uvMode
    uvSel.title = 'tile: repeats by surface size · fit: whole repeats only (patterns never cut) · stretch: once over the face'
    uvSel.onclick = (e) => e.stopPropagation()
    uvSel.onchange = () => cb.onParam(s.slot, 'uvMode', uvSel.value)
    const scaleSel = el('select', 'slot-select') as HTMLSelectElement
    for (const v of ['0.25', '0.5', '1', '2', '4']) {
      const o = el('option', undefined, '×' + v) as HTMLOptionElement
      o.value = v
      scaleSel.appendChild(o)
    }
    scaleSel.value = String(s.uvScale)
    if (![0.25, 0.5, 1, 2, 4].includes(s.uvScale)) {
      const o = el('option', undefined, '×' + s.uvScale) as HTMLOptionElement
      o.value = String(s.uvScale)
      scaleSel.appendChild(o)
      scaleSel.value = String(s.uvScale)
    }
    scaleSel.title = 'texture density (repeats per meter, tile/fit modes)'
    scaleSel.disabled = s.uvMode === 'stretch'
    scaleSel.onclick = (e) => e.stopPropagation()
    scaleSel.onchange = () => cb.onParam(s.slot, 'uvScale', scaleSel.value)
    const rotSel = el('select', 'slot-select') as HTMLSelectElement
    // item 35: full circle in 15° steps (schema accepts any 0–359 value)
    for (let d = 0; d < 360; d += 15) {
      const o = el('option', undefined, d + '°') as HTMLOptionElement
      o.value = String(d)
      rotSel.appendChild(o)
    }
    if (s.uvRot % 15 !== 0) {
      const o = el('option', undefined, s.uvRot + '°') as HTMLOptionElement
      o.value = String(s.uvRot)
      rotSel.appendChild(o)
    }
    rotSel.value = String(s.uvRot)
    rotSel.onclick = (e) => e.stopPropagation()
    rotSel.onchange = () => cb.onParam(s.slot, 'uvRot', rotSel.value)
    // #4: per-slot UV projection override (box | planar | sphere). '' = keep the
    // material/authored UVs. Written to the slot material (over its default).
    const projSel = el('select', 'slot-select') as HTMLSelectElement
    for (const [val, label] of [
      ['', 'proj: —'],
      ['box', 'proj: box'],
      ['planar', 'proj: planar'],
      ['sphere', 'proj: sphere'],
    ]) {
      const o = el('option', undefined, label) as HTMLOptionElement
      o.value = val
      projSel.appendChild(o)
    }
    projSel.value = s.uvProject
    projSel.onclick = (e) => e.stopPropagation()
    projSel.onchange = () => cb.onParam(s.slot, 'uvProject', projSel.value)
    // The per-slot chip is AUTHORITATIVE (factory.effectiveUvProject): an explicit
    // choice here overrides the authored node-level projection, so it always
    // changes the model — no lock/dead-option case anymore.
    projSel.title =
      'UV projection for this part: box = per-face planar, planar = from above, sphere = around center (— = material/authored; overrides the part’s authored node projection when set; on an inheriting part, choosing — PINS authored UVs over the parent’s projection — ↺ to re-follow the parent)'
    decorate(uvSel, 'uvMode', controls)
    decorate(scaleSel, 'uvScale', controls)
    decorate(rotSel, 'uvRot', controls)
    decorate(projSel, 'uvProject', controls)
    meta.appendChild(controls)
    const surf = el('div', 'slot-controls')
    // tint: the color multiplied over the texture — THE source of "same texture,
    // different color". Rendered as our own square swatch (the native color-input
    // chrome is too small to read); the hidden input only supplies the picker.
    const tintWrap = el('label', 'slot-tint')
    tintWrap.title = 'tint — multiplies the texture (white = no tint). Click to change.'
    tintWrap.appendChild(el('span', undefined, 'tint'))
    const swatch = el('span', 'tint-swatch' + (s.tint ? '' : ' none'))
    swatch.style.background = s.tint ?? '#ffffff'
    const tintInput = el('input') as HTMLInputElement
    tintInput.type = 'color'
    tintInput.value = s.tint ?? '#ffffff'
    tintInput.oninput = () => {
      // live preview on the swatch AND the entity material while the picker is
      // open (real-time drag); commit (writes JSON + rebuild) on close.
      swatch.style.background = tintInput.value
      swatch.classList.remove('none')
      cb.onTintLive(s.slot, tintInput.value)
    }
    tintInput.onchange = () => cb.onParam(s.slot, 'tint', tintInput.value)
    tintInput.onclick = (e) => e.stopPropagation()
    tintWrap.onclick = (e) => e.stopPropagation()
    tintWrap.appendChild(swatch)
    tintWrap.appendChild(tintInput)
    decorate(tintWrap, 'tint', surf)
    // surface/cutout/opacity moved to the material (tuning) — phase 4's Material
    // Manager. The chip keeps only per-slot placement overrides (tint + uv).
    meta.appendChild(surf)
    // #24: geometry / craft ("musher") controls now sit INLINE below the apply
    // options — a vertical stack within the same chip (craft slider + number,
    // subdivide selector, ⟲ regen). No popup. The generator only runs from here
    // (or a prompted edit) — results are pinned by stored seeds and replayed
    // verbatim on every build.
    if (s.gen) meta.appendChild(buildGenControls(s, cb))
    chip.appendChild(meta)
    chip.onclick = () => cb.onPick(s.slot)
    wrap.appendChild(chip)
  }
  const slotNames = allSlotNames ?? slots.map((s) => s.slot)
  for (const f of fx) {
    const chip = el('div', 'slot-chip fx-chip' + (picked === f.key ? ' selected' : ''))
    const thumb = el('div', 'slot-thumb')
    thumb.style.background = f.tint ?? '#ffffff'
    const img = el('img') as HTMLImageElement
    if (f.texture) img.src = '/' + encodeURI(resolveTexturePath(f.texture))
    img.loading = 'lazy'
    thumb.appendChild(img)
    chip.appendChild(thumb)
    const meta = el('div', 'slot-meta')
    meta.appendChild(el('div', 'slot-name', f.label))
    meta.appendChild(
      el(
        'div',
        'slot-tex',
        f.inheritSlot ? '← ' + f.inheritSlot : f.texture ? (f.texture.split('/').pop() ?? '') : '— pick a texture',
      ),
    )
    const controls = el('div', 'slot-controls')
    const inheritLabel = el('label', 'fx-inherit')
    const box = el('input') as HTMLInputElement
    box.type = 'checkbox'
    box.checked = !!f.inheritSlot
    const slotSel = el('select', 'slot-select') as HTMLSelectElement
    for (const name of slotNames) {
      const o = el('option', undefined, name) as HTMLOptionElement
      o.value = name
      slotSel.appendChild(o)
    }
    slotSel.value = f.inheritSlot ?? slotNames[0] ?? ''
    slotSel.disabled = !box.checked
    box.onclick = (e) => e.stopPropagation()
    box.onchange = () => cb.onFxInherit(f.key, box.checked ? slotSel.value || null : null)
    slotSel.onclick = (e) => e.stopPropagation()
    slotSel.onchange = () => cb.onFxInherit(f.key, slotSel.value)
    inheritLabel.appendChild(box)
    inheritLabel.appendChild(document.createTextNode(' inherit from'))
    inheritLabel.onclick = (e) => e.stopPropagation()
    controls.appendChild(inheritLabel)
    controls.appendChild(slotSel)
    if (!f.inheritSlot) {
      const fxRot = el('select', 'slot-select') as HTMLSelectElement
      // item 35: full circle in 15° steps (schema accepts any 0–359 value)
      for (let d = 0; d < 360; d += 15) {
        const o = el('option', undefined, d + '°') as HTMLOptionElement
        o.value = String(d)
        fxRot.appendChild(o)
      }
      if (f.uvRot % 15 !== 0) {
        const o = el('option', undefined, f.uvRot + '°') as HTMLOptionElement
        o.value = String(f.uvRot)
        fxRot.appendChild(o)
      }
      fxRot.value = String(f.uvRot)
      fxRot.title = 'debris texture direction'
      fxRot.onclick = (e) => e.stopPropagation()
      fxRot.onchange = () => cb.onFxRot(f.key, fxRot.value)
      controls.appendChild(fxRot)
    }
    meta.appendChild(controls)
    chip.appendChild(meta)
    chip.onclick = () => cb.onPick(f.key)
    wrap.appendChild(chip)
  }
}

// Materials picker (was the old-pack texture browser). Tiles = each catalog
// material's active-resolution color map, grouped/searchable by category. Click
// assigns the material id to the picked slot (main.ts writes slot.material).
export interface MatPickerEntry {
  id: string // catalog material id
  category: string
  color: string // active-res color-map path (for the thumbnail), or ''
}

export interface MatPickerState {
  materials: MatPickerEntry[]
  category: string // '' = all categories
  current: string | null // the picked slot's assigned material id
  onAssign(materialId: string): void
  onEdit(materialId: string): void // #37: right-click a tile → Edit material
}

// item 36: "hide MC textures" — persisted; filters mc_* out of the grid AND
// the category dropdown. Default unchecked (mc visible).
const HIDE_MC_KEY = 'volaticus.hideMc'

export function initMatPicker(state: MatPickerState): { refresh(): void; reveal(id: string): void } {
  const search = $('#tex-search') as HTMLInputElement
  const catSel = $('#tex-folder') as HTMLSelectElement
  const grid = $('#tex-grid')
  const hideMc = $('#tex-hidemc') as HTMLInputElement
  hideMc.checked = localStorage.getItem(HIDE_MC_KEY) === '1'

  const visible = () => state.materials.filter((m) => !(hideMc.checked && m.id.startsWith('mc_')))

  const buildCats = () => {
    const cats = [...new Set(visible().map((m) => m.category))].sort()
    catSel.innerHTML = ''
    const optAll = el('option', undefined, 'all categories') as HTMLOptionElement
    optAll.value = ''
    catSel.appendChild(optAll)
    for (const c of cats) {
      const o = el('option', undefined, c) as HTMLOptionElement
      o.value = c
      catSel.appendChild(o)
    }
    if (state.category && !cats.includes(state.category)) state.category = '' // hidden mc category was selected
    catSel.value = state.category
  }

  const refresh = () => {
    grid.innerHTML = ''
    const q = search.value.trim().toLowerCase()
    let shown = 0
    const MAX = 800
    for (const m of visible()) {
      if (state.category && m.category !== state.category) continue
      if (q && !m.id.toLowerCase().includes(q) && !m.category.toLowerCase().includes(q)) continue
      if (shown++ >= MAX) continue
      const tile = el('div', 'tex-tile' + (state.current === m.id ? ' current' : ''))
      tile.dataset.id = m.id // #38: reveal() finds the tile by material id
      const img = el('img') as HTMLImageElement
      if (m.color) img.src = '/' + encodeURI(resolveTexturePath(m.color))
      img.loading = 'lazy'
      tile.title = m.id + ' · ' + m.category
      tile.appendChild(img)
      tile.appendChild(el('div', 'mat-cap', m.id))
      tile.onclick = () => state.onAssign(m.id)
      // #37: right-click a picker tile → the same context menu as chip previews
      tile.oncontextmenu = (e) => {
        e.preventDefault()
        e.stopPropagation()
        openChipMenu(e.clientX, e.clientY, [{ label: 'Edit material', action: () => state.onEdit(m.id) }])
      }
      grid.appendChild(tile)
    }
    const info = el('div', 'hint', shown > MAX ? `showing ${MAX} — refine search` : `${shown} materials`)
    grid.appendChild(info)
  }

  // #38: reset filters so the target tile is guaranteed rendered (its own
  // category dodges the 800-tile cap; un-hide MC for mc_ targets), scroll the
  // grid to it and flash-highlight.
  const reveal = (id: string) => {
    const m = state.materials.find((x) => x.id === id)
    if (!m) return
    search.value = ''
    if (hideMc.checked && id.startsWith('mc_')) {
      hideMc.checked = false
      localStorage.setItem(HIDE_MC_KEY, '0')
    }
    state.category = m.category
    buildCats()
    refresh()
    const find = () => grid.querySelector(`.tex-tile[data-id="${CSS.escape(id)}"]`) as HTMLElement | null
    let tile = find()
    if (!tile) {
      // category still over the render cap — narrow by exact-id search
      search.value = id
      refresh()
      tile = find()
    }
    if (!tile) return
    // Scroll ONLY the grid. scrollIntoView({block:'center'}) propagates past
    // #tex-grid to the document root (which is silently scrollable — the chip
    // column content leaks into the root scroll area), shoving the whole app
    // up and leaving a dead band below. Manual scrollTop math moves nothing
    // but the grid itself.
    const gr = grid.getBoundingClientRect()
    const tr = tile.getBoundingClientRect()
    grid.scrollTop += tr.top - gr.top - (grid.clientHeight - tr.height) / 2
    tile.classList.add('flash')
    setTimeout(() => tile?.classList.remove('flash'), 1800)
  }

  buildCats()
  search.oninput = () => refresh()
  catSel.onchange = () => {
    state.category = catSel.value
    refresh()
  }
  hideMc.onchange = () => {
    localStorage.setItem(HIDE_MC_KEY, hideMc.checked ? '1' : '0')
    buildCats()
    refresh()
  }
  refresh()
  return { refresh, reveal }
}

// ---------------------------------------------------------------------------
// Material Manager: left catalog list (grouped by category) + right tuning panel.

export interface MgrListEntry {
  id: string
  name: string
  category: string
  color: string // active-res color-map path for the row thumbnail
}

export function renderMgrList(
  entries: MgrListEntry[],
  filter: string,
  selected: string | null,
  onSelect: (id: string) => void,
  isLoading?: (id: string) => boolean, // rows whose GL textures are still decoding
): void {
  const list = $('#mgr-list')
  list.innerHTML = ''
  const q = filter.trim().toLowerCase()
  const groups = new Map<string, MgrListEntry[]>()
  for (const e of entries) {
    if (q && !e.id.toLowerCase().includes(q) && !e.category.toLowerCase().includes(q)) continue
    if (!groups.has(e.category)) groups.set(e.category, [])
    groups.get(e.category)!.push(e)
  }
  let total = 0
  for (const cat of [...groups.keys()].sort()) {
    list.appendChild(el('div', 'list-section', cat))
    for (const e of groups.get(cat)!.sort((a, b) => a.id.localeCompare(b.id))) {
      total++
      const row = el('div', 'mgr-item' + (selected === e.id ? ' selected' : ''))
      const img = el('img') as HTMLImageElement
      if (e.color) img.src = '/' + encodeURI(resolveTexturePath(e.color))
      img.loading = 'lazy'
      row.appendChild(img)
      row.appendChild(el('div', 'mgr-item-name', e.id))
      // spinner while the material's 3D textures are still decoding (the row
      // thumbnail is a plain <img> and loads independently, so it isn't a signal
      // for whether the preview mesh would render or be black).
      if (isLoading?.(e.id)) {
        row.classList.add('mgr-item-loading')
        row.appendChild(el('span', 'mgr-spinner'))
      }
      row.onclick = () => onSelect(e.id)
      list.appendChild(row)
    }
  }
  if (!total) list.appendChild(el('div', 'hint', 'no materials'))
}

// The tuning fields (matches MaterialTuning, minus the retired-from-UI uv defaults
// which are now PREVIEW-ONLY controls in the preview bar).
export interface MgrTuning {
  tint: string | null
  roughness: number
  metalness: number
  normalScale: number
  aoIntensity: number
  emissive: number
  opacity: number
  cutout: boolean
  doubleSided: boolean
  flat: boolean
  alphaMap: string | null // #27: alpha/opacity MASK texture path (single, res-independent)
}

// Which texture maps this material actually ships (any resolution). Drives the
// tuning panel: normal/ao/emissive rows only render when their map is present;
// roughness/metalness always render but show a "backed by a map" badge.
export interface MgrMaps {
  roughness: boolean
  metallic: boolean
  normal: boolean
  ao: boolean
  emissive: boolean
  height: boolean
}

export interface MgrTuningCallbacks {
  onNum(key: 'roughness' | 'metalness' | 'normalScale' | 'aoIntensity' | 'emissive' | 'opacity', value: number): void
  onBool(key: 'cutout' | 'doubleSided' | 'flat', value: boolean): void
  onTint(value: string | null): void
  // live default-tint while dragging — applies to the preview material directly
  // (no rebuild); onTint still commits the value on 'change'.
  onTintLive(value: string): void
  // #27: alpha mask — open a resource-texture picker (returns the chosen path or
  // null to clear). textures() lists all pickable resource paths.
  onAlphaMap(value: string | null): void
  textures(): string[]
}

export function renderMgrTuning(
  title: string,
  category: string,
  t: MgrTuning | null,
  maps: MgrMaps,
  cb: MgrTuningCallbacks,
): void {
  $('#mgr-title').textContent = title
  const wrap = $('#mgr-tuning')
  wrap.innerHTML = ''
  if (!t) {
    wrap.appendChild(el('div', 'hint', 'select a material'))
    return
  }
  wrap.appendChild(el('div', 'tune-sep', category))

  // #9: a small "?" hint marker on a label — the explanation is the title tooltip.
  const withHint = (labelText: string, hintText: string): HTMLLabelElement => {
    const lab = el('label') as HTMLLabelElement
    lab.appendChild(document.createTextNode(labelText))
    const q = el('span', 'tune-hint', '?')
    q.title = hintText
    lab.appendChild(q)
    lab.title = hintText // the whole label is hoverable too
    return lab
  }

  // #8: "default tint" — the material's baseline albedo multiply. A per-slot chip
  // tint overrides it per application (slot.tint ?? material.tuning.tint ?? none).
  const tintRow = el('div', 'tune-tint')
  tintRow.appendChild(
    withHint(
      'default tint',
      'DEFAULT TINT — the material baseline color, multiplied over the albedo map. A part chip’s per-slot tint overrides this when the material is applied to an object (slot tint wins, else this default, else none).',
    ),
  )
  const swatch = el('span', 'tint-swatch' + (t.tint ? '' : ' none'))
  swatch.style.background = t.tint ?? '#ffffff'
  const tintInput = el('input') as HTMLInputElement
  tintInput.type = 'color'
  tintInput.value = t.tint ?? '#ffffff'
  const tintLabel = el('label', undefined) as HTMLLabelElement
  tintLabel.style.position = 'relative'
  tintLabel.style.cursor = 'pointer'
  tintLabel.appendChild(swatch)
  tintLabel.appendChild(tintInput)
  tintInput.oninput = () => {
    swatch.style.background = tintInput.value
    swatch.classList.remove('none')
    cb.onTintLive(tintInput.value) // real-time drag on the preview material
  }
  tintInput.onchange = () => cb.onTint(tintInput.value)
  const clearBtn = el('button', undefined, 'clear') as HTMLButtonElement
  clearBtn.title = 'remove the default tint (untinted albedo)'
  clearBtn.onclick = () => cb.onTint(null)
  tintRow.appendChild(tintLabel)
  tintRow.appendChild(clearBtn)
  wrap.appendChild(tintRow)

  // A small "▦" badge appended to a label, marking that a texture map backs the
  // scalar (so the slider scales that map rather than acting on a flat value).
  const withMapBadge = (lab: HTMLLabelElement): HTMLLabelElement => {
    const badge = el('span', 'tune-map-badge', '▦')
    badge.title = 'backed by a texture map — the slider scales the map'
    lab.appendChild(badge)
    return lab
  }

  const slider = (
    label: string,
    key: Parameters<MgrTuningCallbacks['onNum']>[0],
    min: number,
    max: number,
    step: number,
    val: number,
    hint: string,
    hasMap = false,
  ) => {
    const row = el('div', 'tune-row')
    const lab = withHint(label, hint)
    if (hasMap) withMapBadge(lab)
    row.appendChild(lab)
    const input = el('input') as HTMLInputElement
    input.type = 'range'
    input.min = String(min)
    input.max = String(max)
    input.step = String(step)
    input.value = String(val)
    const fmt = (n: number) => n.toFixed(step < 0.1 ? 2 : step < 1 ? 1 : 0)
    const out = el('span', 'tune-val', fmt(val))
    input.oninput = () => (out.textContent = fmt(parseFloat(input.value)))
    input.onchange = () => cb.onNum(key, parseFloat(input.value))
    row.appendChild(input)
    row.appendChild(out)
    wrap.appendChild(row)
  }

  // roughness + metalness ALWAYS show (they act as scalars even with no map); a
  // "▦" badge marks the ones a texture map backs.
  slider('roughness', 'roughness', 0, 1, 0.01, t.roughness,
    'Micro-surface roughness (scalar × the roughness map). 0 = mirror-smooth/glossy, 1 = fully matte. Affects how sharp reflections and highlights are.', maps.roughness)
  slider('metalness', 'metalness', 0, 1, 0.01, t.metalness,
    'Metallic vs. dielectric. 1 = metal (albedo tints the reflection, needs the skybox to show), 0 = non-metal (plastic/wood/stone).', maps.metallic)
  // normal / AO / emissive are meaningless without their map — show ONLY if present.
  if (maps.normal)
    slider('normalScale', 'normalScale', 0, 3, 0.01, t.normalScale,
      'Strength of the normal map — how much the baked surface bumps catch light. 0 = flat, 3 = strongly exaggerated relief.')
  if (maps.ao)
    slider('aoIntensity', 'aoIntensity', 0, 2, 0.01, t.aoIntensity,
      'Ambient-occlusion map strength — darkens crevices under indirect (skybox/IBL) light. 0 = off, 1 = baked strength, 2 = deepened. (Uses the mesh uv2.)')
  if (maps.emissive)
    slider('emissive', 'emissive', 0, 3, 0.05, t.emissive,
      'Emissive (glow) intensity from the emissive map — the material appears self-lit.')
  slider('opacity', 'opacity', 0, 1, 0.01, t.opacity,
    'Whole-material transparency. <1 turns on alpha blending (depthWrite off) — for glass/water. 1 = opaque.')

  // (uvScale + uvProject moved OUT of the material tuning — they are now
  // PREVIEW-ONLY view controls in the preview bar, never written to the material.)

  // #27: alpha MASK — a texture picker assigning ANY resource texture as the
  // material's alpha mask (green channel, res-independent) + a clear button. Its
  // transparency mode follows the cutout flag (hard alphaTest) or opacity<1 (soft).
  wrap.appendChild(el('div', 'tune-sep', 'alpha mask'))
  const alphaRow = el('div', 'tune-row')
  alphaRow.appendChild(
    withHint(
      'alpha mask',
      'ALPHA MASK — assign any resource texture as the opacity mask (three.js reads its green channel). Combine with "cutout" for hard-edged leaves/foliage, or lower opacity below 1 for soft transparency. Clear to make the material fully opaque again.',
    ),
  )
  const alphaThumb = el('span', 'alpha-thumb' + (t.alphaMap ? '' : ' none'))
  if (t.alphaMap) {
    const im = el('img') as HTMLImageElement
    im.src = '/' + encodeURI(resolveTexturePath(t.alphaMap))
    alphaThumb.appendChild(im)
    alphaThumb.title = t.alphaMap
  }
  const alphaPick = el('button', 'alpha-pick', t.alphaMap ? 'change…' : 'set mask…') as HTMLButtonElement
  alphaPick.onclick = () => openTexturePicker(alphaPick, cb.textures(), cb.onAlphaMap)
  const alphaClear = el('button', undefined, 'clear') as HTMLButtonElement
  alphaClear.title = 'remove the alpha mask (opaque)'
  alphaClear.disabled = !t.alphaMap
  alphaClear.onclick = () => cb.onAlphaMap(null)
  alphaRow.appendChild(alphaThumb)
  alphaRow.appendChild(alphaPick)
  alphaRow.appendChild(alphaClear)
  wrap.appendChild(alphaRow)

  const check = (label: string, key: 'cutout' | 'doubleSided' | 'flat', val: boolean, hint: string) => {
    const row = el('div', 'tune-row chk')
    const box = el('input') as HTMLInputElement
    box.type = 'checkbox'
    box.checked = val
    box.id = 'tune-' + key
    box.onchange = () => cb.onBool(key, box.checked)
    const lab = el('label', undefined, label) as HTMLLabelElement
    lab.htmlFor = box.id
    lab.title = hint
    row.title = hint
    row.appendChild(box)
    row.appendChild(lab)
    wrap.appendChild(row)
  }
  wrap.appendChild(el('div', 'tune-sep', 'flags'))
  check('cutout (alphaTest)', 'cutout', t.cutout,
    'Alpha cutout — pixels below 50% alpha are discarded (hard edges, no blending). For leaves, flags, fences. Cheaper than opacity blending.')
  check('double-sided', 'doubleSided', t.doubleSided,
    'Render both faces (disables back-face culling). For thin planes/cards seen from both sides.')
  check('flat shading', 'flat', t.flat,
    'Flat (faceted) shading — one normal per triangle, the low-poly look. Off = smooth (interpolated) normals. A per-slot flat can still override per part.')
}

// ---------------------------------------------------------------------------
// viewport overlay: states / events / effect controls

export interface OverlayCallbacks {
  onState(name: string): void
  onEvent(name: string): void
  onTriggerEffect(): void
  onPlaySfx(): void
  onNextVariant(): void
  onRegenVariants(): void // rewrite variants.seeds with fresh randoms (explicit editor action)
  onCollider(show: boolean): void
  onResetCam(): void
  onContext(dim: string, value: string | null): void
  onModifier(name: string | null): void // entity-level visibility overlay (face expression)
}

export function renderOverlay(
  item: {
    kind: ItemKind
    states: string[]
    current: string | null
    events: string[]
    modifiers?: string[] // declared entity modifiers (doc.modifiers keys)
    modifier?: string | null // the active one
    contextDims?: Map<string, Set<string>>
    context?: Record<string, string>
    variant?: { index: number; count: number } // stored variant set (variants.seeds)
    hasSeeds?: boolean // doc carries an explicit variants.seeds list
  } | null,
  cb: OverlayCallbacks,
): void {
  const top = $('#overlay-top')
  top.innerHTML = ''
  if (!item) return

  if (item.kind === 'entity') {
    if (item.states.length) {
      const sel = el('select') as HTMLSelectElement
      for (const s of item.states) {
        const o = el('option', undefined, 'state: ' + s) as HTMLOptionElement
        o.value = s
        sel.appendChild(o)
      }
      if (item.current) sel.value = item.current
      sel.onchange = () => cb.onState(sel.value)
      top.appendChild(sel)
    }
    for (const ev of item.events) {
      const b = el('button', 'btn-event', ev + ' !')
      b.onclick = () => cb.onEvent(ev)
      top.appendChild(b)
    }
    // modifier chips: visibility overlays that combine with ANY state — click
    // toggles (one active at a time, clicking the active one clears it)
    for (const m of item.modifiers ?? []) {
      const b = el('button', 'btn-modifier' + (item.modifier === m ? ' active' : ''), m)
      b.title = `modifier "${m}": show/hide overlay on top of the current state (combineable with any animation)`
      b.onclick = () => cb.onModifier(item.modifier === m ? null : m)
      top.appendChild(b)
    }
    for (const [dim, values] of item.contextDims ?? []) {
      const sel = el('select', 'ctx-select') as HTMLSelectElement
      const none = el('option', undefined, dim + ': —') as HTMLOptionElement
      none.value = ''
      sel.appendChild(none)
      for (const v of [...values].sort()) {
        const o = el('option', undefined, dim + ': ' + v) as HTMLOptionElement
        o.value = v
        sel.appendChild(o)
      }
      sel.value = item.context?.[dim] ?? ''
      sel.onchange = () => cb.onContext(dim, sel.value || null)
      top.appendChild(sel)
    }
    // cycle the baked variant geometries — static, nothing regenerates on cycle
    if (item.variant && item.variant.count > 1) {
      const btn = el('button', undefined, `🎲 variant ${item.variant.index + 1}/${item.variant.count}`)
      btn.title = 'cycle the baked variants (<id>.geom.{i}.json) — static, nothing is regenerated'
      btn.onclick = () => cb.onNextVariant()
      top.appendChild(btn)
    }
    // Regen: re-bake every variant's geometry with fresh randomness (same count)
    if (item.hasSeeds) {
      const rg = el('button', undefined, '⟳ regen')
      rg.title = "re-bake every variant's geometry with fresh randomness — rewrites the <id>.geom.{i}.json sidecars"
      rg.onclick = () => cb.onRegenVariants()
      top.appendChild(rg)
    }
    const colWrap = el('label', 'chk')
    const chk = el('input') as HTMLInputElement
    chk.type = 'checkbox'
    chk.onchange = () => cb.onCollider(chk.checked)
    colWrap.appendChild(chk)
    colWrap.appendChild(document.createTextNode(' collider'))
    top.appendChild(colWrap)
  }
  if (item.kind === 'effect') {
    const b = el('button', 'btn-event', '▶ trigger')
    b.onclick = () => cb.onTriggerEffect()
    top.appendChild(b)
  }
  if (item.kind === 'sfx') {
    const b = el('button', 'btn-event', '▶ play')
    b.onclick = () => cb.onPlaySfx()
    top.appendChild(b)
  }
  const cam = el('button', undefined, '⌖ camera')
  cam.onclick = () => cb.onResetCam()
  top.appendChild(cam)
}

export function setPickInfo(text: string): void {
  $('#overlay-bottom').textContent = text
}

// bottom-right status: triangle count of the built entity (updates on rebuild)
export function setStats(text: string): void {
  $('#overlay-stats').textContent = text
}

export function setValidation(issues: string[]): void {
  const bar = $('#valid-bar')
  if (!issues.length) {
    bar.style.display = 'none'
    return
  }
  bar.style.display = 'block'
  bar.textContent = issues.slice(0, 4).join('   •   ') + (issues.length > 4 ? `   (+${issues.length - 4} more)` : '')
}

export function setTitle(text: string, dirty: boolean): void {
  $('#sel-title').textContent = text + (dirty ? ' •' : '')
  ;($('#btn-save') as HTMLButtonElement).disabled = !dirty
}

export function toast(text: string): void {
  const t = el('div', 'toast', text)
  document.body.appendChild(t)
  setTimeout(() => t.classList.add('show'), 10)
  setTimeout(() => {
    t.classList.remove('show')
    setTimeout(() => t.remove(), 300)
  }, 1800)
}
