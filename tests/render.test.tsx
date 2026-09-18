/**
 * aequdash — tests/render.test.tsx
 *
 * Render smoke tests: every screen at every responsive class renders a
 * complete frame with its identifying markers. Deterministic (snapshot mode).
 */

import { describe, test, expect, beforeAll } from "bun:test"

process.env.AEQUDASH_SNAPSHOT = "1"
process.env.AEQUCHAIN_SIMULATE = "1"
process.env.AEQUCHAIN_NO_SPLASH = "1"

const { createTestRenderer } = await import("@opentui/core/testing")
const { createRoot } = await import("@opentui/react")
await import("@opentui/react/runtime-plugin-support")
const { JuliaBridge } = await import("../src/lib/bridge.ts")
const { BridgeProvider, useStore } = await import("../src/state/store.tsx")
const { App } = await import("../src/App.tsx")
const React = await import("react")

type ScreenId = import("../src/lib/types.ts").ScreenId

async function renderFrame(screen: ScreenId, width: number, height: number): Promise<string> {
  const setup = await createTestRenderer({ width, height, screenMode: "alternate-screen" })
  const bridge = new JuliaBridge({ juliaBin: "julia", rpcScript: "/dev/null", simulate: true, cwd: process.cwd() })
  await bridge.start()

  function AppWithScreen() {
    const store = useStore()
    if (store.screen !== screen) setTimeout(() => store.setScreen(screen), 0)
    return React.createElement(App)
  }

  const root = createRoot(setup.renderer)
  root.render(React.createElement(BridgeProvider, { bridge, children: React.createElement(AppWithScreen) }))
  await new Promise((r) => setTimeout(r, 1000))
  await setup.flush({ maxPasses: 20 })
  await new Promise((r) => setTimeout(r, 200))
  const frame = setup.captureCharFrame()
  await bridge.stop()
  setup.renderer.destroy()
  return frame
}

const SCREENS: { id: ScreenId; markers: string[] }[] = [
  { id: "dashboard", markers: ["Treasury", "Members", "Your Member Value", "24h Volume", "Active Pledges", "30d Spend Limit", "Recent Activity", "Live Feed"] },
  { id: "identity", markers: ["Identity", "Members", "Reputation"] },
  { id: "networks", markers: ["Networks", "Network Directory", "AequNet", "Peg Rate"] },
  { id: "businesses", markers: ["Businesses", "EquiTech", "EC Rate"] },
  { id: "pledges", markers: ["Pledges", "Harbor Grid", "Success Rate"] },
  { id: "node", markers: ["Node Status", "Configuration", "aeqnode-01", "Quorum"] },
  { id: "consensus", markers: ["Equality Invariant", "Consensus Test", "PASS"] },
  { id: "console", markers: ["Console", "Command Catalogue"] },
]

describe("screens @ 158x50 (class A)", () => {
  for (const s of SCREENS) {
    test(`${s.id} renders with markers`, async () => {
      const frame = await renderFrame(s.id, 158, 50)
      for (const m of s.markers) expect(frame).toContain(m)
      // No uncontrolled overflow artifacts
      expect(frame).not.toContain("undefined")
      expect(frame).not.toContain("NaN")
    }, 15_000)
  }
})

describe("dashboard markers survive every class", () => {
  const cases: [string, number, number][] = [
    ["A", 158, 50],
    ["B", 120, 34],
    ["C", 90, 40],
    ["D", 70, 40],
    ["E", 50, 16],
  ]
  for (const [cls, w, h] of cases) {
    test(`class ${cls} (${w}x${h})`, async () => {
      const frame = await renderFrame("dashboard", w, h)
      expect(frame).toContain("Dashboard")
      expect(frame).toContain("SIMULATION")
      if (cls === "E") {
        expect(frame).toContain("Summary")
      } else {
        expect(frame).toContain("Treasury")
      }
      expect(frame).not.toContain("NaN")
    }, 15_000)
  }
})

describe("themes", () => {
  test("dark theme renders same composition", async () => {
    process.env.AEQUCHAIN_THEME = "dark"
    const frame = await renderFrame("dashboard", 158, 50)
    expect(frame).toContain("Treasury")
    expect(frame).toContain("Recent Activity")
    process.env.AEQUCHAIN_THEME = "light"
  }, 15_000)
})
