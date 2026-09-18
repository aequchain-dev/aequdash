/**
 * aequdash — src/lib/measure.ts
 *
 * Terminal-cell measurement and safe truncation (guide §15).
 *
 * OpenTUI renders to a terminal cell grid; JavaScript string length is NOT
 * display width. All layout math in aequdash goes through these helpers so
 * columns stay aligned for non-ASCII names, wide glyphs, and grapheme
 * clusters.
 *
 * Policy:
 *   • measure with display-cell width (wide chars count 2, combining 0)
 *   • truncate on grapheme boundaries, never split a cluster
 *   • padding always computed from display width, never string length
 */

// Strip ANSI SGR sequences before measuring (defensive; our own spans are
// styled by the renderer, but pasted/streamed content may carry codes).
const ANSI_RE = /\x1b\[[0-9;]*m/g

/** Conservative per-codepoint cell width (WCwidth-style, zero deps). */
function codepointWidth(cp: number): number {
  if (cp === 0) return 0
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0         // control
  if (cp >= 0x0300 && cp <= 0x036f) return 0                 // combining diacriticals
  if (cp >= 0x1ab0 && cp <= 0x1aff) return 0
  if (cp >= 0x1dc0 && cp <= 0x1dff) return 0
  if (cp >= 0x20d0 && cp <= 0x20ff) return 0
  if (cp >= 0xfe00 && cp <= 0xfe0f) return 0                 // variation selectors
  if (cp >= 0xfe20 && cp <= 0xfe2f) return 0
  if (cp === 0x200d) return 0                                // ZWJ
  if (cp >= 0xe0100 && cp <= 0xe01ef) return 0
  // Wide East Asian + emoji ranges → 2 cells
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||                        // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||       // CJK radicals..Yi
    (cp >= 0xac00 && cp <= 0xd7a3) ||                        // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) ||                        // CJK compat ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) ||                        // CJK compat forms
    (cp >= 0xff00 && cp <= 0xff60) ||                        // Fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||                      // emoji
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2
  return 1
}

/** Display-cell width of a string (ANSI-stripped, grapheme-aware). */
export function cellWidth(s: string): number {
  const clean = s.replace(ANSI_RE, "")
  let w = 0
  for (const ch of clean) {
    w += codepointWidth(ch.codePointAt(0) ?? 0)
  }
  return w
}

/**
 * Truncate to a maximum display width on grapheme boundaries.
 * Appends "…" (1 cell) when truncation occurs. Never splits a cluster.
 */
export function truncateCells(s: string, maxWidth: number): string {
  if (maxWidth <= 0) return ""
  if (cellWidth(s) <= maxWidth) return s
  if (maxWidth === 1) return "…"
  const target = maxWidth - 1
  const seg = new Intl.Segmenter("en", { granularity: "grapheme" })
  let out = ""
  let w = 0
  for (const { segment } of seg.segment(s.replace(ANSI_RE, ""))) {
    const sw = cellWidth(segment)
    if (w + sw > target) break
    out += segment
    w += sw
  }
  return out + "…"
}

/** Left-pad/truncate to exactly `width` cells, right-aligned (numbers). */
export function padStart(s: string, width: number, fill = " "): string {
  const w = cellWidth(s)
  if (w === width) return s
  if (w > width) return truncateCells(s, width)
  return fill.repeat(width - w) + s
}

/** Right-pad/truncate to exactly `width` cells, left-aligned (labels). */
export function padEnd(s: string, width: number, fill = " "): string {
  const w = cellWidth(s)
  if (w === width) return s
  if (w > width) return truncateCells(s, width)
  return s + fill.repeat(width - w)
}

/** Compose a row: left label + right-aligned right segment, exact width. */
export function justifyRow(left: string, right: string, width: number, gap = 1): string {
  const lw = cellWidth(left)
  const rw = cellWidth(right)
  const space = width - lw - rw
  if (space >= gap) return left + " ".repeat(space) + right
  // Squeeze: truncate the left side, keep the right intact (values win).
  const avail = Math.max(0, width - rw - gap)
  return truncateCells(left, avail) + " ".repeat(Math.max(0, width - cellWidth(truncateCells(left, avail)) - rw)) + right
}
