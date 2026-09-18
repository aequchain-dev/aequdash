/**
 * aequdash — src/screens/Console.tsx
 *
 * Live backend output + command catalogue (guide §10.8). The least decorated
 * screen: raw output is data, not branded copy. Signal hierarchy preserved:
 * level colors only, no per-line recoloring beyond the log's own semantics.
 */

import { useTerminalDimensions } from "@opentui/react"
import { useStore } from "../state/store.tsx"
import { THEME } from "../lib/theme.ts"
import { Panel, panelInnerWidth } from "../components/Panel.tsx"
import { ActivityLog } from "../components/ActivityLog.tsx"
import { COMMANDS } from "../lib/commands.ts"
import { T } from "../components/T.tsx"
import { truncateCells } from "../lib/measure.ts"

export function Console() {
  const { activity, status } = useStore()
  const { width: tw } = useTerminalDimensions()
  const w = Math.max(24, tw - 6)
  const iw = panelInnerWidth(w)

  // Right-hand catalogue column on wide terminals
  const showCatalog = w >= 100
  const logW = showCatalog ? Math.floor(iw * 0.68) : iw
  const catW = iw - logW - 2

  return (
    <box flexDirection="column" flexGrow={1} overflow="hidden">
      <Panel
        title="Console"
        meta={status === "ready" ? "Julia Output" : status === "simulating" ? "Simulator Output" : "Output"}
        marker="( )"
        width={w}
        flexGrow={1}
      >
        <box flexDirection="row" flexGrow={1} overflow="hidden">
          <box flexDirection="column" width={showCatalog ? logW : iw} flexGrow={showCatalog ? 0 : 1}>
            <ActivityLog events={activity} width={showCatalog ? logW : iw} />
          </box>
          {showCatalog && (
            <box flexDirection="column" width={catW} border={["left"]} borderColor={THEME.rule.faint} paddingX={1} overflow="hidden">
              <T color={THEME.ink.muted} bold>{"Command Catalogue"}</T>
              <scrollbox flexGrow={1} scrollY={true}>
                {COMMANDS.map((c) => (
                  <box key={c.name} flexDirection="column" flexShrink={0}>
                    <T color={THEME.ink.secondary}>
                      {`${c.name} ${c.args.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(" ")}`.trim()}
                    </T>
                    <T color={THEME.ink.faint}>{`  ${truncateCells(c.description, Math.max(8, catW - 4))}`}</T>
                  </box>
                ))}
              </scrollbox>
              <T color={THEME.ink.faint}>{"press : to run a command"}</T>
            </box>
          )}
        </box>
      </Panel>
    </box>
  )
}
