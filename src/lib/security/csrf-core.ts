import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const csrfHeaderName = "x-novalure-csrf-token";
export const csrfTokenLifetimeMs = 5 * 60 * 1_000;

const tokenVersion = 1;
const maximumClockSkewMs = 30_000;
const unsafeMethods = new Set(["DELETE", "PATCH", "POST", "PUT"]);

type CsrfTokenPayload = {
  exp: number;
  iat: number;
  method: string;
  nonce: string;
  pathname: string;
  sessionHash: string;
  version: 1;
};

export type CsrfValidationFailure =
  | "csrf_expired"
  | "csrf_invalid"
  | "csrf_method_mismatch"
  | "csrf_path_mismatch"
  | "csrf_replayed"
  | "csrf_session_mismatch";

export type CsrfValidationResult =
  | {
      expiresAt: number;
      ok: true;
      sessionHash: string;
      tokenHash: string;
    }
  | { ok: false; reason: CsrfValidationFailure };

function base64UrlEncode(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function signPayload(payload: string, secret: string) {
  return createHmac("sha256", secret)
    .update("novalure-csrf-v1\0")
    .update(payload)
    .digest("base64url");
}

function normalizeUnsafeMethod(method: string) {
  const normalized = method.trim().toUpperCase();
  return unsafeMethods.has(normalized) ? normalized : null;
}

function normalizeApiPathname(pathname: string) {
  if (
    !pathname.startsWith("/api/") ||
    pathname.startsWith("//") ||
    pathname.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(pathname) ||
    pathname.length > 2_048
  ) return null;

  try {
    const decoded = decodeURIComponent(pathname);
    if (decoded.includes("\\") || decoded.startsWith("//")) return null;
  } catch {
    return null;
  }

  return pathname;
}

export function isUnsafeCsrfMethod(method: string) {
  return Boolean(normalizeUnsafeMethod(method));
}

export function hashCsrfValue(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function createCsrfToken(input: {
  method: string;
  nonce?: string;
  now?: number;
  pathname: string;
  secret: string;
  sessionCookie: string;
}) {
  const method = normalizeUnsafeMethod(input.method);
  const pathname = normalizeApiPathname(input.pathname);
  if (!method || !pathname || input.secret.length < 32 || !input.sessionCookie) return null;

  const issuedAt = input.now ?? Date.now();
  const payload = base64UrlEncode(JSON.stringify({
    exp: issuedAt + csrfTokenLifetimeMs,
    iat: issuedAt,
    method,
    nonce: input.nonce ?? randomBytes(32).toString("base64url"),
    pathname,
    sessionHash: hashCsrfValue(input.sessionCookie),
    version: tokenVersion,
  } satisfies CsrfTokenPayload));
  const signature = signPayload(payload, input.secret);

  return {
    expiresAt: issuedAt + csrfTokenLifetimeMs,
    token: `${payload}.${signature}`,
  };
}

function parseTokenPayload(token: string, secret: string) {
  if (secret.length < 32 || token.length > 2_048) return null;

  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  if (!payload || !signature || !/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(signature)) {
    return null;
  }

  const expectedSignature = signPayload(payload, secret);
  if (!safeEqual(signature, expectedSignature)) return null;

  try {
    const parsed = JSON.parse(base64UrlDecode(payload)) as Partial<CsrfTokenPayload>;
    if (
      parsed.version !== tokenVersion ||
      typeof parsed.exp !== "number" ||
      typeof parsed.iat !== "number" ||
      typeof parsed.method !== "string" ||
      typeof parsed.nonce !== "string" ||
      typeof parsed.pathname !== "string" ||
      typeof parsed.sessionHash !== "string" ||
      !/^[A-Za-z0-9_-]{32,128}$/.test(parsed.nonce) ||
      !/^[a-f0-9]{64}$/.test(parsed.sessionHash)
    ) return null;

    return parsed as CsrfTokenPayload;
  } catch {
    return null;
  }
}

export function validateCsrfToken(input: {
  method: string;
  now?: number;
  pathname: string;
  secret: string;
  sessionCookie: string;
  token: string;
}): CsrfValidationResult {
  const payload = parseTokenPayload(input.token, input.secret);
  if (!payload) return { ok: false, reason: "csrf_invalid" };

  const now = input.now ?? Date.now();
  if (
    payload.exp <= now ||
    payload.iat > now + maximumClockSkewMs ||
    payload.exp - payload.iat !== csrfTokenLifetimeMs
  ) return { ok: false, reason: "csrf_expired" };

  const method = normalizeUnsafeMethod(input.method);
  if (!method || payload.method !== method) return { ok: false, reason: "csrf_method_mismatch" };

  const pathname = normalizeApiPathname(input.pathname);
  if (!pathname || payload.pathname !== pathname) return { ok: false, reason: "csrf_path_mismatch" };

  const sessionHash = hashCsrfValue(input.sessionCookie);
  if (!safeEqual(payload.sessionHash, sessionHash)) {
    return { ok: false, reason: "csrf_session_mismatch" };
  }

  return {
    expiresAt: payload.exp,
    ok: true,
    sessionHash,
    tokenHash: hashCsrfValue(input.token),
  };
}

export async function validateAndConsumeCsrfToken(
  input: Parameters<typeof validateCsrfToken>[0],
  consume: (validation: Extract<CsrfValidationResult, { ok: true }>) => Promise<boolean>,
): Promise<CsrfValidationResult> {
  const validation = validateCsrfToken(input);
  if (!validation.ok) return validation;

  const consumed = await consume(validation);
  return consumed ? validation : { ok: false, reason: "csrf_replayed" };
}

function normalizeOrigin(value: string) {
  if (!value || value !== value.trim()) return null;

  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password ||
      url.origin !== value ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function validateCsrfRequestContext(
  headers: Pick<Headers, "get">,
  trustedOriginValue: string,
) {
  let trustedOrigin: string;
  try {
    trustedOrigin = new URL(trustedOriginValue).origin;
  } catch {
    return { ok: false as const, reason: "csrf_trusted_origin_invalid" as const };
  }

  const origin = normalizeOrigin(headers.get("origin") ?? "");
  if (!origin || origin !== trustedOrigin) {
    return { ok: false as const, reason: "csrf_origin_invalid" as const };
  }

  if (headers.get("sec-fetch-site")?.trim().toLowerCase() !== "same-origin") {
    return { ok: false as const, reason: "csrf_fetch_site_invalid" as const };
  }

  return { ok: true as const };
}

export function validateCsrfIssuanceContext(
  headers: Pick<Headers, "get">,
  trustedOriginValue: string,
) {
  if (headers.get("sec-fetch-site")?.trim().toLowerCase() !== "same-origin") {
    return { ok: false as const, reason: "csrf_fetch_site_invalid" as const };
  }

  const suppliedOrigin = headers.get("origin");
  if (!suppliedOrigin) return { ok: true as const };

  let trustedOrigin: string;
  try {
    trustedOrigin = new URL(trustedOriginValue).origin;
  } catch {
    return { ok: false as const, reason: "csrf_trusted_origin_invalid" as const };
  }

  const origin = normalizeOrigin(suppliedOrigin);
  return origin === trustedOrigin
    ? { ok: true as const }
    : { ok: false as const, reason: "csrf_origin_invalid" as const };
}
