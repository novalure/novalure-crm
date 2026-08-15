import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

export const mediaPublicShareScope = "public-download";

const signatures: Record<string, (bytes: Uint8Array) => boolean> = {
  "application/msword": (bytes) => startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  "application/pdf": (bytes) => startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]),
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": (bytes) =>
    startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWith(bytes, [0x50, 0x4b, 0x07, 0x08]),
  "image/avif": (bytes) => {
    if (bytes.length < 16 || ascii(bytes, 4, 8) !== "ftyp") return false;
    const brands = ascii(bytes, 8, Math.min(bytes.length, 40));
    return brands.includes("avif") || brands.includes("avis");
  },
  "image/gif": (bytes) => ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a",
  "image/jpeg": (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff]),
  "image/png": (bytes) => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "image/webp": (bytes) => ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP",
};

function startsWith(bytes: Uint8Array, expected: number[]) {
  return expected.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, start: number, end: number) {
  return String.fromCharCode(...bytes.slice(start, end));
}

export function hasExpectedMediaMagicBytes(bytes: Uint8Array, mimeType: string) {
  const validator = signatures[mimeType.toLowerCase()];
  return Boolean(validator?.(bytes));
}

export function createMediaShareToken() {
  return randomBytes(32).toString("base64url");
}

export function hashMediaShareToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function safeMediaContentDisposition(fileName: string, mimeType: string) {
  const baseName = path.basename(fileName).replace(/[\u0000-\u001f\u007f"\\]/g, "_").trim() || "download";
  const asciiName = baseName.replace(/[^\x20-\x7e]/g, "_").slice(0, 150) || "download";
  const encodedName = encodeURIComponent(baseName.slice(0, 180))
    .replace(/['()*]/g, (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
  const disposition = mimeType.toLowerCase().startsWith("image/") ? "inline" : "attachment";

  return `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodedName}`;
}
