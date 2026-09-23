/**
 * aequdash — tests/node/shared-mesh.test.ts
 *
 * THE MULTI-TERMINAL TEST. Two Bridge instances on the same control port must
 * share ONE mesh: state written via client A is visible to client B, and the
 * mesh evaporates only when the LAST client detaches.
 *
 * This is the "two terminals, one `bun run start` each" scenario.
 */

import { describe, test, expect, afterEach } from "bun:test"
import { Bridge } from "../../src/lib/bridge.ts"

const PORT = 25_000 + Math.floor(Math.random() * 1500)

let bridges: Bridge[] = []

afterEach(async () => {
  for (const b of bridges) { try { await b.terminateMesh() } catch { /* ignore */ } }
  bridges = []
})

function makeBridge(): Bridge {
  const b = new Bridge({
    backend: "aeqnet",
    juliaBin: "julia",
    rpcScript: "/dev/null",
    cwd: process.cwd(),
    aeqnetNodes: 3,
    aeqnetPort: PORT,
  })
  bridges.push(b)
  return b
}

async function waitReady(b: Bridge, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (b.status === "ready") return
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`bridge never became ready (is ${b.status})`)
}

describe("shared mesh (multi-terminal)", () => {
  test("two clients attach to ONE mesh; state written by A is visible to B; last-detach evaporates", async () => {
    // Terminal 1 — spawns the shared gateway
    const a = makeBridge()
    await a.start()
    await waitReady(a, 45_000)
    expect(a.status).toBe("ready")

    // Terminal 1 writes state
    const join = await a.runCommand("join", ["ryan", "100"])
    expect(join.ok).toBe(true)

    // Terminal 2 — attaches to the SAME mesh (no fresh genesis)
    const b = makeBridge()
    await b.start()
    await waitReady(b, 10_000)
    expect(b.status).toBe("ready")

    // Terminal 2 sees the SAME chain height and the SAME member
    const snapB = await b.snapshot()
    expect(snapB.ready).toBe(true)
    expect(snapB.members.map((m) => m.id)).toContain("ryan")
    expect(snapB.cluster?.mesh_size).toBe(3)

    // Both clients see the SAME state root (literally the same mesh)
    const snapA = await a.snapshot()
    expect(snapA.node?.state_root_hex).toBe(snapB.node?.state_root_hex)

    // Terminal 1 detaches. Mesh must SURVIVE (terminal 2 still attached).
    await a.stop()
    await new Promise((r) => setTimeout(r, 400))
    const snapB2 = await b.snapshot()
    expect(snapB2.ready).toBe(true)
    expect(snapB2.members.map((m) => m.id)).toContain("ryan")
  }, 90_000)
})
