/**
 * aequdash — src/components/Rule.tsx
 *
 * Horizontal rule — the primary divider in the aequchain geometry language.
 * `─` repeated across the given width, optional inline label:
 *
 *   ──────────────────────────────
 *   ── Section Label ─────────────
 */

import { THEME } from "../lib/theme.ts"
import { cellWidth, truncateCells } from "../lib/measure.ts"
import { T } from "./T.tsx"

export interface RuleProps {
  width: number
  label?: string
  color?: string
  labelColor?: string
}

export function Rule({ width, label, color, labelColor }: RuleProps) {
  const c = color ?? THEME.rule.soft
  const w = Math.max(0, width)
  if (!label) {
    return <T color={c}>{"─".repeat(w)}</T>
  }
  const lbl = truncateCells(label, Math.max(0, w - 4))
  const fill = Math.max(0, w - 2 - cellWidth(lbl) - 1)
  return (
    <box flexDirection="row" height={1}>
      <T color={c}>{"── "}</T>
      <T color={labelColor ?? THEME.ink.muted}>{lbl}</T>
      <T color={c}>{` ${"─".repeat(fill)}`}</T>
    </box>
  )
}
