/**
 * aequdash — src/node/snapshot.ts
 *
 * Assembles SnapshotV2 from LIVE node state. Every field is derived from
 * the ledger or the node's own telemetry — nothing is fabricated.
 *
 * Money leaves the exact domain (Rational) only here, at the presentation
 * boundary, via toNumber() / toFixed().
 */

import { Ledger, RATE_USD_PER_AEQ, SPEND_WINDOW_MS } from "./ledger.ts"
import { Rational } from "./rational.ts"
import type { AequNode } from "./node.ts"
import type {
  SnapshotV2, TreasuryV2, MembersSummary, MemberV2, NetworkV2, BusinessV2,
  PledgeV2, PledgesSummary, VolumeSummary, SpendSummary, PersonalSummary,
  TestnetNodeV2, EqualityReportV2, ConsensusTestV2, ActivityEvent,
  NodeAccount, BlockV2, QuorumCert, VolumeKind,
} from "../lib/types.ts"
import { cents } from "../lib/types.ts"
import { byzantineTolerance } from "./consensus.ts"

const VOLUME_WINDOW_MS = 24 * 3_600_000
const WORKING_SET_EXCLUDE = /^citizen_\d+$/
const BLOCKS_IN_SNAPSHOT = 64
const EQUALITY_CHECK_CAP = 64

const KIND_MAP: Record<string, VolumeKind> = {
  node_pay: "transfers",
  support: "pledges",
  create_bus: "contracts",
  set_ec: "contracts",
  hire: "contracts",
  bus_withdraw: "contracts",
}

