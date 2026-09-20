# aequdash

**aequchain TUI v2** — a calm, engineered instrument console for the aequchain
Universal Equidistributed Blockchain ephemeral testnet.

Built with OpenTUI + React + Bun per `AEQUCHAIN_OPENTUI_STYLE_GUIDE.md`:
cream/parchment canvas, thin rose-brown rules, single-line geometry,
weight-and-whitespace typography. No neon, no gradients, no noise.

---

## Quick start

```bash
cd aequdash
bun install                    # first run only
bun run start                  # REAL ephemeral testnet mesh (default — no sim)
bun run start:julia            # Julia reference backend (if Julia installed)
bun run start:sim              # deterministic simulator (explicit opt-in)
```

**`bun run start` is real.** It spawns the aeqnet mesh: `node-1` in-process
plus N−1 daemon nodes (`AEQUCHAIN_NODES`, default 3), linked over real TCP
with rotating-proposer BFT consensus, Ed25519-signed votes, and exact
BigInt-rational money. There is no simulator in the default path, and no
silent fallback to one — if the mesh cannot boot, the TUI shows an honest
error state instead of fabricated data.

**Everything is ephemeral.** The mesh holds its state only in memory. Stop
a node and its state drops with it (`node_stop aeqnode-02`); when the last
live node stops, the network's entire state ceases to exist. `reset`
re-genesis the mesh. Nothing is ever written to disk.

**The mesh is observable.** Every node gossips its height and state root on
1s heartbeats; the Node screen's Mesh panel shows every live node, its
height, peers, and state root, so you can watch consensus converge.

## Development

```bash
bun run dev                    # watch mode
bun run typecheck              # zero-error TypeScript gate
bun test                       # 139 tests: units, invariants, mesh e2e
bun run snapshot               # deterministic headless frame (dashboard @ 158x50)
bun run snapshot:all           # every screen
bun run node -- --nodes 3      # bare mesh without the TUI (scriptable)
```

### Snapshot harness (scriptable / CI-safe)

```bash
SCREEN=pledges bun run scripts/snapshot.tsx
WIDTH=90 HEIGHT=40 bun run scripts/snapshot.tsx     # responsive class C
WIDTH=50 HEIGHT=16 bun run scripts/snapshot.tsx     # class E minimum viable
THEME=dark bun run scripts/snapshot.tsx             # dark theme
```

`AEQUDASH_SNAPSHOT=1` freezes the simulator (seeded RNG, pinned clock), so
frames are byte-reproducible across runs and machines.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `AEQUCHAIN_NODES` | `3` | Mesh size for the aeqnet backend |
| `AEQUCHAIN_PORT` | `7920` | Base TCP port for the mesh |
| `AEQUCHAIN_BACKEND` | `aeqnet` | `aeqnet` (default) or `julia` |
| `AEQUCHAIN_SIMULATE` | unset | `1` forces the built-in simulator |
| `AEQUCHAIN_THEME` | `light` | `light` (reference cream) or `dark` |
| `AEQUCHAIN_NO_SPLASH` | unset | `1` skips the ≤900 ms startup splash |
| `AEQUCHAIN_NO_MOTION` | unset | `1` disables decorative motion |
| `AEQUDASH_SNAPSHOT` | unset | `1` frozen deterministic state (tests/CI) |
| `AEQUCHAIN_JULIA` | `julia` | Julia binary path |
| `AEQUCHAIN_RPC` | `../julia/rpc-server.jl` | RPC server script path |

## Keybindings

| Key | Action |
|---|---|
| `1`–`8` | Jump to screen |
| `←` / `→` | Cycle screens |
| `:` | Command bar |
| `r` | Refresh snapshot |
| `q` / `Ctrl-C` | Quit (graceful: mesh shuts down first) |
| `Esc` | Close command bar |
| `↑` / `↓` | Command history |
| Mouse | Nav rail clicks, wheel scroll |

## Process tree & clean exit

`bun run start` spawns the gateway (node-1) plus N−1 daemon nodes. The whole
tree is self-cleaning: every layer watches its stdin, so when a parent dies
— quit, Ctrl-C, or a hard kill — the children follow. **No orphans, ever.**

