/**
 * aequdash — tests/simulator.test.ts
 *
 * Simulator invariants — the v2 reference backend must be:
 *   • deterministic (same seed → identical snapshot)
 *   • internally consistent (equality invariant, conservation, sums)
 *   • command-correct (mutations update every affected aggregate)
 */

import { describe, test, expect } from "bun:test"

process.env.AEQUDASH_SNAPSHOT = "1"

const { AequSimulator } = await import("../src/lib/simulator.ts")

const EPS = 0.01

describe("determinism", () => {
  test("same seed → identical snapshot", () => {
    const a = new AequSimulator({ seed: 42 })
    const b = new AequSimulator({ seed: 42 })
    expect(JSON.stringify(a.snapshot())).toBe(JSON.stringify(b.snapshot()))
  })
  test("different seed → different detail, same totals", () => {
    const a = new AequSimulator({ seed: 42 })
    const c = new AequSimulator({ seed: 7 })
    // Totals are fixed by design; random detail (hashes) differs
    expect(a.snapshot().treasury?.total_aeq).toBe(c.snapshot().treasury?.total_aeq)
    expect(JSON.stringify(a.snapshot())).not.toBe(JSON.stringify(c.snapshot()))
  })
})

describe("internal consistency", () => {
  const sim = new AequSimulator({ seed: 42 })
  const snap = sim.snapshot()

  test("equality invariant: member_value × active = treasury (±rounding)", () => {
    expect(snap.member_value_aeq * (snap.members_summary?.active_24h ?? 0))
      .toBeCloseTo(snap.treasury?.total_aeq ?? 0, -1)
  })
  test("treasury holdings sum to total", () => {
    const t = snap.treasury!
    const sum = t.holdings.reduce((a, h) => a + h.amount_aeq, 0)
    expect(Math.abs(sum - t.total_aeq)).toBeLessThan(EPS)
  })
  test("holding percents sum to 100", () => {
    const t = snap.treasury!
    const pcts = t.holdings.map((h) => (h.amount_aeq / t.total_aeq) * 100)
    expect(pcts.reduce((a, p) => a + p, 0)).toBeCloseTo(100, 0)
  })
  test("member distribution sums to active", () => {
    const ms = snap.members_summary!
    const sum = ms.distribution.reduce((a, d) => a + d.count, 0)
    expect(sum).toBe(ms.active_24h)
  })
  test("member statuses reconcile", () => {
    const ms = snap.members_summary!
    // registered ≥ active + pending + suspended (inactive members exist too)
    expect(ms.total_registered).toBeGreaterThanOrEqual(ms.active_24h)
    expect(ms.pending).toBeGreaterThanOrEqual(0)
    expect(ms.suspended).toBeGreaterThanOrEqual(0)
  })
  test("pledge categories sum to total; statuses sum to total", () => {
    const ps = snap.pledges_summary!
    expect(ps.distribution.reduce((a, d) => a + d.count, 0)).toBe(ps.total)
    expect(ps.in_progress + ps.completed + ps.failed).toBe(ps.total)
  })
  test("success rate = completed / (completed + failed)", () => {
    const ps = snap.pledges_summary!
    const expected = (ps.completed / (ps.completed + ps.failed)) * 100
    expect(ps.success_rate).toBeCloseTo(expected, 1)
  })
  test("volume breakdown sums to total", () => {
    const v = snap.volume!
    const sum = v.breakdown.reduce((a, b) => a + b.amount_aeq, 0)
    expect(Math.abs(sum - v.total_aeq)).toBeLessThan(EPS)
  })
  test("spend: used + remaining = limit; pct consistent", () => {
    const s = snap.spend!
    expect(Math.abs(s.used_aeq + s.remaining_aeq - s.limit_aeq)).toBeLessThan(EPS)
    expect(s.used_pct).toBeCloseTo((s.used_aeq / s.limit_aeq) * 100, 1)
  })
  test("usd conversions use the same rate", () => {
    const t = snap.treasury!
    expect(t.total_usd).toBeCloseTo(t.total_aeq * t.aeq_usd_rate, 0)
  })
  test("equality report passes and matches members", () => {
    const eq = snap.equality!
    expect(eq.all_passed).toBe(true)
    expect(eq.checks.every((c) => c.passed)).toBe(true)
    expect(eq.checks.length).toBe(snap.members.length)
  })
  test("activity feed is structured (tag + fields)", () => {
    expect(snap.activity.length).toBeGreaterThan(0)
    for (const ev of snap.activity) {
      expect(ev.tag.length).toBeGreaterThan(0)
      expect(ev.message.length).toBeGreaterThan(0)
      expect(Array.isArray(ev.fields)).toBe(true)
    }
  })
})

