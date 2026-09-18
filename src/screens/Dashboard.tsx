/**
 * aequdash — src/screens/Dashboard.tsx
 *
 * The canonical aequchain dashboard (guide §9/§10.1, reference image):
 *
 *   ┌ Treasury ─────┐ ┌ Members ───────┐ ┌ Your Member Value ─┐
 *   ┌ 24h Volume ───┐ ┌ Active Pledges ┌ ┌ 30d Spend Limit ───┐
 *   ┌───────────────── Recent Activity (Live Feed) ────────────┐
 *
 * Every value traces to SnapshotV2 state; all arithmetic is internally
 * consistent (member value = treasury / active members, etc.).
 *
 * Layout classes (guide §13): A = fixed 3-col + live activity; B = 3-col
 * scrolled; C = 2-col scrolled; D = 1-col scrolled; E = essentials only.
 */

import { useTerminalDimensions } from "@opentui/react"
import { useStore } from "../state/store.tsx"
import { THEME, fmt0, fmt2, fmtPct, fmtApprox, fmtCountdown, fmtDays, fmtTps, fmtMoney, MOTION } from "../lib/theme.ts"
import { classifyLayout, dashboardGeometry } from "../lib/layout.ts"
import { cellWidth, truncateCells } from "../lib/measure.ts"
import { Panel, panelInnerWidth } from "../components/Panel.tsx"
import { DataRow, Metric, SectionHeader, Blank } from "../components/DataRow.tsx"
import { Bar, DistBar, BarRow } from "../components/Bars.tsx"
import { Rule } from "../components/Rule.tsx"
import { ActivityLog } from "../components/ActivityLog.tsx"
import { LoadingBar } from "../components/LoadingBar.tsx"
import { T } from "../components/T.tsx"
import type { SnapshotV2 } from "../lib/types.ts"

// ─────────────────────────────────────────────────────────────────────────────
// Panels — each takes an explicit outer width
// ─────────────────────────────────────────────────────────────────────────────

function TreasuryPanel({ snap, w, h }: { snap: SnapshotV2; w: number; h?: number }) {
  const t = snap.treasury
  const iw = panelInnerWidth(w)
  if (!t) return <Panel title="Treasury" meta="Total Value" width={w} height={h}><T color={THEME.ink.faint}>{"—"}</T></Panel>
  const ratio = t.circulating_supply > 0 ? (t.total_aeq / t.circulating_supply) * 100 : 0
  const miniBarW = 12
  return (
    <Panel title="Treasury" meta="Total Value" width={w} height={h}>
      <Metric value={fmtMoney("$", t.total_usd)} approx={fmtApprox(t.total_aeq, "AEQ")} width={iw} />
      <Blank />
      {t.holdings.map((h) => (
        <DataRow
          key={h.denom}
          label={h.is_native ? `${h.denom} (native)` : h.denom}
          value={fmt2(h.amount_aeq)}
          suffix={`(${fmtPct((h.amount_aeq / t.total_aeq) * 100)})`}
          width={iw}
        />
      ))}
      <Blank />
      <Rule width={iw} />
      <DataRow label="Network Denomination" value={t.network_denom} width={iw} />
      <DataRow label="Total Supply" value={`${fmt2(t.total_supply)} AEQ`} width={iw} />
      <DataRow label="Circulating Supply" value={`${fmt2(t.circulating_supply)} AEQ`} width={iw} />
      <box flexDirection="row" height={1} width={iw}>
        <T color={THEME.ink.muted}>{"Treasury Ratio"}</T>
        <box flexGrow={1} />
        <T color={THEME.ink.secondary}>{fmtPct(ratio)}</T>
        <T>{" "}</T>
        <Bar pct={ratio * 4} width={miniBarW} />
      </box>
    </Panel>
  )
}

