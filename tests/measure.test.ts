/**
 * aequdash — tests/measure.test.ts
 *
 * Terminal-cell measurement correctness (guide §15): display width, not
 * string length; grapheme-safe truncation; exact alignment math.
 */

import { describe, test, expect } from "bun:test"
import { cellWidth, truncateCells, padStart, padEnd, justifyRow } from "../src/lib/measure.ts"

describe("cellWidth", () => {
  test("ASCII", () => {
    expect(cellWidth("hello")).toBe(5)
    expect(cellWidth("")).toBe(0)
  })
  test("box-drawing chars are 1 cell", () => {
    expect(cellWidth("┌─┐│└┘")).toBe(6)
    expect(cellWidth("█░")).toBe(2)
  })
  test("wide CJK counts 2", () => {
    expect(cellWidth("中")).toBe(2)
    expect(cellWidth("日本語")).toBe(6)
  })
  test("combining marks add 0", () => {
    expect(cellWidth("é")).toBe(1) // e + combining acute
  })
  test("strips ANSI SGR", () => {
    expect(cellWidth("\x1b[31mhello\x1b[0m")).toBe(5)
  })
})

describe("truncateCells", () => {
  test("no-op when fits", () => {
    expect(truncateCells("abc", 5)).toBe("abc")
  })
  test("truncates with ellipsis", () => {
    expect(truncateCells("abcdef", 4)).toBe("abc…")
  })
  test("width 1 is just ellipsis", () => {
    expect(truncateCells("abcdef", 1)).toBe("…")
  })
  test("never splits a grapheme", () => {
    const s = "ab中cd"
    const t = truncateCells(s, 4) // 4 cells: "ab" (2) + "中" (2) would be 4, but ellipsis needs 1 → "ab" + "…"
    expect(t).toBe("ab…")
  })
  test("zero width", () => {
    expect(truncateCells("abc", 0)).toBe("")
  })
})

describe("padding", () => {
  test("padStart right-aligns", () => {
    expect(padStart("42", 5)).toBe("   42")
  })
  test("padEnd left-aligns", () => {
    expect(padEnd("42", 5)).toBe("42   ")
  })
  test("padStart truncates overflow", () => {
    expect(padStart("123456", 4)).toBe("123…")
  })
})

describe("justifyRow", () => {
  test("label left, value right, exact width", () => {
    const row = justifyRow("Label", "42.00", 20)
    expect(cellWidth(row)).toBe(20)
    expect(row.startsWith("Label")).toBe(true)
    expect(row.endsWith("42.00")).toBe(true)
  })
  test("squeezes label, never the value", () => {
    const row = justifyRow("A very long label indeed", "1,248,672.31", 20)
    expect(cellWidth(row)).toBe(20)
    expect(row.endsWith("1,248,672.31")).toBe(true)
    expect(row).toContain("…")
  })
})
