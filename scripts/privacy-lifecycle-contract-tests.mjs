import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = path.resolve(import.meta.dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function transpile(file) {
  const result = ts.transpileModule(read(file), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: file,
    reportDiagnostics: true,
  });
  const errors = (result.diagnostics ?? []).filter((entry) => entry.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors.map((entry) => ts.flattenDiagnosticMessageText(entry.messageText, "\n")), []);
  return result.outputText;
}

function loadPureModules() {
  const contentModule = { exports: {} };
  new Function("require", "module", "exports", transpile("src/lib/content-library.ts"))(
    require, contentModule, contentModule.exports,
  );
  const privacyModule = { exports: {} };
  const localRequire = (id) => id === "@/lib/content-library" ? contentModule.exports : require(id);
  new Function("require", "module", "exports", transpile("src/lib/privacy-lifecycle.ts"))(
    localRequire, privacyModule, privacyModule.exports,
  );
  return privacyModule.exports;
}

test("privacy schema can only propose lifecycle actions and forces manual review", () => {
  const migration = read("migrations/082_content_library_privacy.sql");
  assert.match(migration, /manual_review_required boolean not null default true check \(manual_review_required = true\)/i);
  assert.match(migration, /propose_archive.*propose_anonymize.*propose_delete/i);
  assert.match(migration, /approved_delete/i);
  assert.match(migration, /Completion requires a separate operation and immutable evidence/i);
  assert.doesNotMatch(migration, /delete\s+from\s+(contacts|organizations|leads|deals|media_assets)/i);
});

test("retention and DSAR transitions are explicit and operation states stay unreachable", () => {
  const privacy = loadPureModules();
  assert.equal(privacy.requiredRetentionApprovalStatus("propose_archive"), "approved_archive");
  assert.equal(privacy.requiredRetentionApprovalStatus("propose_anonymize"), "approved_anonymize");
  assert.equal(privacy.requiredRetentionApprovalStatus("propose_delete"), "approved_delete");
  assert.equal(privacy.isAllowedRetentionReviewTransition("proposed", "in_review"), true);
  assert.equal(privacy.isAllowedRetentionReviewTransition("proposed", "approved_archive"), false);
  assert.equal(privacy.isAllowedRetentionReviewTransition("in_review", "approved_delete"), true);
  assert.equal(privacy.isAllowedRetentionReviewTransition("approved_delete", "completed"), false);
  assert.equal(privacy.isAllowedDataSubjectRequestTransition("received", "identity_check"), true);
  assert.equal(privacy.isAllowedDataSubjectRequestTransition("received", "approved"), false);
  assert.equal(privacy.isAllowedDataSubjectRequestTransition("identity_check", "in_review"), true);
  assert.equal(privacy.isAllowedDataSubjectRequestTransition("approved", "export_ready"), false);
  assert.equal(privacy.dataSubjectRequestStatusRequiresOperationEvidence("export_ready"), true);
  assert.equal(privacy.dataSubjectRequestStatusRequiresOperationEvidence("completed"), true);
});

test("legal holds use active windows, serialize overlaps, and refresh effective flags", () => {
  const repository = read("src/lib/db/privacy-lifecycle-repository.ts");
  const migration = read("migrations/082_content_library_privacy.sql");
  assert.match(repository, /privacy_legal_holds/);
  assert.match(repository, /crm_content_links/);
  assert.match(repository, /hold\.starts_at <= now\(\)/);
  assert.match(repository, /hold\.entity_type = 'project'/);
  assert.match(repository, /pg_advisory_xact_lock/);
  assert.match(repository, /tstzrange\(starts_at, expires_at, '\[\)'\)/);
  assert.match(repository, /refreshLegalHoldSnapshots/);
  assert.match(repository, /REFERENCE_BLOCKED/);
  assert.match(repository, /automaticActionPerformed: false/);
  assert.match(repository, /hardDeletePerformed: false/);
  assert.match(migration, /create index privacy_legal_holds_target_window_idx/i);
  assert.doesNotMatch(migration, /create unique index privacy_legal_holds_target_window_idx/i);
  assert.match(migration, /novalure_validate_legal_hold_window/i);
});

test("linked retention reviews preserve policy, entity and action consistency", () => {
  const repository = read("src/lib/db/privacy-lifecycle-repository.ts");
  const migration = read("migrations/082_content_library_privacy.sql");
  assert.match(repository, /Retention policy, entity type, and proposed action must match/);
  assert.match(repository, /Inactive retention policies cannot create reviews/);
  assert.match(repository, /on conflict \(workspace_id, entity_type, entity_id\)[\s\S]*do nothing/);
  assert.match(migration, /novalure_validate_retention_review_state/i);
  assert.match(migration, /novalure_validate_privacy_policy_update/i);
});

test("CSV export neutralizes formula injection and quotes cells", () => {
  const privacy = loadPureModules();
  assert.equal(privacy.escapeCsvCell("=cmd|' /C calc'!A0"), '"\'=cmd|\' /C calc\'!A0"');
  assert.equal(privacy.escapeCsvCell("  @SUM(1,2)"), '"\'  @SUM(1,2)"');
  assert.equal(privacy.escapeCsvCell('A "quote"'), '"A ""quote"""');
  const csv = privacy.buildDataSubjectRequestMetadataCsv({
    id: "id", requestReference: "=danger", requestType: "export", status: "received",
    contactId: null, dueAt: null, exportJobMetadata: { job: "queued" }, reviewedAt: null,
    updatedAt: "2026-09-02T00:00:00.000Z",
  });
  assert.match(csv, /"'=danger"/);
});

test("privacy routes use scoped privacy-manager auth, idempotency and OCC", () => {
  const files = [
    "src/app/api/crm/privacy/policies/route.ts",
    "src/app/api/crm/privacy/reviews/route.ts",
    "src/app/api/crm/privacy/reviews/[reviewId]/route.ts",
    "src/app/api/crm/privacy/holds/route.ts",
    "src/app/api/crm/privacy/holds/[holdId]/route.ts",
    "src/app/api/crm/privacy/requests/route.ts",
    "src/app/api/crm/privacy/requests/[requestId]/route.ts",
  ];
  for (const file of files) {
    const source = read(file);
    assert.match(source, /resolvePrivacyScopedSession/);
    assert.match(source, /parseIdempotencyKey/);
  }
  const shared = read("src/app/api/crm/privacy/_shared.ts");
  assert.match(shared, /permission: "crm:read"/);
  assert.match(shared, /canManagePrivacyLifecycle/);
  const repository = read("src/lib/db/privacy-lifecycle-repository.ts");
  assert.match(repository, /session\.role === "owner"[\s\S]*session\.role === "admin"/);
  assert.match(repository, /hasProductCapability\(session\.productRole, "settings:manage"\)/);
  const validation = read("src/lib/privacy-lifecycle.ts");
  assert.match(validation, /parseRetentionReviewDecision[\s\S]*expectedUpdatedAt/);
  assert.match(validation, /parseLegalHoldRelease[\s\S]*expectedUpdatedAt/);
  assert.match(validation, /parseDataSubjectRequestUpdate[\s\S]*expectedUpdatedAt/);
});

test("privacy TypeScript and TSX files are syntactically valid", () => {
  for (const file of [
    "src/lib/privacy-lifecycle.ts",
    "src/lib/db/privacy-lifecycle-repository.ts",
    "src/app/api/crm/privacy/_shared.ts",
    "src/app/api/crm/privacy/route.ts",
    "src/app/api/crm/privacy/requests/[requestId]/export/route.ts",
    "src/components/privacy-lifecycle-panel.tsx",
  ]) transpile(file);
});
