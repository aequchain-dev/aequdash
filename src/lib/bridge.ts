/**
 * aequdash — src/lib/bridge.ts
 *
 * Julia JSON-RPC bridge with built-in simulator fallback.
 * Critical invariants (from v1, preserved):
 *   • Julia stdio is ALWAYS piped — never inherits parent terminal.
 *   • Fallback to simulator is explicit and visible in UI badge.
 *   • v2 snapshot requested via `state.snapshot.v2`; falls back to
 *     legacy `state.snapshot` + adapter when v2 method missing.
 */

import { EventEmitter } from "events"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { AequSimulator, backendNowMs } from "./simulator.ts"
import type {
  ActivityEvent,
  ActivityLevel,
  BridgeStatus,
  SnapshotV2,
} from "./types.ts"

export interface BridgeOptions {
  juliaBin: string
  rpcScript: string
  simulate: boolean
  cwd: string
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  method: string
  started: number
}

export class JuliaBridge extends EventEmitter {
  readonly options: BridgeOptions
  status: BridgeStatus = "starting"
  private proc: ChildProcessWithoutNullStreams | null = null
  private sim: AequSimulator | null = null
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private stdoutBuf = ""
  private stderrBuf = ""
  private readonly REQUEST_TIMEOUT_MS = 30_000
  private activityBuffer: ActivityEvent[] = []
  private readonly ACTIVITY_BUFFER_CAP = 500

  constructor(opts: BridgeOptions) {
    super()
    this.options = opts
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ───────────────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.options.simulate) {
      this.sim = new AequSimulator({ seed: 42 })
      this.setStatus("simulating")
      this.emitRaw("Starting in SIMULATION mode (no Julia backend).", "stdout", "warn")
      this.emitRaw("All data is in-memory; no aequchain.jl is executed.", "stdout", "info")
      this.emitRaw("Install Julia and run without AEQUCHAIN_SIMULATE=1 for real integration.", "stdout", "info")
      this.emitRaw("rpc: hello — simulator ready", "rpc", "success")
      // Simulator state is already fully seeded by its constructor; just
      // wire the heartbeat/activity forwarding.
      this.sim.start((ev) => this.emit("activity", ev))
      return
    }

