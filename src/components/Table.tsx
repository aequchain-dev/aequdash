/**
 * aequdash — src/components/Table.tsx
 *
 * Aligned table primitive (guide §10.2): header row, rule, data rows.
 * Columns declare fixed widths (cells); numbers right-align. The selected
 * row uses a low-contrast surface shift (bg.active) — never bright inversion.
 *
 * All widths are terminal cells via measure.ts; truncation is
 * grapheme-safe and preserves alignment for non-ASCII content.
 */

import { THEME } from "../lib/theme.ts"
import { padEnd, padStart, truncateCells } from "../lib/measure.ts"
import { T } from "./T.tsx"

export interface Column<T> {
  key: string
  label: string
  width: number
  align?: "left" | "right"
  render: (row: T) => string
}

export interface TableProps<T> {
  columns: Column<T>[]
  rows: T[]
  /** Row key extractor for React keys + optional active highlight. */
  rowKey: (row: T) => string
  /** Mark one row as selected (low-contrast active surface). */
  activeKey?: string
  width?: number
  maxRows?: number
}

export function Table<T>({ columns, rows, rowKey, activeKey, width, maxRows }: TableProps<T>) {
  const shown = maxRows ? rows.slice(0, maxRows) : rows
  return (
    <box flexDirection="column" width={width} flexShrink={0}>
      {/* Header */}
      <box flexDirection="row" height={1}>
        {columns.map((c, i) => (
          <T key={c.key} color={THEME.ink.muted}>
            {(i > 0 ? "  " : "") + (c.align === "right" ? padStart(c.label, c.width) : padEnd(c.label, c.width))}
          </T>
        ))}
      </box>
      {/* Header rule */}
      <box flexDirection="row" height={1}>
        {columns.map((c, i) => (
          <T key={c.key} color={THEME.rule.faint}>
            {(i > 0 ? "  " : "") + "─".repeat(c.width)}
          </T>
        ))}
      </box>
      {/* Data rows */}
      {shown.map((row) => {
        const key = rowKey(row)
        const active = key === activeKey
        return (
          <box key={key} flexDirection="row" height={1} backgroundColor={active ? THEME.bg.active : undefined} flexShrink={0}>
            {columns.map((c, i) => {
              const raw = c.render(row)
              const txt = c.align === "right"
                ? padStart(truncateCells(raw, c.width), c.width)
                : padEnd(truncateCells(raw, c.width), c.width)
              return (
                <T key={c.key} color={active ? THEME.ink.primary : THEME.ink.secondary}>
                  {(i > 0 ? "  " : "") + txt}
                </T>
              )
            })}
          </box>
        )
      })}
      {shown.length === 0 && (
        <box height={1}>
          <T color={THEME.ink.faint}>{"(no records)"}</T>
        </box>
      )}
    </box>
  )
}
