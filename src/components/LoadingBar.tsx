/**
 * aequdash — src/components/LoadingBar.tsx
 *
 * Determinate-free, low-amplitude indeterminate bar (guide §12.5):
 * a short accent block gliding on a faint track. Deterministic tick;
 * disabled (static) under reduced motion.
 */

import { useEffect, useState } from "react"
import { THEME, MOTION, reducedMotion } from "../lib/theme.ts"
import { T } from "./T.tsx"

export function LoadingBar({ width, label }: { width: number; label?: string }) {
  const [pos, setPos] = useState(0)
  const block = Math.max(3, Math.floor(width / 6))
  const track = Math.max(1, width - block)

  useEffect(() => {
    if (reducedMotion()) return
    const id = setInterval(() => setPos((p) => (p + 1) % (track + 1)), 90)
    return () => clearInterval(id)
  }, [track])

  const p = reducedMotion() ? Math.floor(track / 2) : pos
  return (
    <box flexDirection="column" flexShrink={0}>
      <box flexDirection="row" height={1} width={width}>
        <T color={THEME.rule.faint}>{"█".repeat(p)}</T>
        <T color={THEME.accent.main}>{"█".repeat(block)}</T>
        <T color={THEME.rule.faint}>{"█".repeat(Math.max(0, track - p))}</T>
      </box>
      {label && (
        <box height={1} marginTop={1}>
          <T color={THEME.ink.muted}>{label}</T>
        </box>
      )}
    </box>
  )
}
