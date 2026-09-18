/**
 * aequdash — tests/theme.test.ts
 *
 * Token fidelity (guide §5.1) and formatter correctness.
 */

import { describe, test, expect } from "bun:test"
import {
  LIGHT, DARK,
  fmt0, fmt2, fmtN, fmt4, fmtPct, fmtMoney, fmtApprox,
  fmtClock, fmtCountdown, fmtDays, shortHash, fmtBytes, fmtMs, fmtTps,
} from "../src/lib/theme.ts"

describe("light theme tokens (guide §5.1 exact)", () => {
  test("bg family", () => {
    expect(LIGHT.bg.canvas).toBe("#ECE5D8")
    expect(LIGHT.bg.surface).toBe("#F0E9DC")
    expect(LIGHT.bg.subtle).toBe("#E8E0D4")
    expect(LIGHT.bg.active).toBe("#E2D2CA")
  })
  test("ink family", () => {
    expect(LIGHT.ink.primary).toBe("#5E3C3C")
    expect(LIGHT.ink.secondary).toBe("#7B5B5A")
    expect(LIGHT.ink.muted).toBe("#967775")
    expect(LIGHT.ink.faint).toBe("#B69A94")
  })
  test("rule family", () => {
    expect(LIGHT.rule.default).toBe("#B88A88")
    expect(LIGHT.rule.soft).toBe("#D1B4AE")
    expect(LIGHT.rule.faint).toBe("#DED1C8")
  })
  test("accent + status", () => {
    expect(LIGHT.accent.main).toBe("#A86668")
    expect(LIGHT.accent.soft).toBe("#C58F8D")
    expect(LIGHT.status.ok).toBe("#6F8C78")
    expect(LIGHT.status.warn).toBe("#B38B5D")
    expect(LIGHT.status.error).toBe("#A15E61")
    expect(LIGHT.status.info).toBe("#6F808C")
  })
})

describe("dark theme (guide §5.3: same semantics, inverted luminance)", () => {
  test("has identical token structure", () => {
    expect(Object.keys(DARK.bg)).toEqual(Object.keys(LIGHT.bg))
    expect(Object.keys(DARK.ink)).toEqual(Object.keys(LIGHT.ink))
    expect(Object.keys(DARK.rule)).toEqual(Object.keys(LIGHT.rule))
    expect(Object.keys(DARK.accent)).toEqual(Object.keys(LIGHT.accent))
    expect(Object.keys(DARK.status)).toEqual(Object.keys(LIGHT.status))
  })
  test("dark canvas is darker than dark ink", () => {
    const lum = (hex: string) => {
      const n = parseInt(hex.slice(1), 16)
      const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    expect(lum(DARK.bg.canvas)).toBeLessThan(lum(DARK.ink.primary))
    expect(lum(LIGHT.bg.canvas)).toBeGreaterThan(lum(LIGHT.ink.primary))
  })
})

describe("formatters", () => {
  test("fmt2 groups + 2dp", () => {
    expect(fmt2(1248672.31)).toBe("1,248,672.31")
    expect(fmt2(0)).toBe("0.00")
  })
  test("fmt0 groups integers", () => {
    expect(fmt0(1248672)).toBe("1,248,672")
  })
  test("fmtN/fmt4 fixed precision", () => {
    expect(fmtN(2.2805, 4)).toBe("2.2805")
    expect(fmt4(0.0008)).toBe("0.0008")
  })
  test("fmtPct", () => {
    expect(fmtPct(43.8)).toBe("43.8%")
    expect(fmtPct(0.008012, 4)).toBe("0.0080%")
  })
  test("money + approx", () => {
    expect(fmtMoney("$", 2847563.42)).toBe("$ 2,847,563.42")
    expect(fmtApprox(1248672.31, "AEQ")).toBe("≈ 1,248,672.31 AEQ")
  })
  test("clock is UTC (snapshot determinism)", () => {
    expect(fmtClock(new Date("2026-09-16T12:34:27Z"))).toBe("12:34:27")
  })
  test("countdown", () => {
    expect(fmtCountdown(18 * 86400000 + 11 * 3600000 + 25 * 60000)).toBe("18d 11h 25m")
    expect(fmtCountdown(65 * 60000)).toBe("1h 5m")
    expect(fmtCountdown(-5)).toBe("—")
  })
  test("days", () => {
    expect(fmtDays(18.6)).toBe("18.6 days")
  })
  test("shortHash preserves recognizability", () => {
    const h = "0x" + "ab".repeat(32)
    expect(shortHash(h)).toBe("0xababab…abab")
    expect(shortHash("0x1234")).toBe("0x1234")
  })
  test("bytes / ms / tps", () => {
    expect(fmtBytes(42_500_000)).toBe("40.5 MB")
    expect(fmtMs(0.5)).toBe("<1ms")
    expect(fmtMs(23.4)).toBe("23ms")
    expect(fmtTps(3.2)).toBe("3.2")
  })
  test("non-finite safety", () => {
    expect(fmt2(NaN)).toBe("—")
    expect(fmt0(Infinity)).toBe("—")
  })
})
