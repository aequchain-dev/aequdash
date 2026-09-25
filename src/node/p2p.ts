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
import { sha256hex } from "./crypto.ts"

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
  tipHash: string
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
  getTipHash: () => string
  getRoster: () => string[]
  callbacks: MeshCallbacks
  heartbeatMs?: number
  nowFn?: () => number
  /**
   * Optional network token (invite-gated admission). When set, every hello /
   * hello_ack must present HMAC-equivalent proof sha256("aequchain:netauth:"
   * + genesisHash + ":" + token) or the socket is dropped before registration.
   * This is the Sybil gate for internet-open meshes; the mesh genesis hash
   * binds the proof to ONE network so tokens can't be replayed across chains.
   */
  token?: string
  /**
   * Optional TLS for ALL mesh links (this node is both server and client):
   *   - listen with the given cert/key (PEM content or a file path)
   *   - dial with TLS, accept self-signed certs (testnet trust model, same
   *     stance as the gateway control socket)
   * All nodes of a network must agree on TLS on/off — a plaintext peer's
   * bytes fail TLS negotiation and the connection dies. That failure is the
   * honest signal.
   */
  tls?: { cert: string; key: string }
}

/** Accept PEM content directly, or a path (loaded via Bun.file). */
function tlsMaterial(v: string): string | ReturnType<typeof Bun.file> {
  return v.includes("-----BEGIN") ? v : Bun.file(v)
}

/** Proof-of-knowledge of the network token, bound to the chain's genesis. */
export function netAuthProof(genesisHash: string, token: string): string {
  return sha256hex(`aequchain:netauth:${genesisHash}:${token}`)
}

/** Constant-time-ish string compare (token proof verification). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
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
      ...(this.opts.tls
        ? { tls: { cert: tlsMaterial(this.opts.tls.cert), key: tlsMaterial(this.opts.tls.key) } }
        : {}),
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
        ...(this.opts.tls ? { tls: { rejectUnauthorized: false } } : {}),
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
              tip_hash: this.opts.getTipHash(),
              ...(this.opts.token ? { auth: netAuthProof(this.opts.genesisHash, this.opts.token) } : {}),
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
        this.updateLiveness(sock, msg.id, msg.height, msg.state_root, msg.tip_hash ?? "", msg.roster)
        this.sendRaw(sock, {
          type: "pong", id: this.opts.nodeId, ts: msg.ts,
          height: this.opts.getHeight(), state_root: this.opts.getStateRoot(),
          roster: this.opts.getRoster(), tip_hash: this.opts.getTipHash(),
        })
        return
      }
      case "pong": {
        this.updateLiveness(sock, msg.id, msg.height, msg.state_root, msg.tip_hash ?? "", msg.roster)
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
    // Token gate: when this mesh is invite-gated, the peer must prove the token.
    if (this.opts.token && !safeEqual(msg.auth ?? "", netAuthProof(this.opts.genesisHash, this.opts.token))) {
      try { sock.end() } catch {}
      return
    }
    // ORDER MATTERS: the hello_ack must hit the wire BEFORE registerPeer
    // fires onPeerUp. The dialer registers us only on hello_ack; if our
    // onPeerUp handler sends anything to the dialer first (e.g. a fork-heal
    // sync_request after wiping our chain), it would arrive before the ack
    // and be dropped as unregistered. Same socket ⇒ ordered delivery.
    this.sendRaw(sock, {
      type: "hello_ack",
      id: this.opts.nodeId,
      host: this.opts.host,
      port: this.server?.port ?? this.opts.port,
      pub: this.opts.pub,
      height: this.opts.getHeight(),
      state_root: this.opts.getStateRoot(),
      roster: this.opts.getRoster(),
      tip_hash: this.opts.getTipHash(),
      ...(this.opts.token ? { auth: netAuthProof(this.opts.genesisHash, this.opts.token) } : {}),
    })
    this.registerPeer(sock, msg.id, msg.host, msg.port, msg.pub, msg.height, msg.state_root, msg.tip_hash ?? "", msg.roster, false)
  }

  private onHelloAck(sock: PeerSocket, msg: Extract<MeshMessage, { type: "hello_ack" }>): void {
    if (msg.id === this.opts.nodeId) { try { sock.end() } catch {}; return }
    // Mutual proof: the answering peer must also know the token.
    if (this.opts.token && !safeEqual(msg.auth ?? "", netAuthProof(this.opts.genesisHash, this.opts.token))) {
      try { sock.end() } catch {}
      return
    }
    this.registerPeer(sock, msg.id, msg.host, msg.port, msg.pub, msg.height, msg.state_root, msg.tip_hash ?? "", msg.roster, true)
  }

  private registerPeer(
    sock: PeerSocket, id: string, host: string, port: number, pub: string,
    height: number, stateRoot: string, tipHash: string, roster: string[], outbound: boolean,
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
      height, stateRoot, tipHash, roster,
      lastSeenMs: this.now(),
      connectedAt: this.now(),
      socket: sock,
      outbound,
    }
    this.peers.set(id, peer)
    this.bySocket.set(sock, peer)
    this.opts.callbacks.onPeerUp(peer)
  }

  private updateLiveness(sock: PeerSocket, id: string, height: number, stateRoot: string, tipHash: string, roster: string[]): void {
    const peer = this.bySocket.get(sock)
    if (!peer || peer.id !== id) return
    peer.lastSeenMs = this.now()
    peer.height = height
    peer.stateRoot = stateRoot
    if (tipHash) peer.tipHash = tipHash
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
          roster: this.opts.getRoster(), tip_hash: this.opts.getTipHash(),
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
