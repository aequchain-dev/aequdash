/**
 * aequdash — src/node/consensus.ts
 *
 * BFT consensus for the ephemeral testnet mesh.
 *
 * Model: rotating-proposer BFT with Ed25519-signed votes and quorum
 * certificates, in the HotStuff family:
 *
 *   - committee(h)     = deterministic seeded selection from the live roster
 *   - proposer(h, v)   = committee[(h + v) mod |committee|]  (v = view)
 *   - threshold        = floor(2|committee|/3) + 1   (2f+1 for f byzantine)
 *   - QC               = ≥ threshold valid, unique, committee-member votes
 *                        for the same (height, block_hash)
 *
 * Safety: two conflicting QCs at the same height require ≥ threshold votes
 * each; with 2f+1 threshold and ≤ f byzantine voters, quorum intersection
 * guarantees an honest voter signed twice — which honest nodes never do.
 *
 * Liveness: if no QC forms within the round timeout, the view increments
 * and the next committee member proposes.
 */

import { sha256hex, canonicalJson, signObject, verifyObject, type Identity } from "./crypto.ts"
import type { Block, QC, Vote } from "./proto.ts"

// ─────────────────────────────────────────────────────────────────────────────
// Committee selection — deterministic, seeded, shared by all nodes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deterministically select `size` validators from the roster for a height.
 * Every node with the same (roster, height, seed, size) computes the same
 * committee — this is the same property the Julia reference tests for.
 */
export function selectCommittee(
  roster: string[],
  height: number,
  epochSeed: string,
  size: number,
): string[] {
  if (roster.length === 0) return []
  const scored = roster.map((id) => ({
    id,
    score: sha256hex(`${epochSeed}:${height}:${id}`),
  }))
  scored.sort((a, b) => (a.score < b.score ? -1 : a.score > b.score ? 1 : a.id.localeCompare(b.id)))
  return scored.slice(0, Math.min(size, roster.length)).map((s) => s.id).sort()
}

export function committeeId(height: number, committee: string[]): string {
  const digest = sha256hex(canonicalJson(committee)).slice(2, 10)
  return `cmt-${height}-${digest}`
}

/** BFT quorum threshold: floor(2n/3) + 1. */
export function thresholdFor(committeeSize: number): number {
  return Math.floor((2 * committeeSize) / 3) + 1
}

/** Maximum tolerable byzantine validators: floor((n-1)/3). */
export function byzantineTolerance(committeeSize: number): number {
  return Math.floor((committeeSize - 1) / 3)
}

/** Proposer for a given height and view (view increments on timeout). */
export function proposerFor(committee: string[], height: number, view: number): string {
  return committee[(height + view) % committee.length]
}

// ─────────────────────────────────────────────────────────────────────────────
// Votes
// ─────────────────────────────────────────────────────────────────────────────

function votePayload(height: number, blockHash: string, voter: string): unknown {
  return { domain: "aequchain-vote-v1", height, block_hash: blockHash, voter }
}

export function signVote(identity: Identity, nodeId: string, height: number, blockHash: string): Vote {
  return {
    height,
    block_hash: blockHash,
    voter: nodeId,
    voter_pub: identity.pub,
    sig: signObject(identity, votePayload(height, blockHash, nodeId)),
  }
}

export function verifyVote(vote: Vote): boolean {
  if (vote.voter_pub.length === 0 || vote.sig.length === 0) return false
  return verifyObject(vote.voter_pub, votePayload(vote.height, vote.block_hash, vote.voter), vote.sig)
}

// ─────────────────────────────────────────────────────────────────────────────
// Quorum certificate assembly
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Form a QC from a set of votes. Rules (mirroring the reference tests):
 *   - votes must target THIS block hash at THIS height
 *   - duplicate voters are ignored (first valid vote wins)
 *   - non-committee votes are ignored
 *   - invalid signatures are ignored
 *   - fewer than `threshold` valid unique votes → null
 */
export function formQC(
  block: Block,
  votes: Iterable<Vote>,
  committee: string[],
  threshold: number,
): QC | null {
  const committeeSet = new Set(committee)
  const seen = new Set<string>()
  const valid: Vote[] = []

  for (const vote of votes) {
    if (vote.block_hash !== block.hash) continue
    if (vote.height !== block.header.height) continue
    if (!committeeSet.has(vote.voter)) continue
    if (seen.has(vote.voter)) continue
    if (!verifyVote(vote)) continue
    seen.add(vote.voter)
    valid.push(vote)
  }

  if (valid.length < threshold) return null

  return {
    block_hash: block.hash,
    height: block.header.height,
    committee_id: committeeId(block.header.height, committee),
    threshold,
    votes: valid,
  }
}

/** Verify a QC against a committee definition and the expected threshold. */
export function verifyQC(qc: QC, block: Block, committee: string[], threshold: number): boolean {
  if (qc.block_hash !== block.hash) return false
  if (qc.height !== block.header.height) return false
  if (qc.threshold !== threshold) return false
  // Re-derive validity from scratch — never trust the QC's own claims.
  return formQC(block, qc.votes, committee, threshold) !== null
}
