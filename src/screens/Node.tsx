/**
 * aequdash — src/screens/Node.tsx
 *
 * Ephemeral testnet node (guide §10.6) — the most operational screen.
 * Groups: status · configuration · accounts · blocks · quorum certificates ·
 * live metrics. Slightly denser than other screens; same border/typography
 * grammar.
 */

import { useEffect, useState } from "react"
import { useTerminalDimensions } from "@opentui/react"
import { useStore } from "../state/store.tsx"
import { THEME, fmt0, fmt2, fmtBytes, fmtMs, fmtTps, shortHash } from "../lib/theme.ts"
import { Panel, panelInnerWidth } from "../components/Panel.tsx"
import { DataRow, StatSplit } from "../components/DataRow.tsx"
import { Table, type Column } from "../components/Table.tsx"
import { T } from "../components/T.tsx"
import { Qr } from "../components/Qr.tsx"
import type { NodeAccount, BlockV2, ClusterNodeInfo } from "../lib/types.ts"

interface InviteInfo {
  code: string | null
  endpoint: string
  clusterId: string
  gated: boolean
}

export function Node() {
  const { snapshot, bridge } = useStore()
  const { width: tw } = useTerminalDimensions()
  const w = Math.max(24, tw - 6)
  const iw = panelInnerWidth(w)
  const half = Math.floor((w - 1) / 2)

  // Solo nodes publish their join coordinates; gateways/simulators answer
  // net.invite with an error, which we swallow (no panel for those backends).
  const [invite, setInvite] = useState<InviteInfo | null>(null)
  useEffect(() => {
    let alive = true
    bridge.call("net.invite")
      .then((v) => { if (alive && v && typeof v === "object") setInvite(v as InviteInfo) })
      .catch(() => {})
    return () => { alive = false }
  }, [bridge])

  if (!snapshot) return <Panel title="Node" meta="Testnet" width={w}><T color={THEME.ink.faint}>{"loading…"}</T></Panel>
  const node = snapshot.node

  if (!node || !node.running) {
    return (
      <Panel title="Node" meta="Testnet" width={w}>
        <T color={THEME.ink.muted}>{"node not initialized"}</T>
        <T color={THEME.ink.faint}>{"node_init [committee] [threshold] [seed]"}</T>
      </Panel>
    )
  }

  const m = node.metrics
  const cluster = snapshot.cluster

  const acctCols: Column<NodeAccount>[] = [
    { key: "id", label: "Account", width: 14, render: (a) => a.id },
    { key: "bal", label: "Balance (AEQ)", width: 14, align: "right", render: (a) => fmt2(a.balance_aeq) },
    { key: "nonce", label: "Nonce", width: 7, align: "right", render: (a) => String(a.nonce) },
    { key: "head", label: "Head", width: 14, render: (a) => shortHash(a.head_hash) },
  ]

  const meshCols: Column<ClusterNodeInfo>[] = [
    { key: "id", label: "Node", width: 14, render: (n) => n.id },
    { key: "addr", label: "Address", width: 18, render: (n) => `${n.host}:${n.port}` },
    { key: "status", label: "Status", width: 8, render: (n) => (n.status === "live" ? "LIVE" : "DOWN") },
    { key: "height", label: "Height", width: 9, align: "right", render: (n) => fmt0(n.height) },
    { key: "peers", label: "Peers", width: 7, align: "right", render: (n) => String(n.peers) },
    { key: "root", label: "State Root", width: 16, render: (n) => shortHash(n.state_root) },
    { key: "up", label: "Uptime", width: 8, align: "right", render: (n) => `${Math.floor(n.uptime_s / 60)}m${n.uptime_s % 60}s` },
  ]

  const blockCols: Column<BlockV2>[] = [
    { key: "idx", label: "#", width: 8, align: "right", render: (b) => String(b.index) },
    { key: "hash", label: "Hash", width: 16, render: (b) => shortHash(b.hash) },
    { key: "txs", label: "Txs", width: 5, align: "right", render: (b) => String(b.tx_count) },
    { key: "val", label: "Validator", width: 14, render: (b) => b.validator },
  ]

  const metricL = Math.floor(iw / 3)
  const metricR = iw - metricL - 2

  return (
    <scrollbox flexGrow={1} scrollY={true} scrollbarOptions={{ visible: false }}>
      <box flexDirection="column" flexShrink={0}>
        <box flexDirection="row" gap={1} flexShrink={0}>
          <Panel title="Node Status" meta={node.label} width={half}>
            <DataRow label="Status" value={node.running ? "RUNNING" : "STOPPED"} valueColor={node.running ? THEME.status.ok : THEME.status.error} width={panelInnerWidth(half)} />
            <DataRow label="Version" value={node.version} width={panelInnerWidth(half)} />
            <DataRow label="Peers" value={fmt0(m?.peers ?? 0)} width={panelInnerWidth(half)} />
            <DataRow label="Uptime" value={`${Math.floor((m?.uptime_seconds ?? 0) / 60)}m`} width={panelInnerWidth(half)} />
          </Panel>
          <Panel title="Configuration" meta="Committee" width={half}>
            <DataRow label="Committee Size" value={fmt0(node.config.committee_size)} width={panelInnerWidth(half)} />
            <DataRow label="Quorum Threshold" value={fmt0(node.config.threshold)} width={panelInnerWidth(half)} />
            <DataRow label="Epoch Seed" value={node.config.epoch_seed} width={panelInnerWidth(half)} />
            <DataRow label="State Root" value={shortHash(node.state_root_hex)} width={panelInnerWidth(half)} />
          </Panel>
        </box>
        <box height={1} />
        {invite && (
          <>
            <Panel
              title="Network & Invite"
              meta={invite.gated ? "invite-gated" : "open"}
              width={w}
            >
              <DataRow label="Network" value={invite.clusterId} width={iw} />
              <DataRow label="Endpoint" value={invite.endpoint} width={iw} />
              <DataRow
                label="Join as peer"
                value={invite.code ?? `aequdash join ${invite.endpoint}`}
                width={iw}
              />
              {invite.code && (
                <>
                  <T color={THEME.ink.faint}>{"scan to join — the network lives only while peers do:"}</T>
                  <box height={1} />
                  <Qr text={invite.code} />
                </>
              )}
              {!invite.code && (
                <T color={THEME.ink.faint}>{"share the endpoint above — anyone dialing it joins as a real peer"}</T>
              )}
            </Panel>
            <box height={1} />
          </>
        )}
        {cluster && (
          <>
            <Panel
              title="Mesh"
              meta={`${cluster.mesh_size} live node${cluster.mesh_size === 1 ? "" : "s"} · ${cluster.all_converged ? "converged" : "syncing"}`}
              width={w}
            >
              <Table columns={meshCols} rows={cluster.nodes} rowKey={(n) => n.id} width={iw} maxRows={8} />
              <T color={THEME.ink.faint}>{"node_stop <id> · node_start <id> · net_nodes — ephemeral: state vanishes when the mesh empties"}</T>
            </Panel>
            <box height={1} />
          </>
        )}
        <Panel title="Live Metrics" meta="Performance" width={w}>
          <StatSplit
            width={iw}
            leftWidth={metricL}
            left={<>
              <DataRow label="Total Payments" value={fmt0(m?.total_payments ?? 0)} width={metricL} />
              <DataRow label="Throughput" value={`${fmtTps(m?.throughput_tps ?? 0)} tps`} width={metricL} />
            </>}
            right={<>
              <DataRow label="Avg Latency" value={fmtMs(m?.avg_latency_ms ?? 0)} width={metricR} />
              <DataRow label="Memory" value={fmtBytes(m?.memory_bytes ?? 0)} width={metricR} />
            </>}
          />
        </Panel>
        <box height={1} />
        <box flexDirection="row" gap={1} flexShrink={0}>
          <Panel title="Accounts" meta={`${node.accounts.length}`} width={half}>
            <Table columns={acctCols} rows={node.accounts} rowKey={(a) => a.id} width={panelInnerWidth(half)} maxRows={8} />
          </Panel>
          <Panel title="Recent Blocks" meta={`${node.blocks.length}`} width={half}>
            <Table columns={blockCols} rows={[...node.blocks].reverse()} rowKey={(b) => b.hash} width={panelInnerWidth(half)} maxRows={8} />
          </Panel>
        </box>
        <box height={1} />
        <Panel title="Quorum Certificates" meta={`${node.quorum_certs.length} QCs`} width={w}>
          {node.quorum_certs.slice(-4).map((qc) => (
            <DataRow key={qc.block_hash} label={`${qc.committee_id} · ${shortHash(qc.block_hash)}`} value={`${qc.signatures}/${qc.threshold} signatures`} width={iw} />
          ))}
          <T color={THEME.ink.faint}>{"node_register <acct> <balance> · node_pay <from> <to> <amount> · node_reset"}</T>
        </Panel>
      </box>
    </scrollbox>
  )
}
