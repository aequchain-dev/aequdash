/**
 * aequdash — scripts/snapshot.tsx
 *
 * Headless deterministic snapshot harness (dev policy: scriptable/testable).
 *
 *   bun run scripts/snapshot.tsx                      # dashboard @ 158x50
 *   SCREEN=pledges bun run scripts/snapshot.tsx       # any screen
 *   WIDTH=100 HEIGHT=34 bun run scripts/snapshot.tsx  # responsive class B/C
 *   THEME=dark ...                                    # dark theme
 *
 * AEQUDASH_SNAPSHOT=1 freezes the simulator (no heartbeat, pinned clock),
 * so frames are byte-reproducible across runs.
 *
 * NOTE: env vars must be set BEFORE any src/ module loads (they read env at
 * module scope). ESM imports hoist, so everything below uses dynamic import.
 */

process.env.AEQUDASH_SNAPSHOT = "1"
process.env.AEQUCHAIN_SIMULATE = "1"
process.env.AEQUCHAIN_NO_SPLASH = "1"
if (process.env.THEME) process.env.AEQUCHAIN_THEME = process.env.THEME

const SCREEN = process.env.SCREEN ?? "dashboard"
const WIDTH = parseInt(process.env.WIDTH ?? "158")
const HEIGHT = parseInt(process.env.HEIGHT ?? "50")

const { createTestRenderer } = await import("@opentui/core/testing")
const { createRoot } = await import("@opentui/react")
await import("@opentui/react/runtime-plugin-support")
const { JuliaBridge } = await import("../src/lib/bridge.ts")
const { BridgeProvider, useStore } = await import("../src/state/store.tsx")
const { App } = await import("../src/App.tsx")
const React = await import("react")

const setup = await createTestRenderer({
  width: WIDTH,
  height: HEIGHT,
  useMouse: true,
  exitOnCtrlC: false,
  screenMode: "alternate-screen",
})

const bridge = new JuliaBridge({
  juliaBin: "julia",
  rpcScript: "/dev/null",
  simulate: true,
  cwd: process.cwd(),
})

await bridge.start()

function AppWithScreen({ screen }: { screen: string }) {
  const store = useStore()
  if (store.screen !== screen) {
    setTimeout(() => store.setScreen(screen as never), 0)
  }
  return React.createElement(App)
}

const root = createRoot(setup.renderer)
root.render(
  React.createElement(
    BridgeProvider,
    { bridge, children: React.createElement(AppWithScreen, { screen: SCREEN }) },
  ),
)

await new Promise((r) => setTimeout(r, 1200))
await setup.flush({ maxPasses: 20 })
await new Promise((r) => setTimeout(r, 300))

const frame = setup.captureCharFrame()
console.log(frame)

await bridge.stop()
setup.renderer.destroy()
process.exit(0)
