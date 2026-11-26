import assert from "node:assert/strict";
import test from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import type { TenantPool, TenantTransaction } from "../src/lib/db/tenant-client";
import { beginCrmMailboxOAuth, consumeCrmMailboxOAuth, finishCrmMailboxOAuth, saveCrmMailboxConnection } from "../src/lib/db/crm-mailbox-repository";
import { createSignedOAuthState, encryptOAuthStateSecret, hashOAuthState } from "../src/lib/integrations/calendar-oauth-state";
import type { MailboxTransport } from "../src/lib/integrations/mailbox-provider";

// Application-level fake database and transport. These tests do not establish
// PostgreSQL/RLS behavior, real cookies, provider semantics or deployment safety.
const workspaceId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const authIdentityId = "33333333-3333-4333-8333-333333333333";
const authSessionId = "44444444-4444-4444-8444-444444444444";
const session = { authenticated: true, workspaceId, userId, authIdentityId, authSessionId, source: "cookie", role: "owner", productRole: "customer_owner", permissions: ["crm:read"] } as AppSession;
const keys = ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET", "MICROSOFT_CLIENT_AUTH_METHOD", "MICROSOFT_MAILBOX_CLIENT_ID", "MICROSOFT_MAILBOX_CLIENT_SECRET", "MICROSOFT_MAILBOX_CLIENT_AUTH_METHOD", "MICROSOFT_MAILBOX_IDENTITY_MODE", "MICROSOFT_MAILBOX_ALLOW_LEGACY", "MICROSOFT_TENANT_ID", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "OAUTH_STATE_SECRET", "OAUTH_TOKEN_ENCRYPTION_KEY", "NOVALURE_APP_ORIGIN", "VERCEL", "VERCEL_ENV"] as const;
const config = { MICROSOFT_MAILBOX_CLIENT_ID: "synthetic-client", MICROSOFT_MAILBOX_CLIENT_AUTH_METHOD: "vercel-oidc", MICROSOFT_MAILBOX_IDENTITY_MODE: "verified-preview", OAUTH_STATE_SECRET: "synthetic-oauth-state-secret-32-characters", OAUTH_TOKEN_ENCRYPTION_KEY: "synthetic-token-key", NOVALURE_APP_ORIGIN: "https://synthetic.example.invalid", VERCEL: "1", VERCEL_ENV: "preview" };

