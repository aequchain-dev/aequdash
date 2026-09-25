/**
 * aequdash — src/node/commander.ts
 *
 * The command surface of a live aeqnet node, extracted from gateway.ts so
 * BOTH backends share one implementation:
 *
 *   - gateway.ts (--local N dev mesh): host = the daemon-owning cluster
 *   - solo.ts (default internet node): host = a single in-process AequNode
 *
 * A host provides: the node, a per-session snapshot builder, an activity
 * sink, a cluster view, and — OPTIONALLY — cluster lifecycle operations
 * (stop/start/reset). Solo mode implements those against its one node;
 * node_stop of a REMOTE peer is impossible by design (you can't stop
 * someone else's node), which is the honest answer for a real network.
 */

import type { AequNode } from "./node.ts"
import type { ClusterInfo } from "./proto.ts"
import type { ActivityEvent, SnapshotV2 } from "../lib/types.ts"

export interface CommandResult {
  ok: boolean
  message: string
  snapshot?: unknown
}

export interface CommanderSession {
  currentUser: string
}

export interface CommanderHost {
  node(): AequNode | null
  currentSnapshot(session: CommanderSession): SnapshotV2 | null
  emitActivity(tag: string, message: string, level?: ActivityEvent["level"], fields?: { k: string; v: string }[]): void
  clusterInfo(): ClusterInfo
  stopNode?(id: string, session: CommanderSession): Promise<CommandResult>
  startNode?(id: string, session: CommanderSession): Promise<CommandResult>
  resetCluster?(session: CommanderSession): Promise<CommandResult>
}

/** Wait until a tx id is committed to the chain (or timeout). */
function waitForCommit(node: AequNode, txId: string, timeoutMs = 20_000): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { cleanup(); resolve(false) }, timeoutMs)
    const onCommit = ({ block }: { block: { txs: { id: string }[] } }) => {
      if (block.txs.some((t) => t.id === txId)) { cleanup(); resolve(true) }
    }
    const cleanup = () => { clearTimeout(timer); node.off("commit", onCommit) }
    node.on("commit", onCommit)
  })
}

let commandNonce = 0

async function runTxCommand(
  host: CommanderHost,
  command: string,
  actor: string,
  payload: Record<string, unknown>,
  session: CommanderSession,
): Promise<CommandResult> {
  const node = host.node()
  if (!node || !node.running) return { ok: false, message: "node not running" }
  const nonce = Date.now() * 1000 + (commandNonce++ % 1000)
  try {
    const tx = node.submitTx(command as never, actor, payload, Date.now(), nonce)
    host.emitActivity("tx_submit", `${command} submitted by ${actor}`, "info", [{ k: "tx", v: tx.id.slice(0, 12) }])
    const committed = await waitForCommit(node, tx.id)
    if (!committed) return { ok: false, message: `${command}: commit timeout` }
    return { ok: true, message: `${command} committed`, snapshot: host.currentSnapshot(session) }
  } catch (e) {
    return { ok: false, message: (e as Error).message }
  }
}

const UNSUPPORTED_CLUSTER_OP = "not available on a solo node — you own only your own node (the mesh evaporates when the last peer exits)"

