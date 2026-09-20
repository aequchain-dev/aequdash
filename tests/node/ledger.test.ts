/**
 * aequdash — tests/node/ledger.test.ts
 *
 * The equality engine under test. THE invariant — member value is always
 * exactly treasury / member_count — must hold after EVERY operation,
 * no matter the sequence.
 */

import { describe, test, expect } from "bun:test"
import { Ledger, slugify } from "../../src/node/ledger.ts"
import { Rational } from "../../src/node/rational.ts"
import { makeTx } from "../../src/node/block.ts"
import type { Tx, TxKind } from "../../src/node/proto.ts"

let nonceCounter = 0
function tx(kind: TxKind, actor: string, payload: Record<string, unknown>, ts = 1_000): Tx {
  return makeTx(kind, actor, payload, ts, nonceCounter++)
}

describe("ledger: equality invariant", () => {
  test("join: treasury grows, all values equal", () => {
    const l = new Ledger()
    l.apply(tx("join", "system", { id: "a", deposit: "1000" }), 1000)
    l.apply(tx("join", "system", { id: "b", deposit: "500" }), 1000)
    l.apply(tx("join", "system", { id: "c", deposit: "250" }), 1000)
    expect(l.treasury.toString()).toBe("1750/1")
    expect(l.memberValue().toString()).toBe("1750/3")
    expect(l.memberCount()).toBe(3)
    expect(l.equalityReport().allPassed).toBe(true)
  })

  test("withdraw: every member's value drops equally", () => {
    const l = new Ledger()
    l.apply(tx("join", "system", { id: "a", deposit: "1000" }), 1000)
    l.apply(tx("join", "system", { id: "b", deposit: "1000" }), 1000)
    l.apply(tx("withdraw", "a", { id: "a", amount: "400", purpose: "test" }), 2000)
    // 2000 - 400 = 1600 treasury; 1600 / 2 members = 800 each
    expect(l.treasury.toString()).toBe("1600/1")
    expect(l.memberValue().toString()).toBe("800/1")
    expect(l.conservationHolds()).toBe(true)
  })

  test("exit_member: share remains, survivors rise equally", () => {
    const l = new Ledger()
    l.apply(tx("join", "system", { id: "a", deposit: "900" }), 1000)
    l.apply(tx("join", "system", { id: "b", deposit: "900" }), 1000)
    l.apply(tx("exit_member", "system", { id: "a" }), 2000)
    expect(l.memberCount()).toBe(1)
    expect(l.memberValue().toString()).toBe("1800/1")
    expect(l.equalityReport().allPassed).toBe(true)
  })

  test("fractional treasury: exact with repeating decimals", () => {
    const l = new Ledger()
    l.apply(tx("join", "system", { id: "a", deposit: "1" }), 1000)
    l.apply(tx("join", "system", { id: "b", deposit: "0" }), 1000)
    l.apply(tx("join", "system", { id: "c", deposit: "0" }), 1000)
    expect(l.memberValue().toString()).toBe("1/3")
    // share × count == treasury — the conservation form of the invariant
    expect(l.memberValue().mul(Rational.of(l.memberCount())).eq(l.treasury)).toBe(true)
  })
})

describe("ledger: spend window enforcement", () => {
  test("30d window blocks overspend", () => {
    const l = new Ledger()
    l.apply(tx("join", "system", { id: "a", deposit: "1000" }), 1000)
    expect(() => l.apply(tx("withdraw", "a", { id: "a", amount: "60000", purpose: "too much" }), 2000))
      .toThrow(/30d allowance/)
  })

  test("spend accumulates within the window", () => {
    const l = new Ledger()
    l.apply(tx("join", "system", { id: "a", deposit: "100000" }), 1000)
    l.apply(tx("withdraw", "a", { id: "a", amount: "40000", purpose: "one" }), 2000)
    expect(() => l.apply(tx("withdraw", "a", { id: "a", amount: "40000", purpose: "two" }), 3000))
      .toThrow(/30d allowance/)
    // Exactly at the limit is allowed
    l.apply(tx("withdraw", "a", { id: "a", amount: "10000", purpose: "top up" }), 3000)
    expect(l.spendUsed30d("a", 3000).toString()).toBe("50000/1")
  })

  test("window slides: old spends expire", () => {
    const l = new Ledger()
    l.apply(tx("join", "system", { id: "a", deposit: "100000" }), 1000)
    l.apply(tx("withdraw", "a", { id: "a", amount: "50000", purpose: "max" }), 2000)
    const DAY31 = 2000 + 31 * 86_400_000
    l.apply(tx("withdraw", "a", { id: "a", amount: "50000", purpose: "after window" }), DAY31)
    expect(l.spendUsed30d("a", DAY31).toString()).toBe("50000/1")
  })

  test("suspended members cannot withdraw", () => {
    const l = new Ledger()
    l.apply(tx("join", "system", { id: "a", deposit: "100", status: "suspended" }), 1000)
    expect(() => l.apply(tx("withdraw", "a", { id: "a", amount: "1", purpose: "x" }), 2000))
      .toThrow(/suspended/)
  })
})

