/**
 * aequdash — src/node/block.ts
 *
 * Blocks, hashing, and Merkle roots for the ephemeral testnet.
 *
 * A block commits to its contents twice:
 *   - tx_root:    Merkle root over committed tx ids
 *   - state_root: canonical digest of the post-state ledger
 *
 * The block hash covers the header only; the header covers everything else.
 * prev_hash links to the parent — a single global chain, not a lattice.
 */

import { sha256hex, canonicalJson } from "./crypto.ts"
import type { Block, BlockHeader, Tx } from "./proto.ts"

export const ZERO_HASH = "0x" + "0".repeat(64)

// ─────────────────────────────────────────────────────────────────────────────
// Merkle root over tx ids
// ─────────────────────────────────────────────────────────────────────────────

export function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return sha256hex("aequchain:empty")
  let level = leaves.map((l) => sha256hex(l))
  while (level.length > 1) {
    const next: string[] = []
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i]
      const b = i + 1 < level.length ? level[i + 1] : level[i]
      next.push(sha256hex(a + b))
    }
    level = next
  }
  return level[0]
}

// ─────────────────────────────────────────────────────────────────────────────
// Block construction & hashing
// ─────────────────────────────────────────────────────────────────────────────

export function hashHeader(header: BlockHeader): string {
  return sha256hex(canonicalJson(header))
}

export function buildBlock(
  height: number,
  prevHash: string,
  ts: number,
  proposer: string,
  txs: Tx[],
  stateRoot: string,
  roster: string[],
): Block {
  const header: BlockHeader = {
    height,
    prev_hash: prevHash,
    ts,
    proposer,
    tx_root: merkleRoot(txs.map((t) => t.id)),
    state_root: stateRoot,
    roster: [...roster].sort(),
  }
  return { header, txs, hash: hashHeader(header) }
}

/**
 * Structural validation: shape, linkage, tx-root consistency.
 * Does NOT verify state transitions (that's the ledger's job) or votes
 * (that's consensus's job).
 */
export function validateBlockShape(block: Block, expectedHeight: number, expectedPrev: string): string | null {
  const h = block.header
  if (h.height !== expectedHeight) return `height ${h.height} != expected ${expectedHeight}`
  if (h.prev_hash !== expectedPrev) return "prev_hash mismatch"
  if (!Array.isArray(h.roster) || h.roster.length === 0) return "empty roster"
  if (h.roster.join("|") !== [...h.roster].sort().join("|")) return "roster not sorted"
  if (h.tx_root !== merkleRoot(block.txs.map((t) => t.id))) return "tx_root mismatch"
  if (block.hash !== hashHeader(h)) return "block hash mismatch"
  // tx ids must be unique within the block
  const seen = new Set<string>()
  for (const tx of block.txs) {
    if (seen.has(tx.id)) return `duplicate tx ${tx.id}`
    seen.add(tx.id)
  }
  return null
}

/** Deterministic tx id from its immutable fields. */
export function txId(tx: Omit<Tx, "id">): string {
  return sha256hex(canonicalJson({
    kind: tx.kind, actor: tx.actor, payload: tx.payload,
    clientTs: tx.clientTs, nonce: tx.nonce,
  }))
}

/** Construct a fully-formed tx with computed id. */
export function makeTx(kind: Tx["kind"], actor: string, payload: Record<string, unknown>, clientTs: number, nonce: number): Tx {
  const base = { kind, actor, payload, clientTs, nonce }
  return { id: txId(base), ...base }
}
