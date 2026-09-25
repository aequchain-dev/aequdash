/**
 * aequdash — src/node/solo.ts
 *
 * Solo node backend — THE DEFAULT internet-first mode.
 *
 * One aequdash instance = ONE real AequNode, in-process. The TUI talks to
 * it directly (no gateway, no control socket, no daemon tree). The node
 * joins a shared mesh as a genuine consensus peer:
 *
 *   - first instance of a network bootstraps it (genesis anchor = "host")
 *   - later instances dial the invite/rendezvous endpoints and sync in
 *   - the host role DISSOLVES: roster gossip + rendezvous keepalive mean any
 *     live peer can seed new joins, so the creator exiting is a non-event
 *   - when the last peer exits, every byte of chain state is gone — state
 *     only ever lived in node RAM
 *
 * Implements the CommanderHost contract so the full command surface (login,
 * join, withdraw, create_net, …) works identically to the --local dev mesh.
 */

import os from "node:os"
import { AequNode } from "./node.ts"
import { demoSeedTxs } from "./genesis.ts"
import { buildSnapshot } from "./snapshot.ts"
import { RendezvousClient } from "./rendezvous.ts"
import { Registry } from "./registry.ts"
import { LanBeacon } from "./beacon.ts"
import { buildInvite } from "./invite.ts"
import {
  runCliCommand,
  type CommandResult,
  type CommanderHost,
  type CommanderSession,
} from "./commander.ts"
import { NODE_VERSION, type ClusterInfo } from "./proto.ts"
import type { ActivityEvent, SnapshotV2 } from "../lib/types.ts"

export interface SoloNodeConfig {
  nodeId: string
  clusterId: string
  host: string                    // mesh bind host ("0.0.0.0" for internet)
  port: number                    // mesh bind port (0 = auto-assign)
  advertiseHost?: string          // externally dialable host (defaults to bind host; 0.0.0.0 → best-guess LAN IP)
  seeds: { host: string; port: number }[]
  token: string | null            // invite-gated admission token (null = open net)
  peerTls?: { cert: string; key: string } | null   // TLS on all mesh links (peers must agree)
  bootstrap: boolean              // carry the deterministic genesis seed burst
  committeeSize: number
  threshold: number | null
  epochSeed: string
  blockTimeMs: number
  roundTimeoutMs: number
  rendezvous?: string[]           // rendezvous server(s) "host:port" (redundant: register to all, lookup merges)
  dialAssistMs?: number           // rendezvous re-lookup cadence (default 20s; 0 disables)
  /**
   * Local (same-machine) discovery: this instance tries to HOST a tiny
   * loopback registry on 127.0.0.1:<localRegistryPort>. First binder wins;
   * everyone else just uses it. If the host exits, another live instance
   * re-binds it on its next dial-assist tick — the local phone book
   * migrates to a survivor and repopulates via keepalives. Default true.
   */
  localRegistry?: boolean
  localRegistryPort?: number      // default 8930
  /** LAN discovery via UDP subnet broadcast beacons. Default true. */
  beacon?: boolean
  beaconPort?: number             // default 7921
  discoveryGraceMs: number        // anchor waits this long for peers before solo genesis
  autoSeed: boolean               // include the demo scenario in genesis
  /** Named-net invite emission: when both set, an invite code is printed to the activity feed. */
  inviteName?: string
  inviteRand?: string
}

const ACTIVITY_CAP = 500

/** Well-known loopback registry address — same-machine discovery, always on. */
export const LOCAL_REGISTRY_PORT = 8930
export function localRegistryAddr(port = LOCAL_REGISTRY_PORT): string {
  return `127.0.0.1:${port}`
}

export class SoloNodeBackend implements CommanderHost {
  readonly cfg: SoloNodeConfig
  private nodeInst: AequNode | null = null
  private rdv: RendezvousClient | null = null
  private activityLog: ActivityEvent[] = []
  private session: CommanderSession = { currentUser: "aelith" }
  private activitySink: (ev: ActivityEvent) => void = () => {}
  private dialAssistTimer: ReturnType<typeof setInterval> | null = null
  private inviteCode: string | null = null
  private endpoint: { host: string; port: number } | null = null
  private localRegistry: Registry | null = null
  private localRegistryServer: { port: number; stop: () => void } | null = null
  private beacon: LanBeacon | null = null

  /** The effective registry list: loopback first, then configured servers. */
  private rendezvousServers(): string[] {
    const loopback = this.cfg.localRegistry !== false
      ? [localRegistryAddr(this.cfg.localRegistryPort ?? LOCAL_REGISTRY_PORT)]
      : []
    return [...new Set([...loopback, ...(this.cfg.rendezvous ?? [])])]
  }

  constructor(cfg: SoloNodeConfig) {
    this.cfg = cfg
  }

