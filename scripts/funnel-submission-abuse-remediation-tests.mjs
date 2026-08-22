#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildFunnelSubmissionRequest } from "../src/lib/funnel-submission-request.ts";
import { getFunnelConsentCategories } from "../src/lib/funnel-consent.js";
import {
  buildPublicContactIdentityLocks,
  normalizePublicContactEmail,
  normalizePublicContactPhone,
  publicContactIdentityLockNamespace,
} from "../src/lib/security/public-contact-identity.ts";
import {
  canonicalizeFunnelSubmissionPayload,
  FunnelSubmissionValidationError,
  resolveCanonicalFunnelSubmissionSemantics,
  scoreCanonicalFunnelAnswers,
  validateFunnelBlueprintSubmissionContract,
} from "../src/lib/funnel-submission-validation.ts";
import {
  buildPublicSubmissionScope,
  createFunnelSubmissionDomainIdempotencyHash,
  createPublicSubmissionProof,
  funnelSubmissionBodyLimits,
  publicSubmissionActions,
  PublicSubmissionRequestError,
  readBoundedPublicSubmissionJson,
  verifyPublicSubmissionProof,
} from "../src/lib/security/public-submission-abuse.ts";

const secret = "qa-funnel-abuse-secret-with-at-least-32-bytes-2026";
const workspaceId = "11111111-1111-4111-8111-111111111111";
const funnelId = "22222222-2222-4222-8222-222222222222";
const submissionIntentId = "33333333-3333-4333-8333-333333333333";

process.env.NOVALURE_ABUSE_SECRET = secret;

const blueprint = {
  id: funnelId,
  pages: [{
    sections: [{
      rows: [{
        columns: [{
          elements: [{
            fields: [
              {
                crmField: "email",
                id: "field-email",
                label: "Email",
                options: [],
                required: true,
                type: "email",
              },
              {
                crmField: "privacy",
                id: "field-privacy",
                label: "Privacy",
                options: [],
                required: true,
                type: "consent",
              },
              {
                crmField: "budget",
                id: "field-budget",
                label: "Budget",
                max: 1_000_000,
                min: 0,
                options: [],
                required: false,
                type: "number",
              },
            ],
            id: "form-element",
            name: "Lead form",
            type: "form",
          }],
        }],
      }],
    }],
  }],
};

function payload(answers) {
  return {
    answers,
    consent: { analytics: false, marketing: false, privacy: true },
    funnelId,
    mode: "live",
    visitor: {},
  };
}

test("funnel proof is short-lived and bound to the exact funnel workspace scope", () => {
  const scope = buildPublicSubmissionScope({ resourceId: funnelId, resourceType: "funnel", workspaceId });
  const proof = createPublicSubmissionProof({
    action: publicSubmissionActions.funnel,
    nowSeconds: 1_800_000_000,
    scope,
    secret,
  });

  assert.equal(
    verifyPublicSubmissionProof({
      action: publicSubmissionActions.funnel,
      nowSeconds: 1_800_000_001,
      proof,
      scope,
      secret,
    }).ok,
    true,
  );
  assert.equal(
    verifyPublicSubmissionProof({
      action: publicSubmissionActions.form,
      nowSeconds: 1_800_000_001,
      proof,
      scope,
      secret,
    }).ok,
    false,
  );
});

