import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

function envValue(name: string) {
  return process.env[name]?.trim();
}

function getSecretKey() {
  const secret = envValue("OAUTH_TOKEN_ENCRYPTION_KEY");
  if (!secret) {
    throw new Error("OAUTH_TOKEN_ENCRYPTION_KEY is required for storing integration secrets");
  }

  return createHash("sha256").update(secret).digest();
}

export function encryptSecret(value: string | null | undefined) {
  if (!value) return null;

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getSecretKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return ["v1", iv.toString("base64url"), authTag.toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptSecret(value: unknown) {
  if (typeof value !== "string" || !value) return null;

  const [version, ivRaw, tagRaw, encryptedRaw] = value.split(".");
  if (version !== "v1" || !ivRaw || !tagRaw || !encryptedRaw) return null;

  const decipher = createDecipheriv("aes-256-gcm", getSecretKey(), Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
