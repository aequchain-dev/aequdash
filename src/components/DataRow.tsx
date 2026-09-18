/**
 * aequdash — src/components/DataRow.tsx
 *
 * DataRow — the label/value row, the workhorse of the panel system:
 *
 *   Network Denomination                               AEQ
 *   AEQ (native)                    1,248,672.31 (43.8%)
 *
 * Label in muted ink; value right-aligned in secondary; optional suffix
 * (e.g. "(43.8%)") in faint. Flexbox performs justification; column widths
 * are caller-controlled so numeric columns stay tabular.
 *
 * Metric — the dominant panel value row:
 *
 *   $ 2,847,563.42                    ≈ 1,248,672.31 AEQ
 */

import type { ReactNode } from "react"
import { THEME } from "../lib/theme.ts"
import { truncateCells, cellWidth } from "../lib/measure.ts"
import { T } from "./T.tsx"

export interface DataRowProps {
  label: string
  value: string
  /** Optional trailing annotation, rendered faint after the value. */
  suffix?: string
  width?: number
  valueColor?: string
  labelColor?: string
  bold?: boolean
}

export function DataRow({ label, value, suffix, width, valueColor, labelColor, bold }: DataRowProps) {
  const lc = labelColor ?? THEME.ink.muted
  const vc = valueColor ?? THEME.ink.secondary
  const suffixStr = suffix ? ` ${suffix}` : ""
  const maxLabel = width ? Math.max(4, width - cellWidth(value) - cellWidth(suffixStr) - 1) : undefined
  const lbl = maxLabel ? truncateCells(label, maxLabel) : label
  return (
    <box flexDirection="row" height={1} width={width} flexShrink={0}>
      <T color={lc}>{lbl}</T>
      <box flexGrow={1} />
      <T color={vc} bold={bold}>{value}</T>
      {suffix && <T color={THEME.ink.faint}>{suffixStr}</T>}
    </box>
  )
}

export interface MetricProps {
  /** Primary value, e.g. "$ 2,847,563.42" — bold, dominant. */
  value: string
  /** Optional right-side approximation, e.g. "≈ 1,248,672.31 AEQ" — muted. */
  approx?: string
  /** Optional caption below, e.g. "active members". */
  caption?: string
  width?: number
}

export function Metric({ value, approx, caption, width }: MetricProps) {
  return (
    <box flexDirection="column" width={width} flexShrink={0}>
      <box flexDirection="row" height={1} width={width}>
        <T color={THEME.ink.primary} bold>{value}</T>
        {approx && (
          <>
            <box flexGrow={1} />
            <T color={THEME.ink.muted}>{approx}</T>
          </>
        )}
      </box>
      {caption && (
        <box height={1}>
          <T color={THEME.ink.muted}>{caption}</T>
        </box>
      )}
    </box>
  )
}

/** Section header inside a panel — quiet label, e.g. "Member Distribution". */
export function SectionHeader({ label, width }: { label: string; width?: number }) {
  return (
    <box height={1} width={width} flexShrink={0}>
      <T color={THEME.ink.muted}>{label}</T>
    </box>
  )
}

/** Blank spacer row — intentional negative space (guide §8.2). */
export function Blank() {
  return <box height={1} flexShrink={0} />
}

/**
 * StatSplit — two stat columns with a fixed 2-cell gutter:
 *
 *   Total Payments        312   │  Avg Latency          23ms
 *
 * Children of each column should be DataRow; widths are passed down so
 * values right-align at each column's own edge (never collide).
 */
export function StatSplit({ left, right, width, leftWidth }: {
  left: ReactNode
  right: ReactNode
  width: number
  leftWidth?: number
}) {
  const lw = leftWidth ?? Math.floor(width / 3)
  return (
    <box flexDirection="row" width={width} flexShrink={0}>
      <box flexDirection="column" width={lw} flexShrink={0}>
        {left}
      </box>
      <box flexDirection="column" flexGrow={1} paddingLeft={2} overflow="hidden">
        {right}
      </box>
    </box>
  )
}
