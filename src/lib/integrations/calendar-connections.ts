import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { executeQuery, hasDatabaseUrl, queryOne } from "@/lib/db/client";
import { isUuid } from "@/lib/db/runtime-repositories";

export type CalendarOAuthProvider = "google" | "microsoft";

export type CalendarConnectionStatus = {
  accountLabel: string | null;
  connected: boolean;
  error: string | null;
  expiresAt: string | Date | null;
  provider: CalendarOAuthProvider;
  scopes: string[];
};

type ProviderConnectionRow = {
  accountLabel: string | null;
  config: unknown;
  error: string | null;
  expiresAt: string | Date | null;
  scopes: string[] | null;
  status: string;
};

type TokenResponse = {
  access_token?: string;
  error?: string;
  error_description?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
};

const providerKeys: Record<CalendarOAuthProvider, string> = {
  google: "google-calendar",
  microsoft: "microsoft-calendar",
};

const defaultScopes: Record<CalendarOAuthProvider, string[]> = {
  google: ["openid", "email", "profile", "https://www.googleapis.com/auth/calendar"],
  microsoft: [
    "openid",
    "profile",
    "email",
    "offline_access",
    "https://graph.microsoft.com/User.Read",
    "https://graph.microsoft.com/Calendars.ReadWrite",
  ],
};

function envValue(name: string) {
  return process.env[name]?.trim();
}

