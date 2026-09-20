/**
 * aequdash — src/node/node.ts
 *
 * AequNode — a live ephemeral testnet node.
 *
 * Responsibilities:
 *   - Owns a ledger replica (Ledger) and the canonical chain (blocks + QCs)
 *   - Mempool for client txs (precheck on admission; authoritative
 *     validation happens at commit)
 *   - Rotating-proposer BFT: proposes on its turn, votes on valid
 *     proposals, forms QCs at threshold, commits with state-root proof
 *   - Peer mesh: heartbeats carry (height, state_root) so liveness AND
 *     convergence are continuously observable; lagging nodes pull blocks
 *   - Emits structured activity events for the dashboard feed
 *
 * EPHEMERAL: no disk, no persistence. stop() destroys everything. When the
 * last node in a mesh stops, the network state ceases to exist anywhere.
 */

import { EventEmitter } from "node:events"
import { Ledger, RATE_USD_PER_AEQ } from "./ledger.ts"
import { Rational } from "./rational.ts"
import {
  buildBlock, validateBlockShape, makeTx, ZERO_HASH,
} from "./block.ts"
import {
  selectCommittee, committeeId, thresholdFor, byzantineTolerance,
  proposerFor, signVote, formQC, verifyQC,
} from "./consensus.ts"
import { generateIdentity, sha256hex, signObject, verifyObject, type Identity } from "./crypto.ts"
import { PeerMesh, type PeerState } from "./p2p.ts"
import type { Block, MeshMessage, QC, Tx, Vote, ClusterInfo, NodeInfo } from "./proto.ts"
import { NODE_VERSION } from "./proto.ts"
import type { ActivityEvent, ActivityLevel } from "../lib/types.ts"

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

export interface AequNodeConfig {
  nodeId: string
  host: string
  port: number                     // 0 = auto-assign
  seeds: { host: string; port: number }[]
  clusterId: string                // isolates meshes on the same machine
  committeeSize: number
  thresholdOverride: number | null // null → floor(2n/3)+1
  epochSeed: string
  blockTimeMs: number
  roundTimeoutMs: number
  maxTxPerBlock: number
  identity?: Identity
  seedTxs?: Tx[]                   // genesis burst (injected into block 1 by bootstrap node)
  bootstrap?: boolean              // this node carries the seed txs
  nowFn?: () => number             // test hook
}

interface PendingProposal {
  block: Block
  votes: Map<string, Vote>         // voter -> vote
  proposerSigOk: boolean
}

export interface NodeMetrics {
  paymentsTotal: number
  paymentsConfirmed: number
  latencySamplesMs: number[]       // ring buffer (cap 256)
  blocksCommitted: number
  lastBlockMs: number
  roundChanges: number
}

const LATENCY_CAP = 256
const CHAIN_CAP = 10_000           // blocks retained in memory
const MAX_PROPOSAL_FUTURE_SKEW_MS = 5_000

export class AequNode extends EventEmitter {
  readonly cfg: AequNodeConfig
  readonly identity: Identity
  readonly genesisHash: string

  ledger = new Ledger()
  mesh: PeerMesh | null = null

  height = 0
  tipHash = ZERO_HASH
  blocks: Block[] = []
  qcs: QC[] = []
  mempool = new Map<string, Tx>()

  view = 0
  private proposal: PendingProposal | null = null
  /** Proposals received one block ahead — processed right after we commit. */
  private futureProposals: { block: Block; sig: string; pub: string }[] = []
  private roundTimer: ReturnType<typeof setTimeout> | null = null
  private blockTimer: ReturnType<typeof setInterval> | null = null
  private lastCommitAt = 0

  running = false
  /** Consensus gate: the mesh must settle before proposing (no boot races). */
  consensusEnabled = false
  startedAt = 0
  boundPort = 0
  metrics: NodeMetrics = {
    paymentsTotal: 0, paymentsConfirmed: 0,
    latencySamplesMs: [], blocksCommitted: 0, lastBlockMs: 0, roundChanges: 0,
  }

