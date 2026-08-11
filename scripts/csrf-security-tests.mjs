#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createCsrfToken,
  csrfHeaderName,
  validateAndConsumeCsrfToken,
  validateCsrfIssuanceContext,
  validateCsrfRequestContext,
  validateCsrfToken,
} from "../src/lib/security/csrf-core.ts";
import { verifyMetaWebhookSignature } from "../src/lib/bots/webhook-security.ts";

const secret = "csrf-test-secret-with-more-than-thirty-two-characters";
const sessionCookie = "signed-session-cookie-a";
const otherSessionCookie = "signed-session-cookie-b";
const trustedOrigin = "https://crm.novalure.example";
const method = "POST";
const pathname = "/api/crm/deals";
const now = Date.UTC(2026, 7, 11, 10, 0, 0);

function createToken(input = {}) {
  const created = createCsrfToken({
    method,
    nonce: "deterministic_nonce_value_with_32_chars_123456",
    now,
    pathname,
    secret,
    sessionCookie,
    ...input,
  });
  assert.ok(created);
  return created.token;
}

function tokenInput(input = {}) {
  return {
    method,
    now: now + 1_000,
    pathname,
    secret,
    sessionCookie,
    token: createToken(),
    ...input,
  };
}

test("valid CSRF token is cryptographic, session-, method- and path-bound", () => {
  const validation = validateCsrfToken(tokenInput());
  assert.equal(validation.ok, true);
  if (validation.ok) {
    assert.match(validation.tokenHash, /^[a-f0-9]{64}$/);
    assert.match(validation.sessionHash, /^[a-f0-9]{64}$/);
  }

  assert.deepEqual(
    validateCsrfToken(tokenInput({ sessionCookie: otherSessionCookie })),
    { ok: false, reason: "csrf_session_mismatch" },
  );
  assert.deepEqual(
    validateCsrfToken(tokenInput({ method: "PATCH" })),
    { ok: false, reason: "csrf_method_mismatch" },
  );
  assert.deepEqual(
    validateCsrfToken(tokenInput({ pathname: "/api/crm/contacts" })),
    { ok: false, reason: "csrf_path_mismatch" },
  );
});

test("missing, malformed, forged and expired CSRF tokens fail closed", () => {
  assert.deepEqual(
    validateCsrfToken(tokenInput({ token: "" })),
    { ok: false, reason: "csrf_invalid" },
  );
  assert.deepEqual(
    validateCsrfToken(tokenInput({ token: `${createToken()}tampered` })),
    { ok: false, reason: "csrf_invalid" },
  );
  assert.deepEqual(
    validateCsrfToken(tokenInput({ secret: `${secret}-wrong` })),
    { ok: false, reason: "csrf_invalid" },
  );
  assert.deepEqual(
    validateCsrfToken(tokenInput({ now: now + 5 * 60 * 1_000 })),
    { ok: false, reason: "csrf_expired" },
  );
});

test("a consumed token cannot be replayed, while parallel unique tokens remain independent", async () => {
  const consumed = new Set();
  const consumeOnce = async (validation) => {
    if (consumed.has(validation.tokenHash)) return false;
    consumed.add(validation.tokenHash);
    return true;
  };

  const firstInput = tokenInput();
  const first = await validateAndConsumeCsrfToken(firstInput, consumeOnce);
  const replay = await validateAndConsumeCsrfToken(firstInput, consumeOnce);
  assert.equal(first.ok, true);
  assert.deepEqual(replay, { ok: false, reason: "csrf_replayed" });

  const parallelInputs = ["parallel_nonce_value_000000000000000001", "parallel_nonce_value_000000000000000002"]
    .map((nonce) => tokenInput({ token: createToken({ nonce }) }));
  const parallel = await Promise.all(
    parallelInputs.map((input) => validateAndConsumeCsrfToken(input, consumeOnce)),
  );
  assert.deepEqual(parallel.map((result) => result.ok), [true, true]);
});

