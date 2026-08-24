import {
  assertExactObjectKeys,
  canonicalJson,
  isPlainObject,
  requireIsoTimestamp,
  requireSha256,
  sha256,
  verifyExternalGateReceipt,
} from "./external-gate-receipts.mjs";
import {
  recoveryExpectedDatabaseName,
  recoveryExpectedProductionBranchId,
  recoveryExpectedProjectId,
} from "./database-recovery-query-pack.mjs";
import {
  launchScopeDecisionSha256,
  launchScopePolicySha256,
  launchScopePolicyVersion,
} from "../../src/lib/launch-scope.ts";

export const productionFunnelTokenCutoverSchemaVersion = 1;
export const productionFunnelTokenCutoverRecordType =
  "NOVALURE_PRODUCTION_FUNNEL_TOKEN_CUTOVER_EVIDENCE";
export const productionFunnelTokenCutoverReceiptRecordType =
  "NOVALURE_PRODUCTION_FUNNEL_TOKEN_CUTOVER_RECEIPT";
export const productionFunnelTokenCutoverRole =
  "production-funnel-token-cutover-attestor";
export const productionFunnelTokenCutoverExpectedVercelProjectId =
  "prj_R32Okl6AHijTohvuKmryuTLjWMsk";
export const productionFunnelTokenCutoverExpectedProductionHost =
  "www.novalure-crm.app";
export const productionFunnelTokenCutoverEmptyReason =
  "NO_PREEXISTING_PUBLISHED_FUNNEL_CAPABILITIES";

export const productionFunnelTokenCutoverInventoryQuery = `select
  funnel.workspace_id as "workspaceId",
  funnel.id as "funnelId",
  coalesce(
    case
      when jsonb_typeof(funnel.tracking->'publicationRevision') = 'number'
        then (funnel.tracking->>'publicationRevision')::bigint
      else 0
    end,
    0
  ) as "revisionBefore",
  encode(
    digest(
      convert_to(
        coalesce(
          nullif(btrim(funnel.tracking->>'publishToken'), ''),
          nullif(btrim(funnel.tracking->>'publicToken'), '')
        ),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  ) as "priorCapabilitySha256"
from funnels funnel
where coalesce(
  nullif(btrim(funnel.tracking->>'publishToken'), ''),
  nullif(btrim(funnel.tracking->>'publicToken'), '')
) is not null
order by funnel.workspace_id, funnel.id`;

export const productionFunnelTokenCutoverInventoryQuerySha256 = sha256(
  `${productionFunnelTokenCutoverInventoryQuery}\n`,
);

const commitPattern = /^[a-f0-9]{40}$/u;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const vercelDeploymentIdPattern = /^dpl_[A-Za-z0-9]{20,80}$/u;
const vercelDeploymentHostPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.vercel\.app$/u;

function invariant(condition, code) {
  if (!condition) throw new Error(code);
}

function timestampMilliseconds(value, code) {
  return Date.parse(requireIsoTimestamp(value, code));
}

function assertTimestampWithin(value, minimum, maximum, code) {
  const observed = timestampMilliseconds(value, `${code}_INVALID`);
  invariant(observed >= minimum && observed <= maximum, `${code}_OUTSIDE_CUTOVER_WINDOW`);
  return observed;
}

function validatePolicyBinding(policy) {
  assertExactObjectKeys(policy, [
    "decisionSha256",
    "policySha256",
    "policyVersion",
  ], "PRODUCTION_FUNNEL_TOKEN_CUTOVER_POLICY");
  invariant(
    policy.policyVersion === launchScopePolicyVersion,
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_POLICY_VERSION_MISMATCH",
  );
  invariant(
    policy.policySha256 === launchScopePolicySha256,
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_POLICY_DIGEST_MISMATCH",
  );
  invariant(
    policy.decisionSha256 === launchScopeDecisionSha256,
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_DECISION_DIGEST_MISMATCH",
  );
  return policy;
}

