/**
 * aequdash — src/lib/bridge.ts
 *
 * Backend bridge for the TUI. Three backends, one contract:
 *
 *   aeqnet  (DEFAULT) — the real ephemeral testnet mesh: this spawns
 *           src/node/gateway.ts, which hosts node-1 in-process and spawns
 *           N-1 daemon nodes, all linked by real TCP with real BFT
 *           consensus. No Julia required. No simulator. NO FALLBACK —
 *           if the mesh can't boot, the UI shows an honest error state.
 *
 *   julia   — the reference Julia implementation via julia/rpc-server.jl
 *           (AEQUCHAIN_BACKEND=julia). No silent simulator fallback:
 *           failure → error state.
 *
 *   sim     — the built-in deterministic simulator, ONLY when explicitly
 *           requested (AEQUCHAIN_SIMULATE=1) or frozen for CI snapshots
 *           (AEQUDASH_SNAPSHOT=1).
 *
 * Wire protocol (aeqnet + julia): newline-delimited JSON-RPC. Julia uses
 * piped stdio; aeqnet uses a TCP control socket so that MULTIPLE TUI
 * instances share ONE live mesh — the first `bun run start` spawns the
 * detached gateway, later ones attach to it. The mesh evaporates when the
 * last client disconnects. Structured activity arrives as JSON-RPC
 * notifications: {"method":"activity",...}.
 */

import { EventEmitter } from "node:events"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import type { Socket } from "bun"
import { AequSimulator, backendNowMs } from "./simulator.ts"
import { SoloNodeBackend, type SoloNodeConfig } from "../node/solo.ts"
import type {
  ActivityEvent,
  ActivityLevel,
  BridgeStatus,
  SnapshotV2,
} from "./types.ts"

export type BridgeBackend = "aeqnet" | "julia" | "sim"

export interface BridgeOptions {
  backend: BridgeBackend
  juliaBin: string
  rpcScript: string
  cwd: string
  aeqnetNodes: number
  aeqnetPort: number
  /**
   * Optional remote gateway "host:port" to attach to instead of spawning a
   * local mesh. Enables cross-machine sharing: point every user's TUI at one
   * host machine's gateway and they all share one chain.
   */
  remoteGateway?: string
  /**
   * Interface the local control server binds to when this instance spawns the
   * gateway. Default 127.0.0.1. Set to 0.0.0.0 to accept remote terminals.
   */
  controlHost?: string
  /** Shared secret for authenticating to the gateway (AEQUCHAIN_TOKEN). */
  token?: string
  /** Use TLS when attaching to the gateway (required for internet exposure). */
  tls?: boolean
  /**
   * SOLO mode (the internet-first default): this instance IS one real
   * AequNode, in-process. No gateway, no control socket — the TUI talks to
   * its own node, and the node meshes with peers over TCP. When set, the
   * aeqnet backend runs solo instead of spawning/attaching to a gateway.
   */
  solo?: SoloNodeConfig
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  method: string
  started: number
}

const REQUEST_TIMEOUT_MS = 30_000
const STARTUP_TIMEOUT_MS = 90_000
const ACTIVITY_BUFFER_CAP = 500
const ATTACH_PROBE_MS = 5_000   // generous for remote/internet round-trips

/** Thrown when a gateway is reachable but rejects our auth token — fatal. */
class AuthRejected extends Error {}

export class Bridge extends EventEmitter {
  readonly options: BridgeOptions
  readonly backend: BridgeBackend
  status: BridgeStatus = "starting"
  private proc: ChildProcessWithoutNullStreams | null = null
  private sock: Socket | null = null
  private sim: AequSimulator | null = null
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private stdoutBuf = ""
  private stderrBuf = ""
  private sockBuf = ""
  private activityBuffer: ActivityEvent[] = []
  /** True once the aeqnet gateway has announced readiness over the wire. */
  private meshReady = false
  /** Solo mode: the in-process node backend (instance-is-node). */
  private solo: SoloNodeBackend | null = null

