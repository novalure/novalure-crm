#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createNewsletterUnsubscribeToken,
  newsletterUnsubscribeTokenTtlSeconds,
  parseNewsletterUnsubscribeToken,
} from "../src/lib/newsletter-unsubscribe-token.ts";
import {
  hasReplaceableNewsletterUnsubscribeToken,
  newsletterUnsubscribeUrlToken,
  replaceNewsletterUnsubscribeToken,
  resendUnsubscribeUrlToken,
} from "../src/lib/newsletter-unsubscribe-placeholder.ts";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const campaignId = "22222222-2222-4222-8222-222222222222";
const email = "recipient@example.test";
const nowSeconds = 1_800_000_000;

function withTokenSecret(callback) {
  const previous = process.env.NOVALURE_AUTH_ENCRYPTION_KEY;
  process.env.NOVALURE_AUTH_ENCRYPTION_KEY = "qa-newsletter-unsubscribe-encryption-key-2026-with-32-bytes";
  try {
    return callback();
  } finally {
    if (previous === undefined) delete process.env.NOVALURE_AUTH_ENCRYPTION_KEY;
    else process.env.NOVALURE_AUTH_ENCRYPTION_KEY = previous;
  }
}

test("unsubscribe capability is opaque, authenticated, purpose-bound and time-limited", () => {
  withTokenSecret(() => {
    const token = createNewsletterUnsubscribeToken({ campaignId, email, nowSeconds, workspaceId });
    assert.match(token, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
    assert.doesNotMatch(token, /recipient|example|11111111|22222222/u);

    const parsed = parseNewsletterUnsubscribeToken(token, nowSeconds + 1);
    assert.ok(parsed);
    assert.equal(parsed.email, email);
    assert.equal(parsed.workspaceId, workspaceId);
    assert.equal(parsed.campaignId, campaignId);
    assert.equal(parsed.expiresAt, nowSeconds + newsletterUnsubscribeTokenTtlSeconds);
    assert.match(parsed.tokenId, /^[A-Za-z0-9_-]{32}$/u);
    assert.equal(parseNewsletterUnsubscribeToken(token, parsed.expiresAt), null);

    const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    assert.equal(parseNewsletterUnsubscribeToken(tampered, nowSeconds + 1), null);
  });
});

test("unsubscribe token creation fails closed without the dedicated encryption configuration", () => {
  const previous = process.env.NOVALURE_AUTH_ENCRYPTION_KEY;
  delete process.env.NOVALURE_AUTH_ENCRYPTION_KEY;
  try {
    assert.throws(
      () => createNewsletterUnsubscribeToken({ email, nowSeconds, workspaceId }),
      /NOVALURE_AUTH_ENCRYPTION_KEY/,
    );
  } finally {
    if (previous !== undefined) process.env.NOVALURE_AUTH_ENCRYPTION_KEY = previous;
  }
});

test("unsubscribe GET page is read-only and never consumes identity query parameters", async () => {
  const page = await readFile(new URL("../src/app/unsubscribe/page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(page, /recordNewsletterUnsubscribe|runtime-repositories|\bqueryOne\b|\bqueryRows\b/u);
  assert.doesNotMatch(page, /query\.(?:email|workspaceId|wid|campaignId|campaign|token)/u);
  assert.match(page, /robots: \{ follow: false, index: false \}/u);
  assert.match(page, /referrer: "no-referrer"/u);
});

test("email links carry only an opaque fragment capability and previews contain no recipient PII", async () => {
  const sendRoute = await readFile(new URL("../src/app/api/newsletter/send/route.ts", import.meta.url), "utf8");
  const preview = await readFile(new URL("../src/components/newsletter-command-center.tsx", import.meta.url), "utf8");
  const builder = sendRoute.slice(
    sendRoute.indexOf("function buildNewsletterUnsubscribeUrl"),
    sendRoute.indexOf("function withRecipientUnsubscribeUrl"),
  );
  assert.match(builder, /createNewsletterUnsubscribeToken/u);
  assert.match(builder, /unsubscribeUrl\.hash = new URLSearchParams/u);
  assert.doesNotMatch(builder, /searchParams\.set\("(?:email|workspaceId|campaignId)"/u);
  assert.match(sendRoute, /unsubscribeTokenVersion: "v1"/u);
  assert.doesNotMatch(sendRoute, /metadata:\s*\{[^}]*unsubscribeUrl/u);
  assert.match(preview, /new URLSearchParams\(\{ lang: language, preview: "1" \}\)/u);
  assert.doesNotMatch(preview, /unsubscribePreviewParams\.set\("(?:workspaceId|campaignId|email)"/u);
});

test("newsletter preflight accepts only placeholders that the send path actually replaces", async () => {
  const preflight = await readFile(
    new URL("../src/lib/db/editor-preflight-repositories.ts", import.meta.url),
    "utf8",
  );
  const sendRoute = await readFile(new URL("../src/app/api/newsletter/send/route.ts", import.meta.url), "utf8");

  assert.equal(hasReplaceableNewsletterUnsubscribeToken("Please unsubscribe here"), false);
  assert.equal(hasReplaceableNewsletterUnsubscribeToken("Jetzt abmelden"), false);
  assert.equal(hasReplaceableNewsletterUnsubscribeToken(newsletterUnsubscribeUrlToken), true);
  assert.equal(hasReplaceableNewsletterUnsubscribeToken(resendUnsubscribeUrlToken), true);
  assert.equal(
    replaceNewsletterUnsubscribeToken(
      `${newsletterUnsubscribeUrlToken} ${resendUnsubscribeUrlToken}`,
      "https://example.test/unsubscribe#token=opaque",
    ),
    "https://example.test/unsubscribe#token=opaque https://example.test/unsubscribe#token=opaque",
  );
  assert.match(preflight, /hasReplaceableNewsletterUnsubscribeToken\(html\)/u);
  assert.doesNotMatch(preflight, /unsubscribe\|abmelden/u);
  assert.match(sendRoute, /replaceNewsletterUnsubscribeToken\(html, unsubscribeUrl\)/u);
});

test("fragment token requires explicit confirmation and is erased before it enters component state", async () => {
  const client = await readFile(
    new URL("../src/app/unsubscribe/unsubscribe-confirmation.tsx", import.meta.url),
    "utf8",
  );
  const replaceIndex = client.indexOf("window.history.replaceState(");
  const retainIndex = client.indexOf("tokenRef.current = token");
  assert.match(client, /window\.location\.hash/u);
  assert.ok(replaceIndex >= 0 && replaceIndex < retainIndex);
  assert.match(client, /onClick=\{confirm\}/u);
  assert.match(client, /credentials: "omit"/u);
  const effect = client.slice(client.indexOf("useEffect(() =>"), client.indexOf("const confirm = async"));
  assert.doesNotMatch(effect, /fetch\("\/unsubscribe\/confirm"/u);
});

test("confirmation endpoint is POST-only, same-origin, bounded and neutral", async () => {
  const route = await readFile(new URL("../src/app/unsubscribe/confirm/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(route, /export async function GET/u);
  assert.match(route, /export async function POST/u);
  const contextIndex = route.indexOf("validateCsrfRequestContext(");
  const parseIndex = route.indexOf("parseNewsletterUnsubscribeToken(input.token)");
  const persistIndex = route.indexOf("await recordNewsletterUnsubscribe(");
  assert.ok(contextIndex >= 0 && contextIndex < parseIndex && parseIndex < persistIndex);
  assert.match(route, /mediaType !== "application\/json"/u);
  assert.match(route, /Buffer\.byteLength\(rawBody, "utf8"\) > 4_096/u);
  assert.match(route, /"cache-control": "private, no-store"/u);
  assert.match(route, /"referrer-policy": "no-referrer"/u);
  assert.doesNotMatch(route, /Response\.json\([^\n]*(?:email|contactIds|workspaceId)/u);
});

test("persistence is atomic, workspace-bound and idempotent without duplicate opt-out evidence", async () => {
  const repository = await readFile(new URL("../src/lib/db/runtime-repositories.ts", import.meta.url), "utf8");
  const start = repository.indexOf("export async function recordNewsletterUnsubscribe");
  const end = repository.indexOf("export async function listNewsletterSuppressedEmails", start);
  const unsubscribe = repository.slice(start, end);
  assert.match(unsubscribe, /with lock_scope as/u);
  assert.match(unsubscribe, /pg_advisory_xact_lock/u);
  assert.match(unsubscribe, /on conflict \(workspace_id, lower\(email\)\) do update/u);
  assert.match(unsubscribe, /newsletter_suppressions\.metadata->>'unsubscribeTokenId' = \$4/u);
  assert.match(unsubscribe, /order by cr\.captured_at desc, cr\.id desc/u);
  assert.match(unsubscribe, /!~\* '\(abgemeldet\|opt\.\?out\|unsubscribe\|unsubscribed\)'/u);
  assert.doesNotMatch(unsubscribe, /Promise\.all|queryRows</u);
  assert.doesNotMatch(unsubscribe, /jsonb_build_object\([^)]*'email'/su);
});
