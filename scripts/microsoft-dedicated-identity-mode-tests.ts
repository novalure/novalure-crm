import assert from "node:assert/strict";
import test from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import type { TenantPool, TenantTransaction } from "../src/lib/db/tenant-client";
import { beginCrmMailboxOAuth, consumeCrmMailboxOAuth, saveCrmMailboxConnection, syncCrmMailbox } from "../src/lib/db/crm-mailbox-repository";
import { createSignedOAuthState } from "../src/lib/integrations/calendar-oauth-state";
import { exchangeMailboxToken, mailboxAuthorizationUrl, mailboxOAuthConfigured, verifiedExternalMailboxMode, type MailboxTransport } from "../src/lib/integrations/mailbox-provider";

// These tests use only synthetic identities, a fake pool and fake transport.
// They do not prove actual PostgreSQL RLS, Microsoft or deployment behavior.
const keys = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET", "MICROSOFT_CLIENT_AUTH_METHOD", "MICROSOFT_MAILBOX_CLIENT_ID", "MICROSOFT_MAILBOX_CLIENT_SECRET", "MICROSOFT_MAILBOX_CLIENT_AUTH_METHOD", "MICROSOFT_MAILBOX_IDENTITY_MODE", "MICROSOFT_MAILBOX_ALLOW_LEGACY", "MICROSOFT_TENANT_ID", "OAUTH_STATE_SECRET", "OAUTH_TOKEN_ENCRYPTION_KEY", "NOVALURE_APP_ORIGIN", "VERCEL", "VERCEL_ENV"] as const;
const workspaceId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const connectionId = "33333333-3333-4333-8333-333333333333";
const requestId = "44444444-4444-4444-8444-444444444444";
const session = { authenticated: true, userId, workspaceId, role: "owner", productRole: "customer_owner", permissions: ["crm:read"], source: "database" } as AppSession;
const dedicated = { NODE_ENV: "test" as const, MICROSOFT_MAILBOX_CLIENT_ID: "synthetic-mailbox", MICROSOFT_MAILBOX_CLIENT_AUTH_METHOD: "vercel-oidc", VERCEL: "1", VERCEL_ENV: "preview", OAUTH_STATE_SECRET: "synthetic-state-secret-with-over-32-bytes", OAUTH_TOKEN_ENCRYPTION_KEY: "synthetic-token-key", NOVALURE_APP_ORIGIN: "https://synthetic.example.invalid", MICROSOFT_TENANT_ID: "common" };

