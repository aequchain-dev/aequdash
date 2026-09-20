/**
 * aequdash — tests/node/consensus.test.ts
 *
 * BFT primitives under test — mirrors the Julia reference self-test:
 * deterministic committees, threshold aggregation, duplicate-vote
 * rejection, insufficient-vote rejection, conflicting-hash safety.
 */

import { describe, test, expect } from "bun:test"
import {
  selectCommittee, committeeId, thresholdFor, byzantineTolerance,
  proposerFor, signVote, verifyVote, formQC, verifyQC,
} from "../../src/node/consensus.ts"
import { testIdentity } from "../../src/node/crypto.ts"
import { buildBlock } from "../../src/node/block.ts"
import type { Block } from "../../src/node/proto.ts"

const VALIDATORS = ["node-1", "node-2", "node-3", "node-4", "node-5", "node-6", "node-7", "node-8"]

function testBlock(height: number, roster: string[] = VALIDATORS): Block {
  return buildBlock(height, "0x" + "0".repeat(64), 1_000_000, roster[0], [], "0xstateroot", roster)
}

describe("committee selection", () => {
  test("deterministic: same seed → same committee", () => {
    const a = selectCommittee(VALIDATORS, 10, "42", 4)
    const b = selectCommittee(VALIDATORS, 10, "42", 4)
    expect(a).toEqual(b)
  })

  test("different heights → different committees (with high probability)", () => {
    const a = selectCommittee(VALIDATORS, 10, "42", 4)
    const b = selectCommittee(VALIDATORS, 11, "42", 4)
    const c = selectCommittee(VALIDATORS, 12, "42", 4)
    // At least one of the three differs
    expect(a.join() === b.join() && b.join() === c.join()).toBe(false)
  })

  test("size capped by roster", () => {
    const c = selectCommittee(["a", "b"], 1, "42", 8)
    expect(c.length).toBe(2)
  })

  test("empty roster → empty committee", () => {
    expect(selectCommittee([], 1, "42", 8)).toEqual([])
  })

  test("committee id is deterministic", () => {
    const c = selectCommittee(VALIDATORS, 7, "42", 5)
    expect(committeeId(7, c)).toBe(committeeId(7, [...c]))
  })
})

describe("thresholds", () => {
  test("floor(2n/3)+1", () => {
    expect(thresholdFor(1)).toBe(1)
    expect(thresholdFor(2)).toBe(2)
    expect(thresholdFor(3)).toBe(3)
    expect(thresholdFor(4)).toBe(3)
    expect(thresholdFor(7)).toBe(5)
    expect(thresholdFor(12)).toBe(9)
  })
  test("byzantine tolerance floor((n-1)/3)", () => {
    expect(byzantineTolerance(1)).toBe(0)
    expect(byzantineTolerance(4)).toBe(1)
    expect(byzantineTolerance(7)).toBe(2)
  })
  test("proposer rotation covers the committee", () => {
    const c = ["a", "b", "c"]
    const seen = new Set([proposerFor(c, 0, 0), proposerFor(c, 1, 0), proposerFor(c, 2, 0)])
    expect(seen.size).toBe(3)
  })
})

describe("votes & quorum certificates", () => {
  test("vote signs and verifies", () => {
    const id = testIdentity(0)
    const vote = signVote(id, "node-1", 5, "0xblockhash")
    expect(verifyVote(vote)).toBe(true)
  })

  test("tampered vote rejected", () => {
    const id = testIdentity(0)
    const vote = signVote(id, "node-1", 5, "0xblockhash")
    const bad = { ...vote, block_hash: "0xother" }
    expect(verifyVote(bad)).toBe(false)
  })

  test("QC forms at threshold", () => {
    const block = testBlock(1)
    const committee = selectCommittee(VALIDATORS, 1, "42", 4)
    const threshold = thresholdFor(committee.length)
    const votes = committee.slice(0, threshold).map((v, i) => signVote(testIdentity(i), v, 1, block.hash))
    const qc = formQC(block, votes, committee, threshold)
    expect(qc).not.toBeNull()
    expect(qc!.votes.length).toBe(threshold)
    expect(qc!.committee_id).toBe(committeeId(1, committee))
  })

  test("insufficient votes → no QC", () => {
    const block = testBlock(1)
    const committee = selectCommittee(VALIDATORS, 1, "42", 4)
    const threshold = thresholdFor(committee.length)
    const votes = committee.slice(0, threshold - 1).map((v, i) => signVote(testIdentity(i), v, 1, block.hash))
    expect(formQC(block, votes, committee, threshold)).toBeNull()
  })

  test("duplicate votes count once", () => {
    const block = testBlock(1)
    const committee = selectCommittee(VALIDATORS, 1, "42", 4)
    const threshold = thresholdFor(committee.length)
    const v = signVote(testIdentity(0), committee[0], 1, block.hash)
    const rest = committee.slice(1, threshold).map((vv, i) => signVote(testIdentity(i + 1), vv, 1, block.hash))
    const qc = formQC(block, [v, v, v, ...rest], committee, threshold)
    expect(qc).not.toBeNull()
    expect(qc!.votes.length).toBe(threshold)
  })

  test("votes for a different block don't count", () => {
    const block = testBlock(1)
    const committee = selectCommittee(VALIDATORS, 1, "42", 4)
    const threshold = thresholdFor(committee.length)
    const votes = committee.map((v, i) => signVote(testIdentity(i), v, 1, "0xWRONGHASH"))
    expect(formQC(block, votes, committee, threshold)).toBeNull()
  })

  test("non-committee votes ignored", () => {
    const block = testBlock(1)
    const committee = selectCommittee(VALIDATORS, 1, "42", 4)
    const threshold = thresholdFor(committee.length)
    const votes = committee.map((_, i) => signVote(testIdentity(i), `outsider-${i}`, 1, block.hash))
    expect(formQC(block, votes, committee, threshold)).toBeNull()
  })

  test("verifyQC round-trip + forgery rejection", () => {
    const block = testBlock(1)
    const committee = selectCommittee(VALIDATORS, 1, "42", 4)
    const threshold = thresholdFor(committee.length)
    const votes = committee.slice(0, threshold).map((v, i) => signVote(testIdentity(i), v, 1, block.hash))
    const qc = formQC(block, votes, committee, threshold)!
    expect(verifyQC(qc, block, committee, threshold)).toBe(true)
    // Forged: claim a lower threshold
    expect(verifyQC({ ...qc, threshold: 1 }, block, committee, threshold)).toBe(false)
    // Wrong committee
    expect(verifyQC(qc, block, ["x", "y", "z"], threshold)).toBe(false)
  })
})
