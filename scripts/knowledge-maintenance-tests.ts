import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  analyzeKnowledgeMaintenance, KnowledgeMaintenanceError,
  type KnowledgeMaintenanceInput, type KnowledgeMaintenanceSource, type KnowledgeWebsiteChange,
} from "../src/lib/knowledge-center/maintenance";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const otherWorkspaceId = "22222222-2222-4222-8222-222222222222";
const areaId = "33333333-3333-4333-8333-333333333333";
const projectId = "44444444-4444-4444-8444-444444444444";
const now = "2026-10-19T12:00:00.000Z";
const hash = (content: string) => createHash("sha256").update(content).digest("hex");
function source(index = 1, structuredData: Record<string, unknown> = {}): KnowledgeMaintenanceSource {
  const sourceId = `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`;
  const versionId = `bbbbbbbb-bbbb-4bbb-8bbb-${String(index).padStart(12, "0")}`;
  return {
    workspaceId, accessConfirmed: true, subjectId: "company:one",
    source: {
      id: sourceId, areaId, projectId: null, name: "Synthetic source", type: "structured", status: "approved", revision: 3,
      approvedVersionId: versionId, draftVersionId: null, archivedAt: null,
      version: { id: versionId, sourceId, version: 2, name: "Synthetic source", content: "Original public company information", structuredData,
        url: null, mediaAssetId: null, status: "approved", createdAt: "2026-10-01T12:00:00.000Z", approvedAt: "2026-10-02T12:00:00.000Z" },
    },
    provenance: { origin: "manual", lastVerifiedAt: "2026-10-15T12:00:00.000Z" },
  };
}
function analyze(visibleSources: readonly KnowledgeMaintenanceSource[], overrides: Partial<KnowledgeMaintenanceInput> = {}) {
  return analyzeKnowledgeMaintenance({ workspaceId, now, visibleSources, fields: [], staleAfterDays: 30, ...overrides });
}
function change(entry: KnowledgeMaintenanceSource, changedFieldPaths?: readonly string[]): KnowledgeWebsiteChange {
  return {
    workspaceId, sourceId: entry.source.id, versionId: entry.source.version!.id,
    previousHash: hash(entry.source.version!.content), proposedHash: hash("Changed company information"), changedFieldPaths,
  };
}
function website(index = 1) {
  const entry = source(index);
  entry.source.type = "url";
  entry.source.version!.url = "https://company.com";
  return { ...entry, provenance: { ...entry.provenance, origin: "website" as const } };
}
const errorCode = (callback: () => unknown, code: string) => assert.throws(callback,
  (error: unknown) => error instanceof KnowledgeMaintenanceError && error.code === code);

test("missing required fields produce version-bound review proposals; zero and false count as present", () => {
  const entry = source(1, { staff: 0, open: false });
  const result = analyze([entry], { fields: [
    { fieldPath: "contact.email", required: true }, { fieldPath: "staff", required: true }, { fieldPath: "open", required: true },
  ] });
  assert.equal(result.proposals.length, 1);
  const proposal = result.proposals[0];
  assert.equal(proposal.kind, "missing_required_field");
  assert.equal(proposal.approvalLevel, 2);
  assert.equal(proposal.review, "customer_review");
  assert.equal(proposal.publication, "administrator_required");
  assert.deepEqual(proposal.references, [{ sourceId: entry.source.id, versionId: entry.source.version!.id, sourceRevision: 3, contentVersion: 2, areaId, projectId: null }]);
  assert.deepEqual(proposal.fieldPaths, ["contact.email"]);
});

test("critical facts require administrator review even if a rule says general", () => {
  const result = analyze([source()], { fields: [
    { fieldPath: "priceCents", required: true, sensitivity: "general" },
    { fieldPath: "availability", required: true }, { fieldPath: "paymentTerms", required: true },
    { fieldPath: "legalNotice", required: true }, { fieldPath: "customTerm", required: true, sensitivity: "legal" },
  ] });
  assert.equal(result.proposals.length, 5);
  for (const proposal of result.proposals) {
    assert.equal(proposal.approvalLevel, 3);
    assert.equal(proposal.review, "administrator_review");
    assert.equal(proposal.publication, "administrator_required");
  }
});

