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
bun run start:sim              # simulator mode (no Julia required)
bun run start                  # Julia backend if available, auto-fallback otherwise
```

## Development

```bash
bun run dev                    # watch mode
bun run typecheck              # zero-error TypeScript gate
bun test                       # 79 tests: units, invariants, render smoke
bun run snapshot               # deterministic headless frame (dashboard @ 158x50)
bun run snapshot:all           # every screen
bun scripts/verify-colors.tsx  # span-level palette verification (guide §30)
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
| `q` / `Ctrl-C` | Quit |
| `Esc` | Close command bar |
| `↑` / `↓` | Command history |
| Mouse | Nav rail clicks, wheel scroll |

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
│   ├── lib/
│   │   ├── theme.ts            # §5.1/§5.3 tokens, motion tokens, formatters
│   │   ├── measure.ts          # terminal-cell width math (grapheme-safe)
│   │   ├── layout.ts           # responsive classes A–E
│   │   ├── types.ts            # SnapshotV2 — every pixel traces here
│   │   ├── simulator.ts        # seeded deterministic reference backend
│   │   ├── bridge.ts           # Julia JSON-RPC (piped stdio) + fallback
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
│   │   └── StatusBadge.tsx     # JULIA LIVE / SIMULATION vocabulary
│   └── screens/                # Dashboard, Identity, Networks, Businesses,
│                               # Pledges, Node, Consensus, Console
└── tests/                      # 79 tests — format/measure/layout/sim/render
```

## Data honesty

Every rendered value traces to `SnapshotV2` state. The simulator is the v2
reference backend: seeded, deterministic, internally consistent
(`member_value == treasury / members` holds exactly — full precision
internally, quantization only at display). When driven by the real Julia
backend, fields the legacy RPC cannot provide render as `—` rather than
fabricated numbers (`full_fidelity: false`).

## License

MIT. See the parent aequchain project for full attribution.
