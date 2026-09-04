/** Base58 as Solana uses it (Bitcoin alphabet, leading zeros as "1"). No dependency. */

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

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