function MembersPanel({ snap, w, h }: { snap: SnapshotV2; w: number; h?: number }) {
  const m = snap.members_summary
  const iw = panelInnerWidth(w)
  if (!m) return <Panel title="Members" meta="Network" width={w} height={h}><T color={THEME.ink.faint}>{"—"}</T></Panel>
  // Left column never wraps its caption ("active members" = 14 cells)
  const leftW = Math.max(14, Math.min(16, Math.floor(iw * 0.34)))
  const rightW = iw - leftW - 2
  return (
    <Panel title="Members" meta="Network" width={w} height={h}>
      <box flexDirection="row" height={4} flexShrink={0}>
        <box width={leftW} flexDirection="column">
          <T color={THEME.ink.primary} bold>{fmt0(m.active_24h)}</T>
          <T color={THEME.ink.muted}>{"active members"}</T>
        </box>
        <box border={["left"]} borderColor={THEME.rule.faint} paddingX={1} flexGrow={1} flexDirection="column">
          <DataRow label="Total Registered" value={fmt0(m.total_registered)} width={rightW} />
          <DataRow label="Active (24h)" value={fmt0(m.active_24h)} width={rightW} />
          <DataRow label="Pending" value={fmt0(m.pending)} width={rightW} />
          <DataRow label="Suspended" value={fmt0(m.suspended)} width={rightW} />
        </box>
      </box>
      <SectionHeader label="Member Distribution" width={iw} />
      {m.distribution.map((d) => (
        <DistBar key={d.label} label={d.label} pct={d.pct} width={iw} labelWidth={14} />
      ))}
      <Rule width={iw} />
      <FormulaRow
        formula="Member_Value = Treasury / Members"
        value={fmtApprox(snap.member_value_aeq, "AEQ")}
        width={iw}
      />
    </Panel>
  )
}

/** Formula + right-aligned value; truncates the formula with ellipsis first. */
function FormulaRow({ formula, value, width }: { formula: string; value: string; width: number }) {
  const vw = cellWidth(value)
  const left = truncateCells(formula, Math.max(6, width - vw - 1))
  return (
    <box flexDirection="row" height={1} width={width} flexShrink={0}>
      <T color={THEME.ink.muted}>{left}</T>
      <box flexGrow={1} />
      <T color={THEME.ink.secondary}>{value}</T>
    </box>
  )
}

function MemberValuePanel({ snap, w, h }: { snap: SnapshotV2; w: number; h?: number }) {
  const p = snap.personal
  const iw = panelInnerWidth(w)
  if (!p || !p.member_id) {
    return (
      <Panel title="Your Member Value" meta="Personal" width={w} height={h}>
        <Metric value={fmtApprox(snap.member_value_aeq, "AEQ")} width={iw} />
        <Blank />
        <T color={THEME.ink.muted}>{"log in to see personal position"}</T>
      </Panel>
    )
  }
  return (
    <Panel title="Your Member Value" meta="Personal" width={w} height={h}>
      <Metric value={`${fmt2(p.value_aeq)} AEQ`} approx={`≈ $ ${fmt2(p.value_usd)}`} width={iw} />
      <Blank />
      <DataRow label="Your Share of Treasury" value={fmtPct(p.share_pct, 4)} width={iw} />
      <DataRow label="Your Active Pledges" value={String(p.active_pledges)} width={iw} />
      <DataRow label="Reputation Score" value={`${p.reputation.toFixed(1)} / 100`} width={iw} />
      <Blank />
      <SectionHeader label="Pledge Progress" width={iw} />
      {p.pledge_progress.slice(0, 3).map((pp) => (
        <BarRow
          key={pp.id}
          label={`Pledge #${pp.id}`}
          pct={pp.pct}
          rightValue={`${fmt0(pp.raised_aeq)} / ${fmt0(pp.target_aeq)} AEQ`}
          width={iw}
        />
      ))}
    </Panel>
  )
}

