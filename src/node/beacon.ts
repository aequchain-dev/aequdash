/**
 * aequdash — src/node/beacon.ts
 *
 * LAN discovery beacon — zero servers, zero config: nodes announce
 * themselves on the local subnet with UDP broadcasts, and listen for
 * others' announcements.
 *
 *   broadcast: {"v":1,"net":<netKey>,"ep":"host:port","node":"<id>"}
 *
 * A listener whose netKey matches dials the advertised endpoint — the mesh
 * handshake (genesis hash + optional network token) does the actual vetting,
 * so a beacon is only ever a HINT. A forged hint dials at worst a socket
 * that rejects the handshake.
 *
 * Scope honesty: subnet broadcast reaches the local LAN only. Same-machine
 * discovery is the loopback registry's job; internet discovery is the
 * rendezvous server's. This layer covers the middle: laptops on one LAN.
 *
 * Disable with AEQUCHAIN_NO_BEACON=1.
 */

import { netKey } from "./rendezvous.ts"

/** Minimal structural type over Bun's unconnected UDP socket (what we use). */
interface UdpSocketLike {
  send(data: string | Uint8Array, port: number, address: string): boolean
  setBroadcast(enabled: boolean): boolean
  close(): void
}

export const BEACON_PORT = 7921
export const BEACON_MS = 3_000
const MAGIC = "aeqnet-beacon"

export interface BeaconMessage {
  v: 1
  net: string        // netKey(clusterId) — a hash, never the cleartext name
  ep: string         // "host:port" — the announcer's dialable mesh endpoint
  node: string       // node id (self-filter)
}

export function encodeBeacon(msg: BeaconMessage): string {
  return JSON.stringify({ magic: MAGIC, ...msg })
}

/** Parse a beacon datagram; NULL for anything that isn't a well-formed beacon. */
export function decodeBeacon(data: Uint8Array | string): BeaconMessage | null {
  try {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data)
    const obj = JSON.parse(text)
    if (obj?.magic !== MAGIC || obj?.v !== 1) return null
    if (typeof obj.net !== "string" || typeof obj.ep !== "string" || typeof obj.node !== "string") return null
    const ci = obj.ep.lastIndexOf(":")
    if (ci <= 0) return null
    const port = parseInt(obj.ep.slice(ci + 1), 10)
    if (!Number.isFinite(port) || port <= 0 || port > 65535) return null
    return { v: 1, net: obj.net, ep: obj.ep, node: obj.node }
  } catch {
    return null
  }
}

export interface LanBeaconOptions {
  clusterId: string
  nodeId: string
  endpoint: { host: string; port: number }   // OUR advertised mesh endpoint
  port?: number                              // beacon UDP port (default 7921)
  broadcastAddr?: string                     // default 255.255.255.255 (tests: 127.0.0.1 directed)
  intervalMs?: number                        // default 3000
  /** Called when a beacon for OUR network arrives from ANOTHER node. */
  onPeer: (host: string, port: number, nodeId: string) => void
  log?: (msg: string) => void
}

interface ResolvedBeaconOptions {
  clusterId: string
  nodeId: string
  endpoint: { host: string; port: number }
  port: number
  broadcastAddr: string
  intervalMs: number
  onPeer: (host: string, port: number, nodeId: string) => void
  log: (msg: string) => void
}

export class LanBeacon {
  private opts: ResolvedBeaconOptions
  private socket: UdpSocketLike | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private ourNet: string

  constructor(opts: LanBeaconOptions) {
    this.opts = {
      port: opts.port ?? BEACON_PORT,
      broadcastAddr: opts.broadcastAddr ?? "255.255.255.255",
      intervalMs: opts.intervalMs ?? BEACON_MS,
      ...opts,
      log: opts.log ?? (() => {}),
    }
    this.ourNet = netKey(opts.clusterId)
  }

  async start(): Promise<void> {
    try {
      const sock = await Bun.udpSocket({
        port: this.opts.port,
        socket: {
          data: (_sock, buf, _port, _addr) => this.onDatagram(buf),
          error: () => { /* UDP errors are inconsequential */ },
        },
      })
      sock.setBroadcast(true)
      this.socket = sock as unknown as UdpSocketLike
    } catch (e) {
      // Another process already holds the beacon port on this machine — it is
      // announcing for its own node; we still announce (ephemeral port) and
      // rely on the loopback registry for same-machine discovery anyway.
      this.opts.log(`beacon: cannot bind UDP ${this.opts.port} (${(e as Error).message}) — announce-only mode`)
      try {
        const sock = await Bun.udpSocket({ port: 0, socket: { data: () => {} } })
        sock.setBroadcast(true)
        this.socket = sock as unknown as UdpSocketLike
      } catch {
        this.socket = null
        return
      }
    }
    this.timer = setInterval(() => this.announce(), this.opts.intervalMs)
    // Announce immediately on start — a peer starting 1ms later shouldn't
    // have to wait a full cadence to discover us.
    this.announce()
  }

  private announce(): void {
    if (!this.socket) return
    const msg = encodeBeacon({
      v: 1,
      net: this.ourNet,
      ep: `${this.opts.endpoint.host}:${this.opts.endpoint.port}`,
      node: this.opts.nodeId,
    })
    try {
      this.socket.send(msg, this.opts.port, this.opts.broadcastAddr)
    } catch { /* transient send failure; next cadence retries */ }
  }

  private onDatagram(buf: Uint8Array): void {
    const msg = decodeBeacon(buf)
    if (!msg) return
    if (msg.net !== this.ourNet) return          // different network — not ours
    if (msg.node === this.opts.nodeId) return    // our own announcement (loopback paths exist)
    const ci = msg.ep.lastIndexOf(":")
    const port = parseInt(msg.ep.slice(ci + 1), 10)
    this.opts.onPeer(msg.ep.slice(0, ci), port, msg.node)
  }

  async stop(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    try { this.socket?.close() } catch { /* ignore */ }
    this.socket = null
  }
}
