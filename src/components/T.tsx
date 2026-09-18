/**
 * aequdash — src/components/T.tsx
 *
 * Text primitive: <T color bold dim> wraps OpenTUI <text> with
 * attribute flags. Children coerced to string (TextNodeRenderable
 * accepts strings only).
 */

import { isValidElement, type ReactNode } from "react"

export interface TProps {
  children?: ReactNode
  color?: string
  bg?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  dim?: boolean
  inverse?: boolean
  strikethrough?: boolean
}

const ATTR = {
  BOLD:          1 << 0,
  ITALIC:        1 << 1,
  UNDERLINE:     1 << 2,
  STRIKETHROUGH: 1 << 3,
  INVERSE:       1 << 4,
  DIM:           1 << 5,
} as const

function nodeToString(node: ReactNode): string {
  if (node === null || node === undefined || node === false || node === true) return ""
  if (typeof node === "string") return node
  if (typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(nodeToString).join("")
  if (isValidElement(node)) return nodeToString((node.props as { children?: ReactNode }).children)
  return String(node)
}

export function T({ children, color, bg, bold, italic, underline, dim, inverse, strikethrough }: TProps) {
  let attr = 0
  if (bold) attr |= ATTR.BOLD
  if (italic) attr |= ATTR.ITALIC
  if (underline) attr |= ATTR.UNDERLINE
  if (strikethrough) attr |= ATTR.STRIKETHROUGH
  if (inverse) attr |= ATTR.INVERSE
  if (dim) attr |= ATTR.DIM
  return <text fg={color} bg={bg} attributes={attr}>{nodeToString(children)}</text>
}
