/**
 * TOTP (RFC 6238 over HOTP, RFC 4226): the second factor for unsealing the
 * vault and clearing a halt (ADR-0009). SHA-1, 30-second steps, six digits,
 * the defaults every authenticator app uses. Pure over WebCrypto, so the
 * same code runs in the engine and in a test.
 */

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 without padding sensitivity; throws on a foreign character. */
export function base32Decode(text: string): Uint8Array {
  const clean = text.toUpperCase().replace(/=+$/, "").replace(/[\s-]/g, "");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("base32: bad character");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export async function hotp(secret: Uint8Array, counter: number, digits = 6): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    secret.buffer.slice(secret.byteOffset, secret.byteOffset + secret.byteLength) as ArrayBuffer,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg.buffer as ArrayBuffer));
  const offset = mac[19]! & 0x0f;
  const code =
    ((mac[offset]! & 0x7f) << 24) |
    ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) |
    (mac[offset + 3]! & 0xff);
  return String(code % 10 ** digits).padStart(digits, "0");
}

export async function totp(secret: Uint8Array, atMs: number, stepSec = 30): Promise<string> {
  return hotp(secret, Math.floor(atMs / 1000 / stepSec));
}

/** Accepts the current step and one on either side (clock skew), nothing wider. */
export async function verifyTotp(
  secret: Uint8Array,
  code: string,
  atMs: number,
  stepSec = 30,
): Promise<boolean> {
  const given = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(given)) return false;
  const step = Math.floor(atMs / 1000 / stepSec);
  for (const c of [step, step - 1, step + 1]) {
    if (c < 0) continue;
    if (constantEqual(await hotp(secret, c), given)) return true;
  }
  return false;
}

function constantEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The URI an authenticator app scans; the secret is base32. */
export function otpauthUri(secretB32: string, label: string, issuer = "WICK"): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
