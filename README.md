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
bun run start                  # you ARE a node on the ephemeral testnet
bun run start:local            # legacy: shared loopback mesh (N local nodes)
bun run start:julia            # Julia reference backend (if Julia installed)
bun run start:sim              # deterministic simulator (explicit opt-in)
```

**`bun run start` deploys a real node.** Your TUI process hosts one genuine
`AequNode` — rotating-proposer BFT consensus, Ed25519-signed votes, exact
BigInt-rational money — and meshes with peers over real TCP. There is no
simulator in the default path and no silent fallback to one: if the node
cannot boot, the TUI shows an honest error state.

### The ephemeral network lifecycle

```
aequdash                      # join the public testnet — or FOUND it if you
                              # are first (you become the genesis anchor)
aequdash new meadow           # found a named, invite-gated network;
                              # your invite code prints in the activity feed
aequdash join aeq://meadow-…  # later users join as REAL consensus peers
aequdash join 203.0.113.9:7920   # …or via a raw endpoint
```

The lifecycle you get, for free:

1. **First user hosts.** The first instance of a network anchors genesis.
2. **Later users join as peers** — they dial a seed from the invite (or the
   rendezvous registry), verify the chain by its genesis hash, sync the
   blocks, and enter the validator roster. Not viewers: *voters*.
3. **Host exit is a non-event.** The anchor has no special power after
   genesis: the committee re-derives from the live roster every height, and
   every peer re-registers with the rendezvous, so any survivor seeds new
   joins. First leaves → second is the host. Automatically.
4. **Last exit erases everything.** State lives only in node RAM. When the
   final peer exits, the chain — members, treasury, blocks, all of it —
   ceases to exist anywhere. Rendezvous registrations rot out within 90s.

### Discovery: three layers, zero configuration

`bun run start` always looks before it anchors. Three discovery layers stack,
each covering one scope — so a second instance finds the first whether it's
on the same machine, the same LAN, or across the internet:

| Layer | Scope | How | Needs |
|---|---|---|---|
| **Loopback registry** | same machine | Every instance tries to host a tiny registry on `127.0.0.1:8930`; first binder wins, others use it. If the host exits, a survivor re-binds on its next dial-assist tick. | nothing |
| **LAN beacon** | same subnet | Nodes UDP-broadcast `(netHash, endpoint)` every 3s and dial what matches their network. | nothing |
| **Rendezvous server** | internet | Stateless hash-keyed registry you run once and everyone points at (below). | one env var |
| **Invite code** | internet | `aeq://…` codes carry bootstrap endpoints directly. | copy-paste |

The loopback registry and the rendezvous server are the same code
(`src/node/registry.ts`) — one stores `hash(network) → endpoint → expiry`
in RAM with a 90s TTL, never a transaction, block, or cleartext network name.
Discovery layers can only ever *find* peers; the mesh handshake (genesis
hash + optional network token) does the vetting.

```bash
# internet-wide discovery (optional; local and LAN already work).
# On any always-on, publicly reachable host:
bun run rendezvous                       # listens on 0.0.0.0:8930

# Then EVERYONE (both sides), replacing 203.0.113.10 with that host's real IP:
AEQUCHAIN_RENDEZVOUS=203.0.113.10:8930 bun run start

# redundancy: comma-separate several — nodes register to ALL, lookups merge
AEQUCHAIN_RENDEZVOUS=203.0.113.10:8930,198.51.100.7:8930 bun run start
```

Note: at least ONE side of an internet rendezvous must be publicly dialable
(open port / VPS). If only your peer is dialable, that's fine — dial-assist
makes *you* discover and dial *them* outbound. Both sides behind NAT with
nothing dialable needs the relay milestone (not shipped yet). And without
any server at all, `aequdash new <name>` + the invite code (or
`aequdash join HOST_IP:7920`) still works between two dialable endpoints.

**Dial-assist.** Every node re-queries its registries every 20s and dials
newly discovered endpoints. A stale invite (dead seeds, live network) heals
itself: the joiner re-anchors briefly, discovers survivors, and the fork-heal
merges it onto the live chain. It also lets NATted nodes keep discovering
public peers over outbound connections only.

**The invite is in the TUI.** The Node screen's *Network & Invite* panel
shows the network id, your dialable endpoint, the shareable invite code, and
a scannable QR of it (named networks).

**TLS on peer links.** For internet exposure, run every node of a network
with peer TLS enabled (all must agree — a plaintext peer's bytes honestly
fail TLS negotiation):

```bash
AEQUCHAIN_PEER_TLS=1 AEQUCHAIN_TLS_CERT=cert.pem AEQUCHAIN_TLS_KEY=key.pem bun run start
```