async function withEnv(values: Record<string, string>, fn: () => Promise<void>) {
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, values);
    await fn();
  } finally {
    for (const key of keys) { const value = previous.get(key); if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

function fakeStateStore() {
  const records = new Map<string, { nonce: string; workspace: string; user: string; provider: string; verifier: string; consumed: boolean; expiresAt?: number }>();
  let statements = 0;
  let expireAfterLock = false;
  let databaseTime: number | undefined;
  const calls: string[] = [];
  const run = async (sql: string, params: readonly unknown[] = []): Promise<Record<string, unknown>[]> => {
    statements++;
    calls.push(sql);
    if (sql.includes("information_schema.columns")) return [{ ready: true }];
    if (sql.startsWith("delete from crm_mailbox_oauth_states")) return [];
    if (sql.startsWith("insert into crm_mailbox_oauth_states")) {
      records.set(String(params[0]), { workspace: String(params[1]), user: String(params[2]), provider: String(params[3]), nonce: String(params[4]), verifier: String(params[5]), consumed: false, expiresAt: Number(params[6]) });
      return [];
    }
    if (sql.startsWith("select state_hash as \"stateHash\" from crm_mailbox_oauth_states")) {
      const row = records.get(String(params[0]));
      if (!row || row.consumed || row.nonce !== params[1] || row.workspace !== params[2] || row.user !== params[3] || row.provider !== params[4]) return [];
      return [{ stateHash: String(params[0]) }];
    }
    if (sql.startsWith("update crm_mailbox_oauth_states")) {
      const row = records.get(String(params[0]));
      if (!row || row.consumed || row.nonce !== params[1] || row.workspace !== params[2] || row.user !== params[3] || row.provider !== params[4]) return [];
      if (expireAfterLock && sql.includes("expires_at>clock_timestamp()")) return [];
      if (databaseTime !== undefined && sql.includes("expires_at>clock_timestamp()")) {
        if ((row.expiresAt ?? -Infinity) <= databaseTime) return [];
        if (sql.includes("to_timestamp($6::double precision)>clock_timestamp()") && Number(params[5]) <= databaseTime) return [];
      }
      row.consumed = true;
      return [{ verifier: row.verifier }];
    }
    throw new Error("Unexpected synthetic query");
  };
  const tx = { query: run, async queryOne(sql: string, params?: readonly unknown[]) { return (await run(sql, params))[0] ?? null; }, async execute() { throw new Error("Unexpected execute"); } } as unknown as TenantTransaction;
  return { tx, records, run, calls, expireAfterLock() { expireAfterLock = true; }, setDatabaseTime(seconds: number) { databaseTime = seconds; }, get statements() { return statements; } };
}

function fakePool(store: ReturnType<typeof fakeStateStore>, isActive: () => boolean): TenantPool {
  return { async connect() { return {
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes("as safe from pg_roles")) return { rows: [{ safe: true }] };
      if (sql.includes("set_config('app.tenant_id'")) return { rows: [{ workspaceId: params[0], actorId: params[1] }] };
      if (sql.includes("crm_lock_active_member")) return { rows: [{ role: "owner", productRole: "customer_owner", operatingModel: "self_service_customer", authIdentityId }] };
      if (sql.includes("crm_lock_active_session")) return { rows: [{ active: isActive() }] };
      if (["begin", "commit", "rollback"].includes(sql.toLowerCase())) return { rows: [] };
      return { rows: await store.run(sql, params) };
    }, release() {},
  } as never; } };
}

async function started(store: ReturnType<typeof fakeStateStore>, actor: AppSession = session, provider: "google" | "microsoft" = "microsoft") {
  const result = await beginCrmMailboxOAuth(store.tx, actor, provider, config.NOVALURE_APP_ORIGIN);
  const state = new URL(result.authorizationUrl).searchParams.get("state");
  assert.ok(state);
  return state;
}

test("verified Microsoft OAuth requires a personal cookie session before writes", async () => withEnv(config, async () => {
  for (const bad of [
    { ...session, source: "headers" }, { ...session, source: "database" }, { ...session, source: "demo" },
    { ...session, authenticated: false }, { ...session, authSessionId: undefined },
    { ...session, authIdentityId: undefined }, { ...session, authSessionId: "not-a-uuid" },
  ] as AppSession[]) {
    const store = fakeStateStore();
    await assert.rejects(started(store, bad), /Persönliche CRM-Anmeldung/);
    assert.equal(store.statements, 0);
  }
}));

test("verified state is scoped to one cookie session and is single-use", async () => withEnv(config, async () => {
  const store = fakeStateStore(), state = await started(store);
  assert.equal(store.records.size, 1);
  assert.ok(!store.records.has(hashOAuthState(state)), "verified state is not stored as a legacy unbound digest");
  const payload = Buffer.from(state.split(".")[0], "base64url").toString("utf8");
  assert.ok(!payload.includes(authSessionId) && !payload.includes(authIdentityId), "provider-facing state must not expose session identifiers");
  const changed = [
    { ...session, authSessionId: "55555555-5555-4555-8555-555555555555" },
    { ...session, authIdentityId: "66666666-6666-4666-8666-666666666666" },
    { ...session, workspaceId: "77777777-7777-4777-8777-777777777777" },
    { ...session, userId: "88888888-8888-4888-8888-888888888888" },
  ];
  for (const other of changed) await assert.rejects(consumeCrmMailboxOAuth(store.tx, other, "microsoft", state));
  const consumed = await consumeCrmMailboxOAuth(store.tx, session, "microsoft", state);
  assert.ok(consumed.codeVerifier && consumed.verifiedNonce);
  await assert.rejects(consumeCrmMailboxOAuth(store.tx, session, "microsoft", state), /bereits verwendet/);
}));

