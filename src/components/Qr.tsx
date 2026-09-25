/**
 * aequdash — src/components/Qr.tsx
 *
 * Terminal QR renderer. Matrix generation is delegated to the `qrcode`
 * package (battle-tested Reed–Solomon + masking — a hand-rolled encoder can
 * LOOK right and still not scan; we don't gamble on that).
 *
 * Rendering: one character cell per module, "█" for dark, space for light,
 * with a 2-module quiet zone. The palette is FIXED dark-on-light regardless
 * of the app theme — scanners need the contrast, and the cream-on-ink pair
 * matches the house canvas anyway.
 */

import QRCode from "qrcode"
import { T } from "./T.tsx"

const QR_LIGHT = "#f8f5ec"   // cream canvas family
const QR_DARK = "#2a2118"    // ink family
const QUIET = 2

export interface QrMatrix {
  size: number          // modules per side (WITHOUT quiet zone)
  rows: string[]        // pre-rendered rows INCLUDING quiet zone ("█"/space)
}

/** Build (and pre-render) the QR matrix for a payload. Pure — testable. */
export function qrMatrix(text: string): QrMatrix {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" })
  const size: number = qr.modules.size
  const data = qr.modules.data as unknown as Uint8Array
  const rows: string[] = []
  for (let y = -QUIET; y < size + QUIET; y++) {
    let row = ""
    for (let x = -QUIET; x < size + QUIET; x++) {
      const dark = x >= 0 && y >= 0 && x < size && y < size && data[y * size + x] === 1
      row += dark ? "█" : " "
    }
    rows.push(row)
  }
  return { size, rows }
}

export function Qr({ text }: { text: string }) {
  const { rows } = qrMatrix(text)
  return (
    <box flexDirection="column" flexShrink={0}>
      {rows.map((row, i) => (
        <T key={i} color={QR_DARK} bg={QR_LIGHT}>{row}</T>
      ))}
    </box>
  )
}
