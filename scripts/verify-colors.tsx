/**
 * aequdash — scripts/verify-colors.tsx
 *
 * Span-level color verification. The char frame proves geometry; THIS proves
 * the palette. Samples styled spans at known cells and asserts exact theme
 * tokens (guide §30 color checklist):
 *
 *   canvas #ECE5D8 · surface #F0E9DC · rule #B88A88 · ink #5E3C3C
 *   accent #A86668 (bar fill, active tab, badge) · track #DED1C8
 *
 * Exit 0 = all checks pass; exit 1 with diffs otherwise.
 */

process.env.AEQUDASH_SNAPSHOT = "1"
process.env.AEQUCHAIN_SIMULATE = "1"
process.env.AEQUCHAIN_NO_SPLASH = "1"

const { createTestRenderer } = await import("@opentui/core/testing")
const { createRoot } = await import("@opentui/react")
await import("@opentui/react/runtime-plugin-support")
const { JuliaBridge } = await import("../src/lib/bridge.ts")
const { BridgeProvider } = await import("../src/state/store.tsx")
const { App } = await import("../src/App.tsx")
const { LIGHT } = await import("../src/lib/theme.ts")
const React = await import("react")

const setup = await createTestRenderer({ width: 158, height: 50, screenMode: "alternate-screen" })
const bridge = new JuliaBridge({ backend: "sim", juliaBin: "julia", rpcScript: "/dev/null", cwd: process.cwd(), aeqnetNodes: 1, aeqnetPort: 7920 })
await bridge.start()

const root = createRoot(setup.renderer)
root.render(React.createElement(BridgeProvider, { bridge, children: React.createElement(App) }))
await new Promise((r) => setTimeout(r, 1200))
await setup.flush({ maxPasses: 20 })
await new Promise((r) => setTimeout(r, 300))

const spans = setup.captureSpans()

