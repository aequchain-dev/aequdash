#!/usr/bin/env bun
/**
 * aequdash — src/node/gateway.ts
 *
 * aeqnet gateway — the TUI's front door to the ephemeral testnet mesh.
 *
 * Responsibilities:
 *   - Hosts node-1 IN-PROCESS (full validator)
 *   - Spawns node-2 … node-N as daemon processes (piped stdio control)
 *   - Forms the TCP mesh: daemons seed from node-1; node-1 dials daemons
 *     back as their bound ports are announced
 *   - Serves JSON-RPC over stdio (newline-delimited):
 *       state.snapshot.v2 | state.snapshot | cli.run | net.nodes | shutdown
 *   - Emits live activity as JSON-RPC notifications:
 *       {"jsonrpc":"2.0","method":"activity","params":{...event}}
 *   - Enforces EPHEMERALITY: when the live node count reaches zero, all
 *     state is wiped. Nothing is ever written to disk.
 *
 * Protocol handshake: prints `rpc: hello — aeqnet gateway ready` when the
 * mesh is up (the TUI bridge keys on this line).
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { AequNode } from "./node.ts"
import { demoSeedTxs } from "./genesis.ts"
import { buildSnapshot } from "./snapshot.ts"
import { NODE_VERSION, type ClusterInfo } from "./proto.ts"
import type { ActivityEvent } from "../lib/types.ts"

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

interface GatewayConfig {
  nodeCount: number
  host: string
  basePort: number
  committeeSize: number
  threshold: number | null
  epochSeed: string
  blockTimeMs: number
  roundTimeoutMs: number
  clusterId: string
  meshTimeoutMs: number
  autoSeed: boolean
}

function parseArgs(argv: string[]): GatewayConfig {
  const cfg: GatewayConfig = {
    nodeCount: 3,
    host: "127.0.0.1",
    basePort: 7920,
    committeeSize: 3,
    threshold: null,
    epochSeed: "42",
    blockTimeMs: 1_500,
    roundTimeoutMs: 4_000,
    clusterId: `aeqnet-${Math.random().toString(36).slice(2, 10)}`,
    meshTimeoutMs: 15_000,
    autoSeed: true,
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    const next = argv[i + 1]
    switch (a) {
      case "--nodes": cfg.nodeCount = Math.max(1, parseInt(next!, 10)); i++; break
      case "--host": cfg.host = next!; i++; break
      case "--port": cfg.basePort = parseInt(next!, 10); i++; break
      case "--committee": cfg.committeeSize = parseInt(next!, 10); i++; break
      case "--threshold": cfg.threshold = parseInt(next!, 10); i++; break
      case "--epoch-seed": cfg.epochSeed = next!; i++; break
      case "--block-time": cfg.blockTimeMs = parseInt(next!, 10); i++; break
      case "--round-timeout": cfg.roundTimeoutMs = parseInt(next!, 10); i++; break
      case "--cluster": cfg.clusterId = next!; i++; break
      case "--no-seed": cfg.autoSeed = false; break
    }
  }
  return cfg
}

const cfg = parseArgs(process.argv)

// ─────────────────────────────────────────────────────────────────────────────
// Daemon process management
// ─────────────────────────────────────────────────────────────────────────────

interface DaemonHandle {
  id: string
  proc: ChildProcessWithoutNullStreams
  port: number
  nodeRunning: boolean
  stdoutBuf: string
}

const daemons = new Map<string, DaemonHandle>()
let daemonRpcId = 1
const daemonPending = new Map<number, { resolve: (v: unknown) => void }>()

function daemonScript(): string {
  return new URL("./daemon.ts", import.meta.url).pathname
}

async function spawnDaemon(id: string): Promise<DaemonHandle> {
  const argv = [
    "run", daemonScript(),
    "--id", id,
    "--host", cfg.host,
    "--port", "0",                        // auto-assign; announced on ready
    "--seed", `${cfg.host}:${node1?.boundPort ?? cfg.basePort}`,
    "--cluster", cfg.clusterId,
    "--committee", String(cfg.committeeSize),
    "--epoch-seed", cfg.epochSeed,
    "--block-time", String(cfg.blockTimeMs),
    "--round-timeout", String(cfg.roundTimeoutMs),
  ]
  if (cfg.threshold !== null) argv.push("--threshold", String(cfg.threshold))

  const proc = spawn("bun", argv, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  }) as ChildProcessWithoutNullStreams

  const handle: DaemonHandle = { id, proc, port: 0, nodeRunning: false, stdoutBuf: "" }
  daemons.set(id, handle)

  proc.stdout.setEncoding("utf8")
  proc.stdout.on("data", (chunk: string) => {
    handle.stdoutBuf += chunk
    let nl: number
    while ((nl = handle.stdoutBuf.indexOf("\n")) >= 0) {
      const line = handle.stdoutBuf.slice(0, nl).trim()
      handle.stdoutBuf = handle.stdoutBuf.slice(nl + 1)
      if (!line) continue
      try {
        const msg = JSON.parse(line)
        if (msg.ready === true && typeof msg.port === "number") {
          handle.port = msg.port
          handle.nodeRunning = true
          onDaemonReady(handle)
        } else if (typeof msg.id === "number" && daemonPending.has(msg.id)) {
          daemonPending.get(msg.id)!.resolve(msg.result)
          daemonPending.delete(msg.id)
        }
      } catch { /* not JSON — ignore */ }
    }
  })
  proc.stderr.on("data", (chunk: string) => {
    for (const line of String(chunk).split("\n")) {
      if (line.trim()) emitLog(`daemon ${id}: ${line.trim()}`, "warn")
    }
  })
  proc.on("exit", () => {
    handle.nodeRunning = false
    handle.port = 0
    emitActivity("daemon_exit", `Daemon ${id} exited`, "warn", [])
  })

  return handle
}

