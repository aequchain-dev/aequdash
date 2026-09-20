#!/usr/bin/env bun
/**
 * aequdash — bin/aequdash.tsx
 *
 * Entry point. Owns the terminal exclusively:
 *   1. Starts the selected backend (aeqnet mesh by default — REAL ephemeral
 *      testnet nodes, no simulator) with PIPED stdio.
 *   2. Creates the OpenTUI renderer (alternate screen buffer, raw stdin).
 *   3. Mounts the React tree.
 *   4. Hooks signals for clean teardown (bridge + renderer).
 *
 * Backend selection:
 *   (default)              → aeqnet: real ephemeral node mesh (this repo)
 *   AEQUCHAIN_BACKEND=julia → Julia reference implementation (if installed)
 *   AEQUCHAIN_SIMULATE=1    → deterministic simulator (explicit opt-in only)
 *   AEQUDASH_SNAPSHOT=1     → frozen simulator (CI snapshots only)
 *
 * Env:
 *   AEQUCHAIN_NODES=3        mesh size for the aeqnet backend
 *   AEQUCHAIN_PORT=7920      base TCP port for the mesh
 *   AEQUCHAIN_ALLOW_NO_TTY=1 allow headless run
 *   AEQUCHAIN_THEME=light|dark   theme (default: light)
 *   AEQUCHAIN_NO_SPLASH=1    skip startup splash
 *   AEQUCHAIN_NO_MOTION=1    reduced motion
 */

import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import "@opentui/react/runtime-plugin-support"
import { App } from "../src/App.tsx"
import { Bridge, type BridgeBackend } from "../src/lib/bridge.ts"
import { BridgeProvider } from "../src/state/store.tsx"

const isTTY = process.stdin.isTTY && process.stdout.isTTY
const SIMULATE = process.env.AEQUCHAIN_SIMULATE === "1" || process.env.AEQUDASH_SNAPSHOT === "1"
const BACKEND: BridgeBackend = SIMULATE
  ? "sim"
  : (process.env.AEQUCHAIN_BACKEND === "julia" ? "julia" : "aeqnet")
const JULIA_BIN = process.env.AEQUCHAIN_JULIA || "julia"
const RPC_SCRIPT = process.env.AEQUCHAIN_RPC || new URL("../../julia/rpc-server.jl", import.meta.url).pathname
const AEQUCHAIN_NODES = Math.max(1, parseInt(process.env.AEQUCHAIN_NODES ?? "3", 10))
const AEQUCHAIN_PORT = Math.max(1024, parseInt(process.env.AEQUCHAIN_PORT ?? "7920", 10))

if (!isTTY && BACKEND === "sim" && !process.env.AEQUCHAIN_ALLOW_NO_TTY) {
  // Snapshot/CI path — allowed headless without the flag
  if (process.env.AEQUDASH_SNAPSHOT !== "1") {
    console.error("aequdash: interactive TUI requires a TTY. Set AEQUCHAIN_SIMULATE=1 for headless mode.")
    process.exit(1)
  }
}

async function main() {
  const bridge = new Bridge({
    backend: BACKEND,
    juliaBin: JULIA_BIN,
    rpcScript: RPC_SCRIPT,
    cwd: process.cwd(),
    aeqnetNodes: AEQUCHAIN_NODES,
    aeqnetPort: AEQUCHAIN_PORT,
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