describe("commands", () => {
  test("join increases treasury and registered, rebalances values", () => {
    const sim = new AequSimulator({ seed: 42 })
    const before = sim.snapshot()
    const r = sim.cliRun("join", ["testuser", "1000"])
    expect(r.ok).toBe(true)
    const after = sim.snapshot()
    expect(after.treasury!.total_aeq).toBeCloseTo(before.treasury!.total_aeq + 1000, 2)
    expect(after.members_summary!.total_registered).toBe(before.members_summary!.total_registered + 1)
    // equality: value × active ≈ treasury
    expect(after.member_value_aeq * after.members_summary!.active_24h)
      .toBeCloseTo(after.treasury!.total_aeq, -1)
    expect(after.members.some((m) => m.id === "testuser")).toBe(true)
  })
  test("join rejects duplicate", () => {
    const sim = new AequSimulator({ seed: 42 })
    const r = sim.cliRun("join", ["aelith", "10"])
    expect(r.ok).toBe(false)
  })
  test("withdraw enforces 30d allowance", () => {
    const sim = new AequSimulator({ seed: 42 })
    const bad = sim.cliRun("withdraw", ["aelith", "999999999"])
    expect(bad.ok).toBe(false)
    const good = sim.cliRun("withdraw", ["aelith", "100", "groceries"])
    expect(good.ok).toBe(true)
    const after = sim.snapshot()
    const me = after.members.find((m) => m.id === "aelith")!
    expect(me.spend_used_30d_aeq).toBeCloseTo(1245.30 + 100, 2)
    expect(after.spend!.used_aeq).toBeGreaterThan(0)
  })
  test("withdraw unknown member fails", () => {
    const sim = new AequSimulator({ seed: 42 })
    expect(sim.cliRun("withdraw", ["ghost", "10"]).ok).toBe(false)
  })
  test("support completes a pledge at target and updates aggregates", () => {
    const sim = new AequSimulator({ seed: 42 })
    const before = sim.snapshot()
    // pledge 9c1d4f: 760 / 2000 → support 1240 completes it
    const r = sim.cliRun("support", ["9c1d4f", "1240"])
    expect(r.ok).toBe(true)
    const after = sim.snapshot()
    const p = after.pledges.find((x) => x.id === "9c1d4f")!
    expect(p.status).toBe("completed")
    expect(after.pledges_summary!.completed).toBe(before.pledges_summary!.completed + 1)
    expect(after.pledges_summary!.in_progress).toBe(before.pledges_summary!.in_progress - 1)
    expect(after.volume!.breakdown.find((b) => b.kind === "pledges")!.amount_aeq)
      .toBeGreaterThan(before.volume!.breakdown.find((b) => b.kind === "pledges")!.amount_aeq)
  })
  test("node_pay moves balance and appends block + QC", () => {
    const sim = new AequSimulator({ seed: 42 })
    const before = sim.snapshot()
    const r = sim.cliRun("node_pay", ["aelith", "alice", "25"])
    expect(r.ok).toBe(true)
    const after = sim.snapshot()
    expect(after.node!.blocks.length).toBe(before.node!.blocks.length + 1)
    expect(after.node!.quorum_certs.length).toBe(before.node!.quorum_certs.length + 1)
    expect(after.block_height).toBe(before.block_height + 1)
    const aelith = after.node!.accounts.find((a) => a.id === "aelith")!
    const alice = after.node!.accounts.find((a) => a.id === "alice")!
    const aelithBefore = before.node!.accounts.find((a) => a.id === "aelith")!
    const aliceBefore = before.node!.accounts.find((a) => a.id === "alice")!
    expect(aelith.balance_aeq).toBeCloseTo(aelithBefore.balance_aeq - 25, 2)
    expect(alice.balance_aeq).toBeCloseTo(aliceBefore.balance_aeq + 25, 2)
  })
  test("node_pay rejects insufficient balance", () => {
    const sim = new AequSimulator({ seed: 42 })
    expect(sim.cliRun("node_pay", ["aelith", "alice", "99999999"]).ok).toBe(false)
  })
  test("login/logout switch personal summary", () => {
    const sim = new AequSimulator({ seed: 42 })
    expect(sim.snapshot().personal!.member_id).toBe("aelith")
    sim.cliRun("login", ["alice"])
    expect(sim.snapshot().personal!.member_id).toBe("alice")
    sim.cliRun("logout")
    expect(sim.snapshot().personal!.member_id).toBe("")
  })
  test("unknown command fails cleanly", () => {
    const sim = new AequSimulator({ seed: 42 })
    const r = sim.cliRun("frobnicate", [])
    expect(r.ok).toBe(false)
    expect(r.message).toContain("unknown command")
  })
  test("reset restores genesis state (modulo the reset log event itself)", () => {
    const sim = new AequSimulator({ seed: 42 })
    const genesis = sim.snapshot()
    sim.cliRun("join", ["someone", "5000"])
    const r = sim.cliRun("reset", [])
    expect(r.ok).toBe(true)
    const after = sim.snapshot()
    // Everything except the activity tail must be identical to genesis
    const strip = (s: typeof genesis) => JSON.stringify({ ...s, activity: [] })
    expect(strip(after)).toBe(strip(genesis))
    // The reset itself is logged as an event
    expect(after.activity[after.activity.length - 1].tag).toBe("reset")
  })
  test("heartbeat tick advances height, blocks, and emits canonical events", () => {
    const sim = new AequSimulator({ seed: 42 })
    const before = sim.snapshot()
    sim.tick()
    sim.tick()
    const after = sim.snapshot()
    expect(after.block_height).toBe(before.block_height + 2)
    expect(after.node!.blocks.length).toBeGreaterThan(before.node!.blocks.length)
    expect(after.activity.length).toBe(before.activity.length + 2)
    expect(after.volume!.tx_count_24h).toBeGreaterThan(before.volume!.tx_count_24h)
    // invariant survives heartbeats
    expect(after.member_value_aeq * after.members_summary!.active_24h)
      .toBeCloseTo(after.treasury!.total_aeq, 0)
  })

  test("commands emit structured activity", () => {
    const sim = new AequSimulator({ seed: 42 })
    const before = sim.snapshot().activity.length
    sim.cliRun("join", ["emit_test", "10"])
    const after = sim.snapshot().activity
    expect(after.length).toBe(before + 1)
    expect(after[after.length - 1].tag).toBe("join")
  })
})
