/**
 * aequdash — src/components/Bars.tsx
 *
 * Bar primitives (guide §10.5): restrained, narrow, aligned with numbers.
 *
 *   Bar       — horizontal progress bar: filled █ in accent, track █ in faint
 *   DistBar   — distribution row: label · pct · bar · optional count
 *   BarRow    — label + right-aligned value + full-width bar beneath
 *
 * Track uses solid █ in rule.faint (the reference renders a light solid
 * track, not a shaded ░ pattern).
 */

import { THEME } from "../lib/theme.ts"
import { padStart, padEnd, truncateCells, cellWidth } from "../lib/measure.ts"
import { T } from "./T.tsx"

export interface BarProps {
  pct: number            // 0..100
  width: number          // total cells
  fillColor?: string
  trackColor?: string
}

export function Bar({ pct, width, fillColor, trackColor }: BarProps) {
  const w = Math.max(1, width)
  const clamped = Math.max(0, Math.min(100, pct))
  const filled = Math.round((clamped / 100) * w)
  const track = w - filled
  return (
    <box flexDirection="row" height={1} width={w} flexShrink={0}>
      {filled > 0 && <T color={fillColor ?? THEME.accent.main}>{"█".repeat(filled)}</T>}
      {track > 0 && <T color={trackColor ?? THEME.rule.faint}>{"█".repeat(track)}</T>}
    </box>
  )
}

/**
 * Distribution row (Members / Pledges panels):
 *   North America    28.4%  ████████████░░░░░░░░░░
 *   Infrastructure   32.4%  ████████████████░░░░  80
 */
export interface DistBarProps {
  label: string
  pct: number            // 0..100
  width: number          // total row width in cells
  count?: number         // optional right-aligned count
  labelWidth?: number
  barWidth?: number
}

export function DistBar({ label, pct, width, count, labelWidth, barWidth }: DistBarProps) {
  const countStr = count !== undefined ? String(count) : ""
  const countW = count !== undefined ? Math.max(3, cellWidth(countStr)) : 0
  const pctStr = `${pct.toFixed(1)}%`
  const pctW = 6 // "100.0%"
  const lblW = labelWidth ?? Math.min(16, Math.max(8, width - pctW - countW - (barWidth ?? 12) - 4))
  const bw = barWidth ?? Math.max(4, width - lblW - pctW - countW - 3)
  const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * bw)
  const track = bw - filled
  return (
    <box flexDirection="row" height={1} width={width} flexShrink={0}>
      <T color={THEME.ink.secondary}>{padEnd(truncateCells(label, lblW), lblW)}</T>
      <T color={THEME.ink.muted}>{padStart(pctStr, pctW)}</T>
      <T>{" "}</T>
      {filled > 0 && <T color={THEME.accent.main}>{"█".repeat(filled)}</T>}
      {track > 0 && <T color={THEME.rule.faint}>{"█".repeat(track)}</T>}
      {count !== undefined && (
        <T color={THEME.ink.muted}>{padStart(countStr, countW + 1)}</T>
      )}
    </box>
  )
}

/**
 * BarRow (Pledge Progress / Spend Limit):
 *   Pledge #7f3a2e              62%        1,240 / 2,000 AEQ
 *   ██████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░
 */
export interface BarRowProps {
  label: string
  pct: number
  rightValue: string
  width: number
  pctWidth?: number
}

export function BarRow({ label, pct, rightValue, width, pctWidth = 6 }: BarRowProps) {
  const pctStr = `${Math.round(pct)}%`
  return (
    <box flexDirection="column" width={width} flexShrink={0}>
      <box flexDirection="row" height={1} width={width}>
        <T color={THEME.ink.secondary}>{truncateCells(label, Math.max(4, width - pctWidth - cellWidth(rightValue) - 2))}</T>
        <box flexGrow={1} />
        <T color={THEME.ink.muted}>{padStart(pctStr, pctWidth)}</T>
        <T color={THEME.ink.secondary}>{`  ${rightValue}`}</T>
      </box>
      <Bar pct={pct} width={width} />
    </box>
  )
}