function VolumePanel({ snap, w, h }: { snap: SnapshotV2; w: number; h?: number }) {
  const v = snap.volume
  const iw = panelInnerWidth(w)
  if (!v) return <Panel title="24h Volume" meta="Network" width={w} height={h}><T color={THEME.ink.faint}>{"—"}</T></Panel>
  const kindLabel: Record<string, string> = { transfers: "Transfers", pledges: "Pledges", contracts: "Contracts", other: "Other" }
  return (
    <Panel title="24h Volume" meta="Network" width={w} height={h}>
      <Metric value={fmtMoney("$", v.total_usd)} approx={fmtApprox(v.total_aeq, "AEQ")} width={iw} />
      <Blank />
      {v.breakdown.map((b) => (
        <DataRow key={b.kind} label={kindLabel[b.kind] ?? b.kind} value={fmt2(b.amount_aeq)} suffix={`(${fmtPct(b.pct)})`} width={iw} />
      ))}
      <Blank />
      <SectionHeader label="Network Activity (24h)" width={iw} />
      <DataRow label="Tx Count" value={fmt0(v.tx_count_24h)} width={iw} />
      <DataRow label="Avg. Tx Fee" value={`${fmt2(v.avg_fee_aeq)} AEQ`} width={iw} />
      <DataRow label="Block Height" value={fmt0(v.block_height)} width={iw} />
      <DataRow label="TPS" value={fmtTps(v.tps_1m)} width={iw} />
    </Panel>
  )
}

function PledgesPanel({ snap, w, h }: { snap: SnapshotV2; w: number; h?: number }) {
  const p = snap.pledges_summary
  const iw = panelInnerWidth(w)
  if (!p) return <Panel title="Active Pledges" meta="Pledges" width={w} height={h}><T color={THEME.ink.faint}>{"—"}</T></Panel>
  // Left column never wraps its caption ("active pledges" = 14 cells)
  const leftW = Math.max(14, Math.min(16, Math.floor(iw * 0.34)))
  const rightW = iw - leftW - 2
  return (
    <Panel title="Active Pledges" meta="Pledges" width={w} height={h}>
      <box flexDirection="row" height={4} flexShrink={0}>
        <box width={leftW} flexDirection="column">
          <T color={THEME.ink.primary} bold>{fmt0(p.total)}</T>
          <T color={THEME.ink.muted}>{"active pledges"}</T>
        </box>
        <box border={["left"]} borderColor={THEME.rule.faint} paddingX={1} flexGrow={1} flexDirection="column">
          <DataRow label="Total Value" value={`${fmt2(p.total_value_aeq)} AEQ`} width={rightW} />
          <DataRow label="Completed" value={fmt0(p.completed)} width={rightW} />
          <DataRow label="In Progress" value={fmt0(p.in_progress)} width={rightW} />
          <DataRow label="Failed" value={fmt0(p.failed)} width={rightW} />
        </box>
      </box>
      <SectionHeader label="Pledge Distribution" width={iw} />
      {p.distribution.map((d) => (
        <DistBar key={d.label} label={d.label} pct={d.pct} count={d.count} width={iw} labelWidth={14} />
      ))}
      <Rule width={iw} />
      {iw >= 40 ? (
        <box flexDirection="row" height={1} width={iw}>
          <T color={THEME.ink.muted}>{"Avg. Duration"}</T>
          <T color={THEME.ink.secondary}>{`  ${fmtDays(p.avg_duration_days)}`}</T>
          <box flexGrow={1} />
          <T color={THEME.ink.muted}>{"Success Rate"}</T>
          <T color={THEME.ink.secondary}>{`  ${fmtPct(p.success_rate)}`}</T>
        </box>
      ) : (
        <FormulaRow formula="Avg. Duration / Success" value={`${fmtDays(p.avg_duration_days)} · ${fmtPct(p.success_rate)}`} width={iw} />
      )}
    </Panel>
  )
}

