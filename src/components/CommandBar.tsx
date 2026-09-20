/**
 * aequdash — src/components/CommandBar.tsx
 *
 * Command layer (guide §17). Opens with `:`, closes with Esc, executes with
 * Enter. ↑/↓ navigate history. Live tab-completion suggestions from the
 * command catalog. Focus lands immediately — typing never waits.
 *
 *   ┌─ command ────────────────────────────────────────────┐
 *   │ : equality_check▌                                    │
 *   └───────────────────────────────────────────────────────┘
 */

import { useEffect, useRef, useState } from "react"
import { useRenderer } from "@opentui/react"
import { useStore } from "../state/store.tsx"
import { THEME } from "../lib/theme.ts"
import { COMMANDS } from "../lib/commands.ts"
import { truncateCells } from "../lib/measure.ts"
import { T } from "./T.tsx"

const HISTORY_CAP = 50

export function CommandBar() {
  const { commandBarOpen, setCommandBarOpen, call, lastCommand, bridge } = useStore()
  const renderer = useRenderer()
  const [value, setValue] = useState("")
  const [history, setHistory] = useState<string[]>([])
  const [histIdx, setHistIdx] = useState(-1)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const inputRef = useRef<any>(null)

  useEffect(() => {
    if (commandBarOpen) {
      setValue("")
      setHistIdx(-1)
      setSuggestions([])
      const id = setTimeout(() => { try { inputRef.current?.focus?.() } catch {} }, 0)
      return () => clearTimeout(id)
    }
  }, [commandBarOpen])

  if (!commandBarOpen) return null

  const submit = async () => {
    const v = value.trim()
    if (!v) { setCommandBarOpen(false); return }
    setHistory((h) => [...h.slice(-HISTORY_CAP + 1), v])
    const [cmd, ...args] = v.split(/\s+/)

    // kill / shutdown / quit — bring the whole mesh down and exit cleanly.
    // Every node stops (state evaporates), daemons exit, renderer restores
    // the terminal, the process tree dies with zero orphans.
    if (["kill", "shutdown", "quit", "exit"].includes(cmd.toLowerCase())) {
      setCommandBarOpen(false)
      try { await bridge.stop() } catch { /* ignore */ }
      try { renderer.destroy() } catch { /* ignore */ }
      process.exit(0)
    }

    setRunning(true)
    try {
      await call(cmd, args)
    } finally {
      setRunning(false)
      setCommandBarOpen(false)
    }
  }

  const onInput = (v: string) => {
    setValue(v)
    const firstToken = v.split(/\s+/)[0]?.toLowerCase() ?? ""
    if (firstToken && !v.includes(" ")) {
      setSuggestions(
        COMMANDS
          .filter((c) => c.name.startsWith(firstToken) || c.aliases?.some((a) => a.startsWith(firstToken)))
          .slice(0, 5)
          .map((c) => `${c.name} ${c.args.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(" ")}`.trim()),
      )
    } else {
      setSuggestions([])
    }
  }

  const onKey = (key: { name: string; ctrl?: boolean }) => {
    if (key.name === "escape") { setCommandBarOpen(false); return }
    if (key.name === "return" || key.name === "enter") { submit(); return }
    if (key.name === "up") {
      setHistIdx((i) => {
        const idx = i < 0 ? history.length - 1 : Math.max(0, i - 1)
        setValue(history[idx] ?? "")
        return idx
      })
      return
    }
    if (key.name === "down") {
      setHistIdx((i) => {
        const idx = Math.min(history.length, i + 1)
        setValue(history[idx] ?? "")
        return idx
      })
      return
    }
    if (key.ctrl && key.name === "c") { setCommandBarOpen(false); return }
  }

  const height = Math.min(9, 3 + suggestions.length + (lastCommand ? 1 : 0))

  return (
    <box
      position="absolute"
      bottom={1}
      left={2}
      right={2}
      height={height}
      border={true}
      borderStyle="single"
      borderColor={THEME.accent.main}
      backgroundColor={THEME.bg.surface}
      flexDirection="column"
      paddingX={1}
      title="command"
      titleColor={THEME.ink.muted}
      titleAlignment="left"
    >
      <box flexDirection="row" height={1} alignItems="center" marginTop={0}>
        <T color={THEME.accent.main} bold>{running ? " … " : " : "}</T>
        <input
          ref={inputRef}
          value={value}
          onInput={onInput}
          onKeyDown={onKey as any}
          placeholder={running ? "running…" : "command (e.g. support 7f3a2e 100) — Esc closes"}
          flexGrow={1}
          textColor={THEME.ink.primary}
          backgroundColor={THEME.bg.surface}
          focusedBackgroundColor={THEME.bg.surface}
          placeholderColor={THEME.ink.faint}
          cursorColor={THEME.accent.main}
        />
      </box>
      {suggestions.map((s, i) => (
        <T key={i} color={THEME.ink.muted}>{`  ${truncateCells(s, 72)}`}</T>
      ))}
      {lastCommand && (
        <T color={lastCommand.ok ? THEME.status.ok : THEME.status.error}>
          {` ${lastCommand.ok ? "✓" : "✗"} ${truncateCells(lastCommand.message, 90)}`}
        </T>
      )}
    </box>
  )
}