function validateProductionTarget(target, expectedProductionTarget = null) {
  assertExactObjectKeys(target, [
    "databaseName",
    "neonBranchId",
    "neonProjectId",
    "productionHost",
    "vercelDeploymentHost",
    "vercelDeploymentId",
    "vercelProjectId",
  ], "PRODUCTION_FUNNEL_TOKEN_CUTOVER_TARGET");
  invariant(
    target.databaseName === recoveryExpectedDatabaseName,
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_TARGET_DATABASE_MISMATCH",
  );
  invariant(
    target.neonBranchId === recoveryExpectedProductionBranchId,
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_TARGET_NEON_BRANCH_MISMATCH",
  );
  invariant(
    target.neonProjectId === recoveryExpectedProjectId,
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_TARGET_NEON_PROJECT_MISMATCH",
  );
  invariant(
    target.productionHost === productionFunnelTokenCutoverExpectedProductionHost,
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_TARGET_PRODUCTION_HOST_MISMATCH",
  );
  invariant(
    target.vercelProjectId === productionFunnelTokenCutoverExpectedVercelProjectId,
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_TARGET_VERCEL_PROJECT_MISMATCH",
  );
  invariant(
    vercelDeploymentIdPattern.test(target.vercelDeploymentId ?? ""),
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_TARGET_DEPLOYMENT_INVALID",
  );
  invariant(
    vercelDeploymentHostPattern.test(target.vercelDeploymentHost ?? ""),
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_TARGET_DEPLOYMENT_HOST_INVALID",
  );
  if (expectedProductionTarget !== null) {
    assertExactObjectKeys(
      expectedProductionTarget,
      Object.keys(target),
      "PRODUCTION_FUNNEL_TOKEN_CUTOVER_EXPECTED_TARGET",
    );
    for (const key of Object.keys(target)) {
      invariant(
        target[key] === expectedProductionTarget[key],
        `PRODUCTION_FUNNEL_TOKEN_CUTOVER_TARGET_${key.toUpperCase()}_MISMATCH`,
      );
    }
  }
  return target;
}

function validateLinkObservation(observation, {
  capabilitySha256,
  code,
  expectedHttpStatus,
  expectedOutcome,
  maximumTimestamp,
  minimumTimestamp,
}) {
  assertExactObjectKeys(observation, [
    "capabilitySha256",
    "checkedAt",
    "evidenceSha256",
    "httpStatus",
    "outcome",
  ], code);
  invariant(
    observation.capabilitySha256 === capabilitySha256,
    `${code}_CAPABILITY_MISMATCH`,
  );
  requireSha256(observation.evidenceSha256, `${code}_EVIDENCE_DIGEST_INVALID`);
  invariant(observation.httpStatus === expectedHttpStatus, `${code}_HTTP_STATUS_INVALID`);
  invariant(observation.outcome === expectedOutcome, `${code}_OUTCOME_INVALID`);
  assertTimestampWithin(
    observation.checkedAt,
    minimumTimestamp,
    maximumTimestamp,
    `${code}_CHECKED_AT`,
  );
}

function validateProofObservation(observation, {
  capabilitySha256,
  code,
  errorCode,
  expectedHttpStatus,
  expectedOutcome,
  maximumTimestamp,
  minimumTimestamp,
  proofSha256,
}) {
  assertExactObjectKeys(observation, [
    "capabilitySha256",
    "checkedAt",
    "errorCode",
    "evidenceSha256",
    "httpStatus",
    "outcome",
    "proofSha256",
  ], code);
  invariant(
    observation.capabilitySha256 === capabilitySha256,
    `${code}_CAPABILITY_MISMATCH`,
  );
  invariant(observation.proofSha256 === proofSha256, `${code}_PROOF_MISMATCH`);
  requireSha256(observation.evidenceSha256, `${code}_EVIDENCE_DIGEST_INVALID`);
  invariant(observation.httpStatus === expectedHttpStatus, `${code}_HTTP_STATUS_INVALID`);
  invariant(observation.outcome === expectedOutcome, `${code}_OUTCOME_INVALID`);
  invariant(observation.errorCode === errorCode, `${code}_ERROR_CODE_INVALID`);
  assertTimestampWithin(
    observation.checkedAt,
    minimumTimestamp,
    maximumTimestamp,
    `${code}_CHECKED_AT`,
  );
}

