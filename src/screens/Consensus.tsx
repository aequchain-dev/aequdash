/**
 * aequdash — src/screens/Consensus.tsx
 *
 * Equality verification and consensus tests (guide §10.7). Calm and
 * deterministic: the invariant stated plainly, status color only on the
 * final state, never on every line.
 *
 *   Equality invariant
 *   member_value == treasury / member_count
 *   PASS     exact equality confirmed
 */

import { useTerminalDimensions } from "@opentui/react"
import { useStore } from "../state/store.tsx"
import { THEME, fmt0, fmt2, fmt4, fmtMs } from "../lib/theme.ts"
import { Panel, panelInnerWidth } from "../components/Panel.tsx"
import { DataRow, Blank } from "../components/DataRow.tsx"
import { Table, type Column } from "../components/Table.tsx"
import { T } from "../components/T.tsx"

export function Consensus() {
  const { snapshot } = useStore()
  const { width: tw } = useTerminalDimensions()
  const w = Math.max(24, tw - 6)
  const iw = panelInnerWidth(w)
  const half = Math.floor((w - 1) / 2)

  if (!snapshot) return <Panel title="Consensus" meta="Verification" width={w}><T color={THEME.ink.faint}>{"loading…"}</T></Panel>

  const eq = snapshot.equality
  const ct = snapshot.consensus

  return (
    <scrollbox flexGrow={1} scrollY={true} scrollbarOptions={{ visible: false }}>
      <box flexDirection="column" flexShrink={0}>
        <box flexDirection="row" gap={1} flexShrink={0}>
          {/* Equality invariant */}
          <Panel title="Equality Invariant" meta="Equidistribution" width={half}>
            <T color={THEME.ink.muted}>{"member_value == treasury / member_count"}</T>
            <Blank />
            {eq ? (
              <>
                <DataRow label="Treasury" value={`${fmt2(eq.treasury_value_aeq)} AEQ`} width={panelInnerWidth(half)} />
                <DataRow label="Members" value={fmt0(eq.total_members)} width={panelInnerWidth(half)} />
                <DataRow label="Expected Value" value={`${fmt2(eq.expected_member_value_aeq)} AEQ`} width={panelInnerWidth(half)} />
                <DataRow label="Variance" value={`${fmt4(eq.variance)} (threshold ${fmt4(eq.threshold)})`} width={panelInnerWidth(half)} />
                <Blank />
                <box flexDirection="row" height={1}>
                  <T color={eq.all_passed ? THEME.status.ok : THEME.status.error} bold>{eq.all_passed ? " PASS " : " FAIL "}</T>
                  <T color={THEME.ink.muted}>{eq.all_passed ? " exact equality confirmed" : " equality violated"}</T>
                </box>
              </>
            ) : (
              <T color={THEME.ink.faint}>{"equality_check not run yet"}</T>
            )}
          </Panel>

          {/* Consensus test */}
          <Panel title="Consensus Test" meta="Micro-Committee" width={half}>
            {ct ? (
              <>
                <DataRow label="Committee Size" value={fmt0(ct.committee_size)} width={panelInnerWidth(half)} />
                <DataRow label="Threshold" value={fmt0(ct.threshold)} width={panelInnerWidth(half)} />
                <DataRow label="Byzantine Tolerance" value={`f = ${ct.byzantine}`} width={panelInnerWidth(half)} />
                <DataRow label="Round" value={fmt0(ct.round)} width={panelInnerWidth(half)} />
                <DataRow label="Payments" value={`${ct.payments_confirmed}/${ct.payments_sent} confirmed`} width={panelInnerWidth(half)} />
                <DataRow label="Avg Latency" value={fmtMs(ct.avg_latency_ms)} width={panelInnerWidth(half)} />
                <Blank />
                <box flexDirection="row" height={1}>
                  <T color={ct.passed ? THEME.status.ok : THEME.status.error} bold>{ct.passed ? " PASS " : " FAIL "}</T>
                  <T color={THEME.ink.muted}>{ct.passed ? " single-round finality achieved" : " consensus failed"}</T>
                </box>
              </>
            ) : (
              <T color={THEME.ink.faint}>{"consensus_test not run yet"}</T>
            )}
          </Panel>
        </box>
        <box height={1} />
        {eq && eq.checks.length > 0 && (
          <Panel title="Per-Member Equality Checks" meta={`${eq.checks.length} verified`} width={w}>
            <Table
              columns={[
                { key: "id", label: "Member", width: 16, render: (c: { member_id: string; actual: number; expected: number; passed: boolean }) => c.member_id },
                { key: "actual", label: "Actual (AEQ)", width: 14, align: "right", render: (c) => fmt2(c.actual) },
                { key: "expected", label: "Expected (AEQ)", width: 14, align: "right", render: (c) => fmt2(c.expected) },
                { key: "pass", label: "Check", width: 8, align: "right", render: (c) => (c.passed ? "PASS" : "FAIL") },
              ]}
              rows={eq.checks}
              rowKey={(c) => c.member_id}
              width={iw}
            />
          </Panel>
        )}
      </box>
    </scrollbox>
  )
}
