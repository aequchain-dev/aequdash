#!/usr/bin/env bun
/**
 * aequdash — scripts/rendezvous.ts
 *
 * Standalone rendezvous server — the stateless bootstrap phone book for
 * internet-first ephemeral networks. Thin CLI wrapper around the shared
 * registry core (src/node/registry.ts):
 *
 *   bun run scripts/rendezvous.ts --port 8930 [--host 0.0.0.0]
 *
 * The registry stores ONLY netHash → endpoint → expiry (TTL, in RAM). Never
 * a transaction, a block, or even a cleartext network name. When every node
 * of a network stops keepaliving, its entries rot out within one TTL window.
 *
 * Env:
 *   AEQUCHAIN_RDV_TOKEN     optional shared secret required of every client
 *   AEQUCHAIN_RDV_TTL_MS    registration TTL (default 90000)
 *   AEQUCHAIN_RDV_SWEEP_MS  expiry sweep cadence (default 15000)
 */

import { Registry } from "../src/node/registry.ts"

let port = 8930
let host = "0.0.0.0"
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--port") { port = parseInt(process.argv[++i], 10); continue }
  if (process.argv[i] === "--host") { host = process.argv[++i]; continue }
}

const registry = new Registry({
  ttlMs: parseInt(process.env.AEQUCHAIN_RDV_TTL_MS ?? "90000", 10),
  sweepMs: parseInt(process.env.AEQUCHAIN_RDV_SWEEP_MS ?? "15000", 10),
  token: process.env.AEQUCHAIN_RDV_TOKEN ?? null,
})

const server = registry.listen(host, port)
if (!server) {
  console.error(`rendezvous: ${host}:${port} is already in use`)
  process.exit(1)
}

console.log(`aeqnet rendezvous listening on ${host}:${server.port} (ttl=${parseInt(process.env.AEQUCHAIN_RDV_TTL_MS ?? "90000", 10) / 1000}s, auth=${process.env.AEQUCHAIN_RDV_TOKEN ? "on" : "off"})`)

process.on("SIGINT", () => { registry.stop(); process.exit(0) })
process.on("SIGTERM", () => { registry.stop(); process.exit(0) })