function inventoryEntry(entry) {
  return {
    funnelId: entry.funnelId,
    priorCapabilitySha256: entry.priorCapabilitySha256,
    revisionBefore: entry.revisionBefore,
    workspaceId: entry.workspaceId,
  };
}

export function buildProductionFunnelTokenInventorySha256(entries) {
  invariant(Array.isArray(entries), "PRODUCTION_FUNNEL_TOKEN_CUTOVER_ENTRIES_REQUIRED");
  return sha256(canonicalJson(entries.map(inventoryEntry)));
}

export function buildProductionFunnelTokenCutoverEvidenceSha256(document) {
  invariant(isPlainObject(document), "PRODUCTION_FUNNEL_TOKEN_CUTOVER_DOCUMENT_REQUIRED");
  const unsignedDocument = Object.fromEntries(
    Object.entries(document).filter(([key]) => key !== "receipt"),
  );
  return sha256(canonicalJson(unsignedDocument));
}

function validateRotatedEntry(entry, {
  completedAt,
  inventoryObservedAt,
  startedAt,
}) {
  assertExactObjectKeys(entry, [
    "funnelId",
    "nonCapabilityStateSha256After",
    "nonCapabilityStateSha256Before",
    "observations",
    "priorCapabilitySha256",
    "priorProofCapturedAt",
    "priorProofSha256",
    "replacementCapabilitySha256",
    "replacementProofSha256",
    "revisionAfter",
    "revisionBefore",
    "rotatedAt",
    "workspaceId",
  ], "PRODUCTION_FUNNEL_TOKEN_CUTOVER_ENTRY");
  invariant(uuidPattern.test(entry.workspaceId ?? ""), "PRODUCTION_FUNNEL_TOKEN_CUTOVER_WORKSPACE_ID_INVALID");
  invariant(uuidPattern.test(entry.funnelId ?? ""), "PRODUCTION_FUNNEL_TOKEN_CUTOVER_FUNNEL_ID_INVALID");
  invariant(
    Number.isSafeInteger(entry.revisionBefore) && entry.revisionBefore >= 0,
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_REVISION_BEFORE_INVALID",
  );
  invariant(
    entry.revisionAfter === entry.revisionBefore + 1,
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_REVISION_NOT_INCREMENTED",
  );
  requireSha256(
    entry.priorCapabilitySha256,
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_PRIOR_CAPABILITY_DIGEST_INVALID",
  );
  requireSha256(
    entry.replacementCapabilitySha256,
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_REPLACEMENT_CAPABILITY_DIGEST_INVALID",
  );
  invariant(
    entry.priorCapabilitySha256 !== entry.replacementCapabilitySha256,
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_CAPABILITY_NOT_ROTATED",
  );
  requireSha256(entry.priorProofSha256, "PRODUCTION_FUNNEL_TOKEN_CUTOVER_PRIOR_PROOF_DIGEST_INVALID");
  requireSha256(
    entry.replacementProofSha256,
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_REPLACEMENT_PROOF_DIGEST_INVALID",
  );
  invariant(
    entry.priorProofSha256 !== entry.replacementProofSha256,
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_PROOF_NOT_REPLACED",
  );
  requireSha256(
    entry.nonCapabilityStateSha256Before,
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_STATE_BEFORE_DIGEST_INVALID",
  );
  requireSha256(
    entry.nonCapabilityStateSha256After,
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_STATE_AFTER_DIGEST_INVALID",
  );
  invariant(
    entry.nonCapabilityStateSha256After === entry.nonCapabilityStateSha256Before,
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_NON_CAPABILITY_STATE_DRIFT",
  );

  const priorProofCapturedAt = assertTimestampWithin(
    entry.priorProofCapturedAt,
    Math.max(startedAt, inventoryObservedAt),
    completedAt,
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_PRIOR_PROOF_CAPTURED_AT",
  );
  const rotatedAt = assertTimestampWithin(
    entry.rotatedAt,
    priorProofCapturedAt,
    completedAt,
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_ROTATED_AT",
  );
  assertExactObjectKeys(entry.observations, [
    "newLink",
    "newProof",
    "oldLink",
    "oldProof",
  ], "PRODUCTION_FUNNEL_TOKEN_CUTOVER_OBSERVATIONS");
  validateLinkObservation(entry.observations.oldLink, {
    capabilitySha256: entry.priorCapabilitySha256,
    code: "PRODUCTION_FUNNEL_TOKEN_CUTOVER_OLD_LINK",
    expectedHttpStatus: 404,
    expectedOutcome: "NOT_FOUND",
    maximumTimestamp: completedAt,
    minimumTimestamp: rotatedAt,
  });
  validateLinkObservation(entry.observations.newLink, {
    capabilitySha256: entry.replacementCapabilitySha256,
    code: "PRODUCTION_FUNNEL_TOKEN_CUTOVER_NEW_LINK",
    expectedHttpStatus: 200,
    expectedOutcome: "PASS",
    maximumTimestamp: completedAt,
    minimumTimestamp: rotatedAt,
  });
  validateProofObservation(entry.observations.newProof, {
    capabilitySha256: entry.replacementCapabilitySha256,
    code: "PRODUCTION_FUNNEL_TOKEN_CUTOVER_NEW_PROOF",
    errorCode: null,
    expectedHttpStatus: 200,
    expectedOutcome: "PASS",
    maximumTimestamp: completedAt,
    minimumTimestamp: rotatedAt,
    proofSha256: entry.replacementProofSha256,
  });
  validateProofObservation(entry.observations.oldProof, {
    capabilitySha256: entry.priorCapabilitySha256,
    code: "PRODUCTION_FUNNEL_TOKEN_CUTOVER_OLD_PROOF",
    errorCode: "funnel_publication_stale",
    expectedHttpStatus: 409,
    expectedOutcome: "REJECTED",
    maximumTimestamp: completedAt,
    minimumTimestamp: rotatedAt,
    proofSha256: entry.priorProofSha256,
  });
  return entry;
}

