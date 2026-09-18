/**
 * aequdash — src/lib/theme.ts
 *
 * Centralized visual token system for aequchain TUI v2, implementing the
 * AEQUCHAIN OpenTUI Style Guide exactly:
 *
 *   §5.1  Light theme — warm parchment canvas, rose-brown rules and ink.
 *   §5.3  Dark theme  — same semantic tokens, inverted luminance. Not a
 *         second visual language.
 *   §12.2 Motion tokens — terminal-fast timings (70–220 ms typical).
 *   §6    Typography — hierarchy via weight + spacing, never size jumps.
 *
 * Rule: no component may contain a raw hex literal. Everything resolves
 * through useTheme() / TOKENS.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Token types (guide §23)
// ─────────────────────────────────────────────────────────────────────────────

export interface AequTheme {
  name: "light" | "dark"
  bg: {
    canvas: string   // primary field
    surface: string  // slightly lifted panel field
    subtle: string   // restrained alternate surface
    active: string   // selected navigation / active row
  }
  ink: {
    primary: string    // warm dark rose-brown — primary text
    secondary: string  // secondary text
    muted: string      // labels / metadata
    faint: string      // low-priority notes
    inverse: string    // text on accent-filled surfaces
  }
  rule: {
    default: string  // primary border/rule
    soft: string     // secondary divider
    faint: string    // low-contrast separation
  }
  accent: {
    main: string  // selected / interactive accent
    soft: string  // progress / secondary accent
  }
  status: {
    ok: string
    warn: string
    error: string
    info: string
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Light theme — guide §5.1 (verbatim token values)
// ─────────────────────────────────────────────────────────────────────────────

export const LIGHT: AequTheme = {
  name: "light",
  bg: {
    canvas:  "#ECE5D8",
    surface: "#F0E9DC",
    subtle:  "#E8E0D4",
    active:  "#E2D2CA",
  },
  ink: {
    primary:   "#5E3C3C",
    secondary: "#7B5B5A",
    muted:     "#967775",
    faint:     "#B69A94",
    inverse:   "#F0E9DC",
  },
  rule: {
    default: "#B88A88",
    soft:    "#D1B4AE",
    faint:   "#DED1C8",
  },
  accent: {
    main: "#A86668",
    soft: "#C58F8D",
  },
  status: {
    ok:    "#6F8C78",
    warn:  "#B38B5D",
    error: "#A15E61",
    info:  "#6F808C",
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// Dark theme — guide §5.3: same semantic system, inverted luminance.
// Warm near-black browns; pale cream ink; dusty rose rules; muted status.
// ─────────────────────────────────────────────────────────────────────────────

export const DARK: AequTheme = {
  name: "dark",
  bg: {
    canvas:  "#211A17",
    surface: "#2A221E",
    subtle:  "#251E1A",
    active:  "#3A2C27",
  },
  ink: {
    primary:   "#E8DBD3",
    secondary: "#C4B0A9",
    muted:     "#9C8A84",
    faint:     "#6E5F5A",
    inverse:   "#2A221E",
  },
  rule: {
    default: "#7A5C5A",
    soft:    "#5C4744",
    faint:   "#453835",
  },
  accent: {
    main: "#C58F8D",
    soft: "#A87674",
  },
  status: {
    ok:    "#8AA892",
    warn:  "#C9A87C",
    error: "#C48487",
    info:  "#93A4AE",
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// Theme resolution — AEQUCHAIN_THEME=light|dark (default: light, the
// reference-aligned theme).
// ─────────────────────────────────────────────────────────────────────────────

export type ThemeName = "light" | "dark"

export function resolveTheme(name?: string): AequTheme {
  const n = (name ?? process.env.AEQUCHAIN_THEME ?? "light").toLowerCase()
  return n === "dark" ? DARK : LIGHT
}

/** Process-wide active theme (set once at startup; tests may re-set). */
export let THEME: AequTheme = resolveTheme()

export function setTheme(name: ThemeName): void {
  THEME = name === "dark" ? DARK : LIGHT
}

// ─────────────────────────────────────────────────────────────────────────────
// Motion tokens (guide §12.2) — ms. Terminal motion is fast and purposeful.
// ─────────────────────────────────────────────────────────────────────────────

export const MOTION = {
  instant: 0,
  micro: 70,
  fast: 110,
  standard: 150,
  emphasis: 220,
  overlay: 180,
  slow: 320,
  splashBudget: 900,   // total splash duration cap (guide §12.5)
  clockMs: 1000,       // header clock tick
  heartbeatMs: 2400,   // simulator block/activity cadence
  pollMs: 1500,        // snapshot polling cadence
} as const

