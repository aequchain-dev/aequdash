/**
 * aequdash — src/state/store.tsx
 *
 * Global React context bridging the React tree to the JuliaBridge.
 * Exposes: status, snapshot, activity, screen, commandBar, call(), refresh().
 * Also provides a live clock (1s tick) frozen under snapshot mode.
 */

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Bridge } from "../lib/bridge.ts"
import type {
  ActivityEvent,
  BridgeStatus,
  CommandResult,
  ScreenId,
  SnapshotV2,
} from "../lib/types.ts"

const ACTIVITY_CAP = 500
const IS_SNAPSHOT = process.env.AEQUDASH_SNAPSHOT === "1"

export type { CommandResult }

interface StoreValue {
  bridge: Bridge
  status: BridgeStatus
  snapshot: SnapshotV2 | null
  activity: ActivityEvent[]
  screen: ScreenId
  setScreen: (s: ScreenId) => void
  commandBarOpen: boolean
  setCommandBarOpen: (open: boolean) => void
  lastCommand: CommandResult | null
  call: (command: string, args?: string[]) => Promise<CommandResult>
  refresh: () => Promise<void>
  statusLabel: string
  /** Current clock time (ISO) — updates every second live, frozen in snapshot mode. */
  clockISO: string
}

const Ctx = createContext<StoreValue | null>(null)

export function BridgeProvider({ bridge, children }: { bridge: Bridge; children: ReactNode }) {
  const [status, setStatus] = useState<BridgeStatus>(bridge.status)
  const [snapshot, setSnapshot] = useState<SnapshotV2 | null>(null)
  const [activity, setActivity] = useState<ActivityEvent[]>([])
  const [screen, setScreen] = useState<ScreenId>("dashboard")
  const [commandBarOpen, setCommandBarOpen] = useState(false)
  const [lastCommand, setLastCommand] = useState<CommandResult | null>(null)
  const [clockISO, setClockISO] = useState(() => new Date().toISOString())
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clockTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const mounted = useRef(true)

  // Bridge status + activity subscriptions
  useEffect(() => {
    mounted.current = true
    const offStatus = bridge.onStatus((s) => {
      setStatus(s)
      if (s === "ready" || s === "simulating") {
        bridge.snapshot().then((snap) => { if (mounted.current) setSnapshot(snap) }).catch(() => {})
      }
    })
    const offActivity = bridge.onActivity((line) => {
      setActivity((prev) => {
        const next = prev.length >= ACTIVITY_CAP ? prev.slice(prev.length - ACTIVITY_CAP + 1) : prev.slice()
        next.push(line)
        return next
      })
    })
    return () => {
      mounted.current = false
      offStatus()
      offActivity()
    }
  }, [bridge])

  // Clock tick (1s) — frozen when AEQUDASH_SNAPSHOT=1
  useEffect(() => {
    if (IS_SNAPSHOT) return
    clockTimer.current = setInterval(() => { setClockISO(new Date().toISOString()) }, 1000)
    return () => { if (clockTimer.current) clearInterval(clockTimer.current) }
  }, [])

  // Periodic snapshot polling (1.5s) — disabled in snapshot mode
  useEffect(() => {
    if (IS_SNAPSHOT) return
    if (status !== "ready" && status !== "simulating") return
    const tick = async () => {
      try {
        const snap = await bridge.snapshot()
        if (mounted.current) setSnapshot(snap)
      } catch {}
    }
    tick()
    refreshTimer.current = setInterval(tick, 1500)
    return () => { if (refreshTimer.current) clearInterval(refreshTimer.current) }
  }, [bridge, status])

  const call = useMemo(() => async (command: string, args: string[] = []): Promise<CommandResult> => {
    try {
      const result = await bridge.runCommand(command, args)
      setLastCommand(result)
      if (result.snapshot) setSnapshot(result.snapshot)
      else await Promise.resolve()
      return result
    } catch (err) {
      const r: CommandResult = { ok: false, message: (err as Error).message }
      setLastCommand(r)
      return r
    }
  }, [bridge])

  const refresh = useMemo(() => async () => {
    try {
      const snap = await bridge.snapshot()
      if (mounted.current) setSnapshot(snap)
    } catch {}
  }, [bridge])

  const statusLabel = useMemo(() => {
    switch (status) {
      case "starting": return "STARTING"
      case "compiling": return "COMPILING"
      case "ready": return bridge.backend === "aeqnet" ? "TESTNET LIVE" : "JULIA LIVE"
      case "simulating": return "SIMULATION"
      case "error": return "ERROR"
      case "stopped": return "STOPPED"
    }
  }, [status, bridge.backend])

  const value: StoreValue = {
    bridge,
    status,
    snapshot,
    activity,
    screen,
    setScreen,
    commandBarOpen,
    setCommandBarOpen,
    lastCommand,
    call,
    refresh,
    statusLabel,
    clockISO,
  }

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useStore(): StoreValue {
  const v = useContext(Ctx)
  if (!v) throw new Error("useStore must be used inside <BridgeProvider>")
  return v
}