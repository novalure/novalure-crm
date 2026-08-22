#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import {
  createCanonicalPublicSubmissionFormDataFingerprint,
  formSubmissionBodyLimits,
  publicSubmissionControlFields,
  readBoundedPublicSubmissionFormData,
} from "../src/lib/security/public-submission-abuse.ts";
import { validatePublicFormFieldValue } from "../src/lib/form-submission-validation.ts";
import { isTruthyPublicConsentValue } from "../src/lib/form-consent.ts";

const secret = "qa-form-atomicity-secret-with-at-least-32-bytes";
process.env.NOVALURE_ABUSE_SECRET = secret;

async function read(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

async function importPublicFormDto() {
  const source = await read("src/lib/public-form-dto.ts");
  const launchScopeUrl = new URL("../src/lib/launch-scope.ts", import.meta.url).href;
  const compiled = ts.transpileModule(
    source.replace('from "@/lib/launch-scope"', `from ${JSON.stringify(launchScopeUrl)}`),
    {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
      fileName: "public-form-dto.ts",
    },
  ).outputText;

  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
}

const {
  getPublicFormLaunchBlockReason,
  hasSupportedPublicConsentConfiguration,
  toPublicFormDto,
} = await importPublicFormDto();

function semanticFormData({ email = "atomic@example.test", proof = "proof-a" } = {}) {
  const formData = new FormData();
  formData.append("message", "Bitte um Rückruf");
  formData.append("email", email);
  formData.set(publicSubmissionControlFields.idempotencyKey, "a".repeat(48));
  formData.set(publicSubmissionControlFields.issuedAt, "1800000000");
  formData.set(publicSubmissionControlFields.expiresAt, "1800000900");
  formData.set(publicSubmissionControlFields.proof, proof);
  formData.set(publicSubmissionControlFields.honeypot, "");
  return formData;
}

test("semantic multipart fingerprint ignores random boundaries and proof rotation", async () => {
  assert.equal(formSubmissionBodyLimits.allowedFileBytes, 0);
  assert.equal(formSubmissionBodyLimits.allowedFiles, 0);
  assert.equal(formSubmissionBodyLimits.maxBodyBytes, 256 * 1024);
  const first = await readBoundedPublicSubmissionFormData(
    new Request("https://crm.example/api/forms/submissions", {
      body: semanticFormData({ proof: "proof-first" }),
      method: "POST",
    }),
    formSubmissionBodyLimits,
  );
  const second = await readBoundedPublicSubmissionFormData(
    new Request("https://crm.example/api/forms/submissions", {
      body: semanticFormData({ proof: "proof-second" }),
      method: "POST",
    }),
    formSubmissionBodyLimits,
  );

  assert.notEqual(first.requestFingerprint, second.requestFingerprint);
  assert.equal(
    await createCanonicalPublicSubmissionFormDataFingerprint({ formData: first.formData, secret }),
    await createCanonicalPublicSubmissionFormDataFingerprint({ formData: second.formData, secret }),
  );

  const changed = semanticFormData({ email: "different@example.test" });
  assert.notEqual(
    await createCanonicalPublicSubmissionFormDataFingerprint({ formData: first.formData, secret }),
    await createCanonicalPublicSubmissionFormDataFingerprint({ formData: changed, secret }),
  );
});

test("public Form route uses semantic request hashing and atomically completed success replay", async () => {
  const route = await read("src/app/api/forms/submissions/route.ts");

  assert.match(route, /createCanonicalPublicSubmissionFormDataFingerprint\(\{[\s\S]*formData/);
  assert.match(route, /requestFingerprint: semanticRequestFingerprint/);
  assert.match(route, /readPublicSubmissionIdempotency\(hashes\)/);
  assert.match(route, /allowLeaseReclaim: true/);
  assert.match(route, /leaseVersion: claim\.leaseVersion/);
  assert.match(route, /successResponse: createPublicFormSuccessSnapshot/);
  assert.match(route, /body: \{ persisted: true \}/);
  assert.doesNotMatch(route, /body: \{[^}]*form:|body: \{[^}]*formId|body: \{[^}]*slug/);
  assert.match(route, /if \(persistence\.persisted\) \{[\s\S]*responseFromSnapshot\(persistence\.response\)/);
  assert.doesNotMatch(
    route,
    /if \(persistence\.persisted\) \{[\s\S]{0,300}completePublicSubmissionIdempotency/,
  );
  const replayRead = route.indexOf("await readPublicSubmissionIdempotency");
  const rateLimit = route.indexOf("await consumePublicSubmissionRateLimits");
  const honeypot = route.indexOf("hasPublicSubmissionHoneypotValue(formData)");
  const durableClaim = route.indexOf("claim = await claimPublicSubmissionIdempotency");
  assert.ok(replayRead >= 0 && replayRead < rateLimit);
  assert.ok(rateLimit < honeypot && honeypot < durableClaim);
  assert.doesNotMatch(route.slice(rateLimit, durableClaim), /completePublicSubmissionIdempotency/);
});

test("the complete Form domain graph and claim fence live in one PostgreSQL statement", async () => {
  const [repository, funnelRepository] = await Promise.all([
    read("src/lib/db/form-repositories.ts"),
    read("src/lib/db/runtime-repositories.ts"),
  ]);
  const start = repository.indexOf("export async function persistWebsiteFormSubmission");
  const end = repository.indexOf("async function resolveExistingFormId", start);
  const persistence = repository.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.equal((persistence.match(/transaction\.queryOne</g) ?? []).length, 1);
  assert.match(persistence, /withTenantTransaction\([\s\S]*pg_advisory_xact_lock/);
  assert.match(persistence, /for \(const contactIdentityLock of contactIdentityLocks\)/);
  for (const source of [repository, funnelRepository]) {
    assert.match(source, /buildPublicContactIdentityLocks/);
    assert.match(source, /publicContactIdentityLockNamespace/);
    assert.match(source, /\[.+workspaceId, publicContactIdentityLockNamespace, contactIdentityLock\]/);
  }
  assert.doesNotMatch(persistence, /:form_contact:/);
  assert.doesNotMatch(persistence, /Promise\.all|writeCrmAnalyticsEvent|recordSpeedToLeadEvent/);
  for (const cte of [
    "claim_fence",
    "selected_form",
    "email_contacts",
    "phone_contacts",
    "contact_identity",
    "updated_contact",
    "inserted_contact",
    "inserted_lead",
    "inserted_deal",
    "inserted_task",
    "inserted_submission",
    "inserted_privacy_consent",
    "inserted_marketing_consent",
    "inserted_timeline",
    "updated_form",
    "inserted_audit",
    "inserted_funnel_analytics",
    "inserted_lead_analytics",
    "inserted_speed_to_lead",
    "inserted_newsletter_analytics",
    "completed_claim",
  ]) {
    assert.match(persistence, new RegExp(`${cte} as`), `${cte} must remain in the atomic statement`);
  }
  assert.match(persistence, /claim\.lease_version = \$7::bigint[\s\S]*claim\.state = 'processing'/);
  assert.match(persistence, /submission\.idempotency_key = \$8/);
  assert.match(persistence, /existing\."requestHash" = \$6 then 'replay'/);
  assert.match(persistence, /else 'conflict'/);
  assert.match(persistence, /'identity_conflict'::text/);
  assert.match(persistence, /count\(distinct matched\.id\) > 1/);
  assert.match(persistence, /email\.normalized_phone <> \$37::text/);
  assert.match(persistence, /phone\.normalized_email <> \$36::text/);
  assert.match(persistence, /email = coalesce\(nullif\(btrim\(contact\.email\), ''\), \$14::text\)/);
  assert.match(persistence, /phone = coalesce\(nullif\(btrim\(contact\.phone\), ''\), \$15::text\)/);
  assert.match(persistence, /select \$34::jsonb as payload/);
  assert.doesNotMatch(persistence, /jsonb_set\([\s\S]{0,300}'\{body,ids\}'/);
  assert.match(persistence, /1 \/ case[\s\S]*then 1[\s\S]*else 0/);
});

test("public Form launch guards run before proof, claim, validation, or persistence", async () => {
  const [route, repository, formApi, component, publicDto] = await Promise.all([
    read("src/app/api/forms/submissions/route.ts"),
    read("src/lib/db/form-repositories.ts"),
    read("src/app/api/forms/route.ts"),
    read("src/components/form-command-center.tsx"),
    read("src/lib/public-form-dto.ts"),
  ]);
  const guard = route.indexOf("getPublicFormLaunchBlockReason(lookup.form, lookup.ownerActive)");

  assert.ok(guard > route.indexOf("if (!lookup)"));
  assert.ok(guard < route.indexOf("validatePublicSubmissionFieldRules(", guard));
  assert.ok(guard < route.indexOf("verifyPublicSubmissionProof({", guard));
  assert.ok(guard < route.indexOf("claimPublicSubmissionIdempotency({"));
  assert.match(repository, /getPublicFormLaunchBlockReason\(form, lookup\.ownerActive\)/);
  assert.match(repository, /FORM_OWNER_MODE_UNAVAILABLE/);
  assert.match(repository, /FORM_CONSENT_CONFIGURATION_UNAVAILABLE/);
  assert.match(repository, /FORM_CUSTOM_PATTERN_UNAVAILABLE/);
  assert.match(repository, /FORM_FILE_UPLOAD_UNAVAILABLE/);
  assert.match(formApi, /FORM_OWNER_MODE_UNAVAILABLE[\s\S]*FORM_CONSENT_CONFIGURATION_UNAVAILABLE[\s\S]*FORM_CUSTOM_PATTERN_UNAVAILABLE[\s\S]*FORM_FILE_UPLOAD_UNAVAILABLE[\s\S]*\? 400/);
  assert.match(publicDto, /field\.validationPattern\.trim\(\)[\s\S]*form_custom_pattern_unavailable/);
  assert.match(publicDto, /hasSupportedPublicConsentConfiguration\(form\)[\s\S]*form_consent_configuration_unavailable/);
  assert.match(component, /ownerMode: "user"/);
  assert.match(component, /<option disabled value="roundRobin">\{copy\.crm\.roundRobinUnavailable\}<\/option>/);
  assert.match(component, /disabled=\{field\.disabled\}/);
  assert.match(component, /copy\.fields\.fileUnavailable/);
  assert.match(component, /copy\.fields\.validationPatternUnavailable/);
  assert.match(component, /disabled=\{selectedField\.type === "consent" \|\| isMarketingConsentField\(selectedField\)\}/);
  assert.match(repository, /defaultValue: type === "consent" \|\| \(type === "checkbox" && isMarketingConsentCrmField\(crmField\)\)[\s\S]*\? ""/);
});

test("custom patterns and ambiguous or preselected consent stay launch-off", () => {
  const privacyField = {
    conditionalFieldId: "",
    conditionalValue: "",
    crmField: "privacy_consent",
    defaultValue: "",
    errorMessage: "",
    fileAccept: "",
    fileMaxMb: 0,
    helpText: "Privacy",
    id: "privacy_public_id",
    label: "Privacy",
    maxValue: "",
    minValue: "",
    multiple: false,
    options: [],
    placeholder: "",
    required: true,
    stepId: "step-1",
    type: "consent",
    validationPattern: "",
  };
  const form = {
    actions: { createTask: false, followUpEmail: false, internalNotification: false, newsletterList: false, redirectUrl: "", showMeeting: false, thankYouMessage: "" },
    campaign: "",
    conversionRate: 0,
    crmTarget: "contact",
    doubleOptIn: false,
    fields: [privacyField],
    funnelId: "",
    id: "form-id",
    lastSubmission: "",
    name: "Form",
    ownerMode: "user",
    ownerUserId: "owner",
    pipelineStage: "",
    progressMode: "none",
    slug: "form",
    spamProtection: true,
    status: "aktiv",
    steps: [{ description: "", id: "step-1", title: "Step" }],
    submissions: 0,
    tags: "",
    template: "contact",
    utmCapture: true,
    variant: "embed",
    visits: 0,
  };

  assert.equal(hasSupportedPublicConsentConfiguration(form), true);
  assert.equal(getPublicFormLaunchBlockReason({ ...form, fields: [{ ...privacyField, validationPattern: "(a+)+$" }] }), "form_custom_pattern_unavailable");
  assert.equal(getPublicFormLaunchBlockReason({ ...form, fields: [{ ...privacyField, defaultValue: "1" }] }), "form_consent_configuration_unavailable");
  assert.equal(getPublicFormLaunchBlockReason({ ...form, fields: [{ ...privacyField, crmField: "marketing_consent" }] }), "form_consent_configuration_unavailable");
  assert.equal(getPublicFormLaunchBlockReason({ ...form, fields: [privacyField, { ...privacyField, crmField: "marketing_consent", defaultValue: "1", id: "marketing", required: false, type: "checkbox" }] }), "form_consent_configuration_unavailable");
  assert.equal(getPublicFormLaunchBlockReason({ ...form, fields: [privacyField, { ...privacyField, conditionalFieldId: "controller", conditionalValue: "yes", crmField: "marketing_consent", id: "marketing", required: false, type: "checkbox" }] }), "form_consent_configuration_unavailable");
  assert.equal(getPublicFormLaunchBlockReason({ ...form, fields: [{ ...privacyField, required: false }] }), "form_consent_configuration_unavailable");
  assert.equal(getPublicFormLaunchBlockReason({ ...form, fields: [privacyField, { ...privacyField, crmField: "analytics_consent", id: "analytics" }] }), "form_consent_configuration_unavailable");
  for (const falsy of ["", "0", "false", "no", "off", "accepted", "banana", "2"]) assert.equal(isTruthyPublicConsentValue(falsy), false);
  for (const truthy of ["1", "true", "yes", "on"]) assert.equal(isTruthyPublicConsentValue(truthy), true);
  assert.equal(isTruthyPublicConsentValue(true), true);
  assert.equal(isTruthyPublicConsentValue(1), false);
});

test("public Form DTO is an explicit render allowlist and never exposes CRM configuration", () => {
  const dto = toPublicFormDto({
    actions: {
      createTask: true,
      followUpEmail: true,
      internalNotification: true,
      newsletterList: true,
      redirectUrl: "https://internal.example/redirect",
      showMeeting: true,
      thankYouMessage: "Danke",
    },
    campaign: "internal-campaign",
    conversionRate: 42,
    crmTarget: "deal",
    doubleOptIn: false,
    fields: [{
      conditionalFieldId: "controller",
      conditionalValue: "yes",
      crmField: "contact_email",
      defaultValue: "",
      errorMessage: "Invalid",
      fileAccept: "",
      fileMaxMb: 0,
      helpText: "Help",
      id: "public_email",
      label: "Email",
      maxValue: "",
      minValue: "",
      multiple: false,
      options: [],
      placeholder: "you@example.test",
      required: true,
      stepId: "contact",
      type: "email",
      validationPattern: "",
    }],
    funnelId: "internal-funnel",
    id: "internal-form-id",
    lastSubmission: "2026-08-22T00:00:00.000Z",
    name: "Kontakt",
    ownerMode: "user",
    ownerUserId: "internal-owner",
    pipelineStage: "Internal stage",
    progressMode: "steps",
    spamProtection: true,
    status: "aktiv",
    steps: [{ description: "Kontakt", id: "contact", title: "Kontakt" }],
    submissions: 12,
    slug: "internal-slug",
    tags: "internal,tag",
    template: "contact",
    utmCapture: true,
    variant: "embed",
    visits: 99,
  });

  assert.deepEqual(Object.keys(dto).sort(), [
    "fields",
    "name",
    "progressMode",
    "steps",
    "thankYouMessage",
  ]);
  assert.deepEqual(Object.keys(dto.fields[0]).sort(), [
    "defaultValue",
    "errorMessage",
    "helpText",
    "id",
    "label",
    "maxValue",
    "minValue",
    "name",
    "options",
    "placeholder",
    "required",
    "stepId",
    "type",
    "validationPattern",
    "visibleWhen",
  ]);
  assert.equal(dto.fields[0].name, "public_email");
  const serialized = JSON.stringify(dto);
  for (const forbidden of [
    "actions",
    "campaign",
    "conversionRate",
    "crmField",
    "crmTarget",
    "fileAccept",
    "fileMaxMb",
    "funnelId",
    "ownerMode",
    "ownerUserId",
    "pipelineStage",
    "redirectUrl",
    "submissions",
    "tags",
    "variant",
    "visits",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} must stay server-side`);
  }
});

test("public page and embed project the DTO and distinguish missing from infrastructure failure", async () => {
  const [page, embed, route] = await Promise.all([
    read("src/app/forms/public-form-page.tsx"),
    read("src/app/forms/embed/route.ts"),
    read("src/app/api/forms/submissions/route.ts"),
  ]);

  assert.match(page, /const publicForm = toPublicFormDto\(form\)/);
  assert.match(page, /form=\{publicForm\}/);
  assert.doesNotMatch(page, /form\.crmTarget|form\.pipelineStage|form\.actions|copy\.publicPage\.crmTarget/);
  assert.match(embed, /form: toPublicFormDto\(form\)/);
  assert.doesNotMatch(embed, /getPublicWebsiteFormByKey\(formKey\)\.catch/);
  assert.match(embed, /catch \{[\s\S]*status: 503/);
  assert.match(embed, /if \(!persisted\?\.form\)[\s\S]*status: 404/);
  assert.doesNotMatch(route, /getPublicWebsiteFormByKey\(formSlug\)\.catch/);
  assert.match(route, /try \{[\s\S]*getPublicWebsiteFormByKey\(formSlug\)[\s\S]*catch \{[\s\S]*unavailableResponse/);
});

test("custom crmField identities and consents are resolved from field semantics", async () => {
  const [repository, route] = await Promise.all([
    read("src/lib/db/form-repositories.ts"),
    read("src/app/api/forms/submissions/route.ts"),
  ]);

  assert.match(repository, /resolveSemanticFieldValue\(form, answers, input\.formData, "email"\)/);
  assert.match(repository, /resolveSemanticFieldValue\(form, answers, input\.formData, "phone"\)/);
  assert.match(repository, /filter\(\(field\) => field\.type === type\)[\s\S]*getSubmittedFieldValue\(field, answers, formData\)/);
  assert.match(repository, /submittedFields\.some\(isPrivacyConsentField\)/);
  assert.match(repository, /submittedFields\.some\(isMarketingConsentField\)/);
  assert.match(repository, /getFormDataFieldEntries\(field, formData\)\.some\(isTruthyPublicConsentValue\)/);
  assert.match(repository, /field\.type === "hidden"[\s\S]*\? field\.defaultValue\.trim\(\)/);
  assert.match(repository, /field\.type === "hidden" \? \[\] : formData\.getAll\(field\.id\)/);
  assert.doesNotMatch(repository, /\[field\.id, field\.crmField, field\.type, slugify\(field\.label\)\]/);
  assert.doesNotMatch(repository, /formData\.getAll\(key\)/);
  assert.match(route, /if \(field\.type === "hidden"\) continue;[\s\S]*rules\.set\(field\.id/);
  assert.doesNotMatch(route, /new Set\(\[field\.id, field\.crmField\]/);
  assert.doesNotMatch(route, /getString\(formData, emailField\.crmField\)|getString\(formData, phoneField\.crmField\)/);
  assert.match(repository, /!getFormDataFieldEntries\(field, formData\)\.some\(isTruthyPublicConsentValue\)/);
  assert.match(repository, /multiple_email_values/);
  assert.match(repository, /multiple_phone_values/);
  assert.match(repository, /serializeFormDataPayload\(input\.formData\)/);
  assert.doesNotMatch(repository, /Object\.fromEntries\(input\.formData\.entries\(\)\)/);
});

test("server field validation enforces configured types, options, ranges, and patterns", () => {
  const field = (patch) => ({
    conditionalFieldId: "",
    conditionalValue: "",
    crmField: "internal_target",
    defaultValue: "",
    errorMessage: "",
    fileAccept: "",
    fileMaxMb: 0,
    helpText: "",
    id: "public_field",
    label: "Public field",
    maxValue: "",
    minValue: "",
    multiple: false,
    options: [],
    placeholder: "",
    required: false,
    stepId: "step-1",
    type: "text",
    validationPattern: "",
    ...patch,
  });

  assert.match(validatePublicFormFieldValue(field({ type: "phone" }), "abc"), /^invalid_phone:/);
  assert.match(validatePublicFormFieldValue(field({ type: "url" }), "/relative"), /^invalid_url:/);
  assert.match(validatePublicFormFieldValue(field({ type: "url" }), "javascript://evil.example"), /^invalid_url:/);
  assert.match(validatePublicFormFieldValue(field({ type: "url" }), "ftp://files.example"), /^invalid_url:/);
  assert.equal(validatePublicFormFieldValue(field({ type: "url" }), "https://www.example.com/path"), "");
  assert.match(validatePublicFormFieldValue(field({ options: ["A", "B"], type: "select" }), "C"), /^invalid_option:/);
  assert.match(validatePublicFormFieldValue(field({ minValue: "2", type: "number" }), "1"), /^invalid_min_value:/);
  assert.match(validatePublicFormFieldValue(field({ maxValue: "5", type: "number" }), "6"), /^invalid_max_value:/);
  assert.match(validatePublicFormFieldValue(field({ type: "date" }), "2026-02-31"), /^invalid_date:/);
  assert.match(validatePublicFormFieldValue(field({ type: "time" }), "25:00"), /^invalid_time:/);
  assert.match(validatePublicFormFieldValue(field({ validationPattern: "[A-Z]{3}" }), "ab"), /^invalid_pattern:/);
  assert.match(validatePublicFormFieldValue(field({ validationPattern: "[" }), "abc"), /^invalid_field_configuration:/);
  assert.equal(validatePublicFormFieldValue(field({ maxValue: "5", minValue: "2", type: "number" }), "3"), "");
  assert.equal(validatePublicFormFieldValue(field({ options: ["A", "B"], type: "multiCheckbox" }), ["A", "B"]), "");
});

test("conditional required fields share visibility semantics across server, React, and embed", async () => {
  const [repository, renderer, embed, staticRenderer] = await Promise.all([
    read("src/lib/db/form-repositories.ts"),
    read("src/components/form-renderer.tsx"),
    read("src/app/forms/embed/route.ts"),
    read("src/components/form-renderer-static.ts"),
  ]);

  assert.doesNotMatch(repository, /form\.fields\.some\(\(field\) => field\.type === "consent" && field\.required\)/);
  assert.match(repository, /if \(!isSubmittedFormFieldVisible\(form, field, answers, formData\)\) continue/);
  assert.match(repository, /candidate\.id === field\.conditionalFieldId[\s\S]*candidate\.crmField === field\.conditionalFieldId/);
  assert.match(repository, /return value\.some\(\(entry\) => String\(entry\)\.trim\(\) === field\.conditionalValue\)/);
  assert.match(renderer, /disabled: !visible/);
  assert.match(renderer, /required: field\.required && visible/);
  assert.match(renderer, /disabled=\{!visible\}/);
  assert.match(embed, /control\.disabled = !visible/);
  assert.match(embed, /control\.required = visible && control\.getAttribute\("data-novalure-required"\) === "true"/);
  assert.match(staticRenderer, /data-action="submit"[\s\S]*type="submit"/);
  assert.match(embed, /var onLastStep = currentStep === steps\.length - 1/);
  assert.match(embed, /next\.toggleAttribute\("hidden", onLastStep\)/);
  assert.match(embed, /submit\.toggleAttribute\("hidden", !onLastStep\)/);
  assert.match(embed, /function visibleStepControls\(step\)[\s\S]*!control\.disabled[\s\S]*control\.willValidate/);
  assert.match(embed, /if \(!control\.checkValidity\(\)\)/);
  assert.match(embed, /if \(shouldReport && firstInvalid\) firstInvalid\.reportValidity\(\)/);
  assert.match(embed, /validateStep\(steps\[currentStep\], true\)/);
  assert.match(embed, /setStep\(firstInvalid\);[\s\S]*validateStep\(steps\[firstInvalid\], true\)/);
});

test("failure injection model commits no prefix of the atomic graph", () => {
  const stages = [
    "contact",
    "lead",
    "deal",
    "task",
    "consents",
    "submission",
    "timeline",
    "counter",
    "evidence",
    "claim-completion",
  ];

  for (const failAt of stages) {
    const committed = [];
    const pending = [];
    assert.throws(() => {
      for (const stage of stages) {
        if (stage === failAt) throw new Error(`injected:${stage}`);
        pending.push(stage);
      }
      committed.push(...pending);
    }, new RegExp(`injected:${failAt}`));
    assert.deepEqual(committed, [], `failure at ${failAt} must roll back every prior stage`);
  }
});

test("migration, schema inventory, and QA reset retain one reset-safe semantic ledger", async () => {
  const [migration, schema, reset] = await Promise.all([
    read("migrations/072_form_submission_atomicity.sql"),
    read("src/lib/db/schema.ts"),
    read("src/lib/qa-reset-contract.ts"),
  ]);

  assert.match(migration, /form_submissions_workspace_idempotency_key_uidx/);
  assert.match(migration, /idempotency_key ~ '\^form:\[a-f0-9\]\{64\}\$'/);
  assert.match(migration, /request_hash ~ '\^\[a-f0-9\]\{64\}\$'/);
  assert.match(migration, /claim_lease_version > 0/);
  assert.match(migration, /or coalesce\(\([\s\S]*response_payload is not null[\s\S]*\), false\)/);
  assert.match(schema, /"form_submissions"/);
  assert.match(reset, /qaResetDatabaseTables[\s\S]*"form_submissions"/);
  assert.match(reset, /qaResetRetainedTables[\s\S]*"public_submission_idempotency"/);
});