describe("ledger: full op surface", () => {
  test("networks, businesses, pledges, payments", () => {
    const l = new Ledger()
    l.apply(tx("join", "system", { id: "alice", deposit: "5000" }), 1000)
    l.apply(tx("join", "system", { id: "bob", deposit: "3000" }), 1000)

    l.apply(tx("create_net", "alice", { name: "TestNet", denom: "TST", rate: "1.5" }), 1001)
    expect(l.networks.has(slugify("TestNet"))).toBe(true)
    l.apply(tx("join_net", "alice", { member: "bob", net: "testnet" }), 1002)
    expect(l.networks.get("testnet")!.members.size).toBe(2)

    l.apply(tx("create_bus", "alice", { name: "Shop", net: "testnet", ec: "0.03" }), 1003)
    l.apply(tx("hire", "alice", { bus: "shop", member: "bob" }), 1004)
    expect(l.businesses.get("shop")!.employees).toContain("bob")

    l.apply(tx("create_pledge", "alice", { name: "Fund", target: "100", net: "testnet", purpose: "x", category: "Other" }), 1005)
    const pledgeId = [...l.pledges.keys()][0]
    l.apply(tx("support", "bob", { pledge: pledgeId, amount: "100" }), 1006)
    expect(l.pledges.get(pledgeId)!.status).toBe("completed")

    l.apply(tx("node_register", "system", { account: "alice", balance: "100" }), 1007)
    l.apply(tx("node_register", "system", { account: "bob", balance: "50" }), 1008)
    l.apply(tx("node_pay", "alice", { from: "alice", to: "bob", amount: "30" }), 1009)
    expect(l.accounts.get("alice")!.balance.toString()).toBe("70/1")
    expect(l.accounts.get("bob")!.balance.toString()).toBe("80/1")
    expect(l.accounts.get("alice")!.nonce).toBe(1)

    expect(l.equalityReport().allPassed).toBe(true)
    expect(l.conservationHolds()).toBe(true)
  })

  test("business withdraw is owner-only", () => {
    const l = new Ledger()
    l.apply(tx("join", "system", { id: "alice", deposit: "5000" }), 1000)
    l.apply(tx("join", "system", { id: "bob", deposit: "1000" }), 1000)
    l.apply(tx("create_net", "alice", { name: "X", denom: "XX", rate: "1" }), 1001)
    l.apply(tx("create_bus", "alice", { name: "Shop", net: "x", ec: "0.02" }), 1002)
    expect(() => l.apply(tx("bus_withdraw", "bob", { bus: "shop", amount: "10", purpose: "theft" }), 1003))
      .toThrow(/owner/)
  })
})

describe("ledger: atomic commit (clone-verify-adopt)", () => {
  test("bad tx mid-block → live state untouched", () => {
    const l = new Ledger()
    l.apply(tx("join", "system", { id: "a", deposit: "1000" }), 1000)
    const good = tx("join", "system", { id: "b", deposit: "500" })
    const bad = tx("withdraw", "a", { id: "a", amount: "99999999", purpose: "boom" })
    expect(() => l.applyBlockChecked([good, bad], 2000, "0xwhatever")).toThrow()
    // 'b' must NOT exist in live state — the block must be atomic
    expect(l.members.has("b")).toBe(false)
    expect(l.memberCount()).toBe(1)
  })

  test("state-root mismatch rejected without mutation", () => {
    const l = new Ledger()
    l.apply(tx("join", "system", { id: "a", deposit: "1000" }), 1000)
    const t = tx("join", "system", { id: "b", deposit: "500" })
    expect(() => l.applyBlockChecked([t], 2000, "0xdeadbeef")).toThrow(/STATE_ROOT_MISMATCH/)
    expect(l.members.has("b")).toBe(false)
  })

  test("previewBlock → applyBlockChecked round-trip", () => {
    const l = new Ledger()
    l.apply(tx("join", "system", { id: "a", deposit: "1000" }), 1000)
    const txs = [
      tx("join", "system", { id: "b", deposit: "500" }),
      tx("withdraw", "a", { id: "a", amount: "100", purpose: "x" }),
    ]
    const preview = l.previewBlock(txs, 2000)!
    expect(preview.applied.length).toBe(2)
    l.applyBlockChecked(txs, 2000, preview.stateRoot)
    expect(l.memberCount()).toBe(2)
    expect(l.treasury.toString()).toBe("1400/1")
  })

  test("previewBlock returns null on invalid tx", () => {
    const l = new Ledger()
    const bad = tx("withdraw", "ghost", { id: "ghost", amount: "1", purpose: "x" })
    expect(l.previewBlock([bad], 2000)).toBeNull()
  })

  test("clone independence", () => {
    const l = new Ledger()
    l.apply(tx("join", "system", { id: "a", deposit: "1000" }), 1000)
    const c = l.clone()
    c.apply(tx("join", "system", { id: "b", deposit: "500" }), 2000)
    expect(l.memberCount()).toBe(1)
    expect(c.memberCount()).toBe(2)
    // Digests diverge exactly as states diverge
    expect(l.digest()).not.toBe(c.digest())
  })

  test("digest is deterministic for identical histories", () => {
    const a = new Ledger()
    const b = new Ledger()
    const txs = [
      tx("join", "system", { id: "x", deposit: "100" }),
      tx("join", "system", { id: "y", deposit: "50" }),
    ]
    for (const t of txs) { a.apply(t, 1000); b.apply(t, 1000) }
    expect(a.digest()).toBe(b.digest())
  })
})
