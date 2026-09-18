/**
 * aequdash — src/components/Splash.tsx
 *
 * Startup splash (guide §12.5): a short, quiet reveal, ≤ 900 ms total.
 *
 *   1. brand mark appears          (t=0)
 *   2. product name settles        (t=280ms)
 *   3. backend state resolves      (t=560ms)
 *   4. dashboard becomes visible   (t=840ms → onDone)
 *
 * Skipped entirely with AEQUCHAIN_NO_SPLASH=1 or reduced-motion mode.
 */

import { useEffect, useState } from "react"
import { THEME, reducedMotion } from "../lib/theme.ts"
import { T } from "./T.tsx"

export function Splash({ onDone }: { onDone: () => void }) {
  const [stage, setStage] = useState(0)

  useEffect(() => {
    if (reducedMotion()) { onDone(); return }
    const t1 = setTimeout(() => setStage(1), 280)
    const t2 = setTimeout(() => setStage(2), 560)
    const t3 = setTimeout(() => onDone(), 840)
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3) }
  }, [onDone])

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      right={0}
      bottom={0}
      backgroundColor={THEME.bg.canvas}
      alignItems="center"
      justifyContent="center"
      flexDirection="column"
    >
      <T color={THEME.accent.main} bold>{"⬡"}</T>
      {stage >= 1 && (
        <box marginTop={1}>
          <T color={THEME.ink.primary} bold>{"aequchain"}</T>
        </box>
      )}
      {stage >= 2 && (
        <box marginTop={1}>
          <T color={THEME.ink.muted}>{"universal equidistributed blockchain — ephemeral testnet"}</T>
        </box>
      )}
    </box>
  )
}
