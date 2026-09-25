/**
 * aequdash — src/node/registry.ts
 *
 * The rendezvous REGISTRY CORE — shared between the standalone server
 * (scripts/rendezvous.ts) and the embedded loopback registry every solo
 * node tries to host (src/node/solo.ts).
 *
 * What it stores (ALL of it, in RAM, with a TTL):
 *
 *   netHash → endpoint → { node, expiresAt, registeredAt }
 *
 * What it can NEVER store: transactions, blocks, members, treasuries, or
 * cleartext network names (clients register the cluster-id HASH). A dead
 * network's entries rot out within one TTL window — the phone book holds
 * no chain state, so it can never outlive the chain in any meaningful way.
 *
 * Ops (newline-delimited JSON over TCP):
 *   {"op":"register","net":"<hex>","endpoint":"h:p","node":"<id>"}  (also keepalive)
 *   {"op":"lookup","net":"<hex>"}  → {"ok":true,"endpoints":[{endpoint,node,age_ms}]}
 *   {"op":"leave","net":"<hex>","endpoint":"h:p"}
 *   {"op":"stats"}                 → {"ok":true,"networks":N,"endpoints":M}
 *
 * If a registry token is configured, every op must also carry
 * "auth" = sha256("aequchain:rdvauth:" + token) — a spam gate for the
 * registry itself (orthogonal to per-network invite tokens).
 */

import { createHash } from "node:crypto"

export interface RegistryOptions {
  ttlMs?: number
  sweepMs?: number
  /** Shared secret for the registry itself (AEQUCHAIN_RDV_TOKEN). */
  token?: string | null
}

interface Registration {
  node: string
  expiresAt: number
  registeredAt: number
}

const DEFAULT_TTL_MS = 90_000
const DEFAULT_SWEEP_MS = 15_000
const MAX_FRAME = 64 * 1024

function sha256hex(s: string): string {
  return createHash("sha256").update(s).digest("hex")
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export class Registry {
  private readonly ttlMs: number
  private readonly sweepMs: number
  private readonly token: string | null
  private readonly registry = new Map<string, Map<string, Registration>>()
  private sweepTimer: ReturnType<typeof setInterval> | null = null

  constructor(opts: RegistryOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
    this.sweepMs = opts.sweepMs ?? DEFAULT_SWEEP_MS
    this.token = opts.token ?? null
  }

  /** True if the request carries a valid registry token (when configured). */
  private authed(msg: Record<string, unknown>): boolean {
    if (this.token === null) return true
    return safeEqual(String(msg.auth ?? ""), sha256hex(`aequchain:rdvauth:${this.token}`))
  }

  /** Apply one op; returns the reply object. Pure (no I/O) — testable. */
  handle(msg: Record<string, unknown>, now = Date.now()): Record<string, unknown> {
    if (!this.authed(msg)) return { ok: false, error: "unauthorized" }
    switch (msg.op) {
      case "register": {
        const net = String(msg.net ?? "")
        const endpoint = String(msg.endpoint ?? "")
        const node = String(msg.node ?? "")
        if (!/^(0x)?[0-9a-f]{64}$/i.test(net) || !endpoint.includes(":")) {
          return { ok: false, error: "bad register" }
        }
        let m = this.registry.get(net)
        if (!m) { m = new Map(); this.registry.set(net, m) }
        m.set(endpoint, { node, expiresAt: now + this.ttlMs, registeredAt: now })
        return { ok: true, ttl_ms: this.ttlMs }
      }
      case "lookup": {
        const net = String(msg.net ?? "")
        const m = this.registry.get(net)
        if (!m) return { ok: true, endpoints: [] }
        const out: { endpoint: string; node: string; age_ms: number }[] = []
        for (const [endpoint, reg] of m) {
          if (reg.expiresAt <= now) continue
          out.push({ endpoint, node: reg.node, age_ms: now - reg.registeredAt })
        }
        return { ok: true, endpoints: out }
      }
      case "leave": {
        const net = String(msg.net ?? "")
        const endpoint = String(msg.endpoint ?? "")
        const m = this.registry.get(net)
        if (m) {
          m.delete(endpoint)
          if (m.size === 0) this.registry.delete(net)
        }
        return { ok: true }
      }
      case "stats": {
        let endpoints = 0
        for (const m of this.registry.values()) endpoints += m.size
        return { ok: true, networks: this.registry.size, endpoints }
      }
      default:
        return { ok: false, error: `unknown op: ${String(msg.op)}` }
    }
  }

  /** Drop expired registrations (and now-empty networks). */
  sweep(now = Date.now()): void {
    for (const [net, m] of this.registry) {
      for (const [endpoint, reg] of m) {
        if (reg.expiresAt <= now) m.delete(endpoint)
      }
      if (m.size === 0) this.registry.delete(net)
    }
  }

  /** Number of live registrations (diagnostics). */
  get size(): number {
    let n = 0
    for (const m of this.registry.values()) n += m.size
    return n
  }

  /**
   * Serve this registry on a TCP port (newline-delimited JSON).
   * Returns the bound port, or NULL if the address is taken — callers use
   * that to fail over to the registry that is already running (loopback
   * hosting election: first binder wins, everyone else just uses it).
   */
  listen(host: string, port: number): { port: number; stop: () => void } | null {
    this.startSweeper()
    try {
      const server = Bun.listen<undefined>({
        hostname: host,
        port,
        socket: {
          open: () => {},
          data: (sock, chunk) => {
            const text = new TextDecoder().decode(chunk)
            if (text.length > MAX_FRAME) { try { sock.end() } catch { /* ignore */ } ; return }
            for (const line of text.split("\n")) {
              const trimmed = line.trim()
              if (!trimmed) continue
              let reply: Record<string, unknown>
              try {
                reply = this.handle(JSON.parse(trimmed))
              } catch {
                reply = { ok: false, error: "malformed" }
              }
              try { sock.write(JSON.stringify(reply) + "\n") } catch { /* ignore */ }
            }
          },
          error: () => { /* client errors are inconsequential */ },
        },
      })
      return { port: server.port, stop: () => { try { server.stop(true) } catch { /* ignore */ } } }
    } catch {
      return null // address taken — another registry already serves this address
    }
  }

  private startSweeper(): void {
    if (this.sweepTimer) return
    this.sweepTimer = setInterval(() => this.sweep(), this.sweepMs)
  }

  stop(): void {
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null }
  }
}