  /** The bridge subscribes here for the TUI activity feed. */
  onActivity(fn: (ev: ActivityEvent) => void): void {
    this.activitySink = fn
    for (const ev of this.activityLog) fn(ev) // replay what happened pre-subscribe
  }

  emitActivity(tag: string, message: string, level: ActivityEvent["level"] = "info", fields: { k: string; v: string }[] = []): void {
    const ev: ActivityEvent = { ts: new Date(Date.now()).toISOString(), level, tag, message, fields }
    this.activityLog.push(ev)
    if (this.activityLog.length > ACTIVITY_CAP) this.activityLog.shift()
    this.activitySink(ev)
  }

  private buildNode(): AequNode {
    const node = new AequNode({
      nodeId: this.cfg.nodeId,
      host: this.cfg.host,
      port: this.cfg.port,
      seeds: this.cfg.seeds,
      clusterId: this.cfg.clusterId,
      committeeSize: this.cfg.committeeSize,
      thresholdOverride: this.cfg.threshold,
      epochSeed: this.cfg.epochSeed,
      blockTimeMs: this.cfg.blockTimeMs,
      roundTimeoutMs: this.cfg.roundTimeoutMs,
      maxTxPerBlock: 256,
      identity: this.nodeInst?.identity,       // keep our validator identity across restarts
      seedTxs: this.cfg.bootstrap && this.cfg.autoSeed ? demoSeedTxs() : [],
      bootstrap: this.cfg.bootstrap && this.cfg.autoSeed,
      token: this.cfg.token ?? undefined,
      peerTls: this.cfg.peerTls ?? undefined,
    })
    node.on("activity", (ev: ActivityEvent) => this.emitActivity(ev.tag, ev.message, ev.level, ev.fields))
    return node
  }

  /** Our dialable endpoint as others should see it. */
  private advertisedEndpoint(port: number): { host: string; port: number } {
    if (this.cfg.advertiseHost) return { host: this.cfg.advertiseHost, port }
    if (this.cfg.host !== "0.0.0.0" && this.cfg.host !== "::") return { host: this.cfg.host, port }
    return { host: guessOutboundHost(), port }
  }

  async start(): Promise<{ endpoint: { host: string; port: number } }> {
    this.nodeInst = this.buildNode()
    await this.nodeInst.start()
    const endpoint = this.advertisedEndpoint(this.nodeInst.boundPort)
    this.endpoint = endpoint
    this.emitActivity("node_live", `Node ${this.cfg.nodeId} live on ${endpoint.host}:${endpoint.port}`, "success", [
      { k: "net", v: this.cfg.clusterId },
      { k: "gated", v: this.cfg.token ? "yes" : "open" },
    ])

    // LOCAL DISCOVERY (same machine): try to host the loopback registry.
    // First instance binds it; later instances find it already running and
    // simply use it. If the host exits, a survivor re-binds on its next
    // dial-assist tick — the local phone book migrates and repopulates.
    if (this.cfg.localRegistry !== false) this.tryHostLocalRegistry()

    // Rendezvous client: ALWAYS runs (loopback registry is always in the
    // list), so zero-arg instances on one machine find each other with no
    // configuration whatsoever. Register + keepalive means LATER joiners
    // find us even after the original anchor leaves — "host exit" is a
    // non-event by construction.
    const servers = this.rendezvousServers()
    if (servers.length > 0) {
      this.rdv = new RendezvousClient({
        server: servers,
        clusterId: this.cfg.clusterId,
        endpoint,
        nodeId: this.cfg.nodeId,
        log: (msg) => this.emitActivity("rendezvous", msg, "warn"),
      })
      await this.rdv.start()
      this.emitActivity("rendezvous", `Registered with ${servers.length} registry/registries (${servers.join(", ")}) — 90s TTL keepalive`, "info")
      this.startDialAssist()
    }

    // LAN DISCOVERY (different machines, same subnet): UDP beacon.
    if (this.cfg.beacon !== false) {
      this.beacon = new LanBeacon({
        clusterId: this.cfg.clusterId,
        nodeId: this.cfg.nodeId,
        endpoint,
        port: this.cfg.beaconPort,
        onPeer: (host, port, fromNode) => {
          const mesh = this.nodeInst?.mesh
          if (!mesh) return
          const already = mesh.livePeers().some((p) => p.host === host && p.port === port)
          if (!already) {
            this.emitActivity("beacon", `LAN beacon from ${fromNode} — dialing ${host}:${port}`, "info")
            void mesh.dial(host, port)
          }
        },
        log: (msg) => this.emitActivity("beacon", msg, "warn"),
      })
      await this.beacon.start()
    }

    // Discovery grace: register FIRST (above), then wait a window for
    // simultaneous co-founders to connect, THEN open consensus. Two anchors
    // that discover each other during grace share one roster → one
    // deterministic block-1 proposer → no genesis fork. (A fork that still
    // slips through is healed by the tip-hash tiebreak in the node.)
    // Applies to joiners too: if every seed is dead, the network has
    // evaporated and this node re-anchors a FRESH chain for the same
    // cluster id — invites outlive state, never resurrect it.
    if (this.nodeInst.mesh && this.nodeInst.mesh.peerCount() === 0 && this.cfg.discoveryGraceMs > 0) {
      this.emitActivity("discovery", `Discovery grace: ${this.cfg.discoveryGraceMs}ms…`, "info")
      await new Promise((r) => setTimeout(r, this.cfg.discoveryGraceMs))
    }
    if (this.cfg.bootstrap) {
      this.emitActivity("bootstrap", this.nodeInst.mesh && this.nodeInst.mesh.peerCount() > 0
        ? `Peers present (${this.nodeInst.mesh.peerCount()}) — opening consensus`
        : "No peers discovered — anchoring genesis solo", "info")
    }

    // First-run honesty: alone after grace with no internet-layer discovery
    // configured? Say exactly how to be found, once, in the activity feed.
    const hasExternalDiscovery = (this.cfg.rendezvous ?? []).some(
      (s) => !s.startsWith("127.0.0.1:") && !s.startsWith("localhost"),
    )
    if ((this.nodeInst.mesh?.peerCount() ?? 0) === 0 && !hasExternalDiscovery) {
      this.emitActivity(
        "discovery_hint",
        "No peers on this machine or LAN. Internet discovery: run 'bun run rendezvous' on a reachable host, then AEQUCHAIN_RENDEZVOUS=HOST_IP:8930 on both sides — or share the invite from the Node screen (peer must be able to dial you).",
        "info",
      )
    }

    this.nodeInst.enableConsensus()

    // Named networks: surface the shareable invite in the activity feed.
    if (this.cfg.inviteName && this.cfg.inviteRand) {
      this.inviteCode = buildInvite({
        name: this.cfg.inviteName,
        rand: this.cfg.inviteRand,
        token: this.cfg.token,
        endpoints: [endpoint],
      })
      this.emitActivity("invite", `Share to join this network: ${this.inviteCode}`, "success", [
        { k: "net", v: this.cfg.clusterId },
      ])
    }
    return { endpoint }
  }

