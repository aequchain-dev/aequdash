/**
 * aequdash — tests/node/tls-mesh.test.ts
 *
 * TLS on peer links: a mesh running TLS accepts TLS peers and rejects
 * plaintext ones (its bytes fail TLS negotiation — the honest failure).
 * Uses the repo's self-signed test cert (cert.pem/key.pem); clients dial
 * with rejectUnauthorized=false (testnet trust model).
 */

import { describe, test, expect, afterEach, beforeAll } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AequNode } from "../../src/node/node.ts"
import { demoSeedTxs } from "../../src/node/genesis.ts"

const PORT_BASE = 31_100 + Math.floor(Math.random() * 800)

// Self-signed test certs are GENERATED per run into a temp dir — no key
// material ever lives in the repo. (Skipped gracefully if openssl is absent.)
let CERT = ""
let KEY = ""

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "aequdash-tls-test-"))
  const key = join(dir, "key.pem")
  const cert = join(dir, "cert.pem")
  const res = spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", key, "-out", cert, "-subj", "/CN=aeqnet-test",
  ], { stdio: ["ignore", "pipe", "pipe"] })
  if (res.status !== 0) throw new Error("openssl unavailable — cannot generate test cert")
  CERT = cert
  KEY = key
})

let nodes: AequNode[] = []

afterEach(async () => {
  for (const n of nodes) await n.destroy()
  nodes = []
})

function tlsNode(id: string, port: number, seeds: { host: string; port: number }[], tls: boolean): AequNode {
  const node = new AequNode({
    nodeId: id,
    host: "127.0.0.1",
    port,
    seeds,
    clusterId: "tls-mesh-net",
    committeeSize: 3,
    thresholdOverride: null,
    epochSeed: "tls-42",
    blockTimeMs: 150,
    roundTimeoutMs: 1200,
    maxTxPerBlock: 16,
    seedTxs: demoSeedTxs(),
    bootstrap: true,
    peerTls: tls ? { cert: CERT, key: KEY } : undefined,
  })
  nodes.push(node)
  return node
}

async function settle(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

describe("TLS mesh links", () => {
  test("two TLS nodes handshake, mesh, and co-commit", async () => {
    const a = tlsNode("tls-a", PORT_BASE, [], true)
    const b = tlsNode("tls-b", PORT_BASE + 1, [{ host: "127.0.0.1", port: PORT_BASE }], true)
    await a.start()
    await b.start()
    a.enableConsensus()
    b.enableConsensus()

    // Peers connected over TLS
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && (a.mesh!.peerCount() !== 1 || b.mesh!.peerCount() !== 1)) {
      await settle(50)
    }
    expect(a.mesh!.peerCount()).toBe(1)
    expect(b.mesh!.peerCount()).toBe(1)

    // And consensus flows across the encrypted links
    while (Date.now() < deadline && !(a.height >= 1 && b.height >= 1)) {
      await settle(50)
    }
    expect(a.height).toBeGreaterThanOrEqual(1)
    expect(b.height).toBeGreaterThanOrEqual(1)
    expect(a.tipHash).toBe(b.tipHash)
  }, 20_000)

  test("a plaintext peer cannot join a TLS mesh", async () => {
    const a = tlsNode("tls-c", PORT_BASE + 10, [], true)
    const plain = tlsNode("plain-d", PORT_BASE + 11, [{ host: "127.0.0.1", port: PORT_BASE + 10 }], false)
    await a.start()
    await plain.start()
    await settle(1_500)
    expect(a.mesh!.peerCount()).toBe(0)
    expect(plain.mesh!.peerCount()).toBe(0)
  }, 15_000)
})
