/**
 * aequdash — src/node/rational.ts
 *
 * Exact rational arithmetic on BigInt. THE SACRED CORE.
 *
 * Every monetary value in the aequchain ephemeral testnet is a Rational —
 * never a float. The equality invariant
 *
 *     member.value == treasury.total / member_count
 *
 * holds EXACTLY because division here is rational division, not IEEE-754.
 * Display quantization happens only at the snapshot boundary (toNumber /
 * toFixed), never in state.
 *
 * Invariants of this type:
 *   - denominator is always > 0
 *   - numerator/denominator are always coprime (gcd-normalized)
 *   - zero is always 0/1
 *
 * No dependencies. No floats anywhere in arithmetic paths.
 */

export class Rational {
  readonly n: bigint
  readonly d: bigint

  private constructor(n: bigint, d: bigint) {
    if (d === 0n) throw new RangeError("Rational: denominator is zero")
    if (d < 0n) { n = -n; d = -d }
    const g = gcd(n < 0n ? -n : n, d)
    this.n = n / g
    this.d = d / g
  }

  // ── Constructors ──────────────────────────────────────────────────────────

  static readonly ZERO = new Rational(0n, 1n)
  static readonly ONE = new Rational(1n, 1n)

  static of(n: bigint | number, d: bigint | number = 1n): Rational {
    return new Rational(BigInt(n), BigInt(d))
  }

  /** Exact parse of a decimal string: "1000.50" → 2002/2, "-3" → -3/1. */
  static fromDecimal(input: string): Rational {
    const s = input.trim()
    if (!/^[+-]?\d+(\.\d+)?$/.test(s)) {
      throw new SyntaxError(`Rational.fromDecimal: invalid decimal "${input}"`)
    }
    const neg = s.startsWith("-")
    const body = s.replace(/^[+-]/, "")
    const [intPart, fracPart = ""] = body.split(".")
    const scale = 10n ** BigInt(fracPart.length)
    const numerator = BigInt(intPart + fracPart) * (neg ? -1n : 1n)
    return new Rational(numerator, scale)
  }

  /** Parse "n/d" (Julia wire form), "123.45", or integer strings. */
  static parse(input: string): Rational {
    const s = input.trim()
    if (s.includes("/")) {
      const [ns, ds] = s.split("/", 2)
      return new Rational(BigInt(ns), BigInt(ds))
    }
    return Rational.fromDecimal(s)
  }

  /** Safe coercion from unknown wire values (number | "n/d" | "x.y"). */
  static from(v: number | string | bigint | Rational): Rational {
    if (v instanceof Rational) return v
    if (typeof v === "bigint") return new Rational(v, 1n)
    if (typeof v === "string") return Rational.parse(v)
    if (!Number.isFinite(v)) throw new RangeError(`Rational.from: non-finite ${v}`)
    // Numbers enter ONLY through the decimal string path — never binary float
    // arithmetic. This preserves exactness of decimal inputs like 17.35.
    return Rational.fromDecimal(String(v))
  }

  // ── Arithmetic (all exact) ────────────────────────────────────────────────

  add(o: Rational): Rational { return new Rational(this.n * o.d + o.n * this.d, this.d * o.d) }
  sub(o: Rational): Rational { return new Rational(this.n * o.d - o.n * this.d, this.d * o.d) }
  mul(o: Rational): Rational { return new Rational(this.n * o.n, this.d * o.d) }
  div(o: Rational): Rational {
    if (o.n === 0n) throw new RangeError("Rational.div: division by zero")
    return new Rational(this.n * o.d, this.d * o.n)
  }
  neg(): Rational { return new Rational(-this.n, this.d) }
  abs(): Rational { return this.n < 0n ? this.neg() : this }

  /** Exact sign: -1, 0, 1. */
  sign(): -1 | 0 | 1 { return this.n < 0n ? -1 : this.n > 0n ? 1 : 0 }

  cmp(o: Rational): -1 | 0 | 1 {
    const lhs = this.n * o.d
    const rhs = o.n * this.d
    return lhs < rhs ? -1 : lhs > rhs ? 1 : 0
  }
  eq(o: Rational): boolean { return this.n === o.n && this.d === o.d }
  gt(o: Rational): boolean { return this.cmp(o) > 0 }
  gte(o: Rational): boolean { return this.cmp(o) >= 0 }
  lt(o: Rational): boolean { return this.cmp(o) < 0 }
  lte(o: Rational): boolean { return this.cmp(o) <= 0 }
  isZero(): boolean { return this.n === 0n }
  isPositive(): boolean { return this.n > 0n }

  min(o: Rational): Rational { return this.lte(o) ? this : o }
  max(o: Rational): Rational { return this.gte(o) ? this : o }

  /** floor to integer */
  floor(): Rational {
    const q = this.n / this.d  // BigInt division truncates toward zero
    const r = this.n % this.d
    const adjusted = (r !== 0n && this.n < 0n) ? q - 1n : q
    return new Rational(adjusted, 1n)
  }

  // ── Presentation (the ONLY lossy boundary — display only) ────────────────

  /** Float approximation for UI display. NEVER used in state math. */
  toNumber(): number { return Number(this.n) / Number(this.d) }

  /** Fixed-decimal string with round-half-up at the requested precision. */
  toFixed(decimals: number): string {
    const scale = 10n ** BigInt(decimals)
    const scaled = this.n * scale
    const q = scaled / this.d
    const r = scaled % this.d
    // round half up (ties away from zero on the absolute remainder)
    const rounded = (r * 2n >= this.d) ? q + 1n : q
    const neg = rounded < 0n
    const abs = neg ? -rounded : rounded
    const intPart = abs / scale
    const fracPart = (abs % scale).toString().padStart(decimals, "0")
    return (neg ? "-" : "") + intPart.toString() + (decimals > 0 ? "." + fracPart : "")
  }

  /** Canonical wire form: reduced "n/d". */
  toString(): string { return `${this.n}/${this.d}` }
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) { const t = b; b = a % b; a = t }
  return a === 0n ? 1n : a
}

/** Sum a list of rationals exactly. */
export function rsum(xs: readonly Rational[]): Rational {
  let acc = Rational.ZERO
  for (const x of xs) acc = acc.add(x)
  return acc
}