  /**
   * Dial-assist: periodically re-lookup the rendezvous and dial any endpoint
   * we aren't connected to. This is what heals a STALE INVITE (the listed
   * seeds are dead but the network lives on other peers) and what lets a
   * NATted node keep discovering public peers outbound — no inbound dial
   * ever needed on our side.
   */
  private startDialAssist(): void {
    if (!this.rdv) return
    const cadence = this.cfg.dialAssistMs ?? 20_000
    if (cadence <= 0) return
    this.dialAssistTimer = setInterval(() => { void this.dialAssist() }, cadence)
  }

  private async dialAssist(): Promise<void> {
    if (!this.nodeInst?.running || !this.nodeInst.mesh) return
    // Registry failover: if we don't host the local registry and it's gone
    // (its host exited), claim it — the local phone book must always exist
    // while at least one instance lives.
    if (this.cfg.localRegistry !== false && !this.localRegistryServer) {
      const probe = new RendezvousClient({
        server: localRegistryAddr(this.cfg.localRegistryPort ?? LOCAL_REGISTRY_PORT),
        clusterId: this.cfg.clusterId,
        endpoint: this.endpoint ?? { host: "127.0.0.1", port: 0 },
        nodeId: this.cfg.nodeId,
      })
      try {
        await probe.request({ op: "stats" }, 800)
      } catch {
        this.tryHostLocalRegistry()
      }
    }
    if (!this.rdv) return
    const endpoints = await this.rdv.lookup()
    const selfEp = this.endpoint
    for (const ep of endpoints) {
      if (selfEp && ep.host === selfEp.host && ep.port === selfEp.port) continue
      const already = this.nodeInst.mesh.livePeers().some((p) => p.host === ep.host && p.port === ep.port)
      if (!already) {
        this.emitActivity("dial_assist", `Dialing discovered peer ${ep.host}:${ep.port}`, "info")
        await this.nodeInst.mesh.dial(ep.host, ep.port)
      }
    }
  }

  /** Try to bind the loopback registry. Silent no-op if someone hosts it. */
  private tryHostLocalRegistry(): void {
    if (this.localRegistryServer) return
    const reg = new Registry({})
    const server = reg.listen("127.0.0.1", this.cfg.localRegistryPort ?? LOCAL_REGISTRY_PORT)
    if (server) {
      this.localRegistry = reg
      this.localRegistryServer = server
      this.emitActivity("registry", `Hosting the local discovery registry on 127.0.0.1:${server.port}`, "info")
      // A fresh registry starts EMPTY — re-register ourselves immediately
      // instead of waiting out the keepalive window.
      if (this.rdv) void this.rdv.announce()
    }
  }

