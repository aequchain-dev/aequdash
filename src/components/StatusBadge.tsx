/**
 * aequdash — src/components/StatusBadge.tsx
 *
 * Backend status badge (guide §7, §18). Filled accent chip, always explicit:
 *
 *   [ JULIA LIVE ]   [ SIMULATION ]   [ STARTING ]   [ ERROR ]
 *
 * Color + text, never color alone. One quiet vocabulary.
 */

import { THEME } from "../lib/theme.ts"
import type { BridgeStatus } from "../lib/types.ts"
import { T } from "./T.tsx"

export function badgeColors(status: BridgeStatus): { fg: string; bg: string } {
  switch (status) {
    case "ready":      return { fg: THEME.ink.inverse, bg: THEME.accent.main }
    case "simulating": return { fg: THEME.ink.inverse, bg: THEME.accent.soft }
    case "starting":
    case "compiling":  return { fg: THEME.ink.inverse, bg: THEME.status.info }
    case "error":      return { fg: THEME.ink.inverse, bg: THEME.status.error }
    case "stopped":    return { fg: THEME.ink.inverse, bg: THEME.ink.faint }
  }
}

export function StatusBadge({ status, label }: { status: BridgeStatus; label: string }) {
  const { fg, bg } = badgeColors(status)
  return (
    <T color={fg} bg={bg} bold>{` ${label} `}</T>
  )
}
