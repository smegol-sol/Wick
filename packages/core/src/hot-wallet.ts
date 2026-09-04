import { ed25519 } from "@noble/curves/ed25519";
import { isB58 } from "./guard.ts";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ITER_V1 = 150_000;
const ITER = 400_000;
const MIN_PASS = 10;
const MAX_PASS = 128;
const FAIL_MAX = 5;
const IDLE_MS = 8 * 60_000;
const HIDDEN_MS = 45_000;

export type HotVault = {
  pub: string;
  salt: string;
  iv: string;
  data: string;
  exported: boolean;
  v?: 1 | 2;
  iter?: number;
};

let mem: Uint8Array | null = null;
let fails = 0;
let lockUntil = 0;
let lastUse = 0;

export function holdSecret(next: Uint8Array | null): void {
  if (mem) mem.fill(0);
  mem = next;
  lastUse = next ? Date.now() : 0;
}

export function peekSecret(): Uint8Array | null {
  if (mem) lastUse = Date.now();
  return mem;
}

export function touchHot(): void {
  if (mem) lastUse = Date.now();
}

export function unlockWait(): number {
  return Math.max(0, lockUntil - Date.now());
}

export function idleLockDue(hiddenSince: number): boolean {
  if (!mem) return false;
  if (Date.now() - lastUse >= IDLE_MS) return true;
  if (hiddenSince > 0 && Date.now() - hiddenSince >= HIDDEN_MS) return true;
  return false;
}

export function passOk(raw: string): boolean {
  if (raw.length < MIN_PASS || raw.length > MAX_PASS) return false;
  if (/^(.)\1+$/.test(raw)) return false;
  if (/^(1234567890|0123456789|password|qwertyuiop|abcdefghij)/i.test(raw)) return false;
  return true;
}

export function toB58(bytes: Uint8Array): string {
  if (!bytes.length) return "";
  const digits = [0];
  for (let i = 0; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] * 256;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  let i = digits.length - 1;
  while (i >= 0 && digits[i] === 0) i -= 1;
  let out = "1".repeat(zeros);
  for (; i >= 0; i--) out += B58[digits[i]];
  return out;
}

export function fromB58(s: string): Uint8Array | null {
  if (!s || s.length > 128) return null;
  let zeros = 0;
  for (let i = 0; i < s.length; i++) {
    if (B58.indexOf(s[i]) < 0) return null;
    if (i === zeros && s[i] === "1") zeros += 1;
  }
  if (zeros === s.length) return new Uint8Array(zeros);
  const digits = [0];
  for (let i = zeros; i < s.length; i++) {
    let carry = B58.indexOf(s[i]);
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] * 58;
      digits[j] = carry & 255;
      carry >>= 8;
    }
    while (carry > 0) {
      digits.push(carry & 255);
      carry >>= 8;
    }
  }
  let hi = digits.length - 1;
  while (hi > 0 && digits[hi] === 0) hi -= 1;
  const out = new Uint8Array(zeros + hi + 1);
  for (let i = 0; i <= hi; i++) out[out.length - 1 - i] = digits[i];
  return out;
}

