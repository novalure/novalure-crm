import {
  assertExactObjectKeys,
  canonicalJson,
  requireIsoTimestamp,
  requireSafeText,
  requireSha256,
  sha256,
  validateExternalGateRuntimeBinding,
  verifyExternalGateReceipt,
} from "./external-gate-receipts.mjs";

export const companyProfileApprovalRole = "company-profile-approver";
export const companyProfileApprovalRecordType =
  "NOVALURE_COMPANY_PROFILE_APPROVAL_RECEIPT";
export const companyProfileSnapshotRecordType =
  "NOVALURE_COMPANY_PROFILE_APPROVAL_SNAPSHOT";

function invariant(condition, code) {
  if (!condition) throw new Error(code);
}

function validateProfileSnapshot(snapshot, expectedRuntime) {
  assertExactObjectKeys(snapshot, [
    "approval",
    "audit",
    "contentSha256",
    "countryCode",
    "locked",
    "profileIdSha256",
    "profileVersion",
    "recordType",
    "runtime",
    "schemaVersion",
    "validation",
    "workspaceIdSha256",
  ], "COMPANY_PROFILE_SNAPSHOT");
  invariant(snapshot.schemaVersion === 1, "COMPANY_PROFILE_SNAPSHOT_SCHEMA_INVALID");
  invariant(
    snapshot.recordType === companyProfileSnapshotRecordType,
    "COMPANY_PROFILE_SNAPSHOT_TYPE_INVALID",
  );
  validateExternalGateRuntimeBinding(snapshot.runtime, expectedRuntime);
  requireSha256(snapshot.workspaceIdSha256, "COMPANY_PROFILE_WORKSPACE_DIGEST_INVALID");
  requireSha256(snapshot.profileIdSha256, "COMPANY_PROFILE_ID_DIGEST_INVALID");
  requireSha256(snapshot.contentSha256, "COMPANY_PROFILE_CONTENT_DIGEST_INVALID");
  invariant(/^[A-Z]{2}$/u.test(snapshot.countryCode ?? ""), "COMPANY_PROFILE_COUNTRY_INVALID");
  invariant(snapshot.locked === true, "COMPANY_PROFILE_NOT_LOCKED");
  invariant(
    Number.isSafeInteger(snapshot.profileVersion) && snapshot.profileVersion >= 1,
    "COMPANY_PROFILE_VERSION_INVALID",
  );

  assertExactObjectKeys(snapshot.approval, [
    "approvedAt",
    "approverSubject",
    "status",
  ], "COMPANY_PROFILE_APPROVAL");
  invariant(snapshot.approval.status === "APPROVED", "COMPANY_PROFILE_NOT_APPROVED");
  requireIsoTimestamp(snapshot.approval.approvedAt, "COMPANY_PROFILE_APPROVED_AT_INVALID");
  requireSafeText(snapshot.approval.approverSubject, "COMPANY_PROFILE_APPROVER_INVALID", {
    maximumLength: 240,
    pattern: /^subject:[A-Za-z0-9][A-Za-z0-9._:@/-]{7,240}$/u,
  });

  assertExactObjectKeys(snapshot.validation, [
    "countryPreflight",
    "missingRequiredFields",
    "requiredFields",
  ], "COMPANY_PROFILE_VALIDATION");
  invariant(snapshot.validation.countryPreflight === "PASS", "COMPANY_PROFILE_COUNTRY_PREFLIGHT_NOT_PASS");
  invariant(snapshot.validation.requiredFields === "PASS", "COMPANY_PROFILE_REQUIRED_FIELDS_NOT_PASS");
  invariant(snapshot.validation.missingRequiredFields === 0, "COMPANY_PROFILE_REQUIRED_FIELDS_MISSING");

  assertExactObjectKeys(snapshot.audit, [
    "eventIdSha256",
    "eventSha256",
    "eventType",
    "occurredAt",
    "previousVersion",
    "profileVersion",
  ], "COMPANY_PROFILE_AUDIT");
  requireSha256(snapshot.audit.eventIdSha256, "COMPANY_PROFILE_AUDIT_EVENT_ID_INVALID");
  requireSha256(snapshot.audit.eventSha256, "COMPANY_PROFILE_AUDIT_EVENT_DIGEST_INVALID");
  invariant(
    snapshot.audit.eventType === "COMPANY_PROFILE_APPROVED_LOCKED",
    "COMPANY_PROFILE_AUDIT_EVENT_TYPE_INVALID",
  );
  requireIsoTimestamp(snapshot.audit.occurredAt, "COMPANY_PROFILE_AUDIT_TIME_INVALID");
  invariant(
    snapshot.audit.occurredAt === snapshot.approval.approvedAt,
    "COMPANY_PROFILE_APPROVAL_AUDIT_TIME_MISMATCH",
  );
  invariant(
    snapshot.audit.profileVersion === snapshot.profileVersion,
    "COMPANY_PROFILE_AUDIT_VERSION_MISMATCH",
  );
  invariant(
    Number.isSafeInteger(snapshot.audit.previousVersion)
      && snapshot.audit.previousVersion >= 0
      && snapshot.audit.previousVersion < snapshot.profileVersion,
    "COMPANY_PROFILE_AUDIT_PREVIOUS_VERSION_INVALID",
  );
  return snapshot;
}