function validateInventory(inventory, entries, mode, startedAt, completedAt) {
  assertExactObjectKeys(inventory, [
    "authoritativeEmpty",
    "emptyReasonCode",
    "entriesSha256",
    "inventoryQuerySha256",
    "observedAt",
    "sourceArtifactSha256",
    "totalAffectedFunnels",
  ], "PRODUCTION_FUNNEL_TOKEN_CUTOVER_INVENTORY");
  const inventoryObservedAt = assertTimestampWithin(
    inventory.observedAt,
    startedAt,
    completedAt,
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_INVENTORY_OBSERVED_AT",
  );
  requireSha256(
    inventory.sourceArtifactSha256,
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_INVENTORY_SOURCE_DIGEST_INVALID",
  );
  invariant(
    inventory.inventoryQuerySha256 === productionFunnelTokenCutoverInventoryQuerySha256,
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_INVENTORY_QUERY_MISMATCH",
  );
  invariant(
    Number.isSafeInteger(inventory.totalAffectedFunnels)
      && inventory.totalAffectedFunnels >= 0
      && inventory.totalAffectedFunnels === entries.length,
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_INVENTORY_COUNT_MISMATCH",
  );
  invariant(
    inventory.entriesSha256 === buildProductionFunnelTokenInventorySha256(entries),
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_INVENTORY_DIGEST_MISMATCH",
  );
  if (mode === "ROTATED") {
    invariant(entries.length > 0, "PRODUCTION_FUNNEL_TOKEN_CUTOVER_ROTATED_INVENTORY_EMPTY");
    invariant(
      inventory.authoritativeEmpty === false && inventory.emptyReasonCode === null,
      "PRODUCTION_FUNNEL_TOKEN_CUTOVER_ROTATED_INVENTORY_MARKED_EMPTY",
    );
  } else {
    invariant(entries.length === 0, "PRODUCTION_FUNNEL_TOKEN_CUTOVER_EMPTY_INVENTORY_NOT_EMPTY");
    invariant(
      inventory.authoritativeEmpty === true
        && inventory.emptyReasonCode === productionFunnelTokenCutoverEmptyReason,
      "PRODUCTION_FUNNEL_TOKEN_CUTOVER_EMPTY_NOT_AUTHORITATIVE",
    );
  }
  return inventoryObservedAt;
}

