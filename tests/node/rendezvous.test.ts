/**
 * aequdash — tests/node/rendezvous.test.ts
 *
 * Rendezvous server + client: register → lookup → leave → TTL expiry.
 * Proves the discovery layer works AND that it holds nothing but
 * short-lived endpoint registrations (ephemerality of the phone book).
 */

import { describe, test, expect, afterEach } from "bun:test"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { RendezvousClient, lookupOnce, netKey } from "../../src/node/rendezvous.ts"

const PORT = 24_300 + Math.floor(Math.random() * 1000)
const SERVER = `127.0.0.1:${PORT}`

let proc: ChildProcessWithoutNullStreams | null = null

async function startServer(env: Record<string, string> = {}): Promise<void> {
  proc = spawn("bun", ["run", new URL("../../scripts/rendezvous.ts", import.meta.url).pathname, "--port", String(PORT), "--host", "127.0.0.1"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  }) as ChildProcessWithoutNullStreams
  // Wait for the listen line
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("rendezvous server did not start")), 10_000)
    proc!.stdout.setEncoding("utf8")
    proc!.stdout.on("data", (chunk: string) => {
      if (/listening/.test(chunk)) { clearTimeout(timer); resolve() }
    })
    proc!.stderr.setEncoding("utf8")
    proc!.stderr.on("data", () => {})
  })
}

afterEach(() => {
  if (proc) { try { proc.kill("SIGKILL") } catch { /* ignore */ } ; proc = null }
})

describe("rendezvous registry", () => {
  test("register → lookup → leave lifecycle", async () => {
    await startServer()
    const client = new RendezvousClient({
      server: SERVER,
      clusterId: "aeqnet-testnet-abc123",
      endpoint: { host: "203.0.113.9", port: 7920 },
      nodeId: "node-x",
    })
    // register directly (no keepalive loop for the test)
    const reg = await client.request({
      op: "register", net: netKey("aeqnet-testnet-abc123"),
      endpoint: "203.0.113.9:7920", node: "node-x",
    })
    expect(reg.ok).toBe(true)

    const found = await lookupOnce(SERVER, "aeqnet-testnet-abc123")
    expect(found).toEqual([{ host: "203.0.113.9", port: 7920 }])

    const left = await client.request({
      op: "leave", net: netKey("aeqnet-testnet-abc123"), endpoint: "203.0.113.9:7920",
    })
    expect(left.ok).toBe(true)
    expect(await lookupOnce(SERVER, "aeqnet-testnet-abc123")).toEqual([])
  }, 20_000)

  test("networks are isolated by hash; unknown net → empty", async () => {
    await startServer()
    const client = new RendezvousClient({
      server: SERVER, clusterId: "aeqnet-a-111111",
      endpoint: { host: "10.0.0.1", port: 7920 }, nodeId: "n1",
    })
    await client.request({ op: "register", net: netKey("aeqnet-a-111111"), endpoint: "10.0.0.1:7920", node: "n1" })
    expect(await lookupOnce(SERVER, "aeqnet-a-111111")).toHaveLength(1)
    expect(await lookupOnce(SERVER, "aeqnet-b-222222")).toEqual([])
  }, 20_000)

  test("TTL expiry: stale registrations rot out (ephemerality of discovery)", async () => {
    await startServer({ AEQUCHAIN_RDV_TTL_MS: "300", AEQUCHAIN_RDV_SWEEP_MS: "100" })
    const client = new RendezvousClient({
      server: SERVER, clusterId: "aeqnet-ttl-999999",
      endpoint: { host: "10.9.8.7", port: 7920 }, nodeId: "n1",
    })
    await client.request({ op: "register", net: netKey("aeqnet-ttl-999999"), endpoint: "10.9.8.7:7920", node: "n1" })
    expect(await lookupOnce(SERVER, "aeqnet-ttl-999999")).toHaveLength(1)
    // No keepalive → entry must expire (TTL 300ms + sweep 100ms + slack)
    await new Promise((r) => setTimeout(r, 900))
    expect(await lookupOnce(SERVER, "aeqnet-ttl-999999")).toEqual([])
  }, 20_000)

  test("keepalive keeps a registration fresh across TTL windows", async () => {
    await startServer({ AEQUCHAIN_RDV_TTL_MS: "600", AEQUCHAIN_RDV_SWEEP_MS: "100" })
    const client = new RendezvousClient({
      server: SERVER, clusterId: "aeqnet-keepalive-01",
      endpoint: { host: "10.1.2.3", port: 7920 }, nodeId: "n1",
    })
    // Patch the client's keepalive interval by calling register manually in a loop
    const timer = setInterval(() => {
      void client.request({ op: "register", net: netKey("aeqnet-keepalive-01"), endpoint: "10.1.2.3:7920", node: "n1" })
    }, 200)
    await new Promise((r) => setTimeout(r, 1_200)) // > 2 TTL windows
    clearInterval(timer)
    expect(await lookupOnce(SERVER, "aeqnet-keepalive-01")).toHaveLength(1)
  }, 20_000)

  test("malformed and unauthorized requests are handled", async () => {
    await startServer()
    const client = new RendezvousClient({
      server: SERVER, clusterId: "aeqnet-any",
      endpoint: { host: "127.0.0.1", port: 1 }, nodeId: "n1",
    })
    const bad = await client.request({ op: "register", net: "not-a-hash", endpoint: "x" })
    expect(bad.ok).toBe(false)
    const unknown = await client.request({ op: "nonsense" })
    expect(unknown.ok).toBe(false)
  }, 20_000)
})
