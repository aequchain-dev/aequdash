/**
 * aequdash — src/components/Panel.tsx
 *
 * The aequchain panel — principal component grammar (guide §8).
 *
 * Frame anatomy (exact reference composition):
 *
 *   ┌─ [] Title ─────────────────────────────── Meta ─┐   ← top border row
 *   │  content (paddingX 1, column)                    │   ← native side borders
 *   └───────────────────────────────────────────────────┘   ← bottom border row
 *
 * The top border is hand-composed (OpenTUI's box title can't carry both a
 * left title and a right meta label): `─ [] Title ` left segment, `─` fill,
 * ` Meta ` right segment. Side/bottom borders use native box borders with
 * border={["left","right"]} / a bottom text row for exact corner control.
 *
 * Geometry:
 *   • width is explicit (computed by the caller from layout classes)
 *   • inner content width = width - 2 (borders) - 2 * paddingX
 *   • border style family: single-line, color rule.default
 */

import type { ReactNode } from "react"
import { THEME, SPACE } from "../lib/theme.ts"
import { cellWidth, truncateCells } from "../lib/measure.ts"
import { T } from "./T.tsx"

export interface PanelProps {
  title: string
  meta?: string
  /** Panel marker glyph prefix (default "[]"). Activity uses "( )". */
  marker?: string
  width: number
  height?: number
  flexGrow?: number
  children?: ReactNode
  /** Override surface/ink (rare — e.g. highlighted panel). */
  surface?: string
  borderColor?: string
  titleColor?: string
  metaColor?: string
  paddingX?: number
}

/** Compose the top border string segments for a given width. */
export function composeTopBorder(opts: {
  width: number
  title: string
  meta?: string
  marker?: string
}): { left: string; fill: string; right: string; marker: string; title: string; meta: string } {
  const w = Math.max(8, opts.width)
  const marker = opts.marker ?? "[]"
  // Right segment: " Meta ─" when meta present, else "─"
  let meta = opts.meta ?? ""
  let title = opts.title
  // Budget: ┌ + "─ " + marker+" " + title + " " + fill + " " + meta + " ─" + ┐
  const fixed = 1 + 2 + cellWidth(marker) + 1 + 1 + (meta ? 2 + 1 : 0) + 1
  //                      └─ "─ " + marker + " " + title + " " ... " " + meta + " ─"
  let availTitle = w - fixed - cellWidth(meta)
  if (availTitle < 4 && meta) { meta = ""; availTitle = w - fixed - 0 }
  title = truncateCells(title, Math.max(1, availTitle))
  const leftInner = ` ${marker} ${title} `
  const rightInner = meta ? ` ${meta} ─` : "─"
  const fillW = Math.max(0, w - 2 - 1 - cellWidth(leftInner) - cellWidth(rightInner))
  return {
    left: "─",                       // after ┌
    fill: "─".repeat(fillW),
    right: rightInner,
    marker,
    title,
    meta,
  }
}

export function Panel({
  title,
  meta,
  marker,
  width,
  height,
  flexGrow,
  children,
  surface,
  borderColor,
  titleColor,
  metaColor,
  paddingX = SPACE.padX,
}: PanelProps) {
  const surf = surface ?? THEME.bg.surface
  const bc = borderColor ?? THEME.rule.default
  const tc = titleColor ?? THEME.ink.primary
  const mc = metaColor ?? THEME.ink.muted

  const w = Math.max(8, width)
  const top = composeTopBorder({ width: w, title, meta, marker })

  return (
    <box flexDirection="column" width={w} height={height} flexGrow={flexGrow} backgroundColor={surf} overflow="hidden">
      {/* Top border: ┌─ [] Title ─────── Meta ─┐ */}
      <box height={1} flexShrink={0} flexDirection="row">
        <T color={bc}>{"┌─"}</T>
        <T color={THEME.ink.faint}>{`${top.marker} `}</T>
        <T color={tc} bold>{top.title}</T>
        <T color={bc}>{" "}</T>
        <T color={bc}>{top.fill}</T>
        {top.meta ? (
          <>
            <T color={mc}>{` ${top.meta} `}</T>
            <T color={bc}>{"─"}</T>
          </>
        ) : (
          <T color={bc}>{"─"}</T>
        )}
        <T color={bc}>{"┐"}</T>
      </box>

      {/* Content with native side borders */}
      <box
        flexGrow={1}
        border={["left", "right"]}
        borderColor={bc}
        backgroundColor={surf}
        paddingX={paddingX}
        flexDirection="column"
        overflow="hidden"
      >
        {children}
      </box>

      {/* Bottom border */}
      <box height={1} flexShrink={0}>
        <T color={bc}>{`└${"─".repeat(Math.max(0, w - 2))}┘`}</T>
      </box>
    </box>
  )
}

/** Convenience: inner content width for a panel of outer width w. */
export function panelInnerWidth(w: number, paddingX: number = SPACE.padX): number {
  return Math.max(1, w - 2 - paddingX * 2)
}