  constructor(opts: BridgeOptions) {
    super()
    this.options = opts
    this.backend = opts.backend
  }

  /** The shared-mesh control port for aeqnet (derived from the mesh base port). */
  private get controlPort(): number {
    return this.options.aeqnetPort + 1000
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    switch (this.backend) {
      case "sim": return this.startSim()
      case "julia": return this.startProcess(
        this.options.juliaBin,
        [this.options.rpcScript],
        "Julia",
        { JULIA_LOAD_PATH: "@:@v#.#:@stdlib" },
      )
      case "aeqnet": return this.options.solo ? this.startSoloAeqnet() : this.startAeqnetMesh()
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // aeqnet SOLO — this instance IS one real node (internet-first default)
  //
  // No gateway, no control socket, no daemon tree. The TUI's process hosts
  // a single AequNode that joins (or founds) a shared mesh as a genuine
  // consensus peer. Quitting the TUI destroys the node; the network lives
  // while other peers remain; when the last peer exits, the chain is gone.
  // ─────────────────────────────────────────────────────────────────────────

  private async startSoloAeqnet(): Promise<void> {
    this.setStatus("starting")
    const cfg = this.options.solo!
    this.emitRaw(`Starting aequdash node "${cfg.nodeId}" on net ${cfg.clusterId}${cfg.token ? " (invite-gated)" : " (open)"}…`, "stdout", "info")
    if (cfg.seeds.length > 0) {
      this.emitRaw(`Joining via ${cfg.seeds.length} seed(s): ${cfg.seeds.map((s) => `${s.host}:${s.port}`).join(", ")}`, "stdout", "info")
    }
    try {
      this.solo = new SoloNodeBackend(cfg)
      this.solo.onActivity((ev) => this.emitActivity(ev))
      const { endpoint } = await this.solo.start()
      this.meshReady = true
      this.emitRaw(
        `rpc: hello — aeqnet node ready (net=${cfg.clusterId}, endpoint=${endpoint.host}:${endpoint.port}, version=${this.solo.version})`,
        "rpc",
        "success",
      )
      this.setStatus("ready")
    } catch (e) {
      this.solo = null
      return this.failBackend(`solo node failed to start: ${(e as Error).message}`)
    }
  }

  private async startSim(): Promise<void> {
    this.sim = new AequSimulator({ seed: 42 })
    this.setStatus("simulating")
    this.emitRaw("Starting in SIMULATION mode (explicit).", "stdout", "warn")
    this.emitRaw("Data is generated locally by the deterministic reference simulator.", "stdout", "info")
    this.emitRaw("For the real ephemeral testnet mesh: bun run start (no AEQUCHAIN_SIMULATE).", "stdout", "info")
    this.emitRaw("rpc: hello — simulator ready", "rpc", "success")
    this.sim.start((ev) => this.emit("activity", ev))
  }

  // ─────────────────────────────────────────────────────────────────────────
  // aeqnet — shared ephemeral mesh over a TCP control socket
  //
  // The first `bun run start` spawns a DETACHED gateway that owns the mesh and
  // serves JSON-RPC on a well-known control port. Every subsequent TUI simply
  // ATTACHES to that same gateway, so all terminals see one shared chain.
  // The mesh evaporates when the last client disconnects (gateway-side rule).
  // ─────────────────────────────────────────────────────────────────────────

  private async startAeqnetMesh(): Promise<void> {
    this.setStatus("starting")

    // ── Remote-attach mode: point at another machine's gateway, never spawn.
    if (this.options.remoteGateway) {
      const { host, port } = parseHostPort(this.options.remoteGateway, this.controlPort)
      this.emitRaw(`Attaching to remote aeqnet mesh at ${host}:${port}…`, "stdout", "info")
      const deadline = Date.now() + STARTUP_TIMEOUT_MS
      while (Date.now() < deadline) {
        try {
          if (await this.tryAttach(host, port)) {
            this.emitRaw(`Attached to remote aeqnet mesh at ${host}:${port}`, "rpc", "success")
            return
          }
        } catch (e) {
          if (e instanceof AuthRejected) {
            return this.failBackend("gateway rejected the auth token (check AEQUCHAIN_TOKEN)")
          }
          throw e
        }
        await new Promise((r) => setTimeout(r, 400))
      }
      return this.failBackend(
        `could not reach remote gateway at ${host}:${port}. ` +
        `On the host machine, run with AEQUCHAIN_CONTROL_HOST=0.0.0.0 and open the port.`,
      )
    }

    // ── Local shared mesh: attach if running, else spawn + attach.
    let rejected = false
    try {
      if (await this.tryAttach("127.0.0.1", this.controlPort)) {
        this.emitRaw(`Attached to live aeqnet mesh on 127.0.0.1:${this.controlPort}`, "rpc", "success")
        return
      }
    } catch (e) {
      if (e instanceof AuthRejected) rejected = true
      else throw e
    }
    if (rejected) {
      return this.failBackend(
        "a live gateway on this port requires a token. Set AEQUCHAIN_TOKEN, or kill the gateway to start fresh.",
      )
    }
    this.emitRaw(`No live mesh on port ${this.controlPort} — spawning shared gateway…`, "stdout", "info")
    this.spawnGateway()
    const deadline = Date.now() + STARTUP_TIMEOUT_MS
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300))
      try {
        if (await this.tryAttach("127.0.0.1", this.controlPort)) {
          this.emitRaw(`Spawned and attached to aeqnet mesh on 127.0.0.1:${this.controlPort}`, "rpc", "success")
          return
        }
      } catch (e) {
        if (e instanceof AuthRejected) {
          return this.failBackend("gateway rejected the auth token (check AEQUCHAIN_TOKEN)")
        }
        throw e
      }
    }
    this.failBackend("gateway did not come up in time")
  }

  /** Spawn the shared gateway as a detached process that serves the control port. */
  private spawnGateway(): void {
    const controlHost = this.options.controlHost ?? "127.0.0.1"
    const proc = spawn(process.execPath, [
      "run", gatewayScript(),
      "--nodes", String(this.options.aeqnetNodes),
      "--port", String(this.options.aeqnetPort),
      "--serve", String(this.controlPort),
      "--control-host", controlHost,
    ], {
      cwd: this.options.cwd,
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,           // own process group — survives the spawning TUI
      env: { ...process.env },
    })
    proc.unref()                // let us exit without waiting for it
  }

  /**
   * Try to open a TCP connection to a gateway. On success, wire up the socket,
   * authenticate if a token is configured, and return true. Returns false if
   * nothing is listening yet. Throws AuthRejected if the gateway is reachable
   * but refuses our token (fatal — retrying won't help).
   */
  private tryAttach(host: string, port: number): Promise<boolean> {
    return new Promise((resolve, reject) => {
      let settled = false
      const done = (ok: boolean) => { if (!settled) { settled = true; resolve(ok) } }
      const failAuth = () => { if (!settled) { settled = true; reject(new AuthRejected()) } }
      try {
        Bun.connect({
          hostname: host,
          port,
          ...(this.options.tls ? { tls: { rejectUnauthorized: false } } : {}),
          socket: {
            open: (sock) => {
              this.sock = sock
              // If the gateway requires a token, authenticate before serving.
              // Then issue a net.nodes probe — this registers us as a client
              // on the gateway and confirms the mesh is alive.
              const probe = () => this.call("net.nodes", undefined, ATTACH_PROBE_MS - 1_000)
                .then(() => done(true))
                .catch((e: Error) => {
                  if (/invalid token|unauthorized|auth/i.test(e.message)) failAuth()
                  else done(false)
                })
              if (this.options.token) {
                this.call("auth", { token: this.options.token }, ATTACH_PROBE_MS - 1_000)
                  .then(() => probe())
                  .catch((e: Error) => {
                    // Explicit "invalid token" from the gateway is fatal; a
                    // timeout/transport error just means "not ready yet".
                    if (/invalid token|unauthorized/i.test(e.message)) failAuth()
                    else done(false)
                  })
              } else {
                probe()
              }
            },
            data: (_sock, chunk) => this.onSocketData(chunk),
            close: () => this.onSocketClosed(),
            error: () => this.onSocketClosed(),
            connectError: () => { done(false) },
          },
        }).catch(() => done(false))
      } catch {
        done(false)
      }
      // Hard cap on the connect attempt
      setTimeout(() => done(false), ATTACH_PROBE_MS)
    })
  }

  private onSocketData(chunk: Uint8Array): void {
    this.sockBuf += new TextDecoder().decode(chunk)
    let nl: number
    while ((nl = this.sockBuf.indexOf("\n")) >= 0) {
      const line = this.sockBuf.slice(0, nl)
      this.sockBuf = this.sockBuf.slice(nl + 1)
      this.handleLine(line, "stdout")
    }
  }

  private onSocketClosed(): void {
    this.sock = null
    if (this.status !== "stopped") {
      this.emitRaw("aeqnet mesh connection closed (mesh evaporated)", "stderr", "warn")
      this.setStatus("stopped")
    }
  }

  private async startProcess(
    bin: string,
    args: string[],
    label: string,
    extraEnv: Record<string, string>,
  ): Promise<void> {
    this.setStatus("starting")
    this.emitRaw(`Spawning ${label}: ${bin} ${args.join(" ")}`, "stdout", "info")

    try {
      this.proc = spawn(bin, args, {
        cwd: this.options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...extraEnv },
      })
    } catch (err) {
      this.emitRaw(`Failed to spawn ${label}: ${(err as Error).message}`, "stderr", "error")
      return this.failBackend(`spawn failed: ${(err as Error).message}`)
    }

    this.proc.stdout.setEncoding("utf8")
    this.proc.stderr.setEncoding("utf8")
    this.proc.stdout.on("data", (chunk: string) => this.onStdout(chunk))
    this.proc.stderr.on("data", (chunk: string) => this.onStderr(chunk))
    this.proc.on("error", (err: Error) => {
      this.emitRaw(`${label} process error: ${err.message}`, "stderr", "error")
    })

    let settled = false
    const exitHandler = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return
      settled = true
      this.emitRaw(`${label} process exited (code=${code}, signal=${signal ?? "—"})`, "stderr", code === 0 ? "info" : "warn")
      if (this.status !== "stopped") this.failBackend(`${label} exited (code=${code})`)
    }
    const statusHandler = (s: BridgeStatus) => {
      if (settled) return
      if (s === "ready") {
        settled = true
        this.proc?.removeListener("exit", exitHandler)
      }
    }
    this.proc.on("exit", exitHandler)
    this.on("status", statusHandler)

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      this.emitRaw(`${label} startup timed out after ${STARTUP_TIMEOUT_MS / 1000}s.`, "stderr", "warn")
      this.failBackend("startup timeout")
    }, STARTUP_TIMEOUT_MS)

    await new Promise((r) => setTimeout(r, 300))
    if (settled) {
      clearTimeout(timer)
      this.off("status", statusHandler)
    } else {
      this.once("status", () => { clearTimeout(timer); this.off("status", statusHandler) })
    }
  }

  /** Honest failure: NO silent simulator. The UI shows the error state. */
  private failBackend(reason: string): void {
    try { this.proc?.kill("SIGKILL") } catch { /* ignore */ }
    this.proc = null
    this.emitRaw(`Backend "${this.backend}" failed: ${reason}`, "stderr", "error")
    this.emitRaw("aequdash does not fabricate data — fix the backend or run with AEQUCHAIN_SIMULATE=1 explicitly.", "stderr", "info")
    this.setStatus("error")
  }

  async stop(): Promise<void> {
    this.setStatus("stopped")
    if (this.sim) { this.sim.stop(); this.sim = null }
    // solo: quitting the TUI destroys OUR node (state evaporates with us).
    if (this.solo) {
      try { await this.solo.shutdown() } catch { /* ignore */ }
      this.solo = null
      return
    }
    // aeqnet: detach this client from the shared mesh. The gateway owns the
    // mesh and evaporates it only when the LAST client disconnects — so a
    // single TUI quitting leaves a shared mesh alive for the others.
    if (this.sock) {
      try { this.sock.end() } catch { /* ignore */ }
      this.sock = null
      return
    }
    if (!this.proc) return
    try { this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "shutdown" }) + "\n") } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 50))
    try { this.proc.kill("SIGTERM") } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 50))
    try { this.proc.kill("SIGKILL") } catch { /* ignore */ }
    this.proc = null
  }

  kill(): void {
    if (this.solo) { try { void this.solo.shutdown() } catch { /* ignore */ } ; this.solo = null; return }
    if (this.sock) { try { this.sock.end() } catch { /* ignore */ } ; this.sock = null; return }
    try { this.proc?.kill("SIGKILL") } catch { /* ignore */ }
  }

  /**
   * Bring the WHOLE shared mesh down (the `:kill` command). Unlike stop() —
   * which only detaches this client — this instructs the gateway to tear down
   * every node, evaporating the shared state for all attached clients.
   */
  async terminateMesh(): Promise<void> {
    this.setStatus("stopped")
    if (this.sim) { this.sim.stop(); this.sim = null; return }
    // solo: we can only destroy OUR OWN node — other peers own their state.
    // The network evaporates when the last peer does the same.
    if (this.solo) {
      try { await this.solo.shutdown() } catch { /* ignore */ }
      this.solo = null
      return
    }
    if (this.sock) {
      try { await this.call("shutdown", undefined, 3_000) } catch { /* ignore */ }
      try { this.sock.end() } catch { /* ignore */ }
      this.sock = null
      return
    }
    await this.stop()
  }

  // ─────────────────────────────────────────────────────────────────────────
  // JSON-RPC client
  // ─────────────────────────────────────────────────────────────────────────

  async call<T = unknown>(method: string, params?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    // Solo node: serve the JSON-RPC surface in-process (no socket involved).
    if (this.solo) {
      switch (method) {
        case "state.snapshot":
        case "state.snapshot.v2":
          return this.solo.snapshot() as unknown as T
        case "cli.run": {
          const p = params as { command?: string; args?: string[] }
          return (await this.solo.cliRun(String(p?.command ?? ""), Array.isArray(p?.args) ? p.args.map(String) : [])) as unknown as T
        }
        case "net.nodes":
          return this.solo.clusterInfo() as unknown as T
        case "net.invite":
          return this.solo.inviteInfo() as unknown as T
        case "net.clients":
          return { clients: 1, mesh_ready: this.meshReady } as unknown as T
        case "shutdown":
          await this.solo.shutdown()
          return { ok: true } as unknown as T
        default:
          throw new Error(`unknown method: ${method}`)
      }
    }
    if (this.backend === "sim" && this.sim) {
      if (method === "state.snapshot" || method === "state.snapshot.v2") return this.sim.snapshot() as unknown as T
      if (method === "cli.run") {
        const { command, args } = params as { command: string; args: string[] }
        return this.sim.cliRun(command, args) as unknown as T
      }
      if (method === "net.nodes") {
        // The simulator is single-node by definition — report that honestly.
        return {
          self_id: "simulator",
          mesh_size: 1,
          all_converged: true,
          nodes: [{
            id: "sim-node", label: "sim-node", host: "127.0.0.1", port: 0,
            status: "live", height: this.sim.snapshot().block_height,
            state_root: this.sim.snapshot().node?.state_root_hex ?? "",
            peers: 0, uptime_s: 0, version: "sim",
          }],
        } as unknown as T
      }
      if (method === "shutdown") return undefined as unknown as T
      throw new Error(`unknown method: ${method}`)
    }
    if (!this.proc && !this.sock) throw new Error(`backend "${this.backend}" not running`)

    const id = this.nextId++
    const req = { jsonrpc: "2.0", id, method, params }
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`RPC timeout: ${method} (${timeoutMs}ms)`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v as T) },
        reject, method, started: Date.now(),
      })
    })
    const line = JSON.stringify(req) + "\n"
    if (this.sock) this.sock.write(line)
    else this.proc!.stdin.write(line)
    return promise
  }

  snapshot(): Promise<SnapshotV2> {
    if (this.backend === "sim") return this.call<SnapshotV2>("state.snapshot.v2")
    return this.call<SnapshotV2>("state.snapshot.v2")
      .then((snap) => {
        // A v1 backend (legacy Julia) answers unknown methods with a result
        // SHAPED like an error — detect and route to the legacy adapter.
        if (snap && typeof snap === "object" && "error" in (snap as object)) {
          return this.legacySnapshotAdapter()
        }
        return snap
      })
      .catch(() => this.legacySnapshotAdapter())
  }

  private async legacySnapshotAdapter(): Promise<SnapshotV2> {
    return {
      ready: true,
      network: "testnet",
      block_height: 0,
      server_time: new Date(backendNowMs()).toISOString(),
      current_user: "",
      treasury: null,
      member_value_aeq: 0,
      members_summary: null,
      members: [],
      networks: [],
      businesses: [],
      pledges: [],
      pledges_summary: null,
      volume: null,
      spend: null,
      personal: null,
      node: null,
      equality: null,
      consensus: null,
      activity: [],
      full_fidelity: false,
    }
  }

  runCommand(command: string, args: string[] = []): Promise<{ ok: boolean; message: string; snapshot?: SnapshotV2 }> {
    return this.call("cli.run", { command, args })
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Output capture → activity feed
  // ─────────────────────────────────────────────────────────────────────────

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk
    let nl: number
    while ((nl = this.stdoutBuf.indexOf("\n")) >= 0) {
      const line = this.stdoutBuf.slice(0, nl)
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1)
      this.handleLine(line, "stdout")
    }
  }

  private onStderr(chunk: string): void {
    this.stderrBuf += chunk
    let nl: number
    while ((nl = this.stderrBuf.indexOf("\n")) >= 0) {
      const line = this.stderrBuf.slice(0, nl)
      this.stderrBuf = this.stderrBuf.slice(nl + 1)
      this.handleLine(line, "stderr")
    }
  }

  private handleLine(line: string, stream: "stdout" | "stderr"): void {
    const trimmed = line.trim()
    if (!trimmed) return

    if (trimmed.startsWith("{")) {
      try {
        const msg = JSON.parse(trimmed) as {
          id?: number
          method?: string
          params?: unknown
          error?: { message: string; code: number }
          result?: unknown
        }
        // JSON-RPC response (has id)
        if (typeof msg.id === "number" && this.pending.has(msg.id)) {
          const pending = this.pending.get(msg.id)!
          this.pending.delete(msg.id)
          if (msg.error) pending.reject(new Error(`${msg.error.message} (code ${msg.error.code})`))
          else pending.resolve(msg.result)
          this.emitRaw(`rpc: ← ${pending.method} ok`, "rpc", "debug")
          return
        }
        // JSON-RPC notification (no id) — structured activity from the backend
        if (msg.method === "activity" && msg.params) {
          const ev = msg.params as ActivityEvent
          // The gateway demands a token we don't have → fail fast with a clear
          // message instead of hanging at "starting" until the boot timeout.
          if (/auth required/i.test(ev.message) && !this.options.token) {
            this.failBackend(
              "this gateway requires a token. Set AEQUCHAIN_TOKEN to the shared secret.",
            )
            return
          }
          // Over the aeqnet TCP control socket, the readiness hello arrives as
          // an activity event (not a raw stdout line), so detect it here.
          if (
            (this.status === "starting" || this.status === "compiling") &&
            /rpc:\s*hello|gateway ready|mesh.*ready/i.test(ev.message)
          ) {
            this.meshReady = true
            this.setStatus("ready")
          }
          this.emitActivity({ ...ev, ts: ev.ts ?? new Date(backendNowMs()).toISOString() })
          return
        }
        this.emitRaw(`rpc: ${trimmed.slice(0, 240)}`, "rpc", "info")
        return
      } catch {
        // not JSON — fall through to line classification
      }
    }

    // Readiness detection (both backends print an "rpc: hello … ready" line)
    if (this.status === "starting" || this.status === "compiling") {
      if (/\bPrecompiling\b|\b\+ .+ v\b|Updating registry|Resolving package/i.test(trimmed)) {
        this.setStatus("compiling")
      } else if (/rpc:\s*hello|rpc.*ready/i.test(trimmed)) {
        this.setStatus("ready")
      }
    }

    const level = this.classifyLine(trimmed, stream)
    this.emitActivity({ ts: new Date(backendNowMs()).toISOString(), level, tag: stream, message: trimmed, fields: [] })
  }

  private emitRaw(text: string, stream: "stdout" | "stderr" | "rpc" | "tui", level: ActivityLevel): void {
    this.emitActivity({ ts: new Date(backendNowMs()).toISOString(), level, tag: stream, message: text, fields: [] })
  }

  private emitActivity(ev: ActivityEvent): void {
    if (this.activityBuffer.length >= ACTIVITY_BUFFER_CAP) this.activityBuffer.shift()
    this.activityBuffer.push(ev)
    this.emit("raw", ev.message, ev.tag)
    this.emit("activity", ev)
  }

  private classifyLine(line: string, stream: "stdout" | "stderr"): ActivityLevel {
    const l = line.toLowerCase()
    if (stream === "stderr") {
      if (/error|fatal|exception|traceback/.test(l)) return "error"
      if (/warn|deprecated/.test(l)) return "warn"
      return "info"
    }
    if (/✅|✓|success|passed|confirmed|ready/.test(l)) return "success"
    if (/error|fatal|failed|exception/.test(l)) return "error"
    if (/warn/.test(l)) return "warn"
    if (/debug|trace/.test(l)) return "debug"
    return "info"
  }

  private setStatus(s: BridgeStatus): void {
    if (this.status === s) return
    this.status = s
    this.emit("status", s)
  }

  onActivity(handler: (line: ActivityEvent) => void): () => void {
    for (const line of this.activityBuffer) { try { handler(line) } catch { /* ignore */ } }
    this.on("activity", handler)
    return () => this.off("activity", handler)
  }

  onStatus(handler: (s: BridgeStatus) => void): () => void {
    try { handler(this.status) } catch { /* ignore */ }
    this.on("status", handler)
    return () => this.off("status", handler)
  }
}

/** Backwards-compatible alias for existing imports. */
export { Bridge as JuliaBridge }

function gatewayScript(): string {
  return new URL("../node/gateway.ts", import.meta.url).pathname
}

/** Parse "host:port" | "host" into a connect target (default port if omitted). */
function parseHostPort(addr: string, defaultPort: number): { host: string; port: number } {
  const trimmed = addr.trim()
  const idx = trimmed.lastIndexOf(":")
  if (idx > 0) {
    const host = trimmed.slice(0, idx)
    const port = parseInt(trimmed.slice(idx + 1), 10)
    if (host && Number.isFinite(port)) return { host, port }
  }
  return { host: trimmed, port: defaultPort }
}
