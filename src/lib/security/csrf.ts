import { getTrustedAppOrigin } from "@/lib/auth/app-origin";
import { queryOne } from "@/lib/db/client";
import {
  createCsrfToken,
  csrfHeaderName,
  isUnsafeCsrfMethod,
  validateAndConsumeCsrfToken,
  validateCsrfIssuanceContext,
  validateCsrfRequestContext,
} from "@/lib/security/csrf-core";

const sessionCookieName = "novalure_session";

type SessionSource = "cookie" | "headers" | "database" | "demo";

function envValue(name: string) {
  const value = process.env[name]?.trim() ?? "";
  return value.replace(/^['"]|['"]$/g, "");
}

function getCsrfSigningSecret() {
  // Domain separation in csrf-core ensures this key is not used as a raw
  // session signature even though it shares the mandatory session secret.
  return envValue("NOVALURE_SESSION_SECRET");
}

export function assertCsrfConfiguration() {
  if (getCsrfSigningSecret().length < 32) {
    throw new Error("NOVALURE_SESSION_SECRET must contain at least 32 characters for CSRF protection");
  }
}

function getCookie(cookieHeader: string | null, name: string) {
  let matchedCookie: string | null = null;
  for (const part of (cookieHeader ?? "").split(";")) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf("=");
    if (separator <= 0 || trimmed.slice(0, separator) !== name) continue;

    try {
      matchedCookie = decodeURIComponent(trimmed.slice(separator + 1));
    } catch {
      return null;
    }
  }

  return matchedCookie;
}

function csrfFailure(status: 403 | 503) {
  return Response.json(
    { error: status === 503 ? "CSRF protection unavailable" : "CSRF validation failed" },
    {
      headers: {
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
      status,
    },
  );
}

async function consumeToken(input: {
  expiresAt: number;
  method: string;
  pathname: string;
  sessionHash: string;
  tokenHash: string;
}) {
  const consumed = await queryOne<{ tokenHash: string }>(
    `
      with expired as (
        delete from csrf_token_consumptions
        where expires_at < now() - interval '1 day'
      ), consumed as (
        insert into csrf_token_consumptions (
          token_hash,
          session_hash,
          request_method,
          request_path,
          expires_at
        )
        values ($1, $2, $3, $4, to_timestamp($5 / 1000.0))
        on conflict (token_hash) do nothing
        returning token_hash as "tokenHash"
      )
      select "tokenHash" from consumed
    `,
    [input.tokenHash, input.sessionHash, input.method, input.pathname, input.expiresAt],
  );

  return Boolean(consumed);
}

export async function enforceCsrfForSession(
  request: Request,
  session: { source: SessionSource },
) {
  if (!isUnsafeCsrfMethod(request.method) || session.source !== "cookie") {
    return { ok: true as const };
  }

  const context = validateCsrfRequestContext(request.headers, getTrustedAppOrigin());
  if (!context.ok) return { ok: false as const, response: csrfFailure(403) };

  const sessionCookie = getCookie(request.headers.get("cookie"), sessionCookieName);
  const token = request.headers.get(csrfHeaderName)?.trim() ?? "";
  const secret = getCsrfSigningSecret();
  if (!sessionCookie || !token || secret.length < 32) {
    return {
      ok: false as const,
      response: csrfFailure(secret.length < 32 ? 503 : 403),
    };
  }

  const pathname = new URL(request.url).pathname;
  try {
    const validation = await validateAndConsumeCsrfToken(
      {
        method: request.method,
        pathname,
        secret,
        sessionCookie,
        token,
      },
      (value) => consumeToken({
        expiresAt: value.expiresAt,
        method: request.method.toUpperCase(),
        pathname,
        sessionHash: value.sessionHash,
        tokenHash: value.tokenHash,
      }),
    );

    return validation.ok
      ? { ok: true as const }
      : { ok: false as const, response: csrfFailure(403) };
  } catch {
    return { ok: false as const, response: csrfFailure(503) };
  }
}

export function issueCsrfToken(request: Request, session: { source: SessionSource }) {
  if (session.source !== "cookie") {
    return { ok: false as const, response: csrfFailure(403) };
  }

  const context = validateCsrfIssuanceContext(request.headers, getTrustedAppOrigin());
  if (!context.ok) return { ok: false as const, response: csrfFailure(403) };

  const sessionCookie = getCookie(request.headers.get("cookie"), sessionCookieName);
  const secret = getCsrfSigningSecret();
  if (!sessionCookie || secret.length < 32) {
    return {
      ok: false as const,
      response: csrfFailure(secret.length < 32 ? 503 : 403),
    };
  }

  const url = new URL(request.url);
  const created = createCsrfToken({
    method: url.searchParams.get("method") ?? "",
    pathname: url.searchParams.get("path") ?? "",
    secret,
    sessionCookie,
  });
  if (!created) return { ok: false as const, response: csrfFailure(403) };

  return { created, ok: true as const };
}
