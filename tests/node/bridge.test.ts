/**
 * aequdash — tests/node/bridge.test.ts
 *
 * End-to-end: the aeqnet backend exactly as `bun run start` drives it.
 * Bridge → gateway process → node-1 + 2 daemon processes → TCP mesh →
 * consensus → snapshot. This is the release path, proven.
 */

import { describe, test, expect, afterEach } from "bun:test"
import { Bridge } from "../../src/lib/bridge.ts"

const PORT = 21_000 + Math.floor(Math.random() * 2000)

let bridge: Bridge | null = null

afterEach(async () => {
  if (bridge) await bridge.stop()
  bridge = null
})

async function waitStatus(b: Bridge, want: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (b.status === want) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`bridge never reached status ${want} (is ${b.status})`)
}

describe("aeqnet bridge (the `bun run start` path)", () => {
  test("boots a real 3-node mesh, serves snapshots, executes commands, shuts down clean", async () => {
    bridge = new Bridge({
      backend: "aeqnet",
      juliaBin: "julia",
      rpcScript: "/dev/null",
      cwd: process.cwd(),
      aeqnetNodes: 3,
      aeqnetPort: PORT,
    })
    await bridge.start()
    await waitStatus(bridge, "ready", 45_000)
    expect(bridge.status).toBe("ready")

    // Snapshot is live and real (gateway announces ready only after genesis
    // commits — the chain is populated at first contact)
    const snap = await bridge.snapshot()
    expect(snap.ready).toBe(true)
    expect(snap.block_height).toBeGreaterThanOrEqual(1)
    expect(snap.full_fidelity).toBe(true)
    expect(snap.cluster?.mesh_size).toBe(3)
    expect(snap.members_summary?.total_registered).toBeGreaterThan(4000)

    // Equality is exactly maintained
    expect(snap.equality?.all_passed).toBe(true)
    expect(snap.equality?.variance).toBe(0)

    // Command executes through consensus
    const result = await bridge.runCommand("join", ["bridgetest", "123.45"])
    expect(result.ok).toBe(true)

    // The new member exists in the next snapshot — on the whole mesh
    const snap2 = await bridge.snapshot()
    const names = snap2.members.map((m) => m.id)
    expect(names).toContain("bridgetest")

    // Node stop/start lifecycle works through the bridge
    const stop = await bridge.runCommand("node_stop", ["aeqnode-02"])
    expect(stop.ok).toBe(true)
    const midInfo = await bridge.call<{ mesh_size: number }>("net.nodes")
    expect(midInfo.mesh_size).toBe(2)

    const start = await bridge.runCommand("node_start", ["aeqnode-02"])
    expect(start.ok).toBe(true)
    await new Promise((r) => setTimeout(r, 2_500))
    const restored = await bridge.call<{ mesh_size: number }>("net.nodes")
    expect(restored.mesh_size).toBe(3)
  }, 90_000)
})
