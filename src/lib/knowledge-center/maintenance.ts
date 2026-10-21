import "server-only";

import { createHash } from "node:crypto";
import type { KnowledgeSource, KnowledgeSourceType } from "./types";

export class KnowledgeMaintenanceError extends Error {
  constructor(readonly code: string) { super(code); this.name = "KnowledgeMaintenanceError"; }
}

export type KnowledgeFactSensitivity = "general" | "price" | "availability" | "payment" | "legal";
export type KnowledgeMaintenanceField = Readonly<{
  /** A trusted configuration path inside version.structuredData; never an instruction. */
  fieldPath: string;
  required?: boolean;
  sourceTypes?: readonly KnowledgeSourceType[];
  sensitivity?: KnowledgeFactSensitivity;
  compareAs?: "text" | "number" | "boolean";
}>;
export type KnowledgeMaintenanceSource = Readonly<{
  workspaceId: string;
  accessConfirmed: true;
  /** Trusted subject identity, e.g. company ID or unit ID; different subjects never conflict. */
  subjectId: string;
  source: KnowledgeSource;
  provenance: Readonly<{
    origin: "manual" | "website" | "document" | "crm";
    lastVerifiedAt?: string | null;
    validFrom?: string | null;
    validUntil?: string | null;
  }>;
}>;
export type KnowledgeWebsiteChange = Readonly<{
  workspaceId: string;
  sourceId: string;
  versionId: string;
  previousHash: string;
  proposedHash: string;
  /** Optional trusted analysis output. Unknown/unclassified changes require administrator review. */
  changedFieldPaths?: readonly string[];
}>;
export type KnowledgeMaintenanceReference = Readonly<{
  sourceId: string;
  versionId: string;
  sourceRevision: number;
  contentVersion: number;
  areaId: string;
  projectId: string | null;
}>;
export type KnowledgeMaintenanceProposal = Readonly<{
  id: string;
  workspaceId: string;
  evaluatedAt: string;
  kind: "missing_verification_metadata" | "missing_required_field" | "stale" | "expired" | "not_yet_valid" | "conflicting_fact" | "website_changed";
  references: readonly KnowledgeMaintenanceReference[];
  fieldPaths: readonly string[];
  approvalLevel: 1 | 2 | 3;
  review: "automatic_metadata_only" | "customer_review" | "administrator_review";
  /** Every source-content change must use the existing administrator publication boundary. */
  publication: "not_applicable" | "administrator_required";
  action: "record_internal_review_due" | "prepare_content_review";
  visibility: "internal";
  /** No source text, values, personal details, URLs or guessed replacements are included. */
  evidence: Readonly<{
    basis?: "last_verified" | "approved_at" | "created_at";
    validAt?: string;
    previousHash?: string;
    proposedHash?: string;
    distinctValues?: number;
  }>;
}>;
export type KnowledgeMaintenanceInput = Readonly<{
  workspaceId: string;
  /** Explicit clock makes analysis deterministic and avoids background scheduling. */
  now: string;
  visibleSources: readonly KnowledgeMaintenanceSource[];
  fields: readonly KnowledgeMaintenanceField[];
  staleAfterDays: number;
  websiteChanges?: readonly KnowledgeWebsiteChange[];
}>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const sourceTypes = new Set(["manual", "faq", "structured", "url", "file"]);
const sensitivities = new Set(["general", "price", "availability", "payment", "legal"]);
const forbiddenSegments = new Set(["__proto__", "prototype", "constructor"]);
function fail(code = "maintenance_input_invalid"): never { throw new KnowledgeMaintenanceError(code); }
function timestamp(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) fail();
  const [year, month, day, hour, minute, second] = [value.slice(0, 4), value.slice(5, 7), value.slice(8, 10), value.slice(11, 13), value.slice(14, 16), value.slice(17, 19)].map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59) fail();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail();
  return parsed;
}
function fieldPath(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > 160) fail();
  const segments = value.split(".");
  if (segments.length > 8 || segments.some((segment) => !/^[a-z][a-z0-9_-]*$/iu.test(segment) || forbiddenSegments.has(segment.toLowerCase()))) fail();
}
function ownField(data: unknown, path: string): unknown {
  let value = data;
  for (const segment of path.split(".")) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, segment);
    // Never invoke getters from malformed/non-JSON input.
    if (!descriptor || !("value" in descriptor)) return undefined;
    value = descriptor.value;
  }
  return value;
}
function present(value: unknown) {
  return value !== undefined && value !== null &&
    (typeof value !== "string" || value.trim().length > 0) &&
    (typeof value !== "object" || Object.keys(value).length > 0);
}
function normalizedFact(value: unknown, compareAs: KnowledgeMaintenanceField["compareAs"]): string | null {
  if (!present(value)) return null;
  if (compareAs === "boolean") return typeof value === "boolean" ? `boolean:${value}` : null;
  if (compareAs === "number") {
    if (typeof value !== "number" && typeof value !== "string") return null;
    if (typeof value === "number" && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)) return null;
    let raw = String(value).trim();
    if (typeof value === "number" && /e/iu.test(raw)) {
      const [mantissa, exponent] = raw.toLowerCase().split("e");
      const sign = mantissa.startsWith("-") ? "-" : "";
      const [whole, fractional = ""] = mantissa.replace(/^-/, "").split(".");
      const digits = whole + fractional, point = whole.length + Number(exponent);
      raw = sign + (point <= 0 ? `0.${"0".repeat(-point)}${digits}` : point >= digits.length
        ? digits + "0".repeat(point - digits.length) : `${digits.slice(0, point)}.${digits.slice(point)}`);
    }
    if (raw.length > 400 || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(raw)) return null;
    const sign = raw.startsWith("-") ? "-" : "", [whole, fraction = ""] = raw.replace(/^-/, "").split(".");
    const trimmedFraction = fraction.replace(/0+$/u, "");
    return `number:${whole === "0" && !trimmedFraction ? "" : sign}${whole}${trimmedFraction ? `.${trimmedFraction}` : ""}`;
  }
  if (typeof value === "number") return Number.isFinite(value) ? `number:${value}` : null;
  if (typeof value === "boolean") return `boolean:${value}`;
  if (typeof value !== "string" || value.length > 100_000) return null;
  return `text:${value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase()}`;
}
function sensitive(field: KnowledgeMaintenanceField): boolean {
  // Trusted sensitivity may escalate, but recognizable critical keys cannot downgrade.
  return (field.sensitivity !== undefined && field.sensitivity !== "general") ||
    /(?:price|preis|cost|kosten|payment|zahlung|legal|recht|vertrag|contract|availability|verf[uü]gbarkeit|reservation|reservierung)/iu.test(field.fieldPath);
}
function reference(source: KnowledgeSource): KnowledgeMaintenanceReference {
  if (!source.version) fail();
  return {
    sourceId: source.id, versionId: source.version.id, sourceRevision: source.revision,
    contentVersion: source.version.version, areaId: source.areaId, projectId: source.projectId,
  };
}
function applies(field: KnowledgeMaintenanceField, source: KnowledgeSource) {
  return !field.sourceTypes || field.sourceTypes.includes(source.type);
}