/** captureSpans returns RGBA objects ({r,g,b,a} floats 0..1) — normalize to hex. */
type RGBA = { r: number; g: number; b: number; a: number } | string | undefined
function toHex(c: RGBA): string | undefined {
  if (c === undefined || c === null) return undefined
  if (typeof c === "string") return c.toUpperCase()
  const h = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0").toUpperCase()
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`
}

interface SpanInfo { text: string; fg?: string; bg?: string }
const lines: SpanInfo[][] = spans.lines.map((line: { spans?: { text: string; fg?: RGBA; bg?: RGBA }[] }) =>
  (line.spans ?? []).map((s) => ({ text: s.text, fg: toHex(s.fg), bg: toHex(s.bg) })),
)

// Flatten to per-cell color lookup: walk spans accumulating cell offsets.
import { cellWidth } from "../src/lib/measure.ts"
interface Cell { fg?: string; bg?: string }
function cellAt(row: number, col: number): Cell {
  const line = lines[row]
  if (!line) return {}
  let x = 0
  for (const s of line) {
    const w = cellWidth(s.text)
    if (col >= x && col < x + w) return { fg: s.fg, bg: s.bg }
    x += w
  }
  return {}
}
function textAt(row: number, col: number): string {
  const line = lines[row]
  if (!line) return ""
  let x = 0
  for (const s of line) {
    const w = cellWidth(s.text)
    if (col >= x && col < x + w) return s.text.slice(col - x, col - x + 1)
    x += w
  }
  return " "
}

const failures: string[] = []
function check(name: string, cond: boolean, detail: string) {
  if (!cond) failures.push(`${name}: ${detail}`)
}

// Row map (158×50, class A):
//  1 frame top · 2 header · 3 header rule · 5-19 panels row 1 · 21 gap
//  22-35 panels row 2 · 37-46 activity · 48 footer rule · 49 footer · 50 frame

// 1. Header brand mark is accent — header content is row 1 (row 0 = frame top border)
const brandCell = cellAt(1, 3)
check("header.mark.fg", brandCell.fg === LIGHT.accent.main, `fg=${brandCell.fg} want ${LIGHT.accent.main}`)

// 2. Header sits on canvas
check("header.bg", cellAt(1, 20).bg === LIGHT.bg.canvas || cellAt(1, 20).bg === undefined, `bg=${cellAt(1, 20).bg}`)

// 3. Panel border color — find "┌" on the first panel row
let panelTopRow = -1
for (let r = 4; r < 8; r++) {
  if (textAt(r, 3) === "┌") { panelTopRow = r; break }
}
check("panel.toprow.found", panelTopRow > 0, "no panel top border found in rows 4..7")
if (panelTopRow > 0) {
  const c = cellAt(panelTopRow, 3)
  check("panel.border.fg", c.fg === LIGHT.rule.default, `fg=${c.fg} want ${LIGHT.rule.default}`)
}

// 4. Panel surface — interior of Treasury panel
if (panelTopRow > 0) {
  const c = cellAt(panelTopRow + 1, 4)
  check("panel.surface.bg", c.bg === LIGHT.bg.surface, `bg=${c.bg} want ${LIGHT.bg.surface}`)
}

// 5. Bar fill/track on a pledge progress row (Your Member Value panel, right column).
//    Find the row containing "Pledge #7f3a2e", then the bar row under it.
let pledgeRow = -1
for (let r = 0; r < 50; r++) {
  const line = lines[r]?.map((s) => s.text).join("") ?? ""
  if (line.includes("Pledge #7f3a2e")) { pledgeRow = r; break }
}
check("pledge.row.found", pledgeRow > 0, "Pledge #7f3a2e row not found")
if (pledgeRow > 0) {
  const barRow = pledgeRow + 1
  // The bar starts after the panel's left border + padding: find first █
  let firstBar = -1
  const line = lines[barRow] ?? []
  let x = 0
  for (const s of line) {
    if (s.text.includes("█")) { firstBar = x + s.text.indexOf("█"); break }
    x += cellWidth(s.text)
  }
  check("bar.found", firstBar > 0, "no █ on pledge bar row")
  if (firstBar > 0) {
    const fill = cellAt(barRow, firstBar)
    check("bar.fill.fg", fill.fg === LIGHT.accent.main, `fill fg=${fill.fg} want ${LIGHT.accent.main}`)
    // Track: last █ on the row (62% fill → right side is track)
    const full = line.map((s) => s.text).join("")
    const lastBar = full.lastIndexOf("█")
    const track = cellAt(barRow, lastBar)
    check("bar.track.fg", track.fg === LIGHT.rule.faint, `track fg=${track.fg} want ${LIGHT.rule.faint}`)
  }
}

// 6. Active nav tab — footer row, "1 Dashboard" should be accent bg + inverse ink
let footerRow = -1
for (let r = 44; r < 50; r++) {
  const line = lines[r]?.map((s) => s.text).join("") ?? ""
  if (line.includes("1 Dashboard")) { footerRow = r; break }
}
check("footer.found", footerRow > 0, "footer nav row not found")
if (footerRow > 0) {
  const line = lines[footerRow]
  let x = 0
  let found = false
  for (const s of line) {
    if (s.text.includes("1 Dashboard")) {
      const col = x + s.text.indexOf("1 Dashboard")
      const c = cellAt(footerRow, col + 2)
      check("footer.active.bg", c.bg === LIGHT.accent.main, `bg=${c.bg} want ${LIGHT.accent.main}`)
      check("footer.active.fg", c.fg === LIGHT.ink.inverse, `fg=${c.fg} want ${LIGHT.ink.inverse}`)
      found = true
      break
    }
    x += cellWidth(s.text)
  }
  check("footer.active.found", found, "active tab span not found")
}

// 7. Backend badge — "SIMULATION" span should be accent-soft bg
let headerRow = -1
for (let r = 1; r < 4; r++) {
  const line = lines[r]?.map((s) => s.text).join("") ?? ""
  if (line.includes("SIMULATION")) { headerRow = r; break }
}
check("badge.found", headerRow > 0, "SIMULATION badge not found")
if (headerRow > 0) {
  const line = lines[headerRow]
  let x = 0
  for (const s of line) {
    if (s.text.includes("SIMULATION")) {
      const col = x + s.text.indexOf("SIMULATION")
      const c = cellAt(headerRow, col + 1)
      check("badge.bg", c.bg === LIGHT.accent.soft, `bg=${c.bg} want ${LIGHT.accent.soft}`)
      break
    }
    x += cellWidth(s.text)
  }
}

// 8. Activity: INFO level muted, timestamp faint
let actRow = -1
for (let r = 30; r < 50; r++) {
  const line = lines[r]?.map((s) => s.text).join("") ?? ""
  if (line.includes("node_init")) { actRow = r; break }
}
check("activity.found", actRow > 0, "node_init row not found")
if (actRow > 0) {
  const line = lines[actRow]
  let x = 0
  for (const s of line) {
    if (s.text.includes("INFO")) {
      const c = cellAt(actRow, x + s.text.indexOf("INFO"))
      check("activity.info.fg", c.fg === LIGHT.ink.muted, `fg=${c.fg} want ${LIGHT.ink.muted}`)
      break
    }
    x += cellWidth(s.text)
  }
}

if (failures.length > 0) {
  console.log(`COLOR VERIFY: ${failures.length} FAILURE(S)`)
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exit(1)
}
console.log("COLOR VERIFY: all checks passed")
await bridge.stop()
setup.renderer.destroy()
process.exit(0)
