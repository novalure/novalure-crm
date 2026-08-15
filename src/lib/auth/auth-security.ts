import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { isIP } from "node:net";

const minimumSecretLength = 32;
const encryptedValueVersion = "v1";

export const authEncryptionKeyEnvironmentName = "NOVALURE_AUTH_ENCRYPTION_KEY";
export const authRateLimitSecretEnvironmentName = "NOVALURE_AUTH_RATE_LIMIT_SECRET";
export const authSessionSecretEnvironmentName = "NOVALURE_SESSION_SECRET";

function cleanEnvironmentValue(value: string | undefined) {
  return (value ?? "").trim().replace(/^['"]|['"]$/g, "");
}

function requireSecret(name: string) {
  const value = cleanEnvironmentValue(process.env[name]);
  if (value.length < minimumSecretLength) {
    throw new Error(`${name} must contain at least ${minimumSecretLength} characters`);
  }
  return value;
}

export function assertAuthSecurityConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const missing = [
    authSessionSecretEnvironmentName,
    authEncryptionKeyEnvironmentName,
    authRateLimitSecretEnvironmentName,
  ].filter((name) => cleanEnvironmentValue(env[name]).length < minimumSecretLength);

  if (missing.length) {
    throw new Error(`${missing.join(", ")} must each contain at least ${minimumSecretLength} characters`);
  }
}

export function isAuthSecurityConfigured(env: NodeJS.ProcessEnv = process.env) {
  return [
    authSessionSecretEnvironmentName,
    authEncryptionKeyEnvironmentName,
    authRateLimitSecretEnvironmentName,
  ].every((name) => cleanEnvironmentValue(env[name]).length >= minimumSecretLength);
}

export function normalizeAuthEmail(value: string) {
  return value.trim().toLowerCase();
}

export function createOpaqueToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function hashOpaqueToken(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function hashRequestUserAgent(value: string | null | undefined) {
  const normalized = (value ?? "").trim().slice(0, 2_048);
  return normalized ? createHash("sha256").update(normalized).digest("hex") : null;
}

export function protectLowEntropyValue(purpose: string, value: string) {
  const secret = requireSecret(authRateLimitSecretEnvironmentName);
  return createHmac("sha256", secret)
    .update(`novalure-auth-${purpose}-v1\0`)
    .update(value)
    .digest("hex");
}

function getEncryptionKey() {
  return createHash("sha256")
    .update("novalure-auth-encryption-v1\0")
    .update(requireSecret(authEncryptionKeyEnvironmentName))
    .digest();
}

function decodeCanonicalBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64url");
  return decoded.toString("base64url") === value ? decoded : null;
}

export function encryptAuthValue(value: unknown) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    encryptedValueVersion,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptAuthValue<Value>(value: string): Value | null {
  const [version, ivValue, tagValue, ciphertextValue, extra] = value.split(".");
  if (
    version !== encryptedValueVersion ||
    !ivValue ||
    !tagValue ||
    !ciphertextValue ||
    extra ||
    value.length > 32_768
  ) return null;

  try {
    const iv = decodeCanonicalBase64Url(ivValue);
    const tag = decodeCanonicalBase64Url(tagValue);
    const ciphertext = decodeCanonicalBase64Url(ciphertextValue);
    if (!iv || !tag || !ciphertext || iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
      return null;
    }

    const decipher = createDecipheriv("aes-256-gcm", getEncryptionKey(), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    return JSON.parse(plaintext) as Value;
  } catch {
    return null;
  }
}

export function safeEqualAuthValue(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function readCookieValue(cookieHeader: string | null | undefined, name: string) {
  let value: string | null = null;

  for (const part of (cookieHeader ?? "").split(";")) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf("=");
    if (separator <= 0 || trimmed.slice(0, separator) !== name) continue;

    try {
      value = decodeURIComponent(trimmed.slice(separator + 1));
    } catch {
      return null;
    }
  }

  return value;
}

export function hasCookieName(cookieHeader: string | null | undefined, name: string) {
  return (cookieHeader ?? "").split(";").some((part) => {
    const trimmed = part.trim();
    const separator = trimmed.indexOf("=");
    return separator > 0 && trimmed.slice(0, separator) === name;
  });
}

function normalizeTrustedClientIp(value: string) {
  const version = isIP(value);
  if (version === 4) return value;
  if (version !== 6) return null;

  try {
    const hostname = new URL(`http://[${value}]`).hostname;
    return hostname.startsWith("[") ? hostname.slice(1, -1).toLowerCase() : hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Resolve a client IP only from a header that the deployment platform or an
 * explicitly configured trusted proxy owns. Generic forwarding headers are
 * intentionally ignored because a direct client can spoof them.
 */
export function getTrustedAuthClientIp(
  requestHeaders: Pick<Headers, "get">,
  env: NodeJS.ProcessEnv = process.env,
) {
  let headerName = "";
  if (env.VERCEL === "1" || env.VERCEL_ENV?.trim()) {
    headerName = "x-vercel-forwarded-for";
  } else if (env.NOVALURE_TRUSTED_CLIENT_IP_HEADER?.trim()) {
    headerName = env.NOVALURE_TRUSTED_CLIENT_IP_HEADER.trim().toLowerCase();
    if (!/^[a-z0-9-]{1,64}$/u.test(headerName)) return null;
  } else {
    return null;
  }

  const value = requestHeaders.get(headerName);
  if (!value || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  const firstHop = value.split(",", 1)[0]?.trim() ?? "";
  return normalizeTrustedClientIp(firstHop);
}

export function getAuthRequestFingerprint(request: Request) {
  const clientIp = getTrustedAuthClientIp(request.headers) ?? "unavailable";
  return {
    ipHash: protectLowEntropyValue("request-ip", clientIp),
    userAgentHash: hashRequestUserAgent(request.headers.get("user-agent")),
  };
}
