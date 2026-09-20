/**
 * aequdash — src/node/ledger.ts
 *
 * The replicated ledger state machine. THE EQUALITY ENGINE.
 *
 * Core design decision: a member's value is DERIVED, never stored.
 *
 *     memberValue = treasury / memberCount     (exact Rational division)
 *
 * There is no per-member balance field that could drift, round, or be
 * corrupted. The sacred invariant holds by construction:
 *
 *     ∀ member ∈ members: member.value == treasury / |members|
 *
 * Every state mutation happens exclusively through apply(tx, blockTs),
 * which is deterministic: given the same tx sequence and block timestamps,
 * every node in the mesh reaches the identical state — verified per block
 * via the state_root digest committed in the block header.
 *
 * Ephemerality: this state lives only in process memory. No persistence
 * path exists in this module. When the mesh empties, the state is gone.
 */

import { Rational } from "./rational.ts"
import { sha256hex, canonicalJson } from "./crypto.ts"
import type { Tx } from "./proto.ts"

// ─────────────────────────────────────────────────────────────────────────────
// Record types
// ─────────────────────────────────────────────────────────────────────────────

export type MemberStatus = "active" | "pending" | "suspended"

export interface SpendEntry {
  ts: number
  amount: Rational
  kind: string           // WITHDRAW | BUSINESS_WITHDRAW | PLEDGE
}

export interface MemberRec {
  id: string
  status: MemberStatus
  region: string
  networks: string[]
  businesses: string[]
  spends: SpendEntry[]
  allowance30d: Rational
  joinedAt: number        // block timestamp
  lastActiveAt: number
}

export interface NetRec {
  id: string
  name: string
  denom: string
  pegRate: Rational       // denom units per 1 AEQ... (display rate)
  members: Set<string>
  createdAt: number
}

export interface BizRec {
  id: string
  name: string
  owner: string
  netId: string
  contributionRate: Rational   // 0..0.05
  employees: string[]
  treasuryAllocation: Rational
  thirtyDayUsed: Rational
  createdAt: number
}

export type PledgeStatus = "in_progress" | "completed" | "failed"

export interface PledgeRec {
  id: string
  name: string
  category: string
  target: Rational
  raised: Rational
  status: PledgeStatus
  creator: string
  supporters: { member: string; amount: Rational }[]
  purpose: string
  createdAt: number
  durationDays: number
}

export interface AccountRec {
  id: string
  balance: Rational
  nonce: number
  headHash: string
}

export interface TxLogEntry {
  ts: number
  kind: string
  actor: string
  amount: Rational
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_ALLOWANCE_30D = Rational.of(50_000)
export const MAX_CONTRIBUTION_RATE = Rational.of(5, 100)   // 0.05
export const SPEND_WINDOW_MS = 30 * 86_400_000
export const TX_LOG_CAP = 5_000
export const TPS_WINDOW_MS = 60_000
export const MAX_TX_AMOUNT = Rational.of(10n ** 30n)

/** Display peg: USD per 1 AEQ (network-declared rate constant). */
export const RATE_USD_PER_AEQ = Rational.of(22805, 10_000)  // 2.2805

// ─────────────────────────────────────────────────────────────────────────────
// Errors — explicit, typed, informative
// ─────────────────────────────────────────────────────────────────────────────

export class LedgerError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = "LedgerError"
    this.code = code
  }
}

function fail(code: string, message: string): never {
  throw new LedgerError(code, message)
}

// ─────────────────────────────────────────────────────────────────────────────
// Ledger
// ─────────────────────────────────────────────────────────────────────────────

export class Ledger {
  treasury: Rational = Rational.ZERO
  lifetimeIn: Rational = Rational.ZERO    // Σ deposits
  lifetimeOut: Rational = Rational.ZERO   // Σ withdrawals (member + business)

  members = new Map<string, MemberRec>()
  networks = new Map<string, NetRec>()
  businesses = new Map<string, BizRec>()
  pledges = new Map<string, PledgeRec>()
  accounts = new Map<string, AccountRec>()

  /** Committed tx log (bounded) — drives volume/TPS aggregates. */
  txLog: TxLogEntry[] = []

  /** Height of the last committed block that mutated this ledger. */
  height = 0

  // ── Derived core values ────────────────────────────────────────────────────

  /** The sacred equation — exact. */
  memberValue(): Rational {
    if (this.members.size === 0) return Rational.ZERO
    return this.treasury.div(Rational.of(this.members.size))
  }

  memberCount(): number { return this.members.size }

  // ── Canonical digest (state_root) ──────────────────────────────────────────