test("an old unbound verified-preview state cannot be consumed by the new code", async () => withEnv(config, async () => {
  const store = fakeStateStore();
  const old = createSignedOAuthState({ provider: "microsoft", workspaceId, userId, returnTo: "/?mailbox=connected&verified_identity=v1" });
  const legacyHash = hashOAuthState(old.state);
  store.records.set(legacyHash, { workspace: workspaceId, user: userId, provider: "microsoft", nonce: hashOAuthState(old.nonce), verifier: encryptOAuthStateSecret(old.codeVerifier), consumed: false });
  await assert.rejects(consumeCrmMailboxOAuth(store.tx, session, "microsoft", old.state), /bereits verwendet/);
  assert.equal(store.records.get(legacyHash)?.consumed, false);
  const current = await started(store);
  assert.ok((await consumeCrmMailboxOAuth(store.tx, session, "microsoft", current)).codeVerifier);
}));

test("verified state checks expiry after acquiring its lock and fails closed on a simulated expiration", async () => withEnv(config, async () => {
  const store = fakeStateStore(), state = await started(store);
  store.expireAfterLock();
  let providerCalls = 0, assertionCalls = 0;
  const transport: MailboxTransport = async () => { providerCalls++; throw new Error("Unexpected provider call"); };
  const auth = async () => { assertionCalls++; throw new Error("Unexpected assertion request"); };
  await assert.rejects(finishCrmMailboxOAuth(session, "microsoft", state, "synthetic-code", config.NOVALURE_APP_ORIGIN, { pool: fakePool(store, () => true) }, transport, auth), /abgelaufen oder bereits verwendet/);
  const lock = store.calls.findIndex(sql => sql.startsWith("select state_hash as \"stateHash\""));
  const update = store.calls.findIndex(sql => sql.startsWith("update crm_mailbox_oauth_states"));
  assert.ok(lock >= 0 && update > lock, "the expiry check follows the locking statement");
  assert.match(store.calls[lock], /consumed_at is null for update$/);
  assert.match(store.calls[update], /consumed_at=clock_timestamp\(\).*expires_at>clock_timestamp\(\)/);
  assert.equal([...store.records.values()][0]?.consumed, false);
  assert.equal(providerCalls, 0);
  assert.equal(assertionCalls, 0);
}));

test("signed state expiry cannot be extended by a later database expiry", async () => withEnv(config, async () => {
  const store = fakeStateStore(), state = await started(store);
  const payload = JSON.parse(Buffer.from(state.split(".")[0], "base64url").toString("utf8")) as { exp: number };
  const [row] = store.records.values();
  assert.ok(row && Number.isSafeInteger(payload.exp));
  // Model a wait until the signed expiry and a database row whose expiry has
  // independently moved later. The database clock is a synthetic fake here.
  row.expiresAt = payload.exp + 3600;
  store.setDatabaseTime(payload.exp);
  await assert.rejects(consumeCrmMailboxOAuth(store.tx, session, "microsoft", state), /abgelaufen oder bereits verwendet/);
  assert.equal(row.consumed, false);
  assert.match(store.calls.at(-1) ?? "", /to_timestamp\(\$6::double precision\)>clock_timestamp\(\)/);
}));

