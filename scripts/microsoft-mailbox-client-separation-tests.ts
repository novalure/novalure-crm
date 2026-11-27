import assert from "node:assert/strict";
import test from "node:test";
import { microsoftClientAuthConfigured, microsoftMailboxClientEnv, microsoftMailboxClientId } from "../src/lib/integrations/microsoft-client-auth-config";
import { microsoftClientAuthFields, microsoftMailboxClientAuthFields } from "../src/lib/integrations/microsoft-client-auth";
import { exchangeMailboxToken, mailboxAuthorizationUrl, mailboxOAuthConfigured } from "../src/lib/integrations/mailbox-provider";

test("dedicated mailbox identity cannot inherit the calendar app's credentials", async () => {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    MICROSOFT_CLIENT_ID: "synthetic-calendar", MICROSOFT_CLIENT_SECRET: "synthetic-calendar-secret",
    MICROSOFT_MAILBOX_CLIENT_ID: "synthetic-mail", MICROSOFT_MAILBOX_CLIENT_AUTH_METHOD: "vercel-oidc",
    VERCEL: "1", VERCEL_ENV: "production",
  };
  assert.equal(microsoftClientAuthConfigured(env), true);
  assert.equal(microsoftClientAuthConfigured(microsoftMailboxClientEnv(env)), true);
  assert.equal(microsoftMailboxClientId(env), "synthetic-mail");
  assert.deepEqual(await microsoftClientAuthFields(env), { client_id: "synthetic-calendar", client_secret: "synthetic-calendar-secret" });
  const mailbox = await microsoftMailboxClientAuthFields(env, async () => "synthetic-assertion");
  assert.equal(mailbox.client_id, "synthetic-mail");
  assert.equal(mailbox.client_assertion, "synthetic-assertion");
  assert.equal("client_secret" in mailbox, false);
  const incomplete = { ...env, MICROSOFT_MAILBOX_CLIENT_ID: undefined };
  assert.equal(microsoftClientAuthConfigured(microsoftMailboxClientEnv(incomplete)), false);
  await assert.rejects(microsoftMailboxClientAuthFields(incomplete, async () => "synthetic-assertion"), /MICROSOFT_CLIENT_AUTH_NOT_CONFIGURED/);
});

test("legacy configuration remains usable only while no mailbox-specific key exists", () => {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", MICROSOFT_CLIENT_ID: "synthetic-calendar", MICROSOFT_CLIENT_SECRET: "synthetic-calendar-secret" };
  assert.equal(microsoftMailboxClientId(env), "synthetic-calendar");
  assert.equal(microsoftClientAuthConfigured(microsoftMailboxClientEnv(env)), true);
  assert.equal(microsoftClientAuthConfigured(microsoftMailboxClientEnv({ ...env, MICROSOFT_MAILBOX_CLIENT_AUTH_METHOD: "" })), false);
});

test("mailbox OAuth authorizes the dedicated app and requests read-only mail", async () => {
  const values: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    MICROSOFT_CLIENT_ID: "synthetic-calendar", MICROSOFT_CLIENT_SECRET: "synthetic-calendar-secret",
    MICROSOFT_MAILBOX_CLIENT_ID: "synthetic-mail", MICROSOFT_MAILBOX_CLIENT_AUTH_METHOD: "vercel-oidc",
    OAUTH_STATE_SECRET: "synthetic-state-secret-with-at-least-32-bytes", OAUTH_TOKEN_ENCRYPTION_KEY: "synthetic-only",
    NOVALURE_APP_ORIGIN: "https://synthetic.example.invalid", VERCEL: "1", VERCEL_ENV: "preview", MICROSOFT_TENANT_ID: "common", MICROSOFT_MAILBOX_IDENTITY_MODE: "verified-preview", MICROSOFT_MAILBOX_ALLOW_LEGACY: "0",
  };
  const keys = Object.keys(values);
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, values);
    assert.equal(mailboxOAuthConfigured("microsoft"), true);
    const url = new URL(mailboxAuthorizationUrl({ provider: "microsoft", requestUrl: "https://synthetic.example.invalid", state: "synthetic-state", codeChallenge: "synthetic-challenge", verifiedExternalNonce: "a".repeat(43) }));
    assert.equal(url.searchParams.get("client_id"), "synthetic-mail");
    assert.match(url.searchParams.get("scope") || "", /Mail\.Read/);
    assert.doesNotMatch(url.searchParams.get("scope") || "", /Mail\.Send|Mail\.ReadWrite|Calendars/);
    assert.equal(url.searchParams.get("nonce"), "a".repeat(43));
    for (const requestUrl of ["https://preview.example.invalid", "http://synthetic.example.invalid", "https://synthetic.example.invalid:444", "https://user@synthetic.example.invalid"]) {
      assert.throws(() => mailboxAuthorizationUrl({ provider: "microsoft", requestUrl, state: "synthetic-state", codeChallenge: "synthetic-challenge", verifiedExternalNonce: "a".repeat(43) }), /MAIL_OAUTH_ORIGIN/);
    }
    let authCalls = 0, providerCalls = 0;
    await assert.rejects(exchangeMailboxToken({ provider: "microsoft", code: "synthetic-code", codeVerifier: "synthetic-verifier", requestUrl: "https://preview.example.invalid", verifiedMicrosoftAuthority: "common" }, async () => { providerCalls++; throw new Error("unexpected transport"); }, async () => { authCalls++; return { client_id: "synthetic-mail" }; }), /MAIL_OAUTH_ORIGIN/);
    assert.equal(authCalls, 0);
    assert.equal(providerCalls, 0);
  } finally {
    for (const key of keys) { const value = previous.get(key); if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
