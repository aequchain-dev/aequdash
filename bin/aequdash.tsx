#!/usr/bin/env bun
/**
 * aequdash — bin/aequdash.tsx
 *
 * Entry point. Owns the terminal exclusively:
 *   1. Resolves the launch PLAN (solo node | local dev mesh | watch | sim).
 *   2. Starts the selected backend via the Bridge.
 *   3. Creates the OpenTUI renderer (alternate screen buffer, raw stdin).
 *   4. Mounts the React tree.
 *   5. Hooks signals for clean teardown (bridge + renderer).
 *
 * THE DEFAULT IS A REAL NODE ON A REAL NETWORK:
 *
 *   aequdash                      join the public ephemeral testnet (or found
 *                                 it, if no live peer answers) — you ARE a node
 *   aequdash new <name>           found a NAMED, invite-gated network; the
 *                                 invite code prints in the activity feed
 *   aequdash join <aeq://…>       join a network by invite code
 *   aequdash join host:port       join via a raw endpoint (power path)
 *
 * Lifecycle contract:
 *   - first user of a network is its genesis anchor ("host")
 *   - later users join as REAL consensus peers — not viewers
 *   - the anchor leaving is a non-event: any live peer seeds new joins
 *     (roster gossip + rendezvous keepalive)
 *   - when the LAST peer exits, the network's entire state ceases to exist
 *
 * Development / legacy modes:
 *   aequdash --local [N]          spawn the shared loopback gateway mesh (N nodes)
 *   aequdash --watch host:port    attach to a gateway as a control-plane viewer
 *   AEQUCHAIN_BACKEND=julia       Julia reference implementation
 *   AEQUCHAIN_SIMULATE=1          deterministic simulator (explicit opt-in only)
 *   AEQUDASH_SNAPSHOT=1           frozen simulator (CI snapshots only)
 *
 * Env (solo mode):
 *   AEQUCHAIN_NET                 network name for the zero-arg path
 *                                 (default: "aequchain-public")
 *   AEQUCHAIN_RENDEZVOUS          host:port of a rendezvous server (discovery)
 *   AEQUCHAIN_HOST                mesh bind host (default 0.0.0.0)
 *   AEQUCHAIN_PORT                mesh bind port (default: auto-assign)
 *   AEQUCHAIN_ADVERTISE           external host for invites/registry when binding wildcard
 *   AEQUCHAIN_TOKEN               network token (join raw endpoint; or force one for `new`)
 *   AEQUCHAIN_NODE_ID             custom node id (default: aeqnode-<rand>)
 *   AEQUCHAIN_BOOTSTRAP_DELAY_MS  discovery grace before solo genesis (default 3000)
 *   AEQUCHAIN_AUTO_SEED=0         skip the demo genesis scenario
 *   AEQUCHAIN_ALLOW_NO_TTY=1      allow headless run
 *   AEQUCHAIN_THEME=light|dark    theme (default: light)
 *   AEQUCHAIN_NO_SPLASH=1         skip startup splash
 *   AEQUCHAIN_NO_MOTION=1         reduced motion
 */

import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import "@opentui/react/runtime-plugin-support"
import { App } from "../src/App.tsx"
import { Bridge, type BridgeBackend } from "../src/lib/bridge.ts"
import { BridgeProvider } from "../src/state/store.tsx"
import { lookupOnce } from "../src/node/rendezvous.ts"
import {
  PUBLIC_CLUSTER_ID,
  clusterIdFor,
  generateRand,
  generateToken,
  parseInvite,
  slugifyName,
} from "../src/node/invite.ts"
import type { SoloNodeConfig } from "../src/node/solo.ts"
import { localRegistryAddr } from "../src/node/solo.ts"

const isTTY = process.stdin.isTTY && process.stdout.isTTY
const SIMULATE = process.env.AEQUCHAIN_SIMULATE === "1" || process.env.AEQUDASH_SNAPSHOT === "1"

// ─────────────────────────────────────────────────────────────────────────────
// Launch plan resolution
// ─────────────────────────────────────────────────────────────────────────────

type Plan =
  | { mode: "sim" }
  | { mode: "julia" }
  | { mode: "local"; nodes: number; port: number; controlHost?: string; token?: string }
  | { mode: "watch"; gateway: string; token?: string; tls: boolean }
  | { mode: "solo"; solo: SoloNodeConfig }

function rand4(): string {
  const bytes = new Uint8Array(2)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 4)
}

/** Comma-separated rendezvous list → array (undefined when unset). */
function parseRendezvousList(env: string | undefined): string[] | undefined {
  const list = (env ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 8)
  return list.length > 0 ? list : undefined
}