/** Accept 32-byte seed or 64-byte secret: base58, hex, or JSON byte array. */
export function parseSecret(raw: string): Uint8Array | null {
  const t = raw.trim();
  if (!t || t.length > 400) return null;
  let bytes: Uint8Array | null = null;
  if (t.startsWith("[")) {
    try {
      const arr = JSON.parse(t) as unknown;
      if (!Array.isArray(arr) || (arr.length !== 32 && arr.length !== 64)) return null;
      if (!arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return null;
      bytes = Uint8Array.from(arr);
    } catch {
      return null;
    }
  } else {
    const hex = t.startsWith("0x") || t.startsWith("0X") ? t.slice(2) : t;
    const looksHex = (hex.length === 64 || hex.length === 128) && /^[0-9a-fA-F]+$/.test(hex);
    if (looksHex && (t.startsWith("0x") || t.startsWith("0X") || hex.includes("0"))) {
      bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    } else {
      bytes = fromB58(t);
    }
  }
  if (!bytes || (bytes.length !== 32 && bytes.length !== 64)) return null;
  const seed = bytes.length === 32 ? bytes : bytes.subarray(0, 32);
  let pub: Uint8Array;
  try {
    pub = ed25519.getPublicKey(seed);
  } catch {
    bytes.fill(0);
    return null;
  }
  if (bytes.length === 64) {
    for (let i = 0; i < 32; i++) {
      if (bytes[32 + i] !== pub[i]) {
        bytes.fill(0);
        return null;
      }
    }
    return bytes;
  }
  const secret = new Uint8Array(64);
  secret.set(bytes);
  secret.set(pub, 32);
  bytes.fill(0);
  return secret;
}

export async function importHot(
  raw: string,
  pass: string,
): Promise<{ vault: HotVault; pub: string }> {
  if (!passOk(pass)) throw new Error("bad");
  const secret = parseSecret(raw);
  if (!secret) throw new Error("bad");
  const pub = toB58(secret.subarray(32));
  const vault = await sealSecret(secret, pass, pub);
  vault.exported = true;
  holdSecret(secret);
  return { vault, pub };
}

export function b64of(u: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) {
    s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function b64to(s: string): Uint8Array {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

function compactU16(bytes: Uint8Array, offset: number): { n: number; size: number } {
  let n = 0;
  let size = 0;
  for (; size < 3; size++) {
    if (offset + size >= bytes.length) throw new Error("bad");
    const b = bytes[offset + size];
    n |= (b & 0x7f) << (size * 7);
    if ((b & 0x80) === 0) return { n, size: size + 1 };
  }
  throw new Error("bad");
}

export function feePayerOf(bin: Uint8Array): Uint8Array | null {
  try {
    const sigs = compactU16(bin, 0);
    if (sigs.n < 1) return null;
    let i = sigs.size + sigs.n * 64;
    if (i >= bin.length) return null;
    if (bin[i] & 0x80) {
      if ((bin[i] & 0x7f) !== 0) return null;
      i += 1;
    }
    if (i + 3 >= bin.length) return null;
    i += 3;
    const keys = compactU16(bin, i);
    i += keys.size;
    if (keys.n < 1 || i + 32 > bin.length) return null;
    return bin.subarray(i, i + 32);
  } catch {
    return null;
  }
}

function mintSecret(): { secret: Uint8Array; pub: Uint8Array } {
  const seed = ed25519.utils.randomPrivateKey();
  const pub = ed25519.getPublicKey(seed);
  const secret = new Uint8Array(64);
  secret.set(seed);
  secret.set(pub, 32);
  seed.fill(0);
  return { secret, pub };
}

async function derive(pass: string, salt: Uint8Array, iter: number): Promise<CryptoKey> {
  const raw = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pass),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt.buffer as ArrayBuffer, iterations: iter, hash: "SHA-256" },
    raw,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function aadOf(pub: string): Uint8Array {
  return new TextEncoder().encode(pub);
}

export async function sealSecret(secret: Uint8Array, pass: string, pub: string): Promise<HotVault> {
  if (!passOk(pass) || !isB58(pub) || secret.length < 32) throw new Error("bad");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await derive(pass, salt, ITER);
  const packed = new Uint8Array(secret);
  const buf = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv.buffer as ArrayBuffer,
      additionalData: aadOf(pub).buffer as ArrayBuffer,
    },
    key,
    packed.buffer as ArrayBuffer,
  );
  packed.fill(0);
  return {
    pub,
    salt: b64of(salt),
    iv: b64of(iv),
    data: b64of(new Uint8Array(buf)),
    exported: false,
    v: 2,
    iter: ITER,
  };
}

