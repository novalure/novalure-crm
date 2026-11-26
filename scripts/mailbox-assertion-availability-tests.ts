import test from "node:test";
import assert from "node:assert/strict";
import { microsoftClientAuthFields, MicrosoftClientAuthError } from "../src/lib/integrations/microsoft-client-auth";
import { exchangeMailboxToken, MailboxProviderError } from "../src/lib/integrations/mailbox-provider";
import { mailboxSyncFailureStatus } from "../src/lib/crm-mailbox-sync";
import { exchangeVercelOidcToken } from "@vercel/oidc";

const app = "11111111-1111-4111-8111-111111111111";
const tenant = "22222222-2222-4222-8222-222222222222";
const federated: NodeJS.ProcessEnv = { NODE_ENV: "test", MICROSOFT_CLIENT_ID: app, MICROSOFT_CLIENT_AUTH_METHOD: "vercel-oidc", VERCEL: "1", VERCEL_ENV: "preview" };
const configuration = (error: unknown) => error instanceof MicrosoftClientAuthError && error.kind === "configuration";
const unavailable = (error: unknown) => error instanceof MicrosoftClientAuthError && error.kind === "unavailable";

test("only positively identified assertion outages take the existing delayed sync path", { timeout: 12_000 }, async () => {
  const keys = ["MICROSOFT_MAILBOX_CLIENT_ID", "MICROSOFT_MAILBOX_CLIENT_AUTH_METHOD", "MICROSOFT_MAILBOX_CLIENT_SECRET", "MICROSOFT_MAILBOX_IDENTITY_MODE", "MICROSOFT_MAILBOX_ALLOW_LEGACY", "MICROSOFT_CLIENT_ID", "VERCEL", "VERCEL_ENV"] as const;
  const old = keys.map(key => process.env[key]);
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, { MICROSOFT_MAILBOX_CLIENT_ID: app, MICROSOFT_MAILBOX_CLIENT_AUTH_METHOD: "vercel-oidc", MICROSOFT_MAILBOX_IDENTITY_MODE: "verified-preview", VERCEL: "1", VERCEL_ENV: "preview" });
  let providerCalls = 0;
  const transport = async () => { providerCalls++; return new Response("{}"); };
  const input = { provider: "microsoft" as const, refreshToken: "synthetic", verifiedMicrosoftAuthority: tenant };
  try {
    await assert.rejects(microsoftClientAuthFields({ ...federated, MICROSOFT_CLIENT_ID: "" }), configuration);
    await assert.rejects(microsoftClientAuthFields({ ...federated, VERCEL_OIDC_TOKEN: "synthetic" }, async () => "not-used"), configuration);
    const transient = () => new TypeError("synthetic network failure", { cause: { code: "ECONNRESET" } });
    await assert.rejects(microsoftClientAuthFields(federated, async () => { throw transient(); }), unavailable);
    await assert.rejects(microsoftClientAuthFields(federated, async () => { throw Error("unclassified synthetic SDK failure"); }), configuration);

    const exchange = (auth: typeof microsoftClientAuthFields) => exchangeMailboxToken(input, transport, auth);
    const providerUnavailable = (error: unknown) => error instanceof MailboxProviderError && error.code === "MAIL_PROVIDER_UNAVAILABLE" && mailboxSyncFailureStatus(error.code) === "delayed";
    const providerConfig = (error: unknown) => error instanceof MailboxProviderError && error.code === "MAIL_OAUTH_NOT_CONFIGURED" && mailboxSyncFailureStatus(error.code) === "delayed";
    await assert.rejects(exchange(() => microsoftClientAuthFields(federated, async () => { throw transient(); })), providerUnavailable);
    await assert.rejects(exchange(() => microsoftClientAuthFields({ ...federated, VERCEL_OIDC_TOKEN_FILE: "synthetic" }, async () => "not-used")), providerConfig);
    await assert.rejects(exchange(() => microsoftClientAuthFields(federated, async () => { throw Error("unclassified synthetic SDK failure"); })), providerConfig);
    await assert.rejects(exchange(async () => { throw Error("unclassified failure"); }), providerConfig);

    let release!: (value: string) => void;
    const timedOut = exchange(() => microsoftClientAuthFields(federated, () => new Promise<string>(resolve => { release = resolve; })));
    await assert.rejects(timedOut, providerUnavailable);
    release("late-synthetic-assertion");
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(providerCalls, 0);
    for (const code of ["MAIL_AUTHORIZATION_REQUIRED", "MAIL_REAUTH_REQUIRED", "MAIL_SCOPE_REQUIRED", "MAIL_ACCOUNT_CHANGED"]) assert.equal(mailboxSyncFailureStatus(code), "reauthorization_required");
    for (const code of ["MAIL_UNKNOWN_AUTH_FAILURE", "MAIL_UNKNOWN_SCOPE_FAILURE", "MAIL_OAUTH_CONFIG", "MAIL_OAUTH_STATE"]) assert.equal(mailboxSyncFailureStatus(code), "reauthorization_required");
  } finally { keys.forEach((key, index) => { if (old[index] === undefined) delete process.env[key]; else process.env[key] = old[index]; }); }
});

test("SDK status loss leaves synthetic 401 and 503 as conservatively unclassified failures", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const status of [401, 503]) {
      globalThis.fetch = async () => new Response(JSON.stringify({ error: "synthetic-unstructured-failure" }), { status, headers: { "content-type": "application/json" } });
      await assert.rejects(microsoftClientAuthFields(federated, () => exchangeVercelOidcToken({ token: "synthetic-token", audience: "api://AzureADTokenExchange", skipCache: true })), configuration);
    }
  } finally { globalThis.fetch = originalFetch; }
});