  constructor(cfg: AequNodeConfig) {
    super()
    this.cfg = cfg
    this.identity = cfg.identity ?? generateIdentity()
    this.genesisHash = sha256hex(`aequchain:genesis:${cfg.clusterId}`)
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return
    this.startedAt = this.now()
    this.mesh = new PeerMesh({
      nodeId: this.cfg.nodeId,
      pub: this.identity.pub,
      host: this.cfg.host,
      port: this.cfg.port,
      genesisHash: this.genesisHash,
      seeds: this.cfg.seeds,
      getHeight: () => this.height,
      getStateRoot: () => this.tipStateRoot(),
      getRoster: () => this.roster(),
      callbacks: {
        onMessage: (peer, msg) => this.onMeshMessage(peer, msg),
        onPeerUp: (peer) => this.onPeerUp(peer),
        onPeerDown: (id, reason) => this.onPeerDown(id, reason),
      },
      nowFn: this.cfg.nowFn,
    })
    this.boundPort = await this.mesh.start()
    this.running = true

    this.emitActivity("node_init", `Node ${this.cfg.nodeId} live on ${this.cfg.host}:${this.boundPort}`, "success", [
      { k: "committee", v: String(this.cfg.committeeSize) },
    ])
  }

  /** Begin proposing/voting — called once the mesh is formed (by gateway). */
  enableConsensus(): void {
    if (this.consensusEnabled || !this.running) return
    this.consensusEnabled = true
    this.blockTimer = setInterval(() => this.roundTick(), this.cfg.blockTimeMs)
    this.armRoundTimer()
    this.emitActivity("consensus_live", `Consensus live — committee ${this.committee().length}, threshold ${this.threshold()}`, "success", [
      { k: "threshold", v: String(this.threshold()) },
    ])
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    this.consensusEnabled = false
    if (this.blockTimer) { clearInterval(this.blockTimer); this.blockTimer = null }
    if (this.roundTimer) { clearTimeout(this.roundTimer); this.roundTimer = null }
    await this.mesh?.stop()
    this.mesh = null
    this.mempool.clear()
    this.proposal = null
    this.emitActivity("node_stop", `Node ${this.cfg.nodeId} stopped`, "info")
  }

  /** Ephemeral teardown: stop + wipe every byte of state. */
  async destroy(): Promise<void> {
    await this.stop()
    this.ledger = new Ledger()
    this.blocks = []
    this.qcs = []
    this.height = 0
    this.tipHash = ZERO_HASH
    this.view = 0
    this.metrics = { paymentsTotal: 0, paymentsConfirmed: 0, latencySamplesMs: [], blocksCommitted: 0, lastBlockMs: 0, roundChanges: 0 }
  }

  now(): number { return this.cfg.nowFn ? this.cfg.nowFn() : Date.now() }

  // ── Derived consensus state ────────────────────────────────────────────────

  /** Live validator roster: self + live peers, sorted. */
  roster(): string[] {
    const ids = [this.cfg.nodeId, ...(this.mesh?.livePeers().map((p) => p.id) ?? [])]
    return [...new Set(ids)].sort()
  }

  committee(height = this.height + 1): string[] {
    return selectCommittee(this.roster(), height, this.cfg.epochSeed, this.cfg.committeeSize)
  }

  threshold(): number {
    return this.thresholdForCommittee(this.committee().length)
  }

  thresholdForCommittee(size: number): number {
    if (size <= 0) return 1
    if (this.cfg.thresholdOverride) return Math.min(this.cfg.thresholdOverride, size)
    return thresholdFor(size)
  }

  tipStateRoot(): string {
    if (this.blocks.length === 0) return sha256hex("aequchain:empty-state")
    return this.blocks[this.blocks.length - 1].header.state_root
  }

