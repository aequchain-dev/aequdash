/**
 * aequdash — scripts/snapshot-live.tsx
 *
 * Headless frame capture against the LIVE aeqnet mesh (not the simulator).
 * Boots the real 3-node mesh, renders the app, captures the frame.
 *
 *   bun run scripts/snapshot-live.tsx
 *   SCREEN=node bun run scripts/snapshot-live.tsx
 */

process.env.AEQUCHAIN_NO_SPLASH = "1"
process.env.AEQUCHAIN_NO_MOTION = "1"

const SCREEN = process.env.SCREEN ?? "dashboard"
const WIDTH = parseInt(process.env.WIDTH ?? "158")
const HEIGHT = parseInt(process.env.HEIGHT ?? "50")
const PORT = 23_000 + Math.floor(Math.random() * 2000)

const { createTestRenderer } = await import("@opentui/core/testing")
const { createRoot } = await import("@opentui/react")
await import("@opentui/react/runtime-plugin-support")
const { Bridge } = await import("../src/lib/bridge.ts")
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

const bridge = new Bridge({
  backend: "aeqnet",
  juliaBin: "julia",
  rpcScript: "/dev/null",
  cwd: process.cwd(),
  aeqnetNodes: 3,
  aeqnetPort: PORT,
})

await bridge.start()

// Wait for the mesh to be ready (genesis committed)
const deadline = Date.now() + 45_000
while (bridge.status !== "ready" && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 200))
}

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

// Let blocks flow so the frame shows a living chain
await new Promise((r) => setTimeout(r, 6_000))
await setup.flush({ maxPasses: 20 })
await new Promise((r) => setTimeout(r, 300))

const frame = setup.captureCharFrame()
console.log(frame)

const snap = await bridge.snapshot()
console.error(`[live] backend=aeqnet height=${snap.block_height} members=${snap.members_summary?.total_registered} mesh=${snap.cluster?.mesh_size} converged=${snap.cluster?.all_converged} equality=${snap.equality?.all_passed}`)

await bridge.stop()
setup.renderer.destroy()
process.exit(0)