async function withEnv(values: Record<string, string | undefined>, run: () => Promise<void> | void) {
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    for (const [key, value] of Object.entries(values)) if (key !== "NODE_ENV" && value !== undefined) process.env[key] = value;
    await run();
  } finally {
    for (const key of keys) { const value = previous.get(key); if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

test("a preview requires verified preview mode; empty and partial settings never fall back", async () => {
  for (const value of [undefined, "", " ", "legacy", "verified-production"]) {
    const env = { ...dedicated, MICROSOFT_MAILBOX_IDENTITY_MODE: value };
    assert.throws(() => verifiedExternalMailboxMode(env), /MAIL_OAUTH_CONFIG/);
    await withEnv(env, () => assert.equal(mailboxOAuthConfigured("microsoft"), false));
  }
  for (const key of ["MICROSOFT_MAILBOX_CLIENT_ID", "MICROSOFT_MAILBOX_CLIENT_AUTH_METHOD", "MICROSOFT_MAILBOX_CLIENT_SECRET"]) {
    assert.throws(() => verifiedExternalMailboxMode({ NODE_ENV: "test", [key]: "" }), /MAIL_OAUTH_CONFIG/);
  }
  assert.throws(() => verifiedExternalMailboxMode({ ...dedicated, VERCEL_ENV: "production", MICROSOFT_MAILBOX_IDENTITY_MODE: "verified-preview" }), /MAIL_OAUTH_CONFIG/);
  assert.equal(verifiedExternalMailboxMode({ ...dedicated, MICROSOFT_MAILBOX_IDENTITY_MODE: "verified-preview" }), true);
  await withEnv({ ...dedicated, MICROSOFT_MAILBOX_IDENTITY_MODE: "verified-preview" }, () => assert.equal(mailboxOAuthConfigured("microsoft"), true));
});

test("legacy shared Microsoft configuration requires an explicit opt-in", async () => {
  const shared = { NODE_ENV: "test" as const, MICROSOFT_CLIENT_ID: "synthetic-shared", MICROSOFT_CLIENT_SECRET: "synthetic-secret", MICROSOFT_MAILBOX_ALLOW_LEGACY: "1", OAUTH_STATE_SECRET: dedicated.OAUTH_STATE_SECRET, OAUTH_TOKEN_ENCRYPTION_KEY: dedicated.OAUTH_TOKEN_ENCRYPTION_KEY, NOVALURE_APP_ORIGIN: dedicated.NOVALURE_APP_ORIGIN };
  assert.equal(verifiedExternalMailboxMode(shared), false);
  await withEnv(shared, () => {
    assert.equal(mailboxOAuthConfigured("microsoft"), true);
    const url = new URL(mailboxAuthorizationUrl({ provider: "microsoft", requestUrl: dedicated.NOVALURE_APP_ORIGIN, state: "synthetic", codeChallenge: "synthetic" }));
    assert.equal(url.searchParams.get("client_id"), "synthetic-shared");
    assert.equal(url.searchParams.has("nonce"), false);
  });
});

test("lost or contradictory settings cannot silently enable legacy Microsoft OAuth", async () => {
  const shared = { NODE_ENV: "test" as const, MICROSOFT_CLIENT_ID: "synthetic-shared", MICROSOFT_CLIENT_SECRET: "synthetic-secret", OAUTH_STATE_SECRET: dedicated.OAUTH_STATE_SECRET, OAUTH_TOKEN_ENCRYPTION_KEY: dedicated.OAUTH_TOKEN_ENCRYPTION_KEY, NOVALURE_APP_ORIGIN: dedicated.NOVALURE_APP_ORIGIN };
  for (const legacy of [undefined, "", "0", "true", " 1 ", "unexpected"]) {
    const env = { ...shared, MICROSOFT_MAILBOX_ALLOW_LEGACY: legacy };
    assert.throws(() => verifiedExternalMailboxMode(env), /MAIL_OAUTH_CONFIG/);
    await withEnv(env, async () => {
      assert.equal(mailboxOAuthConfigured("microsoft"), false);
      assert.throws(() => mailboxAuthorizationUrl({ provider: "microsoft", requestUrl: dedicated.NOVALURE_APP_ORIGIN, state: "synthetic", codeChallenge: "synthetic" }), /MAIL_OAUTH_NOT_CONFIGURED/);
      let assertions = 0, providerCalls = 0;
      const auth = async () => { assertions++; return { client_id: "synthetic" }; };
      const transport: MailboxTransport = async () => { providerCalls++; throw new Error("unexpected provider call"); };
      await assert.rejects(exchangeMailboxToken({ provider: "microsoft", refreshToken: "synthetic" }, transport, auth), /MAIL_OAUTH_CONFIG/);
      assert.equal(assertions, 0); assert.equal(providerCalls, 0);
    });
  }
  for (const env of [
    { ...dedicated, MICROSOFT_MAILBOX_ALLOW_LEGACY: "1" },
    { ...dedicated, MICROSOFT_MAILBOX_ALLOW_LEGACY: "1", MICROSOFT_MAILBOX_IDENTITY_MODE: "verified-preview" },
    { ...shared, MICROSOFT_MAILBOX_ALLOW_LEGACY: "1", MICROSOFT_MAILBOX_IDENTITY_MODE: "verified-preview", VERCEL_ENV: "preview" },
    { ...dedicated, MICROSOFT_MAILBOX_ALLOW_LEGACY: "invalid", MICROSOFT_MAILBOX_IDENTITY_MODE: "verified-preview" },
    { ...shared, VERCEL: "1", VERCEL_ENV: "preview", MICROSOFT_MAILBOX_IDENTITY_MODE: "verified-preview" },
    { ...shared, VERCEL: "1", VERCEL_ENV: "preview", MICROSOFT_MAILBOX_IDENTITY_MODE: "verified-preview", MICROSOFT_MAILBOX_CLIENT_ID: "synthetic-mailbox" },
    { ...dedicated, MICROSOFT_CLIENT_ID: "SYNTHETIC-MAILBOX", MICROSOFT_MAILBOX_IDENTITY_MODE: "verified-preview" },
    { ...dedicated, VERCEL: "0", MICROSOFT_MAILBOX_CLIENT_AUTH_METHOD: "client-secret", MICROSOFT_MAILBOX_CLIENT_SECRET: "synthetic-secret", MICROSOFT_MAILBOX_IDENTITY_MODE: "verified-preview" },
  ]) {
    assert.throws(() => verifiedExternalMailboxMode(env), /MAIL_OAUTH_CONFIG/);
    await withEnv(env, () => assert.equal(mailboxOAuthConfigured("microsoft"), false));
  }
  assert.equal(verifiedExternalMailboxMode({ ...dedicated, MICROSOFT_MAILBOX_ALLOW_LEGACY: "0", MICROSOFT_MAILBOX_IDENTITY_MODE: "verified-preview" }), true);
});

test("a misconfigured dedicated app cannot start, consume or save a mailbox connection", async () => {
  await withEnv(dedicated, async () => {
    let queries = 0;
    const tx = { query: async () => { queries++; throw new Error("unexpected query"); }, queryOne: async () => { queries++; throw new Error("unexpected query"); }, execute: async () => { queries++; throw new Error("unexpected query"); } } as unknown as TenantTransaction;
    await assert.rejects(beginCrmMailboxOAuth(tx, session, "microsoft", dedicated.NOVALURE_APP_ORIGIN), /Postfach-OAuth ist noch nicht eingerichtet/);
    const state = createSignedOAuthState({ provider: "microsoft", workspaceId, userId, returnTo: "/?mailbox=connected" });
    await assert.rejects(consumeCrmMailboxOAuth(tx, session, "microsoft", state.state), /MAIL_OAUTH_CONFIG/);
    await assert.rejects(saveCrmMailboxConnection(tx, session, "microsoft", { accessToken: "synthetic", refreshToken: null, scopes: ["Mail.Read"], expiresAt: "2026-11-25T12:00:00Z" }, "mailbox@example.invalid"), /MAIL_OAUTH_CONFIG/);
    assert.equal(queries, 0);
  });
});

test("configuration loss blocks Microsoft start, callback and save before database writes", async () => {
  const env = { MICROSOFT_CLIENT_ID: "synthetic-shared", MICROSOFT_CLIENT_SECRET: "synthetic-secret", OAUTH_STATE_SECRET: dedicated.OAUTH_STATE_SECRET, OAUTH_TOKEN_ENCRYPTION_KEY: dedicated.OAUTH_TOKEN_ENCRYPTION_KEY, NOVALURE_APP_ORIGIN: dedicated.NOVALURE_APP_ORIGIN };
  await withEnv(env, async () => {
    let queries = 0;
    const tx = { query: async () => { queries++; throw new Error("unexpected query"); }, queryOne: async () => { queries++; throw new Error("unexpected query"); }, execute: async () => { queries++; throw new Error("unexpected query"); } } as unknown as TenantTransaction;
    const state = createSignedOAuthState({ provider: "microsoft", workspaceId, userId, returnTo: "/?mailbox=connected" });
    await assert.rejects(beginCrmMailboxOAuth(tx, session, "microsoft", dedicated.NOVALURE_APP_ORIGIN), /Postfach-OAuth ist noch nicht eingerichtet/);
    await assert.rejects(consumeCrmMailboxOAuth(tx, session, "microsoft", state.state), /MAIL_OAUTH_CONFIG/);
    await assert.rejects(saveCrmMailboxConnection(tx, session, "microsoft", { accessToken: "synthetic", refreshToken: null, scopes: ["Mail.Read"], expiresAt: "2026-11-25T12:00:00Z" }, "mailbox@example.invalid"), /MAIL_OAUTH_CONFIG/);
    assert.equal(queries, 0);
  });
});

test("a Microsoft legacy restriction or conflicting configuration does not alter Google authorization", async () => {
  const google = { GOOGLE_CLIENT_ID: "synthetic-google", GOOGLE_CLIENT_SECRET: "synthetic-google-secret", OAUTH_STATE_SECRET: dedicated.OAUTH_STATE_SECRET, OAUTH_TOKEN_ENCRYPTION_KEY: dedicated.OAUTH_TOKEN_ENCRYPTION_KEY, NOVALURE_APP_ORIGIN: dedicated.NOVALURE_APP_ORIGIN };
  for (const microsoft of [{}, { ...dedicated, MICROSOFT_MAILBOX_ALLOW_LEGACY: "1", MICROSOFT_MAILBOX_IDENTITY_MODE: "verified-preview" }]) await withEnv({ ...microsoft, ...google }, () => {
    assert.equal(mailboxOAuthConfigured("google"), true);
    const url = new URL(mailboxAuthorizationUrl({ provider: "google", requestUrl: dedicated.NOVALURE_APP_ORIGIN, state: "synthetic", codeChallenge: "synthetic" }));
    assert.equal(url.hostname, "accounts.google.com");
    assert.match(url.searchParams.get("scope") || "", /gmail\.readonly/);
  });
});

test("verified authorization requires a nonce and verified exchanges bind their authority before any I/O", async () => {
  await withEnv({ ...dedicated, MICROSOFT_MAILBOX_IDENTITY_MODE: "verified-preview" }, async () => {
    const input = { provider: "microsoft" as const, requestUrl: dedicated.NOVALURE_APP_ORIGIN, state: "synthetic", codeChallenge: "synthetic" };
    assert.throws(() => mailboxAuthorizationUrl(input), /MAIL_OAUTH_CONFIG/);
    assert.throws(() => mailboxAuthorizationUrl({ ...input, verifiedExternalNonce: "short" }), /MAIL_OAUTH_CONFIG/);
    const authUrl = new URL(mailboxAuthorizationUrl({ ...input, verifiedExternalNonce: "n".repeat(43) }));
    assert.equal(authUrl.searchParams.get("nonce"), "n".repeat(43));
    let assertions = 0, providerCalls = 0;
    const auth = async () => { assertions++; return { client_id: "synthetic" }; };
    const transport: MailboxTransport = async url => {
      providerCalls++;
      assert.equal(url, "https://login.microsoftonline.com/55555555-5555-4555-8555-555555555555/oauth2/v2.0/token");
      return Response.json({ access_token: "synthetic", expires_in: 3600, scope: "Mail.Read User.Read", token_type: "Bearer" });
    };
    await assert.rejects(exchangeMailboxToken({ provider: "microsoft", refreshToken: "synthetic" }, transport, auth), /MAIL_OAUTH_CONFIG/);
    await assert.rejects(exchangeMailboxToken({ provider: "microsoft", refreshToken: "synthetic", verifiedMicrosoftAuthority: "not-a-tenant" }, transport, auth), /MAIL_OAUTH_CONFIG/);
    await assert.rejects(exchangeMailboxToken({ provider: "microsoft", refreshToken: "synthetic", verifiedMicrosoftAuthority: "common" }, transport, auth), /MAIL_OAUTH_CONFIG/);
    assert.equal(assertions, 0); assert.equal(providerCalls, 0);
    await exchangeMailboxToken({ provider: "microsoft", refreshToken: "synthetic", verifiedMicrosoftAuthority: "55555555-5555-4555-8555-555555555555" }, transport, auth);
    assert.equal(assertions, 1); assert.equal(providerCalls, 1);
  });
});

test("a pre-existing legacy connection is left untouched by missing or verified configuration", async () => {
  for (const [env, expected] of [[dedicated, /MAIL_OAUTH_CONFIG/], [{ MICROSOFT_CLIENT_ID: "synthetic-shared", MICROSOFT_CLIENT_SECRET: "synthetic-secret" }, /MAIL_OAUTH_CONFIG/], [{ ...dedicated, MICROSOFT_MAILBOX_IDENTITY_MODE: "verified-preview" }, /Postfachidentität muss erneut sicher verbunden werden/]] as const) await withEnv(env, async () => {
    const statements: string[] = []; let providerCalls = 0;
    const client = {
      async query(sql: string, params: unknown[] = []) {
        statements.push(sql);
        if (sql.includes("as safe from pg_roles")) return { rows: [{ safe: true }] };
        if (sql.includes("set_config('app.tenant_id'")) return { rows: [{ workspaceId: params[0], actorId: params[1] }] };
        if (sql.includes("crm_lock_active_member")) return { rows: [{ role: "owner", productRole: "customer_owner", operatingModel: "self_service_customer", authIdentityId: null }] };
        if (sql.includes("from crm_mailbox_connections") && sql.includes("for update")) return { rows: [{ id: connectionId, provider: "microsoft", accountLabel: "old@example.invalid", status: "connected", scopes: ["Mail.Read"], tenantId: null, subject: null, accountId: "synthetic", revision: 1 }] };
        if (sql === "begin" || sql === "rollback") return { rows: [] };
        throw new Error("unexpected query");
      }, release() {},
    };
    const pool = { connect: async () => client } as unknown as TenantPool;
    const transport: MailboxTransport = async () => { providerCalls++; throw new Error("unexpected provider call"); };
    await assert.rejects(syncCrmMailbox(session, { connectionId, requestId, mode: "latest" }, { pool }, transport), expected);
    assert.equal(providerCalls, 0);
    assert.ok(statements.includes("rollback"));
    assert.ok(!statements.some(sql => /\b(update|insert|delete)\s+(?:into\s+|from\s+)?crm_mailbox/i.test(sql)));
  });
});
