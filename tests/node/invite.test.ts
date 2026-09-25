/**
 * aequdash — tests/node/invite.test.ts
 *
 * Invite codec: roundtrip fidelity, checksum rejection (wrong token /
 * tampered name), malformed input rejection, open (tokenless) networks.
 */

import { describe, test, expect } from "bun:test"
import {
  buildInvite,
  parseInvite,
  slugifyName,
  generateRand,
  generateToken,
  clusterIdFor,
  PUBLIC_CLUSTER_ID,
} from "../../src/node/invite.ts"

describe("invite codec", () => {
  test("roundtrip: name, endpoints, token survive encode→parse", () => {
    const token = generateToken()
    const rand = generateRand()
    const code = buildInvite({
      name: "meadow",
      rand,
      token,
      endpoints: [{ host: "203.0.113.9", port: 7920 }, { host: "198.51.100.2", port: 7921 }],
    })
    const invite = parseInvite(code)
    expect(invite.name).toBe("meadow")
    expect(invite.clusterId).toBe(clusterIdFor("meadow", rand))
    expect(invite.token).toBe(token)
    expect(invite.endpoints).toEqual([
      { host: "203.0.113.9", port: 7920 },
      { host: "198.51.100.2", port: 7921 },
    ])
  })

  test("open network (no token) roundtrips with null token", () => {
    const rand = generateRand()
    const code = buildInvite({
      name: "commons",
      rand,
      endpoints: [{ host: "192.0.2.10", port: 7920 }],
    })
    const invite = parseInvite(code)
    expect(invite.token).toBeNull()
    expect(invite.clusterId).toBe(clusterIdFor("commons", rand))
  })

  test("wrong token fails the checksum before any dial", () => {
    const rand = generateRand()
    const code = buildInvite({
      name: "meadow",
      rand,
      token: generateToken(),
      endpoints: [{ host: "203.0.113.9", port: 7920 }],
    })
    // Swap in a different token, keep the original checksum
    const tampered = code.replace(/&t=.*$/, `&t=${generateToken()}`)
    expect(() => parseInvite(tampered)).toThrow(/checksum/)
  })

  test("tampered network name fails the checksum", () => {
    const rand = generateRand()
    const code = buildInvite({
      name: "meadow",
      rand,
      token: generateToken(),
      endpoints: [{ host: "203.0.113.9", port: 7920 }],
    })
    const tampered = code.replace("meadow-", "garden-")
    expect(() => parseInvite(tampered)).toThrow()
  })

  test("malformed codes are rejected with useful errors", () => {
    expect(() => parseInvite("http://meadow-x1y2z3.abcd1234?e=h:1")).toThrow(/aeq:\/\//)
    expect(() => parseInvite("aeq://meadow-x1y2z3.abcd1234")).toThrow(/endpoint/)
    expect(() => parseInvite("aeq://meadow-x1y2z3.abcd1234?e=")).toThrow()
    expect(() => parseInvite("aeq://meadow-x1y2z3.abcd1234?e=host:notaport")).toThrow(/port/i)
    expect(() => parseInvite(`aeq://meadow.${"abcd1234"}?e=host:7920`)).toThrow() // no rand
  })

  test("network names are slugified and validated", () => {
    expect(slugifyName("My Meadow")).toBe("my-meadow")
    expect(slugifyName("  ZAR Stokvel 2026 ")).toBe("zar-stokvel-2026")
    expect(() => slugifyName("!!!")).toThrow()
  })

  test("cluster id embeds name + creator nonce; public id is well-known", () => {
    expect(clusterIdFor("meadow", "x1y2z3")).toBe("aeqnet-meadow-x1y2z3")
    expect(PUBLIC_CLUSTER_ID).toBe("aequchain-public")
  })

  test("two creators can reuse a name without collision (distinct rands)", () => {
    const r1 = generateRand()
    const r2 = generateRand()
    // Astronomically unlikely to collide; the POINT is they're distinct keys
    expect(clusterIdFor("meadow", r1)).not.toBe(clusterIdFor("meadow", r2))
  })
})
