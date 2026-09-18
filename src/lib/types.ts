/**
 * aequdash — src/lib/types.ts
 *
 * Data contract for aequchain TUI v2. Every rendered value on every screen
 * traces to a field in this file. Two classes of data:
 *
 *   1. Working-set records — fully interactive members, networks, businesses,
 *      pledges, blocks. Commands mutate these.
 *   2. Network-wide aggregates — summary statistics (registered totals,
 *      distributions, success rates) that a dashboard legitimately reports
 *      without shipping 14k rows over the wire. Computed from state by the
 *      backend (simulator or Julia bridge), never hardcoded by the UI.
 *
 * Money is carried as numbers quantized to 2dp at the state boundary.
 * The bridge tolerates Julia's Rational strings ("n/d") via num().
 */

// ─────────────────────────────────────────────────────────────────────────────
// Screens & status
// ─────────────────────────────────────────────────────────────────────────────

export type ScreenId =
  | "dashboard"
  | "identity"
  | "networks"
  | "businesses"
  | "pledges"
  | "node"
  | "consensus"
  | "console"

export const SCREEN_ORDER: ScreenId[] = [
  "dashboard", "identity", "networks", "businesses",
  "pledges", "node", "consensus", "console",
]

export const SCREEN_TITLES: Record<ScreenId, string> = {
  dashboard:  "Dashboard",
  identity:   "Identity",
  networks:   "Networks",
  businesses: "Businesses",
  pledges:    "Pledges",
  node:       "Node",
  consensus:  "Consensus",
  console:    "Console",
}

export type BridgeStatus =
  | "starting"
  | "compiling"
  | "ready"        // JULIA LIVE
  | "simulating"   // SIMULATION
  | "error"
  | "stopped"

// ─────────────────────────────────────────────────────────────────────────────
// Treasury
// ─────────────────────────────────────────────────────────────────────────────

export interface TreasuryHolding {
  denom: string       // "AEQ" | "USDC" | "ETH" | "BTC" | "Other"
  amount_aeq: number  // value in AEQ terms
  is_native: boolean
}

export interface TreasuryV2 {
  total_aeq: number
  total_usd: number
  currency: string          // display currency, "USD"
  network_denom: string     // "AEQ"
  aeq_usd_rate: number
  total_supply: number      // AEQ
  circulating_supply: number
  holdings: TreasuryHolding[]
  last_updated: string      // ISO
}

// ─────────────────────────────────────────────────────────────────────────────
// Members
// ─────────────────────────────────────────────────────────────────────────────

export type MemberStatus = "active" | "pending" | "suspended"

export interface MemberV2 {
  id: string
  value_aeq: number
  status: MemberStatus
  region: string
  reputation: number          // 0..100
  networks: string[]
  businesses: string[]
  spend_used_30d_aeq: number
  spend_allowance_30d_aeq: number
  joined_at: string
}

export interface DistributionBucket {
  label: string
  count: number
  pct: number                 // 0..100
}

export interface MembersSummary {
  total_registered: number
  active_24h: number
  pending: number
  suspended: number
  distribution: DistributionBucket[]   // by region
}

// ─────────────────────────────────────────────────────────────────────────────
// Networks & businesses
// ─────────────────────────────────────────────────────────────────────────────

export interface NetworkV2 {
  id: string
  name: string
  denom: string
  peg_rate: number
  members: number             // member count
  value_aeq: number           // value circulating in this network
  created_at: string
}

