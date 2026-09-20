/**
 * aequdash — src/node/genesis.ts
 *
 * Deterministic genesis scenario for the ephemeral testnet.
 *
 * Every node must produce the IDENTICAL seed list — this function is pure:
 * no randomness, no wall clock. Seed txs carry fixed clientTs and sequential
 * nonces, so their ids are byte-identical on every node in the mesh.
 *
 * The scenario creates a living, populated network through REAL operations:
 * members join with deposits (the treasury is the exact sum), networks are
 * created, businesses are founded and hire, pledges are created and
 * supported, payment accounts are registered and transact. Nothing is
 * fabricated — every number in every snapshot traces to these txs and the
 * ones users submit afterward.
 */

import { makeTx } from "./block.ts"
import { derivePledgeId, slugify } from "./ledger.ts"
import type { Tx } from "./proto.ts"

const SEED_TS = 1_700_000_000_000

/** Number of generated citizen members (beyond the 12 named working set). */
export const CITIZEN_COUNT = 4_096

const REGIONS = [
  "North America", "North America", "North America", "North America",
  "Europe", "Europe", "Europe",
  "Asia", "Asia", "Asia",
  "Africa", "Africa",
  "Latin America",
  "Oceania",
] as const

export function demoSeedTxs(): Tx[] {
  const txs: Tx[] = []
  let nonce = 0
  const tx = (kind: Tx["kind"], actor: string, payload: Record<string, unknown>): Tx => {
    const t = makeTx(kind, actor, payload, SEED_TS, nonce++)
    txs.push(t)
    return t
  }

  // ── Members: the named working set ──
  const named: [string, string, string, "active" | "pending" | "suspended"][] = [
    ["founder", "1200000.00", "North America", "active"],
    ["aelith",  "1000.00", "Europe",        "active"],
    ["alice",   "1000.00", "North America", "active"],
    ["bob",     "1000.00", "Europe",        "active"],
    ["carla",   "800.00",  "Latin America", "active"],
    ["dave",    "500.00",  "Africa",        "active"],
    ["erin",    "600.00",  "Europe",        "active"],
    ["frank",   "700.00",  "North America", "active"],
    ["grace",   "1200.00", "Asia",          "active"],
    ["henry",   "0",       "Africa",        "pending"],
    ["iris",    "0",       "Asia",          "pending"],
    ["jamal",   "0",       "Africa",        "suspended"],
  ]
  for (const [id, deposit, region, status] of named) {
    tx("join", "system", { id, deposit, region, status })
  }

  // ── Citizens: real members, deterministic regions ──
  for (let i = 1; i <= CITIZEN_COUNT; i++) {
    tx("join", "system", {
      id: `citizen_${String(i).padStart(4, "0")}`,
      deposit: "100.00",
      region: REGIONS[(i - 1) % REGIONS.length],
      status: "active",
    })
  }

  // ── Networks ──
  tx("create_net", "founder", { name: "AequNet",   denom: "AEQ", rate: "1" })
  tx("create_net", "founder", { name: "DollarNet", denom: "USD", rate: "2.2805" })
  tx("create_net", "erin",    { name: "EuroNet",   denom: "EUR", rate: "2.10" })
  tx("create_net", "carla",   { name: "RandNet",   denom: "ZAR", rate: "41.5" })

  // ── Network memberships ──
  const memberships: [string, string][] = [
    ["aelith", slugify("AequNet")], ["aelith", slugify("DollarNet")],
    ["alice", slugify("AequNet")], ["bob", slugify("DollarNet")], ["bob", slugify("EuroNet")],
    ["carla", slugify("RandNet")], ["dave", slugify("AequNet")], ["erin", slugify("EuroNet")],
    ["frank", slugify("DollarNet")], ["grace", slugify("AequNet")],
  ]
  for (const [member, net] of memberships) tx("join_net", "system", { member, net })

  // ── Businesses ──
  tx("create_bus", "founder", { name: "EquiTech",        net: slugify("AequNet"),   ec: "0.03" })
  tx("create_bus", "alice",   { name: "UbuntuWorks",     net: slugify("AequNet"),   ec: "0.025" })
  tx("create_bus", "carla",   { name: "Meridian Foods",  net: slugify("DollarNet"), ec: "0.02" })
  tx("create_bus", "erin",    { name: "Atlas Logistics", net: slugify("EuroNet"),   ec: "0.015" })

  tx("hire", "founder", { bus: slugify("EquiTech"),    member: "alice" })
  tx("hire", "founder", { bus: slugify("EquiTech"),    member: "carla" })
  tx("hire", "alice",   { bus: slugify("UbuntuWorks"), member: "bob" })
  tx("hire", "alice",   { bus: slugify("UbuntuWorks"), member: "dave" })
  tx("hire", "erin",    { bus: slugify("Atlas Logistics"), member: "frank" })

  // ── Pledges (ids derived from the exact create txs) ──
  const pledgeDefs: [string, string, string, string, string, string][] = [
    // name, creator, target, net, purpose, category
    ["Harbor Grid",   "aelith", "2000", slugify("AequNet"),   "Coastal resilience infrastructure", "Infrastructure"],
    ["School Drive",  "aelith", "2000", slugify("AequNet"),   "Rural school connectivity",         "Education"],
    ["Solar Coop",    "grace",  "3000", slugify("AequNet"),   "Community solar array",             "Environment"],
    ["Archive Vault", "bob",    "1200", slugify("DollarNet"), "Digital preservation",              "Other"],
    ["Market Stalls", "carla",  "980",  slugify("RandNet"),   "Vendor microgrants",                "Social"],
    ["Water Mesh",    "dave",   "1500", slugify("AequNet"),   "Decentralized water monitoring",    "Infrastructure"],
  ]
  const pledgeIds: Record<string, string> = {}
  for (const [name, creator, target, net, purpose, category] of pledgeDefs) {
    const createTx = tx("create_pledge", creator, { name, target, net, purpose, category })
    pledgeIds[name] = derivePledgeId(name, creator, createTx.id)
  }

  // ── Pledge support (partial fills — pledges stay live) ──
  tx("support", "alice", { pledge: pledgeIds["Harbor Grid"],  amount: "1240.00" })
  tx("support", "bob",   { pledge: pledgeIds["School Drive"], amount: "760.00" })
  tx("support", "carla", { pledge: pledgeIds["Solar Coop"],   amount: "1620.00" })

  // ── Payment accounts (ephemeral payment layer) ──
  tx("node_register", "system", { account: "founder", balance: "10000" })
  tx("node_register", "system", { account: "aelith",  balance: "5000" })
  tx("node_register", "system", { account: "alice",   balance: "3200" })
  tx("node_register", "system", { account: "bob",     balance: "1500" })
  tx("node_register", "system", { account: "grace",   balance: "2750" })

  // ── A few real payments ──
  tx("node_pay", "founder", { from: "founder", to: "aelith", amount: "250" })
  tx("node_pay", "aelith",  { from: "aelith",  to: "alice",  amount: "125" })
  tx("node_pay", "alice",   { from: "alice",   to: "bob",    amount: "75" })

  return txs
}