test("Trusted Origin and Sec-Fetch-Site must both identify the exact same origin", () => {
  const accepted = new Headers({
    Origin: trustedOrigin,
    "Sec-Fetch-Site": "same-origin",
  });
  assert.deepEqual(validateCsrfRequestContext(accepted, trustedOrigin), { ok: true });

  const rejectedHeaders = [
    new Headers({ "Sec-Fetch-Site": "same-origin" }),
    new Headers({ Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" }),
    new Headers({ Origin: "https://attacker.crm.novalure.example", "Sec-Fetch-Site": "same-site" }),
    new Headers({ Origin: trustedOrigin, "Sec-Fetch-Site": "cross-site" }),
    new Headers({ Origin: trustedOrigin }),
  ];
  for (const headers of rejectedHeaders) {
    assert.equal(validateCsrfRequestContext(headers, trustedOrigin).ok, false);
  }

  assert.deepEqual(
    validateCsrfIssuanceContext(new Headers({ "Sec-Fetch-Site": "same-origin" }), trustedOrigin),
    { ok: true },
  );
  assert.equal(
    validateCsrfIssuanceContext(
      new Headers({ Origin: "https://evil.example", "Sec-Fetch-Site": "same-origin" }),
      trustedOrigin,
    ).ok,
    false,
  );
});

test("JSON and form mutations use the same CSRF contract without content-type bypasses", () => {
  for (const contentType of ["application/json", "application/x-www-form-urlencoded", "multipart/form-data; boundary=qa"]) {
    const headers = new Headers({
      "Content-Type": contentType,
      Origin: trustedOrigin,
      "Sec-Fetch-Site": "same-origin",
      [csrfHeaderName]: createToken(),
    });
    assert.deepEqual(validateCsrfRequestContext(headers, trustedOrigin), { ok: true });
    assert.equal(headers.has(csrfHeaderName), true);
  }
});

test("claiming the signed-webhook exception without a valid signature is rejected", () => {
  const body = Buffer.from('{"object":"whatsapp_business_account","entry":[]}');
  assert.equal(verifyMetaWebhookSignature(body, null, "configured-meta-secret"), false);
  assert.equal(verifyMetaWebhookSignature(body, "sha256=invalid", "configured-meta-secret"), false);
});

test("server authorization helpers and direct conflict-free routes invoke the central guard", async () => {
  const sessionSource = await readFile(new URL("../src/lib/auth/session.ts", import.meta.url), "utf8");
  const onboarding = await readFile(new URL("../src/app/api/auth/onboarding/route.ts", import.meta.url), "utf8");
  const logout = await readFile(new URL("../src/app/api/auth/logout/route.ts", import.meta.url), "utf8");
  const password = await readFile(new URL("../src/app/api/settings/access/password/route.ts", import.meta.url), "utf8");
  const endpoint = await readFile(new URL("../src/app/api/auth/csrf/route.ts", import.meta.url), "utf8");
  const workspace = await readFile(new URL("../src/components/crm-workspace.tsx", import.meta.url), "utf8");

  assert.match(sessionSource, /import \{ enforceCsrfForSession \}/);
  assert.ok((sessionSource.match(/await enforceCsrfForSession\(request,/g) ?? []).length >= 3);
  assert.match(onboarding, /await enforceCsrfForSession\(request, session\)/);
  assert.match(logout, /await enforceCsrfForSession\(request, session\)/);
  assert.match(workspace, /csrfFetch\(`\/api\/auth\/logout\?lang=\$\{language\}`, \{ method: "POST" \}\)/);
  assert.doesNotMatch(workspace, /<form[^>]+action="\/api\/auth\/logout"/);
  assert.match(password, /await enforceCsrfForSession\(request, session\)/);
  assert.match(endpoint, /export async function GET/);
  assert.doesNotMatch(endpoint, /export async function (?:POST|PATCH|PUT|DELETE)/);
});

test("one-time ledger and explicit signed exceptions fail closed in source", async () => {
  const migration = await readFile(new URL("../migrations/054_csrf_token_integrity.sql", import.meta.url), "utf8");
  const webhook = await readFile(new URL("../src/app/api/bots/channels/webhook/route.ts", import.meta.url), "utf8");
  const cronRuntime = await readFile(new URL("../src/lib/cron/runtime.ts", import.meta.url), "utf8");
  const client = await readFile(new URL("../src/lib/security/csrf-client.ts", import.meta.url), "utf8");

  assert.match(migration, /token_hash text primary key/);
  assert.match(migration, /revoke all on table csrf_token_consumptions from public/);
  assert.match(webhook, /verifyMetaWebhookSignature/);
  assert.match(cronRuntime, /timingSafeEqual/);
  assert.match(cronRuntime, /CRON_SECRET/);
  assert.match(client, /requestCsrfToken\(method, url\.pathname\)/);
  assert.match(client, /headers\.set\(csrfHeaderName, token\)/);
  assert.doesNotMatch(client, /csrfTokenCache|cachedCsrf/);
});
