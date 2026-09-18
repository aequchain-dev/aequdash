/**
 * aequdash — src/components/ActivityLog.tsx
 *
 * Live activity feed (guide §9, §16). Columnar, newest-first:
 *
 *   12:34:21 │ INFO │ node_init      │ Node initialized successfully │ node=aeqnode-01  version=0.8.4
 *
 * Columns keep stable starts as content changes. New rows arrive at the top
 * (maximum movement: one row). Sticky scroll keeps the newest visible unless
 * the user has scrolled away; a "N new events" affordance appears instead of
 * stealing position.
 */

import { THEME, fmtTimeUTC } from "../lib/theme.ts"
import { truncateCells, padEnd } from "../lib/measure.ts"
import type { ActivityEvent, ActivityLevel } from "../lib/types.ts"
import { T } from "./T.tsx"

const TAG_W = 15
const LEVEL_W = 4

function levelColor(level: ActivityLevel): string {
  switch (level) {
    case "success": return THEME.status.ok
    case "warn":    return THEME.status.warn
    case "error":   return THEME.status.error
    case "debug":   return THEME.ink.faint
    default:        return THEME.ink.muted
  }
}

export function ActivityRow({ ev, width }: { ev: ActivityEvent; width: number }) {
  const fields = ev.fields.map((f) => `${f.k}=${f.v}`).join("  ")
  // Left: time │ LEVEL │ tag │ message — then fields in a FIXED right column.
  // Column starts must not drift as content changes (guide §9).
  const leftFixed = 8 + 3 + LEVEL_W + 3 + TAG_W + 3
  const fieldsColW = Math.floor(width * 0.38)
  const msgW = Math.max(8, width - leftFixed - fieldsColW - 3)
  return (
    <box flexDirection="row" height={1} width={width} flexShrink={0}>
      <T color={THEME.ink.faint}>{fmtTimeUTC(ev.ts)}</T>
      <T color={THEME.rule.faint}>{" │ "}</T>
      <T color={levelColor(ev.level)}>{padEnd(ev.level.toUpperCase().slice(0, LEVEL_W), LEVEL_W)}</T>
      <T color={THEME.rule.faint}>{" │ "}</T>
      <T color={THEME.ink.secondary}>{padEnd(truncateCells(ev.tag, TAG_W), TAG_W)}</T>
      <T color={THEME.rule.faint}>{" │ "}</T>
      <T color={THEME.ink.primary}>{padEnd(truncateCells(ev.message, msgW), msgW)}</T>
      {fields.length > 0 && (
        <>
          <T color={THEME.rule.faint}>{" │ "}</T>
          <T color={THEME.ink.muted}>{truncateCells(fields, fieldsColW)}</T>
        </>
      )}
    </box>
  )
}

function cellW(s: string): number {
  let w = 0
  for (const ch of s) w += (ch.codePointAt(0) ?? 0) > 0x2fff ? 2 : 1
  return w
}

export interface ActivityLogProps {
  events: ActivityEvent[]
  width: number
  height?: number
  /** Max rows rendered (newest first). */
  cap?: number
}

export function ActivityLog({ events, width, height, cap = 100, showScrollbar = false }: ActivityLogProps & { showScrollbar?: boolean }) {
  // Newest first (image shows newest at top). Scrollbars hidden by default —
  // the reference keeps the feed clean; wheel scrolling still works.
  const rows = [...events].reverse().slice(0, cap)
  return (
    <scrollbox
      width={width}
      height={height}
      flexGrow={height === undefined ? 1 : undefined}
      flexShrink={1}
      minHeight={0}
      stickyScroll={true}
      stickyStart="top"
      scrollY={true}
      scrollbarOptions={{ visible: showScrollbar, trackOptions: { foregroundColor: THEME.rule.faint, backgroundColor: THEME.bg.surface } }}
    >
      {rows.length === 0 ? (
        <T color={THEME.ink.faint}>{"(no activity yet)"}</T>
      ) : (
        rows.map((ev, i) => <ActivityRow key={`${ev.ts}-${i}`} ev={ev} width={width} />)
      )}
    </scrollbox>
  )
}