test("session switch, revoked session, and expired state cannot reach Microsoft", async () => withEnv(config, async () => {
  const store = fakeStateStore(), state = await started(store);
  let active = true, providerCalls = 0, assertionCalls = 0;
  const pool = fakePool(store, () => active);
  const transport: MailboxTransport = async () => { providerCalls++; throw new Error("Unexpected provider call"); };
  const auth = async () => { assertionCalls++; throw new Error("Unexpected assertion request"); };
  const finish = (actor: AppSession, value: string) => finishCrmMailboxOAuth(actor, "microsoft", value, "synthetic-code", config.NOVALURE_APP_ORIGIN, { pool }, transport, auth);
  await assert.rejects(finish({ ...session, authSessionId: "55555555-5555-4555-8555-555555555555" }, state));
  for (const source of ["headers", "database", "demo"] as const) {
    await assert.rejects(finish({ ...session, source, authIdentityId: undefined, authSessionId: undefined }, state));
  }
  active = false;
  await assert.rejects(finish(session, state), /Session is expired or revoked/);
  active = true;
  const expired = createSignedOAuthState({ provider: "microsoft", workspaceId, userId, returnTo: "/?mailbox=connected&verified_identity=v1", nowSeconds: 0 });
  await assert.rejects(finish(session, expired.state));
  assert.equal(providerCalls, 0); assert.equal(assertionCalls, 0);
  const consumed = await consumeCrmMailboxOAuth(store.tx, session, "microsoft", state);
  assert.ok(consumed.codeVerifier, "failed attempts must not consume the initiating session's state");
}));

test("revocation during provider I/O prevents saving the verified connection", async () => withEnv(config, async () => {
  const store = fakeStateStore(), state = await started(store);
  let active = true, providerCalls = 0;
  const pool = fakePool(store, () => active);
  const transport: MailboxTransport = async url => {
    providerCalls++;
    if (url.includes("/oauth2/v2.0/token")) return Response.json({ access_token: "synthetic-access", refresh_token: "synthetic-refresh", id_token: "synthetic-id", scope: "Mail.Read User.Read", token_type: "Bearer", expires_in: 3600 });
    if (url === "https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName") { active = false; return Response.json({ id: userId, mail: "synthetic@example.invalid" }); }
    throw new Error("Unexpected provider URL");
  };
  const auth = async () => ({ client_id: "synthetic-client", client_assertion: "synthetic-assertion" });
  const verify = async () => ({ tenantId: workspaceId, objectId: userId, subject: "synthetic-subject" });
  await assert.rejects(finishCrmMailboxOAuth(session, "microsoft", state, "synthetic-code", config.NOVALURE_APP_ORIGIN, { pool }, transport, auth, verify), /Session is expired or revoked/);
  assert.equal(providerCalls, 2, "in-flight provider calls are not represented as cancellable");
}));

test("revocation during token exchange prevents key and mailbox lookups", async () => withEnv(config, async () => {
  const store = fakeStateStore(), state = await started(store);
  let active = true, providerCalls = 0, verifierCalls = 0;
  const pool = fakePool(store, () => active);
  const transport: MailboxTransport = async url => {
    providerCalls++;
    assert.ok(url.includes("/oauth2/v2.0/token"), "no Graph request may follow revoked token exchange");
    active = false;
    return Response.json({ access_token: "synthetic-access", refresh_token: "synthetic-refresh", id_token: "synthetic-id", scope: "Mail.Read User.Read", token_type: "Bearer", expires_in: 3600 });
  };
  const auth = async () => ({ client_id: "synthetic-client", client_assertion: "synthetic-assertion" });
  const verify = async () => { verifierCalls++; return { tenantId: workspaceId, objectId: userId, subject: "synthetic-subject" }; };
  await assert.rejects(finishCrmMailboxOAuth(session, "microsoft", state, "synthetic-code", config.NOVALURE_APP_ORIGIN, { pool }, transport, auth, verify), /Session is expired or revoked/);
  assert.equal(providerCalls, 1);
  assert.equal(verifierCalls, 0, "no signing-key verification is attempted after the observed revocation");
}));

