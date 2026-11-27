import assert from "node:assert/strict";
import test from "node:test";
import { microsoftClientAuthConfigured } from "../src/lib/integrations/microsoft-client-auth-config";
import { microsoftClientAuthFields } from "../src/lib/integrations/microsoft-client-auth";
import { exchangeMailboxToken, type MailboxTransport } from "../src/lib/integrations/mailbox-provider";
import { bookingOAuthReadiness } from "../src/lib/booking/runtime";
import { syncMicrosoftCalendarEvent } from "../src/lib/integrations/microsoft-calendar";

const base: NodeJS.ProcessEnv = { NODE_ENV: "test", MICROSOFT_CLIENT_ID: "synthetic-client" };
const federated: NodeJS.ProcessEnv = { ...base, MICROSOFT_CLIENT_AUTH_METHOD: "vercel-oidc", VERCEL: "1", VERCEL_ENV: "production" };

test("secret mode preserves existing behaviour without obtaining an OIDC assertion", async () => {
  let calls = 0;
  const fields = await microsoftClientAuthFields({ ...base, MICROSOFT_CLIENT_SECRET: "synthetic-secret" }, async () => { calls++; throw Error(); });
  assert.deepEqual(fields, { client_id: "synthetic-client", client_secret: "synthetic-secret" });
  assert.equal(calls, 0);
});