test("bounded JSON reader rejects unsupported and oversized funnel bodies", async () => {
  const validRequest = new Request(`https://crm.example/api/funnels/${funnelId}/submissions`, {
    body: JSON.stringify(payload({ email: "qa@example.test", privacy: true })),
    headers: { "content-type": "application/json; charset=utf-8" },
    method: "POST",
  });
  const parsed = await readBoundedPublicSubmissionJson(validRequest, funnelSubmissionBodyLimits);
  assert.equal(parsed.value.funnelId, funnelId);
  assert.match(parsed.requestFingerprint, /^[a-f0-9]{64}$/u);

  await assert.rejects(
    readBoundedPublicSubmissionJson(
      new Request(`https://crm.example/api/funnels/${funnelId}/submissions`, {
        body: "email=qa%40example.test",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      }),
      funnelSubmissionBodyLimits,
    ),
    (error) => error instanceof PublicSubmissionRequestError && error.code === "unsupported_content_type",
  );
  await assert.rejects(
    readBoundedPublicSubmissionJson(
      new Request(`https://crm.example/api/funnels/${funnelId}/submissions`, {
        body: JSON.stringify({ value: "x".repeat(200) }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      { maxBodyBytes: 32 },
    ),
    (error) => error instanceof PublicSubmissionRequestError && error.code === "submission_too_large",
  );
});

test("blueprint canonicalization scores an aliased email once and rejects injected answers", () => {
  const canonical = canonicalizeFunnelSubmissionPayload(
    blueprint,
    payload({
      "field-email": "qa@example.test",
      email: "qa@example.test",
      "field-privacy": true,
      privacy: true,
    }),
  );
  assert.deepEqual(canonical.answers, { email: "qa@example.test", privacy: true });
  assert.equal(scoreCanonicalFunnelAnswers(canonical.answers), 15);

  assert.throws(
    () => canonicalizeFunnelSubmissionPayload(
      blueprint,
      payload({
        email: "qa@example.test",
        injected_score: 999_999,
        privacy: true,
      }),
    ),
    (error) => error instanceof FunnelSubmissionValidationError && error.code === "unknown_funnel_answer",
  );
  assert.throws(
    () => canonicalizeFunnelSubmissionPayload(
      blueprint,
      payload({
        "field-email": "first@example.test",
        email: "second@example.test",
        privacy: true,
      }),
    ),
    (error) => error instanceof FunnelSubmissionValidationError && error.code === "funnel_answer_alias_conflict",
  );
});

test("required and typed blueprint fields fail closed", () => {
  assert.throws(
    () => canonicalizeFunnelSubmissionPayload(blueprint, payload({ email: "", privacy: true })),
    (error) => error instanceof FunnelSubmissionValidationError && error.status === 422,
  );
  assert.throws(
    () => canonicalizeFunnelSubmissionPayload(
      blueprint,
      payload({ budget: "unbounded", email: "qa@example.test", privacy: true }),
    ),
    (error) => error instanceof FunnelSubmissionValidationError && error.code === "invalid_funnel_field_type",
  );

  for (const [type, invalidValue, expectedCode] of [
    ["phone", "123", "invalid_funnel_phone"],
    ["url", "javascript:alert(1)", "invalid_funnel_url"],
    ["date", "2026-02-31", "invalid_funnel_date"],
    ["time", "25:00", "invalid_funnel_time"],
  ]) {
    const typedBlueprint = structuredClone(blueprint);
    typedBlueprint.pages[0].sections[0].rows[0].columns[0].elements[0].fields.push({
      crmField: `typed_${type}`,
      id: `field-${type}`,
      label: type,
      options: [],
      required: false,
      type,
    });
    assert.throws(
      () => canonicalizeFunnelSubmissionPayload(
        typedBlueprint,
        payload({ email: "qa@example.test", privacy: true, [`typed_${type}`]: invalidValue }),
      ),
      (error) => error instanceof FunnelSubmissionValidationError && error.code === expectedCode,
    );
  }
});

test("consent is derived from canonical consent answers and forged top-level flags fail closed", () => {
  const valid = canonicalizeFunnelSubmissionPayload(
    blueprint,
    payload({ email: "qa@example.test", privacy: true }),
  );
  assert.deepEqual(valid.consent, { analytics: false, marketing: false, privacy: true });

  for (const forgedConsent of [
    { analytics: true, marketing: false, privacy: true },
    { analytics: false, marketing: true, privacy: true },
    { analytics: false, marketing: false, privacy: false },
  ]) {
    assert.throws(
      () => canonicalizeFunnelSubmissionPayload(
        blueprint,
        { ...payload({ email: "qa@example.test", privacy: true }), consent: forgedConsent },
      ),
      (error) => error instanceof FunnelSubmissionValidationError && error.code === "funnel_consent_mismatch",
    );
  }
});

test("marketing and analytics consent cannot impersonate required privacy consent", () => {
  assert.deepEqual(
    getFunnelConsentCategories({ crmField: "marketing_consent", label: "Newsletter consent" }),
    { analytics: false, marketing: true, privacy: false },
  );
  assert.deepEqual(
    getFunnelConsentCategories({ crmField: "analytics_consent", label: "Tracking consent" }),
    { analytics: true, marketing: false, privacy: false },
  );
  assert.deepEqual(
    getFunnelConsentCategories({ crmField: "consent", label: "Einwilligung" }),
    { analytics: false, marketing: false, privacy: true },
  );
});

test("custom CRM aliases preserve typed identities and conflicting identity fields fail closed", () => {
  const customBlueprint = structuredClone(blueprint);
  const fields = customBlueprint.pages[0].sections[0].rows[0].columns[0].elements[0].fields;
  fields[0].crmField = "internal_email_alias";
  fields.push(
    {
      crmField: "internal_phone_alias",
      id: "field-phone",
      label: "Telephone",
      options: [],
      required: false,
      type: "phone",
    },
    {
      crmField: "internal_contact_alias",
      id: "field-name",
      label: "Full name",
      options: [],
      required: false,
      type: "text",
    },
  );

  const canonical = canonicalizeFunnelSubmissionPayload(
    customBlueprint,
    payload({
      "field-email": "QA@Example.Test",
      "field-name": "Ada Lovelace",
      "field-phone": "+43 660 123456",
      "field-privacy": true,
    }),
  );
  assert.deepEqual(
    resolveCanonicalFunnelSubmissionSemantics(customBlueprint, canonical.answers),
    {
      budget: "",
      contactName: "Ada Lovelace",
      email: "QA@Example.Test",
      intent: "",
      phone: "+43 660 123456",
    },
  );

  fields.push({
    crmField: "secondary_email_alias",
    id: "field-email-secondary",
    label: "Alternative email",
    options: [],
    required: false,
    type: "email",
  });
  assert.throws(
    () => canonicalizeFunnelSubmissionPayload(
      customBlueprint,
      payload({
        "field-email": "first@example.test",
        "field-email-secondary": "second@example.test",
        "field-privacy": true,
      }),
    ),
    (error) => error instanceof FunnelSubmissionValidationError && error.code === "multiple_funnel_email_values",
  );
});

test("public contact identity locks normalize and order every channel identically", () => {
  assert.equal(publicContactIdentityLockNamespace, "public_contact_identity");
  assert.equal(normalizePublicContactEmail(" QA@Example.Test "), "qa@example.test");
  assert.equal(normalizePublicContactPhone("+43 (660) 123-456"), "+43660123456");
  assert.deepEqual(
    buildPublicContactIdentityLocks({
      email: " QA@Example.Test ",
      fallback: "fallback",
      phone: "+43 (660) 123-456",
    }),
    ["email:qa@example.test", "phone:+43660123456"],
  );
  assert.deepEqual(
    buildPublicContactIdentityLocks({ fallback: "fallback" }),
    ["submission:fallback"],
  );
});

test("blueprint submission contract rejects duplicate public or CRM aliases before publish", () => {
  const conflictingBlueprint = structuredClone(blueprint);
  conflictingBlueprint.pages[0].sections[0].rows[0].columns[0].elements[0].fields.push({
    crmField: "email",
    id: "field-secondary",
    label: "Secondary",
    options: [],
    required: false,
    type: "text",
  });
  assert.throws(
    () => validateFunnelBlueprintSubmissionContract(conflictingBlueprint),
    (error) => error instanceof FunnelSubmissionValidationError && error.code === "funnel_blueprint_field_alias_conflict",
  );
});

test("actual renderer request carries proof and never forwards the publish token", () => {
  const proof = createPublicSubmissionProof({
    action: publicSubmissionActions.funnel,
    scope: buildPublicSubmissionScope({ resourceId: funnelId, resourceType: "funnel", workspaceId }),
    secret,
  });
  const request = buildFunnelSubmissionRequest({
    answers: { email: "qa@example.test", privacy: true },
    consent: { analytics: false, marketing: false, privacy: true },
    funnelId,
    honeypot: "",
    intentId: submissionIntentId,
    mode: "live",
    proof,
    visitor: {
      sourceUrl: `https://crm.example/preview/${funnelId}?lang=en&token=do-not-forward#private-fragment`,
    },
  });
  const body = JSON.parse(request.init.body);

  assert.equal(request.endpoint, `/api/funnels/${funnelId}/submissions`);
  assert.deepEqual(request.init.headers, { "content-type": "application/json" });
  assert.equal(body.publicSubmission.proof.idempotencyKey, proof.idempotencyKey);
  assert.equal(body.publicSubmission.intentId, submissionIntentId);
  assert.equal(body.visitor.sourceUrl, `https://crm.example/preview/${funnelId}?lang=en`);
  assert.doesNotMatch(request.init.body, /do-not-forward|private-fragment/u);
  assert.doesNotMatch(request.endpoint, /token/u);
  assert.equal(Object.keys(request.init.headers).some((key) => /token/i.test(key)), false);
});

test("commit-before-completion recovers the same domain submission after a refreshed proof", async () => {
  const scope = buildPublicSubmissionScope({ resourceId: funnelId, resourceType: "funnel", workspaceId });
  const firstProof = createPublicSubmissionProof({ action: publicSubmissionActions.funnel, scope, secret });
  const refreshedProof = createPublicSubmissionProof({ action: publicSubmissionActions.funnel, scope, secret });
  const firstHash = createFunnelSubmissionDomainIdempotencyHash({
    intentId: submissionIntentId,
    requestFingerprint: "same-canonical-payload",
    scope,
    secret,
  });
  const refreshedHash = createFunnelSubmissionDomainIdempotencyHash({
    intentId: submissionIntentId,
    requestFingerprint: "same-canonical-payload",
    scope,
    secret,
  });
  const committed = new Map();

  async function persistWithInjectedCompletionFailure(proof, failAfterCommit) {
    assert.ok(proof.idempotencyKey);
    const existing = committed.get(firstHash);
    const row = existing ?? { contactId: "contact-1", submissionId: "submission-1" };
    committed.set(firstHash, row);
    if (failAfterCommit) throw new Error("injected_completion_failure");
    return row;
  }

  await assert.rejects(persistWithInjectedCompletionFailure(firstProof, true), /injected_completion_failure/);
  const replay = await persistWithInjectedCompletionFailure(refreshedProof, false);
  assert.equal(firstHash, refreshedHash);
  assert.deepEqual(replay, { contactId: "contact-1", submissionId: "submission-1" });
  assert.equal(committed.size, 1);
});

test("route orders abuse controls before the single atomic and recoverable CRM write", async () => {
  const [route, renderer, preview, repository, claimRepository, migration, runner, livePreflight, blueprintRoute, funnelStore] = await Promise.all([
    readFile(new URL("../src/app/api/funnels/[funnelId]/submissions/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/components/funnel-renderer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/preview/[funnelId]/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/db/runtime-repositories.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/db/public-submission-abuse-repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../migrations/070_funnel_submission_idempotency_recovery.sql", import.meta.url), "utf8"),
    readFile(new URL("../scripts/db-migrate.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/funnel-live-preflight.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/app/api/funnels/[funnelId]/blueprint/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/funnel-store.ts", import.meta.url), "utf8"),
  ]);

  assert.ok(route.indexOf("readBoundedPublicSubmissionJson") < route.indexOf("getStoredFunnel(funnelId"));
  assert.ok(route.indexOf("canonicalizeFunnelSubmissionPayload") < route.indexOf("scoreCanonicalFunnelAnswers"));
  assert.ok(route.lastIndexOf("runFunnelLivePreflight(blueprint)") < route.lastIndexOf("canonicalizeFunnelSubmissionPayload(blueprint, payload)"));
  assert.match(livePreflight, /field\.type === "consent"[\s\S]*field\.required[\s\S]*getFunnelConsentCategories\(field\)\.privacy/);
  assert.match(livePreflight, /single_form_runtime_required/);
  assert.match(livePreflight, /conditional_required_runtime_unsupported/);
  assert.match(livePreflight, /device_hidden_required_runtime_unsupported/);
  assert.match(livePreflight, /file_field_runtime_unavailable/);
  assert.match(livePreflight, /custom_pattern_runtime_unavailable/);
  assert.match(livePreflight, /validateFunnelBlueprintSubmissionContract/);
  assert.match(blueprintRoute, /runFunnelLivePreflight\(body\.blueprint\)/);
  assert.match(blueprintRoute, /restoreStoredFunnelVersion[\s\S]*FunnelLivePreflightError/);
  assert.match(funnelStore, /assertFunnelLivePreflight\(blueprint\)[\s\S]*saveStoredFunnelToDatabase/);
  assert.match(route, /getFunnelSubmissionIdentifier\(blueprint, payload/);
  assert.ok(route.lastIndexOf("claimPublicSubmissionIdempotency") < route.lastIndexOf("consumePublicSubmissionRateLimits"));
  assert.ok(route.lastIndexOf("consumePublicSubmissionRateLimits") < route.lastIndexOf("persistFunnelSubmission({"));
  assert.match(route, /completePublicSubmissionIdempotency/);
  assert.match(route, /submissionIdempotencyHash: domainIdempotencyHash/);
  assert.match(route, /claim\.state === "processing"[\s\S]*findPersistedFunnelSubmissionByIdempotency/);
  assert.match(route, /leaseVersion: claim\.leaseVersion/);
  assert.doesNotMatch(route, /getRequestToken|x-novalure-funnel-token|x-funnel-token/u);
  assert.match(preview, /action: publicSubmissionActions\.funnel/);
  assert.match(preview, /resourceType: "funnel"/);
  assert.match(renderer, /buildFunnelSubmissionRequest/);
  assert.match(renderer, /apiFetch\(submissionRequest\.endpoint, submissionRequest\.init\)/);
  assert.match(renderer, /getOrCreateFunnelSubmissionIntentId/);
  assert.match(renderer, /publicSubmissionControlFields\.honeypot/);
  assert.doesNotMatch(renderer, /x-novalure-funnel-token|x-funnel-token/u);

  const start = repository.indexOf("export async function persistFunnelSubmission");
  const end = repository.indexOf("export async function persistFunnelTestSubmission", start);
  const livePersistence = repository.slice(start, end);
  assert.equal((livePersistence.match(/transaction\.queryOne</gu) ?? []).length, 1);
  assert.match(livePersistence, /withTenantTransaction/);
  assert.match(livePersistence, /resolveCanonicalFunnelSubmissionSemantics/);
  assert.doesNotMatch(livePersistence, /getAnswerString/);
  assert.match(livePersistence, /pg_advisory_xact_lock[\s\S]*publicContactIdentityLockNamespace/);
  assert.match(livePersistence, /buildPublicContactIdentityLocks/);
  assert.match(livePersistence, /normalizePublicContactEmail[\s\S]*normalizePublicContactPhone/);
  assert.match(livePersistence, /count\(distinct id\) > 1[\s\S]*normalized_email <> \$3::text/);
  assert.match(livePersistence, /Funnel contact identity conflict/);
  assert.match(livePersistence, /updated_contact[\s\S]*email = coalesce[\s\S]*phone = coalesce/);
  assert.ok(
    livePersistence.indexOf("await transaction.execute(")
      < livePersistence.indexOf("transaction.queryOne<FunnelSubmissionPersistenceRow>"),
  );
  for (const cte of [
    "selected_funnel",
    "inserted_contact",
    "inserted_lead",
    "inserted_submission",
    "inserted_deal",
    "inserted_privacy_consent",
    "inserted_task",
    "inserted_timeline",
    "updated_funnel",
    "inserted_audit",
    "inserted_funnel_analytics",
    "inserted_speed_to_lead",
  ]) {
    assert.match(livePersistence, new RegExp(`\\b${cte}\\b`, "u"));
  }
  assert.match(livePersistence, /for update/);
  assert.match(livePersistence, /and status = 'aktiv'/);
  assert.match(livePersistence, /jsonb_typeof\(blueprint->'blueprint'->'pages'\) = 'array'/);
  assert.match(livePersistence, /submissionIdempotencyHash/);
  assert.match(livePersistence, /existing_submission/);
  assert.match(livePersistence, /idempotency_key/);
  assert.match(repository, /findPersistedFunnelSubmissionByIdempotency/);
  assert.doesNotMatch(livePersistence, /Promise\.all|findSubmissionFunnel\(/u);
  assert.match(claimRepository, /existing\.expires_at <= now\(\)/);
  assert.match(claimRepository, /lease_version = existing\.lease_version \+ 1/);
  assert.match(claimRepository, /and \$5::boolean/);
  assert.match(claimRepository, /when \$5::boolean then interval '2 minutes'/);
  assert.match(claimRepository, /else interval '24 hours'/);
  assert.match(claimRepository, /lease_version = \$4::bigint/);
  assert.doesNotMatch(claimRepository, /leaseVersion\?: number/);
  assert.match(claimRepository, /value: publicSubmissionActions\.funnel/);
  assert.match(route, /allowLeaseReclaim: true/);
  assert.match(migration, /funnel_submissions_workspace_idempotency_key_uidx/);
  assert.match(migration, /lease_version bigint not null default 1/);
  assert.match(runner, /\["070_funnel_submission_idempotency_recovery", "055_public_submission_abuse_guards"\]/);
});