(Self-signed certs are accepted between peers — the testnet trust model, same
as the gateway control socket.)

**Invite-gated admission.** Named networks (`aequdash new`) carry a token in
the invite; the mesh handshake (HMAC-style proof bound to the genesis hash)
rejects peers that don't know it. The public zero-arg net is open by design.

### Legacy / development modes

```bash
bun run start:local            # one machine hosts a whole N-node loopback mesh
bun run start:local 5          # …with 5 nodes
aequdash --watch host:8920     # attach to a --local gateway as a viewer
                               # (AEQUCHAIN_GATEWAY=host:8920 also works)
```

The `--local` gateway is the previous default: a detached process owning the
whole loopback mesh, shared by every terminal on the machine, evaporating
when the last client detaches. Its internet-safe variant (token + TLS on the
control socket):

```bash
# Host machine — control socket exposed with token + TLS
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout key.pem -out cert.pem -subj "/CN=aeqnet"
AEQUCHAIN_CONTROL_HOST=0.0.0.0 \
AEQUCHAIN_TOKEN="testnet" \
AEQUCHAIN_TLS_CERT=cert.pem AEQUCHAIN_TLS_KEY=key.pem \
  bun run start:local

# Every other machine — present the same token, over TLS
AEQUCHAIN_GATEWAY=host.example.com:8920 \
AEQUCHAIN_TOKEN="testnet" \
AEQUCHAIN_TLS=1 \
  bun run start
```

## Development