/** Reduced motion: AEQUCHAIN_NO_MOTION=1 disables decorative animation. */
export function reducedMotion(): boolean {
  return process.env.AEQUCHAIN_NO_MOTION === "1" || process.env.AEQUCHAIN_REDUCED_MOTION === "1"
}

// ─────────────────────────────────────────────────────────────────────────────
// Spacing (guide §8.2) — base unit: 1 terminal cell.
// ─────────────────────────────────────────────────────────────────────────────

export const SPACE = {
  none: 0,
  inset: 1,   // outer application inset
  gap: 1,     // panel gap
  padX: 1,    // panel internal horizontal padding
  padY: 0,    // panel internal vertical padding (dense rows; blank rows explicit)
  section: 1, // section divider row
} as const

// ─────────────────────────────────────────────────────────────────────────────
// Status vocabulary (guide §18) — small, stable, never synonymous.
// ─────────────────────────────────────────────────────────────────────────────

export const STATUS_WORDS = [
  "LIVE", "SIMULATION", "READY", "SYNCING", "BUSY",
  "PASS", "WARN", "ERROR", "OFFLINE",
] as const

export type StatusWord = typeof STATUS_WORDS[number]

// ─────────────────────────────────────────────────────────────────────────────
// Formatters — tabular, consistent precision, symbol separated from value.
// ─────────────────────────────────────────────────────────────────────────────

/** "1,248,672.31" — fixed 2dp with thousands separators. */
export function fmt2(n: number): string {
  if (!isFinite(n)) return "—"
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** "1,248,672" — grouped integer. */
export function fmt0(n: number): string {
  if (!isFinite(n)) return "—"
  return Math.round(n).toLocaleString("en-US")
}

/** Fixed-decimal general (0..6 dp), always grouped. */
export function fmtN(n: number, decimals: number): string {
  if (!isFinite(n)) return "—"
  const d = Math.max(0, Math.min(6, decimals))
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })
}

/** "0.0008" — four-decimal convenience for rates, variance, thresholds. */
export function fmt4(n: number): string {
  return fmtN(n, 4)
}

/** Percent: "43.8%" (1dp) — pass a fraction (0.438) or points (43.8)? We take points. */
export function fmtPct(points: number, decimals = 1): string {
  if (!isFinite(points)) return "—"
  return `${points.toFixed(decimals)}%`
}

/** Currency pair rendering: "$ 2,847,563.42". Symbol separated from value. */
export function fmtMoney(symbol: string, n: number, decimals = 2): string {
  return `${symbol} ${fmtN(n, decimals)}`
}

/** Approximate conversion: "≈ 1,248,672.31 AEQ". */
export function fmtApprox(n: number, unit: string, decimals = 2): string {
  return `≈ ${fmtN(n, decimals)} ${unit}`
}

/** "12:34:27" — HH:MM:SS in UTC. UTC keeps snapshots byte-reproducible
 *  across host timezones and matches the reference composition. */
export function fmtClock(d: Date): string {
  const p = (x: number) => String(x).padStart(2, "0")
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
}

/** HH:MM:SS UTC from an ISO string — for activity rows. */
export function fmtTimeUTC(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return "--:--:--"
  return fmtClock(d)
}

/** Duration countdown: "18d 11h 25m" / "11h 25m" / "25m 10s". */
export function fmtCountdown(ms: number): string {
  if (!isFinite(ms) || ms < 0) return "—"
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m ${s % 60}s`
}

/** Duration with days: "18.6 days". */
export function fmtDays(days: number): string {
  return `${days.toFixed(1)} days`
}

/** Short hash: "0x3f8a…9c21" — preserves identifier recognizability. */
export function shortHash(hash: string, head = 6, tail = 4): string {
  if (hash.length <= head + tail + 1) return hash
  const clean = hash.startsWith("0x") ? hash.slice(2) : hash
  if (clean.length <= head + tail) return hash
  return `0x${clean.slice(0, head)}…${clean.slice(-tail)}`
}

/** Human byte sizes for node memory stats. */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

/** Latency: "<1ms" | "12ms" | "1.20s". */
export function fmtMs(n: number): string {
  if (n < 1) return "<1ms"
  if (n < 1000) return `${Math.round(n)}ms`
  return `${(n / 1000).toFixed(2)}s`
}

/** Throughput: keep one decimal under 100. */
export function fmtTps(n: number): string {
  if (n < 100) return n.toFixed(1)
  return Math.round(n).toLocaleString("en-US")
}
