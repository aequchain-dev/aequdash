/**
 * aequdash — src/components/Footer.tsx
 *
 * Navigation rail (guide §9) — a horizontal rail, not a giant tab bar:
 *
 *   [ 1 Dashboard ] │ 2 Identity │ 3 Networks │ … │ 8 Console      : command
 *
 * The selected screen gets a compact filled accent block; everything else is
 * quiet. Tabs are mouse-clickable (pointer feedback never replaces keys).
 * At narrow widths the rail abbreviates (screen names shrink first).
 */

import { useStore } from "../state/store.tsx"
import { THEME } from "../lib/theme.ts"
import { SCREEN_ORDER, SCREEN_TITLES, type ScreenId } from "../lib/types.ts"
import { T } from "./T.tsx"

function NavItem({ screen, index, active, compact }: { screen: ScreenId; index: number; active: boolean; compact: boolean }) {
  const { setScreen } = useStore()
  const label = compact ? SCREEN_TITLES[screen].slice(0, 4) : SCREEN_TITLES[screen]
  if (active) {
    return (
      <box flexDirection="row" flexShrink={0} onMouseDown={() => setScreen(screen)}>
        <T color={THEME.ink.inverse} bg={THEME.accent.main} bold>{` ${index + 1} ${label} `}</T>
      </box>
    )
  }
  return (
    <box flexDirection="row" flexShrink={0} onMouseDown={() => setScreen(screen)}>
      <T color={THEME.ink.faint}>{`${index + 1} `}</T>
      <T color={THEME.ink.secondary}>{label}</T>
    </box>
  )
}

export function Footer({ width }: { width: number }) {
  const { screen, setScreen, setCommandBarOpen, commandBarOpen } = useStore()
  // Full rail needs ~ 8 * (3 + 10 + 3) ≈ 128 cells; compact names below
  // that; numbers-only micro rail below 96.
  const compact = width < 128
  const micro = width < 96

  if (micro) {
    return (
      <box
        height={2}
        width="100%"
        flexDirection="row"
        alignItems="flex-end"
        paddingX={1}
        border={["top"]}
        borderColor={THEME.rule.default}
        backgroundColor={THEME.bg.canvas}
        flexShrink={0}
      >
        {SCREEN_ORDER.map((s, i) => {
          const active = s === screen
          return (
            <box key={s} flexDirection="row" flexShrink={0}>
              <box flexDirection="row" flexShrink={0} onMouseDown={() => setScreen(s)}>
                {active ? (
                  <T color={THEME.ink.inverse} bg={THEME.accent.main} bold>{` ${i + 1} `}</T>
                ) : (
                  <T color={THEME.ink.muted}>{` ${i + 1} `}</T>
                )}
              </box>
              {i < SCREEN_ORDER.length - 1 && <T color={THEME.rule.faint}>{"│"}</T>}
            </box>
          )
        })}
        <box flexGrow={1} />
        <box flexDirection="row" flexShrink={0} onMouseDown={() => setCommandBarOpen(!commandBarOpen)}>
          <T color={THEME.accent.main} bold>{":"}</T>
        </box>
      </box>
    )
  }

  return (
    <box
      height={2}
      width="100%"
      flexDirection="row"
      alignItems="flex-end"
      paddingX={1}
      border={["top"]}
      borderColor={THEME.rule.default}
      backgroundColor={THEME.bg.canvas}
      flexShrink={0}
    >
      {SCREEN_ORDER.map((s, i) => (
        <box key={s} flexDirection="row" flexShrink={0}>
          <NavItem screen={s} index={i} active={s === screen} compact={compact} />
          {i < SCREEN_ORDER.length - 1 && <T color={THEME.rule.faint}>{" │ "}</T>}
        </box>
      ))}
      <box flexGrow={1} />
      <box flexDirection="row" flexShrink={0} onMouseDown={() => setCommandBarOpen(!commandBarOpen)}>
        <T color={THEME.accent.main} bold>{":"}</T>
        <T color={THEME.ink.muted}>{" command"}</T>
      </box>
    </box>
  )
}
