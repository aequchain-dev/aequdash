/**
 * aequdash — src/screens/Pledges.tsx
 *
 * Pledge targets, progress and supporters (guide §10.5). The primary visual
 * is progress: compact horizontal bars, restrained, aligned with numbers.
 */

import { useTerminalDimensions } from "@opentui/react"
import { useStore } from "../state/store.tsx"
import { THEME, fmt2, fmt0, fmtPct, fmtDays } from "../lib/theme.ts"
import { Panel, panelInnerWidth } from "../components/Panel.tsx"
import { DataRow, Blank, StatSplit } from "../components/DataRow.tsx"
import { Bar, DistBar } from "../components/Bars.tsx"
import { T } from "../components/T.tsx"
import type { PledgeV2, PledgeStatus } from "../lib/types.ts"

function statusColor(s: PledgeStatus): string {
  switch (s) {
    case "completed": return THEME.status.ok
    case "failed": return THEME.status.error
    default: return THEME.ink.muted
  }
}

function statusLabel(s: PledgeStatus): string {
  switch (s) {
    case "completed": return "completed"
    case "failed": return "failed"
    default: return "in progress"
  }
}

function PledgeCard({ p, width }: { p: PledgeV2; width: number }) {
  const pct = p.target_aeq > 0 ? (p.raised_aeq / p.target_aeq) * 100 : 0
  const supporters = `${p.supporters.length} ${p.supporters.length === 1 ? "supporter" : "supporters"}`
  return (
    <box flexDirection="column" width={width} flexShrink={0} marginBottom={1}>
      <box flexDirection="row" height={1} width={width}>
        <T color={THEME.ink.faint}>{`#${p.id}  `}</T>
        <T color={THEME.ink.primary} bold>{p.name}</T>
        <T color={THEME.ink.muted}>{`  ${p.category}`}</T>
        <box flexGrow={1} />
        <T color={statusColor(p.status)} bold={p.status !== "in_progress"}>{statusLabel(p.status)}</T>
      </box>
      <box flexDirection="row" height={1} width={width}>
        <T color={THEME.ink.secondary}>{`${fmt2(p.raised_aeq)} / ${fmt2(p.target_aeq)} AEQ`}</T>
        <box flexGrow={1} />
        <T color={THEME.ink.muted}>{`${fmtPct(pct)} · ${supporters} · ${fmtDays(p.duration_days)}`}</T>
      </box>
      <Bar pct={pct} width={width} />
    </box>
  )
}

export function Pledges() {
  const { snapshot } = useStore()
  const { width: tw } = useTerminalDimensions()
  const w = Math.max(24, tw - 6)
  const iw = panelInnerWidth(w)

  if (!snapshot) return <Panel title="Pledges" meta="Targets" width={w}><T color={THEME.ink.faint}>{"loading…"}</T></Panel>

  const sum = snapshot.pledges_summary
  const pledges = [...snapshot.pledges].sort((a, b) => (b.raised_aeq / b.target_aeq) - (a.raised_aeq / a.target_aeq))

  return (
    <box flexDirection="column" flexGrow={1} overflow="hidden">
      {sum && (
        <>
          <Panel title="Pledges" meta="Overview" width={w}>
            <StatSplit
              width={iw}
              left={<>
                <DataRow label="Total" value={fmt0(sum.total)} width={Math.floor(iw / 3)} />
                <DataRow label="In Progress" value={fmt0(sum.in_progress)} width={Math.floor(iw / 3)} />
                <DataRow label="Completed" value={fmt0(sum.completed)} width={Math.floor(iw / 3)} />
                <DataRow label="Failed" value={fmt0(sum.failed)} width={Math.floor(iw / 3)} />
              </>}
              right={<>
                <DataRow label="Total Value" value={`${fmt2(sum.total_value_aeq)} AEQ`} width={iw - Math.floor(iw / 3) - 2} />
                <DataRow label="Avg. Duration" value={fmtDays(sum.avg_duration_days)} width={iw - Math.floor(iw / 3) - 2} />
                <DataRow label="Success Rate" value={fmtPct(sum.success_rate)} width={iw - Math.floor(iw / 3) - 2} />
              </>}
            />
          </Panel>
          <box height={1} />
        </>
      )}
      <Panel title="Active Pledges" meta={`${pledges.length} shown`} width={w} flexGrow={1}>
        <scrollbox flexGrow={1} scrollY={true} scrollbarOptions={{ visible: false }}>
          <box flexDirection="column" flexShrink={0}>
            {pledges.map((p) => <PledgeCard key={p.id} p={p} width={iw} />)}
            <Blank />
            <T color={THEME.ink.faint}>{"create_pledge <name> <target> <net> [purpose] · support <pledge_id> <amount>"}</T>
          </box>
        </scrollbox>
      </Panel>
    </box>
  )
}