```bash
bun run dev                    # watch mode
bun run typecheck              # zero-error TypeScript gate
bun test                       # 173 tests: units, invariants, mesh e2e, shared-mesh,
                               #   secure-gateway, invite codec, rendezvous, token gate,
                               #   join-as-peer lifecycle & fork-heal, TLS mesh, QR render,
                               #   zero-config local discovery & registry failover, LAN beacon
bun run snapshot               # deterministic headless frame (dashboard @ 158x50)
bun run snapshot:all           # every screen
bun run node -- --nodes 3      # bare mesh without the TUI (scriptable)
bun run rendezvous             # rendezvous server on 0.0.0.0:8930
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
| `AEQUCHAIN_BACKEND` | `aeqnet` | `aeqnet` (default) or `julia` |
| `AEQUCHAIN_SIMULATE` | unset | `1` forces the built-in simulator |
| `AEQUCHAIN_THEME` | `light` | `light` (reference cream) or `dark` |
| `AEQUCHAIN_NO_SPLASH` | unset | `1` skips the ≤900 ms startup splash |
| `AEQUCHAIN_NO_MOTION` | unset | `1` disables decorative motion |
| `AEQUDASH_SNAPSHOT` | unset | `1` frozen deterministic state (tests/CI) |
| `AEQUCHAIN_JULIA` | `julia` | Julia binary path |
| `AEQUCHAIN_RPC` | `../julia/rpc-server.jl` | RPC server script path |
| **Solo node (default)** |||
| `AEQUCHAIN_NET` | `aequchain-public` | Network name for the zero-arg path |
| `AEQUCHAIN_RENDEZVOUS` | unset | Rendezvous server(s) `host:port` — comma-separate for redundancy |
| `AEQUCHAIN_HOST` | `0.0.0.0` | Mesh bind host |
| `AEQUCHAIN_PORT` | auto | Mesh bind port (unset = auto-assign) |
| `AEQUCHAIN_ADVERTISE` | unset | External host for invites/registry when binding wildcard |
| `AEQUCHAIN_TOKEN` | unset | Network token (raw-endpoint join; or force one for `new`) |
| `AEQUCHAIN_NODE_ID` | `aeqnode-<rand>` | Custom node id |
| `AEQUCHAIN_BOOTSTRAP_DELAY_MS` | `3000` | Discovery grace before solo genesis |
| `AEQUCHAIN_DIAL_ASSIST_MS` | `20000` | Rendezvous re-lookup / peer top-up cadence (`0` disables) |
| `AEQUCHAIN_NO_LOCAL_REGISTRY` | unset | `1` = don't host/use the same-machine loopback registry |
| `AEQUCHAIN_NO_BEACON` | unset | `1` = disable the LAN UDP beacon |
| `AEQUCHAIN_PEER_TLS` | unset | `1` = TLS on all mesh links (pair with the two vars below) |
| `AEQUCHAIN_TLS_CERT` / `AEQUCHAIN_TLS_KEY` | `cert.pem` / `key.pem` | Peer-TLS material when `AEQUCHAIN_PEER_TLS=1` |
| `AEQUCHAIN_AUTO_SEED` | `1` | `0` = skip the demo genesis scenario |
| **Local mesh (`--local`)** |||
| `AEQUCHAIN_NODES` | `3` | Mesh size for the local gateway mesh |
| `AEQUCHAIN_GATEWAY` | unset | `host:port` of a remote gateway to attach to (viewer mode) |
| `AEQUCHAIN_CONTROL_HOST` | `127.0.0.1` | Control-server bind interface; `0.0.0.0` accepts remote terminals |
| `AEQUCHAIN_TLS` | unset | `1` = attach to a gateway over TLS |
| `AEQUCHAIN_TLS_CERT` / `AEQUCHAIN_TLS_KEY` | unset | Gateway-side TLS cert/key for the control server (same vars are reused for peer TLS in solo mode) |
| `AEQUCHAIN_RDV_TTL_MS` / `AEQUCHAIN_RDV_SWEEP_MS` | `90000` / `15000` | Rendezvous server TTL + sweep cadence |
| `AEQUCHAIN_RDV_TOKEN` | unset | Optional shared secret for the rendezvous server itself |

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

**Default (solo node):** the TUI process *is* the node — no gateway, no
daemon tree, no orphans possible. `q` / `Ctrl-C` destroys your node (peers
see a graceful `bye`; your state drops with you). The network lives while
other peers do; when the last peer exits, the chain is gone everywhere.

**`--local` (shared gateway):** a detached gateway process owns the loopback
mesh and serves a control socket; terminals attach as clients. Lifecycle is
driven by **client count**: the last terminal to detach evaporates the mesh.
`:kill` / `:shutdown` brings the whole shared mesh down for everyone;
`:node_stop aeqnode-02` / `:node_start aeqnode-02` cycle individual nodes.

Stale processes from older versions (pre-mesh) may still be running from
before the self-cleaning tree existed — kill them once: `pkill -f aequdash`.

## Architecture

```
aequdash/
├── bin/aequdash.tsx            # entry: plan resolution (solo/new/join/local/watch) + renderer
├── scripts/
│   ├── snapshot.tsx            # headless deterministic frame capture
│   ├── verify-colors.tsx       # span-level palette assertions
│   └── rendezvous.ts           # stateless discovery registry (TTL, hash-keyed, no chain state)
├── src/
│   ├── App.tsx                 # frame shell + keyboard router
│   ├── state/store.tsx         # BridgeProvider: status/snapshot/activity/clock
│   ├── node/                   # THE EPHEMERAL TESTNET MESH (real backend)
│   │   ├── rational.ts         #   exact BigInt rational arithmetic
│   │   ├── ledger.ts           #   state machine; equality by construction
│   │   ├── block.ts            #   blocks, merkle roots, tx ids
│   │   ├── consensus.ts        #   BFT committee selection, votes, QCs
│   │   ├── crypto.ts           #   SHA-256 + Ed25519 identities
│   │   ├── p2p.ts              #   TCP mesh: token-gated handshake, heartbeat, gossip
│   │   ├── node.ts             #   AequNode: mempool, proposals, commits, fork-heal
│   │   ├── genesis.ts          #   deterministic genesis scenario
│   │   ├── snapshot.ts         #   SnapshotV2 assembly from live state
│   │   ├── invite.ts           #   invite codes (aeq://name-nonce.cksum?e=…&t=…)
│   │   ├── rendezvous.ts       #   rendezvous client (register/lookup/keepalive)
│   │   ├── commander.ts        #   the shared command surface (used by solo + gateway)
│   │   ├── solo.ts             #   SOLO backend: this instance IS a real node (default)
│   │   ├── daemon.ts           #   child-process node (stdio control, --local mode)
│   │   └── gateway.ts          #   shared loopback mesh + JSON-RPC (--local mode)
│   ├── lib/
│   │   ├── theme.ts            # §5.1/§5.3 tokens, motion tokens, formatters
│   │   ├── measure.ts          # terminal-cell width math (grapheme-safe)
│   │   ├── layout.ts           # responsive classes A–E
│   │   ├── types.ts            # SnapshotV2 — every pixel traces here
│   │   ├── simulator.ts        # seeded deterministic reference backend
│   │   ├── bridge.ts           # backend client: aeqnet solo/mesh | julia | sim
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
└── tests/                      # 162 tests — format/measure/layout/sim/render
                                #   + node: rational, ledger, consensus, mesh,
                                #   bridge end-to-end, shared-mesh multi-client,
                                #   secure-gateway (TLS+token), invite codec,
                                #   rendezvous registry, token gate, join-as-peer lifecycle
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