- `q` / `Ctrl-C` — graceful quit (mesh shuts down, terminal restored)
- `:kill` (aliases `:shutdown`, `:quit`, `:exit`) — bring the whole mesh
  down from inside the TUI and exit
- `:node_stop aeqnode-02` — stop one node (its state drops with it)
- `:node_start aeqnode-02` — start it again (fresh state, re-syncs)
- `:net_nodes` — list the live mesh

Stale processes from older versions (pre-mesh) may still be running from
before the self-cleaning tree existed — kill them once: `pkill -f aequdash`.

## Architecture

```
aequdash/
├── bin/aequdash.tsx            # entry: bridge + renderer + React mount
├── scripts/
│   ├── snapshot.tsx            # headless deterministic frame capture
│   └── verify-colors.tsx       # span-level palette assertions
├── src/
│   ├── App.tsx                 # frame shell + keyboard router
│   ├── state/store.tsx         # BridgeProvider: status/snapshot/activity/clock
│   ├── node/                   # THE EPHEMERAL TESTNET MESH (real backend)
│   │   ├── rational.ts         #   exact BigInt rational arithmetic
│   │   ├── ledger.ts           #   state machine; equality by construction
│   │   ├── block.ts            #   blocks, merkle roots, tx ids
│   │   ├── consensus.ts        #   BFT committee selection, votes, QCs
│   │   ├── crypto.ts           #   SHA-256 + Ed25519 identities
│   │   ├── p2p.ts              #   TCP mesh: handshake, heartbeat, gossip
│   │   ├── node.ts             #   AequNode: mempool, proposals, commits
│   │   ├── genesis.ts          #   deterministic genesis scenario
│   │   ├── snapshot.ts         #   SnapshotV2 assembly from live state
│   │   ├── daemon.ts           #   child-process node (stdio control)
│   │   └── gateway.ts          #   JSON-RPC front door + cluster orchestration
│   ├── lib/
│   │   ├── theme.ts            # §5.1/§5.3 tokens, motion tokens, formatters
│   │   ├── measure.ts          # terminal-cell width math (grapheme-safe)
│   │   ├── layout.ts           # responsive classes A–E
│   │   ├── types.ts            # SnapshotV2 — every pixel traces here
│   │   ├── simulator.ts        # seeded deterministic reference backend
│   │   ├── bridge.ts           # backend client: aeqnet | julia | sim
│   │   └── commands.ts         # command catalog
│   ├── components/
│   │   ├── Panel.tsx           # [] Title ──── Meta frame grammar
│   │   ├── DataRow.tsx         # label/value rows, Metric, StatSplit
│   │   ├── Bars.tsx            # progress + distribution bars
│   │   ├── Table.tsx           # aligned tables, quiet selection
│   │   ├── ActivityLog.tsx     # columnar live feed, stable column starts
│   │   ├── Header.tsx          # brand · backend · height · clock
│   │   ├── Footer.tsx          # nav rail 1–8 + : command
│   │   ├── CommandBar.tsx      # : layer with history + completion
│   │   ├── Splash.tsx          # ≤900 ms quiet reveal
│   │   └── StatusBadge.tsx     # TESTNET LIVE / JULIA LIVE / SIMULATION
│   └── screens/                # Dashboard, Identity, Networks, Businesses,
│                               # Pledges, Node, Consensus, Console
└── tests/                      # 139 tests — format/measure/layout/sim/render
                                #   + node: rational, ledger, consensus, mesh,
                                #   bridge end-to-end
```

## Data honesty

Every rendered value traces to `SnapshotV2` state. Under the default aeqnet
backend, every value traces further — to a committed block produced by real
quorum consensus across the live mesh. The equality invariant

    member_value == treasury / member_count

holds exactly (BigInt rational arithmetic; member value is *derived*, never
stored), and is verified continuously: every block carries a state-root
digest that every node recomputes before voting. `equality_check` and the
Consensus screen report live results, including per-member verification.

## License

MIT. See the parent aequchain project for full attribution.
