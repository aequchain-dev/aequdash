/**
 * aequdash — src/node/netaddr.ts
 *
 * "What address should I advertise?" — answered per discovery scope,
 * automatically, with honest uncertainty.
 *
 *   loopback scope → 127.0.0.1            (same machine always dials loopback)
 *   lan scope      → first non-internal    (LAN peers dial the LAN IP)
 *   public scope   → discovered WAN IP     (internet rendezvous / invites)
 *
 * Public-IP discovery asks 3 independent echo services (HTTPS, 2.5s each,
 * first good answer wins). If none answer — offline, censored, or firewalled
 * — we fall back to the LAN guess and SAY SO, because:
 *
 *   A discovered public IP is NOT proof of reachability. Behind NAT without
 *   a port forward, the IP exists but inbound dials die at the router. The
 *   activity log must therefore never claim "peers can reach you" — only
 *   "this is the address we're advertising".
 */

import os from "node:os"

export type NetScope = "loopback" | "lan" | "public"

const IP_ECHO_SERVICES = [
  "https://api.ipify.org",
  "https://ifconfig.me/ip",
  "https://icanhazip.com",
] as const

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

export function isValidPublicIPv4(ip: string): boolean {
  const m = IPV4_RE.exec(ip.trim())
  if (!m) return false
  return [m[1], m[2], m[3], m[4]].every((o) => {
    const n = parseInt(o, 10)
    return n >= 0 && n <= 255
  })
}

/** First non-internal IPv4 of this machine (the LAN dial address). */
export function guessOutboundHost(): string {
  const ifaces = os.networkInterfaces()
  for (const list of Object.values(ifaces)) {
    for (const addr of list ?? []) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address
    }
  }
  return "127.0.0.1"
}

/**
 * Discover our public IPv4 via HTTPS echo services. Returns null when no
 * service answers with a valid IPv4 (offline / blocked / IPv6-only path).
 */
export async function discoverPublicIPv4(timeoutMs = 2_500): Promise<string | null> {
  for (const url of IP_ECHO_SERVICES) {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeoutMs)
      const res = await fetch(url, { signal: ctrl.signal })
      clearTimeout(timer)
      if (!res.ok) continue
      const text = (await res.text()).trim()
      if (isValidPublicIPv4(text)) return text
    } catch {
      // try the next echo service
    }
  }
  return null
}

/**
 * Resolve the address to advertise for a given scope.
 *
 * - loopback → always 127.0.0.1
 * - lan      → LAN interface guess
 * - public   → `advertise` override if set (and not "auto"), else discovered
 *              WAN IP, else LAN guess (callers must phrase the log honestly)
 *
 * Returns { host, source } so the caller can log HOW the address was chosen.
 */
export async function resolveAdvertisedHost(opts: {
  scope: NetScope
  advertise?: string
  /** Injectable for tests: the WAN discovery function. */
  discover?: () => Promise<string | null>
}): Promise<{ host: string; source: "explicit" | "discovered" | "lan-guess" | "loopback" }> {
  if (opts.scope === "loopback") return { host: "127.0.0.1", source: "loopback" }
  if (opts.scope === "lan") return { host: guessOutboundHost(), source: "lan-guess" }
  // public scope
  if (opts.advertise && opts.advertise !== "auto") {
    return { host: opts.advertise, source: "explicit" }
  }
  const discover = opts.discover ?? discoverPublicIPv4
  const found = await discover()
  if (found) return { host: found, source: "discovered" }
  return { host: guessOutboundHost(), source: "lan-guess" }
}
