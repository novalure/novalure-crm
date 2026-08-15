import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export type CalendarOAuthProvider = "google" | "microsoft";

export type OAuthStatePayload = {
  exp: number;
  iat: number;
  nonce: string;
  provider: CalendarOAuthProvider;
  returnTo: string;
  userId: string;
  workspaceId: string;
};

export const oauthStateTtlSeconds = 10 * 60;

function base64UrlEncode(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

export function assertOAuthStateSecretConfigured() {
  const secret = process.env.OAUTH_STATE_SECRET?.trim();
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("OAUTH_STATE_SECRET must be configured with at least 32 bytes");
  }

  return secret;
}

function getStateSecret() {
  return assertOAuthStateSecretConfigured();
}

function getStateEncryptionKey() {
  return createHash("sha256").update(getStateSecret()).digest();
}

function signState(payload: string) {
  return createHmac("sha256", getStateSecret()).update(payload).digest("base64url");
}

function signaturesMatch(expected: string, provided: string) {
  const expectedBuffer = Buffer.from(expected, "base64url");
  const providedBuffer = Buffer.from(provided, "base64url");
  return (
    expectedBuffer.length === providedBuffer.length &&
    expectedBuffer.length > 0 &&
    timingSafeEqual(expectedBuffer, providedBuffer)
  );
}

export function hashOAuthState(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function encryptOAuthStateSecret(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getStateEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return ["v1", base64UrlEncode(iv), base64UrlEncode(authTag), base64UrlEncode(encrypted)].join(".");
}

export function decryptOAuthStateSecret(value: string) {
  const [version, ivRaw, tagRaw, encryptedRaw] = value.split(".");
  if (version !== "v1" || !ivRaw || !tagRaw || !encryptedRaw) {
    throw new Error("OAuth state secret is invalid");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    getStateEncryptionKey(),
    Buffer.from(ivRaw, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function createSignedOAuthState(input: {
  nowSeconds?: number;
  provider: CalendarOAuthProvider;
  returnTo: string;
  userId: string;
  workspaceId: string;
}) {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const nonce = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(48).toString("base64url");
  const payload = base64UrlEncode(
    JSON.stringify({
      exp: now + oauthStateTtlSeconds,
      iat: now,
      nonce,
      provider: input.provider,
      returnTo: input.returnTo,
      userId: input.userId,
      workspaceId: input.workspaceId,
    } satisfies OAuthStatePayload),
  );
  const state = `${payload}.${signState(payload)}`;

  return {
    codeChallenge: createHash("sha256").update(codeVerifier).digest("base64url"),
    codeVerifier,
    expiresAt: now + oauthStateTtlSeconds,
    nonce,
    state,
  };
}

export function parseSignedOAuthState(
  value: string | null,
  expectedProvider: CalendarOAuthProvider,
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  if (!payload || !signature || !signaturesMatch(signState(payload), signature)) return null;

  try {
    const parsed = JSON.parse(base64UrlDecode(payload)) as Partial<OAuthStatePayload>;
    if (
      parsed.provider !== expectedProvider ||
      typeof parsed.userId !== "string" ||
      typeof parsed.workspaceId !== "string" ||
      typeof parsed.nonce !== "string" ||
      parsed.nonce.length < 32 ||
      typeof parsed.iat !== "number" ||
      typeof parsed.exp !== "number" ||
      parsed.iat > nowSeconds + 30 ||
      parsed.exp <= nowSeconds ||
      parsed.exp - parsed.iat !== oauthStateTtlSeconds ||
      typeof parsed.returnTo !== "string" ||
      !parsed.returnTo.startsWith("/") ||
      parsed.returnTo.startsWith("//") ||
      parsed.returnTo.length > 2048 ||
      /[\\\u0000-\u001f\u007f]/.test(parsed.returnTo)
    ) {
      return null;
    }

    return parsed as OAuthStatePayload;
  } catch {
    return null;
  }
}