export async function openVault(vault: HotVault, pass: string): Promise<Uint8Array> {
  if (!passOk(pass) || !isB58(vault.pub)) throw new Error("bad");
  const salt = b64to(vault.salt);
  const iv = b64to(vault.iv);
  const data = b64to(vault.data);
  if (salt.length !== 16 || iv.length !== 12 || data.length < 16) throw new Error("bad");
  const ver = vault.v === 2 ? 2 : 1;
  const iter =
    typeof vault.iter === "number" && vault.iter >= 100_000 && vault.iter <= 2_000_000
      ? Math.floor(vault.iter)
      : ver === 2
        ? ITER
        : ITER_V1;
  const key = await derive(pass, salt, iter);
  const params: AesGcmParams = { name: "AES-GCM", iv: iv.buffer as ArrayBuffer };
  if (ver === 2) params.additionalData = aadOf(vault.pub).buffer as ArrayBuffer;
  const buf = await crypto.subtle.decrypt(params, key, data.buffer as ArrayBuffer);
  return new Uint8Array(buf);
}

export function slimVault(raw: unknown): HotVault | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.pub !== "string" || !isB58(v.pub)) return null;
  if (typeof v.salt !== "string" || typeof v.iv !== "string" || typeof v.data !== "string")
    return null;
  if (v.salt.length > 64 || v.iv.length > 48 || v.data.length > 400) return null;
  if (!/^[A-Za-z0-9+/=]+$/.test(v.salt + v.iv + v.data)) return null;
  const ver = v.v === 2 ? 2 : 1;
  const iter =
    typeof v.iter === "number" && v.iter >= 100_000 && v.iter <= 2_000_000
      ? Math.floor(v.iter)
      : undefined;
  return {
    pub: v.pub,
    salt: v.salt,
    iv: v.iv,
    data: v.data,
    exported: v.exported === true,
    v: ver,
    iter,
  };
}

export async function createHot(pass: string): Promise<{ vault: HotVault; secretB58: string }> {
  if (!passOk(pass)) throw new Error("bad");
  const { secret, pub } = mintSecret();
  const pubB58 = toB58(pub);
  const vault = await sealSecret(secret, pass, pubB58);
  const secretB58 = toB58(secret);
  holdSecret(secret);
  return { vault, secretB58 };
}

export async function unlockHot(vault: HotVault, pass: string): Promise<void> {
  if (Date.now() < lockUntil) throw new Error("lockout");
  try {
    const secret = await openVault(vault, pass);
    const pub = ed25519.getPublicKey(secret.subarray(0, 32));
    if (toB58(pub) !== vault.pub) {
      secret.fill(0);
      throw new Error("bad");
    }
    holdSecret(secret);
    fails = 0;
    lockUntil = 0;
  } catch (e) {
    fails += 1;
    if (fails >= FAIL_MAX) lockUntil = Date.now() + Math.min(60_000, 8_000 * (fails - 4));
    throw e;
  }
}

export function lockHotMem(): void {
  holdSecret(null);
}

export async function signHotTx(unsignedB64: string): Promise<string> {
  const secret = peekSecret();
  if (!secret || secret.length < 32) throw new Error("locked");
  const bin = b64to(unsignedB64);
  const { n, size } = compactU16(bin, 0);
  if (n < 1 || size + n * 64 >= bin.length) throw new Error("bad");
  const payer = feePayerOf(bin);
  const pub = secret.subarray(32, 64);
  if (!payer || payer.length !== 32) throw new Error("bad");
  for (let i = 0; i < 32; i++) {
    if (payer[i] !== pub[i]) throw new Error("payer");
  }
  const msg = bin.subarray(size + n * 64);
  const sig = ed25519.sign(msg, secret.subarray(0, 32));
  const out = new Uint8Array(bin);
  out.set(sig, size);
  return b64of(out);
}

export function canSignHot(vault: HotVault | null, unlocked: boolean, pk: string | null): boolean {
  return !!(unlocked && vault?.exported && pk && vault.pub === pk && peekSecret());
}
