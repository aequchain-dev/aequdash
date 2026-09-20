/**
 * aequdash — src/App.tsx
 *
 * Application shell (guide §4.1): outer inset, single outer frame, header
 * band, screen region, navigation rail. Keyboard per guide §3:
 *
 *   1–8 jump · ←/→ cycle · : command · r refresh · q/Ctrl-C quit
 *   Esc closes the command bar; ↑/↓ history inside it.
 *
 * Layout skeleton:
 *   ┌ frame (single border, rule.default) ───────────────────┐
 *   │ Header (1 row, bottom rule)                            │
 *   │ screen region (flexGrow, padding 1)                    │
 *   │ Footer nav rail (1 row, top rule)                      │
 *   └─────────────────────────────────────────────────────────┘
 */

import { useState } from "react"
import { useKeyboard, useRenderer } from "@opentui/react"
import { useStore } from "./state/store.tsx"
import { THEME } from "./lib/theme.ts"
import { SCREEN_ORDER, type ScreenId } from "./lib/types.ts"
import { Header } from "./components/Header.tsx"
import { Footer } from "./components/Footer.tsx"
import { CommandBar } from "./components/CommandBar.tsx"
import { Splash } from "./components/Splash.tsx"
import { Dashboard } from "./screens/Dashboard.tsx"
import { Identity } from "./screens/Identity.tsx"
import { Networks } from "./screens/Networks.tsx"
import { Businesses } from "./screens/Businesses.tsx"
import { Pledges } from "./screens/Pledges.tsx"
import { Node } from "./screens/Node.tsx"
import { Consensus } from "./screens/Consensus.tsx"
import { Console } from "./screens/Console.tsx"
import { useTerminalDimensions } from "@opentui/react"

const KEY_TO_SCREEN: Record<string, ScreenId> = {
  "1": "dashboard",
  "2": "identity",
  "3": "networks",
  "4": "businesses",
  "5": "pledges",
  "6": "node",
  "7": "consensus",
  "8": "console",
}

export function App() {
  const { screen, setScreen, commandBarOpen, setCommandBarOpen, refresh, bridge } = useStore()
  const renderer = useRenderer()
  const { width } = useTerminalDimensions()
  const [showSplash, setShowSplash] = useState(
    process.env.AEQUCHAIN_NO_SPLASH !== "1" && process.env.AEQUDASH_SNAPSHOT !== "1",
  )

  // Graceful full teardown: stop the backend (mesh shuts down cleanly),
  // destroy the renderer (restores the terminal), then exit.
  const quit = async () => {
    try { await bridge.stop() } catch { /* ignore */ }
    try { renderer.destroy() } catch { /* ignore */ }
    process.exit(0)
  }

  useKeyboard((key) => {
    if (commandBarOpen) return

    const name = key.name

    if (name === "q" || (key.ctrl && name === "c")) {
      void quit()
      return
    }

    if (KEY_TO_SCREEN[name]) { setScreen(KEY_TO_SCREEN[name]); return }

    if (name === "right" || name === "l") {
      const i = SCREEN_ORDER.indexOf(screen)
      setScreen(SCREEN_ORDER[(i + 1) % SCREEN_ORDER.length])
      return
    }
    if (name === "left" || name === "h") {
      const i = SCREEN_ORDER.indexOf(screen)
      setScreen(SCREEN_ORDER[(i - 1 + SCREEN_ORDER.length) % SCREEN_ORDER.length])
      return
    }

    if (name === ":" || name === ";") { setCommandBarOpen(true); return }
    if (name === "r") { refresh(); return }
  })

  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      backgroundColor={THEME.bg.canvas}
      paddingX={1}
      overflow="hidden"
    >
      <box
        border={true}
        borderStyle="single"
        borderColor={THEME.rule.default}
        flexDirection="column"
        flexGrow={1}
        backgroundColor={THEME.bg.canvas}
        overflow="hidden"
      >
        <Header />
        <box flexGrow={1} flexDirection="column" paddingX={1} paddingTop={1} overflow="hidden">
          {screen === "dashboard"  && <Dashboard />}
          {screen === "identity"   && <Identity />}
          {screen === "networks"   && <Networks />}
          {screen === "businesses" && <Businesses />}
          {screen === "pledges"    && <Pledges />}
          {screen === "node"       && <Node />}
          {screen === "consensus"  && <Consensus />}
          {screen === "console"    && <Console />}
        </box>
        <Footer width={width} />
      </box>
      <CommandBar />
      {showSplash && <Splash onDone={() => setShowSplash(false)} />}
    </box>
  )
}
