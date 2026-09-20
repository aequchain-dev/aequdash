/**
 * aequdash — src/node/crypto.ts
 *
 * Cryptographic primitives for the ephemeral testnet mesh.
 *
 *   - SHA-256 hashing (hex) for blocks, txs, state roots
 *   - Ed25519 identities for validator signatures (node:crypto)
 *   - Canonical JSON for deterministic signing payloads
 *
 * Keys are generated in memory at boot and never persisted — the mesh is
 * ephemeral by construction.
 */

import {
  createHash,
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
  createPrivateKey,
  createPublicKey,
} from "node:crypto"

// ─────────────────────────────────────────────────────────────────────────────
// Hashing
// ─────────────────────────────────────────────────────────────────────────────

export function sha256(data: string | Uint8Array): Uint8Array {
  return createHash("sha256").update(typeof data === "string" ? data : data).digest()
}

export function sha256hex(data: string | Uint8Array): string {
  return "0x" + createHash("sha256").update(data as string).digest("hex")
}

/**
 * Canonical JSON: object keys sorted recursively, no whitespace.
 * Deterministic across nodes — required for identical block hashes.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value))
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep)
  if (v !== null && typeof v === "object") {
    const obj = v as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(obj).sort()) out[k] = sortDeep(obj[k])
    return out
  }
  return v
}

export function hashObject(value: unknown): string {
  return sha256hex(canonicalJson(value))
}

// ─────────────────────────────────────────────────────────────────────────────
// Ed25519 identities
// ─────────────────────────────────────────────────────────────────────────────

export interface Identity {
  /** Raw public key, base64url (JWK x). Safe to share. */
  pub: string
  /** Raw private key, base64url (JWK d). NEVER leaves the process. */
  priv: string
}

/** Generate a fresh ephemeral identity. */
export function generateIdentity(): Identity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  return {
    pub: publicKey.export({ format: "jwk" }).x as string,
    priv: privateKey.export({ format: "jwk" }).d as string,
  }
}

/** Short fingerprint of a public key — used as validator fingerprint. */
export function fingerprint(pub: string): string {
  return sha256hex(pub).slice(0, 18) // "0x" + 16 hex chars
}

export function signBytes(id: Identity, payload: Uint8Array): string {
  const key = createPrivateKey({
    key: { kty: "OKP", crv: "Ed25519", d: id.priv, x: id.pub },
    format: "jwk",
  })
  return Buffer.from(nodeSign(null, payload, key)).toString("base64url")
}

export function verifyBytes(pub: string, payload: Uint8Array, signature: string): boolean {
  try {
    const key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: pub },
      format: "jwk",
    })
    return nodeVerify(null, payload, key, Buffer.from(signature, "base64url"))
  } catch {
    return false
  }
}

/** Sign an arbitrary JSON-able value canonically. */
export function signObject(id: Identity, value: unknown): string {
  return signBytes(id, new TextEncoder().encode(canonicalJson(value)))
}

export function verifyObject(pub: string, value: unknown, signature: string): boolean {
  return verifyBytes(pub, new TextEncoder().encode(canonicalJson(value)), signature)
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic test identities
// ─────────────────────────────────────────────────────────────────────────────
//
// Real Ed25519 keys, generated once and frozen as fixtures. Tests (and only
// tests) need reproducible validator identities so committees/QCs are
// byte-stable across runs. Production nodes always use generateIdentity().

export const TEST_IDENTITIES: Identity[] = [
  { pub: "dhCzzWrdxinySg2N8nQZUH6UBPkv-fvkdubNs57Wk0E", priv: "yqiOaAj58rsl__GMTRHWa8MuYVfJ7vv1zWjD12N9uMc" },
  { pub: "FVDyAHfb0p15zjo11yzV0TwbZOuwcKI3U2OC-8A4zlQ", priv: "acoj_3XAATUlWiHekUmp7NsjDVnLHxy2hwyMlOn4IAw" },
  { pub: "R4ZRr66AiyU-gdV5egJcfO_L5Oeqa9hL0khko8L1g5Q", priv: "BRGLj3dqFpMfPoaN272kO83bOgBjw9nGeh2_1c4Zkc4" },
  { pub: "hipBB_Pcn_wZuaHVXorxi-FxN_LHt3MLJgpFkKbtmTQ", priv: "Hpn2RLp5IVHsv863kuqtUBPPqrhnzrxSQ-2vq4ayzLs" },
  { pub: "ofc71tPE6PcXDvJ_YbexsSvU7iY1aJx3mqXfeHzki-o", priv: "tJVeSTWWJRdO7MRq0MDmhoWK7LziR3mRaFSZ2BLPfkE" },
  { pub: "pFv3h7t2cd3afDMy-BYwc5OrsffTe1upgz_Qv77SNqc", priv: "xiOa8tqzmET2g03JP-H5cROpcLmnSKbLpB0gGQovVu8" },
  { pub: "mF1rzGEF6rzOyydTrjF_j6tlYzYgxegBjrExt7mz5uQ", priv: "66V3JyjOECAX_RN_9ygnihBWRruGP2-yfOPg4Vs4jc4" },
  { pub: "37ZZmZS0ii96VGW7bmz4JDzjn6-riHW_C_gUmkHe0jU", priv: "fHVF73w3fkV8_ZkHfV_nWtVCu3rySnhzE4Cnh24Dnjg" },
  { pub: "c9BETAw_lt2U1Cyg4CAGe2huCTXrxNnC20qogj2nVN0", priv: "PfLIwj01lNB07OCI0V0XdQq2Xb6q56JdG9U3ZQr9sOE" },
  { pub: "E70CocG0mF4AlhYeJYnCBeJnYOVkavWZjZY8gA54DJU", priv: "TU6tV7YgwfwmY-e1fq3IapBNM3iWhDgiQMJ1DYxF4LM" },
  { pub: "5lGNkUOEyKX_dFqps-w-I4ZbSv0NuusWPtqfkv42Qag", priv: "qeqjKjx58jb_OKGBhcNV_WSBDwhBGRqwu2LU4InA8RM" },
  { pub: "O1DXN3dfwf5YMFehKjFTn5bVVZIAr9DrU44oSlalqW4", priv: "4bMB7WK0ld5v62CHOkX0b-x5n4qeh9Xk57ovR1zMU9w" },
]

let extraIdentities: Identity[] | null = null

/**
 * Identity for tests/fixtures. Index 0..2 are the frozen fixtures above;
 * beyond that, identities are generated once per process and cached (still
 * deterministic WITHIN a test process, which is all tests need).
 */
export function testIdentity(index: number): Identity {
  if (index < TEST_IDENTITIES.length) return TEST_IDENTITIES[index]
  if (!extraIdentities) extraIdentities = []
  while (extraIdentities.length <= index - TEST_IDENTITIES.length) {
    extraIdentities.push(generateIdentity())
  }
  return extraIdentities[index - TEST_IDENTITIES.length]
}
