/**
 * aequdash — tests/qr.test.ts
 *
 * Structural verification of the terminal QR renderer: correct dimensions
 * (21 + 4·(version−1) modules), uniform row widths, quiet zone, finder
 * pattern anchors, and determinism. Scan-level correctness is delegated to
 * the `qrcode` package's own conformance (that's why we didn't hand-roll).
 */

import { describe, test, expect } from "bun:test"
import { qrMatrix } from "../src/components/Qr.tsx"

describe("QR terminal renderer", () => {
  test("matrix dimensions follow QR version geometry", () => {
    const { size, rows } = qrMatrix("aeq://meadow-x1y2z3.abcdef12?e=203.0.113.9:7920&t=tok")
    expect(size).toBeGreaterThanOrEqual(21)
    expect((size - 21) % 4).toBe(0) // version geometry: 21, 25, 29, …
    expect(rows.length).toBe(size + 4) // 2-module quiet zone top+bottom
    for (const row of rows) expect(row.length).toBe(size + 4) // …and left+right
  })

  test("finder patterns anchor the three corners", () => {
    const { rows } = qrMatrix("HELLO")
    const q = 2 // quiet zone offset
    // Top-left finder: outer ring dark, inner 3x3 dark, ring separator light
    const dark = (x: number, y: number) => rows[y + q][x + q] === "█"
    for (let i = 0; i <= 6; i++) {
      expect(dark(i, 0)).toBe(true)  // top edge
      expect(dark(0, i)).toBe(true)  // left edge
      expect(dark(6, i)).toBe(true)  // right edge of finder
      expect(dark(i, 6)).toBe(true)  // bottom edge of finder
    }
    expect(dark(2, 2)).toBe(true)
    expect(dark(4, 4)).toBe(true)
    // Top-right and bottom-left finder corners
    const n = rows.length - 4 // matrix size
    expect(dark(n - 7, 0)).toBe(true)
    expect(dark(n - 1, 6)).toBe(true)
    expect(dark(0, n - 7)).toBe(true)
    expect(dark(6, n - 1)).toBe(true)
  })

  test("quiet zone is genuinely empty", () => {
    const { rows } = qrMatrix("quiet-zone-check")
    const w = rows[0].length
    expect(rows[0].trim()).toBe("")
    expect(rows[1].trim()).toBe("")
    expect(rows[rows.length - 1].trim()).toBe("")
    expect(rows[rows.length - 2].trim()).toBe("")
    for (const row of rows) {
      expect(row.slice(0, 2).trim()).toBe("")
      expect(row.slice(w - 2).trim()).toBe("")
    }
  })

  test("deterministic: same input → identical matrix; different input → different matrix", () => {
    const a1 = qrMatrix("aeq://same")
    const a2 = qrMatrix("aeq://same")
    const b = qrMatrix("aeq://different")
    expect(a1.rows.join("\n")).toBe(a2.rows.join("\n"))
    expect(a1.rows.join("\n")).not.toBe(b.rows.join("\n"))
  })
})
