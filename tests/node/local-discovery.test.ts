/**
 * aequdash — tests/node/local-discovery.test.ts
 *
 * THE ZERO-CONFIG LOCAL E2E — the exact reported experience:
 *
 *   terminal 1: bun run start  → anchors; `join xen 100` → xen exists
 *   terminal 2: bun run start  → MUST find terminal 1's network on the SAME
 *                                machine with ZERO configuration, join it as
 *                                a peer, and see xen.
 *
 * Also: the loopback registry is itself ephemeral — when its host exits, a
 * survivor claims it (failover), so the discovery layer can never be a
 * leftover orphan or a permanent dependency of the first process.
 */

import { describe, test, expect, afterEach } from "bun:test"
import { SoloNodeBackend, localRegistryAddr, type SoloNodeConfig } from "../../src/node/solo.ts"
import { lookupOnce } from "../../src/node/rendezvous.ts"

const RDV_PORT = 35_930 + Math.floor(Math.random() * 500)
const NET = `aeqnet-localdisc-${Math.random().toString(36).slice(2, 8)}`

let backends: SoloNodeBackend[] = []

afterEach(async () => {
  for (const b of backends) await b.shutdown()
  backends = []
})

function soloCfg(nodeId: string, seeds: { host: string; port: number }[]): SoloNodeConfig {
  return {
    nodeId,
    clusterId: NET,
    host: "127.0.0.1",
    port: 0,                       // auto-assign, like the real default
    seeds,
    token: null,
    bootstrap: true,
    committeeSize: 3,
    threshold: null,
    epochSeed: "42",
    blockTimeMs: 150,
    roundTimeoutMs: 1200,
    rendezvous: [localRegistryAddr(RDV_PORT)],
    dialAssistMs: 400,
    localRegistry: true,
    localRegistryPort: RDV_PORT,
    beacon: false,                 // UDP beacons are exercised in beacon.test.ts
    discoveryGraceMs: 300,
    autoSeed: true,
  }
}

async function waitFor(pred: () => boolean, timeoutMs: number, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`waitFor timeout: ${what}`)
}

describe("zero-config local discovery", () => {
  test("second instance on the same machine finds and joins the first", async () => {
    // ── Terminal 1: bun run start → anchors the network ──
    const A = new SoloNodeBackend(soloCfg("term-1", []))
    backends.push(A)
    await A.start()

    // Genesis commits (solo anchor, threshold 1 until peers arrive)
    await waitFor(() => (A.snapshot()?.block_height ?? 0) >= 1, 15_000, "terminal 1 genesis")

    // User creates state in terminal 1
    const joinRes = await A.cliRun("join", ["xen", "100"])
    expect(joinRes.ok).toBe(true)
    expect(A.node()?.ledger.members.has("xen")).toBe(true)

    // ── Terminal 2: bun run start → the zero-arg path looks BEFORE anchoring ──
    // (bin/aequdash.tsx does exactly this lookup with no user configuration)
    const seeds = await lookupOnce([localRegistryAddr(RDV_PORT)], NET)
    expect(seeds.length).toBe(1) // terminal 1's registration is found

    const B = new SoloNodeBackend(soloCfg("term-2", seeds))
    backends.push(B)
    await B.start()

    // Terminal 2 joins as a REAL PEER and syncs terminal 1's chain — xen included.
    await waitFor(() => B.node()?.ledger.members.has("xen") === true, 15_000, "xen visible in terminal 2")
    await waitFor(() => B.clusterInfo().mesh_size === 2, 10_000, "two peers in one mesh")

    // Both terminals now commit on ONE shared chain
    await waitFor(
      () => {
        const a = A.node(), b = B.node()
        return !!a && !!b && a.tipHash === b.tipHash && Math.abs(a.height - b.height) <= 1
      },
      15_000,
      "both terminals on the same tip",
    )
  }, 60_000)

  test("registry failover: the local phone book migrates when its host exits", async () => {
    // A starts first → hosts the loopback registry
    const A = new SoloNodeBackend(soloCfg("host-1", []))
    backends.push(A)
    await A.start()
    await waitFor(() => (A.snapshot()?.block_height ?? 0) >= 1, 15_000, "A genesis")

    // B joins via the registry A hosts
    const seeds = await lookupOnce([localRegistryAddr(RDV_PORT)], NET)
    expect(seeds.length).toBe(1)
    const B = new SoloNodeBackend(soloCfg("host-2", seeds))
    backends.push(B)
    await B.start()
    await waitFor(() => B.clusterInfo().mesh_size === 2, 10_000, "B meshed with A")

    // A exits (its registry dies with it). B keeps running.
    await A.shutdown()
    backends = backends.filter((b) => b !== A)

    // B's dial-assist notices the dead registry, claims the port, and
    // re-registers itself — the phone book now lives with the survivor.
    const bEp = B.inviteInfo()?.endpoint
    expect(bEp).toBeTruthy()
    const deadline = Date.now() + 20_000
    let found: { host: string; port: number }[] = []
    while (Date.now() < deadline) {
      found = await lookupOnce([localRegistryAddr(RDV_PORT)], NET)
      if (found.some((e) => `${e.host}:${e.port}` === bEp)) break
      await new Promise((r) => setTimeout(r, 200))
    }
    expect(found.some((e) => `${e.host}:${e.port}` === bEp)).toBe(true)

    // …and B's chain is still alive and advancing on its own.
    const h = B.node()!.height
    await waitFor(() => B.node()!.height > h, 15_000, "B keeps committing after hosting takeover")
  }, 60_000)

  test("alone with no internet-layer discovery → the feed says how to be found", async () => {
    const A = new SoloNodeBackend(soloCfg("lone-node", []))
    backends.push(A)
    const events: string[] = []
    A.onActivity((ev) => events.push(`${ev.tag}:${ev.message}`))
    await A.start() // grace elapses with zero peers; loopback registry is not "external"
    const hint = events.find((e) => e.startsWith("discovery_hint:"))
    expect(hint).toBeTruthy()
    expect(hint).toContain("AEQUCHAIN_RENDEZVOUS")
  }, 30_000)
})
