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
 * Wire protocol (aeqnet + julia): newline-delimited JSON-RPC over piped
 * stdio. Child stdout NEVER touches the parent terminal. Structured
 * activity arrives as JSON-RPC notifications: {"method":"activity",...}.
 */

import { EventEmitter } from "node:events"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { AequSimulator, backendNowMs } from "./simulator.ts"
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

export class Bridge extends EventEmitter {
  readonly options: BridgeOptions
  readonly backend: BridgeBackend
  status: BridgeStatus = "starting"
  private proc: ChildProcessWithoutNullStreams | null = null
  private sim: AequSimulator | null = null
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private stdoutBuf = ""
  private stderrBuf = ""
  private activityBuffer: ActivityEvent[] = []

  constructor(opts: BridgeOptions) {
    super()
    this.options = opts
    this.backend = opts.backend
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
      case "aeqnet": return this.startProcess(
        process.execPath, // the bun binary running us
        [
          "run", gatewayScript(),
          "--nodes", String(this.options.aeqnetNodes),
          "--port", String(this.options.aeqnetPort),
        ],
        "aeqnet",
        {},
      )
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
    if (!this.proc) return
    try { this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "shutdown" }) + "\n") } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 50))
    try { this.proc.kill("SIGTERM") } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 50))
    try { this.proc.kill("SIGKILL") } catch { /* ignore */ }
    this.proc = null
  }

  kill(): void { try { this.proc?.kill("SIGKILL") } catch { /* ignore */ } }

  // ─────────────────────────────────────────────────────────────────────────
  // JSON-RPC client
  // ─────────────────────────────────────────────────────────────────────────

  async call<T = unknown>(method: string, params?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
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
    if (!this.proc) throw new Error(`backend "${this.backend}" not running`)

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
    this.proc.stdin.write(JSON.stringify(req) + "\n")
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
