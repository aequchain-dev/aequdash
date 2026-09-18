/**
 * aequdash — src/lib/layout.ts
 *
 * Responsive capability classes (guide §13). Terminal dimensions are
 * first-class state; layout reflows through five classes:
 *
 *   A  ≥140 cols, ≥38 rows   canonical 3-column dashboard
 *   B  100–139 cols, ≥34     3 columns, tightened
 *   C  80–99 cols            2 columns
 *   D  60–79 cols            1 column
 *   E  <60 cols or <18 rows  minimum viable: header + stacked essentials
 *
 * No fixed pixel canvas anywhere — only these classes and flexbox.
 */

export type LayoutClass = "A" | "B" | "C" | "D" | "E"

export function classifyLayout(width: number, height: number): LayoutClass {
  if (width < 60 || height < 18) return "E"
  if (width < 80) return "D"
  if (width < 100) return "C"
  if (width < 140 || height < 38) return "B"
  return "A"
}

/** Dashboard grid columns per class (guide §13). */
export function dashboardColumns(cls: LayoutClass): 1 | 2 | 3 {
  switch (cls) {
    case "A":
    case "B": return 3
    case "C": return 2
    case "D":
    case "E": return 1
  }
}

/**
 * Dashboard panel display order (guide §13.1 priority list):
 * Treasury, Members, Member Value, Volume, Pledges, Spend Limit, Activity.
 */
export const DASHBOARD_PANEL_ORDER = [
  "treasury",
  "members",
  "memberValue",
  "volume",
  "pledges",
  "spendLimit",
] as const

export type DashboardPanelId = typeof DASHBOARD_PANEL_ORDER[number]

/** Row heights (in terminal rows) for the canonical Class-A composition. */
export interface DashboardGeometry {
  panelRowHeight: number   // height of each of the two metric rows
  activityMin: number      // minimum activity panel height
  gap: number
}

export function dashboardGeometry(cls: LayoutClass, _width: number, _height: number): DashboardGeometry {
  // Panel rows hold 13 content rows + 2 border rows = 15 everywhere.
  // Smaller classes scroll rather than compress panel internals (guide §14:
  // "Do not solve small terminals by shrinking all text. Reflow first.").
  switch (cls) {
    case "A": return { panelRowHeight: 15, activityMin: 8, gap: 1 }
    case "B": return { panelRowHeight: 15, activityMin: 6, gap: 1 }
    case "C": return { panelRowHeight: 15, activityMin: 6, gap: 1 }
    case "D": return { panelRowHeight: 15, activityMin: 5, gap: 1 }
    case "E": return { panelRowHeight: 12, activityMin: 4, gap: 0 }
  }
}
