/**
 * aequdash — src/node/rendezvous.ts
 *
 * Rendezvous CLIENT for the ephemeral testnet — the internet-first phone
 * book. A rendezvous server answers exactly one question:
 *
 *   "who is currently live for network hash H?"  →  [endpoints]
 *
 * EPHEMERALITY BY CONSTRUCTION: the registry holds ONLY
 *   netHash → { endpoint → (nodeId, expiry) }
 * with a 90s TTL refreshed by keepalive. It never sees a transaction, a
 * block, a member, or a treasury value — chain state lives exclusively in
 * node RAM. When the last node of a network stops keepaliving, its
 * registrations rot out and the network is gone from the universe.
 *
 * Privacy: clients register the HASH of the cluster id, never the human
 * network name. Strangers browsing the registry learn nothing about which
 * named networks exist.
 *
 * Wire protocol: newline-delimited JSON over TCP (same framing discipline
 * as the mesh, minus gossip):
 *   → {"op":"register","net":"<hex>","endpoint":"host:port","node":"<id>"}
 *   → {"op":"lookup","net":"<hex>"}
 *   → {"op":"leave","net":"<hex>","endpoint":"host:port"}
 *   ← {"ok":true, ...} / {"ok":false,"error":"..."}
 */

import { sha256hex } from "./crypto.ts"

export interface RendezvousEndpoint {
  host: string
  port: number
}

interface RegistryEntry {
  endpoint: string
  node: string
  ageMs: number
}

const KEEPALIVE_MS = 30_000
const REQUEST_TIMEOUT_MS = 5_000

/** The registry key for a network — a hash, never the cleartext name. */
export function netKey(clusterId: string): string {
  return sha256hex(`aequchain:rendezvous:${clusterId}`)
}

export class RendezvousClient {
  private servers: { host: string; port: number }[]
  private clusterId: string
  private endpointFor: (serverHost: string) => RendezvousEndpoint
  private nodeId: string
  private timer: ReturnType<typeof setInterval> | null = null
  private logFn: (msg: string) => void

  constructor(opts: {
    /** One or more "host:port" rendezvous addresses (redundancy: register to ALL, lookup merges). */
    server: string | string[]
    clusterId: string
    /**
     * OUR dialable endpoint — either fixed, or resolved PER SERVER (e.g. the
     * loopback registry gets 127.0.0.1:port; internet registries get the
     * public address). The resolver receives the registry's host.
     */
    endpoint: RendezvousEndpoint | ((serverHost: string) => RendezvousEndpoint)
    nodeId: string
    log?: (msg: string) => void
  }) {
    const list = (Array.isArray(opts.server) ? opts.server : [opts.server])
      .map((s) => s.trim())
      .filter(Boolean)
    if (list.length === 0) throw new Error("rendezvous: at least one server required")
    this.servers = list.map((s) => {
      const ci = s.lastIndexOf(":")
      if (ci <= 0) throw new Error(`invalid rendezvous address: "${s}" (want host:port)`)
      const port = parseInt(s.slice(ci + 1), 10)
      if (!Number.isFinite(port)) throw new Error(`invalid rendezvous port in "${s}"`)
      return { host: s.slice(0, ci), port }
    })
    this.clusterId = opts.clusterId
    this.endpointFor = typeof opts.endpoint === "function"
      ? opts.endpoint
      : () => opts.endpoint as RendezvousEndpoint
    this.nodeId = opts.nodeId
    this.logFn = opts.log ?? (() => {})
  }