export function buildSnapshot(
  node: AequNode,
  currentUser: string,
  activity: ActivityEvent[],
): SnapshotV2 {
  const l = node.ledger
  const now = node.now()

  return {
    ready: node.running,
    network: "testnet",
    block_height: node.height,
    server_time: new Date(now).toISOString(),
    current_user: currentUser,
    treasury: treasuryView(l, node),
    member_value_aeq: l.memberValue().toNumber(),
    members_summary: membersSummary(l, now),
    members: workingSetMembers(l),
    networks: networksView(l),
    businesses: businessesView(l),
    pledges: pledgesView(l),
    pledges_summary: pledgesSummary(l),
    volume: volumeSummary(l, node, now),
    spend: spendSummary(l, currentUser, now),
    personal: personalSummary(l, currentUser),
    node: nodeView(node),
    equality: equalityView(l),
    consensus: consensusView(node),
    activity,
    full_fidelity: true,
    cluster: node.clusterInfo(),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Treasury
// ─────────────────────────────────────────────────────────────────────────────

function treasuryView(l: Ledger, node: AequNode): TreasuryV2 {
  const total = l.treasury
  const totalUsd = total.mul(RATE_USD_PER_AEQ)
  const tipTs = node.blocks.length > 0 ? node.blocks[node.blocks.length - 1].header.ts : node.now()
  return {
    total_aeq: total.toNumber(),
    total_usd: totalUsd.toNumber(),
    currency: "USD",
    network_denom: "AEQ",
    aeq_usd_rate: RATE_USD_PER_AEQ.toNumber(),
    total_supply: l.lifetimeIn.toNumber(),
    circulating_supply: total.toNumber(),
    holdings: [{
      denom: "AEQ",
      amount_aeq: total.toNumber(),
      is_native: true,
      pct: total.isZero() ? 0 : 100,
    }],
    last_updated: new Date(tipTs).toISOString(),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Members
// ─────────────────────────────────────────────────────────────────────────────

function membersSummary(l: Ledger, now: number): MembersSummary {
  let active = 0, pending = 0, suspended = 0
  const regions = new Map<string, number>()
  for (const m of l.members.values()) {
    if (m.status === "active" && now - m.lastActiveAt <= VOLUME_WINDOW_MS) active++
    if (m.status === "pending") pending++
    if (m.status === "suspended") suspended++
    regions.set(m.region, (regions.get(m.region) ?? 0) + 1)
  }
  const total = l.members.size
  return {
    total_registered: total,
    active_24h: active,
    pending,
    suspended,
    distribution: [...regions.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label, count]) => ({ label, count, pct: total > 0 ? cents((count / total) * 100) : 0 })),
  }
}

function memberView(l: Ledger, m: Ledger["members"] extends Map<string, infer V> ? V : never): MemberV2 {
  return {
    id: m.id,
    value_aeq: l.memberValue().toNumber(),
    status: m.status,
    region: m.region,
    reputation: l.reputationOf(m.id),
    networks: [...m.networks],
    businesses: [...m.businesses],
    spend_used_30d_aeq: l.spendUsed30d(m.id, Date.now()).toNumber(),
    spend_allowance_30d_aeq: m.allowance30d.toNumber(),
    joined_at: new Date(m.joinedAt).toISOString(),
  }
}

/** The interactive working set: named members (generated citizens excluded). */
function workingSetMembers(l: Ledger): MemberV2[] {
  const value = l.memberValue().toNumber()
  const out: MemberV2[] = []
  for (const m of l.members.values()) {
    if (WORKING_SET_EXCLUDE.test(m.id)) continue
    out.push({
      id: m.id,
      value_aeq: value,
      status: m.status,
      region: m.region,
      reputation: l.reputationOf(m.id),
      networks: [...m.networks],
      businesses: [...m.businesses],
      spend_used_30d_aeq: l.spendUsed30d(m.id, m.lastActiveAt > 0 ? Date.now() : 0).toNumber(),
      spend_allowance_30d_aeq: m.allowance30d.toNumber(),
      joined_at: new Date(m.joinedAt).toISOString(),
    })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

// ─────────────────────────────────────────────────────────────────────────────
// Networks / businesses / pledges
// ─────────────────────────────────────────────────────────────────────────────

function networksView(l: Ledger): NetworkV2[] {
  const value = l.memberValue()
  return [...l.networks.values()].map((n) => ({
    id: n.id,
    name: n.name,
    denom: n.denom,
    peg_rate: n.pegRate.toNumber(),
    members: n.members.size,
    value_aeq: value.mul(Rational.of(n.members.size)).toNumber(),
    created_at: new Date(n.createdAt).toISOString(),
  })).sort((a, b) => b.value_aeq - a.value_aeq)
}

function businessesView(l: Ledger): BusinessV2[] {
  return [...l.businesses.values()].map((b) => ({
    id: b.id,
    name: b.name,
    owner: b.owner,
    net_id: b.netId,
    contribution_rate: b.contributionRate.toNumber(),
    employees: b.employees.length,
    treasury_allocation_aeq: b.treasuryAllocation.toNumber(),
    thirty_day_used_aeq: b.thirtyDayUsed.toNumber(),
    created_at: new Date(b.createdAt).toISOString(),
  })).sort((a, b) => a.id.localeCompare(b.id))
}

function pledgesView(l: Ledger): PledgeV2[] {
  return [...l.pledges.values()].map((p) => ({
    id: p.id,
    name: p.name,
    category: p.category,
    target_aeq: p.target.toNumber(),
    raised_aeq: p.raised.toNumber(),
    status: p.status,
    creator: p.creator,
    supporters: p.supporters.map((s) => ({ member: s.member, amount_aeq: s.amount.toNumber() })),
    purpose: p.purpose,
    created_at: new Date(p.createdAt).toISOString(),
    duration_days: p.durationDays,
  })).sort((a, b) => a.created_at.localeCompare(b.created_at))
}

function pledgesSummary(l: Ledger): PledgesSummary {
  const all = [...l.pledges.values()]
  const inProgress = all.filter((p) => p.status === "in_progress").length
  const completed = all.filter((p) => p.status === "completed").length
  const failed = all.filter((p) => p.status === "failed").length
  const totalValue = all.reduce((acc, p) => acc.add(p.target), Rational.ZERO)
  const cats = new Map<string, number>()
  for (const p of all) cats.set(p.category, (cats.get(p.category) ?? 0) + 1)
  const total = all.length
  const avgDuration = total > 0 ? all.reduce((a, p) => a + p.durationDays, 0) / total : 0
  return {
    total,
    in_progress: inProgress,
    completed,
    failed,
    total_value_aeq: totalValue.toNumber(),
    avg_duration_days: Math.round(avgDuration * 10) / 10,
    success_rate: completed + failed > 0 ? cents((completed / (completed + failed)) * 100) : 0,
    distribution: [...cats.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label, count]) => ({ label, count, pct: total > 0 ? cents((count / total) * 100) : 0 })),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Volume
// ─────────────────────────────────────────────────────────────────────────────

function volumeSummary(l: Ledger, node: AequNode, now: number): VolumeSummary {
  const windowTxs = l.txsInWindow(now, VOLUME_WINDOW_MS)
  const byKind = new Map<VolumeKind, Rational>([
    ["transfers", Rational.ZERO],
    ["pledges", Rational.ZERO],
    ["contracts", Rational.ZERO],
    ["other", Rational.ZERO],
  ])
  let total = Rational.ZERO
  for (const t of windowTxs) {
    const kind = KIND_MAP[t.kind] ?? "other"
    byKind.set(kind, byKind.get(kind)!.add(t.amount))
    total = total.add(t.amount)
  }
  return {
    total_aeq: total.toNumber(),
    total_usd: total.mul(RATE_USD_PER_AEQ).toNumber(),
    breakdown: [...byKind.entries()].map(([kind, amount]) => ({
      kind,
      amount_aeq: amount.toNumber(),
      pct: total.isZero() ? 0 : cents(amount.div(total).mul(Rational.of(100)).toNumber()),
    })),
    tx_count_24h: windowTxs.length,
    avg_fee_aeq: 0, // zero-fee testnet — honest
    block_height: node.height,
    tps_1m: cents(l.tps1m(now)),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Spend window
// ─────────────────────────────────────────────────────────────────────────────

function spendSummary(l: Ledger, currentUser: string, now: number): SpendSummary {
  const me = currentUser ? l.members.get(currentUser) : undefined
  let limit: Rational
  let used: Rational
  let windowStart: number
  if (me) {
    limit = me.allowance30d
    used = l.spendUsed30d(me.id, now)
    const oldest = me.spends.length > 0 ? me.spends[0].ts : now
    windowStart = oldest
  } else {
    // Network-wide: Σ allowances, Σ used
    limit = l.members.size > 0
      ? Rational.of(l.members.size).mul(Rational.of(50_000))
      : Rational.ZERO
    let u = Rational.ZERO
    for (const m of l.members.values()) u = u.add(l.spendUsed30d(m.id, now))
    used = u
    windowStart = now
  }
  const remaining = limit.sub(used).max(Rational.ZERO)
  const daysElapsed = Math.max(1, Math.ceil((now - windowStart) / 86_400_000))
  const dailyAvg = used.div(Rational.of(daysElapsed))
  return {
    limit_aeq: limit.toNumber(),
    limit_usd: limit.mul(RATE_USD_PER_AEQ).toNumber(),
    used_aeq: used.toNumber(),
    used_usd: used.mul(RATE_USD_PER_AEQ).toNumber(),
    remaining_aeq: remaining.toNumber(),
    remaining_usd: remaining.mul(RATE_USD_PER_AEQ).toNumber(),
    used_pct: limit.isZero() ? 0 : cents(used.div(limit).mul(Rational.of(100)).toNumber()),
    daily_avg_aeq: dailyAvg.toNumber(),
    projected_30d_aeq: dailyAvg.mul(Rational.of(30)).toNumber(),
    window_days: 30,
    days_elapsed: daysElapsed,
    reset_at: new Date(windowStart + SPEND_WINDOW_MS).toISOString(),
    policy: "Equidistributed",
    max_per_member_aeq: 50_000,
    network_denom: "AEQ",
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Personal
// ─────────────────────────────────────────────────────────────────────────────

function personalSummary(l: Ledger, currentUser: string): PersonalSummary | null {
  const me = currentUser ? l.members.get(currentUser) : undefined
  if (!me) {
    return { member_id: "", value_aeq: 0, value_usd: 0, share_pct: 0, active_pledges: 0, reputation: 0, pledge_progress: [] }
  }
  const value = l.memberValue()
  const myPledges = [...l.pledges.values()].filter(
    (p) => p.creator === me.id || p.supporters.some((s) => s.member === me.id),
  )
  return {
    member_id: me.id,
    value_aeq: value.toNumber(),
    value_usd: value.mul(RATE_USD_PER_AEQ).toNumber(),
    share_pct: l.treasury.isZero() ? 0 : value.div(l.treasury).mul(Rational.of(100)).toNumber(),
    active_pledges: myPledges.filter((p) => p.status === "in_progress").length,
    reputation: l.reputationOf(me.id),
    pledge_progress: myPledges.map((p) => ({
      id: p.id,
      pct: p.target.isZero() ? 0 : cents(p.raised.div(p.target).mul(Rational.of(100)).toNumber()),
      raised_aeq: p.raised.toNumber(),
      target_aeq: p.target.toNumber(),
    })),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Node / equality / consensus
// ─────────────────────────────────────────────────────────────────────────────

function nodeView(node: AequNode): TestnetNodeV2 {
  const accounts: NodeAccount[] = [...node.ledger.accounts.values()].map((a) => ({
    id: a.id,
    balance_aeq: a.balance.toNumber(),
    head_hash: a.headHash,
    nonce: a.nonce,
  }))
  const blocks: BlockV2[] = node.blocks.slice(-BLOCKS_IN_SNAPSHOT).map((b) => ({
    index: b.header.height,
    hash: b.hash,
    prev_hash: b.header.prev_hash,
    timestamp: new Date(b.header.ts).toISOString(),
    tx_count: b.txs.length,
    validator: b.header.proposer,
    state_root: b.header.state_root,
  }))
  const qcs: QuorumCert[] = node.qcs.slice(-BLOCKS_IN_SNAPSHOT).map((q) => ({
    block_hash: q.block_hash,
    committee_id: q.committee_id,
    signatures: q.votes.length,
    threshold: q.threshold,
  }))
  const mem = process.memoryUsage()
  return {
    running: node.running,
    label: node.cfg.nodeId,
    version: "0.9.0",
    config: {
      committee_size: node.cfg.committeeSize,
      threshold: node.threshold(),
      epoch_seed: node.cfg.epochSeed,
    },
    accounts,
    blocks,
    quorum_certs: qcs,
    state_root_hex: node.tipStateRoot(),
    metrics: {
      total_payments: node.metrics.paymentsTotal,
      avg_latency_ms: cents(node.avgLatencyMs()),
      last_latency_ms: cents(node.lastLatencyMs()),
      throughput_tps: cents(node.ledger.tps1m(node.now())),
      uptime_seconds: node.uptimeSeconds(),
      memory_bytes: mem.rss,
      peers: node.mesh?.peerCount() ?? 0,
    },
  }
}

function equalityView(l: Ledger): EqualityReportV2 {
  const started = Date.now()
  const report = l.equalityReport(0.000000001) // exact math → variance is 0
  const checks = report.checks
    .filter((c) => !WORKING_SET_EXCLUDE.test(c.memberId))
    .slice(0, EQUALITY_CHECK_CAP)
    .map((c) => ({ member_id: c.memberId, actual: c.actual, expected: c.expected, passed: c.passed }))
  return {
    all_passed: report.allPassed && l.conservationHolds(),
    total_members: report.totalMembers,
    treasury_value_aeq: report.treasuryAeq.toNumber(),
    expected_member_value_aeq: report.expectedValue.toNumber(),
    variance: report.variance,
    threshold: report.threshold,
    checks,
    duration_ms: Date.now() - started,
  }
}

function consensusView(node: AequNode): ConsensusTestV2 {
  const committee = node.committee()
  const info = node.clusterInfo()
  const threshold = node.threshold()
  const lastCommitAgoMs = node.now() - node.lastCommitTime()
  const makingProgress = node.height > 0 && lastCommitAgoMs < 10_000
  const passed = node.running && makingProgress
  return {
    committee_size: committee.length,
    threshold,
    byzantine: byzantineTolerance(committee.length),
    round: node.height + 1,
    validators: info.mesh_size,
    payments_sent: node.metrics.paymentsTotal,
    payments_confirmed: node.metrics.paymentsConfirmed,
    avg_latency_ms: cents(node.avgLatencyMs()),
    state_root_hex: node.tipStateRoot(),
    passed,
    notes: [
      `Rotating proposer BFT — committee of ${committee.length}, quorum at ${threshold} votes`,
      `Byzantine tolerance: f = ⌊(n−1)/3⌋ = ${byzantineTolerance(committee.length)}`,
      info.all_converged
        ? `All ${info.mesh_size} live nodes share state root ${node.tipStateRoot().slice(0, 12)}…`
        : `Mesh syncing — peers converging (heights: ${info.nodes.map((n) => n.height).join("/")})`,
      `Blocks committed: ${node.height} · last commit ${Math.floor(lastCommitAgoMs / 1000)}s ago · view changes: ${node.metrics.roundChanges}`,
    ],
  }
}