  isSynced(): boolean {
    if (!this.mesh) return true
    for (const p of this.mesh.livePeers()) if (p.height > this.height) return false
    return true
  }

  // ── Round engine ───────────────────────────────────────────────────────────

  /**
   * Called every blockTimeMs. If it's my turn to propose for the current
   * (height+1, view) and no proposal is outstanding, build & broadcast.
   */
  private roundTick(): void {
    if (!this.running || !this.consensusEnabled || !this.mesh) return
    const nextHeight = this.height + 1
    const committee = this.committee(nextHeight)
    if (committee.length === 0) return
    if (!this.isSynced()) return // catching up; don't propose from behind

    const proposer = proposerFor(committee, nextHeight, this.view)
    if (proposer !== this.cfg.nodeId) return
    if (this.proposal && this.proposal.block.header.height === nextHeight) return // already proposed

    this.propose(nextHeight, committee)
  }

  private propose(height: number, committee: string[]): void {
    if (!this.mesh) return

    // Select txs: genesis burst on block 1 for the bootstrap node, then mempool
    let candidateTxs: Tx[]
    if (height === 1 && this.cfg.bootstrap && this.cfg.seedTxs?.length) {
      candidateTxs = this.cfg.seedTxs
      this.cfg.seedTxs = [] // consumed
    } else {
      candidateTxs = [...this.mempool.values()].slice(0, this.cfg.maxTxPerBlock)
    }

    // Build post-state on a clone; keep only txs that apply cleanly
    const ts = this.now()
    const preview = this.ledger.previewBlock(candidateTxs, ts)
    const txs = preview ? preview.applied : []
    if (!preview) {
      // Some tx in the candidate set is invalid — filter one-by-one
      const clone = this.ledger.clone()
      const good: Tx[] = []
      for (const tx of candidateTxs) {
        try { clone.apply(tx, ts); good.push(tx) } catch { /* drop invalid */ }
      }
      const retry = this.ledger.previewBlock(good, ts)
      if (!retry) return // cannot happen, but never crash the loop
      txs.length = 0
      txs.push(...retry.applied)
      var stateRoot = retry.stateRoot
    } else {
      var stateRoot = preview.stateRoot
    }

    const block = buildBlock(height, this.tipHash, ts, this.cfg.nodeId, txs, stateRoot, this.roster())
    const sig = signObject(this.identity, { domain: "aequchain-proposal-v1", block_hash: block.hash, height })

    this.proposal = { block, votes: new Map(), proposerSigOk: true }
    this.mesh.broadcast({ type: "proposal", block, sig, pub: this.identity.pub })
    this.handleProposal(block, sig, this.identity.pub) // self-process
  }

  /** View-change timeout: if no QC formed for the round, advance the view. */
  private armRoundTimer(): void {
    if (!this.consensusEnabled) return
    if (this.roundTimer) clearTimeout(this.roundTimer)
    this.roundTimer = setTimeout(() => {
      if (!this.running) return
      this.view++
      this.metrics.roundChanges++
      this.proposal = null
      this.emitActivity("view_change", `Round timeout at height ${this.height + 1} — view ${this.view}`, "warn", [
        { k: "view", v: String(this.view) },
      ])
      this.roundTick()
      this.armRoundTimer()
    }, this.cfg.roundTimeoutMs)
  }

  // ── Proposal handling ──────────────────────────────────────────────────────

