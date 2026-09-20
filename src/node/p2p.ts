/**
 * aequdash — src/node/p2p.ts
 *
 * TCP peer mesh for the ephemeral testnet. REAL networking:
 *
 *   - Length-prefixed JSON frames over TCP (4-byte BE length + JSON)
 *   - Handshake with genesis-hash verification (wrong chain = rejected)
 *   - 1s heartbeats carrying height + state_root (peer liveness AND
 *     convergence are continuously observable by every node)
 *   - Gossip with seen-set dedup
 *   - Graceful leave via `bye`; unresponsive peers dropped after 3 missed
 *     heartbeats
 *
 * When a node leaves, every peer sees it. When all nodes leave, the mesh —
 * and everything it held — ceases to exist. Nothing is written to disk.
 */

import type { Socket } from "bun"
import type { MeshMessage, PeerInfo } from "./proto.ts"

const MAX_FRAME = 4 * 1024 * 1024        // 4 MiB frame cap
const HEARTBEAT_MS = 1_000
const DEAD_AFTER_MISSED = 3
const SEEN_CAP = 10_000
const CONNECT_TIMEOUT_MS = 5_000

export interface PeerState {
  id: string
  host: string
  port: number
  pub: string
  height: number
  stateRoot: string
  roster: string[]
  lastSeenMs: number
  connectedAt: number
  socket: PeerSocket | null
  outbound: boolean          // we initiated the connection
}

type PeerSocket = Socket<undefined>

export interface MeshCallbacks {
  onMessage(peer: PeerState, msg: MeshMessage): void
  onPeerUp(peer: PeerState): void
  onPeerDown(peerId: string, reason: string): void
}

export interface MeshOptions {
  nodeId: string
  pub: string
  host: string
  port: number
  genesisHash: string
  seeds: { host: string; port: number }[]
  getHeight: () => number
  getStateRoot: () => string
  getRoster: () => string[]
  callbacks: MeshCallbacks
  heartbeatMs?: number
  nowFn?: () => number
}

export class PeerMesh {
  private opts: MeshOptions
  /** Bun's TCP listener (typed minimally — Bun.listen's union includes unix sockets). */
  private server: { port: number; stop: (closeActive?: boolean) => void } | null = null
  private peers = new Map<string, PeerState>()          // by node id
  private pending = new Set<PeerSocket>()               // pre-handshake sockets
  private bySocket = new Map<PeerSocket, PeerState>()
  private seen = new Set<string>()
  private hbTimer: ReturnType<typeof setInterval> | null = null
  private stopped = false

  constructor(opts: MeshOptions) {
    this.opts = opts
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<number> {
    const { host, port } = this.opts
    const server = Bun.listen<undefined>({
      hostname: host,
      port,
      socket: {
        data: (sock, data) => this.onData(sock, data),
        open: (sock) => { this.pending.add(sock) },
        close: (sock) => this.onSocketClose(sock),
        error: (_sock, err) => { /* logged by owner via peer events */ void err },
      },
    })
    this.server = server as unknown as { port: number; stop: (closeActive?: boolean) => void }
    const boundPort = server.port

    this.hbTimer = setInterval(() => this.heartbeat(), this.opts.heartbeatMs ?? HEARTBEAT_MS)

    // Dial seeds (don't await serially — connect in parallel, failures tolerated)
    await Promise.allSettled(
      this.opts.seeds
        .filter((s) => !(s.host === host && s.port === boundPort))
        .map((s) => this.dial(s.host, s.port)),
    )
    return boundPort
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.hbTimer) clearInterval(this.hbTimer)
    try { this.broadcast({ type: "bye", id: this.opts.nodeId }) } catch {}
    for (const p of this.peers.values()) { try { p.socket?.end() } catch {} }
    for (const s of this.pending) { try { s.end() } catch {} }
    this.peers.clear()
    this.bySocket.clear()
    this.pending.clear()
    try { this.server?.stop(true) } catch {}
    this.server = null
  }

  // ── Peer table (visibility: every live node is observable) ────────────────

  livePeers(): PeerState[] {
    return [...this.peers.values()]
  }

  liveNodeIds(): string[] {
    return [this.opts.nodeId, ...this.peers.keys()].sort()
  }

  peerCount(): number {
    return this.peers.size
  }

  // ── Outbound messaging ─────────────────────────────────────────────────────

  broadcast(msg: MeshMessage): void {
    const frame = encodeFrame(msg)
    for (const p of this.peers.values()) {
      try { p.socket?.write(frame) } catch { /* dropped on next heartbeat */ }
    }
  }