  /** Invite + identity info for the TUI's Node screen (null code on non-named nets). */
  inviteInfo(): { code: string | null; endpoint: string; clusterId: string; gated: boolean } | null {
    if (!this.endpoint) return null
    return {
      code: this.inviteCode,
      endpoint: `${this.endpoint.host}:${this.endpoint.port}`,
      clusterId: this.cfg.clusterId,
      gated: this.cfg.token !== null,
    }
  }

  /** Height 0 after grace with peers present means: sync in progress. */
  get ready(): boolean {
    return this.nodeInst?.running ?? false
  }

  // ── CommanderHost ──────────────────────────────────────────────────────────

  node(): AequNode | null {
    return this.nodeInst
  }

  currentSnapshot(session: CommanderSession): SnapshotV2 | null {
    if (!this.nodeInst) return null
    return buildSnapshot(this.nodeInst, session.currentUser, [...this.activityLog])
  }

  /** Snapshot for the TUI's own session. */
  snapshot(): SnapshotV2 | null {
    return this.currentSnapshot(this.session)
  }

  clusterInfo(): ClusterInfo {
    if (this.nodeInst && this.nodeInst.running) return this.nodeInst.clusterInfo()
    return { self_id: this.cfg.nodeId, mesh_size: 0, all_converged: true, nodes: [] }
  }

  async stopNode(id: string, session: CommanderSession): Promise<CommandResult> {
    if (id !== this.cfg.nodeId) {
      return { ok: false, message: `you can only stop your OWN node (${this.cfg.nodeId}) — the mesh evaporates when the last peer exits` }
    }
    if (!this.nodeInst?.running) return { ok: false, message: `${id} already stopped` }
    await this.nodeInst.stop()
    this.emitActivity("node_stop", `Node ${id} stopped (peers see a graceful bye)`, "warn")
    return { ok: true, message: `${id} stopped`, snapshot: this.currentSnapshot(session) }
  }

  async startNode(id: string, session: CommanderSession): Promise<CommandResult> {
    if (id !== this.cfg.nodeId) {
      return { ok: false, message: `you can only start your OWN node (${this.cfg.nodeId})` }
    }
    if (this.nodeInst?.running) return { ok: false, message: `${id} already running` }
    if (!this.nodeInst) this.nodeInst = this.buildNode()
    await this.nodeInst.start()
    this.nodeInst.enableConsensus()
    return { ok: true, message: `${id} started (kept identity, re-syncing)`, snapshot: this.currentSnapshot(session) }
  }

  /** Local re-genesis: wipe OUR node and bootstrap again. Other peers' state is theirs. */
  async resetCluster(session: CommanderSession): Promise<CommandResult> {
    this.emitActivity("cluster_reset", "Re-genesis: wiping this node and re-anchoring", "warn")
    if (this.nodeInst) await this.nodeInst.destroy()
    this.nodeInst = this.buildNode()
    await this.nodeInst.start()
    this.nodeInst.enableConsensus()
    return { ok: true, message: "node re-anchored at genesis", snapshot: this.currentSnapshot(session) }
  }

  async cliRun(command: string, args: string[]): Promise<CommandResult> {
    return runCliCommand(this, command, args, this.session)
  }

  /** Ephemeral teardown: leave the registry, stop announcing, wipe every byte. */
  async shutdown(): Promise<void> {
    if (this.dialAssistTimer) { clearInterval(this.dialAssistTimer); this.dialAssistTimer = null }
    if (this.beacon) { try { await this.beacon.stop() } catch { /* ignore */ } ; this.beacon = null }
    if (this.rdv) { try { await this.rdv.stop() } catch { /* best-effort */ } ; this.rdv = null }
    if (this.localRegistryServer) { try { this.localRegistryServer.stop() } catch { /* ignore */ } ; this.localRegistryServer = null }
    if (this.localRegistry) { this.localRegistry.stop(); this.localRegistry = null }
    if (this.nodeInst) { try { await this.nodeInst.destroy() } catch { /* ignore */ } }
    this.nodeInst = null
  }

  get version(): string {
    return NODE_VERSION
  }
}

/** Best-effort outbound IPv4 guess for advertise-when-bound-to-wildcard. */
function guessOutboundHost(): string {
  const ifaces = os.networkInterfaces()
  for (const list of Object.values(ifaces)) {
    for (const addr of list ?? []) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address
    }
  }
  return "127.0.0.1"
}