function validateReceiptPayload(receipt, document) {
  const payload = receipt.payload;
  assertExactObjectKeys(payload, [
    "attestationDecision",
    "candidateCommit",
    "completedAt",
    "evidenceSha256",
    "inventorySha256",
    "mode",
    "policy",
    "productionMutationPerformed",
    "productionTarget",
    "totalAffectedFunnels",
  ], "PRODUCTION_FUNNEL_TOKEN_CUTOVER_RECEIPT_PAYLOAD");
  invariant(
    payload.attestationDecision === (
      document.mode === "ROTATED"
        ? "ROTATION_VERIFIED"
        : "AUTHORITATIVE_EMPTY_VERIFIED"
    ),
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_RECEIPT_DECISION_INVALID",
  );
  for (const key of [
    "candidateCommit",
    "completedAt",
    "mode",
    "productionMutationPerformed",
  ]) {
    invariant(
      payload[key] === document[key],
      `PRODUCTION_FUNNEL_TOKEN_CUTOVER_RECEIPT_${key.toUpperCase()}_MISMATCH`,
    );
  }
  invariant(
    canonicalJson(payload.policy) === canonicalJson(document.policy),
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_RECEIPT_POLICY_MISMATCH",
  );
  invariant(
    canonicalJson(payload.productionTarget) === canonicalJson(document.productionTarget),
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_RECEIPT_TARGET_MISMATCH",
  );
  invariant(
    payload.totalAffectedFunnels === document.inventory.totalAffectedFunnels,
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_RECEIPT_COUNT_MISMATCH",
  );
  invariant(
    payload.inventorySha256 === document.inventory.entriesSha256,
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_RECEIPT_INVENTORY_DIGEST_MISMATCH",
  );
  invariant(
    payload.evidenceSha256 === buildProductionFunnelTokenCutoverEvidenceSha256(document),
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_RECEIPT_EVIDENCE_DIGEST_MISMATCH",
  );
}