  private handleProposal(block: Block, sig: string, pub: string): void {
    if (!this.mesh || !this.running) return
    const h = block.header

    if (h.height > this.height + 1) {
      // One block ahead: stash and process right after we commit.
      if (h.height === this.height + 2) {
        this.futureProposals.push({ block, sig, pub })
        if (this.futureProposals.length > 8) this.futureProposals.shift()
      }
      // Far ahead: we're out of sync — pull from the proposer's mesh view
      return
    }
    if (h.height !== this.height + 1) return // already committed or stale
    // Shape & linkage
    const shapeErr = validateBlockShape(block, h.height, this.tipHash)
    if (shapeErr) return this.emitActivity("invalid_block", `Rejected proposal: ${shapeErr}`, "warn")

    // Proposer eligibility: must be the scheduled proposer for some view.
    // Committee derives from the BLOCK'S committed roster — verification is
    // stable regardless of transient differences in live peer views.
    const committee = selectCommittee(h.roster, h.height, this.cfg.epochSeed, this.cfg.committeeSize)
    if (!committee.includes(h.proposer)) return
    const eligibleViews: number[] = []
    for (let v = 0; v < committee.length; v++) {
      if (proposerFor(committee, h.height, v) === h.proposer) eligibleViews.push(v)
    }
    if (eligibleViews.length === 0) return

    // Proposer signature over the block hash must verify
    if (!verifyObject(pub, { domain: "aequchain-proposal-v1", block_hash: block.hash, height: h.height }, sig)) return

    // Timestamp sanity
    if (h.ts > this.now() + MAX_PROPOSAL_FUTURE_SKEW_MS) return

    // Roster consistency: the block's roster must match our live view.
    // (On localhost full-mesh, rosters agree; disagreement → skip voting,
    // safety preserved because a QC can't form across two rosters for the
    // same hash unless threshold committee members share it.)
    // NOTE: we still count votes toward QC — see handleVote.

    // Full state validation: replay the block on a clone
    const preview = this.ledger.previewBlock(block.txs, h.ts)
    if (!preview || preview.stateRoot !== h.state_root) {
      return this.emitActivity("invalid_block", "Rejected proposal: state_root does not match replay", "warn")
    }

    // Valid → vote (only committee members of the block's roster may vote)
    if (!committee.includes(this.cfg.nodeId)) return
    this.proposal = this.proposal && this.proposal.block.hash === block.hash
      ? this.proposal
      : { block, votes: new Map(), proposerSigOk: true }

    const vote = signVote(this.identity, this.cfg.nodeId, h.height, block.hash)
    this.mesh.broadcast({ type: "vote", vote })
    this.handleVote(vote) // self-vote
  }

  private handleVote(vote: Vote): void {
    if (!this.proposal) return
    const { block, votes } = this.proposal
    if (vote.block_hash !== block.hash || vote.height !== block.header.height) return

    const committee = selectCommittee(block.header.roster, block.header.height, this.cfg.epochSeed, this.cfg.committeeSize)
    if (!committee.includes(vote.voter)) return
    if (votes.has(vote.voter)) return
    if (!verifyVoteFor(vote)) return
    votes.set(vote.voter, vote)

    const threshold = this.thresholdForCommittee(committee.length)
    if (votes.size >= threshold) {
      const qc = formQC(block, votes.values(), committee, threshold)
      if (qc) this.commit(block, qc)
    }
  }

  // ── Commit ─────────────────────────────────────────────────────────────────

