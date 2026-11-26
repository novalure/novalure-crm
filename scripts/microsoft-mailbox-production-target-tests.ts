import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { AppSession } from "../src/lib/auth/session";
import type { TenantTransaction } from "../src/lib/crm-command";
import { beginCrmMailboxOAuth, syncCrmMailbox } from "../src/lib/db/crm-mailbox-repository";
import type { TenantPool } from "../src/lib/db/tenant-client";
import { exchangeMailboxToken, mailboxAuthorizationUrl } from "../src/lib/integrations/mailbox-provider";

const sha = "a".repeat(40);
const production = {
  VERCEL: "1",
  VERCEL_ENV: "production",
  VERCEL_TARGET_ENV: "production",
  VERCEL_PROJECT_ID: "prj_R32Okl6AHijTohvuKmryuTLjWMsk",
  NOVALURE_APP_ORIGIN: "https://www.novalure-crm.app",
  NOVALURE_BUILD_GIT_SHA: sha,
  VERCEL_GIT_COMMIT_SHA: sha,
  MICROSOFT_CLIENT_ID: "synthetic-calendar",
  MICROSOFT_MAILBOX_CLIENT_ID: "0c00e270-a9c7-473e-baa2-3400058e8375",
  MICROSOFT_MAILBOX_CLIENT_AUTH_METHOD: "vercel-oidc",
  MICROSOFT_MAILBOX_IDENTITY_MODE: "verified-production",
  MICROSOFT_MAILBOX_PRODUCTION_RELEASE_SHA: sha,
  DATABASE_URL: "postgresql://novalure_app:synthetic@ep-wandering-union-alem0781-pooler.c-3.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
  OAUTH_STATE_SECRET: "synthetic-state-value-with-more-than-32-bytes",
  OAUTH_TOKEN_ENCRYPTION_KEY: "synthetic-encryption",
};
const input = {
  provider: "microsoft" as const,
  requestUrl: production.NOVALURE_APP_ORIGIN,
  state: "synthetic", codeChallenge: "synthetic", verifiedExternalNonce: "n".repeat(43),
};

