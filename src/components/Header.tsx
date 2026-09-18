/**
 * aequdash — src/components/Header.tsx
 *
 * Application header band (guide §7) — one continuous baseline:
 *
 *   ⬡ aequchain │ Dashboard          Backend: [ JULIA LIVE ] │ Testnet │ Height: 1,248,672 │ 12:34:27
 *
 * Brand gets the strongest chromatic accent; the screen name stays attached
 * to the brand; backend status is always explicit; no large logo block.
 */

import { useStore } from "../state/store.tsx"
import { THEME, fmt0, fmtClock } from "../lib/theme.ts"
import { SCREEN_TITLES } from "../lib/types.ts"
import { cellWidth, truncateCells } from "../lib/measure.ts"
import { StatusBadge } from "./StatusBadge.tsx"
import { T } from "./T.tsx"
import { useTerminalDimensions } from "@opentui/react"

const IS_SNAPSHOT = process.env.AEQUDASH_SNAPSHOT === "1"

/**
 * Adaptive header (guide §14 width priority):
 *   screen identity → backend state → height → clock → network label
 * Lower-priority segments drop out as width shrinks; text never wraps or
 * overlaps. The status badge is always explicit and never truncated.
 */
export function Header() {
  const { status, statusLabel, snapshot, screen, clockISO } = useStore()
  const { width: tw } = useTerminalDimensions()

  const height = snapshot?.block_height ?? 0
  const network = snapshot?.network ?? "testnet"
  const iso = IS_SNAPSHOT && snapshot ? snapshot.server_time : clockISO
  const clock = fmtClock(new Date(iso))

  // Available content cells inside the header (app inset + frame + paddingX)
  const avail = Math.max(20, tw - 6)
  const badgeW = cellWidth(statusLabel) + 2

  // Priority 1+2: brand + screen, badge
  let leftW = cellWidth("⬡ aequchain │ ") + cellWidth(SCREEN_TITLES[screen])
  let brandFull = true
  if (leftW + badgeW > avail) {
    // shrink brand to mark only
    leftW = cellWidth("⬡ ") + cellWidth(SCREEN_TITLES[screen])
    brandFull = false
  }
  if (leftW + badgeW > avail) {
    // last resort: truncate screen name, keep badge
    leftW = cellWidth("⬡ ") + Math.max(4, avail - badgeW)
  }
  const screenLabel = brandFull
    ? SCREEN_TITLES[screen]
    : truncateCells(SCREEN_TITLES[screen], Math.max(4, avail - badgeW - 2))

  // Remaining budget for optional right-side segments
  const used = leftW + badgeW
  const rest = avail - used

  const segHeight = `Height: ${fmt0(height)}`
  const segClock = clock
  const segNet = network === "testnet" ? "Testnet" : network

  const showHeight = rest >= cellWidth(segHeight) + 3
  const afterHeight = rest - (showHeight ? cellWidth(segHeight) + 3 : 0)
  const showClock = afterHeight >= cellWidth(segClock) + 3
  const afterClock = afterHeight - (showClock ? cellWidth(segClock) + 3 : 0)
  const showNet = afterClock >= cellWidth(segNet) + 3
  const showBackendLabel = rest >= cellWidth("Backend: ") + badgeW + cellWidth(segHeight) + cellWidth(segClock) + cellWidth(segNet) + 9

  return (
    <box
      height={2}
      width="100%"
      flexDirection="row"
      alignItems="flex-start"
      paddingX={1}
      border={["bottom"]}
      borderColor={THEME.rule.default}
      backgroundColor={THEME.bg.canvas}
      flexShrink={0}
      overflow="hidden"
    >
      <T color={THEME.accent.main} bold>{"⬡"}</T>
      {brandFull && <T color={THEME.ink.primary} bold>{" aequchain"}</T>}
      <T color={THEME.rule.default}>{brandFull ? " │ " : " "}</T>
      <T color={THEME.ink.secondary} bold>{screenLabel}</T>
      <box flexGrow={1} />
      {showBackendLabel && <T color={THEME.ink.muted}>{"Backend: "}</T>}
      <StatusBadge status={status} label={statusLabel} />
      {showNet && (
        <>
          <T color={THEME.rule.default}>{" │ "}</T>
          <T color={THEME.ink.secondary}>{segNet}</T>
        </>
      )}
      {showHeight && (
        <>
          <T color={THEME.rule.default}>{" │ "}</T>
          <T color={THEME.ink.muted}>{"Height: "}</T>
          <T color={THEME.ink.primary} bold>{fmt0(height)}</T>
        </>
      )}
      {showClock && (
        <>
          <T color={THEME.rule.default}>{" │ "}</T>
          <T color={THEME.ink.secondary}>{clock}</T>
        </>
      )}
    </box>
  )
}