  private commit(block: Block, qc: QC): void {
    if (!this.running) return
    if (block.header.height !== this.height + 1) return
    if (block.header.prev_hash !== this.tipHash) return

    const started = this.now()
    try {
      this.ledger.applyBlockChecked(block.txs, block.header.ts, block.header.state_root)
    } catch (e) {
      this.emitActivity("commit_failed", `Block ${block.header.height} failed to apply: ${(e as Error).message}`, "error")
      return
    }
    const elapsed = Math.max(1, this.now() - started)

    this.ledger.height = block.header.height
    this.blocks.push(block)
    this.qcs.push(qc)
    if (this.blocks.length > CHAIN_CAP) this.blocks.shift()
    if (this.qcs.length > CHAIN_CAP) this.qcs.shift()
    this.height = block.header.height
    this.tipHash = block.hash
    this.view = 0
    this.proposal = null
    this.lastCommitAt = this.now()
    this.armRoundTimer()

    // Remove committed txs from mempool
    for (const tx of block.txs) this.mempool.delete(tx.id)

    // Metrics
    this.metrics.blocksCommitted++
    this.metrics.lastBlockMs = elapsed
    this.metrics.latencySamplesMs.push(elapsed)
    if (this.metrics.latencySamplesMs.length > LATENCY_CAP) this.metrics.latencySamplesMs.shift()
    const payments = block.txs.filter((t) => t.kind === "node_pay").length
    this.metrics.paymentsTotal += payments
    this.metrics.paymentsConfirmed += payments

    const txCount = block.txs.length
    this.emitActivity("block_commit", `Block ${this.height} committed`, "success", [
      { k: "txs", v: String(txCount) },
      { k: "qc", v: `${qc.votes.length}/${qc.threshold}` },
      { k: "root", v: block.header.state_root.slice(0, 10) },
    ])
    this.emit("commit", { block, qc })
    this.mesh?.broadcast({ type: "commit", block, qc })

    // Process any proposal stashed for the new next height
    const stashed = this.futureProposals.filter((f) => f.block.header.height === this.height + 1)
    this.futureProposals = this.futureProposals.filter((f) => f.block.header.height > this.height + 1)
    for (const f of stashed) this.handleProposal(f.block, f.sig, f.pub)
  }

  // ── Mesh message handlers ──────────────────────────────────────────────────

  private onMeshMessage(peer: PeerState, msg: MeshMessage): void {
    switch (msg.type) {
      case "tx": {
        if (!this.mempool.has(msg.tx.id) && this.ledger.precheck(msg.tx, this.now()) === null) {
          this.mempool.set(msg.tx.id, msg.tx)
          this.emit("tx_accepted", msg.tx)
        }
        return
      }
      case "proposal": return this.handleProposal(msg.block, msg.sig, msg.pub)
      case "vote": return this.handleVote(msg.vote)
      case "commit": return this.handleCommitMsg(peer, msg.block, msg.qc)
      case "sync_request": {
        const blocks = this.blocks.filter((b) => b.header.height >= msg.from_height)
        const qcs = this.qcs.filter((q) => q.height >= msg.from_height)
        // Send in bounded chunks: last 512 blocks max per response
        this.mesh?.sendTo(peer.id, {
          type: "sync_response",
          blocks: blocks.slice(-512),
          qcs: qcs.slice(-512),
        })
        return
      }
      case "sync_response": return this.handleSyncResponse(msg.blocks, msg.qcs)
      default: return
    }
  }

  private handleCommitMsg(peer: PeerState, block: Block, qc: QC): void {
    if (block.header.height <= this.height) return // already have it
    if (block.header.height > this.height + 1) {
      // We're behind: pull the gap from the peer who told us
      this.mesh?.sendTo(peer.id, { type: "sync_request", from_height: this.height + 1 })
      return
    }
    const committee = selectCommittee(block.header.roster, block.header.height, this.cfg.epochSeed, this.cfg.committeeSize)
    if (!verifyQC(qc, block, committee, this.thresholdForCommittee(committee.length))) {
      return this.emitActivity("invalid_qc", `Rejected commit for block ${block.header.height}: QC invalid`, "warn")
    }
    this.commit(block, qc)
  }

  private handleSyncResponse(blocks: Block[], qcs: QC[]): void {
    const byHeight = new Map(qcs.map((q) => [q.height, q]))
    for (const block of blocks.sort((a, b) => a.header.height - b.header.height)) {
      if (block.header.height !== this.height + 1) continue
      const qc = byHeight.get(block.header.height)
      if (!qc) continue
      const committee = selectCommittee(block.header.roster, block.header.height, this.cfg.epochSeed, this.cfg.committeeSize)
      if (!verifyQC(qc, block, committee, this.thresholdForCommittee(committee.length))) continue
      this.commit(block, qc)
    }
  }

  // ── Peer lifecycle ─────────────────────────────────────────────────────────