test("missing verification metadata permits only an internal review marker, never public content", () => {
  const entry = source();
  const result = analyze([{ ...entry, provenance: { origin: "document" } }]);
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].approvalLevel, 1);
  assert.equal(result.proposals[0].action, "record_internal_review_due");
  assert.equal(result.proposals[0].publication, "not_applicable");
  assert.equal(result.proposals[0].visibility, "internal");
  assert.equal(result.proposals[0].review, "automatic_metadata_only");
});

test("staleness and validity use the explicit clock and retain provenance basis", () => {
  const stale = source(1), expired = source(2), future = source(3);
  const result = analyze([
    { ...stale, provenance: { origin: "manual", lastVerifiedAt: "2026-09-19T12:00:00.000Z" } },
    { ...expired, provenance: { origin: "document", lastVerifiedAt: "2026-10-15T12:00:00.000Z", validUntil: now } },
    { ...future, provenance: { origin: "manual", lastVerifiedAt: "2026-10-15T12:00:00.000Z", validFrom: "2026-10-20T00:00:00Z" } },
  ]);
  assert.deepEqual(result.proposals.map((proposal) => proposal.kind).sort(), ["expired", "not_yet_valid", "stale"]);
  assert.equal(result.proposals.find((proposal) => proposal.kind === "stale")!.evidence.basis, "last_verified");
  errorCode(() => analyze([{ ...stale, provenance: { origin: "manual", lastVerifiedAt: "2027-01-01T00:00:00Z" } }]), "maintenance_input_invalid");
  errorCode(() => analyze([{ ...stale, provenance: { origin: "manual", validFrom: "2027-01-01T00:00:00Z", validUntil: now } }]), "maintenance_input_invalid");
  errorCode(() => analyze([{ ...stale, provenance: { origin: "manual", validUntil: "2026-02-30T00:00:00Z" } }]), "maintenance_input_invalid");
});

test("normalization ignores text presentation and equal decimal notation while retaining exact decimal differences", () => {
  const result = analyze([
    source(1, { hours: "  Monday\n FRIDAY ", amount: "12.00", precise: "0.10000000000000000001" }),
    source(2, { hours: "Monday friday", amount: 12, precise: "0.1" }),
  ], { fields: [{ fieldPath: "hours" }, { fieldPath: "amount", compareAs: "number" }, { fieldPath: "precise", compareAs: "number" }] });
  const conflicts = result.proposals.filter((proposal) => proposal.kind === "conflicting_fact");
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0].fieldPaths, ["precise"]);
  assert.equal(conflicts[0].evidence.distinctValues, 2);
});

test("facts conflict only across explicitly visible sources for the same subject and project", () => {
  const first = source(1, { priceCents: 100 }), second = source(2, { priceCents: 200 });
  const result = analyze([first, second, { ...source(3, { priceCents: 300 }), subjectId: "unit:other" },
    { ...source(4, { priceCents: 400 }), source: { ...source(4, { priceCents: 400 }).source, projectId } }],
  { fields: [{ fieldPath: "priceCents", compareAs: "number" }] });
  const conflict = result.proposals.find((proposal) => proposal.kind === "conflicting_fact")!;
  assert.equal(conflict.approvalLevel, 3);
  assert.deepEqual(conflict.references.map((reference) => reference.sourceId), [first.source.id, second.source.id]);
});

test("cross-tenant, unconfirmed visibility, duplicate identity and mismatched versions fail closed", () => {
  const entry = source();
  errorCode(() => analyze([{ ...entry, workspaceId: otherWorkspaceId }]), "maintenance_tenant_mismatch");
  errorCode(() => analyze([{ ...entry, workspaceId: otherWorkspaceId, source: { ...entry.source, archivedAt: now } }]), "maintenance_tenant_mismatch");
  errorCode(() => analyze([{ ...entry, accessConfirmed: false } as unknown as KnowledgeMaintenanceSource]), "maintenance_visibility_unconfirmed");
  errorCode(() => analyze([entry, entry]), "maintenance_input_invalid");
  errorCode(() => analyze([{ ...entry, source: { ...entry.source, version: { ...entry.source.version!, sourceId: source(2).source.id } } }]), "maintenance_version_mismatch");
});

