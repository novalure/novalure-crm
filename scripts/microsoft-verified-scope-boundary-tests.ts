import assert from "node:assert/strict";
import test from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import type { TenantPool, TenantTransaction } from "../src/lib/db/tenant-client";
import { hasVerifiedMicrosoftMailboxScopes } from "../src/lib/crm-mailbox";
import { saveCrmMailboxConnection, syncCrmMailbox } from "../src/lib/db/crm-mailbox-repository";
import { runPersonalMailboxSync } from "../src/lib/db/crm-mailbox-sync-repository";
import { exchangeMailboxToken, type MailboxTransport } from "../src/lib/integrations/mailbox-provider";

// Purely synthetic provider responses; no network, mailbox or database access.
const keys = ["MICROSOFT_MAILBOX_CLIENT_ID", "MICROSOFT_MAILBOX_CLIENT_AUTH_METHOD", "MICROSOFT_MAILBOX_CLIENT_SECRET", "MICROSOFT_MAILBOX_IDENTITY_MODE", "MICROSOFT_MAILBOX_ALLOW_LEGACY", "MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET", "NOVALURE_APP_ORIGIN", "VERCEL", "VERCEL_ENV"] as const;
const tenant = "55555555-5555-4555-8555-555555555555";
const auth = async () => ({ client_id: "synthetic-client" });
async function withEnvironment(config: Record<string, string>, work: () => Promise<void>) {
  const saved = new Map(keys.map(key => [key, process.env[key]]));
  try { for (const key of keys) delete process.env[key]; Object.assign(process.env, config); await work(); }
  finally { for (const key of keys) { const value = saved.get(key); if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}
const verifiedConfig = { MICROSOFT_MAILBOX_CLIENT_ID: "synthetic-mail", MICROSOFT_MAILBOX_CLIENT_AUTH_METHOD: "client-secret", MICROSOFT_MAILBOX_CLIENT_SECRET: "synthetic-secret", MICROSOFT_MAILBOX_IDENTITY_MODE: "verified-preview", NOVALURE_APP_ORIGIN: "https://synthetic.example.invalid", VERCEL: "1", VERCEL_ENV: "preview" };
function transport(scope: unknown): MailboxTransport {
  return async () => Response.json({ access_token: "synthetic-token", id_token: "synthetic-id", expires_in: 3600, token_type: "Bearer", ...(scope === undefined ? {} : { scope }) });
}

test("verified scopes accept only bounded read-only Microsoft and OpenID permissions", () => {
  for (const scopes of [["Mail.Read"], ["https://graph.microsoft.com/Mail.Read", "User.Read", "openid", "profile", "email", "offline_access"], ["MAIL.READ", "HTTPS://GRAPH.MICROSOFT.COM/USER.READ"]]) assert.equal(hasVerifiedMicrosoftMailboxScopes(scopes), true);
  for (const scopes of [[], ["User.Read"], ["Mail.ReadWrite"], ["Mail.Read", "Mail.Send"], ["Mail.Read", "Calendars.Read"], ["Mail.Read", "https://attacker.invalid/user.read"], ["Mail.Read", "mail.read extra"], ["Mail.Read", "a".repeat(257)], Array(33).fill("Mail.Read"), ["Mail.Read", null] as unknown as string[]]) assert.equal(hasVerifiedMicrosoftMailboxScopes(scopes), false);
});

test("verified code and refresh exchanges reject extra permissions, including from prior scopes", async () => {
  await withEnvironment(verifiedConfig, async () => {
    for (const scope of ["Mail.Read Mail.Send", "Mail.ReadWrite", "Mail.Read Calendars.Read", "User.Read"]) {
      await assert.rejects(exchangeMailboxToken({ provider: "microsoft", refreshToken: "synthetic-refresh", verifiedMicrosoftAuthority: tenant }, transport(scope), auth), /MAIL_SCOPE_REQUIRED/);
      await assert.rejects(exchangeMailboxToken({ provider: "microsoft", code: "synthetic-code", codeVerifier: "synthetic-verifier", requestUrl: verifiedConfig.NOVALURE_APP_ORIGIN, verifiedMicrosoftAuthority: "common" }, transport(scope), auth), /MAIL_SCOPE_REQUIRED/);
    }
    const accepted = await exchangeMailboxToken({ provider: "microsoft", refreshToken: "synthetic-refresh", verifiedMicrosoftAuthority: tenant }, transport("openid profile email offline_access User.Read Mail.Read"), auth);
    assert.ok(accepted.scopes.includes("Mail.Read"));
    await assert.rejects(exchangeMailboxToken({ provider: "microsoft", refreshToken: "synthetic-refresh", priorScopes: ["Mail.Read", "Mail.Send"], verifiedMicrosoftAuthority: tenant }, transport(undefined), auth), /MAIL_SCOPE_REQUIRED/);
    const carried = await exchangeMailboxToken({ provider: "microsoft", refreshToken: "synthetic-refresh", priorScopes: ["Mail.Read", "User.Read"], verifiedMicrosoftAuthority: tenant }, transport(undefined), auth);
    assert.deepEqual(carried.scopes, ["Mail.Read", "User.Read"]);
  });
});

test("verified save rejects excessive permissions before any database query", async () => {
  await withEnvironment(verifiedConfig, async () => {
    let calls = 0;
    const tx = { queryOne: async () => { calls++; throw new Error("unexpected query"); } } as unknown as TenantTransaction;
    const session = { authenticated: true, workspaceId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222", role: "owner", productRole: "customer_owner", source: "database" } as AppSession;
    const identity = { tenantId: tenant, subject: "synthetic-subject", objectId: "33333333-3333-4333-8333-333333333333" };
    await assert.rejects(saveCrmMailboxConnection(tx, session, "microsoft", { accessToken: "synthetic", refreshToken: null, scopes: ["Mail.Read", "Mail.Send"], expiresAt: "2099-01-01T00:00:00Z" }, "qa@example.invalid", identity), /Nur Postfach-Lesezugriff/);
    assert.equal(calls, 0);
  });
});

test("manual and automatic verified sync reject excessive stored scopes before provider I/O", async () => {
  await withEnvironment(verifiedConfig, async () => {
    const queries: string[] = []; let providerCalls = 0;
    const connectionId = "33333333-3333-4333-8333-333333333333";
    const userId = "22222222-2222-4222-8222-222222222222";
    const client = {
      async query(sql: string, params: unknown[] = []) {
        queries.push(sql);
        if (sql.includes("as safe from pg_roles")) return { rows: [{ safe: true }] };
        if (sql.includes("set_config('app.tenant_id'")) return { rows: [{ workspaceId: params[0], actorId: params[1] }] };
        if (sql.includes("crm_lock_active_member")) return { rows: [{ role: "owner", productRole: "customer_owner", operatingModel: "self_service_customer", authIdentityId: null }] };
        if (sql.includes("to_regclass('public.crm_mailbox_auto_settings')")) return { rows: [{ ready: true }] };
        if (sql.includes("from crm_mailbox_connections") && sql.includes("for update")) return { rows: [{ id: connectionId, provider: "microsoft", accountLabel: "qa@example.invalid", label: "qa@example.invalid", status: "connected", scopes: ["Mail.Read", "Mail.Send"], tenantId: tenant, subject: "synthetic-subject", accountId: "synthetic-id", revision: 1, enabled: true, due: true, busy: false, identityId: null }] };
        if (sql === "begin" || sql === "rollback") return { rows: [] };
        throw new Error("unexpected query");
      }, release() {},
    };
    const pool = { connect: async () => client } as unknown as TenantPool;
    const session = { authenticated: true, workspaceId: "11111111-1111-4111-8111-111111111111", userId, role: "owner", productRole: "customer_owner", permissions: ["crm:read"], source: "database" } as AppSession;
    const provider: MailboxTransport = async () => { providerCalls++; throw new Error("unexpected provider call"); };
    await assert.rejects(syncCrmMailbox(session, { connectionId, requestId: "44444444-4444-4444-8444-444444444444", mode: "latest" }, { pool }, provider), /Nur Postfach-Lesezugriff/);
    await assert.rejects(runPersonalMailboxSync(session, connectionId, { pool, transport: provider }), /Identitätsbindung und Mail-Leserecht/);
    assert.equal(providerCalls, 0);
    assert.equal(queries.filter(sql => sql === "rollback").length, 2);
    assert.ok(!queries.some(sql => /\b(update|insert|delete)\s+(?:into\s+|from\s+)?crm_mailbox/i.test(sql)));
  });
});

test("the legacy shared Microsoft connection retains its existing scope behavior", async () => {
  await withEnvironment({ MICROSOFT_CLIENT_ID: "synthetic-legacy", MICROSOFT_CLIENT_SECRET: "synthetic-secret", MICROSOFT_MAILBOX_ALLOW_LEGACY: "1" }, async () => {
    const result = await exchangeMailboxToken({ provider: "microsoft", refreshToken: "synthetic-refresh" }, transport("Mail.ReadWrite"), auth);
    assert.deepEqual(result.scopes, ["Mail.ReadWrite"]);
  });
});
