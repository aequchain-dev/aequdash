/**
 * aequdash — tests/node/secure-gateway.test.ts
 *
 * The SAFE-internet path. A gateway started with a shared token (+TLS) must:
 *   - reject clients with NO token
 *   - reject clients with a WRONG token
 *   - serve clients with the CORRECT token (full command + snapshot access)
 *   - share mesh state across those authenticated clients
 *
 * The gateway is spawned as a plain child (NOT detached) so it dies with the
 * test process — no orphans.
 */

import { describe, test, expect, afterAll } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { Bridge } from "../../src/lib/bridge.ts"

const MESH_PORT = 29_000 + Math.floor(Math.random() * 1500)
const CTL_PORT = MESH_PORT + 1000
const TOKEN = "test-shared-secret-7f3a"
const HOST = "127.0.0.1"

let gateway: ChildProcess | null = null
const bridges: Bridge[] = []

afterAll(async () => {
  for (const b of bridges) { try { await b.stop() } catch { /* ignore */ } }
  if (gateway) { try { gateway.kill("SIGKILL") } catch { /* ignore */ } }
  await new Promise((r) => setTimeout(r, 800))
})

async function waitStatus(b: Bridge, want: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (b.status === want) return true
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
}

function makeBridge(token?: string): Bridge {
  const b = new Bridge({
    backend: "aeqnet",
    juliaBin: "julia",
    rpcScript: "/dev/null",
    cwd: process.cwd(),
    aeqnetNodes: 3,
    aeqnetPort: MESH_PORT,
    remoteGateway: `${HOST}:${CTL_PORT}`,
    token,
    tls: true,
  })
  bridges.push(b)
  return b
}

describe("secure gateway (token + TLS)", () => {
  test("rejects unauthenticated clients, serves authenticated ones, shares state", async () => {
    // Spawn the secure gateway as a plain child (dies with this test process).
    gateway = spawn(process.execPath, [
      "run", new URL("../../src/node/gateway.ts", import.meta.url).pathname,
      "--nodes", "3", "--port", String(MESH_PORT),
      "--serve", String(CTL_PORT), "--control-host", "127.0.0.1",
    ], {
      cwd: process.cwd(),
      stdio: ["ignore", "ignore", "pipe"],   // capture stderr for debugging
      env: {
        ...process.env,
        AEQUCHAIN_TOKEN: TOKEN,
        AEQUCHAIN_TLS_CERT: "/tmp/opencode/cert.pem",
        AEQUCHAIN_TLS_KEY: "/tmp/opencode/key.pem",
      },
    })
    gateway.stderr?.on("data", (d) => console.error("[gw]", String(d).trim()))

    // Wait for the control port to accept TLS connections.
    const portUp = await (async () => {
      const end = Date.now() + 30_000
      while (Date.now() < end) {
        try {
          const s = await Bun.connect({
            hostname: HOST, port: CTL_PORT, tls: { rejectUnauthorized: false },
            socket: { open(s) { s.end() }, data() {}, close() {}, error() {}, connectError() {} },
          })
          return true
        } catch { await new Promise((r) => setTimeout(r, 300)) }
      }
      return false
    })()
    expect(portUp).toBe(true)

    // Give genesis time to commit so the mesh reports ready.
    await new Promise((r) => setTimeout(r, 5_000))

    // (a) NO token → must NOT become ready
    const noTok = makeBridge(undefined)
    await noTok.start()
    expect(await waitStatus(noTok, "ready", 8_000)).toBe(false)

    // (b) WRONG token → must NOT become ready
    const badTok = makeBridge("definitely-wrong")
    await badTok.start()
    expect(await waitStatus(badTok, "ready", 8_000)).toBe(false)

    // (c) CORRECT token → ready, can command, shares state
    const good = makeBridge(TOKEN)
    await good.start()
    expect(await waitStatus(good, "ready", 30_000)).toBe(true)

    const join = await good.runCommand("join", ["secure_member", "750"])
    expect(join.ok).toBe(true)

    // (d) a SECOND authenticated client sees the same state (shared mesh)
    const good2 = makeBridge(TOKEN)
    await good2.start()
    expect(await waitStatus(good2, "ready", 15_000)).toBe(true)
    const snap = await good2.snapshot()
    expect(snap.members.some((m) => m.id === "secure_member")).toBe(true)
  }, 90_000)
})
