#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertPublicSubmissionAbuseConfiguration,
  bookingSubmissionBodyLimits,
  buildPublicSubmissionScope,
  createPublicSubmissionProof,
  createPublicSubmissionRateLimitPolicies,
  escapeHtmlText,
  formSubmissionBodyLimits,
  getPublicSubmissionProof,
  getTrustedPublicSubmissionClientIp,
  hasPublicSubmissionHoneypotValue,
  normalizePublicSubmissionIdentifier,
  publicSubmissionActions,
  publicSubmissionControlFields,
  PublicSubmissionRequestError,
  readBoundedPublicSubmissionFormData,
  shouldSuppressPublicSubmissionExternalEffects,
  validatePublicSubmissionFieldRules,
  verifyPublicSubmissionProof,
} from "../src/lib/security/public-submission-abuse.ts";

const secret = "qa-public-abuse-secret-with-at-least-32-bytes-2026";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const resourceId = "22222222-2222-4222-8222-222222222222";
const nowSeconds = 1_800_000_000;

process.env.NOVALURE_ABUSE_SECRET = secret;

function proofFormData(proof) {
  const formData = new FormData();
  formData.set(publicSubmissionControlFields.idempotencyKey, proof.idempotencyKey);
  formData.set(publicSubmissionControlFields.issuedAt, String(proof.issuedAt));
  formData.set(publicSubmissionControlFields.expiresAt, String(proof.expiresAt));
  formData.set(publicSubmissionControlFields.proof, proof.signature);
  formData.set(publicSubmissionControlFields.honeypot, "");
  return formData;
}

test("submission proof is short-lived and bound to action, scope and random idempotency key", () => {
  const scope = buildPublicSubmissionScope({ resourceId, resourceType: "form", workspaceId });
  const proof = createPublicSubmissionProof({
    action: publicSubmissionActions.form,
    nowSeconds,
    scope,
    secret,
  });
  assert.match(proof.idempotencyKey, /^[A-Za-z0-9_-]{32,128}$/);
  assert.equal(proof.expiresAt - proof.issuedAt, 15 * 60);
  assert.deepEqual(
    verifyPublicSubmissionProof({
      action: publicSubmissionActions.form,
      nowSeconds: nowSeconds + 1,
      proof: getPublicSubmissionProof(proofFormData(proof)),
      scope,
      secret,
    }).ok,
    true,
  );
  assert.equal(
    verifyPublicSubmissionProof({
      action: publicSubmissionActions.booking,
      nowSeconds: nowSeconds + 1,
      proof,
      scope,
      secret,
    }).ok,
    false,
  );
  assert.equal(
    verifyPublicSubmissionProof({
      action: publicSubmissionActions.form,
      nowSeconds: nowSeconds + 1,
      proof,
      scope: `${scope}:other`,
      secret,
    }).ok,
    false,
  );
  assert.deepEqual(
    verifyPublicSubmissionProof({
      action: publicSubmissionActions.form,
      nowSeconds: proof.expiresAt + 1,
      proof,
      scope,
      secret,
    }),
    { ok: false, reason: "submission_proof_expired" },
  );
});

test("abuse secret has no fallback and must contain at least 32 bytes", () => {
  assert.throws(() => assertPublicSubmissionAbuseConfiguration({}), /NOVALURE_ABUSE_SECRET/);
  assert.throws(
    () => assertPublicSubmissionAbuseConfiguration({ NOVALURE_ABUSE_SECRET: "too-short" }),
    /at least 32 bytes/,
  );
  assert.equal(
    assertPublicSubmissionAbuseConfiguration({ NOVALURE_ABUSE_SECRET: secret }),
    secret,
  );
});

