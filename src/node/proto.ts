/**
 * aequdash — src/node/proto.ts
 *
 * Wire protocol types for the ephemeral testnet mesh.
 * Everything that crosses a TCP socket or a process boundary is declared here.
 *
 * Frame format (TCP): [4-byte big-endian length][UTF-8 JSON payload].
 * JSON-RPC (stdio, gateway↔TUI): one JSON object per line, newline-delimited.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Transactions (consensus-replicated)
// ─────────────────────────────────────────────────────────────────────────────

export type TxKind =
  | "join"            // member joins with deposit
  | "exit_member"     // member leaves
  | "withdraw"        // member external withdrawal (30d window enforced)
  | "create_net"      // create network
  | "join_net"        // member joins network
  | "transfer_net"    // member moves network
  | "create_bus"      // create business
  | "set_ec"          // set contribution rate
  | "hire"            // hire member into business
  | "bus_withdraw"    // business withdrawal (owner only)
  | "create_pledge"   // create pledge
  | "support"         // support pledge
  | "node_register"   // register payment account
  | "node_pay"        // payment between accounts

export interface Tx {
  /** Deterministic id: sha256(canonical({kind, actor, payload, clientTs, nonce})) */
  id: string
  kind: TxKind
  actor: string
  payload: Record<string, unknown>
  /** Client-side submission time (ms). Commit time is the block's timestamp. */
  clientTs: number
  /** Per-actor monotonic nonce, prevents id collisions on identical payloads. */
  nonce: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Blocks & consensus
// ─────────────────────────────────────────────────────────────────────────────

export interface BlockHeader {
  height: number
  prev_hash: string
  ts: number                 // proposer-assigned commit time — identical on all nodes
  proposer: string           // node id of proposer
  tx_root: string            // merkle root of committed txs
  state_root: string         // hash of post-state (ledger canonical digest)
  roster: string[]           // live validator roster the proposer used (sorted)
}

export interface Block {
  header: BlockHeader
  txs: Tx[]
  hash: string               // sha256 of canonical header
}

export interface Vote {
  height: number
  block_hash: string
  voter: string              // node id
  voter_pub: string          // Ed25519 public key (base64url)
  sig: string                // Ed25519 signature over canonical {height, block_hash, voter}
}

export interface QC {
  block_hash: string
  height: number
  committee_id: string       // "cmt-{height}-{rosterdigest}"
  threshold: number
  votes: Vote[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Peer-to-peer messages
// ─────────────────────────────────────────────────────────────────────────────

export interface PeerInfo {
  id: string
  host: string
  port: number
  pub: string
}

export type MeshMessage =
  | { type: "hello"; id: string; host: string; port: number; pub: string; height: number; state_root: string; genesis_hash: string; roster: string[]; tip_hash?: string; auth?: string }
  | { type: "hello_ack"; id: string; host: string; port: number; pub: string; height: number; state_root: string; roster: string[]; tip_hash?: string; auth?: string }
  | { type: "ping"; id: string; ts: number; height: number; state_root: string; roster: string[]; tip_hash?: string }
  | { type: "pong"; id: string; ts: number; height: number; state_root: string; roster: string[]; tip_hash?: string }
  | { type: "tx"; tx: Tx }
  | { type: "proposal"; block: Block; sig: string; pub: string }
  | { type: "vote"; vote: Vote }
  | { type: "commit"; block: Block; qc: QC }
  | { type: "sync_request"; from_height: number }
  | { type: "sync_response"; blocks: Block[]; qcs: QC[] }
  | { type: "bye"; id: string }

// ─────────────────────────────────────────────────────────────────────────────
// Cluster / gateway reporting
// ─────────────────────────────────────────────────────────────────────────────

export interface NodeInfo {
  id: string
  label: string
  host: string
  port: number
  status: "live" | "down"
  height: number
  state_root: string
  peers: number
  uptime_s: number
  version: string
}

export interface ClusterInfo {
  self_id: string
  mesh_size: number           // live nodes including self
  all_converged: boolean      // every live node shares our state root
  nodes: NodeInfo[]
}

export const PROTOCOL_VERSION = "aeqnet/1"
export const NODE_VERSION = "0.9.0"