function parseEndpoint(addr: string): { host: string; port: number } {
  const ci = addr.lastIndexOf(":")
  if (ci <= 0) throw new Error(`invalid endpoint "${addr}" (want host:port)`)
  const port = parseInt(addr.slice(ci + 1), 10)
  if (!Number.isFinite(port) || port <= 0 || port > 65535) throw new Error(`invalid port in "${addr}"`)
  return { host: addr.slice(0, ci), port }
}

function soloBase(): Omit<SoloNodeConfig, "clusterId" | "seeds" | "token" | "bootstrap" | "nodeId"> {
  const peerTls = process.env.AEQUCHAIN_PEER_TLS === "1"
    ? {
        cert: process.env.AEQUCHAIN_TLS_CERT ?? "cert.pem",
        key: process.env.AEQUCHAIN_TLS_KEY ?? "key.pem",
      }
    : null
  return {
    host: process.env.AEQUCHAIN_HOST ?? "0.0.0.0",
    port: process.env.AEQUCHAIN_PORT ? parseInt(process.env.AEQUCHAIN_PORT, 10) : 0,
    advertiseHost: process.env.AEQUCHAIN_ADVERTISE || undefined,
    committeeSize: parseInt(process.env.AEQUCHAIN_COMMITTEE ?? "3", 10),
    threshold: process.env.AEQUCHAIN_THRESHOLD ? parseInt(process.env.AEQUCHAIN_THRESHOLD, 10) : null,
    epochSeed: process.env.AEQUCHAIN_EPOCH_SEED ?? "42",
    blockTimeMs: parseInt(process.env.AEQUCHAIN_BLOCK_TIME ?? "1500", 10),
    roundTimeoutMs: parseInt(process.env.AEQUCHAIN_ROUND_TIMEOUT ?? "4000", 10),
    // Discovery list: the loopback registry FIRST (same-machine zero-config),
    // then any configured rendezvous servers (internet). solo.ts dedups.
    rendezvous: [localRegistryAddr(), ...(parseRendezvousList(process.env.AEQUCHAIN_RENDEZVOUS) ?? [])],
    dialAssistMs: parseInt(process.env.AEQUCHAIN_DIAL_ASSIST_MS ?? "20000", 10),
    localRegistry: process.env.AEQUCHAIN_NO_LOCAL_REGISTRY !== "1",
    beacon: process.env.AEQUCHAIN_NO_BEACON !== "1",
    peerTls,
    discoveryGraceMs: parseInt(process.env.AEQUCHAIN_BOOTSTRAP_DELAY_MS ?? "3000", 10),
    autoSeed: process.env.AEQUCHAIN_AUTO_SEED !== "0",
  }
}