  sendTo(nodeId: string, msg: MeshMessage): boolean {
    const p = this.peers.get(nodeId)
    if (!p?.socket) return false
    try { p.socket.write(encodeFrame(msg)); return true } catch { return false }
  }

  // ── Connection management ──────────────────────────────────────────────────

  async dial(host: string, port: number): Promise<boolean> {
    if (this.stopped) return false
    // Already connected to this endpoint?
    for (const p of this.peers.values()) {
      if (p.host === host && p.port === port) return true
    }
    return new Promise((resolve) => {
      let settled = false
      const done = (ok: boolean) => { if (!settled) { settled = true; resolve(ok) } }
      const timer = setTimeout(() => done(false), CONNECT_TIMEOUT_MS)
      Bun.connect({
        hostname: host,
        port,
        socket: {
          data: (sock, data) => this.onData(sock, data),
          open: (sock) => {
            this.pending.add(sock)
            // Initiate handshake
            this.sendRaw(sock, {
              type: "hello",
              id: this.opts.nodeId,
              host: this.opts.host,
              port: this.server?.port ?? this.opts.port,
              pub: this.opts.pub,
              height: this.opts.getHeight(),
              state_root: this.opts.getStateRoot(),
              genesis_hash: this.opts.genesisHash,
              roster: this.opts.getRoster(),
            })
            clearTimeout(timer)
            done(true)
          },
          close: (sock) => this.onSocketClose(sock),
          error: (sock) => { this.onSocketClose(sock) },
          connectError: () => { clearTimeout(timer); done(false) },
        },
      }).catch(() => { clearTimeout(timer); done(false) })
    })
  }

  // ── Frame handling ─────────────────────────────────────────────────────────

  private bufs = new Map<PeerSocket, Uint8Array>()

  private onData(sock: PeerSocket, chunk: Uint8Array): void {
    const prev = this.bufs.get(sock)
    const buf = prev ? concat(prev, chunk) : chunk
    let offset = 0
    while (offset + 4 <= buf.length) {
      const len = (buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]
      if (len > MAX_FRAME) { try { sock.end() } catch {} ; this.bufs.delete(sock); return }
      if (offset + 4 + len > buf.length) break
      const payload = buf.subarray(offset + 4, offset + 4 + len)
      offset += 4 + len
      this.handleFrame(sock, payload)
    }
    if (offset > 0) this.bufs.set(sock, buf.subarray(offset))
    else this.bufs.set(sock, buf)
  }

  private handleFrame(sock: PeerSocket, payload: Uint8Array): void {
    let msg: MeshMessage
    try {
      msg = JSON.parse(new TextDecoder().decode(payload)) as MeshMessage
    } catch {
      return
    }

    switch (msg.type) {
      case "hello": return this.onHello(sock, msg)
      case "hello_ack": return this.onHelloAck(sock, msg)
      case "ping": {
        this.updateLiveness(sock, msg.id, msg.height, msg.state_root, msg.roster)
        this.sendRaw(sock, {
          type: "pong", id: this.opts.nodeId, ts: msg.ts,
          height: this.opts.getHeight(), state_root: this.opts.getStateRoot(),
          roster: this.opts.getRoster(),
        })
        return
      }
      case "pong": {
        this.updateLiveness(sock, msg.id, msg.height, msg.state_root, msg.roster)
        return
      }
      case "bye": {
        const peer = this.bySocket.get(sock)
        if (peer) this.dropPeer(peer.id, "peer said bye")
        return
      }
      default: {
        const peer = this.bySocket.get(sock)
        if (!peer) return
        peer.lastSeenMs = this.now()
        // Gossip dedup
        const key = frameKey(msg)
        if (this.seen.has(key)) return
        this.seen.add(key)
        if (this.seen.size > SEEN_CAP) {
          const first = this.seen.values().next().value
          if (first) this.seen.delete(first)
        }
        this.opts.callbacks.onMessage(peer, msg)
        // Re-gossip to OTHER peers (full relay)
        if (msg.type === "tx" || msg.type === "proposal" || msg.type === "vote" || msg.type === "commit") {
          const frame = encodeFrame(msg)
          for (const p of this.peers.values()) {
            if (p.id !== peer.id) { try { p.socket?.write(frame) } catch {} }
          }
        }
      }
    }
  }

