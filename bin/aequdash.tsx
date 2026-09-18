#!/usr/bin/env bun
/**
 * aequdash — bin/aequdash.tsx
 *
 * Entry point. Owns the terminal exclusively:
 *   1. Spawns the Julia JSON-RPC bridge (or built-in simulator) with PIPED
 *      stdio — nothing from Julia ever touches the parent terminal.
 *   2. Creates the OpenTUI renderer (alternate screen buffer, raw stdin).
 *   3. Mounts the React tree.
 *   4. Hooks signals for clean teardown (bridge + renderer).
 *
 * Env:
 *   AEQUCHAIN_SIMULATE=1     force simulator (no Julia)
 *   AEQUCHAIN_ALLOW_NO_TTY=1 allow headless run
 *   AEQUCHAIN_THEME=light|dark   theme (default: light)
 *   AEQUCHAIN_NO_SPLASH=1    skip startup splash
 *   AEQUCHAIN_NO_MOTION=1    reduced motion
 *   AEQUDASH_SNAPSHOT=1      frozen deterministic state (CI/snapshots)
 */

import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import "@opentui/react/runtime-plugin-support"
import { App } from "../src/App.tsx"
import { JuliaBridge } from "../src/lib/bridge.ts"
import { BridgeProvider } from "../src/state/store.tsx"

const isTTY = process.stdin.isTTY && process.stdout.isTTY
const SIMULATE = process.env.AEQUCHAIN_SIMULATE === "1" || process.env.AEQUDASH_SNAPSHOT === "1"
const JULIA_BIN = process.env.AEQUCHAIN_JULIA || "julia"
const RPC_SCRIPT = process.env.AEQUCHAIN_RPC || new URL("../../julia/rpc-server.jl", import.meta.url).pathname

if (!isTTY && !SIMULATE) {
  if (!process.env.AEQUCHAIN_ALLOW_NO_TTY) {
    console.error("aequdash: interactive TUI requires a TTY. Set AEQUCHAIN_SIMULATE=1 for headless mode.")
    process.exit(1)
  }
}

async function main() {
  const bridge = new JuliaBridge({
    juliaBin: JULIA_BIN,
    rpcScript: RPC_SCRIPT,
    simulate: SIMULATE || !isTTY,
    cwd: process.cwd(),
  })

  await bridge.start()

  const renderer = await createCliRenderer({
    stdin: process.stdin as NodeJS.ReadStream,
    stdout: process.stdout as NodeJS.WriteStream,
    exitOnCtrlC: false,
    useMouse: true,
    enableMouseMovement: false,
    screenMode: "alternate-screen",
    clearOnShutdown: true,
  })

  const root = createRoot(renderer)
  root.render(
    <BridgeProvider bridge={bridge}>
      <App />
    </BridgeProvider>,
  )

  let tearingDown = false
  const teardown = async () => {
    if (tearingDown) return
    tearingDown = true
    try { await bridge.stop() } catch {}
    try { renderer.destroy() } catch {}
    process.exit(0)
  }
  process.on("SIGINT", teardown)
  process.on("SIGTERM", teardown)
  process.on("SIGHUP", teardown)
  process.on("exit", () => { try { bridge.kill() } catch {} })
}

main().catch((err) => {
  console.error("aequdash fatal:", err)
  process.exit(1)
})
