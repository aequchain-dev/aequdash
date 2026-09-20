/**
 * aequdash — tests/node/rational.test.ts
 *
 * The sacred arithmetic: exact BigInt rational math. If these pass, money
 * cannot drift.
 */

import { describe, test, expect } from "bun:test"
import { Rational, rsum } from "../../src/node/rational.ts"

describe("Rational construction", () => {
  test("integers", () => {
    expect(Rational.of(5).toString()).toBe("5/1")
    expect(Rational.of(-7).toString()).toBe("-7/1")
  })
  test("normalizes by gcd", () => {
    expect(Rational.of(6, 8).toString()).toBe("3/4")
    expect(Rational.of(100, 10).toString()).toBe("10/1")
  })
  test("denominator sign normalized", () => {
    expect(Rational.of(1, -2).toString()).toBe("-1/2")
    expect(Rational.of(-1, -2).toString()).toBe("1/2")
  })
  test("zero denominator throws", () => {
    expect(() => Rational.of(1, 0)).toThrow()
  })
  test("zero is always 0/1", () => {
    expect(Rational.of(0, 999).toString()).toBe("0/1")
  })
})

describe("decimal parsing (exact)", () => {
  test('parses "1000.50" exactly', () => {
    const r = Rational.fromDecimal("1000.50")
    expect(r.toString()).toBe("2001/2")
  })
  test("parses rates like 2.2805", () => {
    expect(Rational.fromDecimal("2.2805").toString()).toBe("4561/2000")
  })
  test("parses negatives", () => {
    expect(Rational.fromDecimal("-3.25").toString()).toBe("-13/4")
  })
  test("parses integers", () => {
    expect(Rational.fromDecimal("42").toString()).toBe("42/1")
  })
  test("parses Julia wire form n/d", () => {
    expect(Rational.parse("963/2").toString()).toBe("963/2")
  })
  test("rejects garbage", () => {
    expect(() => Rational.fromDecimal("1.2.3")).toThrow()
    expect(() => Rational.fromDecimal("abc")).toThrow()
  })
})

describe("arithmetic is exact", () => {
  test("1/3 + 1/3 + 1/3 == 1 exactly", () => {
    const third = Rational.of(1, 3)
    expect(rsum([third, third, third]).eq(Rational.ONE)).toBe(true)
  })
  test("0.1 + 0.2 == 0.3 exactly (floats cannot do this)", () => {
    const a = Rational.fromDecimal("0.1")
    const b = Rational.fromDecimal("0.2")
    expect(a.add(b).eq(Rational.fromDecimal("0.3"))).toBe(true)
  })
  test("division is exact: 1000 / 3 × 3 == 1000", () => {
    const t = Rational.of(1000)
    const share = t.div(Rational.of(3))
    expect(share.mul(Rational.of(3)).eq(t)).toBe(true)
  })
  test("mixed operations", () => {
    const a = Rational.of(22, 7)
    const b = Rational.of(355, 113)
    const c = a.mul(b).div(b)
    expect(c.eq(a)).toBe(true)
  })
  test("subtraction to zero", () => {
    const a = Rational.fromDecimal("17.35")
    expect(a.sub(a).isZero()).toBe(true)
  })
})

describe("comparison", () => {
  test("cmp/eq/gt/lt", () => {
    const a = Rational.of(1, 2)
    const b = Rational.of(2, 4)
    const c = Rational.of(3, 4)
    expect(a.eq(b)).toBe(true)
    expect(a.cmp(b)).toBe(0)
    expect(c.gt(a)).toBe(true)
    expect(a.lt(c)).toBe(true)
  })
  test("sign", () => {
    expect(Rational.of(5).sign()).toBe(1)
    expect(Rational.of(-5).sign()).toBe(-1)
    expect(Rational.ZERO.sign()).toBe(0)
  })
})

describe("presentation boundary (display only)", () => {
  test("toFixed rounds half-up", () => {
    expect(Rational.of(1, 8).toFixed(2)).toBe("0.13")   // 0.125 → 0.13
    expect(Rational.of(1, 4).toFixed(2)).toBe("0.25")
    expect(Rational.of(1000, 3).toFixed(2)).toBe("333.33")
  })
  test("toFixed(0)", () => {
    expect(Rational.of(5, 2).toFixed(0)).toBe("3")       // 2.5 → 3
  })
  test("negative toFixed", () => {
    expect(Rational.of(-7, 2).toFixed(2)).toBe("-3.50")
  })
  test("toNumber is approximate (display only)", () => {
    expect(Rational.of(1, 3).toNumber()).toBeCloseTo(0.3333, 3)
  })
})