test("revocation during signing-key verification prevents Graph lookup and save", async () => withEnv(config, async () => {
  const store = fakeStateStore(), state = await started(store);
  let active = true, providerCalls = 0, verifierCalls = 0;
  const pool = fakePool(store, () => active);
  const transport: MailboxTransport = async url => {
    providerCalls++;
    assert.ok(url.includes("/oauth2/v2.0/token"), "no Graph request may follow revoked identity verification");
    return Response.json({ access_token: "synthetic-access", refresh_token: "synthetic-refresh", id_token: "synthetic-id", scope: "Mail.Read User.Read", token_type: "Bearer", expires_in: 3600 });
  };
  const auth = async () => ({ client_id: "synthetic-client", client_assertion: "synthetic-assertion" });
  const verify = async () => { verifierCalls++; active = false; return { tenantId: workspaceId, objectId: userId, subject: "synthetic-subject" }; };
  await assert.rejects(finishCrmMailboxOAuth(session, "microsoft", state, "synthetic-code", config.NOVALURE_APP_ORIGIN, { pool }, transport, auth, verify), /Session is expired or revoked/);
  assert.equal(providerCalls, 1);
  assert.equal(verifierCalls, 1);
}));

test("verified connection cannot be saved from a non-personal session", async () => withEnv(config, async () => {
  const store = fakeStateStore();
  await assert.rejects(saveCrmMailboxConnection(store.tx, { ...session, source: "database" }, "microsoft", { accessToken: "synthetic", refreshToken: "synthetic", scopes: ["Mail.Read"], expiresAt: "2030-01-01T00:00:00Z" }, "mailbox@example.invalid", { tenantId: workspaceId, objectId: userId, subject: "synthetic" }), /Persönliche CRM-Anmeldung/);
  assert.equal(store.statements, 0);
}));

test("Google and explicitly enabled shared Microsoft legacy states retain their previous contract", async () => {
  const shared = { MICROSOFT_CLIENT_ID: "synthetic-shared", MICROSOFT_CLIENT_SECRET: "synthetic-secret", MICROSOFT_MAILBOX_ALLOW_LEGACY: "1", GOOGLE_CLIENT_ID: "synthetic-google", GOOGLE_CLIENT_SECRET: "synthetic-google-secret", OAUTH_STATE_SECRET: config.OAUTH_STATE_SECRET, OAUTH_TOKEN_ENCRYPTION_KEY: config.OAUTH_TOKEN_ENCRYPTION_KEY, NOVALURE_APP_ORIGIN: config.NOVALURE_APP_ORIGIN };
  await withEnv(shared, async () => {
    for (const provider of ["google", "microsoft"] as const) {
      const store = fakeStateStore(), databaseSession = { ...session, source: "database" as const, authIdentityId: undefined, authSessionId: undefined };
      const state = await started(store, databaseSession, provider);
      assert.ok(store.records.has(hashOAuthState(state)));
      const consumed = await consumeCrmMailboxOAuth(store.tx, databaseSession, provider, state);
      assert.equal(consumed.verifiedNonce, null);
    }
  });
  for (const legacyMode of [undefined, "0"] as const) {
    const settings: Record<string, string> = { ...shared };
    if (legacyMode === undefined) delete settings.MICROSOFT_MAILBOX_ALLOW_LEGACY;
    else settings.MICROSOFT_MAILBOX_ALLOW_LEGACY = legacyMode;
    await withEnv(settings, async () => {
      const databaseSession = { ...session, source: "database" as const, authIdentityId: undefined, authSessionId: undefined };
      const microsoft = fakeStateStore();
      await assert.rejects(started(microsoft, databaseSession, "microsoft"), /Postfach-OAuth ist noch nicht eingerichtet/);
      assert.equal(microsoft.statements, 0);
      const google = fakeStateStore(), state = await started(google, databaseSession, "google");
      assert.ok(google.records.has(hashOAuthState(state)));
      assert.equal((await consumeCrmMailboxOAuth(google.tx, databaseSession, "google", state)).verifiedNonce, null);
    });
  }
});
