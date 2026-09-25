/**
 * aequdash — tests/node/netaddr.test.ts
 *
 * Public-address auto-discovery: the user should never have to know what
 * their IP is. Validates the IPv4 shape check, per-scope resolution, the
 * fallback ladder (explicit → discovered → LAN guess), and the multi-service
 * echo discovery with a mocked fetch (hermetic — no real network).
 */

import { describe, test, expect, afterEach } from "bun:test"
import {
  discoverPublicIPv4,
  guessOutboundHost,
  isValidPublicIPv4,
  resolveAdvertisedHost,
} from "../../src/node/netaddr.ts"

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

function mockFetch(behavior: (url: string) => Promise<{ ok: boolean; text: () => Promise<string> }>): void {
  globalThis.fetch = behavior as unknown as typeof fetch
}

describe("IPv4 validation", () => {
  test("accepts valid, rejects junk", () => {
    expect(isValidPublicIPv4("203.0.113.7")).toBe(true)
    expect(isValidPublicIPv4("  198.51.100.9\n")).toBe(true)
    expect(isValidPublicIPv4("256.1.1.1")).toBe(false)
    expect(isValidPublicIPv4("1.2.3")).toBe(false)
    expect(isValidPublicIPv4("abc.def.ghi.jkl")).toBe(false)
    expect(isValidPublicIPv4("")).toBe(false)
  })
})

describe("per-scope address resolution", () => {
  test("loopback is always 127.0.0.1", async () => {
    const r = await resolveAdvertisedHost({ scope: "loopback" })
    expect(r).toEqual({ host: "127.0.0.1", source: "loopback" })
  })

  test("lan scope returns the interface guess", async () => {
    const r = await resolveAdvertisedHost({ scope: "lan" })
    expect(r.source).toBe("lan-guess")
    expect(r.host.length).toBeGreaterThan(0)
    expect(r.host).toBe(guessOutboundHost())
  })

  test("public: explicit advertise wins over discovery", async () => {
    const r = await resolveAdvertisedHost({
      scope: "public",
      advertise: "203.0.113.50",
      discover: async () => { throw new Error("must not be called") },
    })
    expect(r).toEqual({ host: "203.0.113.50", source: "explicit" })
  })

  test("public: 'auto' (or unset) discovers; discovery failure falls back to LAN guess", async () => {
    const discovered = await resolveAdvertisedHost({
      scope: "public",
      advertise: "auto",
      discover: async () => "203.0.113.77",
    })
    expect(discovered).toEqual({ host: "203.0.113.77", source: "discovered" })

    const fallback = await resolveAdvertisedHost({
      scope: "public",
      discover: async () => null,
    })
    expect(fallback.source).toBe("lan-guess")
    expect(fallback.host).toBe(guessOutboundHost())
  })
})

describe("echo-service discovery (mocked fetch)", () => {
  test("first bad service is skipped; a later good one wins", async () => {
    mockFetch(async (url) => {
      if (url.includes("ipify")) throw new Error("network down")
      if (url.includes("ifconfig")) return { ok: true, text: async () => " 198.51.100.9\n" }
      throw new Error("unreached")
    })
    expect(await discoverPublicIPv4(500)).toBe("198.51.100.9")
  })

  test("invalid payloads don't count as answers", async () => {
    mockFetch(async () => ({ ok: true, text: async () => "<html>nope</html>" }))
    expect(await discoverPublicIPv4(500)).toBeNull()
  })

  test("all services failing → null (callers must fall back and say so)", async () => {
    mockFetch(async () => { throw new Error("offline") })
    expect(await discoverPublicIPv4(300)).toBeNull()
  })

  test("HTTP error status is not an answer", async () => {
    mockFetch(async () => ({ ok: false, text: async () => "203.0.113.1" }))
    expect(await discoverPublicIPv4(300)).toBeNull()
  })
})