/**
 * Pure bounded analysis of an already authorized snapshot. It does not establish
 * authorization, persist proposals, alter metadata/content, publish, call a model,
 * fetch a page or schedule work. Provenance/validity are prepared caller contracts;
 * source content and structured data never control access or approval policy.
 */
export function analyzeKnowledgeMaintenance(input: KnowledgeMaintenanceInput): Readonly<{
  proposals: readonly KnowledgeMaintenanceProposal[];
  skippedSourceIds: readonly string[];
}> {
  if (!uuid.test(input.workspaceId) || !Array.isArray(input.visibleSources) || input.visibleSources.length > 500 ||
    !Array.isArray(input.fields) || input.fields.length > 50 || !Number.isFinite(input.staleAfterDays) ||
    input.staleAfterDays <= 0 || input.staleAfterDays > 36_500 ||
    (input.websiteChanges !== undefined && (!Array.isArray(input.websiteChanges) || input.websiteChanges.length > 500))) fail();
  const now = timestamp(input.now), evaluatedAt = new Date(now).toISOString();
  const configuredFields = new Map<string, KnowledgeMaintenanceField>();
  for (const field of input.fields) {
    if (!field || typeof field !== "object") fail();
    fieldPath(field.fieldPath);
    if (configuredFields.has(field.fieldPath) || (field.sensitivity !== undefined && !sensitivities.has(field.sensitivity)) ||
      (field.required !== undefined && typeof field.required !== "boolean") ||
      (field.compareAs !== undefined && !["text", "number", "boolean"].includes(field.compareAs)) ||
      (field.sourceTypes !== undefined && (!Array.isArray(field.sourceTypes) || field.sourceTypes.some((type: unknown) => typeof type !== "string" || !sourceTypes.has(type))))) fail();
    configuredFields.set(field.fieldPath, field);
  }
  const sources = new Map<string, KnowledgeMaintenanceSource>();
  const skippedSourceIds: string[] = [];
  for (const entry of input.visibleSources) {
    if (!entry || !entry.source || !entry.provenance) fail();
    if (entry.workspaceId !== input.workspaceId) fail("maintenance_tenant_mismatch");
    if (entry.accessConfirmed !== true) fail("maintenance_visibility_unconfirmed");
    const source = entry.source;
    if (!uuid.test(source.id) || !uuid.test(source.areaId) || (source.projectId !== null && !uuid.test(source.projectId)) ||
      sources.has(source.id) || !Number.isSafeInteger(source.revision) || source.revision < 1 ||
      !sourceTypes.has(source.type) || typeof entry.subjectId !== "string" || !entry.subjectId || entry.subjectId.length > 200 ||
      !["manual", "website", "document", "crm"].includes(entry.provenance.origin)) fail();
    for (const value of [entry.provenance.lastVerifiedAt, entry.provenance.validFrom, entry.provenance.validUntil]) {
      if (value !== undefined && value !== null) timestamp(value);
    }
    if (entry.provenance.validFrom && entry.provenance.validUntil && timestamp(entry.provenance.validFrom) > timestamp(entry.provenance.validUntil)) fail();
    if (entry.provenance.lastVerifiedAt && timestamp(entry.provenance.lastVerifiedAt) > now) fail();
    if (source.version && (!uuid.test(source.version.id) || source.version.sourceId !== source.id ||
      !Number.isSafeInteger(source.version.version) || source.version.version < 1 ||
      ![source.approvedVersionId, source.draftVersionId].includes(source.version.id) ||
      (source.version.status === "approved" && source.approvedVersionId !== source.version.id) ||
      (source.version.status === "draft" && source.draftVersionId !== source.version.id) ||
      !["approved", "draft"].includes(source.version.status))) fail("maintenance_version_mismatch");
    if (source.version) {
      timestamp(source.version.createdAt);
      if (source.version.approvedAt) timestamp(source.version.approvedAt);
    }
    sources.set(source.id, entry);
    if (!source.version || source.archivedAt !== null) skippedSourceIds.push(source.id);
  }
  const proposals: KnowledgeMaintenanceProposal[] = [];
  function propose(kind: KnowledgeMaintenanceProposal["kind"], entries: readonly KnowledgeMaintenanceSource[], paths: readonly string[], level: 1 | 2 | 3,
    evidence: KnowledgeMaintenanceProposal["evidence"] = {}) {
    if (proposals.length >= 2_000) fail("maintenance_result_limit");
    const references = entries.map((entry) => reference(entry.source)).sort((left, right) => left.sourceId.localeCompare(right.sourceId, "en"));
    const fieldPaths = [...new Set(paths)].sort();
    const digest = createHash("sha256").update(JSON.stringify({ workspaceId: input.workspaceId, kind, references, fieldPaths, evidence, level })).digest("hex");
    proposals.push({
      id: `maintenance_${digest}`, workspaceId: input.workspaceId, evaluatedAt, kind, references, fieldPaths,
      approvalLevel: level, review: level === 1 ? "automatic_metadata_only" : level === 2 ? "customer_review" : "administrator_review",
      publication: level === 1 ? "not_applicable" : "administrator_required",
      action: level === 1 ? "record_internal_review_due" : "prepare_content_review", visibility: "internal", evidence,
    });
  }
  const conflicts = new Map<string, { field: KnowledgeMaintenanceField; values: Map<string, KnowledgeMaintenanceSource[]> }>();
  for (const entry of [...sources.values()].sort((a, b) => a.source.id.localeCompare(b.source.id, "en"))) {
    const source = entry.source, version = source.version;
    if (!version || source.archivedAt !== null) continue;
    const relevantFields = input.fields.filter((field) => applies(field, source));
    const level = relevantFields.some(sensitive) ? 3 : 2;
    if (!entry.provenance.lastVerifiedAt) propose("missing_verification_metadata", [entry], [], 1);
    const validFrom = entry.provenance.validFrom, validUntil = entry.provenance.validUntil;
    if (validUntil && timestamp(validUntil) <= now) propose("expired", [entry], [], level, { validAt: new Date(timestamp(validUntil)).toISOString() });
    else if (validFrom && timestamp(validFrom) > now) propose("not_yet_valid", [entry], [], level, { validAt: new Date(timestamp(validFrom)).toISOString() });
    else {
      const basis = entry.provenance.lastVerifiedAt ? "last_verified" : version.approvedAt ? "approved_at" : "created_at";
      const baseline = entry.provenance.lastVerifiedAt ?? version.approvedAt ?? version.createdAt;
      if (now - timestamp(baseline) >= input.staleAfterDays * 86_400_000) propose("stale", [entry], [], level, { basis });
    }
    for (const field of relevantFields) {
      const value = ownField(version.structuredData, field.fieldPath);
      if (field.required && !present(value)) propose("missing_required_field", [entry], [field.fieldPath], sensitive(field) ? 3 : 2);
      const normalized = normalizedFact(value, field.compareAs);
      if (normalized === null) continue;
      const key = JSON.stringify([source.projectId, entry.subjectId, field.fieldPath]);
      let group = conflicts.get(key);
      if (!group) { group = { field, values: new Map() }; conflicts.set(key, group); }
      const entries = group.values.get(normalized) ?? [];
      entries.push(entry); group.values.set(normalized, entries);
    }
  }
  for (const group of conflicts.values()) {
    if (group.values.size < 2) continue;
    propose("conflicting_fact", [...group.values.values()].flat(), [group.field.fieldPath], sensitive(group.field) ? 3 : 2, { distinctValues: group.values.size });
  }
  const seenChanges = new Set<string>();
  for (const change of input.websiteChanges ?? []) {
    if (change.workspaceId !== input.workspaceId) fail("maintenance_tenant_mismatch");
    const entry = sources.get(change.sourceId);
    if (!entry || !entry.source.version || entry.source.version.id !== change.versionId || entry.source.type !== "url" ||
      entry.provenance.origin !== "website" || entry.source.archivedAt !== null || seenChanges.has(change.sourceId)) fail("maintenance_change_scope_mismatch");
    if (!/^[a-f0-9]{64}$/u.test(change.previousHash) || !/^[a-f0-9]{64}$/u.test(change.proposedHash) ||
      (change.changedFieldPaths !== undefined && (!Array.isArray(change.changedFieldPaths) || change.changedFieldPaths.length > 50))) fail();
    if (change.previousHash !== createHash("sha256").update(entry.source.version.content).digest("hex")) fail("maintenance_change_baseline_mismatch");
    seenChanges.add(change.sourceId);
    for (const path of change.changedFieldPaths ?? []) fieldPath(path);
    if (change.previousHash === change.proposedHash) continue;
    const paths: readonly string[] = change.changedFieldPaths ?? [];
    const needsAdministrator = paths.length === 0 || paths.some((path) => {
      const field = configuredFields.get(path);
      return !field || !applies(field, entry.source) || sensitive(field);
    });
    propose("website_changed", [entry], paths, needsAdministrator ? 3 : 2, { previousHash: change.previousHash, proposedHash: change.proposedHash });
  }
  return {
    proposals: proposals.sort((a, b) => a.id.localeCompare(b.id, "en")),
    skippedSourceIds: skippedSourceIds.sort(),
  };
}