export function validateProductionFunnelTokenCutoverEvidence({
  document,
  expectedCandidateCommit,
  expectedProductionTarget = null,
  trustContext,
}) {
  invariant(
    commitPattern.test(expectedCandidateCommit ?? ""),
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_EXPECTED_CANDIDATE_INVALID",
  );
  assertExactObjectKeys(document, [
    "candidateCommit",
    "completedAt",
    "entries",
    "inventory",
    "mode",
    "policy",
    "productionMutationPerformed",
    "productionTarget",
    "receipt",
    "recordType",
    "schemaVersion",
    "startedAt",
    "status",
  ], "PRODUCTION_FUNNEL_TOKEN_CUTOVER_DOCUMENT");
  invariant(
    document.schemaVersion === productionFunnelTokenCutoverSchemaVersion,
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_SCHEMA_INVALID",
  );
  invariant(
    document.recordType === productionFunnelTokenCutoverRecordType,
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_RECORD_TYPE_INVALID",
  );
  invariant(document.status === "PASS", "PRODUCTION_FUNNEL_TOKEN_CUTOVER_STATUS_NOT_PASS");
  invariant(
    document.mode === "ROTATED" || document.mode === "AUTHORITATIVE_EMPTY",
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_MODE_INVALID",
  );
  invariant(
    document.candidateCommit === expectedCandidateCommit,
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_CANDIDATE_MISMATCH",
  );
  validatePolicyBinding(document.policy);
  validateProductionTarget(document.productionTarget, expectedProductionTarget);
  const startedAt = timestampMilliseconds(
    document.startedAt,
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_STARTED_AT_INVALID",
  );
  const completedAt = timestampMilliseconds(
    document.completedAt,
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_COMPLETED_AT_INVALID",
  );
  invariant(completedAt >= startedAt, "PRODUCTION_FUNNEL_TOKEN_CUTOVER_TIME_ORDER_INVALID");
  invariant(Array.isArray(document.entries), "PRODUCTION_FUNNEL_TOKEN_CUTOVER_ENTRIES_REQUIRED");
  const inventoryObservedAt = validateInventory(
    document.inventory,
    document.entries,
    document.mode,
    startedAt,
    completedAt,
  );
  const inventoryKeys = [];
  const priorCapabilities = new Set();
  const replacementCapabilities = new Set();
  if (document.mode === "ROTATED") {
    for (const entry of document.entries) {
      validateRotatedEntry(entry, { completedAt, inventoryObservedAt, startedAt });
      const inventoryKey = `${entry.workspaceId}:${entry.funnelId}`;
      invariant(
        inventoryKeys.length === 0 || inventoryKeys.at(-1).localeCompare(inventoryKey) < 0,
        "PRODUCTION_FUNNEL_TOKEN_CUTOVER_INVENTORY_ORDER_OR_DUPLICATE_INVALID",
      );
      inventoryKeys.push(inventoryKey);
      invariant(
        !priorCapabilities.has(entry.priorCapabilitySha256),
        "PRODUCTION_FUNNEL_TOKEN_CUTOVER_PRIOR_CAPABILITY_DUPLICATED",
      );
      invariant(
        !replacementCapabilities.has(entry.replacementCapabilitySha256),
        "PRODUCTION_FUNNEL_TOKEN_CUTOVER_REPLACEMENT_CAPABILITY_DUPLICATED",
      );
      priorCapabilities.add(entry.priorCapabilitySha256);
      replacementCapabilities.add(entry.replacementCapabilitySha256);
    }
    invariant(
      [...replacementCapabilities].every((digest) => !priorCapabilities.has(digest)),
      "PRODUCTION_FUNNEL_TOKEN_CUTOVER_OLD_CAPABILITY_REUSED",
    );
    invariant(
      document.productionMutationPerformed === true,
      "PRODUCTION_FUNNEL_TOKEN_CUTOVER_MUTATION_NOT_RECORDED",
    );
  } else {
    invariant(
      document.productionMutationPerformed === false,
      "PRODUCTION_FUNNEL_TOKEN_CUTOVER_EMPTY_MUTATION_RECORDED",
    );
  }

  verifyExternalGateReceipt({
    expectedRecordType: productionFunnelTokenCutoverReceiptRecordType,
    expectedRole: productionFunnelTokenCutoverRole,
    receipt: document.receipt,
    trustContext,
  });
  validateReceiptPayload(document.receipt, document);
  invariant(
    timestampMilliseconds(
      document.receipt.signedAt,
      "PRODUCTION_FUNNEL_TOKEN_CUTOVER_RECEIPT_SIGNED_AT_INVALID",
    ) >= completedAt,
    "PRODUCTION_FUNNEL_TOKEN_CUTOVER_RECEIPT_PREDATES_EVIDENCE",
  );
  return Object.freeze({
    candidateCommit: document.candidateCommit,
    completedAt: document.completedAt,
    inventorySha256: document.inventory.entriesSha256,
    mode: document.mode,
    productionTarget: Object.freeze({ ...document.productionTarget }),
    totalAffectedFunnels: document.inventory.totalAffectedFunnels,
    verificationStatus: "PASS",
  });
}
