/**
 * aequdash — tests/node/join-peer.test.ts
 *
 * THE LIFECYCLE E2E — the exact user story of the refactor:
 *
 *   1. first user anchors a network (solo genesis)
 *   2. later user joins as a REAL peer (syncs, votes, commits)
 *   3. first user leaves → second keeps the chain alive (host migration
 *      is a non-event: roster re-derives, threshold re-computes)
 *   4. last peer exits → the network's state ceases to exist
 *
 * Plus: the simultaneous-anchor genesis fork heals deterministically via
 * the tip-hash tiebreak.
 */

import { describe, test, expect, afterEach } from "bun:test"
import { AequNode } from "../../src/node/node.ts"
import { demoSeedTxs } from "../../src/node/genesis.ts"

const PORT_BASE = 28_700 + Math.floor(Math.random() * 800)

let nodes: AequNode[] = []

afterEach(async () => {
  for (const n of nodes) await n.destroy()
  nodes = []
})

function peerNode(id: string, port: number, clusterId: string, seeds: { host: string; port: number }[], bootstrap: boolean): AequNode {
  const node = new AequNode({
    nodeId: id,
    host: "127.0.0.1",
    port,
    seeds,
    clusterId,
    committeeSize: 3,
    thresholdOverride: null,
    epochSeed: "join-42",
    blockTimeMs: 150,
    roundTimeoutMs: 1200,
    maxTxPerBlock: 64,
    seedTxs: bootstrap ? demoSeedTxs() : [],
    bootstrap,
  })
  nodes.push(node)
  return node
}

async function waitFor(pred: () => boolean, timeoutMs: number, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`waitFor timeout: ${what}`)
}

describe("instance-is-node lifecycle", () => {
  test("anchor → peer joins → syncs → co-commits → anchor leaves → peer carries on", async () => {
    const NET = "lifecycle-net-1"
    // 1. FIRST USER: anchor. Solo until a peer appears.
    const anchor = peerNode("anchor", PORT_BASE, NET, [], true)
    await anchor.start()
    anchor.enableConsensus()
    // Anchors solo: roster=[anchor], threshold 1 → genesis commits alone
    await waitFor(() => anchor.height >= 1, 15_000, "anchor genesis commit")
    expect(anchor.ledger.memberCount()).toBeGreaterThan(0)

    // 2. LATER USER: joins via the anchor as seed; must sync and join roster
    const joiner = peerNode("joiner", PORT_BASE + 1, NET, [{ host: "127.0.0.1", port: PORT_BASE }], true)
    await joiner.start()
    joiner.enableConsensus()

    // Joiner syncs the chain from the anchor
    await waitFor(() => joiner.height >= anchor.height && anchor.height >= 1, 15_000, "joiner syncs to anchor tip")
    // Both see each other as caught-up roster members
    await waitFor(() => anchor.roster().includes("joiner") && joiner.roster().includes("anchor"), 10_000, "mutual roster membership")

    // The joiner PARTICIPATES IN CONSENSUS: a tx submitted to the JOINER
    // still commits (gossip → anchor/committee → commit), and both apply it.
    const heightBefore = anchor.height
    const tx = joiner.submitTx("join", "system", { id: "newcomer_1", deposit: "42.00", region: "Test", status: "active" }, Date.now(), 1)
    expect(tx.id).toBeTruthy()
    await waitFor(() => joiner.height > heightBefore && joiner.ledger.members.has("newcomer_1"), 15_000, "tx via joiner commits on joiner")
    await waitFor(() => anchor.ledger.members.has("newcomer_1"), 15_000, "tx via joiner replicates to anchor")

    // 3. HOST MIGRATION: the anchor (first user) leaves.
    const heightAtAnchorExit = anchor.height
    await anchor.stop() // graceful bye — peers see it leave
    // The joiner is now alone: roster shrinks to self, threshold drops to 1,
    // and the chain KEEPS COMMITTING. No handoff protocol was needed.
    await waitFor(() => joiner.mesh!.peerCount() === 0, 10_000, "joiner sees anchor leave")
    await waitFor(() => joiner.height > heightAtAnchorExit, 15_000, "chain continues under the joiner")
    expect(joiner.ledger.members.has("newcomer_1")).toBe(true) // state survived the anchor

    // 4. FULL EPHEMERALITY: the last peer exits → state ceases to exist.
    await joiner.destroy()
    expect(joiner.height).toBe(0)
    expect(joiner.blocks.length).toBe(0)
    expect(joiner.ledger.memberCount()).toBe(0)
  }, 60_000)

  test("simultaneous solo anchors converge via the tip-hash tiebreak", async () => {
    const NET = "fork-heal-net"
    // Two nodes bootstrap the SAME network with NO knowledge of each other.
    // Both self-commit their own block 1 (different proposer → different tip).
    const a = peerNode("anchor-a", PORT_BASE + 10, NET, [], true)
    const b = peerNode("anchor-b", PORT_BASE + 11, NET, [], true)
    await a.start()
    await b.start()
    a.enableConsensus()
    b.enableConsensus()

    await waitFor(() => a.height >= 1 && b.height >= 1, 15_000, "both anchors solo-commit block 1")
    expect(a.tipHash).not.toBe(b.tipHash) // genuinely divergent tips

    // They discover each other (rendezvous would do this on the internet).
    await a.mesh!.dial("127.0.0.1", PORT_BASE + 11)

    // The tiebreak (lexicographically smaller tip wins) heals the fork:
    // the loser wipes to genesis and re-syncs from the winner.
    await waitFor(() => a.tipHash === b.tipHash && a.height === b.height, 20_000, "fork heals to a single tip")
    expect(a.height).toBeGreaterThanOrEqual(1)

    // And the merged network keeps committing.
    const h = a.height
    await waitFor(() => a.height > h && b.height >= a.height - 1, 15_000, "merged network keeps committing")
  }, 60_000)

  test("a late joiner does not stall the committee (catch-up roster filter)", async () => {
    const NET = "catchup-net"
    const anchor = peerNode("anchor", PORT_BASE + 20, NET, [], true)
    await anchor.start()
    anchor.enableConsensus()
    await waitFor(() => anchor.height >= 3, 15_000, "anchor advances alone")

    // A joiner connects but we DON'T let it sync (simulate a slow peer by
    // observing roster before sync completes): the anchor must not be stuck
    // waiting on votes from a node at height 0.
    const joiner = peerNode("slow-joiner", PORT_BASE + 21, NET, [{ host: "127.0.0.1", port: PORT_BASE + 20 }], true)
    await joiner.start()
    // (no enableConsensus on the joiner yet — it's still catching up)

    // The anchor's roster must exclude the behind peer…
    await waitFor(() => anchor.mesh!.peerCount() === 1, 10_000, "anchor sees the joiner")
    expect(anchor.roster()).not.toContain("slow-joiner")
    // …and the chain keeps moving at full speed.
    const h = anchor.height
    await waitFor(() => anchor.height > h, 10_000, "chain unstalled by the syncing joiner")
  }, 60_000)
})