function SpendPanel({ snap, w, h }: { snap: SnapshotV2; w: number; h?: number }) {
  const s = snap.spend
  const iw = panelInnerWidth(w)
  if (!s) return <Panel title="30d Spend Limit" meta="Economy" width={w} height={h}><T color={THEME.ink.faint}>{"—"}</T></Panel>
  const resetMs = Date.parse(s.reset_at) - Date.parse(snap.server_time)
  return (
    <Panel title="30d Spend Limit" meta="Economy" width={w} height={h}>
      <Metric value={fmtMoney("$", s.limit_usd)} approx={fmtApprox(s.limit_aeq, "AEQ")} width={iw} />
      <Blank />
      <DataRow label="Used (30d)" value={fmt2(s.used_usd)} suffix={`(${fmtPct(s.used_pct)})`} width={iw} />
      <DataRow label="Remaining" value={fmt2(s.remaining_usd)} suffix={`(${fmtPct(100 - s.used_pct)})`} width={iw} />
      <Bar pct={s.used_pct} width={iw} />
      <Blank />
      <DataRow label="Daily Average" value={`${fmt2(s.daily_avg_aeq)} AEQ`} width={iw} />
      <DataRow label="Projected (30d)" value={`${fmt2(s.projected_30d_aeq)} AEQ`} width={iw} />
      <DataRow label="Limit Reset" value={fmtCountdown(resetMs)} width={iw} />
      <Rule width={iw} />
      <DataRow label="Network Denomination" value={s.network_denom} width={iw} />
      <DataRow label="Spend Policy" value={s.policy} width={iw} />
      <DataRow label="Max per Member" value={`${fmt2(s.max_per_member_aeq)} AEQ`} width={iw} />
    </Panel>
  )
}