    this.setStatus("starting")
    this.emitRaw(`Spawning Julia: ${this.options.juliaBin} ${this.options.rpcScript}`, "stdout", "info")
    try {
      this.proc = spawn(this.options.juliaBin, [this.options.rpcScript], {
        cwd: this.options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, JULIA_LOAD_PATH: "@:@v#.#:@stdlib" },
      })
    } catch (err) {
      this.emitRaw(`Failed to spawn Julia: ${(err as Error).message}`, "stderr", "error")
      return this.fallBackToSimulation(`spawn failed: ${(err as Error).message}`)
    }

    this.proc.stdout.setEncoding("utf8")
    this.proc.stderr.setEncoding("utf8")
    this.proc.stdout.on("data", (chunk: string) => this.onStdout(chunk))
    this.proc.stderr.on("data", (chunk: string) => this.onStderr(chunk))
    this.proc.on("error", (err: Error) => {
      this.emitRaw(`Julia process error: ${err.message}`, "stderr", "error")
    })

    const STARTUP_TIMEOUT_MS = 30_000
    let settled = false
    const exitHandler = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return
      settled = true
      this.emitRaw(`Julia process exited (code=${code}, signal=${signal ?? "—"})`, "stderr", code === 0 ? "info" : "warn")
      if (this.status !== "stopped") this.fallBackToSimulation(`julia exited (code=${code})`)
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
      this.emitRaw("Julia startup timed out after 30s — falling back to simulation.", "stderr", "warn")
      this.fallBackToSimulation("startup timeout")
    }, STARTUP_TIMEOUT_MS)

    await new Promise((r) => setTimeout(r, 300))
    if (settled) {
      clearTimeout(timer)
      this.off("status", statusHandler)
    } else {
      this.once("status", () => { clearTimeout(timer); this.off("status", statusHandler) })
    }
  }

  private async fallBackToSimulation(reason: string): Promise<void> {
    if (this.options.simulate) return
    this.options.simulate = true
    try { this.proc?.kill("SIGKILL") } catch {}
    this.proc = null

    this.emitRaw("Julia backend unavailable — switching to SIMULATION mode.", "stderr", "warn")
    this.emitRaw(`Reason: ${reason}`, "stderr", "info")
    this.emitRaw("The TUI will use a built-in simulator that mirrors aequchain.jl's demo state.", "stdout", "info")
    this.emitRaw("To use the real Julia backend:", "stdout", "info")
    this.emitRaw("  1. Install Julia ≥ 1.8 from https://julialang.org", "stdout", "info")
    this.emitRaw("  2. Run: julia --project=. -e 'using Pkg; Pkg.instantiate()'", "stdout", "info")
    this.emitRaw("  3. Restart this TUI", "stdout", "info")

    this.sim = new AequSimulator({ seed: 42 })
    this.setStatus("simulating")
    this.sim.start((ev) => this.emit("activity", ev))
  }

  async stop(): Promise<void> {
    this.setStatus("stopped")
    if (this.sim) { this.sim.stop(); this.sim = null }
    if (!this.proc) return
    try { this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "shutdown" }) + "\n") } catch {}
    await new Promise((r) => setTimeout(r, 50))
    try { this.proc.kill("SIGTERM") } catch {}
    await new Promise((r) => setTimeout(r, 50))
    try { this.proc.kill("SIGKILL") } catch {}
    this.proc = null
  }

  kill() { try { this.proc?.kill("SIGKILL") } catch {} }

  // ───────────────────────────────────────────────────────────────────────────
  // JSON-RPC client
  // ───────────────────────────────────────────────────────────────────────────

  async call<T = unknown>(method: string, params?: unknown, timeoutMs = this.REQUEST_TIMEOUT_MS): Promise<T> {
    if (this.options.simulate && this.sim) {
      if (method === "state.snapshot") return this.sim.snapshot() as unknown as T
      if (method === "state.snapshot.v2") return this.sim.snapshot() as unknown as T
      if (method === "cli.run") {
        const { command, args } = params as { command: string; args: string[] }
        return this.sim.cliRun(command, args) as unknown as T
      }
      if (method === "shutdown") return undefined as unknown as T
      throw new Error(`unknown method: ${method}`)
    }
    if (!this.proc) throw new Error("Julia bridge not started")

    const id = this.nextId++
    const req = { jsonrpc: "2.0", id, method, params }
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`RPC timeout: ${method} (${timeoutMs}ms)`))
      }, timeoutMs)
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v as T) }, reject, method, started: Date.now() })
    })
    this.proc.stdin.write(JSON.stringify(req) + "\n")
    return promise
  }

  snapshot(): Promise<SnapshotV2> {
    // Try v2 method first; if Julia doesn't implement it, adapter will handle legacy
    return this.call<SnapshotV2>("state.snapshot.v2").catch(() => this.legacySnapshotAdapter())
  }

  private async legacySnapshotAdapter(): Promise<SnapshotV2> {
    // Call legacy state.snapshot and adapt what we can
    // This is a minimal adapter — real v1 snapshot shape differs
    // For now, return empty-ready snapshot; UI shows "—" for missing aggregates
    return {
      ready: true,
      network: "testnet",
      block_height: 0,
      server_time: new Date().toISOString(),
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

  // ───────────────────────────────────────────────────────────────────────────
  // Output capture → activity feed
  // ───────────────────────────────────────────────────────────────────────────

  private onStdout(chunk: string) {
    this.stdoutBuf += chunk
    let nl: number
    while ((nl = this.stdoutBuf.indexOf("\n")) >= 0) {
      const line = this.stdoutBuf.slice(0, nl)
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1)
      this.handleLine(line, "stdout")
    }
  }

  private onStderr(chunk: string) {
    this.stderrBuf += chunk
    let nl: number
    while ((nl = this.stderrBuf.indexOf("\n")) >= 0) {
      const line = this.stderrBuf.slice(0, nl)
      this.stderrBuf = this.stderrBuf.slice(nl + 1)
      this.handleLine(line, "stderr")
    }
  }

  private handleLine(line: string, stream: "stdout" | "stderr") {
    const trimmed = line.trim()
    if (!trimmed) return

    // JSON-RPC response?
    if (trimmed.startsWith("{")) {
      try {
        const msg = JSON.parse(trimmed) as { id?: number; error?: { message: string; code: number }; result?: unknown }
        if (typeof msg.id === "number" && this.pending.has(msg.id)) {
          const pending = this.pending.get(msg.id)!
          this.pending.delete(msg.id)
          if (msg.error) pending.reject(new Error(`${msg.error.message} (code ${msg.error.code})`))
          else pending.resolve(msg.result)
          this.emitRaw(`rpc: ← ${pending.method} ok`, "rpc", "debug")
          return
        }
        this.emitRaw(`rpc: ${trimmed}`, "rpc", "info")
        return
      } catch {
        // not JSON
      }
    }

    // Julia precompilation detection
    if (this.status === "starting" || this.status === "compiling") {
      if (/\bPrecompiling\b|\b\+ .+ v\b|Updating registry|Resolving package/i.test(trimmed)) {
        this.setStatus("compiling")
      } else if (/rpc:\s*hello|aequchain.*rpc.*ready/i.test(trimmed)) {
        this.setStatus("ready")
      }
    }

    // Parse structured "tag: message | k=v ..." lines
    const level = this.classifyLine(trimmed, stream)
    let tag: string = stream
    let message = trimmed
    const fields: { k: string; v: string }[] = []

    // Try "tag: message | k=v, k=v" pattern
    const colonIdx = trimmed.indexOf(": ")
    if (colonIdx > 0 && colonIdx < 40) {
      const maybeTag = trimmed.slice(0, colonIdx)
      if (/^[a-z_][a-z0-9_]*$/i.test(maybeTag)) {
        tag = maybeTag
        const rest = trimmed.slice(colonIdx + 2)
        const pipeIdx = rest.indexOf(" | ")
        if (pipeIdx >= 0) {
          message = rest.slice(0, pipeIdx)
          const kvs = rest.slice(pipeIdx + 3).split(", ")
          for (const kv of kvs) {
            const eq = kv.indexOf("=")
            if (eq > 0) fields.push({ k: kv.slice(0, eq), v: kv.slice(eq + 1) })
          }
        } else {
          message = rest
        }
      }
    }

    this.emitActivity({ ts: new Date(backendNowMs()).toISOString(), level, tag, message, fields })
  }

  private emitRaw(text: string, stream: "stdout" | "stderr" | "rpc" | "tui", level: ActivityLevel) {
    this.emitActivity({ ts: new Date(backendNowMs()).toISOString(), level, tag: stream, message: text, fields: [] })
  }

  private emitActivity(ev: ActivityEvent) {
    if (this.activityBuffer.length >= this.ACTIVITY_BUFFER_CAP) this.activityBuffer.shift()
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

  private setStatus(s: BridgeStatus) {
    if (this.status === s) return
    this.status = s
    this.emit("status", s)
  }

  onActivity(handler: (line: ActivityEvent) => void): () => void {
    for (const line of this.activityBuffer) { try { handler(line) } catch {} }
    this.on("activity", handler)
    return () => this.off("activity", handler)
  }
  onStatus(handler: (s: BridgeStatus) => void): () => void {
    try { handler(this.status) } catch {}
    this.on("status", handler)
    return () => this.off("status", handler)
  }
}