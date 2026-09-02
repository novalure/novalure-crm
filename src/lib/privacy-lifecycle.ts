import {
  ContentValidationError,
  assertUuid,
  parseExpectedUpdatedAt,
  parseOptionalUuid,
} from "@/lib/content-library";

export const privacyEntityTypes = [
  "contact",
  "organization",
  "lead",
  "project",
  "property",
  "unit",
  "deal",
  "task",
  "document",
  "template",
] as const;
export const retentionActions = ["propose_archive", "propose_anonymize", "propose_delete"] as const;
export const retentionReviewStatuses = [
  "proposed",
  "in_review",
  "approved_archive",
  "approved_anonymize",
  "approved_delete",
  "rejected",
  "completed",
] as const;
export const dataSubjectRequestTypes = [
  "access",
  "export",
  "rectification",
  "erasure",
  "restriction",
  "objection",
] as const;
export const dataSubjectRequestStatuses = [
  "received",
  "identity_check",
  "in_review",
  "approved",
  "rejected",
  "export_ready",
  "completed",
  "cancelled",
] as const;

export type PrivacyEntityType = (typeof privacyEntityTypes)[number];
export type RetentionAction = (typeof retentionActions)[number];
export type RetentionReviewStatus = (typeof retentionReviewStatuses)[number];
export type DataSubjectRequestType = (typeof dataSubjectRequestTypes)[number];
export type DataSubjectRequestStatus = (typeof dataSubjectRequestStatuses)[number];

const retentionApprovalByAction = Object.freeze({
  propose_archive: "approved_archive",
  propose_anonymize: "approved_anonymize",
  propose_delete: "approved_delete",
} as const satisfies Record<RetentionAction, RetentionReviewStatus>);

const retentionReviewTransitions: Readonly<Record<RetentionReviewStatus, readonly RetentionReviewStatus[]>> =
  Object.freeze({
    proposed: ["in_review", "rejected"],
    in_review: ["approved_archive", "approved_anonymize", "approved_delete", "rejected"],
    approved_archive: [],
    approved_anonymize: [],
    approved_delete: [],
    rejected: [],
    completed: [],
  });

const dataSubjectRequestTransitions: Readonly<Record<DataSubjectRequestStatus, readonly DataSubjectRequestStatus[]>> =
  Object.freeze({
    received: ["identity_check", "cancelled"],
    identity_check: ["in_review", "rejected", "cancelled"],
    in_review: ["approved", "rejected", "cancelled"],
    approved: [],
    rejected: [],
    export_ready: [],
    completed: [],
    cancelled: [],
  });

export function requiredRetentionApprovalStatus(action: RetentionAction) {
  return retentionApprovalByAction[action];
}

export function isAllowedRetentionReviewTransition(
  from: RetentionReviewStatus,
  to: RetentionReviewStatus,
) {
  return retentionReviewTransitions[from].includes(to);
}

export function isAllowedDataSubjectRequestTransition(
  from: DataSubjectRequestStatus,
  to: DataSubjectRequestStatus,
) {
  return dataSubjectRequestTransitions[from].includes(to);
}

export function dataSubjectRequestStatusRequiresIdentity(status: DataSubjectRequestStatus) {
  return ["in_review", "approved", "export_ready", "completed"].includes(status);
}

export function dataSubjectRequestStatusRequiresOperationEvidence(status: DataSubjectRequestStatus) {
  return status === "export_ready" || status === "completed";
}

function requireRecord(value: unknown, label = "Payload") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ContentValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function cleanString(value: unknown, label: string, maxLength: number, required = true) {
  if (value === undefined || value === null) {
    if (!required) return "";
    throw new ContentValidationError(`${label} is required`);
  }
  if (typeof value !== "string") throw new ContentValidationError(`${label} must be text`);
  const result = value.trim();
  if (required && !result) throw new ContentValidationError(`${label} is required`);
  if (result.length > maxLength) {
    throw new ContentValidationError(`${label} must not exceed ${maxLength} characters`);
  }
  return result;
}

function enumValue<const Values extends readonly string[]>(value: unknown, values: Values, label: string) {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new ContentValidationError(`${label} is invalid`);
  }
  return value as Values[number];
}

function optionalDate(value: unknown, label: string) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new ContentValidationError(`${label} must be an ISO date`);
  }
  return new Date(value).toISOString();
}

function safeMetadata(value: unknown) {
  if (value === undefined || value === null) return {};
  const metadata = requireRecord(value, "exportJobMetadata");
  const serialized = JSON.stringify(metadata);
  if (serialized.length > 20_000) {
    throw new ContentValidationError("exportJobMetadata is too large");
  }
  const forbiddenNames = ["password", "secret", "token", "authorization", "cookie", "credential"];
  const forbiddenValue = /\bbearer\s+\S+|postgres(?:ql)?:\/\/|[?&](?:token|signature|key)=/i;
  const inspect = (entry: unknown, depth: number): void => {
    if (depth > 8) throw new ContentValidationError("exportJobMetadata is nested too deeply");
    if (typeof entry === "string") {
      if (entry.length > 4000) throw new ContentValidationError("exportJobMetadata contains an oversized value");
      if (forbiddenValue.test(entry)) {
        throw new ContentValidationError("exportJobMetadata must contain references, not credentials");
      }
      return;
    }
    if (Array.isArray(entry)) {
      entry.forEach((item) => inspect(item, depth + 1));
      return;
    }
    if (!entry || typeof entry !== "object") return;
    for (const [key, nested] of Object.entries(entry as Record<string, unknown>)) {
      if (forbiddenNames.some((forbidden) => key.toLowerCase().includes(forbidden))) {
        throw new ContentValidationError(`exportJobMetadata contains a forbidden credential field`);
      }
      inspect(nested, depth + 1);
    }
  };
  inspect(metadata, 0);
  return metadata;
}

