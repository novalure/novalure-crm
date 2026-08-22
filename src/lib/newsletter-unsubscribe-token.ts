import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const tokenVersion = "v1";
const tokenPurpose = "newsletter_unsubscribe";
const maximumTokenLength = 2_048;
const maximumClockSkewSeconds = 30;
const minimumSecretBytes = 32;

export const newsletterUnsubscribeTokenTtlSeconds = 90 * 24 * 60 * 60;

type NewsletterUnsubscribeTokenPayload = {
  campaignId: string | null;
  email: string;
  exp: number;
  iat: number;
  purpose: typeof tokenPurpose;
  tokenId: string;
  version: 1;
  workspaceId: string;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

function getTokenSecret() {
  const secret = process.env.NOVALURE_AUTH_ENCRYPTION_KEY?.trim() ?? "";
  if (Buffer.byteLength(secret, "utf8") < minimumSecretBytes) {
    throw new Error("NOVALURE_AUTH_ENCRYPTION_KEY must contain at least 32 bytes");
  }
  return secret;
}

function getTokenEncryptionKey() {
  return createHash("sha256")
    .update("novalure-newsletter-unsubscribe-token-v1\0")
    .update(getTokenSecret())
    .digest();
}

function decodeCanonicalBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const decoded = Buffer.from(value, "base64url");
  return decoded.toString("base64url") === value ? decoded : null;
}

function normalizeEmail(value: string) {
  const email = value.trim().toLowerCase();
  return email.length <= 254 && emailPattern.test(email) ? email : "";
}

export function createNewsletterUnsubscribeToken(input: {
  campaignId?: string | null;
  email: string;
  nowSeconds?: number;
  workspaceId: string;
}) {
  const email = normalizeEmail(input.email);
  if (!email || !uuidPattern.test(input.workspaceId)) {
    throw new Error("Newsletter unsubscribe token input is invalid");
  }

  const issuedAt = input.nowSeconds ?? Math.floor(Date.now() / 1_000);
  const payload = {
    campaignId: input.campaignId && uuidPattern.test(input.campaignId) ? input.campaignId : null,
    email,
    exp: issuedAt + newsletterUnsubscribeTokenTtlSeconds,
    iat: issuedAt,
    purpose: tokenPurpose,
    tokenId: randomBytes(24).toString("base64url"),
    version: 1,
    workspaceId: input.workspaceId,
  } satisfies NewsletterUnsubscribeTokenPayload;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getTokenEncryptionKey(), iv);
  cipher.setAAD(Buffer.from(`novalure:${tokenPurpose}:${tokenVersion}`, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    tokenVersion,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function parseNewsletterUnsubscribeToken(
  value: string | null | undefined,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  if (!value || value.length > maximumTokenLength) return null;
  const [version, ivValue, tagValue, ciphertextValue, extra] = value.split(".");
  if (version !== tokenVersion || !ivValue || !tagValue || !ciphertextValue || extra) return null;

  try {
    const iv = decodeCanonicalBase64Url(ivValue);
    const tag = decodeCanonicalBase64Url(tagValue);
    const ciphertext = decodeCanonicalBase64Url(ciphertextValue);
    if (!iv || !tag || !ciphertext || iv.length !== 12 || tag.length !== 16 || !ciphertext.length) {
      return null;
    }

    const decipher = createDecipheriv("aes-256-gcm", getTokenEncryptionKey(), iv);
    decipher.setAAD(Buffer.from(`novalure:${tokenPurpose}:${tokenVersion}`, "utf8"));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
    const payload = JSON.parse(plaintext) as Partial<NewsletterUnsubscribeTokenPayload>;
    const email = typeof payload.email === "string" ? normalizeEmail(payload.email) : "";

    if (
      payload.version !== 1 ||
      payload.purpose !== tokenPurpose ||
      !email ||
      typeof payload.workspaceId !== "string" ||
      !uuidPattern.test(payload.workspaceId) ||
      (payload.campaignId !== null &&
        (typeof payload.campaignId !== "string" || !uuidPattern.test(payload.campaignId))) ||
      typeof payload.tokenId !== "string" ||
      !/^[A-Za-z0-9_-]{32}$/u.test(payload.tokenId) ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number" ||
      !Number.isSafeInteger(payload.iat) ||
      !Number.isSafeInteger(payload.exp) ||
      payload.iat > nowSeconds + maximumClockSkewSeconds ||
      payload.exp <= nowSeconds ||
      payload.exp - payload.iat !== newsletterUnsubscribeTokenTtlSeconds
    ) {
      return null;
    }

    return {
      campaignId: payload.campaignId,
      email,
      expiresAt: payload.exp,
      tokenId: payload.tokenId,
      workspaceId: payload.workspaceId,
    };
  } catch {
    return null;
  }
}