async function resolvePlan(argv: string[]): Promise<Plan> {
  if (SIMULATE) return { mode: "sim" }
  if (process.env.AEQUCHAIN_BACKEND === "julia") return { mode: "julia" }

  const args = argv.slice(2)
  const sub = args[0]

  // ── Legacy: shared loopback gateway mesh ──
  if (sub === "--local") {
    const nodes = Math.max(1, parseInt(args[1] ?? process.env.AEQUCHAIN_NODES ?? "3", 10) || 3)
    return {
      mode: "local",
      nodes,
      port: Math.max(1024, parseInt(process.env.AEQUCHAIN_PORT ?? "7920", 10)),
      controlHost: process.env.AEQUCHAIN_CONTROL_HOST || undefined,
      token: process.env.AEQUCHAIN_TOKEN || undefined,
    }
  }

  // ── Legacy: attach to a remote gateway as a control-plane viewer ──
  if (sub === "--watch") {
    const gateway = args[1] ?? process.env.AEQUCHAIN_GATEWAY
    if (!gateway) throw new Error("usage: aequdash --watch host:port")
    return { mode: "watch", gateway, token: process.env.AEQUCHAIN_TOKEN || undefined, tls: process.env.AEQUCHAIN_TLS === "1" }
  }
  if (process.env.AEQUCHAIN_GATEWAY) {
    return { mode: "watch", gateway: process.env.AEQUCHAIN_GATEWAY, token: process.env.AEQUCHAIN_TOKEN || undefined, tls: process.env.AEQUCHAIN_TLS === "1" }
  }

  const base = soloBase()
  const nodeId = process.env.AEQUCHAIN_NODE_ID || `aeqnode-${rand4()}`

  // ── Found a named, invite-gated network ──
  if (sub === "new") {
    const nameArg = args[1]
    if (!nameArg) throw new Error("usage: aequdash new <network-name>")
    const name = slugifyName(nameArg)
    const rand = generateRand()
    const token = process.env.AEQUCHAIN_TOKEN || generateToken()
    return {
      mode: "solo",
      solo: {
        ...base,
        nodeId,
        clusterId: clusterIdFor(name, rand),
        seeds: [],
        token,
        bootstrap: true,
        inviteName: name,
        inviteRand: rand,
      },
    }
  }

  // ── Join by invite code or raw endpoint ──
  if (sub === "join") {
    const target = args[1]
    if (!target) throw new Error("usage: aequdash join <aeq://… | host:port>")
    if (target.startsWith("aeq://")) {
      const invite = parseInvite(target) // throws on bad checksum / malformation
      return {
        mode: "solo",
        solo: {
          ...base,
          nodeId,
          clusterId: invite.clusterId,
          seeds: invite.endpoints,
          token: invite.token,
          bootstrap: true, // deterministic seed burst — only matters if net evaporated and we re-anchor
        },
      }
    }
    const ep = parseEndpoint(target)
    const clusterId = process.env.AEQUCHAIN_NET ?? PUBLIC_CLUSTER_ID
    return {
      mode: "solo",
      solo: {
        ...base,
        nodeId,
        clusterId,
        seeds: [ep],
        token: process.env.AEQUCHAIN_TOKEN || null,
        bootstrap: true,
      },
    }
  }

  if (sub === "--help" || sub === "-h" || sub === "help") {
    console.log(`aequdash — you ARE the node

  aequdash                        join (or found) the public ephemeral testnet
  aequdash new <name>             found a named, invite-gated network
  aequdash join <aeq://…>         join via invite code
  aequdash join <host:port>       join via a raw endpoint
  aequdash --local [N]            dev: shared loopback mesh of N nodes
  aequdash --watch <host:port>    attach to a --local gateway as a viewer

  env: AEQUCHAIN_NET, AEQUCHAIN_RENDEZVOUS, AEQUCHAIN_HOST, AEQUCHAIN_PORT,
       AEQUCHAIN_ADVERTISE, AEQUCHAIN_TOKEN, AEQUCHAIN_NODE_ID,
       AEQUCHAIN_BOOTSTRAP_DELAY_MS, AEQUCHAIN_AUTO_SEED, AEQUCHAIN_SIMULATE`)
    process.exit(0)
  }
  if (sub) {
    throw new Error(`unknown command: ${sub} (try: aequdash | aequdash new <name> | aequdash join <code> | aequdash --local [N] | aequdash --watch host:port)`)
  }

  // ── Zero-arg: join-or-anchor the (default public) network ──
  const clusterId = process.env.AEQUCHAIN_NET
    ? clusterIdFor(slugifyName(process.env.AEQUCHAIN_NET), "public")
    : PUBLIC_CLUSTER_ID
  // Always look before anchoring: loopback registry (same machine) first,
  // then any configured rendezvous servers (internet). If ANY live peer
  // answers, we join their chain instead of founding a parallel one.
  const seeds = await lookupOnce(base.rendezvous ?? [], clusterId)
  if (seeds.length > 0) {
    process.stderr.write(`aequdash: found ${seeds.length} live peer(s) for ${clusterId} — joining the running network\n`)
  } else {
    process.stderr.write(`aequdash: no live peers for ${clusterId} (local/LAN/rendezvous) — you are the genesis anchor; others will find you\n`)
  }
  return {
    mode: "solo",
    solo: {
      ...base,
      nodeId,
      clusterId,
      seeds,
      token: process.env.AEQUCHAIN_TOKEN || null,
      bootstrap: true,
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const plan = await resolvePlan(process.argv)

  if (!isTTY && plan.mode === "sim" && !process.env.AEQUCHAIN_ALLOW_NO_TTY) {
    if (process.env.AEQUDASH_SNAPSHOT !== "1") {
      console.error("aequdash: interactive TUI requires a TTY. Set AEQUCHAIN_SIMULATE=1 for headless mode.")
      process.exit(1)
    }
  }

  const JULIA_BIN = process.env.AEQUCHAIN_JULIA || "julia"
  const RPC_SCRIPT = process.env.AEQUCHAIN_RPC || new URL("../../julia/rpc-server.jl", import.meta.url).pathname

  const backend: BridgeBackend =
    plan.mode === "sim" ? "sim" : plan.mode === "julia" ? "julia" : "aeqnet"

  const bridge = new Bridge({
    backend,
    juliaBin: JULIA_BIN,
    rpcScript: RPC_SCRIPT,
    cwd: process.cwd(),
    // local-mesh knobs (used only in --local)
    aeqnetNodes: plan.mode === "local" ? plan.nodes : 1,
    aeqnetPort: plan.mode === "local" ? plan.port : parseInt(process.env.AEQUCHAIN_PORT ?? "7920", 10),
    // watch knobs
    remoteGateway: plan.mode === "watch" ? plan.gateway : undefined,
    controlHost: plan.mode === "local" ? plan.controlHost : undefined,
    token: (plan.mode === "watch" || plan.mode === "local" ? plan.token : undefined) ?? undefined,
    tls: plan.mode === "watch" ? plan.tls : false,
    // solo node (the default)
    solo: plan.mode === "solo" ? plan.solo : undefined,
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