function daemonCall(handle: DaemonHandle, op: string, params?: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve) => {
    const id = daemonRpcId++
    daemonPending.set(id, { resolve })
    try {
      handle.proc.stdin.write(JSON.stringify({ id, op, params }) + "\n")
    } catch {
      daemonPending.delete(id)
      resolve(null)
    }
    setTimeout(() => {
      if (daemonPending.delete(id)) resolve(null)
    }, 10_000)
  })
}

function onDaemonReady(handle: DaemonHandle): void {
  emitActivity("node_live", `Node ${handle.id} live on ${cfg.host}:${handle.port}`, "success", [
    { k: "port", v: String(handle.port) },
  ])
  // Cross-connect: node-1 dials the new daemon so the mesh completes
  if (node1?.mesh && node1.running) {
    void node1.mesh.dial(cfg.host, handle.port)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Node-1 (in-process validator)
// ─────────────────────────────────────────────────────────────────────────────

let node1: AequNode | null = null
const activityLog: ActivityEvent[] = []
const ACTIVITY_CAP = 500
let currentUser = "aelith"
let commandNonce = 0

function buildNode1(port?: number): AequNode {
  const node = new AequNode({
    nodeId: "aeqnode-01",
    host: cfg.host,
    port: port ?? cfg.basePort,
    seeds: [],
    clusterId: cfg.clusterId,
    committeeSize: cfg.committeeSize,
    thresholdOverride: cfg.threshold,
    epochSeed: cfg.epochSeed,
    blockTimeMs: cfg.blockTimeMs,
    roundTimeoutMs: cfg.roundTimeoutMs,
    maxTxPerBlock: 256,
    seedTxs: cfg.autoSeed ? demoSeedTxs() : [],
    bootstrap: cfg.autoSeed,
  })
  node.on("activity", (ev: ActivityEvent) => emitActivity(ev.tag, ev.message, ev.level, ev.fields))
  return node
}

function emitActivity(tag: string, message: string, level: ActivityEvent["level"] = "info", fields: { k: string; v: string }[] = []): void {
  const ev: ActivityEvent = {
    ts: new Date(Date.now()).toISOString(),
    level, tag, message, fields,
  }
  activityLog.push(ev)
  if (activityLog.length > ACTIVITY_CAP) activityLog.shift()
  notify("activity", ev)
}

function emitLog(message: string, level: ActivityEvent["level"] = "info"): void {
  emitActivity("gateway", message, level, [])
}

// ─────────────────────────────────────────────────────────────────────────────
// Command execution — cli.run
// ─────────────────────────────────────────────────────────────────────────────

interface CommandResult {
  ok: boolean
  message: string
  snapshot?: unknown
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

async function runTxCommand(command: string, actor: string, payload: Record<string, unknown>): Promise<CommandResult> {
  if (!node1 || !node1.running) return { ok: false, message: "node not running" }
  const nonce = Date.now() * 1000 + (commandNonce++ % 1000)
  try {
    const tx = node1.submitTx(command as never, actor, payload, Date.now(), nonce)
    emitActivity("tx_submit", `${command} submitted by ${actor}`, "info", [{ k: "tx", v: tx.id.slice(0, 12) }])
    const committed = await waitForCommit(node1, tx.id)
    if (!committed) return { ok: false, message: `${command}: commit timeout` }
    return { ok: true, message: `${command} committed`, snapshot: currentSnapshot() }
  } catch (e) {
    return { ok: false, message: (e as Error).message }
  }
}

async function cliRun(command: string, args: string[]): Promise<CommandResult> {
  const cmd = command.toLowerCase()
  const actor = currentUser || "founder"

  switch (cmd) {
    // ── Session (local, not replicated) ──
    case "login": {
      const id = args[0]
      if (!id) return { ok: false, message: "usage: login <member_id>" }
      if (!node1?.ledger.members.has(id)) return { ok: false, message: `no such member: ${id}` }
      currentUser = id
      emitActivity("auth", `Logged in as ${id}`, "success")
      return { ok: true, message: `logged in as ${id}`, snapshot: currentSnapshot() }
    }
    case "logout": {
      currentUser = ""
      emitActivity("auth", "Logged out", "info")
      return { ok: true, message: "logged out", snapshot: currentSnapshot() }
    }

    // ── Member ops (replicated) ──
    case "join": {
      const [id, deposit] = args
      if (!id) return { ok: false, message: "usage: join <id> [deposit]" }
      return runTxCommand("join", "system", { id, deposit: deposit ?? "0", region: "Unspecified", status: "active" })
    }
    case "exit_member": {
      if (!args[0]) return { ok: false, message: "usage: exit_member <id>" }
      return runTxCommand("exit_member", "system", { id: args[0] })
    }
    case "withdraw": {
      const [id, amount, ...rest] = args
      if (!id || !amount) return { ok: false, message: "usage: withdraw <id> <amount> [purpose]" }
      return runTxCommand("withdraw", id, { id, amount, purpose: rest.join(" ") || "withdrawal" })
    }

    // ── Networks ──
    case "create_net": {
      const [name, denom, rate] = args
      if (!name || !denom || !rate) return { ok: false, message: "usage: create_net <name> <denom> <rate>" }
      return runTxCommand("create_net", actor, { name, denom, rate })
    }
    case "join_net": {
      const [member, net] = args
      if (!member || !net) return { ok: false, message: "usage: join_net <member> <net>" }
      return runTxCommand("join_net", actor, { member, net })
    }
    case "transfer_net": {
      const [member, from, to] = args
      if (!member || !from || !to) return { ok: false, message: "usage: transfer_net <member> <from> <to>" }
      return runTxCommand("transfer_net", actor, { member, from, to })
    }

    // ── Businesses ──
    case "create_bus": {
      const [name, net, ec] = args
      if (!name || !net) return { ok: false, message: "usage: create_bus <name> <net> [ec]" }
      return runTxCommand("create_bus", actor, { name, net, ec: ec ?? "0.02" })
    }
    case "set_ec": {
      const [bus, rate] = args
      if (!bus || !rate) return { ok: false, message: "usage: set_ec <bus> <rate>" }
      return runTxCommand("set_ec", actor, { bus, rate })
    }
    case "hire": {
      const [bus, member] = args
      if (!bus || !member) return { ok: false, message: "usage: hire <bus> <member>" }
      return runTxCommand("hire", actor, { bus, member })
    }
    case "bus_withdraw": {
      const [bus, amount, ...rest] = args
      if (!bus || !amount) return { ok: false, message: "usage: bus_withdraw <bus> <amount> [purpose]" }
      return runTxCommand("bus_withdraw", actor, { bus, amount, purpose: rest.join(" ") || "business withdrawal" })
    }

    // ── Pledges ──
    case "create_pledge": {
      const [name, target, net, ...rest] = args
      if (!name || !target || !net) return { ok: false, message: "usage: create_pledge <name> <target> <net> [purpose]" }
      return runTxCommand("create_pledge", actor, { name, target, net, purpose: rest.join(" ") || "—", category: "Other" })
    }
    case "support": {
      const [pledge, amount] = args
      if (!pledge || !amount) return { ok: false, message: "usage: support <pledge> <amount>" }
      return runTxCommand("support", actor, { pledge, amount })
    }

    // ── Payment layer ──
    case "node_register": {
      const [account, balance] = args
      if (!account || !balance) return { ok: false, message: "usage: node_register <account> <balance>" }
      return runTxCommand("node_register", actor, { account, balance })
    }
    case "node_pay": {
      const [from, to, amount] = args
      if (!from || !to || !amount) return { ok: false, message: "usage: node_pay <from> <to> <amount>" }
      return runTxCommand("node_pay", actor, { from, to, amount })
    }

    // ── Cluster lifecycle (gateway-local) ──
    case "node_init": {
      // Reconfigure committee/threshold — requires cluster restart
      return { ok: false, message: "node_init: restart the TUI with AEQUCHAIN_NODES/committee env to reconfigure (ephemeral mesh boots pre-configured)" }
    }
    case "node_stop": {
      const id = args[0]
      if (!id) return { ok: false, message: "usage: node_stop <node_id>" }
      return stopNode(id)
    }
    case "node_start": {
      const id = args[0]
      if (!id) return { ok: false, message: "usage: node_start <node_id>" }
      return startNode(id)
    }
    case "net_nodes": {
      const info = clusterInfo()
      return { ok: true, message: `${info.mesh_size} live node(s): ${info.nodes.map((n) => n.id).join(", ")}`, snapshot: currentSnapshot() }
    }
    case "node_reset":
    case "reset": {
      return resetCluster()
    }

    // ── Reports (computed live from state) ──
    case "node_status": {
      const n = node1
      if (!n) return { ok: false, message: "node not running" }
      return {
        ok: true,
        message: `height ${n.height} · peers ${n.mesh?.peerCount() ?? 0} · accounts ${n.ledger.accounts.size} · mempool ${n.mempool.size}`,
        snapshot: currentSnapshot(),
      }
    }
    case "equality_check": {
      const eq = node1?.ledger.equalityReport()
      if (!eq) return { ok: false, message: "node not running" }
      emitActivity("equality_check", eq.allPassed ? "Equidistribution check passed" : "EQUALITY VIOLATION", eq.allPassed ? "success" : "error", [
        { k: "members", v: String(eq.totalMembers) },
        { k: "variance", v: String(eq.variance) },
      ])
      return { ok: eq.allPassed, message: eq.allPassed ? `equality verified for ${eq.totalMembers} members` : "EQUALITY VIOLATION", snapshot: currentSnapshot() }
    }
    case "consensus_test": {
      const snap = currentSnapshot()
      const c = snap?.consensus
      if (!c) return { ok: false, message: "node not running" }
      emitActivity("consensus_test", c.passed ? "Consensus healthy" : "CONSENSUS DEGRADED", c.passed ? "success" : "error", [
        { k: "committee", v: String(c.committee_size) },
        { k: "round", v: String(c.round) },
      ])
      return { ok: c.passed, message: c.passed ? "consensus healthy" : "consensus degraded", snapshot: snap }
    }

    case "demo":
    case "status": {
      const s = currentSnapshot()
      return {
        ok: true,
        message: `${s?.members_summary?.total_registered ?? 0} members · height ${s?.block_height ?? 0} · ${clusterInfo().mesh_size} nodes`,
        snapshot: s,
      }
    }
    case "help": {
      const mesh = clusterInfo()
      emitActivity("help", "Command help", "info", [
        { k: "mesh", v: `${mesh.mesh_size} nodes` },
      ])
      return {
        ok: true,
        message: "identity: login/logout/join/withdraw · networks: create_net/join_net/transfer_net · business: create_bus/hire/bus_withdraw · pledges: create_pledge/support · mesh: node_stop/node_start/net_nodes/reset · checks: equality_check/consensus_test · exit: kill",
        snapshot: currentSnapshot(),
      }
    }

    default:
      return { ok: false, message: `unknown command: ${cmd}` }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cluster lifecycle & ephemerality
// ─────────────────────────────────────────────────────────────────────────────

async function stopNode(id: string): Promise<CommandResult> {
  if (id === "aeqnode-01") {
    if (!node1?.running) return { ok: false, message: `${id} already stopped` }
    await node1.stop()
    emitActivity("node_stop", "Node aeqnode-01 stopped", "warn")
    await checkMeshEmptiness()
    return { ok: true, message: `${id} stopped`, snapshot: currentSnapshot() }
  }
  const d = daemons.get(id)
  if (!d) return { ok: false, message: `no such node: ${id}` }
  await daemonCall(d, "stop")
  d.nodeRunning = false
  emitActivity("node_stop", `Node ${id} stopped`, "warn")
  await checkMeshEmptiness()
  return { ok: true, message: `${id} stopped`, snapshot: currentSnapshot() }
}

async function startNode(id: string): Promise<CommandResult> {
  if (id === "aeqnode-01") {
    if (node1?.running) return { ok: false, message: `${id} already running` }
    await startNode1()
    // Re-dial all live daemons
    for (const d of daemons.values()) if (d.nodeRunning && d.port) await node1!.mesh?.dial(cfg.host, d.port)
    node1!.enableConsensus()
    return { ok: true, message: `${id} started`, snapshot: currentSnapshot() }
  }
  const d = daemons.get(id)
  if (!d) return { ok: false, message: `no such node: ${id}` }
  if (d.nodeRunning) return { ok: false, message: `${id} already running` }
  const res = await daemonCall(d, "start") as { ok?: boolean; port?: number } | null
  d.nodeRunning = true
  if (res?.port) d.port = res.port
  // Cross-link: node-1 dials the (re)started daemon, then unpause it
  if (node1?.running && d.port) await node1.mesh?.dial(cfg.host, d.port)
  await daemonCall(d, "unpause")
  return { ok: true, message: `${id} started`, snapshot: currentSnapshot() }
}

/** THE EPHEMERALITY RULE: when no live nodes remain, wipe everything. */
async function checkMeshEmptiness(): Promise<void> {
  const liveDaemons = [...daemons.values()].filter((d) => d.nodeRunning).length
  const live = (node1?.running ? 1 : 0) + liveDaemons
  if (live === 0) {
    emitActivity("mesh_empty", "All nodes stopped — ephemeral state wiped", "warn")
    if (node1) await node1.destroy()
    node1 = null
    // Wipe daemon-side state too (processes stay alive for restart)
    for (const d of daemons.values()) {
      await daemonCall(d, "destroy")
      d.port = 0
    }
    activityLog.length = 0
    currentUser = ""
  }
}

async function resetCluster(): Promise<CommandResult> {
  emitActivity("cluster_reset", "Resetting mesh to genesis", "warn")
  // Destroy every node
  for (const d of daemons.values()) {
    await daemonCall(d, "destroy")
    d.nodeRunning = false
  }
  if (node1) await node1.destroy()

  // Recreate node-1 fresh
  await startNode1()

  // Restart daemons (fresh state, re-mesh) — refresh bound ports from responses
  for (const d of daemons.values()) {
    const res = await daemonCall(d, "start") as { ok?: boolean; port?: number } | null
    d.nodeRunning = true
    if (res?.port) d.port = res.port
    if (node1?.running && d.port) await node1.mesh?.dial(cfg.host, d.port)
  }
  // Unpause everyone once re-meshed
  node1?.enableConsensus()
  for (const d of daemons.values()) await daemonCall(d, "unpause")
  return { ok: true, message: "cluster reset to genesis", snapshot: currentSnapshot() }
}

function clusterInfo(): ClusterInfo {
  if (node1 && node1.running) return node1.clusterInfo()
  // node-1 down: report from daemon status knowledge
  const nodes = [...daemons.values()]
    .filter((d) => d.nodeRunning)
    .map((d) => ({
      id: d.id, label: d.id, host: cfg.host, port: d.port,
      status: "live" as const, height: 0, state_root: "",
      peers: 0, uptime_s: 0, version: NODE_VERSION,
    }))
  return { self_id: "gateway", mesh_size: nodes.length, all_converged: true, nodes }
}

function currentSnapshot(): import("../lib/types.ts").SnapshotV2 | null {
  if (!node1) return null
  return buildSnapshot(node1, currentUser, [...activityLog])
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON-RPC stdio server (newline-delimited)
// ─────────────────────────────────────────────────────────────────────────────

function respond(id: number, result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n")
}

function respondError(id: number, message: string): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message } }) + "\n")
}

function notify(method: string, params: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n")
}

async function handleRpc(id: number, method: string, params: unknown): Promise<void> {
  try {
    switch (method) {
      case "state.snapshot":
      case "state.snapshot.v2": {
        respond(id, currentSnapshot())
        return
      }
      case "cli.run": {
        const p = params as { command?: string; args?: string[] }
        const result = await cliRun(String(p.command ?? ""), Array.isArray(p.args) ? p.args.map(String) : [])
        respond(id, result)
        return
      }
      case "net.nodes": {
        respond(id, clusterInfo())
        return
      }
      case "shutdown": {
        respond(id, { ok: true })
        setTimeout(() => void shutdown(0), 25)
        return
      }
      default:
        respondError(id, `unknown method: ${method}`)
    }
  } catch (e) {
    respondError(id, (e as Error).message)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

let shuttingDown = false

async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  try { await node1?.destroy() } catch {}
  for (const d of daemons.values()) {
    try {
      await daemonCall(d, "shutdown")
    } catch { /* ignore */ }
    try { d.proc.kill("SIGTERM") } catch { /* ignore */ }
  }
  // Hard-kill stragglers after a grace period
  setTimeout(() => {
    for (const d of daemons.values()) { try { d.proc.kill("SIGKILL") } catch {} }
    process.exit(code)
  }, 500)
  // If all daemons exited cleanly, exit sooner
  const check = setInterval(() => {
    if ([...daemons.values()].every((d) => d.proc.exitCode !== null || d.proc.killed)) {
      clearInterval(check)
      process.exit(code)
    }
  }, 100)
}

/** Start node-1 with port-in-use retry (zombie-proof). */
async function startNode1(): Promise<void> {
  let lastErr: Error | null = null
  for (let port = cfg.basePort; port < cfg.basePort + 25; port++) {
    node1 = buildNode1(port)
    try {
      await node1.start()
      return
    } catch (e) {
      lastErr = e as Error
      if (!/EADDRINUSE|address.*in use|listen/i.test(lastErr.message)) throw e
      node1 = null
    }
  }
  throw lastErr ?? new Error("could not bind node-1")
}

async function boot(): Promise<void> {
  // 1. Start node-1 (in-process) — it binds first so daemons can seed from it.
  await startNode1()
  emitLog(`node-1 listening on ${cfg.host}:${node1!.boundPort}`, "info")

  // 2. Spawn daemons (node-2 … node-N)
  for (let i = 2; i <= cfg.nodeCount; i++) {
    const id = `aeqnode-${String(i).padStart(2, "0")}`
    try {
      await spawnDaemon(id)
    } catch (e) {
      emitLog(`failed to spawn ${id}: ${(e as Error).message}`, "error")
    }
  }

  // 3. Wait for mesh formation (all daemons ready + node-1 sees them)
  const n1 = node1!
  const deadline = Date.now() + cfg.meshTimeoutMs
  while (Date.now() < deadline) {
    const ready = [...daemons.values()].filter((d) => d.nodeRunning).length
    const meshPeers = n1.mesh?.peerCount() ?? 0
    if (ready === cfg.nodeCount - 1 && meshPeers >= cfg.nodeCount - 1) break
    await new Promise((r) => setTimeout(r, 100))
  }

  const mesh = clusterInfo()
  emitLog(`mesh formed: ${mesh.mesh_size} live node(s) [${mesh.nodes.map((n) => n.id).join(", ")}]`, "success")

  // 4. Full-mesh wiring: daemons dial EACH OTHER (not just node-1), so every
  //    node is directly visible to every other node.
  const liveDaemons = [...daemons.values()].filter((d) => d.nodeRunning && d.port > 0)
  for (const a of liveDaemons) {
    for (const b of liveDaemons) {
      if (a.id < b.id) await daemonCall(a, "dial", { host: cfg.host, port: b.port })
    }
  }

  // 5. Unpause consensus across the now-stable mesh
  n1.enableConsensus()
  for (const d of daemons.values()) {
    if (d.nodeRunning) await daemonCall(d, "unpause")
  }
  emitLog("consensus enabled on all live nodes", "success")

  // 6. Wait for the genesis block to commit — "ready" means the chain is
  //    LIVE AND POPULATED, not merely started. (Seeded mode only.)
  if (cfg.autoSeed) {
    const genesisDeadline = Date.now() + 60_000
    while (node1 && node1.height < 1 && Date.now() < genesisDeadline) {
      await new Promise((r) => setTimeout(r, 200))
    }
    if (node1 && node1.height >= 1) {
      emitLog(`genesis committed at height 1 — ${node1.ledger.memberCount()} members, treasury ${node1.ledger.treasury.toFixed(2)} AEQ`, "success")
    } else {
      emitLog("WARNING: genesis did not commit within 60s — check mesh health", "warn")
    }
  }

  // 7. Announce readiness (bridge keys on this line)
  process.stdout.write(`rpc: hello — aeqnet gateway ready (nodes=${mesh.mesh_size}, committee=${cfg.committeeSize}, version=${NODE_VERSION})\n`)
}

// stdin loop
let buf = ""
process.stdin.on("data", (chunk) => {
  buf += chunk
  let nl: number
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let req: { id?: number; method?: string; params?: unknown }
    try {
      req = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof req.id === "number" && typeof req.method === "string") {
      void handleRpc(req.id, req.method, req.params)
    }
  }
})

process.on("SIGTERM", () => void shutdown(0))
process.on("SIGINT", () => void shutdown(0))
process.on("SIGHUP", () => void shutdown(0))
// ORPHAN-KILLER: if the TUI (our parent) dies for ANY reason, our stdin
// closes and the whole mesh comes down with us. Nothing outlives the TUI.
process.stdin.on("end", () => void shutdown(0))
process.stdin.on("close", () => void shutdown(0))

// Go.
boot().catch((e) => {
  process.stderr.write(`gateway boot failed: ${(e as Error).message}\n`)
  process.exit(1)
})