function base64UrlEncode(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function getStateSecret() {
  return (
    envValue("OAUTH_STATE_SECRET") ||
    envValue("CRON_SECRET") ||
    envValue("OAUTH_TOKEN_ENCRYPTION_KEY") ||
    "novalure-local-oauth-state"
  );
}

function getTokenEncryptionKey() {
  const secret = envValue("OAUTH_TOKEN_ENCRYPTION_KEY");
  if (!secret) {
    throw new Error("OAUTH_TOKEN_ENCRYPTION_KEY is required for storing calendar tokens");
  }

  return createHash("sha256").update(secret).digest();
}

function encryptToken(value: string | null | undefined) {
  if (!value) return null;

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getTokenEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return ["v1", base64UrlEncode(iv), base64UrlEncode(authTag), base64UrlEncode(encrypted)].join(".");
}

function decryptToken(value: unknown) {
  if (typeof value !== "string" || !value) return null;
  const [version, ivRaw, tagRaw, encryptedRaw] = value.split(".");
  if (version !== "v1" || !ivRaw || !tagRaw || !encryptedRaw) return null;

  const decipher = createDecipheriv("aes-256-gcm", getTokenEncryptionKey(), Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function asConfig(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? { ...(value as Record<string, unknown>) } : {};
}

function getRedirectUri(provider: CalendarOAuthProvider, origin: string) {
  return `${origin.replace(/\/$/, "")}/api/meetings/oauth/${provider}/callback`;
}

function getAppOrigin(requestUrl: string) {
  const origin = new URL(requestUrl).origin;
  return envValue("NEXT_PUBLIC_APP_URL") || origin;
}

function signState(payload: string) {
  return createHmac("sha256", getStateSecret()).update(payload).digest("base64url");
}

export function createOAuthState(input: {
  provider: CalendarOAuthProvider;
  returnTo?: string;
  userId: string;
  workspaceId: string;
}) {
  const payload = base64UrlEncode(
    JSON.stringify({
      provider: input.provider,
      returnTo: input.returnTo || "/",
      userId: input.userId,
      workspaceId: input.workspaceId,
    }),
  );

  return `${payload}.${signState(payload)}`;
}

export function parseOAuthState(value: string | null, expectedProvider: CalendarOAuthProvider) {
  if (!value) return null;
  const [payload, signature] = value.split(".");
  if (!payload || !signature || signState(payload) !== signature) return null;

  try {
    const parsed = JSON.parse(base64UrlDecode(payload)) as {
      provider?: string;
      returnTo?: string;
      userId?: string;
      workspaceId?: string;
    };

    if (parsed.provider !== expectedProvider || !isUuid(parsed.workspaceId) || !parsed.userId) {
      return null;
    }

    return {
      returnTo: parsed.returnTo || "/",
      userId: parsed.userId,
      workspaceId: parsed.workspaceId,
    };
  } catch {
    return null;
  }
}

export function getOAuthAuthorizationUrl(input: {
  provider: CalendarOAuthProvider;
  requestUrl: string;
  state: string;
}) {
  const origin = getAppOrigin(input.requestUrl);
  const redirectUri = getRedirectUri(input.provider, origin);

  if (input.provider === "google") {
    const clientId = envValue("GOOGLE_CLIENT_ID");
    if (!clientId) throw new Error("GOOGLE_CLIENT_ID is not configured");

    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("scope", defaultScopes.google.join(" "));
    url.searchParams.set("state", input.state);
    return url.toString();
  }

  const tenantId = envValue("MICROSOFT_TENANT_ID") || "common";
  const clientId = envValue("MICROSOFT_CLIENT_ID");
  if (!clientId) throw new Error("MICROSOFT_CLIENT_ID is not configured");

  const url = new URL(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", defaultScopes.microsoft.join(" "));
  url.searchParams.set("state", input.state);
  return url.toString();
}

export async function exchangeOAuthCode(input: {
  code: string;
  provider: CalendarOAuthProvider;
  requestUrl: string;
}) {
  const origin = getAppOrigin(input.requestUrl);
  const redirectUri = getRedirectUri(input.provider, origin);

  if (input.provider === "google") {
    const clientId = envValue("GOOGLE_CLIENT_ID");
    const clientSecret = envValue("GOOGLE_CLIENT_SECRET");
    if (!clientId || !clientSecret) throw new Error("Google OAuth credentials are not configured");

    return postToken("https://oauth2.googleapis.com/token", {
      client_id: clientId,
      client_secret: clientSecret,
      code: input.code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    });
  }

  const tenantId = envValue("MICROSOFT_TENANT_ID") || "common";
  const clientId = envValue("MICROSOFT_CLIENT_ID");
  const clientSecret = envValue("MICROSOFT_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("Microsoft OAuth credentials are not configured");

  return postToken(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    client_id: clientId,
    client_secret: clientSecret,
    code: input.code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    scope: defaultScopes.microsoft.join(" "),
  });
}

async function postToken(url: string, body: Record<string, string>) {
  const response = await fetch(url, {
    body: new URLSearchParams(body),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const data = (await response.json().catch(() => ({}))) as TokenResponse;

  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || `Token request failed with ${response.status}`);
  }

  return data;
}

export async function fetchCalendarAccountLabel(provider: CalendarOAuthProvider, accessToken: string) {
  const url =
    provider === "google"
      ? "https://www.googleapis.com/oauth2/v3/userinfo"
      : "https://graph.microsoft.com/v1.0/me";
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = (await response.json().catch(() => ({}))) as {
    displayName?: string;
    email?: string;
    mail?: string;
    name?: string;
    userPrincipalName?: string;
  };

  if (!response.ok) return null;
  return data.email || data.mail || data.userPrincipalName || data.name || data.displayName || null;
}

export async function upsertCalendarOAuthConnection(input: {
  accountLabel: string | null;
  provider: CalendarOAuthProvider;
  token: TokenResponse;
  userId: string;
  workspaceId: string;
}) {
  if (!hasDatabaseUrl() || !isUuid(input.workspaceId)) return null;
  const existing = await getProviderConnection(input.workspaceId, input.provider);
  const existingConfig = asConfig(existing?.config);
  const expiresAt = new Date(Date.now() + Math.max(60, input.token.expires_in ?? 3600) * 1000);
  const refreshToken = input.token.refresh_token
    ? encryptToken(input.token.refresh_token)
    : existingConfig.refreshToken;
  const config = {
    accessToken: encryptToken(input.token.access_token),
    calendarId: "primary",
    refreshToken,
    tokenType: input.token.token_type || "Bearer",
  };
  const scopes = input.token.scope?.split(/\s+/).filter(Boolean) ?? defaultScopes[input.provider];

  await executeQuery(
    `
      insert into provider_connections (
        workspace_id,
        provider,
        status,
        account_label,
        scopes,
        config,
        expires_at,
        refreshed_at,
        error
      )
      values ($1, $2, 'connected', $3, $4, $5::jsonb, $6, now(), null)
      on conflict (workspace_id, provider)
      do update set
        status = 'connected',
        account_label = excluded.account_label,
        scopes = excluded.scopes,
        config = excluded.config,
        expires_at = excluded.expires_at,
        refreshed_at = now(),
        error = null,
        updated_at = now()
    `,
    [
      input.workspaceId,
      providerKeys[input.provider],
      input.accountLabel,
      scopes,
      JSON.stringify(config),
      expiresAt.toISOString(),
    ],
  );

  return {
    accountLabel: input.accountLabel,
    connected: true,
    error: null,
    expiresAt,
    provider: input.provider,
    scopes,
  } satisfies CalendarConnectionStatus;
}

async function getProviderConnection(workspaceId: string, provider: CalendarOAuthProvider) {
  if (!hasDatabaseUrl() || !isUuid(workspaceId)) return null;

  return queryOne<ProviderConnectionRow>(
    `
      select
        account_label as "accountLabel",
        scopes,
        config,
        status,
        expires_at as "expiresAt",
        error
      from provider_connections
      where workspace_id = $1 and provider = $2
      limit 1
    `,
    [workspaceId, providerKeys[provider]],
  );
}

export async function getCalendarConnectionStatus(
  workspaceId: string,
  provider: CalendarOAuthProvider,
): Promise<CalendarConnectionStatus> {
  const row = await getProviderConnection(workspaceId, provider);

  return {
    accountLabel: row?.accountLabel ?? null,
    connected: row?.status === "connected",
    error: row?.error ?? null,
    expiresAt: row?.expiresAt ?? null,
    provider,
    scopes: row?.scopes ?? [],
  };
}

export async function disconnectCalendarOAuthConnection(input: {
  provider: CalendarOAuthProvider;
  workspaceId: string;
}) {
  if (!hasDatabaseUrl() || !isUuid(input.workspaceId)) {
    return { ok: false, reason: "database_unavailable" };
  }

  await executeQuery(
    `
      update provider_connections
      set status = 'disconnected',
          config = '{}'::jsonb,
          scopes = '{}'::text[],
          expires_at = null,
          refreshed_at = null,
          error = null,
          updated_at = now()
      where workspace_id = $1 and provider = $2
    `,
    [input.workspaceId, providerKeys[input.provider]],
  );

  return { ok: true, reason: null };
}

export async function getCalendarAccessToken(input: {
  provider: CalendarOAuthProvider;
  workspaceId: string;
}) {
  const row = await getProviderConnection(input.workspaceId, input.provider);
  if (!row || row.status !== "connected") return null;

  const config = asConfig(row.config);
  const expiresAt = row.expiresAt ? new Date(row.expiresAt).getTime() : 0;
  const accessToken = decryptToken(config.accessToken);

  if (accessToken && expiresAt > Date.now() + 5 * 60_000) {
    return accessToken;
  }

  const refreshed = await refreshCalendarAccessToken({
    config,
    provider: input.provider,
    workspaceId: input.workspaceId,
  });

  return refreshed.accessToken;
}

async function refreshCalendarAccessToken(input: {
  config: Record<string, unknown>;
  provider: CalendarOAuthProvider;
  workspaceId: string;
}) {
  const refreshToken = decryptToken(input.config.refreshToken);
  if (!refreshToken) throw new Error(`${input.provider} refresh token is missing`);

  const token =
    input.provider === "google"
      ? await refreshGoogleToken(refreshToken)
      : await refreshMicrosoftToken(refreshToken);
  const expiresAt = new Date(Date.now() + Math.max(60, token.expires_in ?? 3600) * 1000);
  const nextConfig = {
    ...input.config,
    accessToken: encryptToken(token.access_token),
    refreshToken: token.refresh_token ? encryptToken(token.refresh_token) : input.config.refreshToken,
    tokenType: token.token_type || input.config.tokenType || "Bearer",
  };

  await executeQuery(
    `
      update provider_connections
      set config = $3::jsonb,
          expires_at = $4,
          refreshed_at = now(),
          error = null,
          updated_at = now()
      where workspace_id = $1 and provider = $2
    `,
    [input.workspaceId, providerKeys[input.provider], JSON.stringify(nextConfig), expiresAt.toISOString()],
  );

  return { accessToken: token.access_token as string, expiresAt };
}

async function refreshGoogleToken(refreshToken: string) {
  const clientId = envValue("GOOGLE_CLIENT_ID");
  const clientSecret = envValue("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("Google OAuth credentials are not configured");

  return postToken("https://oauth2.googleapis.com/token", {
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

async function refreshMicrosoftToken(refreshToken: string) {
  const tenantId = envValue("MICROSOFT_TENANT_ID") || "common";
  const clientId = envValue("MICROSOFT_CLIENT_ID");
  const clientSecret = envValue("MICROSOFT_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("Microsoft OAuth credentials are not configured");

  return postToken(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: defaultScopes.microsoft.join(" "),
  });
}
