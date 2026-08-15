#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createSignedOAuthState,
  decryptOAuthStateSecret,
  encryptOAuthStateSecret,
  oauthStateTtlSeconds,
  parseSignedOAuthState,
} from "../src/lib/integrations/calendar-oauth-state.ts";

const testSecret = "qa-oauth-state-secret-with-at-least-32-bytes-2026";
const userId = "22222222-2222-4222-8222-222222222222";
const workspaceId = "11111111-1111-4111-8111-111111111111";

function issueState(nowSeconds = 1_800_000_000) {
  process.env.OAUTH_STATE_SECRET = testSecret;
  return createSignedOAuthState({
    nowSeconds,
    provider: "google",
    returnTo: "/#calendar",
    userId,
    workspaceId,
  });
}

test("OAuth state contains a high-entropy nonce, short TTL and S256 PKCE pair", () => {
  const now = 1_800_000_000;
  const issued = issueState(now);
  const parsed = parseSignedOAuthState(issued.state, "google", now + 1);

  assert.ok(parsed);
  assert.equal(parsed.userId, userId);
  assert.equal(parsed.workspaceId, workspaceId);
  assert.equal(parsed.exp - parsed.iat, oauthStateTtlSeconds);
  assert.ok(parsed.nonce.length >= 32);
  assert.ok(issued.codeVerifier.length >= 43);
  assert.equal(
    issued.codeChallenge,
    createHash("sha256").update(issued.codeVerifier).digest("base64url"),
  );
});

test("tampered, wrong-provider, expired and future OAuth states are rejected", () => {
  const now = 1_800_000_000;
  const issued = issueState(now);
  const [payload, signature] = issued.state.split(".");
  const tamperedSignature = `${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;

  assert.equal(parseSignedOAuthState(`${payload}.${tamperedSignature}`, "google", now + 1), null);
  assert.equal(parseSignedOAuthState(issued.state, "microsoft", now + 1), null);
  assert.equal(parseSignedOAuthState(issued.state, "google", now + oauthStateTtlSeconds + 1), null);
  assert.equal(parseSignedOAuthState(issued.state, "google", now - 31), null);
});

test("OAuth state never falls back to unrelated secrets and encrypts the PKCE verifier", () => {
  const previousStateSecret = process.env.OAUTH_STATE_SECRET;
  const previousCronSecret = process.env.CRON_SECRET;
  const previousTokenKey = process.env.OAUTH_TOKEN_ENCRYPTION_KEY;

  try {
    delete process.env.OAUTH_STATE_SECRET;
    process.env.CRON_SECRET = "cron-secret-that-must-not-be-used-as-an-oauth-secret";
    process.env.OAUTH_TOKEN_ENCRYPTION_KEY = "token-key-that-must-not-be-used-as-an-oauth-secret";
    assert.throws(
      () =>
        createSignedOAuthState({
          provider: "google",
          returnTo: "/",
          userId,
          workspaceId,
        }),
      /OAUTH_STATE_SECRET/,
    );

    process.env.OAUTH_STATE_SECRET = testSecret;
    const encrypted = encryptOAuthStateSecret("pkce-verifier-secret");
    assert.doesNotMatch(encrypted, /pkce-verifier-secret/);
    assert.equal(decryptOAuthStateSecret(encrypted), "pkce-verifier-secret");

    process.env.OAUTH_STATE_SECRET = `${testSecret}-rotated`;
    assert.throws(() => decryptOAuthStateSecret(encrypted));
  } finally {
    if (previousStateSecret === undefined) delete process.env.OAUTH_STATE_SECRET;
    else process.env.OAUTH_STATE_SECRET = previousStateSecret;
    if (previousCronSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousCronSecret;
    if (previousTokenKey === undefined) delete process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
    else process.env.OAUTH_TOKEN_ENCRYPTION_KEY = previousTokenKey;
  }
});

test("OAuth persistence and callback enforce atomic one-time, session-bound state before exchange", async () => {
  const library = await readFile(
    new URL("../src/lib/integrations/calendar-connections.ts", import.meta.url),
    "utf8",
  );
  const callback = await readFile(
    new URL("../src/app/api/meetings/oauth/[provider]/callback/route.ts", import.meta.url),
    "utf8",
  );
  const migration = await readFile(
    new URL("../migrations/053_oauth_state_integrity.sql", import.meta.url),
    "utf8",
  );
  const tenantGuardMigration = await readFile(
    new URL("../migrations/066_oauth_state_workspace_user_guard.sql", import.meta.url),
    "utf8",
  );

  assert.match(library, /state_hash/);
  assert.match(library, /nonce_hash/);
  assert.match(library, /set consumed_at = now\(\)/);
  assert.match(library, /consumed_at is null/);
  assert.match(library, /expires_at > now\(\)/);
  assert.match(library, /sessionWorkspaceId/);
  assert.match(library, /sessionUserId/);
  assert.match(library, /code_verifier: input\.codeVerifier/);
  assert.match(callback, /requirePermissionAndProductCapability/);
  assert.ok(callback.indexOf("consumeOAuthState") < callback.indexOf("exchangeOAuthCode"));
  assert.match(migration, /state_hash text not null unique/);
  assert.match(migration, /nonce_hash text not null unique/);
  assert.match(migration, /code_verifier_encrypted text not null/);
  assert.match(tenantGuardMigration, /oauth_authorization_states_workspace_user_fk/);
  assert.match(tenantGuardMigration, /foreign key \(workspace_id, user_id\)/);
  assert.match(tenantGuardMigration, /references public\.workspace_users\(workspace_id, id\)/);
  assert.match(
    tenantGuardMigration,
    /validate constraint oauth_authorization_states_workspace_user_fk/,
  );
});
