import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(value: Buffer) {
  let bits = 0;
  let buffer = 0;
  let encoded = "";

  for (const byte of value) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += base32Alphabet[(buffer >>> bits) & 31];
    }
  }

  if (bits > 0) encoded += base32Alphabet[(buffer << (5 - bits)) & 31];
  return encoded;
}

function base32Decode(value: string) {
  const normalized = value.toUpperCase().replace(/=+$/g, "").replace(/[\s-]/g, "");
  if (!normalized || /[^A-Z2-7]/.test(normalized)) return null;

  let bits = 0;
  let buffer = 0;
  const decoded: number[] = [];

  for (const character of normalized) {
    const index = base32Alphabet.indexOf(character);
    if (index < 0) return null;
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      decoded.push((buffer >>> bits) & 255);
    }
  }

  return Buffer.from(decoded);
}

function hotp(secret: Buffer, counter: number) {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 15;
  const binary =
    ((digest[offset] & 127) << 24) |
    ((digest[offset + 1] & 255) << 16) |
    ((digest[offset + 2] & 255) << 8) |
    (digest[offset + 3] & 255);
  return String(binary % 1_000_000).padStart(6, "0");
}

export function createTotpSecret() {
  return base32Encode(randomBytes(20));
}

export function createTotpCode(secret: string, now = Date.now()) {
  const decoded = base32Decode(secret);
  if (!decoded) return null;
  return hotp(decoded, Math.floor(now / 30_000));
}

export function verifyTotpCode(secret: string, code: string, now = Date.now()) {
  const normalizedCode = code.trim();
  if (!/^\d{6}$/.test(normalizedCode)) return false;

  for (const offset of [-1, 0, 1]) {
    const expected = createTotpCode(secret, now + offset * 30_000);
    if (!expected) continue;
    const left = Buffer.from(normalizedCode);
    const right = Buffer.from(expected);
    if (left.length === right.length && timingSafeEqual(left, right)) return true;
  }
  return false;
}

export function normalizeRecoveryCode(value: string) {
  return value.toUpperCase().replace(/[^A-Z2-9]/g, "");
}

export function createRecoveryCodes(count = 10) {
  return Array.from({ length: count }, () => {
    const code = base32Encode(randomBytes(10));
    return code.match(/.{1,4}/g)?.join("-") ?? code;
  });
}