export function validateCompanyProfileApprovalReceipt({
  profileSnapshot,
  receipt,
  runtime,
  trustContext,
}) {
  validateExternalGateRuntimeBinding(runtime, runtime);
  validateProfileSnapshot(profileSnapshot, runtime);
  verifyExternalGateReceipt({
    expectedRecordType: companyProfileApprovalRecordType,
    expectedRole: companyProfileApprovalRole,
    receipt,
    trustContext,
  });
  assertExactObjectKeys(receipt.payload, [
    "approvalStatus",
    "approvedAt",
    "auditEventSha256",
    "locked",
    "profileSnapshotSha256",
    "profileVersion",
    "runtime",
    "workspaceIdSha256",
  ], "COMPANY_PROFILE_RECEIPT_PAYLOAD");
  validateExternalGateRuntimeBinding(receipt.payload.runtime, runtime);
  invariant(receipt.payload.approvalStatus === "APPROVED", "COMPANY_PROFILE_RECEIPT_NOT_APPROVED");
  invariant(receipt.payload.locked === true, "COMPANY_PROFILE_RECEIPT_NOT_LOCKED");
  invariant(
    receipt.payload.profileVersion === profileSnapshot.profileVersion,
    "COMPANY_PROFILE_RECEIPT_VERSION_MISMATCH",
  );
  invariant(
    receipt.payload.approvedAt === profileSnapshot.approval.approvedAt,
    "COMPANY_PROFILE_RECEIPT_APPROVED_AT_MISMATCH",
  );
  invariant(
    receipt.payload.workspaceIdSha256 === profileSnapshot.workspaceIdSha256,
    "COMPANY_PROFILE_RECEIPT_WORKSPACE_MISMATCH",
  );
  invariant(
    receipt.payload.auditEventSha256 === profileSnapshot.audit.eventSha256,
    "COMPANY_PROFILE_RECEIPT_AUDIT_DIGEST_MISMATCH",
  );
  invariant(
    receipt.payload.profileSnapshotSha256 === sha256(canonicalJson(profileSnapshot)),
    "COMPANY_PROFILE_RECEIPT_SNAPSHOT_DIGEST_MISMATCH",
  );
  invariant(
    profileSnapshot.approval.approverSubject === receipt.signerSubject,
    "COMPANY_PROFILE_APPROVER_SUBJECT_MISMATCH",
  );
  invariant(
    Date.parse(receipt.signedAt) >= Date.parse(profileSnapshot.approval.approvedAt),
    "COMPANY_PROFILE_RECEIPT_SIGNED_BEFORE_APPROVAL",
  );
  return Object.freeze({
    approvedAt: receipt.payload.approvedAt,
    auditEventSha256: receipt.payload.auditEventSha256,
    locked: true,
    profileSnapshotSha256: receipt.payload.profileSnapshotSha256,
    profileVersion: receipt.payload.profileVersion,
    receiptId: receipt.receiptId,
    signerSubject: receipt.signerSubject,
    status: "VERIFIED",
    workspaceIdSha256: receipt.payload.workspaceIdSha256,
  });
}
