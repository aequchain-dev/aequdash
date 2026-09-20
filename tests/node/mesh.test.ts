/**
 * aequdash — tests/node/mesh.test.ts
 *
 * END-TO-END: three real AequNode processes-of-logic on a real TCP mesh.
 * Proves: mesh formation, peer visibility, block consensus, tx replication,
 * state convergence, and ephemerality.
 *
 * Nodes run in-process (one bun process, three nodes) but communicate only
 * through real TCP sockets on 127.0.0.1 — the same code path as the
 * multi-process daemon deployment.
 */

import { describe, test, expect, afterEach } from "bun:test"
import { AequNode } from "../../src/node/node.ts"
import { makeTx } from "../../src/node/block.ts"
import type { Tx } from "../../src/node/proto.ts"

const PORT_BASE = 19_700 + Math.floor(Math.random() * 2000)

let nodes: AequNode[] = []

afterEach(async () => {
  for (const n of nodes) await n.destroy()
  nodes = []
})

async function startCluster(n: number, clusterId: string): Promise<AequNode[]> {
  const cluster: AequNode[] = []
  for (let i = 0; i < n; i++) {
    const node = new AequNode({
      nodeId: `test-node-${i + 1}`,
      host: "127.0.0.1",
      port: PORT_BASE + i,
      seeds: i === 0 ? [] : [{ host: "127.0.0.1", port: PORT_BASE }], // dial node-1
      clusterId,
      committeeSize: n,
      thresholdOverride: null,
      epochSeed: "test-42",
      blockTimeMs: 150,
      roundTimeoutMs: 1200,
      maxTxPerBlock: 64,
    })
    cluster.push(node)
  }
  for (const node of cluster) await node.start()
  // Full mesh: every node dials every higher-numbered node
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      await cluster[j].mesh!.dial("127.0.0.1", PORT_BASE + i)
    }
  }
  // Wait for full peer visibility
  await waitFor(() => cluster.every((c) => (c.mesh?.peerCount() ?? 0) === n - 1), 8_000)
  // Enable consensus everywhere
  for (const node of cluster) node.enableConsensus()
  nodes = cluster
  return cluster
}

async function waitFor(pred: () => boolean, timeoutMs: number, step = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, step))
  }
  throw new Error("waitFor timeout")
}

describe("mesh: formation & visibility", () => {
  test("3 nodes form a full mesh — each sees the other two", async () => {
    const cluster = await startCluster(3, "mesh-vis")
    for (const node of cluster) {
      expect(node.mesh!.peerCount()).toBe(2)
      const ids = node.mesh!.livePeers().map((p) => p.id).sort()
      const expected = cluster.map((c) => c.cfg.nodeId).filter((id) => id !== node.cfg.nodeId).sort()
      expect(ids).toEqual(expected)
    }
    // clusterInfo reports the full mesh from any node's perspective
    const info = cluster[0].clusterInfo()
    expect(info.mesh_size).toBe(3)
    expect(info.nodes.length).toBe(3)
  }, 20_000)

  test("genesis hash isolates meshes — foreign node is rejected", async () => {
    const a = await startCluster(1, "mesh-a")
    const intruder = new AequNode({
      nodeId: "intruder", host: "127.0.0.1", port: PORT_BASE + 500,
      seeds: [{ host: "127.0.0.1", port: PORT_BASE }],
      clusterId: "DIFFERENT-CLUSTER", committeeSize: 1, thresholdOverride: null,
      epochSeed: "x", blockTimeMs: 150, roundTimeoutMs: 1000, maxTxPerBlock: 16,
    })
    await intruder.start()
    await new Promise((r) => setTimeout(r, 600))
    expect(a[0].mesh!.peerCount()).toBe(0) // never accepted
    expect(intruder.mesh!.peerCount()).toBe(0)
    await intruder.destroy()
  }, 15_000)
})

describe("mesh: consensus & replication", () => {
  test("blocks commit across all nodes; roots converge", async () => {
    const cluster = await startCluster(3, "mesh-consensus")
    await waitFor(() => cluster.every((c) => c.height >= 3), 15_000)
    const roots = cluster.map((c) => c.tipStateRoot())
    // All nodes converged on the same tip
    expect(new Set(roots).size).toBe(1)
    // QCs exist for every block
    expect(cluster[0].qcs.length).toBeGreaterThanOrEqual(3)
    const qc = cluster[0].qcs.at(-1)!
    expect(qc.votes.length).toBeGreaterThanOrEqual(qc.threshold)
  }, 25_000)

  test("a tx submitted to one node commits on ALL nodes", async () => {
    const cluster = await startCluster(3, "mesh-tx")
    await waitFor(() => cluster.every((c) => c.height >= 2), 15_000)

    // Submit via node-3 (not node-1)
    const t = makeTx("join", "system", { id: "livemember", deposit: "777.50", region: "Test", status: "active" }, Date.now(), 1)
    cluster[2].submitTx("join", "system", { id: "livemember", deposit: "777.50", region: "Test", status: "active" }, t.clientTs, 1)

    await waitFor(() => cluster.every((c) => c.ledger.members.has("livemember")), 15_000)
    // Identical state on all replicas
    const digests = cluster.map((c) => c.ledger.digest())
    expect(new Set(digests).size).toBe(1)
    // Equality holds everywhere
    for (const c of cluster) {
      expect(c.ledger.equalityReport().allPassed).toBe(true)
    }
  }, 25_000)
})

describe("mesh: ephemerality", () => {
  test("a node that stops is dropped from every peer's view", async () => {
    const cluster = await startCluster(3, "mesh-eph")
    await cluster[2].stop() // graceful bye
    await waitFor(() => cluster[0].mesh!.peerCount() === 1 && cluster[1].mesh!.peerCount() === 1, 8_000)
    const info = cluster[0].clusterInfo()
    expect(info.mesh_size).toBe(2)
    expect(info.nodes.map((n) => n.id)).not.toContain("test-node-3")
  }, 20_000)

  test("destroy wipes all state (nothing survives, nothing persists)", async () => {
    const cluster = await startCluster(3, "mesh-wipe")
    await waitFor(() => cluster.every((c) => c.height >= 2), 15_000)
    const victim = cluster[1]
    await victim.destroy()
    expect(victim.height).toBe(0)
    expect(victim.ledger.memberCount()).toBe(0)
    expect(victim.blocks.length).toBe(0)
    expect(victim.mesh).toBeNull()
    expect(victim.running).toBe(false)
  }, 25_000)
})
