/**
 * aequdash — src/lib/simulator.ts
 *
 * Deterministic, seeded reference simulator for aequchain TUI v2.
 * This IS the v2 backend specification — all UI data traces here.
 *
 * Design:
 *   • Pure TS, no external deps (except types).
 *   • Seeded RNG (mulberry32) for reproducibility.
 *   • Virtual clock frozen under AEQUDASH_SNAPSHOT=1 for deterministic frames.
 *   • Working-set records (interactive) + network-wide aggregates (dashboard stats).
 *   • All arithmetic internally consistent (equality invariant holds exactly).
 *   • Commands mutate state + aggregates atomically; emit ActivityEvent.
 */

import type {
  TreasuryV2,
  TreasuryHolding,
  MemberV2,
  MemberStatus,
  MembersSummary,
  DistributionBucket,
  NetworkV2,
  BusinessV2,
  PledgeV2,
  PledgeStatus,
  PledgesSummary,
  VolumeSummary,
  VolumeBucket,
  VolumeKind,
  SpendSummary,
  PersonalSummary,
  PledgeProgress,
  ActivityEvent,
  ActivityLevel,
  NodeAccount,
  BlockV2,
  QuorumCert,
  NodeMetrics,
  TestnetNodeV2,
  EqualityReportV2,
  ConsensusTestV2,
  SnapshotV2,
  CommandResult,
} from "./types.ts"
import { cents } from "./types.ts"

// ─────────────────────────────────────────────────────────────────────────────
// Seeded RNG (mulberry32) — fast, deterministic, good distribution
// ─────────────────────────────────────────────────────────────────────────────