test("OIDC obtains a request assertion on every exchange without a secret", async () => {
  let calls = 0;
  const obtain = async () => `synthetic-assertion-${++calls}`;
  const first = await microsoftClientAuthFields({ ...federated, MICROSOFT_CLIENT_SECRET: "must-not-fallback" }, obtain);
  const second = await microsoftClientAuthFields(federated, obtain);
  assert.equal(first.client_assertion, "synthetic-assertion-1");
  assert.equal(second.client_assertion, "synthetic-assertion-2");
  assert.equal(first.client_assertion_type, "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
  assert.equal("client_secret" in first, false);
});

test("missing OIDC request identity fails closed even when an old secret is configured", async () => {
  await assert.rejects(microsoftClientAuthFields({ ...federated, MICROSOFT_CLIENT_SECRET: "old" }, async () => { throw new Error("sensitive provider error"); }), /^Error: MICROSOFT_CLIENT_ASSERTION_UNAVAILABLE$/);
  await assert.rejects(microsoftClientAuthFields(federated, async () => ""), /^Error: MICROSOFT_CLIENT_ASSERTION_UNAVAILABLE$/);
});

test("unknown modes and non-Vercel context do not silently enable OAuth", () => {
  assert.equal(microsoftClientAuthConfigured({ ...base, MICROSOFT_CLIENT_AUTH_METHOD: "unknown", MICROSOFT_CLIENT_SECRET: "old" }), false);
  assert.equal(microsoftClientAuthConfigured({ ...federated, VERCEL: "0", MICROSOFT_CLIENT_SECRET: "old" }), false);
  assert.equal(microsoftClientAuthConfigured({ ...federated, VERCEL_ENV: "development" }), false);
  assert.equal(microsoftClientAuthConfigured({ ...federated, MICROSOFT_CLIENT_ID: "" }), false);
  assert.equal(microsoftClientAuthConfigured({ ...federated, VERCEL_ENV: "preview" }), true);
});

test("federated mode rejects environment or file token fallbacks", async () => {
  for (const value of [{ VERCEL_OIDC_TOKEN: "synthetic" }, { VERCEL_OIDC_TOKEN_FILE: "synthetic" }]) {
    await assert.rejects(microsoftClientAuthFields({ ...federated, ...value }, async () => "synthetic-assertion"), /MICROSOFT_CLIENT_ASSERTION_UNAVAILABLE/);
  }
});

test("prior customer-booking verification does not automatically verify a new federation", () => {
  const env = { ...federated, BOOKING_MICROSOFT_ACCOUNT_TYPE: "organizations_and_personal", BOOKING_MICROSOFT_AUTHORITY: "common", BOOKING_MICROSOFT_EXTERNAL_OAUTH_VERIFIED: "1" };
  assert.equal(bookingOAuthReadiness("microsoft", env).externalCustomerReady, false);
});

test("an unavailable workspace calendar never falls back to an ambient global token", async () => {
  const oldToken = process.env.MICROSOFT_GRAPH_ACCESS_TOKEN;
  const dbNames = ["DATABASE_URL", "POSTGRES_URL", "POSTGRES_DATABASE_URL", "POSTGRES_PRISMA_URL"] as const;
  const oldDatabases = dbNames.map(name => process.env[name]);
  const oldFetch = globalThis.fetch;
  let calls = 0;
  process.env.MICROSOFT_GRAPH_ACCESS_TOKEN = "synthetic-ambient-token";
  for (const name of dbNames) delete process.env[name];
  globalThis.fetch = async () => { calls++; throw new Error("unexpected external request"); };
  try {
    const result = await syncMicrosoftCalendarEvent({ workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", subject: "synthetic", startsAt: "2030-01-01T09:00:00Z", endsAt: "2030-01-01T09:30:00Z" });
    assert.notEqual(result.status, "synced");
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldToken === undefined) delete process.env.MICROSOFT_GRAPH_ACCESS_TOKEN; else process.env.MICROSOFT_GRAPH_ACCESS_TOKEN = oldToken;
    dbNames.forEach((name, index) => { if (oldDatabases[index] === undefined) delete process.env[name]; else process.env[name] = oldDatabases[index]; });
  }
});

test("mailbox authorization-code and refresh requests use a fresh assertion and retain read-only scope", async () => {
  const oldOrigin = process.env.NOVALURE_APP_ORIGIN;
  const oldTenant = process.env.MICROSOFT_TENANT_ID;
  const modeKeys = ["MICROSOFT_MAILBOX_ALLOW_LEGACY", "MICROSOFT_MAILBOX_IDENTITY_MODE", "MICROSOFT_MAILBOX_CLIENT_ID", "MICROSOFT_MAILBOX_CLIENT_AUTH_METHOD", "MICROSOFT_MAILBOX_CLIENT_SECRET"] as const;
  const oldModes = modeKeys.map(key => process.env[key]);
  for (const key of modeKeys) delete process.env[key];
  process.env.MICROSOFT_MAILBOX_ALLOW_LEGACY = "1";
  process.env.NOVALURE_APP_ORIGIN = "https://synthetic.example.invalid";
  process.env.MICROSOFT_TENANT_ID = "common";
  let assertions = 0;
  const auth = async () => ({ client_id: "synthetic-client", client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: `synthetic-${++assertions}` });
  const requests: URLSearchParams[] = [];
  const transport: MailboxTransport = async (url, init) => {
    assert.equal(url, "https://login.microsoftonline.com/common/oauth2/v2.0/token");
    requests.push(new URLSearchParams(String(init.body)));
    return new Response(JSON.stringify({ access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_in: 3600, token_type: "Bearer", scope: "Mail.Read User.Read" }), { status: 200 });
  };
  try {
    await exchangeMailboxToken({ provider: "microsoft", code: "synthetic-code", codeVerifier: "synthetic-verifier", requestUrl: "https://synthetic.example.invalid" }, transport, auth);
    await exchangeMailboxToken({ provider: "microsoft", refreshToken: "synthetic-refresh" }, transport, auth);
    assert.equal(assertions, 2);
    assert.deepEqual(requests.map(item => item.get("grant_type")), ["authorization_code", "refresh_token"]);
    assert.deepEqual(requests.map(item => item.get("client_assertion")), ["synthetic-1", "synthetic-2"]);
    for (const body of requests) {
      assert.equal(body.has("client_secret"), false);
      assert.match(body.get("scope") || "", /Mail\.Read/);
      assert.doesNotMatch(body.get("scope") || "", /Mail\.Send|Mail\.ReadWrite/);
    }
  } finally {
    if (oldOrigin === undefined) delete process.env.NOVALURE_APP_ORIGIN; else process.env.NOVALURE_APP_ORIGIN = oldOrigin;
    if (oldTenant === undefined) delete process.env.MICROSOFT_TENANT_ID; else process.env.MICROSOFT_TENANT_ID = oldTenant;
    modeKeys.forEach((key, index) => { if (oldModes[index] === undefined) delete process.env[key]; else process.env[key] = oldModes[index]; });
  }
});