  /** One request, one response, one short-lived connection, one server. */
  private requestTo(server: { host: string; port: number }, msg: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let settled = false
      const done = (r: Record<string, unknown>) => { if (!settled) { settled = true; resolve(r) } }
      const fail = (e: Error) => { if (!settled) { settled = true; reject(e) } }
      const timer = setTimeout(() => fail(new Error("rendezvous timeout")), timeoutMs)
      try {
        let buf = ""
        Bun.connect({
          hostname: server.host,
          port: server.port,
          socket: {
            open: (sock) => { try { sock.write(JSON.stringify(msg) + "\n") } catch { /* fall through */ } },
            data: (sock, chunk) => {
              buf += new TextDecoder().decode(chunk)
              const nl = buf.indexOf("\n")
              if (nl < 0) return
              clearTimeout(timer)
              try { done(JSON.parse(buf.slice(0, nl))) } catch { fail(new Error("bad rendezvous reply")) }
              try { sock.end() } catch { /* ignore */ }
            },
            error: () => { clearTimeout(timer); fail(new Error("rendezvous connect error")) },
            connectError: () => { clearTimeout(timer); fail(new Error("rendezvous unreachable")) },
            close: () => { /* resolved on data; close without data = no reply */ },
          },
        }).catch(() => { clearTimeout(timer); fail(new Error("rendezvous connect failed")) })
      } catch (e) {
        clearTimeout(timer)
        fail(e as Error)
      }
    })
  }

  /** Broadcast a request to ALL servers; fulfill independently (failures tolerated). */
  async requestAll(msg: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Record<string, unknown>[]> {
    return Promise.all(this.servers.map((s) => this.requestTo(s, msg, timeoutMs).catch(() => null))).then(
      (rs) => rs.filter((r): r is Record<string, unknown> => r !== null),
    )
  }

  /** Single-server request (first configured) — used by tests and tooling. */
  request(msg: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Record<string, unknown>> {
    return this.requestTo(this.servers[0], msg, timeoutMs)
  }

  /** Register our endpoint on ALL servers and keep the registrations alive. */
  async start(): Promise<void> {
    await this.register()
    this.timer = setInterval(() => { void this.register() }, KEEPALIVE_MS)
  }

  /** One immediate registration on all servers (used right after failover rebinds). */
  async announce(): Promise<void> {
    await this.register()
  }

  private async register(): Promise<void> {
    // Resolve the advertised endpoint PER SERVER (loopback registry gets the
    // loopback address; internet registries get the public one).
    const results = await Promise.all(
      this.servers.map((s) => {
        const ep = this.endpointFor(s.host)
        return this.requestTo(s, {
          op: "register",
          net: netKey(this.clusterId),
          endpoint: `${ep.host}:${ep.port}`,
          node: this.nodeId,
        }).catch(() => null)
      }),
    ).then((rs) => rs.filter((r): r is Record<string, unknown> => r !== null))
    if (results.length === 0) this.logFn("rendezvous register failed on all servers")
    for (const res of results) {
      if (res.ok !== true) this.logFn(`rendezvous register rejected: ${String(res.error ?? "?")}`)
    }
  }

  /** Best-effort deregistration (peers would TTL out anyway in 90s). */
  async stop(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    try {
      await Promise.all(
        this.servers.map((s) => {
          const ep = this.endpointFor(s.host)
          return this.requestTo(s, {
            op: "leave",
            net: netKey(this.clusterId),
            endpoint: `${ep.host}:${ep.port}`,
          }).catch(() => null)
        }),
      )
    } catch { /* leaving is best-effort */ }
  }

  /** Who else is live on this network right now? (merged + deduped across servers) */
  async lookup(): Promise<RendezvousEndpoint[]> {
    return lookupOnce(this.servers.map((s) => `${s.host}:${s.port}`), this.clusterId)
  }
}

/**
 * One-shot lookup — usable before any node exists (the zero-arg join path):
 * ask EVERY configured registry for live endpoints of a network, then merge
 * and dedup the answers. One server being down never blinds a joiner.
 */
export async function lookupOnce(servers: string | string[], clusterId: string, timeoutMs = 5_000): Promise<RendezvousEndpoint[]> {
  const list = (Array.isArray(servers) ? servers : [servers]).map((s) => s.trim()).filter(Boolean)
  const client = new RendezvousClient({
    server: list.length > 0 ? list : ["127.0.0.1:1"], // placeholder; requestAll tolerates failure
    clusterId,
    endpoint: { host: "0.0.0.0", port: 0 }, // unused for lookup
    nodeId: "lookup",
  })
  const results = await client.requestAll({ op: "lookup", net: netKey(clusterId) }, timeoutMs)
  const seen = new Set<string>()
  const out: RendezvousEndpoint[] = []
  for (const res of results) {
    if (res.ok !== true || !Array.isArray(res.endpoints)) continue
    for (const e of res.endpoints as RegistryEntry[]) {
      const ep = String(e.endpoint)
      if (seen.has(ep)) continue
      seen.add(ep)
      const eci = ep.lastIndexOf(":")
      if (eci <= 0) continue
      const port = parseInt(ep.slice(eci + 1), 10)
      if (!Number.isFinite(port)) continue
      out.push({ host: ep.slice(0, eci), port })
    }
  }
  return out
}