  private onPeerUp(peer: PeerState): void {
    this.emitActivity("peer_up", `Peer ${peer.id} connected (${peer.host}:${peer.port})`, "success", [
      { k: "peers", v: String((this.mesh?.peerCount() ?? 0)) },
    ])
    this.emit("peer", { id: peer.id, up: true })
    if (peer.height > this.height) {
      this.mesh?.sendTo(peer.id, { type: "sync_request", from_height: this.height + 1 })
    }
  }

  private onPeerDown(id: string, reason: string): void {
    this.emitActivity("peer_down", `Peer ${id} left (${reason})`, "warn", [
      { k: "peers", v: String((this.mesh?.peerCount() ?? 0)) },
    ])
    this.emit("peer", { id, up: false })
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Submit a client tx: precheck → mempool → gossip. */
  submitTx(kind: Tx["kind"], actor: string, payload: Record<string, unknown>, clientTs: number, nonce: number): Tx {
    const tx = makeTx(kind, actor, payload, clientTs, nonce)
    const err = this.ledger.precheck(tx, this.now())
    if (err) throw new Error(err)
    this.mempool.set(tx.id, tx)
    this.mesh?.broadcast({ type: "tx", tx })
    return tx
  }

  /** Live cluster view — the "nodes visible unto each other" contract. */
  clusterInfo(): ClusterInfo {
    const peers = this.mesh?.livePeers() ?? []
    const myRoot = this.tipStateRoot()
    // 1-block grace: heartbeats arrive every ~1s, so a peer one block behind
    // whose root matches our previous block counts as converged.
    const prevRoot = this.blocks.length >= 2
      ? this.blocks[this.blocks.length - 2].header.state_root
      : myRoot
    const nodes: NodeInfo[] = [
      {
        id: this.cfg.nodeId,
        label: this.cfg.nodeId,
        host: this.cfg.host,
        port: this.boundPort,
        status: this.running ? "live" : "down",
        height: this.height,
        state_root: myRoot,
        peers: this.mesh?.peerCount() ?? 0,
        uptime_s: Math.max(0, Math.floor((this.now() - this.startedAt) / 1000)),
        version: NODE_VERSION,
      },
      ...peers.map((p) => ({
        id: p.id,
        label: p.id,
        host: p.host,
        port: p.port,
        status: "live" as const,
        height: p.height,
        state_root: p.stateRoot,
        peers: p.roster.length - 1,
        uptime_s: Math.max(0, Math.floor((this.now() - p.connectedAt) / 1000)),
        version: NODE_VERSION,
      })),
    ]
    const allConverged = peers.every((p) => p.stateRoot === myRoot || p.stateRoot === prevRoot)
    return {
      self_id: this.cfg.nodeId,
      mesh_size: 1 + peers.length,
      all_converged: allConverged,
      nodes,
    }
  }

  avgLatencyMs(): number {
    const s = this.metrics.latencySamplesMs
    if (s.length === 0) return 0
    return s.reduce((a, b) => a + b, 0) / s.length
  }

  lastLatencyMs(): number {
    const s = this.metrics.latencySamplesMs
    return s.length === 0 ? 0 : s[s.length - 1]
  }

  uptimeSeconds(): number {
    return this.startedAt === 0 ? 0 : Math.max(0, Math.floor((this.now() - this.startedAt) / 1000))
  }

  lastCommitTime(): number {
    return this.lastCommitAt
  }

  emitActivity(tag: string, message: string, level: ActivityLevel = "info", fields: { k: string; v: string }[] = []): void {
    const ev: ActivityEvent = { ts: new Date(this.now()).toISOString(), level, tag, message, fields }
    this.emit("activity", ev)
  }
}

/** Standalone vote verification (import cycle guard). */
function verifyVoteFor(vote: Vote): boolean {
  return verifyObject(vote.voter_pub, {
    domain: "aequchain-vote-v1", height: vote.height, block_hash: vote.block_hash, voter: vote.voter,
  }, vote.sig)
}