function ActivityPanel({ snap, w, h }: { snap: SnapshotV2; w: number; h?: number }) {
  return (
    <Panel title="Recent Activity" meta="Live Feed" marker="( )" width={w} height={h} flexGrow={h === undefined ? 1 : undefined}>
      <ActivityLog events={snap.activity} width={panelInnerWidth(w)} height={h ? h - 2 : undefined} />
    </Panel>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Screen
// ─────────────────────────────────────────────────────────────────────────────

export function Dashboard() {
  const { snapshot, status } = useStore()
  const { width: tw, height: th } = useTerminalDimensions()
  const cls = classifyLayout(tw, th)
  const geo = dashboardGeometry(cls, tw, th)

  if (status === "starting" || status === "compiling" || !snapshot) {
    return <LoadingDashboard />
  }

  // Content width inside frame (app padding 1+1, frame borders 1+1, content paddingX 1+1)
  const contentW = Math.max(24, tw - 6)

  if (cls === "E") {
    return <MinimalDashboard snap={snapshot} w={contentW} />
  }

  const cols = cls === "A" || cls === "B" ? 3 : cls === "C" ? 2 : 1
  const gap = geo.gap
  const panelW = cols === 3
    ? Math.floor((contentW - gap * 2) / 3)
    : cols === 2
      ? Math.floor((contentW - gap) / 2)
      : contentW
  const rowH = geo.panelRowHeight

  const grid = (
    <>
      {cols === 3 && (
        <>
          <box flexDirection="row" height={rowH} flexShrink={0} gap={gap}>
            <TreasuryPanel snap={snapshot} w={panelW} h={rowH} />
            <MembersPanel snap={snapshot} w={panelW} h={rowH} />
            <MemberValuePanel snap={snapshot} w={panelW} h={rowH} />
          </box>
          <box height={gap} flexShrink={0} />
          <box flexDirection="row" height={rowH} flexShrink={0} gap={gap}>
            <VolumePanel snap={snapshot} w={panelW} h={rowH} />
            <PledgesPanel snap={snapshot} w={panelW} h={rowH} />
            <SpendPanel snap={snapshot} w={panelW} h={rowH} />
          </box>
          <box height={gap} flexShrink={0} />
        </>
      )}
      {cols === 2 && (
        <>
          {[
            [<TreasuryPanel key="t" snap={snapshot} w={panelW} h={rowH} />, <MembersPanel key="m" snap={snapshot} w={panelW} h={rowH} />],
            [<MemberValuePanel key="v" snap={snapshot} w={panelW} h={rowH} />, <VolumePanel key="o" snap={snapshot} w={panelW} h={rowH} />],
            [<PledgesPanel key="p" snap={snapshot} w={panelW} h={rowH} />, <SpendPanel key="s" snap={snapshot} w={panelW} h={rowH} />],
          ].map((pair, i) => (
            <box key={i} flexDirection="row" height={rowH} flexShrink={0} gap={gap} marginTop={i === 0 ? 0 : gap}>
              {pair}
            </box>
          ))}
          <box height={gap} flexShrink={0} />
        </>
      )}
      {cols === 1 && (
        <>
          <TreasuryPanel snap={snapshot} w={panelW} h={rowH} />
          <box height={gap} flexShrink={0} />
          <MembersPanel snap={snapshot} w={panelW} h={rowH} />
          <box height={gap} flexShrink={0} />
          <MemberValuePanel snap={snapshot} w={panelW} h={rowH} />
          <box height={gap} flexShrink={0} />
          <VolumePanel snap={snapshot} w={panelW} h={rowH} />
          <box height={gap} flexShrink={0} />
          <PledgesPanel snap={snapshot} w={panelW} h={rowH} />
          <box height={gap} flexShrink={0} />
          <SpendPanel snap={snapshot} w={panelW} h={rowH} />
          <box height={gap} flexShrink={0} />
        </>
      )}
      <ActivityPanel
        snap={snapshot}
        w={cols === 3 ? contentW : panelW * cols + gap * (cols - 1)}
        h={cls === "A" ? Math.max(geo.activityMin, th - 7 - (rowH * 2 + gap * 2)) : undefined}
      />
    </>
  )

  if (cls === "A") {
    return (
      <box flexDirection="column" flexGrow={1} overflow="hidden">
        {grid}
      </box>
    )
  }

  // B / C / D — scrolled composition; activity below the fold remains reachable.
  return (
    <scrollbox flexGrow={1} scrollY={true} stickyScroll={false}
      scrollbarOptions={{ visible: true, trackOptions: { foregroundColor: THEME.rule.faint, backgroundColor: THEME.bg.canvas } }}>
      <box flexDirection="column" flexShrink={0}>
        {grid}
      </box>
    </scrollbox>
  )
}

/** Class E — minimum viable: essentials only, never overlapped. */
function MinimalDashboard({ snap, w }: { snap: SnapshotV2; w: number }) {
  const t = snap.treasury
  const m = snap.members_summary
  const p = snap.personal
  return (
    <scrollbox flexGrow={1} scrollY={true}>
      <box flexDirection="column" flexShrink={0}>
        <Panel title="Summary" meta="Essentials" width={w}>
          {t && <Metric value={fmtMoney("$", t.total_usd)} approx={fmtApprox(t.total_aeq, "AEQ")} width={panelInnerWidth(w)} />}
          <Blank />
          {m && <DataRow label="Active Members" value={fmt0(m.active_24h)} width={panelInnerWidth(w)} />}
          <DataRow label="Member Value" value={`${fmt2(snap.member_value_aeq)} AEQ`} width={panelInnerWidth(w)} />
          {p && p.member_id && <DataRow label="You" value={`${p.member_id} · ${p.reputation.toFixed(1)}/100`} width={panelInnerWidth(w)} />}
          <DataRow label="Block Height" value={fmt0(snap.block_height)} width={panelInnerWidth(w)} />
        </Panel>
        <box height={1} />
        <Panel title="Recent Activity" meta="Live Feed" marker="( )" width={w}>
          <ActivityLog events={snap.activity} width={panelInnerWidth(w)} cap={20} />
        </Panel>
      </box>
    </scrollbox>
  )
}

function LoadingDashboard() {
  const { status } = useStore()
  const label =
    status === "starting" ? "starting julia" :
    status === "compiling" ? "compiling packages" :
    status === "error" ? "falling back to simulation" :
    "connecting"
  const { width: tw } = useTerminalDimensions()
  const w = Math.max(24, tw - 6)
  return (
    <box flexDirection="column" flexGrow={1}>
      <Panel title="aequchain" meta="Ephemeral Testnet" width={w}>
        <Blank />
        <LoadingBar width={Math.min(48, panelInnerWidth(w) - 4)} label={label} />
        <Blank />
      </Panel>
    </box>
  )
}
