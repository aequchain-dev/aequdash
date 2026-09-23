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

**The mesh is shared across terminals.** The first `bun run start` spawns a
detached gateway that owns the mesh and listens on a control port
(`AEQUCHAIN_PORT + 1000`, default `8920`). Every later `bun run start`
**attaches to that same mesh** instead of starting a fresh one — so state
created in one terminal (e.g. `join ryan 100`) is immediately visible in the
other. Each terminal keeps its own login session, but the chain, members,
treasury, and blocks are shared. The mesh evaporates when the *last* terminal
detaches.

**The mesh is shared across machines too.** Run one host machine with the
control server exposed on the LAN, then point every other machine's TUI at it:

```bash
# Host machine (e.g. 192.168.0.161) — expose the control server on the LAN
AEQUCHAIN_CONTROL_HOST=0.0.0.0 bun run start

# Every other machine — attach to the host's gateway (no local mesh spawned)
AEQUCHAIN_GATEWAY=192.168.0.161:8920 bun run start
```

All attached machines share one chain: members, treasury, blocks, live
consensus. Works over LAN, Tailscale/WireGuard, or any reachable IP.

**Over the internet, secure the control socket first.** A gateway bound to a
public interface must require a shared token and (recommended) TLS:

```bash
# Host machine — token + TLS, exposed on a reachable interface
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout key.pem -out cert.pem -subj "/CN=aeqnet"
AEQUCHAIN_CONTROL_HOST=0.0.0.0 \
AEQUCHAIN_TOKEN="pick-a-long-random-secret" \
AEQUCHAIN_TLS_CERT=cert.pem AEQUCHAIN_TLS_KEY=key.pem \
  bun run start

# Every other machine — present the same token, over TLS
AEQUCHAIN_GATEWAY=host.example.com:8920 \
AEQUCHAIN_TOKEN="pick-a-long-random-secret" \
AEQUCHAIN_TLS=1 \
  bun run start
```

With a token set, the gateway rejects every command from any client that
hasn't authenticated; TLS encrypts the control channel. (Self-signed certs are
accepted client-side — this is a testnet, not a public CA trust model.)

## Development

```bash
bun run dev                    # watch mode
bun run typecheck              # zero-error TypeScript gate
bun test                       # 142 tests: units, invariants, mesh e2e, shared-mesh, secure-gateway
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
| `AEQUCHAIN_GATEWAY` | unset | `host:port` of a remote mesh to attach to (no local spawn) |
| `AEQUCHAIN_CONTROL_HOST` | `127.0.0.1` | Control-server bind interface when this instance hosts the mesh; `0.0.0.0` accepts remote terminals |
| `AEQUCHAIN_TOKEN` | unset | Shared secret required of every control client (internet exposure) |
| `AEQUCHAIN_TLS` | unset | `1` = this client attaches over TLS |
| `AEQUCHAIN_TLS_CERT` / `AEQUCHAIN_TLS_KEY` | unset | Host-side TLS cert/key for the control server |

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

`bun run start` uses a **shared gateway** process (detached, owns the mesh)
plus N−1 daemon nodes. Terminals attach to the gateway over a TCP control
socket, so any number of TUIs can watch and drive the same chain.

Lifecycle is driven by **client count**, not by which terminal started it:

- `q` / `Ctrl-C` / `:quit` / `:exit` — detach *this* terminal. The mesh keeps
  running while other terminals are attached.
- `:kill` / `:shutdown` — bring the **whole shared mesh** down immediately
  (every node stops, state evaporates for everyone) and exit.
- When the **last** terminal detaches, the gateway evaporates the mesh after a
  short grace window — no orphans, ever.
- `:node_stop aeqnode-02` — stop one node (its state drops with it)
- `:node_start aeqnode-02` — start it again (fresh state, re-syncs)
- `:net_nodes` — list the live mesh

Because the gateway only lives while at least one client is attached, a hard
kill of every terminal (`kill -9`) still cleans up: the control socket closes,
the client count drops to zero, and the mesh self-terminates.

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
└── tests/                      # 142 tests — format/measure/layout/sim/render
                                #   + node: rational, ledger, consensus, mesh,
                                #   bridge end-to-end, shared-mesh multi-client, secure-gateway (TLS+token)
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