test("body reader enforces content type, actual byte size, charset and field limits", async () => {
  await assert.rejects(
    readBoundedPublicSubmissionFormData(
      new Request("https://crm.example/api/forms/submissions", {
        body: JSON.stringify({ email: "qa@example.test" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      formSubmissionBodyLimits,
    ),
    (error) => error instanceof PublicSubmissionRequestError && error.code === "unsupported_content_type",
  );

  await assert.rejects(
    readBoundedPublicSubmissionFormData(
      new Request("https://crm.example/api/meetings/bookings", {
        body: new URLSearchParams({ note: "x".repeat(100) }),
        headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
        method: "POST",
      }),
      { ...bookingSubmissionBodyLimits, maxBodyBytes: 20 },
    ),
    (error) => error instanceof PublicSubmissionRequestError && error.code === "submission_too_large",
  );

  const parsed = await readBoundedPublicSubmissionFormData(
    new Request("https://crm.example/api/meetings/bookings", {
      body: new URLSearchParams({ email: "qa@example.test", note: "Legitimate note" }),
      headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
      method: "POST",
    }),
    bookingSubmissionBodyLimits,
  );
  assert.equal(parsed.formData.get("email"), "qa@example.test");
  assert.match(parsed.requestFingerprint, /^[a-f0-9]{64}$/);
  assert.throws(
    () => validatePublicSubmissionFieldRules(parsed.formData, [{ maxLength: 5, name: "email" }]),
    /unknown_submission_field|submission_field_too_long/,
  );
});

test("multipart files require an allowlisted type, extension and matching magic bytes", async () => {
  const valid = new FormData();
  valid.set("document", new File([Buffer.from("%PDF-1.7\nqa")], "qa.pdf", { type: "application/pdf" }));
  const parsed = await readBoundedPublicSubmissionFormData(
    new Request("https://crm.example/api/forms/submissions", { body: valid, method: "POST" }),
    formSubmissionBodyLimits,
  );
  assert.equal(parsed.formData.get("document")?.name, "qa.pdf");

  const forged = new FormData();
  forged.set("document", new File([Buffer.from("<script>alert(1)</script>")], "qa.pdf", { type: "application/pdf" }));
  await assert.rejects(
    readBoundedPublicSubmissionFormData(
      new Request("https://crm.example/api/forms/submissions", { body: forged, method: "POST" }),
      formSubmissionBodyLimits,
    ),
    (error) => error instanceof PublicSubmissionRequestError && error.code === "file_signature_invalid",
  );
});

test("honeypot, trusted Vercel IP and opaque rate keys fail closed without storing PII", () => {
  const formData = new FormData();
  formData.set(publicSubmissionControlFields.honeypot, "bot-company");
  assert.equal(hasPublicSubmissionHoneypotValue(formData), true);

  const trustedHeaders = new Headers({
    "x-forwarded-for": "203.0.113.99",
    "x-vercel-forwarded-for": "2001:0db8:0:0:0:0:0:1",
  });
  assert.equal(
    getTrustedPublicSubmissionClientIp(trustedHeaders, { VERCEL: "1" }),
    "[2001:db8::1]".replace(/^\[|\]$/g, ""),
  );
  assert.equal(
    getTrustedPublicSubmissionClientIp(new Headers({ "x-forwarded-for": "203.0.113.99" }), {
      VERCEL: "1",
    }),
    null,
  );

  const email = normalizePublicSubmissionIdentifier(" QA.User@Example.Test ", "email");
  const policies = createPublicSubmissionRateLimitPolicies({
    action: publicSubmissionActions.form,
    clientIp: "203.0.113.8",
    identifier: email,
    scope: `form:${workspaceId}:${resourceId}`,
    secret,
  });
  assert.equal(policies.length, 3);
  for (const policy of policies) {
    assert.match(policy.keyHash, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(policy.keyHash, /example|203\.0\.113/u);
  }
});

test("QA/preview mode suppresses external effects and HTML escaping neutralizes event markup", () => {
  assert.equal(
    shouldSuppressPublicSubmissionExternalEffects({ env: { NODE_ENV: "test" }, workspaceId }),
    true,
  );
  assert.equal(
    shouldSuppressPublicSubmissionExternalEffects({
      env: { NODE_ENV: "production", VERCEL_ENV: "preview" },
      workspaceId,
    }),
    true,
  );
  assert.equal(
    shouldSuppressPublicSubmissionExternalEffects({
      env: { NODE_ENV: "production", VERCEL_ENV: "production" },
      workspaceId,
    }),
    false,
  );
  const escaped = escapeHtmlText('<img src=x onerror="alert(1)">&');
  assert.equal(escaped, "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;");
  assert.doesNotMatch(escaped, /<|>|"|'/u);
});

test("source and migration preserve atomic claim/rate/slot concurrency ordering", async () => {
  const [bookingRoute, formRoute, repository, migration, slotMigration, meetingRepository, instrumentation] = await Promise.all([
    readFile(new URL("../src/app/api/meetings/bookings/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/app/api/forms/submissions/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/db/public-submission-abuse-repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../migrations/055_public_submission_abuse_guards.sql", import.meta.url), "utf8"),
    readFile(new URL("../migrations/008_meeting_calendar_integrations.sql", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/db/meeting-repositories.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/instrumentation.ts", import.meta.url), "utf8"),
  ]);

  assert.ok(
    bookingRoute.indexOf("await claimPublicSubmissionIdempotency") <
      bookingRoute.indexOf("await createMeetingBookingWithNotifications"),
  );
  assert.ok(
    formRoute.indexOf("await claimPublicSubmissionIdempotency") <
      formRoute.indexOf("await persistWebsiteFormSubmission"),
  );
  assert.match(repository, /on conflict \(idempotency_hash\) do nothing/);
  assert.match(repository, /existing\.request_hash <> \$4/);
  assert.match(repository, /on conflict \(key_hash, bucket_started_at\) do update/);
  assert.match(repository, /request_count\s*< least/);
  assert.match(migration, /idempotency_hash text primary key/);
  assert.match(migration, /primary key \(key_hash, bucket_started_at\)/);
  assert.match(migration, /request_hash text not null/);
  assert.doesNotMatch(migration, /\b(?:email|phone|ip_address|identifier)\s+text\b/iu);
  assert.match(slotMigration, /create unique index if not exists meeting_bookings_active_slot_idx/);
  assert.match(slotMigration, /where status in \('requested', 'confirmed', 'rescheduled'\)/);

  const createStart = meetingRepository.indexOf("export async function createMeetingBookingWithNotifications");
  const createEnd = meetingRepository.indexOf("export async function listMeetingBookingOverview", createStart);
  const createSource = meetingRepository.slice(createStart, createEnd);
  assert.ok(createSource.indexOf("if (input.suppressExternalEffects)") < createSource.indexOf("confirmMeetingBooking({"));
  assert.match(createSource, /duplicate\|unique/i);
  assert.match(meetingRepository, /escapeHtmlText\(booking\.contactNote\)/);
  assert.match(instrumentation, /assertPublicSubmissionAbuseConfiguration/);
  assert.match(instrumentation, /assertPublicSubmissionAbuseConfiguration\(\)/);
});

test("all three public renderers carry the same proof and honeypot contract", async () => {
  const [bookingPage, formRenderer, staticRenderer, embedRoute, contract] = await Promise.all([
    readFile(new URL("../src/app/book/public-booking-page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/form-renderer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/form-renderer-static.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/app/forms/embed/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/public-submission-contract.ts", import.meta.url), "utf8"),
  ]);

  for (const fieldName of Object.values(publicSubmissionControlFields)) {
    assert.match(contract, new RegExp(fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(bookingPage, /createPublicSubmissionProof/);
  assert.match(bookingPage, /publicSubmissionControlFields\.honeypot/);
  assert.match(formRenderer, /PublicSubmissionProofInputs/);
  assert.match(formRenderer, /publicSubmissionControlFields\.honeypot/);
  assert.match(staticRenderer, /submissionProof\.signature/);
  assert.match(staticRenderer, /publicSubmissionControlFields\.honeypot/);
  assert.match(embedRoute, /"cache-control": "private, no-store"/);
});
