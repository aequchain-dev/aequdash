/**
 * aequdash — tests/layout.test.ts
 *
 * Responsive capability classes (guide §13).
 */

import { describe, test, expect } from "bun:test"
import { classifyLayout, dashboardColumns, DASHBOARD_PANEL_ORDER } from "../src/lib/layout.ts"

describe("classifyLayout", () => {
  test("class A: expansive", () => {
    expect(classifyLayout(158, 50)).toBe("A")
    expect(classifyLayout(140, 38)).toBe("A")
    expect(classifyLayout(200, 60)).toBe("A")
  })
  test("class B: standard", () => {
    expect(classifyLayout(120, 40)).toBe("B")
    expect(classifyLayout(100, 34)).toBe("B")
    expect(classifyLayout(139, 38)).toBe("B")
    // wide but short → B (height matters)
    expect(classifyLayout(158, 30)).toBe("B")
  })
  test("class C: compact 2-col", () => {
    expect(classifyLayout(90, 40)).toBe("C")
    expect(classifyLayout(80, 30)).toBe("C")
  })
  test("class D: narrow 1-col", () => {
    expect(classifyLayout(70, 40)).toBe("D")
    expect(classifyLayout(60, 24)).toBe("D")
  })
  test("class E: minimum viable", () => {
    expect(classifyLayout(50, 40)).toBe("E")
    expect(classifyLayout(120, 12)).toBe("E")  // too short regardless of width
    expect(classifyLayout(59, 17)).toBe("E")
  })
})

describe("dashboardColumns", () => {
  test("3/2/1 mapping", () => {
    expect(dashboardColumns("A")).toBe(3)
    expect(dashboardColumns("B")).toBe(3)
    expect(dashboardColumns("C")).toBe(2)
    expect(dashboardColumns("D")).toBe(1)
    expect(dashboardColumns("E")).toBe(1)
  })
})

describe("panel order (guide §13.1 priority)", () => {
  test("treasury first, spend last", () => {
    expect(DASHBOARD_PANEL_ORDER[0]).toBe("treasury")
    expect(DASHBOARD_PANEL_ORDER[5]).toBe("spendLimit")
    expect(DASHBOARD_PANEL_ORDER).toHaveLength(6)
  })
})