export function parseRetentionPolicyInput(value: unknown) {
  const input = requireRecord(value);
  const inactivityDays = Number(input.inactivityDays);
  if (!Number.isSafeInteger(inactivityDays) || inactivityDays < 1 || inactivityDays > 36_500) {
    throw new ContentValidationError("inactivityDays must be between 1 and 36500");
  }
  return {
    entityType: enumValue(input.entityType, privacyEntityTypes, "entityType"),
    inactivityDays,
    proposedAction: enumValue(input.proposedAction, retentionActions, "proposedAction"),
    legalBasis: cleanString(input.legalBasis, "legalBasis", 240),
    isActive: input.isActive !== false,
    expectedUpdatedAt: input.expectedUpdatedAt === undefined || input.expectedUpdatedAt === null
      ? null
      : parseExpectedUpdatedAt(input.expectedUpdatedAt),
  };
}

export function parseRetentionReviewInput(value: unknown) {
  const input = requireRecord(value);
  return {
    policyId: parseOptionalUuid(input.policyId, "policyId"),
    entityType: enumValue(input.entityType, privacyEntityTypes, "entityType"),
    entityId: assertUuid(input.entityId, "entityId"),
    proposedAction: enumValue(input.proposedAction, retentionActions, "proposedAction"),
    rationale: cleanString(input.rationale, "rationale", 2000),
    dueAt: optionalDate(input.dueAt, "dueAt"),
  };
}

export function parseRetentionReviewDecision(value: unknown) {
  const input = requireRecord(value);
  return {
    expectedUpdatedAt: parseExpectedUpdatedAt(input.expectedUpdatedAt),
    status: enumValue(input.status, retentionReviewStatuses, "status"),
    decisionNote: cleanString(input.decisionNote, "decisionNote", 2000),
  };
}

export function parseLegalHoldInput(value: unknown) {
  const input = requireRecord(value);
  const entityType = input.entityType === "workspace"
    ? "workspace" as const
    : enumValue(input.entityType, privacyEntityTypes, "entityType");
  const entityId = entityType === "workspace" ? null : assertUuid(input.entityId, "entityId");
  const startsAt = optionalDate(input.startsAt, "startsAt") ?? new Date().toISOString();
  const expiresAt = optionalDate(input.expiresAt, "expiresAt");
  if (expiresAt && Date.parse(expiresAt) <= Date.parse(startsAt)) {
    throw new ContentValidationError("expiresAt must be after startsAt");
  }
  return {
    entityType,
    entityId,
    reason: cleanString(input.reason, "reason", 2000),
    reference: cleanString(input.reference, "reference", 240, false),
    startsAt,
    expiresAt,
  };
}

export function parseLegalHoldRelease(value: unknown) {
  const input = requireRecord(value);
  return {
    expectedUpdatedAt: parseExpectedUpdatedAt(input.expectedUpdatedAt),
    releaseNote: cleanString(input.releaseNote, "releaseNote", 2000),
  };
}

export function parseDataSubjectRequestInput(value: unknown) {
  const input = requireRecord(value);
  return {
    contactId: parseOptionalUuid(input.contactId, "contactId"),
    requestReference: cleanString(input.requestReference, "requestReference", 120),
    requestType: enumValue(input.requestType, dataSubjectRequestTypes, "requestType"),
    dueAt: optionalDate(input.dueAt, "dueAt"),
    reviewNote: cleanString(input.reviewNote, "reviewNote", 4000, false),
  };
}

export function parseDataSubjectRequestUpdate(value: unknown) {
  const input = requireRecord(value);
  return {
    expectedUpdatedAt: parseExpectedUpdatedAt(input.expectedUpdatedAt),
    status: enumValue(input.status, dataSubjectRequestStatuses, "status"),
    identityVerifiedAt: input.identityVerifiedAt === undefined
      ? undefined
      : optionalDate(input.identityVerifiedAt, "identityVerifiedAt"),
    exportJobMetadata: input.exportJobMetadata === undefined
      ? undefined
      : safeMetadata(input.exportJobMetadata),
    reviewNote: input.reviewNote === undefined
      ? undefined
      : cleanString(input.reviewNote, "reviewNote", 4000, false),
  };
}

/**
 * Neutralizes spreadsheet formula execution before RFC-4180 quoting. This must
 * be used for every user-controlled CSV cell, including values beginning with
 * whitespace followed by =, +, -, or @.
 */
export function escapeCsvCell(value: unknown) {
  const raw = value === null || value === undefined
    ? ""
    : typeof value === "string"
      ? value
      : JSON.stringify(value);
  const neutralized = /^[\t\r\n ]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${neutralized.replace(/"/g, '""')}"`;
}

export function buildDataSubjectRequestMetadataCsv(input: {
  id: string;
  requestReference: string;
  requestType: string;
  status: string;
  contactId: string | null;
  dueAt: string | null;
  exportJobMetadata: unknown;
  reviewedAt: string | null;
  updatedAt: string;
}) {
  const headers = [
    "id",
    "request_reference",
    "request_type",
    "status",
    "contact_id",
    "due_at",
    "export_job_metadata",
    "reviewed_at",
    "updated_at",
  ];
  const row = [
    input.id,
    input.requestReference,
    input.requestType,
    input.status,
    input.contactId,
    input.dueAt,
    input.exportJobMetadata,
    input.reviewedAt,
    input.updatedAt,
  ];
  return `${headers.map(escapeCsvCell).join(",")}\r\n${row.map(escapeCsvCell).join(",")}\r\n`;
}
