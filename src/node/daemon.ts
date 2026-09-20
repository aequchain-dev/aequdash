#!/usr/bin/env bun
/**
 * aequdash — src/node/daemon.ts
 *
 * Ephemeral node daemon — a standalone process hosting ONE AequNode.
 *
 * Control channel: newline-delimited JSON-RPC over stdio (spawned by the
 * gateway with piped stdio). Mesh traffic is pure TCP between nodes.
 *
 * Commands:
 *   start   → boot the node (listen + connect to seeds)
 *   stop    → stop the node (peers see a graceful bye; state dropped)
 *   destroy → stop + wipe all state (ephemeral guarantee)
 *   status  → { running, port, height, peers, state_root }
 *   shutdown→ exit the process
 *
 * On successful listen it prints one unprompted line:
 *   {"ready":true,"id":"...","port":12345}
 */

import { AequNode } from "./node.ts"
import { demoSeedTxs } from "./genesis.ts"
import { NODE_VERSION } from "./proto.ts"

interface DaemonArgs {
  id: string
  host: string
  port: number
  seeds: { host: string; port: number }[]
  clusterId: string
  committeeSize: number
  threshold: number | null
  epochSeed: string
  blockTimeMs: number
  roundTimeoutMs: number
}

function parseArgs(argv: string[]): DaemonArgs {
  const args: DaemonArgs = {
    id: "aeqnode-x",
    host: "127.0.0.1",
    port: 0,
    seeds: [],
    clusterId: "default",
    committeeSize: 3,
    threshold: null,
    epochSeed: "42",
    blockTimeMs: 1_500,
    roundTimeoutMs: 4_000,
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    const next = argv[i + 1]
    switch (a) {
      case "--id": args.id = next!; i++; break
      case "--host": args.host = next!; i++; break
      case "--port": args.port = parseInt(next!, 10); i++; break
      case "--seed": {
        const [h, p] = (next ?? "").split(":")
        if (h && p) args.seeds.push({ host: h, port: parseInt(p, 10) })
        i++
        break
      }
      case "--cluster": args.clusterId = next!; i++; break
      case "--committee": args.committeeSize = parseInt(next!, 10); i++; break
      case "--threshold": args.threshold = parseInt(next!, 10); i++; break
      case "--epoch-seed": args.epochSeed = next!; i++; break
      case "--block-time": args.blockTimeMs = parseInt(next!, 10); i++; break
      case "--round-timeout": args.roundTimeoutMs = parseInt(next!, 10); i++; break
    }
  }
  return args
}

const args = parseArgs(process.argv)

let node: AequNode | null = null

function buildNode(): AequNode {
  return new AequNode({
    nodeId: args.id,
    host: args.host,
    port: args.port,
    seeds: args.seeds,
    clusterId: args.clusterId,
    committeeSize: args.committeeSize,
    thresholdOverride: args.threshold,
    epochSeed: args.epochSeed,
    blockTimeMs: args.blockTimeMs,
    roundTimeoutMs: args.roundTimeoutMs,
    maxTxPerBlock: 256,
    seedTxs: demoSeedTxs(),
    bootstrap: true, // any node may end up proposing block 1; seeds are identical everywhere
  })
}

function respond(id: number, result: unknown): void {
  process.stdout.write(JSON.stringify({ id, result }) + "\n")
}

async function handle(id: number, op: string, params?: Record<string, unknown>): Promise<void> {
  switch (op) {
    case "start": {
      if (!node) node = buildNode()
      await node.start()
      respond(id, { ok: true, port: node.boundPort, height: node.height })
      return
    }
    case "stop": {
      await node?.stop()
      respond(id, { ok: true })
      return
    }
    case "unpause": {
      node?.enableConsensus()
      respond(id, { ok: true })
      return
    }
    case "dial": {
      // Open a mesh connection to another node (full-mesh wiring)
      const host = String(params?.host ?? "127.0.0.1")
      const port = Number(params?.port ?? 0)
      if (node?.mesh && port > 0) await node.mesh.dial(host, port)
      respond(id, { ok: true, port })
      return
    }
    case "destroy": {
      if (node) await node.destroy()
      node = null
      respond(id, { ok: true })
      return
    }
    case "status": {
      respond(id, {
        ok: true,
        running: node?.running ?? false,
        port: node?.boundPort ?? 0,
        height: node?.height ?? 0,
        peers: node?.mesh?.peerCount() ?? 0,
        state_root: node?.tipStateRoot() ?? null,
        version: NODE_VERSION,
      })
      return
    }
    case "shutdown": {
      respond(id, { ok: true })
      setTimeout(() => process.exit(0), 25)
      return
    }
    default:
      respond(id, { ok: false, error: `unknown op: ${op}` })
  }
}

// Auto-start on boot, then announce readiness.
;(async () => {
  try {
    node = buildNode()
    await node.start()
    process.stdout.write(JSON.stringify({
      ready: true,
      id: args.id,
      port: node.boundPort,
      version: NODE_VERSION,
    }) + "\n")
  } catch (e) {
    process.stdout.write(JSON.stringify({ ready: false, error: String(e) }) + "\n")
  }
})()

// Control loop
const decoder = new TextDecoder()
let buf = ""
process.stdin.on("data", (chunk: string | Uint8Array) => {
  buf += typeof chunk === "string" ? chunk : decoder.decode(chunk)
  let nl: number
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    try {
      const req = JSON.parse(line) as { id: number; op: string; params?: Record<string, unknown> }
      void handle(req.id, req.op, req.params as Record<string, unknown> | undefined)
    } catch { /* malformed line: ignore */ }
  }
})

process.on("SIGTERM", () => { void node?.stop().finally(() => process.exit(0)) })
process.on("SIGINT", () => { void node?.stop().finally(() => process.exit(0)) })

// ORPHAN-KILLER: if the gateway (our parent) dies for ANY reason, our stdin
// closes. A daemon without a parent destroys its node and exits — nothing
// outlives the mesh.
process.stdin.on("end", () => { void node?.destroy().finally(() => process.exit(0)) })
process.stdin.on("close", () => { void node?.destroy().finally(() => process.exit(0)) })