  private onHello(sock: PeerSocket, msg: Extract<MeshMessage, { type: "hello" }>): void {
    if (msg.genesis_hash !== this.opts.genesisHash) {
      try { sock.end() } catch {}
      return
    }
    if (msg.id === this.opts.nodeId) { try { sock.end() } catch {}; return }
    this.registerPeer(sock, msg.id, msg.host, msg.port, msg.pub, msg.height, msg.state_root, msg.roster, false)
    this.sendRaw(sock, {
      type: "hello_ack",
      id: this.opts.nodeId,
      host: this.opts.host,
      port: this.server?.port ?? this.opts.port,
      pub: this.opts.pub,
      height: this.opts.getHeight(),
      state_root: this.opts.getStateRoot(),
      roster: this.opts.getRoster(),
    })
  }

  private onHelloAck(sock: PeerSocket, msg: Extract<MeshMessage, { type: "hello_ack" }>): void {
    if (msg.id === this.opts.nodeId) { try { sock.end() } catch {}; return }
    this.registerPeer(sock, msg.id, msg.host, msg.port, msg.pub, msg.height, msg.state_root, msg.roster, true)
  }

  private registerPeer(
    sock: PeerSocket, id: string, host: string, port: number, pub: string,
    height: number, stateRoot: string, roster: string[], outbound: boolean,
  ): void {
    this.pending.delete(sock)
    const existing = this.peers.get(id)
    if (existing) {
      // Duplicate connection: keep the existing one.
      try { sock.end() } catch {}
      return
    }
    const peer: PeerState = {
      id, host, port, pub,
      height, stateRoot, roster,
      lastSeenMs: this.now(),
      connectedAt: this.now(),
      socket: sock,
      outbound,
    }
    this.peers.set(id, peer)
    this.bySocket.set(sock, peer)
    this.opts.callbacks.onPeerUp(peer)
  }

  private updateLiveness(sock: PeerSocket, id: string, height: number, stateRoot: string, roster: string[]): void {
    const peer = this.bySocket.get(sock)
    if (!peer || peer.id !== id) return
    peer.lastSeenMs = this.now()
    peer.height = height
    peer.stateRoot = stateRoot
    peer.roster = roster
  }

  private onSocketClose(sock: PeerSocket): void {
    this.pending.delete(sock)
    this.bufs.delete(sock)
    const peer = this.bySocket.get(sock)
    if (peer) {
      this.bySocket.delete(sock)
      if (this.peers.get(id_of(peer))?.socket === sock) {
        this.dropPeer(peer.id, "connection closed")
      }
    }
  }

  private dropPeer(id: string, reason: string): void {
    const peer = this.peers.get(id)
    if (!peer) return
    this.peers.delete(id)
    if (peer.socket) {
      this.bySocket.delete(peer.socket)
      try { peer.socket.end() } catch {}
    }
    this.opts.callbacks.onPeerDown(id, reason)
  }

  // ── Heartbeat ──────────────────────────────────────────────────────────────

  private heartbeat(): void {
    if (this.stopped) return
    const now = this.now()
    const deadAfter = (this.opts.heartbeatMs ?? HEARTBEAT_MS) * DEAD_AFTER_MISSED
    for (const peer of this.peers.values()) {
      if (now - peer.lastSeenMs > deadAfter) {
        this.dropPeer(peer.id, "heartbeat timeout")
        continue
      }
      try {
        peer.socket?.write(encodeFrame({
          type: "ping", id: this.opts.nodeId, ts: now,
          height: this.opts.getHeight(), state_root: this.opts.getStateRoot(),
          roster: this.opts.getRoster(),
        }))
      } catch { /* dropped on next heartbeat */ }
    }
  }

  private now(): number {
    return this.opts.nowFn ? this.opts.nowFn() : Date.now()
  }

  private sendRaw(sock: PeerSocket, msg: MeshMessage): void {
    try { sock.write(encodeFrame(msg)) } catch {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Framing helpers
// ─────────────────────────────────────────────────────────────────────────────

export function encodeFrame(msg: MeshMessage): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(msg))
  const frame = new Uint8Array(4 + payload.length)
  frame[0] = (payload.length >>> 24) & 0xff
  frame[1] = (payload.length >>> 16) & 0xff
  frame[2] = (payload.length >>> 8) & 0xff
  frame[3] = payload.length & 0xff
  frame.set(payload, 4)
  return frame
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

function frameKey(msg: MeshMessage): string {
  // Structural dedup key — cheap and sufficient for gossip
  switch (msg.type) {
    case "tx": return `tx:${msg.tx.id}`
    case "proposal": return `proposal:${msg.block.hash}`
    case "vote": return `vote:${msg.vote.voter}:${msg.vote.block_hash}`
    case "commit": return `commit:${msg.block.hash}`
    default: return JSON.stringify(msg).slice(0, 128)
  }
}

function id_of(peer: PeerState): string { return peer.id }