async function withProductionEnv(drift: Record<string, string | undefined>, run: () => void | Promise<void>) {
  const keys = new Set([...Object.keys(production), ...Object.keys(drift), "MICROSOFT_MAILBOX_ALLOW_LEGACY", "MICROSOFT_MAILBOX_CLIENT_SECRET", "VERCEL_OIDC_TOKEN", "VERCEL_OIDC_TOKEN_FILE"]);
  const previous = new Map([...keys].map(key => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    for (const [key, value] of Object.entries({ ...production, ...drift })) {
      if (value !== undefined) process.env[key] = value;
    }
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("production uses its exact CRM callback and requests read-only mailbox permissions", async () => {
  await withProductionEnv({}, () => {
    const url = new URL(mailboxAuthorizationUrl(input));
    assert.equal(url.searchParams.get("redirect_uri"), "https://www.novalure-crm.app/api/crm/mailbox/oauth/microsoft/callback");
    assert.ok(url.searchParams.get("scope")?.split(" ").includes("https://graph.microsoft.com/Mail.Read"));
    assert.doesNotMatch(url.searchParams.get("scope") ?? "", /Mail\.(?:Send|ReadWrite)/i);
    assert.throws(() => mailboxAuthorizationUrl({ ...input, requestUrl: "https://foreign.example.invalid" }), /MAIL_OAUTH_ORIGIN/);
  });
});

test("deployment or credential drift blocks authorization and refresh before external I/O", async () => {
  const drifts: Record<string, string | undefined>[] = [
    { MICROSOFT_MAILBOX_PRODUCTION_RELEASE_SHA: undefined },
    { NOVALURE_BUILD_GIT_SHA: "b".repeat(40) },
    { VERCEL_GIT_COMMIT_SHA: "b".repeat(40) },
    { VERCEL_PROJECT_ID: "prj_foreign" },
    { VERCEL_ENV: "preview", VERCEL_TARGET_ENV: "preview" },
    { VERCEL_TARGET_ENV: "preview" },
    { NOVALURE_APP_ORIGIN: "https://foreign.example.invalid" },
    { VERCEL_OIDC_TOKEN: "synthetic" },
    { MICROSOFT_MAILBOX_CLIENT_SECRET: "synthetic" },
    { MICROSOFT_MAILBOX_CLIENT_ID: "55555555-5555-4555-8555-555555555555" },
    { MICROSOFT_MAILBOX_ALLOW_LEGACY: "1" },
    {
      MICROSOFT_MAILBOX_IDENTITY_MODE: undefined, MICROSOFT_MAILBOX_CLIENT_ID: undefined,
      MICROSOFT_MAILBOX_CLIENT_AUTH_METHOD: undefined, MICROSOFT_MAILBOX_ALLOW_LEGACY: "1",
      MICROSOFT_CLIENT_SECRET: "synthetic-calendar-secret",
    },
  ];
  for (const drift of drifts) await withProductionEnv(drift, async () => {
    assert.throws(() => mailboxAuthorizationUrl(input), /MAIL_OAUTH_NOT_CONFIGURED/);
    const noIo = async (): Promise<never> => { assert.fail("a mismatched deployment called an external service"); };
    await assert.rejects(exchangeMailboxToken({
      provider: "microsoft", refreshToken: "synthetic", verifiedMicrosoftAuthority: "66666666-6666-4666-8666-666666666666",
    }, noIo, noIo), /MAIL_OAUTH_CONFIG/);
  });
});

test("production does not generate a mailbox OAuth state on an unready or mismatched database", async () => {
  const cases = [
    { drift: {}, checks: 1 },
    { drift: { DATABASE_URL: undefined }, checks: 0 },
    { drift: { DATABASE_URL: production.DATABASE_URL.replace("ep-wandering-union-alem0781-pooler", "ep-other-pooler") }, checks: 0 },
    { drift: { DATABASE_URL: production.DATABASE_URL + "&options=-c%20neon.branch_id%3Dspoofed" }, checks: 0 },
  ];
  for (const scenario of cases) await withProductionEnv(scenario.drift, async () => {
    const session = {
      authenticated: true, source: "cookie", role: "owner", productRole: "customer_owner",
      workspaceId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222",
      authSessionId: "33333333-3333-4333-8333-333333333333", authIdentityId: "44444444-4444-4444-8444-444444444444",
    } as AppSession;
    let checks = 0;
    const tx = {
      async queryOne(_query: string, values: unknown[]) {
        checks++;
        assert.deepEqual(values, ["misty-cloud-70835427", "br-spring-night-alyu48yp"]);
        return { ready: false };
      },
      async query() { assert.fail("OAuth state must not be written on an unready database"); },
    } as unknown as TenantTransaction;
    await assert.rejects(beginCrmMailboxOAuth(tx, session, "microsoft", input.requestUrl), { code: "MAIL_PRODUCTION_DATABASE_UNAVAILABLE" });
    assert.equal(checks, scenario.checks);
  });
});

test("manual sync checks the database again after committing its lease", async () => {
  await withProductionEnv({}, async () => {
    const workspaceId = randomUUID(), userId = randomUUID(), id = randomUUID();
    const session = { authenticated: true, source: "database", role: "owner", productRole: "customer_owner", permissions: ["crm:read"], workspaceId, userId } as AppSession;
    let checkouts = 0;
    let targetChecks = 0;
    const pool = {
      async connect() {
        const checkout = ++checkouts;
        return { release() {}, async query(sql: string) {
          const query = sql.replace(/\s+/g, " ").trim();
          if (query.includes("from pg_roles runtime_role")) return { rows: [{ safe: true }] };
          if (query.startsWith("select set_config('app.tenant_id'")) return { rows: [{ workspaceId, actorId: userId }] };
          if (query.includes("crm_lock_active_member")) return { rows: [{ role: "owner", productRole: "customer_owner", operatingModel: "self_service_customer", authIdentityId: null }] };
          if (["begin", "commit", "rollback"].includes(query)) return { rows: [], command: query.toUpperCase() };
          if (query.includes("current_setting('neon.project_id'")) { targetChecks++; return { rows: [{ ready: checkout === 1 }] }; }
          assert.equal(checkout, 1, "only the first checkout is trusted to access mailbox state");
          if (query.startsWith("select id,provider,account_label")) return { rows: [{ id, provider: "microsoft", status: "connected", scopes: ["Mail.Read"], tenantId: randomUUID(), subject: "synthetic", accountId: randomUUID(), revision: 7 }] };
          if (query.startsWith("select id,status,request_hash")) return { rows: [] };
          if (query.startsWith("select coalesce(sync_lease_until")) return { rows: [{ busy: false }] };
          if (query.startsWith("insert into crm_mailbox_sync_runs")) return { rows: [] };
          if (query.startsWith("update crm_mailbox_connections set sync_lease_id")) return { rows: [{ revision: 8 }] };
          assert.fail("unexpected synthetic query");
        } };
      },
    } as unknown as TenantPool;
    const noIo = async (): Promise<never> => { assert.fail("the second database must be checked before provider I/O"); };
    await assert.rejects(syncCrmMailbox(session, { connectionId: id, requestId: randomUUID(), mode: "latest" }, { pool }, noIo, noIo, noIo), { code: "MAIL_PRODUCTION_DATABASE_UNAVAILABLE" });
    assert.equal(checkouts, 3); // claim, denied provider preflight, denied failure write
    assert.equal(targetChecks, 3);
  });
});
