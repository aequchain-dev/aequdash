/**
 * aequdash — src/lib/commands.ts
 *
 * Full command catalog mirroring aequchain.jl interactive CLI.
 * Used by CommandBar for tab-completion and by help.
 */

import type { CommandDef, ScreenId } from "./types.ts"

export const COMMANDS: CommandDef[] = ([
  // Identity
  { name: "login", args: [{ name: "id", required: true, description: "member id to log in as" }], description: "Log in as a member", screen: "identity" },
  { name: "logout", args: [], description: "Log out current user", screen: "identity" },
  { name: "join", args: [{ name: "id", required: true, description: "new member id" }, { name: "deposit", description: "initial deposit (default 0)" }], description: "Add a new member with optional deposit", screen: "identity" },
  { name: "exit_member", args: [{ name: "id", required: true, description: "member id to remove" }], description: "Remove a member (rebalances the rest)", screen: "identity" },
  { name: "withdraw", args: [{ name: "id", required: true, description: "member id" }, { name: "amount", required: true, description: "amount" }, { name: "purpose", description: "spend purpose" }], description: "Member withdrawal (subject to 30d limits)", screen: "identity" },

  // Networks
  { name: "create_net", args: [{ name: "name", required: true, description: "network name" }, { name: "denom", required: true, description: "currency code" }, { name: "rate", required: true, description: "peg rate" }], description: "Create a new network", screen: "networks" },
  { name: "join_net", args: [{ name: "member", required: true, description: "member id" }, { name: "net", required: true, description: "network id" }], description: "Member joins a network", screen: "networks" },
  { name: "transfer_net", args: [{ name: "member", required: true, description: "member id" }, { name: "from_net", required: true, description: "source network" }, { name: "to_net", required: true, description: "destination network" }], description: "Move member between networks", screen: "networks" },

  // Businesses
  { name: "create_bus", args: [{ name: "name", required: true, description: "business name" }, { name: "net", required: true, description: "network id" }, { name: "ec", description: "contribution rate 0-0.05 (default 0.02)" }], description: "Create a business", screen: "businesses" },
  { name: "set_ec", args: [{ name: "bus_id", required: true, description: "business id" }, { name: "rate", required: true, description: "0.0-0.05" }], description: "Set contribution rate", screen: "businesses" },
  { name: "hire", args: [{ name: "bus_id", required: true, description: "business id" }, { name: "member", required: true, description: "member to hire" }], description: "Hire member into business", screen: "businesses" },
  { name: "bus_withdraw", args: [{ name: "bus_id", required: true, description: "business id" }, { name: "amount", required: true, description: "amount" }, { name: "purpose", description: "purpose" }], description: "Business withdrawal", screen: "businesses" },

  // Pledges
  { name: "create_pledge", args: [{ name: "name", required: true, description: "pledge name" }, { name: "target", required: true, description: "target amount" }, { name: "net", required: true, description: "network id" }, { name: "purpose", description: "purpose" }], description: "Create a pledge", screen: "pledges" },
  { name: "support", args: [{ name: "pledge_id", required: true, description: "pledge id" }, { name: "amount", required: true, description: "amount" }], description: "Support a pledge", screen: "pledges" },

  // Node
  { name: "node_init", args: [{ name: "committee", description: "committee size (default 12)" }, { name: "threshold", description: "quorum threshold (default 8)" }, { name: "seed", description: "epoch seed" }], description: "Initialize ephemeral testnet node", screen: "node" },
  { name: "node_reset", args: [], description: "Reset node state", screen: "node" },
  { name: "node_register", args: [{ name: "acct", required: true, description: "account id" }, { name: "balance", required: true, description: "initial balance" }], description: "Register a node account", screen: "node" },
  { name: "node_pay", args: [{ name: "from", required: true, description: "sender" }, { name: "to", required: true, description: "recipient" }, { name: "amount", required: true, description: "amount" }], description: "Submit a payment through the node", screen: "node" },
  { name: "node_status", args: [], description: "Show node status", screen: "node" },
  { name: "node_stop", args: [{ name: "id", required: true, description: "node id (e.g. aeqnode-02)" }], description: "Stop a mesh node (ephemeral: state drops with it)", screen: "node" },
  { name: "node_start", args: [{ name: "id", required: true, description: "node id (e.g. aeqnode-02)" }], description: "Start a stopped mesh node (fresh state, re-syncs)", screen: "node" },
  { name: "net_nodes", args: [], description: "List live mesh nodes and their state roots", screen: "node" },

  // Consensus
  { name: "equality_check", args: [], description: "Run equality invariant check", screen: "consensus" },
  { name: "consensus_test", args: [], description: "Run consensus protocol test", screen: "consensus" },

  // Global
  { name: "demo", args: [], description: "Replay the canonical demo scenario", screen: "dashboard" },
  { name: "reset", args: [], description: "Reset state to demo defaults", screen: "dashboard" },
  { name: "status", args: [], description: "Show high-level status", screen: "dashboard" },
  { name: "help", args: [], description: "Show command help", screen: "dashboard" },
  { name: "kill", args: [], aliases: ["shutdown", "quit", "exit"], description: "Shut down the mesh and exit (all nodes stop; state evaporates)", screen: "dashboard" },
] as CommandDef[]).map(c => ({
  ...c,
  aliases: c.name === "create_net" ? ["cn"]
    : c.name === "join_net" ? ["jn"]
    : c.name === "create_bus" ? ["cb"]
    : c.name === "node_pay" ? ["np"]
    : c.name === "exit_member" ? ["ex"]
    : c.name === "equality_check" ? ["eq"]
    : c.name === "consensus_test" ? ["ct"]
    : c.aliases,   // preserve aliases declared inline (e.g. kill → shutdown/quit/exit)
}))

export function commandsForScreen(screen: ScreenId): CommandDef[] {
  return COMMANDS.filter(c => c.screen === screen)
}

export function allCommands(): CommandDef[] {
  return COMMANDS
}

export function findCommand(name: string): CommandDef | undefined {
  const lower = name.toLowerCase()
  return COMMANDS.find(c => c.name === lower || c.aliases?.includes(lower))
}