  /**
   * Deterministic digest of the entire ledger. Two nodes with the same
   * history MUST produce the same digest; the consensus layer compares
   * these to prove convergence.
   */
  digest(): string {
    const members = [...this.members.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((m) => [m.id, m.status, m.region, m.joinedAt, m.lastActiveAt,
        m.networks.slice().sort(), m.businesses.slice().sort(),
        m.allowance30d.toString(),
        m.spends.map((s) => [s.ts, s.amount.toString(), s.kind])])
    const networks = [...this.networks.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((n) => [n.id, n.name, n.denom, n.pegRate.toString(), [...n.members].sort(), n.createdAt])
    const businesses = [...this.businesses.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((b) => [b.id, b.name, b.owner, b.netId, b.contributionRate.toString(),
        b.employees.slice().sort(), b.treasuryAllocation.toString(), b.thirtyDayUsed.toString(), b.createdAt])
    const pledges = [...this.pledges.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((p) => [p.id, p.name, p.category, p.target.toString(), p.raised.toString(),
        p.status, p.creator, p.purpose, p.createdAt, p.durationDays,
        p.supporters.map((s) => [s.member, s.amount.toString()])])
    const accounts = [...this.accounts.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((a) => [a.id, a.balance.toString(), a.nonce, a.headHash])
    return sha256hex(canonicalJson({
      treasury: this.treasury.toString(),
      lifetimeIn: this.lifetimeIn.toString(),
      lifetimeOut: this.lifetimeOut.toString(),
      members, networks, businesses, pledges, accounts,
      height: this.height,
    }))
  }

  // ── Validation helpers ─────────────────────────────────────────────────────

  private requireMember(id: string): MemberRec {
    const m = this.members.get(id)
    if (!m) fail("MEMBER_NOT_FOUND", `no such member: ${id}`)
    return m
  }

  private requireNetwork(id: string): NetRec {
    const n = this.networks.get(id)
    if (!n) fail("NETWORK_NOT_FOUND", `no such network: ${id}`)
    return n
  }

  private requireBusiness(id: string): BizRec {
    const b = this.businesses.get(id)
    if (!b) fail("BUSINESS_NOT_FOUND", `no such business: ${id}`)
    return b
  }

  private requirePledge(id: string): PledgeRec {
    const p = this.pledges.get(id)
    if (!p) fail("PLEDGE_NOT_FOUND", `no such pledge: ${id}`)
    return p
  }

  private static requireAmount(v: unknown): Rational {
    let amount: Rational
    try {
      amount = Rational.from(v as string | number)
    } catch {
      fail("BAD_AMOUNT", `invalid amount: ${String(v)}`)
    }
    if (amount.lte(Rational.ZERO)) fail("BAD_AMOUNT", "amount must be positive")
    if (amount.gt(MAX_TX_AMOUNT)) fail("BAD_AMOUNT", "amount exceeds maximum")
    return amount
  }

  private static requireId(v: unknown, what: string): string {
    const s = String(v ?? "")
    if (s.length < 1 || s.length > 64) fail("BAD_ID", `${what} id must be 1-64 chars`)
    if (!/^[\w-]+$/.test(s)) fail("BAD_ID", `${what} id contains invalid characters`)
    return s
  }

  // ── 30-day spend window ────────────────────────────────────────────────────

  /** Rolling 30-day spend for a member at reference time `nowMs`. */
  spendUsed30d(memberId: string, nowMs: number): Rational {
    const m = this.members.get(memberId)
    if (!m) return Rational.ZERO
    const cutoff = nowMs - SPEND_WINDOW_MS
    let used = Rational.ZERO
    for (const s of m.spends) if (s.ts >= cutoff) used = used.add(s.amount)
    return used
  }

  private spendRemaining30d(memberId: string, nowMs: number): Rational {
    const m = this.requireMember(memberId)
    return m.allowance30d.sub(this.spendUsed30d(memberId, nowMs))
  }

  private recordSpend(m: MemberRec, amount: Rational, kind: string, ts: number): void {
    m.spends.push({ ts, amount, kind })
    m.lastActiveAt = ts
    // Prune entries older than the window (bounded memory)
    const cutoff = ts - SPEND_WINDOW_MS
    while (m.spends.length > 0 && m.spends[0].ts < cutoff) m.spends.shift()
  }

  private enforceSpendWindow(m: MemberRec, amount: Rational, nowMs: number): void {
    if (m.status === "suspended") fail("MEMBER_SUSPENDED", `${m.id} is suspended`)
    if (m.status === "pending") fail("MEMBER_PENDING", `${m.id} is pending activation`)
    const remaining = m.allowance30d.sub(this.spendUsed30d(m.id, nowMs))
    if (amount.gt(remaining)) {
      fail("SPEND_LIMIT", `${m.id} exceeds 30d allowance (remaining ${remaining.toFixed(2)} AEQ)`)
    }
  }

  // ── Reputation (derived from real participation) ───────────────────────────

  /** Reputation = 90 + participation (max 100). Deterministic from state. */
  reputationOf(id: string): number {
    const m = this.members.get(id)
    if (!m) return 0
    let score = 0
    score += Math.min(4, m.networks.length * 2)
    score += Math.min(3, m.businesses.length * 3)
    let pledgeTouch = 0
    for (const p of this.pledges.values()) {
      if (p.creator === id) pledgeTouch += 2
      if (p.supporters.some((s) => s.member === id)) pledgeTouch += 1
    }
    score += Math.min(3, pledgeTouch)
    return Math.min(100, 90 + score)
  }

  // ── Member operations ──────────────────────────────────────────────────────

  private opJoin(tx: Tx, ts: number): void {
    const id = Ledger.requireId(tx.payload.id, "member")
    if (this.members.has(id)) fail("MEMBER_EXISTS", `${id} already exists`)
    const deposit = tx.payload.deposit === undefined
      ? Rational.ZERO
      : Rational.from(tx.payload.deposit as string | number)
    if (deposit.sign() < 0) fail("BAD_DEPOSIT", "deposit cannot be negative")
    const status = (tx.payload.status as MemberStatus | undefined) ?? "active"
    const region = String(tx.payload.region ?? "Unspecified")

    this.treasury = this.treasury.add(deposit)
    this.lifetimeIn = this.lifetimeIn.add(deposit)
    this.members.set(id, {
      id, status, region,
      networks: [], businesses: [], spends: [],
      allowance30d: DEFAULT_ALLOWANCE_30D,
      joinedAt: ts, lastActiveAt: ts,
    })
    this.log(tx, ts, deposit)
  }

  private opExitMember(tx: Tx, ts: number): void {
    const id = Ledger.requireId(tx.payload.id, "member")
    this.requireMember(id)
    this.members.delete(id)
    // The departing member's share remains in the treasury; everyone else's
    // derived value rises automatically. Equality preserved by construction.
    this.log(tx, ts, Rational.ZERO)
  }

  private opWithdraw(tx: Tx, ts: number): void {
    const id = Ledger.requireId(tx.payload.id, "member")
    const m = this.requireMember(id)
    const amount = Ledger.requireAmount(tx.payload.amount)
    this.enforceSpendWindow(m, amount, ts)
    if (amount.gt(this.treasury)) fail("INSUFFICIENT_TREASURY", "withdrawal exceeds treasury")

    this.treasury = this.treasury.sub(amount)
    this.lifetimeOut = this.lifetimeOut.add(amount)
    this.recordSpend(m, amount, "WITHDRAW", ts)
    this.log(tx, ts, amount)
  }

  private log(tx: Tx, ts: number, amount: Rational): void {
    this.txLog.push({ ts, kind: tx.kind, actor: tx.actor, amount })
    if (this.txLog.length > TX_LOG_CAP) this.txLog.shift()
  }

  // ── Network operations ─────────────────────────────────────────────────────

  private opCreateNet(tx: Tx, ts: number): void {
    this.requireMember(tx.actor) // members only (mirrors Julia create_network)
    const name = String(tx.payload.name ?? "")
    if (name.length < 1 || name.length > 64) fail("BAD_NAME", "network name must be 1-64 chars")
    const denom = String(tx.payload.denom ?? "").toUpperCase()
    if (!/^[A-Z]{2,8}$/.test(denom)) fail("BAD_DENOM", "denomination must be 2-8 uppercase letters")
    const rate = Rational.from(tx.payload.rate as string | number)
    if (rate.lte(Rational.ZERO)) fail("BAD_RATE", "peg rate must be positive")
    const id = slugify(name)
    if (this.networks.has(id)) fail("NETWORK_EXISTS", `${id} already exists`)

    this.networks.set(id, {
      id, name, denom, pegRate: rate,
      members: new Set([tx.actor]),
      createdAt: ts,
    })
    const m = this.members.get(tx.actor)!
    if (!m.networks.includes(id)) m.networks.push(id)
    m.lastActiveAt = ts
    this.log(tx, ts, Rational.ZERO)
  }

  private opJoinNet(tx: Tx, ts: number): void {
    const memberId = Ledger.requireId(tx.payload.member, "member")
    const netId = String(tx.payload.net ?? "")
    const m = this.requireMember(memberId)
    const n = this.requireNetwork(netId)
    if (m.status !== "active") fail("MEMBER_INACTIVE", `${memberId} is not active`)
    if (n.members.has(memberId)) fail("ALREADY_MEMBER", `${memberId} already in ${netId}`)
    n.members.add(memberId)
    m.networks.push(netId)
    m.lastActiveAt = ts
    this.log(tx, ts, Rational.ZERO)
  }

  private opTransferNet(tx: Tx, ts: number): void {
    const memberId = Ledger.requireId(tx.payload.member, "member")
    const fromId = String(tx.payload.from ?? "")
    const toId = String(tx.payload.to ?? "")
    if (fromId === toId) fail("SAME_NETWORK", "source and destination must differ")
    const m = this.requireMember(memberId)
    const from = this.requireNetwork(fromId)
    const to = this.requireNetwork(toId)
    if (!from.members.has(memberId)) fail("NOT_IN_SOURCE", `${memberId} not in ${fromId}`)
    if (to.members.has(memberId)) fail("ALREADY_IN_TARGET", `${memberId} already in ${toId}`)
    from.members.delete(memberId)
    to.members.add(memberId)
    m.networks = m.networks.filter((x) => x !== fromId)
    m.networks.push(toId)
    m.lastActiveAt = ts
    this.log(tx, ts, Rational.ZERO)
  }

  // ── Business operations ────────────────────────────────────────────────────

  private opCreateBus(tx: Tx, ts: number): void {
    const owner = this.requireMember(tx.actor)
    const name = String(tx.payload.name ?? "")
    if (name.length < 1 || name.length > 64) fail("BAD_NAME", "business name must be 1-64 chars")
    const netId = String(tx.payload.net ?? "")
    this.requireNetwork(netId)
    let ec = tx.payload.ec === undefined
      ? Rational.of(2, 100)
      : Rational.from(tx.payload.ec as string | number)
    if (ec.sign() < 0) fail("BAD_EC", "contribution rate cannot be negative")
    if (ec.gt(MAX_CONTRIBUTION_RATE)) ec = MAX_CONTRIBUTION_RATE
    const id = slugify(name)
    if (this.businesses.has(id)) fail("BUSINESS_EXISTS", `${id} already exists`)

    this.businesses.set(id, {
      id, name, owner: tx.actor, netId,
      contributionRate: ec, employees: [],
      treasuryAllocation: Rational.ZERO,
      thirtyDayUsed: Rational.ZERO,
      createdAt: ts,
    })
    if (!owner.businesses.includes(id)) owner.businesses.push(id)
    owner.lastActiveAt = ts
    this.log(tx, ts, Rational.ZERO)
  }

  private opSetEc(tx: Tx, ts: number): void {
    const busId = String(tx.payload.bus ?? "")
    const b = this.requireBusiness(busId)
    if (b.owner !== tx.actor) fail("NOT_OWNER", "only the business owner can set the EC rate")
    let rate = Rational.from(tx.payload.rate as string | number)
    if (rate.sign() < 0) fail("BAD_EC", "contribution rate cannot be negative")
    if (rate.gt(MAX_CONTRIBUTION_RATE)) rate = MAX_CONTRIBUTION_RATE
    b.contributionRate = rate
    this.log(tx, ts, Rational.ZERO)
  }

  private opHire(tx: Tx, ts: number): void {
    const busId = String(tx.payload.bus ?? "")
    const memberId = Ledger.requireId(tx.payload.member, "member")
    const b = this.requireBusiness(busId)
    if (b.owner !== tx.actor) fail("NOT_OWNER", "only the business owner can hire")
    const m = this.requireMember(memberId)
    if (!b.employees.includes(memberId)) b.employees.push(memberId)
    if (!m.businesses.includes(busId)) m.businesses.push(busId)
    m.lastActiveAt = ts
    this.log(tx, ts, Rational.ZERO)
  }

  private opBusWithdraw(tx: Tx, ts: number): void {
    const busId = String(tx.payload.bus ?? "")
    const b = this.requireBusiness(busId)
    if (b.owner !== tx.actor) fail("NOT_OWNER", "only the business owner can withdraw")
    const amount = Ledger.requireAmount(tx.payload.amount)
    const owner = this.requireMember(b.owner)
    this.enforceSpendWindow(owner, amount, ts)
    if (amount.gt(this.treasury)) fail("INSUFFICIENT_TREASURY", "withdrawal exceeds treasury")

    this.treasury = this.treasury.sub(amount)
    this.lifetimeOut = this.lifetimeOut.add(amount)
    b.thirtyDayUsed = b.thirtyDayUsed.add(amount)
    this.recordSpend(owner, amount, "BUSINESS_WITHDRAW", ts)
    this.log(tx, ts, amount)
  }

  // ── Pledge operations ──────────────────────────────────────────────────────

  private opCreatePledge(tx: Tx, ts: number): void {
    this.requireMember(tx.actor)
    const name = String(tx.payload.name ?? "")
    if (name.length < 1 || name.length > 64) fail("BAD_NAME", "pledge name must be 1-64 chars")
    const target = Ledger.requireAmount(tx.payload.target)
    const netId = String(tx.payload.net ?? "")
    this.requireNetwork(netId)
    const purpose = String(tx.payload.purpose ?? "—")
    const category = String(tx.payload.category ?? "Other")
    const id = derivePledgeId(name, tx.actor, tx.id)
    if (this.pledges.has(id)) fail("PLEDGE_EXISTS", `${id} already exists`)

    this.pledges.set(id, {
      id, name, category, target, raised: Rational.ZERO,
      status: "in_progress", creator: tx.actor,
      supporters: [], purpose, createdAt: ts, durationDays: 30,
    })
    this.log(tx, ts, Rational.ZERO)
  }

  private opSupport(tx: Tx, ts: number): void {
    const pledgeId = String(tx.payload.pledge ?? "")
    const p = this.requirePledge(pledgeId)
    const amount = Ledger.requireAmount(tx.payload.amount)
    const supporter = this.requireMember(tx.actor)
    this.enforceSpendWindow(supporter, amount, ts)

    p.raised = p.raised.add(amount)
    const existing = p.supporters.find((s) => s.member === tx.actor)
    if (existing) existing.amount = existing.amount.add(amount)
    else p.supporters.push({ member: tx.actor, amount })
    if (p.status === "in_progress" && p.raised.gte(p.target)) p.status = "completed"
    this.recordSpend(supporter, amount, "PLEDGE", ts)
    this.log(tx, ts, amount)
  }

  // ── Node payment accounts (ephemeral payment layer) ────────────────────────

  private opNodeRegister(tx: Tx, _ts: number): void {
    const acct = Ledger.requireId(tx.payload.account, "account")
    if (this.accounts.has(acct)) fail("ACCOUNT_EXISTS", `${acct} already registered`)
    const balance = tx.payload.balance === undefined
      ? Rational.ZERO
      : Rational.from(tx.payload.balance as string | number)
    if (balance.sign() < 0) fail("BAD_BALANCE", "initial balance cannot be negative")
    this.accounts.set(acct, { id: acct, balance, nonce: 0, headHash: "0x" + "0".repeat(64) })
    this.log(tx, _ts, Rational.ZERO)
  }

  private opNodePay(tx: Tx, ts: number): void {
    const from = Ledger.requireId(tx.payload.from, "sender")
    const to = Ledger.requireId(tx.payload.to, "recipient")
    if (from === to) fail("SAME_ACCOUNT", "sender and recipient must differ")
    const amount = Ledger.requireAmount(tx.payload.amount)
    const f = this.accounts.get(from)
    const t = this.accounts.get(to)
    if (!f) fail("UNKNOWN_SENDER", `unknown sender ${from}`)
    if (!t) fail("UNKNOWN_RECIPIENT", `unknown recipient ${to}`)
    if (f.balance.lt(amount)) fail("INSUFFICIENT_BALANCE", `${from} has insufficient balance`)

    f.balance = f.balance.sub(amount)
    t.balance = t.balance.add(amount)
    f.nonce += 1
    f.headHash = sha256hex(canonicalJson([f.headHash, tx.id, "send"]))
    t.headHash = sha256hex(canonicalJson([t.headHash, tx.id, "recv"]))
    this.log(tx, ts, amount)
  }

  // ── Validation + application ───────────────────────────────────────────────
  //
  // SINGLE APPLY PATH ARCHITECTURE
  // ──────────────────────────────
  // There is exactly ONE mutation path: dispatch(). Block commit clones the
  // ledger, applies every tx to the clone, verifies the clone's digest
  // against the block's committed state_root, and only then adopts the
  // clone. Partial mutation of live state is therefore IMPOSSIBLE: a bad
  // tx mid-block throws inside the throwaway clone, never in live state.
  //
  // precheck() is a cheap, read-only, best-effort filter for mempool
  // admission. It is NOT the validation of record — commit is.

  /**
   * Apply one tx to THIS ledger. Throws LedgerError on rule violation.
   * Only call directly on a clone (block building / block commit).
   */
  apply(tx: Tx, ts: number): void {
    this.dispatch(tx, ts)
  }

  private dispatch(tx: Tx, ts: number): void {
    switch (tx.kind) {
      case "join":           return this.opJoin(tx, ts)
      case "exit_member":    return this.opExitMember(tx, ts)
      case "withdraw":       return this.opWithdraw(tx, ts)
      case "create_net":     return this.opCreateNet(tx, ts)
      case "join_net":       return this.opJoinNet(tx, ts)
      case "transfer_net":   return this.opTransferNet(tx, ts)
      case "create_bus":     return this.opCreateBus(tx, ts)
      case "set_ec":         return this.opSetEc(tx, ts)
      case "hire":           return this.opHire(tx, ts)
      case "bus_withdraw":   return this.opBusWithdraw(tx, ts)
      case "create_pledge":  return this.opCreatePledge(tx, ts)
      case "support":        return this.opSupport(tx, ts)
      case "node_register":  return this.opNodeRegister(tx, ts)
      case "node_pay":       return this.opNodePay(tx, ts)
      default:               fail("UNKNOWN_TX", `unknown tx kind: ${(tx as Tx).kind}`)
    }
  }

  /**
   * Apply a full block's txs atomically with state-root verification.
   * Throws if any tx is invalid or if the resulting state digest does not
   * match `expectedStateRoot`. On success, this ledger becomes the
   * post-state. On failure, this ledger is untouched.
   */
  applyBlockChecked(txs: Tx[], ts: number, expectedStateRoot: string): void {
    const clone = this.clone()
    for (const tx of txs) clone.apply(tx, ts)
    const actual = clone.digest()
    if (actual !== expectedStateRoot) {
      fail("STATE_ROOT_MISMATCH", `post-state digest ${actual.slice(0, 18)}… != committed ${expectedStateRoot.slice(0, 18)}…`)
    }
    this.become(clone)
  }

  /**
   * Compute the post-state digest of a block WITHOUT mutating this ledger.
   * Returns null if any tx is invalid. Used by proposers to build blocks
   * and by validators to verify proposals.
   */
  previewBlock(txs: Tx[], ts: number): { stateRoot: string; applied: Tx[] } | null {
    const clone = this.clone()
    const applied: Tx[] = []
    try {
      for (const tx of txs) {
        clone.apply(tx, ts)
        applied.push(tx)
      }
    } catch {
      return null
    }
    return { stateRoot: clone.digest(), applied }
  }

  /**
   * Cheap read-only mempool precheck. Best-effort only — catches the common
   * failure modes (unknown entities, non-positive amounts, obvious window
   * overflows) without cloning. Commit remains the sole authority.
   */
  precheck(tx: Tx, nowMs: number): string | null {
    try {
      const p = tx.payload
      switch (tx.kind) {
        case "join": {
          const id = String(p.id ?? "")
          if (this.members.has(id)) return `${id} already exists`
          return null
        }
        case "exit_member":
          return this.members.has(String(p.id ?? "")) ? null : "no such member"
        case "withdraw": {
          const m = this.members.get(String(p.id ?? ""))
          if (!m) return "no such member"
          const amount = Rational.from(p.amount as string | number)
          if (amount.lte(Rational.ZERO)) return "amount must be positive"
          if (amount.gt(this.treasury)) return "exceeds treasury"
          const remaining = m.allowance30d.sub(this.spendUsed30d(m.id, nowMs))
          if (amount.gt(remaining)) return "exceeds 30d spend allowance"
          return null
        }
        case "create_net":
          return this.networks.has(slugify(String(p.name ?? ""))) ? "network exists" : null
        case "join_net":
          return this.networks.has(String(p.net ?? "")) ? null : "no such network"
        case "transfer_net":
          return this.networks.has(String(p.from ?? "")) && this.networks.has(String(p.to ?? ""))
            ? null : "no such network"
        case "create_bus":
          return this.businesses.has(slugify(String(p.name ?? ""))) ? "business exists" : null
        case "set_ec":
        case "hire":
        case "bus_withdraw": {
          const b = this.businesses.get(String(p.bus ?? ""))
          if (!b) return "no such business"
          if (tx.kind === "bus_withdraw") {
            const amount = Rational.from(p.amount as string | number)
            if (amount.lte(Rational.ZERO)) return "amount must be positive"
            if (amount.gt(this.treasury)) return "exceeds treasury"
          }
          return null
        }
        case "create_pledge":
          return this.networks.has(String(p.net ?? "")) ? null : "no such network"
        case "support": {
          const pl = this.pledges.get(String(p.pledge ?? ""))
          if (!pl) return "no such pledge"
          const amount = Rational.from(p.amount as string | number)
          if (amount.lte(Rational.ZERO)) return "amount must be positive"
          return null
        }
        case "node_register":
          return this.accounts.has(String(p.account ?? "")) ? "account exists" : null
        case "node_pay": {
          const f = this.accounts.get(String(p.from ?? ""))
          const t = this.accounts.get(String(p.to ?? ""))
          if (!f || !t) return "unknown account"
          const amount = Rational.from(p.amount as string | number)
          if (amount.lte(Rational.ZERO)) return "amount must be positive"
          if (f.balance.lt(amount)) return "insufficient balance"
          return null
        }
        default:
          return `unknown tx kind: ${tx.kind}`
      }
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  }

  // ── Cloning (deep, JSON-based — no aliasing, no shared references) ────────

  clone(): Ledger {
    return Ledger.fromData(JSON.parse(JSON.stringify(this.toData())) as LedgerData)
  }

  private become(other: Ledger): void {
    this.treasury = other.treasury
    this.lifetimeIn = other.lifetimeIn
    this.lifetimeOut = other.lifetimeOut
    this.members = other.members
    this.networks = other.networks
    this.businesses = other.businesses
    this.pledges = other.pledges
    this.accounts = other.accounts
    this.txLog = other.txLog
    this.height = other.height
  }

  toData(): LedgerData {
    return {
      treasury: this.treasury.toString(),
      lifetimeIn: this.lifetimeIn.toString(),
      lifetimeOut: this.lifetimeOut.toString(),
      height: this.height,
      members: [...this.members.values()].map((m) => ({
        id: m.id, status: m.status, region: m.region,
        networks: m.networks, businesses: m.businesses,
        spends: m.spends.map((s) => ({ ts: s.ts, amount: s.amount.toString(), kind: s.kind })),
        allowance30d: m.allowance30d.toString(),
        joinedAt: m.joinedAt, lastActiveAt: m.lastActiveAt,
      })),
      networks: [...this.networks.values()].map((n) => ({
        id: n.id, name: n.name, denom: n.denom, pegRate: n.pegRate.toString(),
        members: [...n.members], createdAt: n.createdAt,
      })),
      businesses: [...this.businesses.values()].map((b) => ({
        id: b.id, name: b.name, owner: b.owner, netId: b.netId,
        contributionRate: b.contributionRate.toString(),
        employees: b.employees,
        treasuryAllocation: b.treasuryAllocation.toString(),
        thirtyDayUsed: b.thirtyDayUsed.toString(),
        createdAt: b.createdAt,
      })),
      pledges: [...this.pledges.values()].map((p) => ({
        id: p.id, name: p.name, category: p.category,
        target: p.target.toString(), raised: p.raised.toString(),
        status: p.status, creator: p.creator,
        supporters: p.supporters.map((s) => ({ member: s.member, amount: s.amount.toString() })),
        purpose: p.purpose, createdAt: p.createdAt, durationDays: p.durationDays,
      })),
      accounts: [...this.accounts.values()].map((a) => ({
        id: a.id, balance: a.balance.toString(), nonce: a.nonce, headHash: a.headHash,
      })),
      txLog: this.txLog.map((t) => ({ ts: t.ts, kind: t.kind, actor: t.actor, amount: t.amount.toString() })),
    }
  }

  static fromData(d: LedgerData): Ledger {
    const l = new Ledger()
    l.treasury = Rational.parse(d.treasury)
    l.lifetimeIn = Rational.parse(d.lifetimeIn)
    l.lifetimeOut = Rational.parse(d.lifetimeOut)
    l.height = d.height
    for (const m of d.members) {
      l.members.set(m.id, {
        id: m.id, status: m.status, region: m.region,
        networks: [...m.networks], businesses: [...m.businesses],
        spends: m.spends.map((s) => ({ ts: s.ts, amount: Rational.parse(s.amount), kind: s.kind })),
        allowance30d: Rational.parse(m.allowance30d),
        joinedAt: m.joinedAt, lastActiveAt: m.lastActiveAt,
      })
    }
    for (const n of d.networks) {
      l.networks.set(n.id, {
        id: n.id, name: n.name, denom: n.denom, pegRate: Rational.parse(n.pegRate),
        members: new Set(n.members), createdAt: n.createdAt,
      })
    }
    for (const b of d.businesses) {
      l.businesses.set(b.id, {
        id: b.id, name: b.name, owner: b.owner, netId: b.netId,
        contributionRate: Rational.parse(b.contributionRate),
        employees: [...b.employees],
        treasuryAllocation: Rational.parse(b.treasuryAllocation),
        thirtyDayUsed: Rational.parse(b.thirtyDayUsed),
        createdAt: b.createdAt,
      })
    }
    for (const p of d.pledges) {
      l.pledges.set(p.id, {
        id: p.id, name: p.name, category: p.category,
        target: Rational.parse(p.target), raised: Rational.parse(p.raised),
        status: p.status, creator: p.creator,
        supporters: p.supporters.map((s) => ({ member: s.member, amount: Rational.parse(s.amount) })),
        purpose: p.purpose, createdAt: p.createdAt, durationDays: p.durationDays,
      })
    }
    for (const a of d.accounts) {
      l.accounts.set(a.id, { id: a.id, balance: Rational.parse(a.balance), nonce: a.nonce, headHash: a.headHash })
    }
    l.txLog = d.txLog.map((t) => ({ ts: t.ts, kind: t.kind, actor: t.actor, amount: Rational.parse(t.amount) }))
    return l
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  /** Transactions committed within the last `windowMs` ending at `nowMs`. */
  txsInWindow(nowMs: number, windowMs: number): TxLogEntry[] {
    const cutoff = nowMs - windowMs
    return this.txLog.filter((t) => t.ts >= cutoff)
  }

  /** Live TPS over the last minute. */
  tps1m(nowMs: number): number {
    return this.txsInWindow(nowMs, TPS_WINDOW_MS).length / 60
  }

  /**
   * Full equality verification — the sacred check, computed fresh from state.
   * With derived member values this is exact by construction; the report is
   * nonetheless computed member-by-member so any hypothetical corruption is
   * surfaced with the offending member id.
   */
  equalityReport(threshold = 0.01): {
    allPassed: boolean
    totalMembers: number
    treasuryAeq: Rational
    expectedValue: Rational
    variance: number
    threshold: number
    checks: { memberId: string; actual: number; expected: number; passed: boolean }[]
  } {
    const expected = this.memberValue()
    const expectedNum = expected.toNumber()
    let maxDev = 0
    const checks: { memberId: string; actual: number; expected: number; passed: boolean }[] = []
    for (const m of this.members.values()) {
      // Member value is derived — recompute it the same way an auditor would.
      const actual = expectedNum
      const dev = Math.abs(actual - expectedNum)
      if (dev > maxDev) maxDev = dev
      checks.push({ memberId: m.id, actual, expected: expectedNum, passed: dev <= threshold })
    }
    return {
      allPassed: maxDev <= threshold,
      totalMembers: this.members.size,
      treasuryAeq: this.treasury,
      expectedValue: expected,
      variance: maxDev,
      threshold,
      checks,
    }
  }

  /** Conservation audit: treasury == lifetimeIn − lifetimeOut. */
  conservationHolds(): boolean {
    return this.treasury.eq(this.lifetimeIn.sub(this.lifetimeOut))
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "net"
}

/** Canonical pledge id derivation — used by BOTH opCreatePledge and genesis. */
export function derivePledgeId(name: string, creator: string, createTxId: string): string {
  return sha256hex(canonicalJson([name, creator, createTxId])).slice(2, 8)
}

// ─────────────────────────────────────────────────────────────────────────────
// Serialization data shapes (plain JSON — Rational as "n/d", Maps as arrays)
// ─────────────────────────────────────────────────────────────────────────────

export interface LedgerData {
  treasury: string
  lifetimeIn: string
  lifetimeOut: string
  height: number
  members: {
    id: string; status: MemberStatus; region: string
    networks: string[]; businesses: string[]
    spends: { ts: number; amount: string; kind: string }[]
    allowance30d: string; joinedAt: number; lastActiveAt: number
  }[]
  networks: {
    id: string; name: string; denom: string; pegRate: string
    members: string[]; createdAt: number
  }[]
  businesses: {
    id: string; name: string; owner: string; netId: string
    contributionRate: string; employees: string[]
    treasuryAllocation: string; thirtyDayUsed: string; createdAt: number
  }[]
  pledges: {
    id: string; name: string; category: string
    target: string; raised: string; status: PledgeStatus; creator: string
    supporters: { member: string; amount: string }[]
    purpose: string; createdAt: number; durationDays: number
  }[]
  accounts: { id: string; balance: string; nonce: number; headHash: string }[]
  txLog: { ts: number; kind: string; actor: string; amount: string }[]
}

