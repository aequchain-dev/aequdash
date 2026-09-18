/**
 * aequdash — src/screens/Networks.tsx
 *
 * Networks, denominations and participation (guide §10.3). Numerically
 * aligned denomination/rate/member columns; semantic emphasis only for the
 * active network or an abnormal peg.
 */

import { useTerminalDimensions } from "@opentui/react"
import { useStore } from "../state/store.tsx"
import { THEME, fmt2, fmt0, fmt4 } from "../lib/theme.ts"
import { Panel, panelInnerWidth } from "../components/Panel.tsx"
import { Table, type Column } from "../components/Table.tsx"
import { DataRow, Blank, StatSplit } from "../components/DataRow.tsx"
import { T } from "../components/T.tsx"
import type { NetworkV2 } from "../lib/types.ts"

export function Networks() {
  const { snapshot } = useStore()
  const { width: tw } = useTerminalDimensions()
  const w = Math.max(24, tw - 6)
  const iw = panelInnerWidth(w)

  if (!snapshot) return <Panel title="Networks" meta="Networks" width={w}><T color={THEME.ink.faint}>{"loading…"}</T></Panel>

  const nets = snapshot.networks
  const totalValue = nets.reduce((a, n) => a + n.value_aeq, 0)
  const totalMembers = nets.reduce((a, n) => a + n.members, 0)

  const cols: Column<NetworkV2>[] = [
    { key: "name", label: "Network", width: 16, render: (n) => n.name },
    { key: "denom", label: "Denom", width: 8, render: (n) => n.denom },
    { key: "peg", label: "Peg Rate", width: 10, align: "right", render: (n) => fmt4(n.peg_rate) },
    { key: "members", label: "Members", width: 10, align: "right", render: (n) => fmt0(n.members) },
    { key: "value", label: "Value (AEQ)", width: 16, align: "right", render: (n) => fmt2(n.value_aeq) },
    { key: "share", label: "Share", width: 8, align: "right", render: (n) => `${((n.value_aeq / Math.max(1, totalValue)) * 100).toFixed(1)}%` },
  ]

  return (
    <box flexDirection="column" flexGrow={1} overflow="hidden">
      <Panel title="Networks" meta="Participation" width={w}>
        <StatSplit
          width={iw}
          left={<>
            <DataRow label="Networks" value={fmt0(nets.length)} width={Math.floor(iw / 3)} />
            <DataRow label="Total Members" value={fmt0(totalMembers)} width={Math.floor(iw / 3)} />
          </>}
          right={<>
            <DataRow label="Circulating (AEQ)" value={fmt2(totalValue)} width={iw - Math.floor(iw / 3) - 2} />
            <DataRow label="Base Peg" value="AEQ = 1.0000" width={iw - Math.floor(iw / 3) - 2} />
          </>}
        />
      </Panel>
      <box height={1} />
      <Panel title="Network Directory" meta={`${nets.length} networks`} width={w} flexGrow={1}>
        <scrollbox flexGrow={1} scrollY={true} scrollbarOptions={{ visible: false }}>
          <Table columns={cols} rows={nets} rowKey={(n) => n.id} activeKey="aequ_net" width={iw} />
          <Blank />
          <T color={THEME.ink.faint}>{"create_net <name> <denom> <rate> · join_net <member> <net> · transfer_net <member> <from> <to>"}</T>
        </scrollbox>
      </Panel>
    </box>
  )
}