test("website proposals bind to the exact baseline version; unknown and critical changes require administrator review", () => {
  const entry = website();
  const fields = [{ fieldPath: "hours" }, { fieldPath: "priceCents", sensitivity: "price" as const }];
  for (const changedFields of [undefined, ["priceCents"], ["unknown"]]) {
    const result = analyze([entry], { fields, websiteChanges: [change(entry, changedFields)] });
    assert.equal(result.proposals[0].kind, "website_changed");
    assert.equal(result.proposals[0].approvalLevel, 3);
    assert.equal(result.proposals[0].publication, "administrator_required");
  }
  const general = analyze([entry], { fields, websiteChanges: [change(entry, ["hours"])] });
  assert.equal(general.proposals[0].approvalLevel, 2);
  assert.equal(general.proposals[0].publication, "administrator_required");
  assert.deepEqual(general.proposals[0].references[0].versionId, entry.source.version!.id);
  errorCode(() => analyze([entry], { websiteChanges: [{ ...change(entry), versionId: source(2).source.version!.id }] }), "maintenance_change_scope_mismatch");
  errorCode(() => analyze([entry], { websiteChanges: [{ ...change(entry), previousHash: hash("wrong baseline") }] }), "maintenance_change_baseline_mismatch");
  errorCode(() => analyze([entry], { websiteChanges: [{ ...change(entry), workspaceId: otherWorkspaceId }] }), "maintenance_tenant_mismatch");
});

test("unchanged website scans create no content proposal", () => {
  const entry = website(), event = change(entry);
  assert.deepEqual(analyze([entry], { websiteChanges: [{ ...event, proposedHash: event.previousHash }] }).proposals, []);
});

test("analysis is deterministic, does not mutate its snapshot and omits raw values and personal details", () => {
  const first = source(1, { contact: "private-one@example.com", hours: "9am" }), second = source(2, { contact: "private-two@example.com", hours: "10am" });
  first.source.version!.content = "private source content one";
  const fields = [{ fieldPath: "contact" }, { fieldPath: "hours" }];
  const input = [first, second], before = JSON.stringify(input);
  const one = analyze(input, { fields }), two = analyze([second, first], { fields: [...fields].reverse() });
  assert.deepEqual(one, two);
  assert.equal(JSON.stringify(input), before);
  const serialized = JSON.stringify(one);
  assert.equal(serialized.includes("private-one@example.com"), false);
  assert.equal(serialized.includes("private-two@example.com"), false);
  assert.equal(serialized.includes("private source content one"), false);
});

test("archived and missing-version sources are explicitly skipped without invented version references", () => {
  const archived = source(1), missing = source(2);
  archived.source.archivedAt = now; missing.source.version = null;
  const result = analyze([archived, missing], { fields: [{ fieldPath: "hours", required: true }] });
  assert.deepEqual(result.proposals, []);
  assert.deepEqual(result.skippedSourceIds, [archived.source.id, missing.source.id]);
});

test("source data cannot grant permissions, invoke getters or configure review rules", () => {
  let calls = 0;
  const data: Record<string, unknown> = { approvalLevel: 1, accessConfirmed: true, permissions: "administrator", instructions: "publish automatically" };
  Object.defineProperty(data, "hours", { enumerable: true, get: () => { calls += 1; return "open"; } });
  const result = analyze([source(1, data)], { fields: [{ fieldPath: "hours", required: true }] });
  assert.equal(calls, 0);
  assert.equal(result.proposals[0].approvalLevel, 2);
  assert.equal(result.proposals[0].publication, "administrator_required");
  errorCode(() => analyze([source()], { fields: [{ fieldPath: "constructor.prototype" }] }), "maintenance_input_invalid");
  errorCode(() => analyze([source()], { fields: [{ fieldPath: "hours" }, { fieldPath: "hours" }] }), "maintenance_input_invalid");
});