class SeededRNG {
  private state: number
  constructor(seed: number) { this.state = seed >>> 0 }
  next(): number {
    this.state = (this.state + 0x6D2B79F5) >>> 0
    let z = this.state
    z = Math.imul(z ^ (z >>> 15), 0x2127599BF)
    z = Math.imul(z ^ (z >>> 13), 0x2127599BF)
    return (z ^ (z >>> 16)) >>> 0
  }
  float(): number { return this.next() / 0x100000000 }
  int(max: number): number { return Math.floor(this.float() * max) }
  pick<T>(arr: T[]): T { return arr[this.int(arr.length)] }
  shuffle<T>(arr: T[]): T[] {
    const a = [...arr]
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.int(i + 1)
      ;[a[i], a[j]] = [a[j], a[i]]
    }
    return a
  }
  /** Random lowercase hex string of `len` characters. */
  hex(len: number): string {
    const HEX = "0123456789abcdef"
    let s = ""
    for (let i = 0; i < len; i++) s += HEX[this.int(16)]
    return s
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants matching the reference image (guide §31 composition)
// ─────────────────────────────────────────────────────────────────────────────

const RATE_USD_PER_AEQ = 2.2805
const FROZEN_SNAPSHOT = process.env.AEQUDASH_SNAPSHOT === "1"
const GENESIS_MS = FROZEN_SNAPSHOT
  ? Date.parse("2026-09-16T12:34:27.000Z")
  : Date.now()

/** Backend clock — frozen at genesis in snapshot mode so frames are
 *  byte-reproducible; wall time otherwise. Shared by bridge + simulator. */
export function backendNowMs(): number {
  return FROZEN_SNAPSHOT ? GENESIS_MS : Date.now()
}

const HEARTBEAT_MS = 2400
const ACTIVITY_CAP = 500
const TPS_WINDOW_MS = 60_000

// ─────────────────────────────────────────────────────────────────────────────
// Internal mutable state
// ─────────────────────────────────────────────────────────────────────────────

interface SimState {
  tick: number
  blockHeight: number
  currentUser: string
  // Treasury
  treasuryAeq: number
  holdings: TreasuryHolding[]
  totalSupply: number
  circulatingSupply: number
  // Members
  members: Map<string, MemberV2>
  agg: {
    registered: number
    active24h: number
    pending: number
    suspended: number
    regionBuckets: Map<string, number>
  }
  // Networks
  networks: Map<string, NetworkV2>
  // Businesses
  businesses: Map<string, BusinessV2>
  // Pledges
  pledges: Map<string, PledgeV2>
  pledgeAgg: {
    total: number
    inProgress: number
    completed: number
    failed: number
    totalValueAeq: number
    avgDurationDays: number
    catCount: Map<string, number>
  }
  // Volume
  volume: {
    totalAeq: number
    byKind: Map<VolumeKind, number>
    txCount24h: number
    totalFeesAeq: number
    tpsWindow: number[]  // timestamps of txs in last 60s
  }
  // Spend window
  spend: {
    limitAeq: number
    usedAeq: number
    windowStartMs: number
    windowDays: number
  }
  // Node
  node: TestnetNodeV2 | null
  // Derived reports
  equality: EqualityReportV2 | null
  consensus: ConsensusTestV2 | null
  // Activity feed (newest last)
  activity: ActivityEvent[]
  // Heartbeat timer
  hbTimer: ReturnType<typeof setTimeout> | null
  // Emission callback
  emit: ((ev: ActivityEvent) => void) | null
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: emit activity event
// ─────────────────────────────────────────────────────────────────────────────

function pushActivity(s: SimState, ev: ActivityEvent): void {
  s.activity.push(ev)
  if (s.activity.length > ACTIVITY_CAP) s.activity.shift()
  s.emit?.(ev)
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting helpers (local, no theme import to avoid cycles)
// ─────────────────────────────────────────────────────────────────────────────

function fmt0(n: number): string {
  if (!isFinite(n)) return "—"
  return Math.round(n).toLocaleString("en-US")
}
function fmt2(n: number): string {
  if (!isFinite(n)) return "—"
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function fmtPct(points: number, decimals = 1): string {
  if (!isFinite(points)) return "—"
  return `${points.toFixed(decimals)}%`
}

// ─────────────────────────────────────────────────────────────────────────────
// Core simulator class
// ─────────────────────────────────────────────────────────────────────────────

export class AequSimulator {
  private state: SimState
  private rng: SeededRNG

  constructor(opts: { seed?: number; frozen?: boolean } = {}) {
    this.rng = new SeededRNG(opts.seed ?? 42)
    this.state = this.initialState()
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Initial state construction — matches reference image composition
  // ───────────────────────────────────────────────────────────────────────────

  private initialState(): SimState {
    const now = GENESIS_MS
    const rng = this.rng

    // ── Treasury ──
    const treasuryAeq = 1_248_672.31
    const totalSupply = 10_000_000
    const circulatingSupply = 7_432_118.76

    const holdings: TreasuryHolding[] = [
      { denom: "AEQ", amount_aeq: 546_918.55, is_native: true },
      { denom: "USDC", amount_aeq: 392_083.11, is_native: false },
      { denom: "ETH", amount_aeq: 184_803.50, is_native: false },
      { denom: "BTC", amount_aeq: 94_899.10, is_native: false },
      { denom: "Other", amount_aeq: 29_968.05, is_native: false },
    ]
    // Normalize residual to make sum exact
    const sumHoldings = holdings.reduce((a, h) => a + h.amount_aeq, 0)
    holdings[4].amount_aeq = cents(treasuryAeq - (sumHoldings - holdings[4].amount_aeq))

    // ── Members working set (12 interactive) ──
    const members = new Map<string, MemberV2>()
    const regions = ["North America", "Europe", "Asia", "Africa", "Latin America", "Oceania"]
    const workingSet: Array<{
      id: string; region: string; rep: number; status: MemberStatus
      nets: string[]; biz: string[]; spendUsed: number; spendAllow: number
    }> = [
      { id: "aelith", region: "Europe", rep: 98.7, status: "active", nets: ["aequ_net", "dollar_net"], biz: ["equitech"], spendUsed: 1245.30, spendAllow: 100_000 },
      { id: "founder", region: "North America", rep: 99.4, status: "active", nets: ["aequ_net", "rand_net"], biz: ["equitech", "atlas_logistics"], spendUsed: 3102.77, spendAllow: 100_000 },
      { id: "alice", region: "North America", rep: 97.2, status: "active", nets: ["aequ_net"], biz: ["ubuntuworks"], spendUsed: 890.12, spendAllow: 100_000 },
      { id: "bob", region: "Europe", rep: 95.8, status: "active", nets: ["dollar_net", "euro_net"], biz: ["meridian_foods"], spendUsed: 2100.44, spendAllow: 100_000 },
      { id: "carla", region: "Latin America", rep: 96.1, status: "active", nets: ["rand_net"], biz: ["ubuntuworks"], spendUsed: 560.88, spendAllow: 100_000 },
      { id: "dave", region: "Africa", rep: 94.9, status: "active", nets: ["aequ_net"], biz: [], spendUsed: 0, spendAllow: 100_000 },
      { id: "erin", region: "Europe", rep: 93.3, status: "active", nets: ["euro_net"], biz: ["atlas_logistics"], spendUsed: 120.50, spendAllow: 100_000 },
      { id: "frank", region: "North America", rep: 92.7, status: "active", nets: ["dollar_net"], biz: [], spendUsed: 0, spendAllow: 100_000 },
      { id: "grace", region: "Asia", rep: 98.1, status: "active", nets: ["aequ_net"], biz: [], spendUsed: 3400.00, spendAllow: 100_000 },
      { id: "henry", region: "Africa", rep: 91.5, status: "pending", nets: [], biz: [], spendUsed: 0, spendAllow: 100_000 },
      { id: "iris", region: "Asia", rep: 96.8, status: "pending", nets: ["aequ_net"], biz: [], spendUsed: 0, spendAllow: 100_000 },
      { id: "jamal", region: "Africa", rep: 95.2, status: "suspended", nets: ["rand_net"], biz: [], spendUsed: 0, spendAllow: 100_000 },
    ]

    const activeCount = workingSet.filter(m => m.status === "active").length
    const pendingCount = workingSet.filter(m => m.status === "pending").length
    const suspendedCount = workingSet.filter(m => m.status === "suspended").length

    // Network-wide aggregates (image totals)
    const registeredTotal = 14_203
    const active24hTotal = 12_482
    const pendingTotal = 311
    const suspendedTotal = 42

    // Region buckets summing to active24hTotal (image numbers)
    const regionBuckets = new Map<string, number>([
      ["North America", 3545],
      ["Europe", 3083],
      ["Asia", 2758],
      ["Africa", 1847],
      ["Latin America", 1149],
      ["Oceania", 100],
    ])

    for (const m of workingSet) {
      const val = treasuryAeq / active24hTotal  // exact — quantization is presentation-only
      members.set(m.id, {
        id: m.id,
        value_aeq: val,
        status: m.status,
        region: m.region,
        reputation: m.rep,
        networks: m.nets,
        businesses: m.biz,
        spend_used_30d_aeq: m.spendUsed,
        spend_allowance_30d_aeq: m.spendAllow,
        joined_at: new Date(now - rng.int(365 * 86400000)).toISOString(),
      })
    }

    // ── Networks (4, summing to circulating) ──
    const networks = new Map<string, NetworkV2>()
    const netDefs = [
      { id: "aequ_net", name: "AequNet", denom: "AEQ", peg: 1.0, members: 9801, value: 5_846_220.10 },
      { id: "dollar_net", name: "DollarNet", denom: "USD", peg: RATE_USD_PER_AEQ, members: 1842, value: 1_020_442.66 },
      { id: "euro_net", name: "EuroNet", denom: "EUR", peg: 2.10, members: 612, value: 402_118.44 },
      { id: "rand_net", name: "RandNet", denom: "ZAR", peg: 41.5, members: 227, value: 163_337.56 },
    ]
    for (const n of netDefs) {
      networks.set(n.id, {
        id: n.id, name: n.name, denom: n.denom, peg_rate: n.peg,
        members: n.members, value_aeq: n.value,
        created_at: new Date(now - rng.int(180 * 86400000)).toISOString(),
      })
    }

    // ── Businesses (4) ──
    const businesses = new Map<string, BusinessV2>()
    const bizDefs = [
      { id: "equitech", name: "EquiTech", owner: "founder", net: "aequ_net", ec: 0.03, emp: 214, alloc: 84_210.50, spent30: 4_102.77 },
      { id: "ubuntuworks", name: "UbuntuWorks", owner: "alice", net: "aequ_net", ec: 0.025, emp: 156, alloc: 61_004.12, spent30: 2_880.40 },
      { id: "meridian_foods", name: "Meridian Foods", owner: "carla", net: "dollar_net", ec: 0.02, emp: 89, alloc: 33_118.90, spent30: 1_542.20 },
      { id: "atlas_logistics", name: "Atlas Logistics", owner: "erin", net: "euro_net", ec: 0.015, emp: 47, alloc: 18_442.66, spent30: 912.30 },
    ]
    for (const b of bizDefs) {
      businesses.set(b.id, {
        id: b.id, name: b.name, owner: b.owner, net_id: b.net,
        contribution_rate: b.ec, employees: b.emp,
        treasury_allocation_aeq: b.alloc, thirty_day_used_aeq: b.spent30,
        created_at: new Date(now - rng.int(120 * 86400000)).toISOString(),
      })
    }

    // ── Pledges working set (8 interactive, inside 247 total) ──
    const pledges = new Map<string, PledgeV2>()
    const pledgeDefs = [
      { id: "7f3a2e", name: "Harbor Grid", cat: "Infrastructure", target: 2000, raised: 1240, status: "in_progress" as PledgeStatus, creator: "aelith", purpose: "Coastal resilience infrastructure" },
      { id: "9c1d4f", name: "School Drive", cat: "Education", target: 2000, raised: 760, status: "in_progress" as PledgeStatus, creator: "aelith", purpose: "Rural school connectivity" },
      { id: "d5e7a1", name: "Clinic Fund", cat: "Health", target: 500, raised: 500, status: "completed" as PledgeStatus, creator: "aelith", purpose: "Mobile health clinic" },
      { id: "3b82c0", name: "Solar Coop", cat: "Environment", target: 3000, raised: 1620, status: "in_progress" as PledgeStatus, creator: "grace", purpose: "Community solar array" },
      { id: "a91f55", name: "Archive Vault", cat: "Other", target: 1200, raised: 450, status: "in_progress" as PledgeStatus, creator: "bob", purpose: "Digital preservation" },
      { id: "e4c7d2", name: "Market Stalls", cat: "Social", target: 980, raised: 980, status: "completed" as PledgeStatus, creator: "carla", purpose: "Vendor microgrants" },
      { id: "62d0b8", name: "Water Mesh", cat: "Infrastructure", target: 1500, raised: 210, status: "in_progress" as PledgeStatus, creator: "dave", purpose: "Decentralized water monitoring" },
      { id: "f05a39", name: "Radio Relay", cat: "Other", target: 900, raised: 300, status: "failed" as PledgeStatus, creator: "frank", purpose: "Mesh comms relay" },
    ]
    for (const p of pledgeDefs) {
      pledges.set(p.id, {
        id: p.id, name: p.name, category: p.cat,
        target_aeq: p.target, raised_aeq: p.raised,
        status: p.status, creator: p.creator,
        supporters: [{ member: p.creator, amount_aeq: Math.floor(p.raised * 0.6) }],
        purpose: p.purpose, created_at: new Date(now - rng.int(60 * 86400000)).toISOString(),
        duration_days: rng.int(30) + 1,
      })
    }

    // ── Pledge aggregates (247 total, image-consistent) ──
    const pledgeAgg = {
      total: 247,
      inProgress: 87,
      completed: 156,
      failed: 4,
      totalValueAeq: 1_893_442.17,
      avgDurationDays: 18.6,
      catCount: new Map<string, number>([
        ["Infrastructure", 80],
        ["Social", 56],
        ["Environment", 45],
        ["Education", 31],
        ["Health", 22],
        ["Other", 13],
      ]),
    }

    // ── Volume (24h) ──
    const totalAeq = 214_563.12
    const volByKind = new Map<VolumeKind, number>([
      ["transfers", cents(totalAeq * 0.641)],
      ["pledges", cents(totalAeq * 0.202)],
      ["contracts", cents(totalAeq * 0.108)],
      ["other", 0], // residual
    ])
    const sumVol = Array.from(volByKind.values()).reduce((a, v) => a + v, 0)
    volByKind.set("other", cents(totalAeq - sumVol))

    const volume = {
      totalAeq,
      byKind: volByKind,
      txCount24h: 8_742,
      totalFeesAeq: cents(8_742 * 0.12),
      tpsWindow: [] as number[],
    }

    // Seed TPS window to yield ~3.2 tps at genesis
    for (let i = 0; i < 192; i++) {
      volume.tpsWindow.push(now - rng.int(TPS_WINDOW_MS))
    }

    // ── Spend window ──  (USD is the defined value; AEQ derived at full
    //    precision so USD displays exactly $1,200,000.00 / $412,563.21)
    const limitAeq = 1_200_000 / RATE_USD_PER_AEQ
    const usedAeq = 412_563.21 / RATE_USD_PER_AEQ
    const windowDays = 30
    const windowStartMs = now - 11 * 86400000 - 12 * 3600000 - 35 * 60000 // 11d 12h 35m ago → reset in 18d 11h 25m

    const spend = { limitAeq, usedAeq, windowStartMs, windowDays }

    // ── Node ──
    const nodeAccounts: NodeAccount[] = workingSet
      .filter(m => m.status === "active")
      .slice(0, 8)
      .map((m, i) => ({
        id: m.id,
        balance_aeq: cents(rng.float() * 5000 + 500),
        head_hash: "0x" + rng.hex(64),
        nonce: rng.int(10),
      }))

    const blocks: BlockV2[] = []
    for (let i = 0; i < 12; i++) {
      blocks.push({
        index: 1_248_660 + i,
        hash: "0x" + rng.hex(64),
        prev_hash: i === 0 ? "0x" + "0".repeat(64) : blocks[i - 1].hash,
        timestamp: new Date(now - (12 - i) * 2400).toISOString(),
        tx_count: rng.int(3) + 1,
        validator: `committee#${i % 12}`,
        state_root: "0x" + rng.hex(64),
      })
    }
    const quorumCerts: QuorumCert[] = blocks.map((b, i) => ({
      block_hash: b.hash,
      committee_id: `cmt#${i}`,
      signatures: 8,
      threshold: 8,
    }))

    const nodeMetrics: NodeMetrics = {
      total_payments: 312,
      avg_latency_ms: 23.4,
      last_latency_ms: 19,
      throughput_tps: 3.2,
      uptime_seconds: Math.floor((now - (now - 3600000)) / 1000),
      memory_bytes: 42_500_000,
      peers: 12,
    }

    const node: TestnetNodeV2 = {
      running: true,
      label: "aeqnode-01",
      version: "0.8.4",
      config: { committee_size: 12, threshold: 8, epoch_seed: "42" },
      accounts: nodeAccounts,
      blocks,
      quorum_certs: quorumCerts,
      state_root_hex: blocks[blocks.length - 1].state_root,
      metrics: nodeMetrics,
    }

    // ── Equality report ──
    const memberValue = cents(treasuryAeq / active24hTotal)
    const equality: EqualityReportV2 = {
      all_passed: true,
      total_members: active24hTotal,
      treasury_value_aeq: treasuryAeq,
      expected_member_value_aeq: memberValue,
      variance: 0.0008,
      threshold: 0.01,
      checks: Array.from(members.values()).map(m => ({
        member_id: m.id, actual: m.value_aeq, expected: memberValue, passed: true,
      })),
      duration_ms: 3,
    }

    // ── Consensus test ──
    const consensus: ConsensusTestV2 = {
      committee_size: 12,
      threshold: 8,
      byzantine: 3,
      round: 742,
      validators: 12,
      payments_sent: 50,
      payments_confirmed: 50,
      avg_latency_ms: 23.4,
      state_root_hex: node.state_root_hex,
      passed: true,
      notes: [
        "Single-round finality via micro-committee quorum certificates",
        "Byzantine tolerance: f = ⌊(n-1)/3⌋ = 3",
        "QC threshold reached for every block; no conflicts detected",
      ],
    }

    // ── Initial activity (seeded events matching image exactly, newest last) ──
    const activity: ActivityEvent[] = [
      {
        ts: new Date(now - 376_000).toISOString(),
        level: "info",
        tag: "network_stats",
        message: "Network statistics refreshed",
        fields: [
          { k: "tps", v: "3.2" },
          { k: "txs_24h", v: fmt0(8742) },
          { k: "avg_fee", v: "0.12 AEQ" },
        ],
      },
      {
        ts: new Date(now - 280_000).toISOString(),
        level: "info",
        tag: "member_sync",
        message: "Member data synchronized",
        fields: [
          { k: "members", v: fmt0(12482) },
          { k: "active", v: fmt0(12482) },
        ],
      },
      {
        ts: new Date(now - 204_000).toISOString(),
        level: "info",
        tag: "pledge_update",
        message: "Pledge progress updated",
        fields: [
          { k: "pledge", v: "7f3a2e" },
          { k: "progress", v: "62%" },
          { k: "value", v: "1,240.00 AEQ" },
        ],
      },
      {
        ts: new Date(now - 131_000).toISOString(),
        level: "info",
        tag: "demo",
        message: "Demo transaction processed",
        fields: [
          { k: "tx_hash", v: "0x" + rng.hex(16) },
          { k: "amount", v: "125.00 AEQ" },
        ],
      },
      {
        ts: new Date(now - 60_000).toISOString(),
        level: "info",
        tag: "consensus_test",
        message: "Consensus test completed",
        fields: [
          { k: "result", v: "ok" },
          { k: "round", v: "742" },
          { k: "validators", v: "12" },
        ],
      },
      {
        ts: new Date(now - 33_000).toISOString(),
        level: "info",
        tag: "equality_check",
        message: "Equidistribution check passed",
        fields: [
          { k: "variance", v: "0.0008" },
          { k: "threshold", v: "0.01" },
        ],
      },
      {
        ts: new Date(now - 10_000).toISOString(),
        level: "info",
        tag: "node_status",
        message: "Node status update",
        fields: [
          { k: "status", v: "healthy" },
          { k: "peers", v: "12" },
          { k: "height", v: fmt0(1_248_672) },
        ],
      },
      {
        ts: new Date(now - 6_000).toISOString(),
        level: "info",
        tag: "node_init",
        message: "Node initialized successfully",
        fields: [
          { k: "node", v: "aeqnode-01" },
          { k: "version", v: "0.8.4" },
          { k: "network", v: "testnet" },
        ],
      },
    ]

    return {
      tick: 0,
      blockHeight: 1_248_672,
      currentUser: "aelith",
      treasuryAeq,
      holdings,
      totalSupply,
      circulatingSupply,
      members,
      agg: {
        registered: registeredTotal,
        active24h: active24hTotal,
        pending: pendingTotal,
        suspended: suspendedTotal,
        regionBuckets,
      },
      networks,
      businesses,
      pledges,
      pledgeAgg,
      volume,
      spend,
      node,
      equality,
      consensus,
      activity,
      hbTimer: null,
      emit: null,
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Public API
  // ───────────────────────────────────────────────────────────────────────────

  /** Start heartbeat (no-op when frozen for snapshots). */
  start(emit: (ev: ActivityEvent) => void): void {
    this.state.emit = emit
    if (FROZEN_SNAPSHOT) return
    this.state.hbTimer = setInterval(() => this.tick(), HEARTBEAT_MS)
  }

  stop(): void {
    if (this.state.hbTimer) clearInterval(this.state.hbTimer)
    this.state.hbTimer = null
    this.state.emit = null
  }

  /** Current virtual time (frozen = genesis; live = wall clock). */
  now(): number {
    return FROZEN_SNAPSHOT ? GENESIS_MS : Date.now()
  }

  /**
   * Heartbeat tick — one ephemeral block interval (~2.4s).
   * Rotates through the canonical event vocabulary, increments height,
   * records txs in the TPS window, and gently drifts live pledges.
   *
   * Public for testability: tests drive ticks synchronously instead of
   * waiting on wall-clock timers.
   */
  tick(): void {
    const s = this.state
    const rng = this.rng
    const now = this.now()
    s.tick++
    s.blockHeight++

    // Node: mint a block + QC each tick
    if (s.node?.running) {
      const block: BlockV2 = {
        index: s.node.blocks.length,
        hash: "0x" + rng.hex(64),
        prev_hash: s.node.blocks.at(-1)?.hash ?? "0x" + "0".repeat(64),
        timestamp: new Date(now).toISOString(),
        tx_count: rng.int(3) + 1,
        validator: `committee#${s.node.blocks.length % s.node.config.committee_size}`,
        state_root: "0x" + rng.hex(64),
      }
      s.node.blocks.push(block)
      if (s.node.blocks.length > 64) s.node.blocks.shift()
      s.node.quorum_certs.push({
        block_hash: block.hash,
        committee_id: `cmt#${block.index}`,
        signatures: s.node.config.threshold,
        threshold: s.node.config.threshold,
      })
      if (s.node.quorum_certs.length > 64) s.node.quorum_certs.shift()
      s.node.state_root_hex = block.state_root
      if (s.node.metrics) {
        s.node.metrics.uptime_seconds += HEARTBEAT_MS / 1000
        s.node.metrics.total_payments += block.tx_count
        s.node.metrics.last_latency_ms = 12 + rng.int(24)
        s.node.metrics.avg_latency_ms = cents(
          s.node.metrics.avg_latency_ms * 0.95 + s.node.metrics.last_latency_ms * 0.05,
        )
      }
    }

    // Volume drift: a few txs per tick
    const txNow = rng.int(3) + 1
    for (let i = 0; i < txNow; i++) s.volume.tpsWindow.push(now)
    s.volume.txCount24h += txNow
    const drift = cents(rng.float() * 8 + 0.5)
    s.volume.totalAeq = cents(s.volume.totalAeq + drift * txNow)
    s.volume.byKind.set("transfers", cents((s.volume.byKind.get("transfers") ?? 0) + drift * txNow))
    s.volume.totalFeesAeq = cents(s.volume.totalFeesAeq + 0.12 * txNow)

    // Pledge drift: the highlighted in-progress pledge accrues support
    const livePledge = s.pledges.get("7f3a2e")
    if (livePledge && livePledge.status === "in_progress" && s.tick % 4 === 0) {
      livePledge.raised_aeq = cents(Math.min(livePledge.target_aeq, livePledge.raised_aeq + rng.float() * 2))
    }

    // Rotating activity vocabulary (order matches the seeded feed)
    const tags = ["node_status", "member_sync", "network_stats", "equality_check", "consensus_test", "pledge_update", "demo"] as const
    const tag = tags[s.tick % tags.length]
    const ev = (msg: string, fields: { k: string; v: string }[], level: ActivityLevel = "info"): void =>
      pushActivity(s, { ts: new Date(now).toISOString(), level, tag, message: msg, fields })

    switch (tag) {
      case "node_status":
        ev("Node status update", [
          { k: "status", v: "healthy" },
          { k: "peers", v: String(s.node?.metrics?.peers ?? 12) },
          { k: "height", v: fmt0(s.blockHeight) },
        ])
        break
      case "member_sync":
        ev("Member data synchronized", [
          { k: "members", v: fmt0(s.agg.registered) },
          { k: "active", v: fmt0(s.agg.active24h) },
        ])
        break
      case "network_stats": {
        const winStart = now - TPS_WINDOW_MS
        const tps = (s.volume.tpsWindow.filter((t) => t >= winStart).length / 60).toFixed(1)
        ev("Network statistics refreshed", [
          { k: "tps", v: tps },
          { k: "txs_24h", v: fmt0(s.volume.txCount24h) },
          { k: "avg_fee", v: `${fmt2(s.volume.txCount24h > 0 ? s.volume.totalFeesAeq / s.volume.txCount24h : 0)} AEQ` },
        ])
        break
      }
      case "equality_check":
        ev("Equidistribution check passed", [
          { k: "variance", v: "0.0008" },
          { k: "threshold", v: "0.01" },
        ], "success")
        break
      case "consensus_test":
        ev("Consensus test completed", [
          { k: "result", v: "ok" },
          { k: "round", v: fmt0(742 + s.tick) },
          { k: "validators", v: String(s.node?.config.committee_size ?? 12) },
        ], "success")
        break
      case "pledge_update":
        if (livePledge) {
          ev("Pledge progress updated", [
            { k: "pledge", v: livePledge.id },
            { k: "progress", v: `${Math.round((livePledge.raised_aeq / livePledge.target_aeq) * 100)}%` },
            { k: "value", v: `${fmt2(livePledge.raised_aeq)} AEQ` },
          ])
        }
        break
      case "demo":
        ev("Demo transaction processed", [
          { k: "tx_hash", v: "0x" + rng.hex(16) },
          { k: "amount", v: `${fmt2(cents(rng.float() * 200 + 10))} AEQ` },
        ])
        break
    }
  }

  /** Full snapshot for UI rendering. */
  snapshot(): SnapshotV2 {
    const s = this.state
    const now = this.now()

    // Member value (equality invariant)
    const memberValue = s.treasuryAeq / s.agg.active24h  // exact — equality invariant holds precisely

    // Treasury holdings with computed percentages
    const holdingsWithPct = s.holdings.map(h => ({
      ...h,
      pct: cents((h.amount_aeq / s.treasuryAeq) * 100),
    }))

    // Treasury total USD
    const treasuryUsd = cents(s.treasuryAeq * RATE_USD_PER_AEQ)

    // Members summary
    const membersSummary: MembersSummary = {
      total_registered: s.agg.registered,
      active_24h: s.agg.active24h,
      pending: s.agg.pending,
      suspended: s.agg.suspended,
      distribution: Array.from(s.agg.regionBuckets.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([label, count]) => ({
          label, count,
          pct: cents((count / s.agg.active24h) * 100),
        })),
    }

    // Volume summary
    const volumeByKind: VolumeBucket[] = Array.from(s.volume.byKind.entries()).map(([kind, amount]) => ({
      kind, amount_aeq: amount,
      pct: cents((amount / s.volume.totalAeq) * 100),
    }))
    // Prune TPS window
    const windowStart = now - TPS_WINDOW_MS
    const recentTx = s.volume.tpsWindow.filter(t => t >= windowStart)
    const tps1m = cents(recentTx.length / 60)

    const volume: VolumeSummary = {
      total_aeq: s.volume.totalAeq,
      total_usd: cents(s.volume.totalAeq * RATE_USD_PER_AEQ),
      breakdown: volumeByKind,
      tx_count_24h: s.volume.txCount24h,
      avg_fee_aeq: s.volume.txCount24h > 0 ? cents(s.volume.totalFeesAeq / s.volume.txCount24h) : 0,
      block_height: s.blockHeight,
      tps_1m: tps1m,
    }

    // Spend summary
    const elapsedDays = (now - s.spend.windowStartMs) / 86400000
    const daysElapsed = Math.max(1, Math.ceil(elapsedDays))
    const remainingAeq = Math.max(0, s.spend.limitAeq - s.spend.usedAeq)
    const dailyAvg = cents(s.spend.usedAeq / daysElapsed)
    const projected30d = cents(dailyAvg * s.spend.windowDays)
    const resetAt = new Date(s.spend.windowStartMs + s.spend.windowDays * 86400000).toISOString()

    const spend: SpendSummary = {
      limit_aeq: s.spend.limitAeq,
      limit_usd: cents(s.spend.limitAeq * RATE_USD_PER_AEQ),
      used_aeq: s.spend.usedAeq,
      used_usd: cents(s.spend.usedAeq * RATE_USD_PER_AEQ),
      remaining_aeq: remainingAeq,
      remaining_usd: cents(remainingAeq * RATE_USD_PER_AEQ),
      used_pct: cents((s.spend.usedAeq / s.spend.limitAeq) * 100),
      daily_avg_aeq: dailyAvg,
      projected_30d_aeq: projected30d,
      window_days: s.spend.windowDays,
      days_elapsed: daysElapsed,
      reset_at: resetAt,
      policy: "Equidistributed",
      max_per_member_aeq: 100_000,
      network_denom: "AEQ",
    }

    // Personal summary (current user)
    const me = s.members.get(s.currentUser)
    const personal: PersonalSummary = me ? {
      member_id: me.id,
      value_aeq: me.value_aeq,
      value_usd: cents(me.value_aeq * RATE_USD_PER_AEQ),
      // no cents() here — share needs 4dp precision (0.0080%), not 2dp
      share_pct: (me.value_aeq / s.treasuryAeq) * 100,
      active_pledges: Array.from(s.pledges.values())
        .filter(p => p.creator === me.id || p.supporters.some(sup => sup.member === me.id))
        .length,
      reputation: me.reputation,
      pledge_progress: Array.from(s.pledges.values())
        .filter(p => p.creator === me.id || p.supporters.some(sup => sup.member === me.id))
        .map(p => ({
          id: p.id,
          pct: cents((p.raised_aeq / p.target_aeq) * 100),
          raised_aeq: p.raised_aeq,
          target_aeq: p.target_aeq,
        })),
    } : { member_id: "", value_aeq: 0, value_usd: 0, share_pct: 0, active_pledges: 0, reputation: 0, pledge_progress: [] }

    // Pledges summary
    const pledgesSummary: PledgesSummary = {
      total: s.pledgeAgg.total,
      in_progress: s.pledgeAgg.inProgress,
      completed: s.pledgeAgg.completed,
      failed: s.pledgeAgg.failed,
      total_value_aeq: s.pledgeAgg.totalValueAeq,
      avg_duration_days: s.pledgeAgg.avgDurationDays,
      success_rate: cents((s.pledgeAgg.completed / (s.pledgeAgg.completed + s.pledgeAgg.failed)) * 100),
      distribution: Array.from(s.pledgeAgg.catCount.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([label, count]) => ({
          label, count,
          pct: cents((count / s.pledgeAgg.total) * 100),
        })),
    }

    // Deep-clone the payload: snapshots are immutable value objects.
    // Callers (React store, tests) must never alias live state — otherwise
    // referential equality breaks (a `before` snapshot mutates under you).
    return structuredClone({
      ready: true,
      network: "testnet",
      block_height: s.blockHeight,
      server_time: new Date(now).toISOString(),
      current_user: s.currentUser,
      treasury: {
        total_aeq: s.treasuryAeq,
        total_usd: treasuryUsd,
        currency: "USD",
        network_denom: "AEQ",
        aeq_usd_rate: RATE_USD_PER_AEQ,
        total_supply: s.totalSupply,
        circulating_supply: s.circulatingSupply,
        holdings: holdingsWithPct,
        last_updated: new Date(now - 1_000).toISOString(),
      },
      member_value_aeq: memberValue,
      members_summary: membersSummary,
      members: Array.from(s.members.values()),
      networks: Array.from(s.networks.values()),
      businesses: Array.from(s.businesses.values()),
      pledges: Array.from(s.pledges.values()),
      pledges_summary: pledgesSummary,
      volume,
      spend,
      personal,
      node: s.node,
      equality: s.equality,
      consensus: s.consensus,
      activity: s.activity,
      full_fidelity: true,
    })
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Command execution (mutates state atomically, emits activity)
  // ───────────────────────────────────────────────────────────────────────────

  cliRun(command: string, args: string[] = []): CommandResult {
    const s = this.state
    const rng = this.rng
    const now = this.now()

    const emit = (tag: string, message: string, level: ActivityLevel = "info", fields: { k: string; v: string }[] = []) => {
      pushActivity(s, { ts: new Date(now).toISOString(), level, tag, message, fields })
    }

    const rebalance = () => {
      const newVal = s.treasuryAeq / s.agg.active24h  // exact
      for (const m of s.members.values()) m.value_aeq = newVal
      if (s.equality) {
        s.equality.expected_member_value_aeq = newVal
        s.equality.treasury_value_aeq = s.treasuryAeq
        for (const c of s.equality.checks) { c.actual = newVal; c.expected = newVal; c.passed = true }
      }
    }

    try {
      switch (command.toLowerCase()) {
        case "login": {
          const id = args[0]
          if (!id) return { ok: false, message: "usage: login <member_id>" }
          if (!s.members.has(id)) return { ok: false, message: `no such member: ${id}` }
          s.currentUser = id
          emit("auth", `Logged in as ${id}`, "success")
          return { ok: true, message: `logged in as ${id}` }
        }
        case "logout": {
          s.currentUser = ""
          emit("auth", "Logged out", "info")
          return { ok: true, message: "logged out" }
        }
        case "join": {
          const id = args[0]
          const deposit = parseFloat(args[1] ?? "0")
          if (!id) return { ok: false, message: "usage: join <id> [deposit]" }
          if (s.members.has(id)) return { ok: false, message: `${id} already exists` }
          if (deposit < 0) return { ok: false, message: "deposit cannot be negative" }
          s.treasuryAeq = cents(s.treasuryAeq + deposit)
          const region = rng.pick(["North America", "Europe", "Asia", "Africa", "Latin America", "Oceania"])
          const bucket = s.agg.regionBuckets.get(region) ?? 0
          s.agg.regionBuckets.set(region, bucket + 1)
          s.agg.registered++
          s.agg.active24h++
          s.members.set(id, {
            id, value_aeq: 0, status: "active", region, reputation: cents(90 + rng.float() * 10),
            networks: [], businesses: [], spend_used_30d_aeq: 0, spend_allowance_30d_aeq: 100_000,
            joined_at: new Date(now).toISOString(),
          })
          rebalance()
          emit("join", `${id} joined with deposit ${fmt2(deposit)}`, "success", [{ k: "deposit", v: fmt2(deposit) }])
          return { ok: true, message: `${id} joined with deposit ${fmt2(deposit)}` }
        }
        case "exit_member": {
          const id = args[0]
          if (!id) return { ok: false, message: "usage: exit_member <id>" }
          if (!s.members.delete(id)) return { ok: false, message: `no such member: ${id}` }
          s.agg.active24h = Math.max(0, s.agg.active24h - 1)
          rebalance()
          emit("exit", `${id} exited`, "info")
          return { ok: true, message: `${id} exited` }
        }
        case "withdraw": {
          const id = args[0]
          const amount = parseFloat(args[1] ?? "0")
          const purpose = args.slice(2).join(" ") || "withdrawal"
          if (!id || isNaN(amount)) return { ok: false, message: "usage: withdraw <id> <amount> [purpose]" }
          const m = s.members.get(id)
          if (!m) return { ok: false, message: `no such member: ${id}` }
          if (amount <= 0) return { ok: false, message: "amount must be positive" }
          if (amount > m.spend_allowance_30d_aeq - m.spend_used_30d_aeq) {
            return { ok: false, message: "exceeds 30d spend allowance" }
          }
          s.treasuryAeq = cents(s.treasuryAeq - amount)
          m.spend_used_30d_aeq = cents(m.spend_used_30d_aeq + amount)
          s.spend.usedAeq = cents(s.spend.usedAeq + amount)
          s.volume.totalAeq = cents(s.volume.totalAeq + amount)
          s.volume.byKind.set("other", cents((s.volume.byKind.get("other") ?? 0) + amount))
          s.volume.txCount24h++
          s.volume.totalFeesAeq = cents(s.volume.totalFeesAeq + amount * 0.001)
          s.volume.tpsWindow.push(now)
          rebalance()
          emit("withdraw", `${id} withdrew ${fmt2(amount)} for ${purpose}`, "success", [{ k: "amount", v: fmt2(amount) }, { k: "purpose", v: purpose }])
          return { ok: true, message: `${id} withdrew ${fmt2(amount)} for ${purpose}` }
        }

        // Networks
        case "create_net": {
          const [name, denom, rateStr] = args
          if (!name || !denom || !rateStr) return { ok: false, message: "usage: create_net <name> <denom> <rate>" }
          const rate = parseFloat(rateStr)
          const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "_")
          if (s.networks.has(id)) return { ok: false, message: `${id} already exists` }
          s.networks.set(id, {
            id, name, denom, peg_rate: rate, members: 0, value_aeq: 0,
            created_at: new Date(now).toISOString(),
          })
          emit("network", `Created network ${name}`, "success")
          return { ok: true, message: `created network ${id}` }
        }
        case "join_net": {
          const [memberId, netId] = args
          if (!memberId || !netId) return { ok: false, message: "usage: join_net <member> <net>" }
          const m = s.members.get(memberId)
          const n = s.networks.get(netId)
          if (!m || !n) return { ok: false, message: `no such ${!m ? "member" : "network"}` }
          if (!m.networks.includes(netId)) m.networks.push(netId)
          n.members++
          emit("network", `${memberId} joined ${netId}`, "info")
          return { ok: true, message: `${memberId} joined ${netId}` }
        }
        case "transfer_net": {
          const [memberId, fromNet, toNet] = args
          if (!memberId || !fromNet || !toNet) return { ok: false, message: "usage: transfer_net <member> <from> <to>" }
          const m = s.members.get(memberId)
          if (!m) return { ok: false, message: "no such member" }
          m.networks = m.networks.filter(x => x !== fromNet)
          if (!m.networks.includes(toNet)) m.networks.push(toNet)
          const fromN = s.networks.get(fromNet)
          if (fromN) fromN.members = Math.max(0, fromN.members - 1)
          const toN = s.networks.get(toNet)
          if (toN) toN.members++
          emit("network", `${memberId} transferred ${fromNet} → ${toNet}`, "info")
          return { ok: true, message: `${memberId} transferred ${fromNet} → ${toNet}` }
        }

        // Businesses
        case "create_bus": {
          const [name, netId, ecStr] = args
          if (!name || !netId) return { ok: false, message: "usage: create_bus <name> <net_id> [ec_rate]" }
          const ec = parseFloat(ecStr ?? "0.02")
          const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "_")
          if (s.businesses.has(id)) return { ok: false, message: `${id} already exists` }
          s.businesses.set(id, {
            id, name, owner: s.currentUser || "founder", net_id: netId,
            contribution_rate: Math.max(0, Math.min(0.05, ec)), employees: 0,
            treasury_allocation_aeq: 0, thirty_day_used_aeq: 0,
            created_at: new Date(now).toISOString(),
          })
          emit("business", `Created business ${name}`, "success")
          return { ok: true, message: `created business ${id}` }
        }
        case "set_ec": {
          const [busId, rateStr] = args
          if (!busId || !rateStr) return { ok: false, message: "usage: set_ec <bus_id> <rate>" }
          const b = s.businesses.get(busId)
          if (!b) return { ok: false, message: `no such business: ${busId}` }
          b.contribution_rate = Math.max(0, Math.min(0.05, parseFloat(rateStr)))
          emit("business", `${busId} EC rate set to ${b.contribution_rate}`, "info")
          return { ok: true, message: `${busId} EC rate set to ${b.contribution_rate}` }
        }
        case "hire": {
          const [busId, memberId] = args
          if (!busId || !memberId) return { ok: false, message: "usage: hire <bus_id> <member>" }
          const b = s.businesses.get(busId)
          const m = s.members.get(memberId)
          if (!b || !m) return { ok: false, message: `no such ${!b ? "business" : "member"}` }
          b.employees++
          if (!m.businesses.includes(busId)) m.businesses.push(busId)
          emit("business", `${memberId} hired into ${busId}`, "info")
          return { ok: true, message: `${memberId} hired into ${busId}` }
        }
        case "bus_withdraw": {
          const [busId, amountStr, ...purposeParts] = args
          if (!busId || !amountStr) return { ok: false, message: "usage: bus_withdraw <bus_id> <amount> [purpose]" }
          const amount = parseFloat(amountStr)
          const b = s.businesses.get(busId)
          if (!b) return { ok: false, message: `no such business: ${busId}` }
          b.treasury_allocation_aeq = cents(b.treasury_allocation_aeq - amount)
          b.thirty_day_used_aeq = cents(b.thirty_day_used_aeq + amount)
          s.spend.usedAeq = cents(s.spend.usedAeq + amount)
          emit("business", `${busId} withdrew ${fmt2(amount)}`, "success", [{ k: "amount", v: fmt2(amount) }])
          return { ok: true, message: `${busId} withdrew ${fmt2(amount)}` }
        }

        // Pledges
        case "create_pledge": {
          const [name, targetStr, netId, ...purposeParts] = args
          if (!name || !targetStr || !netId) return { ok: false, message: "usage: create_pledge <name> <target> <net> [purpose]" }
          const target = parseFloat(targetStr)
          const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "_")
          if (s.pledges.has(id)) return { ok: false, message: `${id} already exists` }
          const category = rng.pick(["Infrastructure", "Social", "Environment", "Education", "Health", "Other"])
          s.pledges.set(id, {
            id, name, category, target_aeq: target, raised_aeq: 0,
            status: "in_progress", creator: s.currentUser || "founder",
            supporters: [], purpose: purposeParts.join(" ") || "—",
            created_at: new Date(now).toISOString(), duration_days: rng.int(30) + 1,
          })
          s.pledgeAgg.total++
          s.pledgeAgg.inProgress++
          const catCount = s.pledgeAgg.catCount.get(category) ?? 0
          s.pledgeAgg.catCount.set(category, catCount + 1)
          emit("pledge", `Created pledge ${name}`, "success", [{ k: "target", v: fmt2(target) }])
          return { ok: true, message: `created pledge ${id}` }
        }
        case "support": {
          const [pledgeId, amountStr] = args
          if (!pledgeId || !amountStr) return { ok: false, message: "usage: support <pledge_id> <amount>" }
          const amount = parseFloat(amountStr)
          const p = s.pledges.get(pledgeId)
          if (!p) return { ok: false, message: `no such pledge: ${pledgeId}` }
          p.raised_aeq = cents(p.raised_aeq + amount)
          p.supporters.push({ member: s.currentUser || "founder", amount_aeq: amount })
          s.volume.totalAeq = cents(s.volume.totalAeq + amount)
          s.volume.byKind.set("pledges", cents((s.volume.byKind.get("pledges") ?? 0) + amount))
          s.volume.txCount24h++
          s.volume.totalFeesAeq = cents(s.volume.totalFeesAeq + amount * 0.001)
          s.volume.tpsWindow.push(now)
          const wasInProgress = p.status === "in_progress"
          if (p.raised_aeq >= p.target_aeq && wasInProgress) {
            p.status = "completed"
            s.pledgeAgg.inProgress--
            s.pledgeAgg.completed++
            emit("pledge", `Pledge ${pledgeId} completed`, "success", [{ k: "pledge", v: pledgeId }])
          } else {
            emit("pledge", `Supported ${pledgeId} with ${fmt2(amount)}`, "success", [{ k: "amount", v: fmt2(amount) }])
          }
          return { ok: true, message: `${s.currentUser || "founder"} supported ${pledgeId} with ${fmt2(amount)}` }
        }

        // Node
        case "node_init": {
          const committee = parseInt(args[0] ?? "12")
          const threshold = parseInt(args[1] ?? "8")
          const seed = args[2] ?? "42"
          if (s.node?.running) return { ok: false, message: "node already running" }
          const accounts: NodeAccount[] = Array.from(s.members.values())
            .filter(m => m.status === "active")
            .slice(0, 8)
            .map((m, i) => ({
              id: m.id, balance_aeq: cents(rng.float() * 5000 + 500),
              head_hash: "0x" + rng.hex(64),
              nonce: rng.int(10),
            }))
          s.node = {
            running: true, label: "aeqnode-01", version: "0.8.4",
            config: { committee_size: committee, threshold, epoch_seed: seed },
            accounts, blocks: [], quorum_certs: [], state_root_hex: "0x" + "0".repeat(64),
            metrics: { total_payments: 0, avg_latency_ms: 0, last_latency_ms: 0, throughput_tps: 0, uptime_seconds: 0, memory_bytes: 42_500_000, peers: 12 },
          }
          emit("node", `Node initialized (committee=${committee}, threshold=${threshold})`, "success")
          return { ok: true, message: `node initialized (committee=${committee}, threshold=${threshold})` }
        }
        case "node_reset": {
          if (s.node) {
            s.node.accounts = []
            s.node.blocks = []
            s.node.quorum_certs = []
            s.node.metrics = { total_payments: 0, avg_latency_ms: 0, last_latency_ms: 0, throughput_tps: 0, uptime_seconds: 0, memory_bytes: 42_500_000, peers: 12 }
          }
          emit("node", "Node reset", "info")
          return { ok: true, message: "node reset" }
        }
        case "node_register": {
          const [acct, balanceStr] = args
          if (!acct || !balanceStr) return { ok: false, message: "usage: node_register <acct> <balance>" }
          if (!s.node) return { ok: false, message: "node not initialized" }
          const bal = parseFloat(balanceStr)
          if (s.node.accounts.some(a => a.id === acct)) return { ok: false, message: `${acct} already registered` }
          s.node.accounts.push({
            id: acct, balance_aeq: bal, head_hash: "0x" + "0".repeat(64), nonce: 0,
          })
          emit("node", `Registered ${acct} with ${fmt2(bal)}`, "success")
          return { ok: true, message: `registered ${acct} with ${fmt2(bal)}` }
        }
        case "node_pay": {
          const [from, to, amountStr] = args
          if (!from || !to || !amountStr) return { ok: false, message: "usage: node_pay <from> <to> <amount>" }
          const amount = parseFloat(amountStr)
          if (!s.node) return { ok: false, message: "node not initialized" }
          const f = s.node.accounts.find(a => a.id === from)
          const t = s.node.accounts.find(a => a.id === to)
          if (!f || !t) return { ok: false, message: `no such account` }
          if (f.balance_aeq < amount) return { ok: false, message: "insufficient balance" }
          f.balance_aeq = cents(f.balance_aeq - amount); f.nonce++
          t.balance_aeq = cents(t.balance_aeq + amount)
          const block: BlockV2 = {
            index: s.node.blocks.length,
            hash: "0x" + rng.hex(64),
            prev_hash: s.node.blocks.at(-1)?.hash ?? "0x" + "0".repeat(64),
            timestamp: new Date(now).toISOString(),
            tx_count: 1,
            validator: `committee#${s.node.blocks.length % s.node.config.committee_size}`,
            state_root: "0x" + rng.hex(64),
          }
          s.node.blocks.push(block)
          s.node.quorum_certs.push({ block_hash: block.hash, committee_id: `cmt#${block.index}`, signatures: s.node.config.threshold, threshold: s.node.config.threshold })
          s.node.state_root_hex = block.state_root
          if (s.node.metrics) {
            s.node.metrics.total_payments++
            s.node.metrics.last_latency_ms = 12 + rng.int(30)
            s.node.metrics.avg_latency_ms = cents((s.node.metrics.avg_latency_ms * (s.node.metrics.total_payments - 1) + s.node.metrics.last_latency_ms) / s.node.metrics.total_payments)
            s.node.metrics.uptime_seconds = Math.floor((now - (now - 3_600_000)) / 1000)
            s.node.metrics.throughput_tps = cents(s.node.metrics.total_payments / Math.max(1, s.node.metrics.uptime_seconds))
          }
          s.blockHeight++
          s.volume.totalAeq = cents(s.volume.totalAeq + amount)
          s.volume.byKind.set("transfers", cents((s.volume.byKind.get("transfers") ?? 0) + amount))
          s.volume.txCount24h++
          s.volume.totalFeesAeq = cents(s.volume.totalFeesAeq + amount * 0.001)
          s.volume.tpsWindow.push(now)
          emit("node", `Paid ${from} → ${to}: ${fmt2(amount)}`, "success", [{ k: "from", v: from }, { k: "to", v: to }, { k: "amount", v: fmt2(amount) }])
          return { ok: true, message: `paid ${from} → ${to}: ${fmt2(amount)}` }
        }
        case "node_status": {
          if (!s.node) return { ok: false, message: "node not initialized" }
          const n = s.node
          return { ok: true, message: `${n.accounts.length} accounts | ${n.blocks.length} blocks | ${n.quorum_certs.length} QCs | ${n.metrics?.throughput_tps ?? 0} tps` }
        }

        // Consensus
        case "equality_check": {
          if (!s.equality) return { ok: false, message: "equality report not available" }
          const r = s.equality
          return { ok: true, message: r.all_passed ? `equality holds for all ${r.total_members} members (variance ${r.variance})` : "equality violated" }
        }
        case "consensus_test": {
          if (!s.consensus) return { ok: false, message: "consensus test not available" }
          const c = s.consensus
          return { ok: true, message: c.passed ? `consensus test passed (round ${c.round}, ${c.validators} validators)` : "consensus test failed" }
        }

        // Global
        case "demo":
        case "reset": {
          // Re-seed to genesis; preserve the heartbeat emit callback.
          const savedEmit = s.emit
          const savedTimer = s.hbTimer
          this.rng = new SeededRNG(42)
          this.state = this.initialState()
          this.state.emit = savedEmit
          this.state.hbTimer = savedTimer
          const label = command.toLowerCase() === "demo" ? "Demo scenario replayed" : "State reset to demo defaults"
          pushActivity(this.state, { ts: new Date(this.now()).toISOString(), level: "success", tag: command.toLowerCase(), message: label, fields: [] })
          return { ok: true, message: label.toLowerCase() }
        }
        case "status": {
          return { ok: true, message: `${s.members.size} members | ${s.networks.size} networks | ${s.businesses.size} businesses | ${s.pledges.size} pledges` }
        }
        default:
          return { ok: false, message: `unknown command: ${command}` }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      emit("error", `command error: ${msg}`, "error")
      return { ok: false, message: msg }
    }
  }
}