export async function runCliCommand(
  host: CommanderHost,
  command: string,
  args: string[],
  session: CommanderSession,
): Promise<CommandResult> {
  const cmd = command.toLowerCase()
  const actor = session.currentUser || "founder"

  switch (cmd) {
    // ── Session (local, not replicated) ──
    case "login": {
      const id = args[0]
      if (!id) return { ok: false, message: "usage: login <member_id>" }
      if (!host.node()?.ledger.members.has(id)) return { ok: false, message: `no such member: ${id}` }
      session.currentUser = id
      host.emitActivity("auth", `Logged in as ${id}`, "success")
      return { ok: true, message: `logged in as ${id}`, snapshot: host.currentSnapshot(session) }
    }
    case "logout": {
      session.currentUser = ""
      host.emitActivity("auth", "Logged out", "info")
      return { ok: true, message: "logged out", snapshot: host.currentSnapshot(session) }
    }

    // ── Member ops (replicated) ──
    case "join": {
      const [id, deposit] = args
      if (!id) return { ok: false, message: "usage: join <id> [deposit]" }
      return runTxCommand(host, "join", "system", { id, deposit: deposit ?? "0", region: "Unspecified", status: "active" }, session)
    }
    case "exit_member": {
      if (!args[0]) return { ok: false, message: "usage: exit_member <id>" }
      return runTxCommand(host, "exit_member", "system", { id: args[0] }, session)
    }
    case "withdraw": {
      const [id, amount, ...rest] = args
      if (!id || !amount) return { ok: false, message: "usage: withdraw <id> <amount> [purpose]" }
      return runTxCommand(host, "withdraw", id, { id, amount, purpose: rest.join(" ") || "withdrawal" }, session)
    }

    // ── Networks ──
    case "create_net": {
      const [name, denom, rate] = args
      if (!name || !denom || !rate) return { ok: false, message: "usage: create_net <name> <denom> <rate>" }
      return runTxCommand(host, "create_net", actor, { name, denom, rate }, session)
    }
    case "join_net": {
      const [member, net] = args
      if (!member || !net) return { ok: false, message: "usage: join_net <member> <net>" }
      return runTxCommand(host, "join_net", actor, { member, net }, session)
    }
    case "transfer_net": {
      const [member, from, to] = args
      if (!member || !from || !to) return { ok: false, message: "usage: transfer_net <member> <from> <to>" }
      return runTxCommand(host, "transfer_net", actor, { member, from, to }, session)
    }

    // ── Businesses ──
    case "create_bus": {
      const [name, net, ec] = args
      if (!name || !net) return { ok: false, message: "usage: create_bus <name> <net> [ec]" }
      return runTxCommand(host, "create_bus", actor, { name, net, ec: ec ?? "0.02" }, session)
    }
    case "set_ec": {
      const [bus, rate] = args
      if (!bus || !rate) return { ok: false, message: "usage: set_ec <bus> <rate>" }
      return runTxCommand(host, "set_ec", actor, { bus, rate }, session)
    }
    case "hire": {
      const [bus, member] = args
      if (!bus || !member) return { ok: false, message: "usage: hire <bus> <member>" }
      return runTxCommand(host, "hire", actor, { bus, member }, session)
    }
    case "bus_withdraw": {
      const [bus, amount, ...rest] = args
      if (!bus || !amount) return { ok: false, message: "usage: bus_withdraw <bus> <amount> [purpose]" }
      return runTxCommand(host, "bus_withdraw", actor, { bus, amount, purpose: rest.join(" ") || "business withdrawal" }, session)
    }

    // ── Pledges ──
    case "create_pledge": {
      const [name, target, net, ...rest] = args
      if (!name || !target || !net) return { ok: false, message: "usage: create_pledge <name> <target> <net> [purpose]" }
      return runTxCommand(host, "create_pledge", actor, { name, target, net, purpose: rest.join(" ") || "—", category: "Other" }, session)
    }
    case "support": {
      const [pledge, amount] = args
      if (!pledge || !amount) return { ok: false, message: "usage: support <pledge> <amount>" }
      return runTxCommand(host, "support", actor, { pledge, amount }, session)
    }

    // ── Payment layer ──
    case "node_register": {
      const [account, balance] = args
      if (!account || !balance) return { ok: false, message: "usage: node_register <account> <balance>" }
      return runTxCommand(host, "node_register", actor, { account, balance }, session)
    }
    case "node_pay": {
      const [from, to, amount] = args
      if (!from || !to || !amount) return { ok: false, message: "usage: node_pay <from> <to> <amount>" }
      return runTxCommand(host, "node_pay", actor, { from, to, amount }, session)
    }

    // ── Cluster lifecycle (host-dependent) ──
    case "node_init": {
      return { ok: false, message: "node_init: restart with AEQUCHAIN_NODES/committee env to reconfigure (ephemeral mesh boots pre-configured)" }
    }
    case "node_stop": {
      const id = args[0]
      if (!id) return { ok: false, message: "usage: node_stop <node_id>" }
      if (!host.stopNode) return { ok: false, message: UNSUPPORTED_CLUSTER_OP }
      return host.stopNode(id, session)
    }
    case "node_start": {
      const id = args[0]
      if (!id) return { ok: false, message: "usage: node_start <node_id>" }
      if (!host.startNode) return { ok: false, message: UNSUPPORTED_CLUSTER_OP }
      return host.startNode(id, session)
    }
    case "net_nodes": {
      const info = host.clusterInfo()
      return { ok: true, message: `${info.mesh_size} live node(s): ${info.nodes.map((n) => n.id).join(", ")}`, snapshot: host.currentSnapshot(session) }
    }
    case "node_reset":
    case "reset": {
      if (!host.resetCluster) return { ok: false, message: UNSUPPORTED_CLUSTER_OP }
      return host.resetCluster(session)
    }

    // ── Reports (computed live from state) ──
    case "node_status": {
      const n = host.node()
      if (!n) return { ok: false, message: "node not running" }
      return {
        ok: true,
        message: `height ${n.height} · peers ${n.mesh?.peerCount() ?? 0} · accounts ${n.ledger.accounts.size} · mempool ${n.mempool.size}`,
        snapshot: host.currentSnapshot(session),
      }
    }
    case "equality_check": {
      const eq = host.node()?.ledger.equalityReport()
      if (!eq) return { ok: false, message: "node not running" }
      host.emitActivity("equality_check", eq.allPassed ? "Equidistribution check passed" : "EQUALITY VIOLATION", eq.allPassed ? "success" : "error", [
        { k: "members", v: String(eq.totalMembers) },
        { k: "variance", v: String(eq.variance) },
      ])
      return { ok: eq.allPassed, message: eq.allPassed ? `equality verified for ${eq.totalMembers} members` : "EQUALITY VIOLATION", snapshot: host.currentSnapshot(session) }
    }
    case "consensus_test": {
      const snap = host.currentSnapshot(session)
      const c = snap?.consensus
      if (!c) return { ok: false, message: "node not running" }
      host.emitActivity("consensus_test", c.passed ? "Consensus healthy" : "CONSENSUS DEGRADED", c.passed ? "success" : "error", [
        { k: "committee", v: String(c.committee_size) },
        { k: "round", v: String(c.round) },
      ])
      return { ok: c.passed, message: c.passed ? "consensus healthy" : "consensus degraded", snapshot: snap }
    }

    case "demo":
    case "status": {
      const s = host.currentSnapshot(session)
      return {
        ok: true,
        message: `${s?.members_summary?.total_registered ?? 0} members · height ${s?.block_height ?? 0} · ${host.clusterInfo().mesh_size} nodes`,
        snapshot: s,
      }
    }
    case "help": {
      const mesh = host.clusterInfo()
      host.emitActivity("help", "Command help", "info", [
        { k: "mesh", v: `${mesh.mesh_size} nodes` },
      ])
      return {
        ok: true,
        message: "identity: login/logout/join/withdraw · networks: create_net/join_net/transfer_net · business: create_bus/hire/bus_withdraw · pledges: create_pledge/support · mesh: node_stop/node_start/net_nodes/reset · checks: equality_check/consensus_test · exit: kill",
        snapshot: host.currentSnapshot(session),
      }
    }

    default:
      return { ok: false, message: `unknown command: ${cmd}` }
  }
}
