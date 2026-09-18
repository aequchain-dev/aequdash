/**
 * aequdash — src/screens/Businesses.tsx
 *
 * Enterprise network participation and allocations (guide §10.4).
 * Priorities: identity · network · contribution rate · employees ·
 * allocation · 30d spend. Consistent decimal precision throughout.
 */

import { useTerminalDimensions } from "@opentui/react"
import { useStore } from "../state/store.tsx"
import { THEME, fmt2, fmt0, fmtPct } from "../lib/theme.ts"
import { Panel, panelInnerWidth } from "../components/Panel.tsx"
import { Table, type Column } from "../components/Table.tsx"
import { DataRow, StatSplit } from "../components/DataRow.tsx"
import { T } from "../components/T.tsx"
import type { BusinessV2 } from "../lib/types.ts"

export function Businesses() {
  const { snapshot } = useStore()
  const { width: tw } = useTerminalDimensions()
  const w = Math.max(24, tw - 6)
  const iw = panelInnerWidth(w)

  if (!snapshot) return <Panel title="Businesses" meta="Enterprise" width={w}><T color={THEME.ink.faint}>{"loading…"}</T></Panel>

  const biz = snapshot.businesses
  const totalAlloc = biz.reduce((a, b) => a + b.treasury_allocation_aeq, 0)
  const totalSpent = biz.reduce((a, b) => a + b.thirty_day_used_aeq, 0)
  const totalEmp = biz.reduce((a, b) => a + b.employees, 0)

  const cols: Column<BusinessV2>[] = [
    { key: "name", label: "Business", width: 18, render: (b) => b.name },
    { key: "net", label: "Network", width: 12, render: (b) => b.net_id },
    { key: "ec", label: "EC Rate", width: 8, align: "right", render: (b) => fmtPct(b.contribution_rate * 100, 1) },
    { key: "employees", label: "Employees", width: 10, align: "right", render: (b) => fmt0(b.employees) },
    { key: "alloc", label: "Allocation (AEQ)", width: 16, align: "right", render: (b) => fmt2(b.treasury_allocation_aeq) },
    { key: "spent", label: "30d Spend (AEQ)", width: 14, align: "right", render: (b) => fmt2(b.thirty_day_used_aeq) },
  ]

  return (
    <box flexDirection="column" flexGrow={1} overflow="hidden">
      <Panel title="Businesses" meta="Enterprise" width={w}>
        <StatSplit
          width={iw}
          left={<>
            <DataRow label="Registered" value={fmt0(biz.length)} width={Math.floor(iw / 3)} />
            <DataRow label="Total Employees" value={fmt0(totalEmp)} width={Math.floor(iw / 3)} />
          </>}
          right={<>
            <DataRow label="Treasury Allocated" value={`${fmt2(totalAlloc)} AEQ`} width={iw - Math.floor(iw / 3) - 2} />
            <DataRow label="30d Business Spend" value={`${fmt2(totalSpent)} AEQ`} width={iw - Math.floor(iw / 3) - 2} />
          </>}
        />
      </Panel>
      <box height={1} />
      <Panel title="Business Directory" meta={`${biz.length} registered`} width={w} flexGrow={1}>
        <scrollbox flexGrow={1} scrollY={true} scrollbarOptions={{ visible: false }}>
          <Table columns={cols} rows={biz} rowKey={(b) => b.id} width={iw} />
          <T color={THEME.ink.faint}>{"create_bus <name> <net> [ec] · set_ec <bus> <rate> · hire <bus> <member> · bus_withdraw <bus> <amount>"}</T>
        </scrollbox>
      </Panel>
    </box>
  )
}
