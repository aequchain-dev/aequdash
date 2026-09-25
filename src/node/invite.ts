/**
 * aequdash — src/node/invite.ts
 *
 * Invite codes for the ephemeral testnet — the "join my network" UX.
 *
 * Format (human-shareable, one line, pasteable):
 *
 *   aeq://<slug>-<rand6>.<cksum8>?e=host:port[,host2:port2]&t=<token>
 *
 *   slug     lowercase network name chosen by the creator ("meadow")
 *   rand6    creator nonce — two people can both name a net "meadow"
 *            without colliding, because the cluster id differs
 *   cksum8   first 8 hex of sha256("aequchain:invite:" + clusterId + ":" +
 *            token) — a wrong password or mistyped code fails HERE, before
 *            any TCP dial is attempted
 *   e        comma-separated bootstrap endpoints (any live peer works —
 *            host migration means the creator need not be among them)
 *   t        network token (invite-gated admission). Absent = open network.
 *
 * The zero-arg default public testnet uses the well-known cluster id
 * "aequchain-public" and NO token — it is open by design (ephemeral demo
 * data only). Named nets get a real token and are closed by default.
 *
 * EPHEMERALITY: an invite encodes ONLY discovery information (cluster id,
 * endpoints, token). It carries no chain state. When the last node of a
 * network exits, the invite simply dials dead endpoints — the chain it once
 * pointed at no longer exists anywhere.
 */

import { sha256hex } from "./crypto.ts"

export interface Invite {
  /** Human name the creator chose (display only). */
  name: string
  /** Full cluster id: aeqnet-<slug>-<rand6> (or the public well-known id). */
  clusterId: string
  /** Bootstrap endpoints (host:port). At least one required to dial. */
  endpoints: { host: string; port: number }[]
  /** Network token; null = open network. */
  token: string | null
}

/** The well-known zero-arg public testnet. Open (no token) by design. */
export const PUBLIC_NET_NAME = "aequchain-public"
export const PUBLIC_CLUSTER_ID = "aequchain-public"

const INVITE_PREFIX = "aeq://"
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,30}$/

/** slug + rand → the deterministic cluster id (drives the genesis hash). */
export function clusterIdFor(name: string, rand: string): string {
  return `aeqnet-${name}-${rand}`
}

export function slugifyName(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "")
  if (!SLUG_RE.test(slug)) throw new Error(`invalid network name: "${name}" (use a–z, 0–9, dashes)`)
  return slug
}

/** Short url-safe random nonce (creator entropy). */
export function generateRand(): string {
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 6)
}

/** Invite-gated network token (url-safe). */
export function generateToken(): string {
  const bytes = new Uint8Array(18)
  crypto.getRandomValues(bytes)
  let s = ""
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function checksum(clusterId: string, token: string | null): string {
  return sha256hex(`aequchain:invite:${clusterId}:${token ?? ""}`).slice(0, 8)
}

/** Build an invite code. `namePart` is the slug; `rand` the creator nonce. */
export function buildInvite(opts: {
  name: string
  rand: string
  token?: string | null
  endpoints: { host: string; port: number }[]
}): string {
  if (opts.endpoints.length === 0) throw new Error("invite needs at least one bootstrap endpoint")
  const clusterId = clusterIdFor(opts.name, opts.rand)
  const eps = opts.endpoints.map((e) => `${e.host}:${e.port}`).join(",")
  let code = `${INVITE_PREFIX}${opts.name}-${opts.rand}.${checksum(clusterId, opts.token ?? null)}?e=${encodeURIComponent(eps)}`
  if (opts.token) code += `&t=${encodeURIComponent(opts.token)}`
  return code
}

/** Parse and checksum-verify an invite code. Throws on any malformation. */
export function parseInvite(code: string): Invite {
  const trimmed = code.trim()
  if (!trimmed.startsWith(INVITE_PREFIX)) throw new Error("invite must start with aeq://")
  const rest = trimmed.slice(INVITE_PREFIX.length)
  const qIdx = rest.indexOf("?")
  if (qIdx < 0) throw new Error("invite is missing its endpoint list (?e=…)")
  const head = rest.slice(0, qIdx)
  const query = rest.slice(qIdx + 1)

  const dotIdx = head.lastIndexOf(".")
  if (dotIdx < 0) throw new Error("invite is missing its checksum")
  const nameRand = head.slice(0, dotIdx)
  const cksum = head.slice(dotIdx + 1)
  const dashIdx = nameRand.lastIndexOf("-")
  if (dashIdx < 0) throw new Error("invite is missing its creator nonce")
  const name = nameRand.slice(0, dashIdx)
  const rand = nameRand.slice(dashIdx + 1)
  if (!SLUG_RE.test(name)) throw new Error(`invalid network name in invite: "${name}"`)
  if (!/^[a-z0-9]{6}$/.test(rand)) throw new Error("invalid creator nonce in invite")

  let endpoints: { host: string; port: number }[] = []
  let token: string | null = null
  for (const part of query.split("&")) {
    const eq = part.indexOf("=")
    if (eq < 0) continue
    const k = part.slice(0, eq)
    const v = decodeURIComponent(part.slice(eq + 1))
    if (k === "e") {
      endpoints = v.split(",").filter(Boolean).map((ep) => {
        const ci = ep.lastIndexOf(":")
        if (ci <= 0) throw new Error(`invalid endpoint in invite: "${ep}"`)
        const port = parseInt(ep.slice(ci + 1), 10)
        if (!Number.isFinite(port) || port <= 0 || port > 65535) throw new Error(`invalid port in invite: "${ep}"`)
        return { host: ep.slice(0, ci), port }
      })
    } else if (k === "t") {
      token = v
    }
  }
  if (endpoints.length === 0) throw new Error("invite carries no bootstrap endpoints")

  const clusterId = clusterIdFor(name, rand)
  if (checksum(clusterId, token) !== cksum) {
    throw new Error("invite checksum mismatch — wrong token or corrupted code")
  }
  return { name, clusterId, endpoints, token }
}
