/**
 * aequdash — src/screens/Identity.tsx
 *
 * Member/account inspection (guide §10.2). Clean tabular view with
 * generous column breathing room; current user marked with the quiet
 * active surface. Personal summary panel above the table.
 */

import { useTerminalDimensions } from "@opentui/react"
import { useStore } from "../state/store.tsx"
import { THEME, fmt2, fmtPct, fmt0 } from "../lib/theme.ts"
import { Panel, panelInnerWidth } from "../components/Panel.tsx"
import { Table, type Column } from "../components/Table.tsx"
import { DataRow, Metric, Blank } from "../components/DataRow.tsx"
import { Bar } from "../components/Bars.tsx"
import { T } from "../components/T.tsx"
import type { MemberV2 } from "../lib/types.ts"

export function Identity() {
  const { snapshot } = useStore()
  const { width: tw } = useTerminalDimensions()
  const w = Math.max(24, tw - 6)
  const iw = panelInnerWidth(w)

  if (!snapshot) return <Panel title="Identity" meta="Members" width={w}><T color={THEME.ink.faint}>{"loading…"}</T></Panel>

  const members = snapshot.members
  const me = snapshot.personal

  const cols: Column<MemberV2>[] = [
    { key: "id", label: "Member", width: 14, render: (m) => m.id },
    { key: "value", label: "Value (AEQ)", width: 12, align: "right", render: (m) => fmt2(m.value_aeq) },
    { key: "status", label: "Status", width: 10, render: (m) => m.status },
    { key: "region", label: "Region", width: 14, render: (m) => m.region },
    { key: "rep", label: "Rep", width: 6, align: "right", render: (m) => m.reputation.toFixed(1) },
    { key: "nets", label: "Networks", width: 8, align: "right", render: (m) => String(m.networks.length) },
    { key: "biz", label: "Biz", width: 5, align: "right", render: (m) => String(m.businesses.length) },
    { key: "spend", label: "30d Spend", width: 12, align: "right", render: (m) => `${fmt2(m.spend_used_30d_aeq)}` },
  ]

  return (
    <box flexDirection="column" flexGrow={1} overflow="hidden">
      {me && me.member_id && (
        <>
          <Panel title="Your Identity" meta="Personal" width={w}>
            <box flexDirection="row" height={4}>
              <box flexDirection="column" width={Math.floor(iw * 0.4)}>
                <T color={THEME.ink.primary} bold>{me.member_id}</T>
                <T color={THEME.ink.muted}>{`${fmt2(me.value_aeq)} AEQ · ≈ $ ${fmt2(me.value_usd)}`}</T>
                <T color={THEME.ink.muted}>{`share of treasury ${fmtPct(me.share_pct, 4)}`}</T>
              </box>
              <box flexDirection="column" flexGrow={1} paddingLeft={2}>
                <DataRow label="Reputation" value={`${me.reputation.toFixed(1)} / 100`} width={iw - Math.floor(iw * 0.4) - 2} />
                <DataRow label="Active Pledges" value={String(me.active_pledges)} width={iw - Math.floor(iw * 0.4) - 2} />
                <box flexDirection="row" height={1}>
                  <T color={THEME.ink.muted}>{"Spend window"}</T>
                  <box flexGrow={1} />
                  <Bar pct={snapshot.spend?.used_pct ?? 0} width={Math.min(24, Math.floor(iw * 0.3))} />
                </box>
              </box>
            </box>
          </Panel>
          <box height={1} />
        </>
      )}
      <Panel title="Members" meta={`${fmt0(snapshot.members_summary?.total_registered ?? members.length)} registered`} width={w} flexGrow={1}>
        <scrollbox flexGrow={1} scrollY={true} scrollbarOptions={{ visible: false }}>
          <Table columns={cols} rows={members} rowKey={(m) => m.id} activeKey={snapshot.current_user} width={iw} />
        </scrollbox>
      </Panel>
    </box>
  )
}