export interface BusinessV2 {
  id: string
  name: string
  owner: string
  net_id: string
  contribution_rate: number   // 0..0.05
  employees: number
  treasury_allocation_aeq: number
  thirty_day_used_aeq: number
  created_at: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Pledges
// ─────────────────────────────────────────────────────────────────────────────

export type PledgeStatus = "in_progress" | "completed" | "failed"

export interface PledgeV2 {
  id: string                  // short hex, e.g. "7f3a2e"
  name: string
  category: string            // Infrastructure | Social | Environment | Education | Health | Other
  target_aeq: number
  raised_aeq: number
  status: PledgeStatus
  creator: string
  supporters: { member: string; amount_aeq: number }[]
  purpose: string
  created_at: string
  duration_days: number
}

export interface PledgesSummary {
  total: number
  in_progress: number
  completed: number
  failed: number
  total_value_aeq: number
  avg_duration_days: number
  success_rate: number        // 0..100
  distribution: DistributionBucket[]  // by category
}

// ─────────────────────────────────────────────────────────────────────────────
// Volume / network activity
// ─────────────────────────────────────────────────────────────────────────────

export type VolumeKind = "transfers" | "pledges" | "contracts" | "other"

export interface VolumeBucket {
  kind: VolumeKind
  amount_aeq: number
  pct: number
}

export interface VolumeSummary {
  total_aeq: number
  total_usd: number
  breakdown: VolumeBucket[]
  tx_count_24h: number
  avg_fee_aeq: number
  block_height: number
  tps_1m: number              // live 1-minute window rate
}

// ─────────────────────────────────────────────────────────────────────────────
// Spend limit
// ─────────────────────────────────────────────────────────────────────────────

export interface SpendSummary {
  limit_aeq: number
  limit_usd: number
  used_aeq: number
  used_usd: number
  remaining_aeq: number
  remaining_usd: number
  used_pct: number            // 0..100
  daily_avg_aeq: number
  projected_30d_aeq: number
  window_days: number
  days_elapsed: number
  reset_at: string            // ISO
  policy: string              // "Equidistributed"
  max_per_member_aeq: number
  network_denom: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Personal (current user)
// ─────────────────────────────────────────────────────────────────────────────

export interface PledgeProgress {
  id: string
  pct: number                 // 0..100
  raised_aeq: number
  target_aeq: number
}

export interface PersonalSummary {
  member_id: string           // "" when logged out
  value_aeq: number
  value_usd: number
  share_pct: number           // % of treasury
  active_pledges: number
  reputation: number          // 0..100
  pledge_progress: PledgeProgress[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Activity feed — structured live events
// ─────────────────────────────────────────────────────────────────────────────

export type ActivityLevel = "info" | "warn" | "error" | "success" | "debug"

export interface ActivityEvent {
  ts: string                  // ISO
  level: ActivityLevel
  tag: string                 // node_init | equality_check | pledge_update | ...
  message: string
  fields: { k: string; v: string }[]   // key=value pairs, right column
}

// ─────────────────────────────────────────────────────────────────────────────
// Node / consensus (ephemeral testnet)
// ─────────────────────────────────────────────────────────────────────────────

export interface NodeAccount {
  id: string
  balance_aeq: number
  head_hash: string
  nonce: number
}

export interface BlockV2 {
  index: number
  hash: string
  prev_hash: string
  timestamp: string
  tx_count: number
  validator: string
  state_root: string
}

export interface QuorumCert {
  block_hash: string
  committee_id: string
  signatures: number
  threshold: number
}

export interface NodeMetrics {
  total_payments: number
  avg_latency_ms: number
  last_latency_ms: number
  throughput_tps: number
  uptime_seconds: number
  memory_bytes: number
  peers: number
}

export interface TestnetNodeV2 {
  running: boolean
  label: string               // "aeqnode-01"
  version: string             // "0.8.4"
  config: { committee_size: number; threshold: number; epoch_seed: string }
  accounts: NodeAccount[]
  blocks: BlockV2[]
  quorum_certs: QuorumCert[]
  state_root_hex: string
  metrics: NodeMetrics | null
}

export interface EqualityReportV2 {
  all_passed: boolean
  total_members: number
  treasury_value_aeq: number
  expected_member_value_aeq: number
  variance: number
  threshold: number
  checks: { member_id: string; actual: number; expected: number; passed: boolean }[]
  duration_ms: number
}

export interface ConsensusTestV2 {
  committee_size: number
  threshold: number
  byzantine: number
  round: number
  validators: number
  payments_sent: number
  payments_confirmed: number
  avg_latency_ms: number
  state_root_hex: string
  passed: boolean
  notes: string[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot — the single payload every screen renders from
// ─────────────────────────────────────────────────────────────────────────────

export interface SnapshotV2 {
  ready: boolean
  network: string             // "testnet"
  block_height: number
  server_time: string         // ISO — backend clock (frozen under snapshot mode)
  current_user: string
  treasury: TreasuryV2 | null
  member_value_aeq: number
  members_summary: MembersSummary | null
  members: MemberV2[]                  // working set (interactive)
  networks: NetworkV2[]
  businesses: BusinessV2[]
  pledges: PledgeV2[]                  // working set (interactive)
  pledges_summary: PledgesSummary | null
  volume: VolumeSummary | null
  spend: SpendSummary | null
  personal: PersonalSummary | null
  node: TestnetNodeV2 | null
  equality: EqualityReportV2 | null
  consensus: ConsensusTestV2 | null
  activity: ActivityEvent[]            // structured live feed (newest last)
  /** false when the backend is v1 Julia and v2 aggregates were derived locally. */
  full_fidelity: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

export interface CommandDef {
  name: string
  aliases?: string[]
  args: { name: string; required?: boolean; description: string }[]
  description: string
  screen?: ScreenId
}

export interface CommandResult {
  ok: boolean
  message: string
  snapshot?: SnapshotV2
}

/** Tolerate both numeric and Rational-string ("n/d") values from the bridge. */
export function num(v: number | string | undefined | null): number {
  if (v === undefined || v === null) return 0
  if (typeof v === "number") return isFinite(v) ? v : 0
  const parts = v.split("/")
  const n = Number(parts[0])
  const d = parts.length > 1 ? Number(parts[1]) : 1
  if (!isFinite(n) || !isFinite(d) || d === 0) return 0
  return n / d
}

/** Quantize to cents — the state boundary's canonical money precision. */
export function cents(n: number): number {
  return Math.round(n * 100) / 100
}
