/**
 * aequdash — tests/node/beacon.test.ts
 *
 * LAN beacon: packet codec (strictness + roundtrip), network filtering
 * (only OUR net's beacons trigger dials), self-filtering, and a real UDP
 * loopback exchange.
 */

import { describe, test, expect, afterEach } from "bun:test"
import { LanBeacon, decodeBeacon, encodeBeacon, type BeaconMessage } from "../../src/node/beacon.ts"
import { netKey } from "../../src/node/rendezvous.ts"

const BEACON_PORT = 37_921 + Math.floor(Math.random() * 500)
const NET = "aeqnet-beacon-test1"

let beacons: LanBeacon[] = []

afterEach(async () => {
  for (const b of beacons) await b.stop()
  beacons = []
})

describe("beacon codec", () => {
  test("roundtrip", () => {
    const msg: BeaconMessage = { v: 1, net: netKey(NET), ep: "192.168.1.20:7920", node: "aeqnode-x7" }
    const decoded = decodeBeacon(encodeBeacon(msg))
    expect(decoded).toEqual(msg)
  })

  test("rejects garbage and foreign magic", () => {
    expect(decodeBeacon("not json")).toBeNull()
    expect(decodeBeacon("{}")).toBeNull()
    expect(decodeBeacon(JSON.stringify({ magic: "other", v: 1 }))).toBeNull()
    expect(decodeBeacon(JSON.stringify({ magic: "aeqnet-beacon", v: 1, net: "n", ep: "no-port", node: "x" }))).toBeNull()
    expect(decodeBeacon(JSON.stringify({ magic: "aeqnet-beacon", v: 1, net: "n", ep: "h:99999", node: "x" }))).toBeNull()
    expect(decodeBeacon(new Uint8Array([0, 1, 2, 3]))).toBeNull()
  })
})

describe("LAN beacon exchange (directed loopback)", () => {
  test("a beacon from OUR network triggers onPeer; foreign/self beacons don't", async () => {
    const heard: { host: string; port: number; node: string }[] = []

    const listener = new LanBeacon({
      clusterId: NET,
      nodeId: "listener",
      endpoint: { host: "127.0.0.1", port: 9000 }, // not actually listening TCP — beacons are just hints
      port: BEACON_PORT,
      broadcastAddr: "127.0.0.1",  // directed for the test instead of subnet broadcast
      intervalMs: 100,
      onPeer: (host, port, node) => heard.push({ host, port, node }),
    })
    beacons.push(listener)
    await listener.start()

    // Same network → heard
    const announcer = new LanBeacon({
      clusterId: NET,
      nodeId: "announcer",
      endpoint: { host: "127.0.0.1", port: 9443 },
      port: BEACON_PORT,           // port already held by listener → announce-only fallback
      broadcastAddr: "127.0.0.1",
      intervalMs: 100,
      onPeer: () => {},
    })
    beacons.push(announcer)
    await announcer.start()

    // Foreign network on the same port → must be ignored
    const foreign = new LanBeacon({
      clusterId: "aeqnet-SOMEONE-ELSE",
      nodeId: "foreigner",
      endpoint: { host: "127.0.0.1", port: 9555 },
      port: BEACON_PORT,
      broadcastAddr: "127.0.0.1",
      intervalMs: 100,
      onPeer: () => {},
    })
    beacons.push(foreign)
    await foreign.start()

    // Self-id announcement → must be ignored
    const self = new LanBeacon({
      clusterId: NET,
      nodeId: "listener",          // same node id as the listener
      endpoint: { host: "127.0.0.1", port: 9666 },
      port: BEACON_PORT,
      broadcastAddr: "127.0.0.1",
      intervalMs: 100,
      onPeer: () => {},
    })
    beacons.push(self)
    await self.start()

    const deadline = Date.now() + 8_000
    while (Date.now() < deadline && heard.length === 0) {
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(heard.length).toBeGreaterThan(0)
    expect(heard[0]).toEqual({ host: "127.0.0.1", port: 9443, node: "announcer" })
    // Only the same-network, non-self announcer may appear — ever
    expect(heard.every((h) => h.node === "announcer")).toBe(true)
  }, 15_000)
})
