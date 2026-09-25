/**
 * aequdash — tests/node/token-gate.test.ts
 *
 * Invite-gated mesh admission (the Sybil gate for internet-open meshes):
 * a mesh running WITH a network token only accepts peers that prove it in
 * the handshake; wrong-token and no-token peers are dropped pre-registration.
 */

import { describe, test, expect, afterEach } from "bun:test"
import { AequNode } from "../../src/node/node.ts"

const PORT_BASE = 26_100 + Math.floor(Math.random() * 1000)

let nodes: AequNode[] = []

afterEach(async () => {
  for (const n of nodes) await n.destroy()
  nodes = []
})

function makeNode(id: string, port: number, clusterId: string, token?: string, seeds: { host: string; port: number }[] = []): AequNode {
  const node = new AequNode({
    nodeId: id,
    host: "127.0.0.1",
    port,
    seeds,
    clusterId,
    committeeSize: 3,
    thresholdOverride: null,
    epochSeed: "tg-42",
    blockTimeMs: 150,
    roundTimeoutMs: 1000,
    maxTxPerBlock: 16,
    token,
  })
  nodes.push(node)
  return node
}

async function settle(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

describe("mesh token gate (invite-gated admission)", () => {
  test("matching token → peers connect", async () => {
    const a = makeNode("tok-a", PORT_BASE, "tok-net", "sekret")
    const b = makeNode("tok-b", PORT_BASE + 1, "tok-net", "sekret", [{ host: "127.0.0.1", port: PORT_BASE }])
    await a.start()
    await b.start()
    await settle(800)
    expect(a.mesh!.peerCount()).toBe(1)
    expect(b.mesh!.peerCount()).toBe(1)
  }, 15_000)

  test("wrong token → rejected at the handshake", async () => {
    const a = makeNode("tok-c", PORT_BASE + 10, "tok-net-2", "sekret")
    const b = makeNode("tok-d", PORT_BASE + 11, "tok-net-2", "WRONG", [{ host: "127.0.0.1", port: PORT_BASE + 10 }])
    await a.start()
    await b.start()
    await settle(800)
    expect(a.mesh!.peerCount()).toBe(0)
    expect(b.mesh!.peerCount()).toBe(0)
  }, 15_000)

  test("no token vs token-gated mesh → rejected", async () => {
    const a = makeNode("tok-e", PORT_BASE + 20, "tok-net-3", "sekret")
    const b = makeNode("tok-f", PORT_BASE + 21, "tok-net-3", undefined, [{ host: "127.0.0.1", port: PORT_BASE + 20 }])
    await a.start()
    await b.start()
    await settle(800)
    expect(a.mesh!.peerCount()).toBe(0)
    expect(b.mesh!.peerCount()).toBe(0)
  }, 15_000)

  test("open mesh (no token) still interoperates — backwards compatible", async () => {
    const a = makeNode("open-a", PORT_BASE + 30, "open-net")
    const b = makeNode("open-b", PORT_BASE + 31, "open-net", undefined, [{ host: "127.0.0.1", port: PORT_BASE + 30 }])
    await a.start()
    await b.start()
    await settle(800)
    expect(a.mesh!.peerCount()).toBe(1)
    expect(b.mesh!.peerCount()).toBe(1)
  }, 15_000)
})
