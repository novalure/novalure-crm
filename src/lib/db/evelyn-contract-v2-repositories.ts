import { createHash, randomUUID } from "node:crypto";
import type { AppSession } from "@/lib/auth/session";
import {
  assertCrmUuid,
  assertExpectedVersion,
  assertProjectGrant,
  CrmCommandError,
  executeCrmCommand,
  reconcileCrmCommand,
  withCrmRead,
  type CrmCommandInput,
  type TenantTransaction,
  type TenantTransactionOptions,
} from "@/lib/crm-command";
import {
  assertEvelynApprovalV2RequestSize,
  createEvelynApprovalV2Client,
  EvelynApprovalError,
  type EvelynApprovalActionV2,
  type EvelynApprovalV2Client,
  type EvelynCreateApprovalRequestV2,
  type EvelynCreateApprovalResponseV2,
  type EvelynVerifyRequestV2,
} from "@/lib/evelyn-approval-client";
import {
  approvalActionV2Hash,
  approvalActionV2InputSchema,
  financialSnapshotHash,
  v2ThresholdContext,
} from "@/lib/evelyn-money-tax-v2";
import {
  buildCompleteFinancialSnapshot,
  financialPolicyContentHash,
  financialPolicyPayloadSchema,
  type ResolvedFinancialPolicy,
} from "@/lib/financial-snapshot";
import type { ContractFinancialPolicySelection } from "@/lib/db/financial-snapshot-repositories";
import {
  createOfferContractSnapshotInTransaction,
  readFinancialSnapshotInTransaction,
  recordFinancialApprovalEventInTransaction,
  type AcceptedOfferFinancialSource,
  type FinancialSnapshotRecord,
} from "@/lib/db/financial-snapshot-repositories";
import { offerTotal, parseOfferContent, type OfferContent } from "@/lib/offer-workflow";
import { getOfferApprovalReference } from "./approval-reference-repositories";

type Metadata = { idempotencyKey: string; correlationId: string };
export type EvelynContractV2ActionInput = Metadata & {
  actionId: string;
  expectedVersion: number;
  approvalReference?: string;
};
export type EvelynContractV2Command =
  | (Metadata & {
      operation: "create";
      approvalContractVersion: "v2";
      projectId: string;
      offerId: string;
      expectedOfferVersion: number;
      policySelection: ContractFinancialPolicySelection;
    })
  | (EvelynContractV2ActionInput & {
      operation: "revise";
      approvalContractVersion: "v2";
      projectId: string;
      policySelection: ContractFinancialPolicySelection;
    })
  | (EvelynContractV2ActionInput & {
      operation: "request" | "verify" | "execute";
      approvalContractVersion: "v2";
      projectId: string;
    });

type Target = { workspaceId: string; projectId: string; tenantId: string };
export type EvelynContractV2Options = TenantTransactionOptions & {
  testOnly?: { target: Target; client: EvelynApprovalV2Client };
};
type V2VerificationResult = {
  contractVersion: "approval-bridge-v2";
  environment: "preview";
  status: "VALID";
  approvalReference: string;
  correlationId: string;
  actionVersion: number;
  actionHash: string;
  financialSnapshotHash: string;
};
type Source = AcceptedOfferFinancialSource & {
  version: number;
  contactId: string;
  approvalId: string;
  acceptanceId: string;
};

function approvalRequest(input: {
  requestId: string;
  correlationId: string;
  action: EvelynApprovalActionV2;
  actionHash: string;
  source: Pick<Source, "offerId" | "acceptanceId">;
}): EvelynCreateApprovalRequestV2 {
  return {
    contractVersion: "create-approval-request-v2",
    requestId: input.requestId,
    correlationId: input.correlationId,
    action: input.action,
    actionHash: input.actionHash,
    policyEvidence: {
      financialTotalKnown: true,
      standardContract: false,
      approvedOffer: true,
      customerAccepted: true,
      approvedTemplate: false,
    },
    policyReferences: {
      approvedOfferId: input.source.offerId,
      customerAcceptanceId: input.source.acceptanceId,
      approvedTemplateId: null,
    },
  };
}
type ActionRow = {
  id: string;
  projectId: string;
  offerId: string;
  offerVersion: number | string;
  offerRevision: number | string;
  sourceApprovalId: string;
  sourceContentDigest: string;
  correlationId: string;
  version: number | string;
  currentVersion: number | string;
  action: unknown;
  actionHash: string;
  approvalReference: string | null;
  financialSnapshotId: string;
  financialSnapshotHash: string;
  approvalContractVersion: string;
};
type V2Snapshot = Omit<ActionRow, "action" | "version" | "currentVersion" | "offerVersion" | "offerRevision"> & {
  action: EvelynApprovalActionV2;
  version: number;
  currentVersion: number;
  offerVersion: number;
  offerRevision: number;
  financial: FinancialSnapshotRecord;
};

type PolicyBindingRow = {
  policyKind: "CURRENCY" | "TAX" | "ROUNDING";
  policyId: string;
  policyVersion: string;
  contentHash: string;
  payload: unknown;
  jurisdiction: string | null;
  effectiveFrom: string | Date | null;
  effectiveTo: string | Date | null;
  sourceReference: string;
  verifiedAt: string | Date;
};

function failure(code: string, status = 409): never {
  throw new CrmCommandError(code, code, status);
}
const safeCode = (error: unknown) => error instanceof EvelynApprovalError || error instanceof CrmCommandError
  ? error.code : "EVELYN_UNAVAILABLE";

function derivedId(key: string, suffix: string) {
  const bytes = createHash("sha256").update(`crm-evelyn:${key}:${suffix}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function target(options: EvelynContractV2Options): Target {
  if (options.testOnly) {
    if (process.env.NODE_ENV !== "test" || !options.pool || process.env.VERCEL !== undefined
      || process.env.VERCEL_ENV !== undefined || process.env.VERCEL_URL !== undefined) {
      failure("EVELYN_TEST_OVERRIDE_DISABLED", 403);
    }
  } else if (process.env.VERCEL !== "1" || process.env.VERCEL_ENV !== "preview") {
    failure("EVELYN_PREVIEW_ONLY", 403);
  }
  const configured = options.testOnly?.target ?? {
    workspaceId: process.env.CRM_EVELYN_QA_WORKSPACE_ID!,
    projectId: process.env.CRM_EVELYN_QA_PROJECT_ID!,
    tenantId: process.env.CRM_EVELYN_QA_TENANT_ID!,
  };
  for (const value of Object.values(configured)) assertCrmUuid(value);
  if (configured.tenantId !== configured.workspaceId) failure("EVELYN_TENANT_MAPPING_FORBIDDEN", 403);
  return configured;
}

async function guard(tx: TenantTransaction, session: AppSession, projectId: string, options: EvelynContractV2Options) {
  const configured = target(options);
  if (session.workspaceId !== configured.workspaceId || projectId !== configured.projectId) {
    failure("EVELYN_QA_SCOPE_DENIED", 403);
  }
  await assertProjectGrant(tx, session, projectId, true);
  if (options.testOnly && !(await tx.queryOne<{ local: boolean }>(
    "select inet_server_addr() in ('127.0.0.1'::inet,'::1'::inet) as local",
  ))?.local) failure("LOCAL_TEST_DATABASE_REQUIRED", 403);
  const allowed = await tx.queryOne<{ allowed: boolean }>(
    "select crm_lock_evelyn_preview_target($1::uuid,$2::uuid,$3::uuid) as allowed",
    [session.workspaceId, projectId, configured.tenantId],
  );
  if (!allowed?.allowed) failure("EVELYN_QA_TARGET_NOT_REGISTERED", 403);
  return configured;
}

function asIso(value: string | Date) {
  const iso = value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  if (new Date(iso).toISOString() !== iso) failure("EVELYN_SOURCE_TIMESTAMP_INVALID", 500);
  return iso;
}

async function source(tx: TenantTransaction, session: AppSession, offerId: string, projectId: string): Promise<Source> {
  const row = await tx.queryOne<{
    offerId: string; projectId: string; version: number | string; revision: number | string;
    contactId: string; approvalId: string | null; contentDigest: string; content: OfferContent;
    total: string; acceptanceId: string | null; recordedAt: string | Date; recordedBy: string;
    effectiveAt: string | Date | null;
  }>(`
    select o.id as "offerId",o.project_id as "projectId",o.version,o.revision,o.contact_id as "contactId",
      o.approval_id as "approvalId",r.content_digest as "contentDigest",r.content,
      r.total_net_cents::text as total,r.created_at as "recordedAt",r.created_by as "recordedBy",
      acceptance.id as "acceptanceId",acceptance.changed_at as "effectiveAt"
    from crm_offers o
    join crm_offer_revisions r on r.workspace_id=o.workspace_id and r.offer_id=o.id and r.revision=o.revision
    left join lateral (
      select h.id,h.changed_at from deal_stage_history h
      where h.workspace_id=o.workspace_id and h.deal_id=o.deal_id and h.to_stage='Gewonnen'
        and h.metadata->>'offerId'=o.id::text and h.metadata->>'contentDigest'=r.content_digest
        and h.metadata->>'approvalReference'=o.approval_id::text
      order by h.changed_at desc,h.id desc limit 1
    ) acceptance on true
    where o.workspace_id=$1::uuid and o.project_id=$2::uuid and o.id=$3::uuid
      and o.status='ACCEPTED' and o.response_reference is not null and o.response_actor_id is not null
    for share of o
  `, [session.workspaceId, projectId, assertCrmUuid(offerId, "offerId")]);
  if (!row?.approvalId || !row.acceptanceId || !row.effectiveAt) failure("ACCEPTED_APPROVED_OFFER_REQUIRED");
  const approved = await getOfferApprovalReference(session, row.approvalId);
  if (approved.status !== "APPROVED" || approved.scope.contentDigest !== row.contentDigest
    || approved.scope.resourceId !== row.offerId || approved.scope.resourceVersion !== Number(row.revision)) {
    failure("CURRENT_OFFER_APPROVAL_REQUIRED");
  }
  const content = parseOfferContent(row.content);
  if (!content.subject.startsWith("SYNTHETIC") || !content.terms.startsWith("SYNTHETIC")
    || !content.recipientEmail.endsWith(".invalid") || String(offerTotal(content)) !== row.total) {
    failure("SYNTHETIC_OFFER_REQUIRED", 403);
  }
  return {
    offerId: row.offerId,
    projectId: row.projectId,
    version: Number(row.version),
    revision: Number(row.revision),
    contactId: row.contactId,
    approvalId: row.approvalId,
    acceptanceId: row.acceptanceId,
    contentDigest: row.contentDigest,
    content,
    totalNetMinorUnits: row.total,
    recordedAt: asIso(row.recordedAt),
    recordedBy: row.recordedBy,
    effectiveAt: asIso(row.effectiveAt),
  };
}

function actionHash(action: EvelynApprovalActionV2) {
  return approvalActionV2Hash({ ...action, environment: "preview", synthetic: true });
}

function sameReference(
  actual: { id: string; version: string; contentHash: string },
  expected: { id: string; version: string; contentHash: string },
) {
  return actual.id === expected.id && actual.version === expected.version
    && actual.contentHash === expected.contentHash;
}

function sameMoney(
  actual: { minorUnits: string; currency: string; minorUnitExponent: number } | null,
  expected: { minorUnits: string; currency: string; minorUnitExponent: number },
) {
  return actual !== null && actual.minorUnits === expected.minorUnits
    && actual.currency === expected.currency && actual.minorUnitExponent === expected.minorUnitExponent;
}

function registryInstant(value: string | Date | null) {
  if (value === null) return null;
  try {
    const result = value instanceof Date ? value.toISOString() : new Date(value).toISOString();
    return new Date(result).toISOString() === result ? result : null;
  } catch {
    return null;
  }
}

async function assertFinancialBinding(
  tx: TenantTransaction,
  session: AppSession,
  row: Pick<ActionRow, "id" | "projectId">,
  version: number,
  action: EvelynApprovalActionV2,
  financial: FinancialSnapshotRecord & { snapshot: Extract<FinancialSnapshotRecord["snapshot"], { reviewState: "COMPLETE" }> },
  current: Source,
) {
  const snapshot = financial.snapshot;
  const expectedPricingReference = {
    id: current.offerId,
    version: String(current.revision),
    contentHash: current.contentDigest,
  };
  if (financial.resourceType !== "CONTRACT" || financial.projectId !== row.projectId
    || financial.resourceId !== row.id || financial.businessVersion !== version
    || snapshot.tenantId !== session.workspaceId || snapshot.resourceId !== row.id
    || snapshot.businessVersion !== version || snapshot.effectiveAt !== current.effectiveAt
    || snapshot.currency !== current.content.currency || snapshot.minorUnitExponent !== 2
    || snapshot.totals.net.minorUnits !== current.totalNetMinorUnits
    || !sameReference(snapshot.pricingReference, expectedPricingReference)
    || snapshot.provenance.sourceSystem !== "novalure-crm"
    || snapshot.provenance.sourceRecordId !== current.offerId
    || snapshot.provenance.sourceVersion !== String(current.revision)
    || snapshot.provenance.sourceHash !== current.contentDigest
    || snapshot.provenance.recordedAt !== current.recordedAt
    || snapshot.provenance.recordedBy !== current.recordedBy
    || action.actionId !== row.id || action.workflowId !== row.id || action.resourceId !== row.id
    || action.actionVersion !== version || action.resourceVersion !== version
    || action.payload.scope.projectId !== row.projectId
    || action.payload.contract.id !== row.id || action.payload.contract.version !== version
    || action.payload.recipient.id !== current.contactId
    || action.payload.recipient.email !== current.content.recipientEmail
    || action.financialSnapshotHash !== financial.snapshotHash
    || financialSnapshotHash(action.financialSnapshot) !== financial.snapshotHash
    || !sameMoney(action.economicCommitment.amount, snapshot.totals.net)) {
    failure("FINANCIAL_SNAPSHOT_INTEGRITY_FAILED", 500);
  }
  if (snapshot.components.some(component => !sameReference(component.pricingReference, expectedPricingReference))) {
    failure("FINANCIAL_SNAPSHOT_INTEGRITY_FAILED", 500);
  }

  const required = new Map<string, { kind: PolicyBindingRow["policyKind"]; id: string; version: string }>();
  const addRequired = (kind: PolicyBindingRow["policyKind"], reference: { id: string; version: string }) => {
    required.set(`${kind}\u0000${reference.id}\u0000${reference.version}`, { kind, id: reference.id, version: reference.version });
  };
  addRequired("CURRENCY", snapshot.currencyDefinition.registryReference);
  addRequired("ROUNDING", snapshot.roundingPolicy);
  for (const component of snapshot.components) {
    for (const tax of component.taxComponents) addRequired("TAX", tax.policy.reference);
  }
  const requested = [...required.values()];
  if (requested.length > 22) failure("FINANCIAL_SNAPSHOT_INTEGRITY_FAILED", 500);
  const policyRows = await tx.query<PolicyBindingRow>(`
    select policy_kind as "policyKind",policy_id as "policyId",policy_version as "policyVersion",
      content_hash as "contentHash",contract_payload as payload,jurisdiction,
      effective_from as "effectiveFrom",effective_to as "effectiveTo",
      source_reference as "sourceReference",verified_at as "verifiedAt"
    from crm_financial_policy_versions policy
    where policy.workspace_id=$1::uuid and policy.project_id=$2::uuid and exists(
      select 1 from jsonb_to_recordset($3::jsonb) requested(kind text,id text,version text)
      where requested.kind=policy.policy_kind and requested.id=policy.policy_id
        and requested.version=policy.policy_version
    )
    order by policy_kind,policy_id,policy_version,id
  `, [session.workspaceId, row.projectId, JSON.stringify(requested)]);
  if (policyRows.length !== requested.length) failure("FINANCIAL_SNAPSHOT_INTEGRITY_FAILED", 500);
  const policies = policyRows.map(policy => {
    const parsed = financialPolicyPayloadSchema.safeParse(policy.payload);
    const verifiedAt = registryInstant(policy.verifiedAt);
    const effectiveFrom = registryInstant(policy.effectiveFrom);
    const effectiveTo = registryInstant(policy.effectiveTo);
    if (!parsed.success || financialPolicyContentHash(parsed.data) !== policy.contentHash || verifiedAt === null) {
      failure("FINANCIAL_SNAPSHOT_INTEGRITY_FAILED", 500);
    }
    if ((policy.effectiveFrom !== null && effectiveFrom === null)
      || (policy.effectiveTo !== null && (effectiveTo === null || effectiveFrom === null))
      || (effectiveFrom !== null && snapshot.effectiveAt < effectiveFrom)
      || (effectiveTo !== null && snapshot.effectiveAt >= effectiveTo)) {
      failure("FINANCIAL_SNAPSHOT_INTEGRITY_FAILED", 500);
    }
    const payload = parsed.data;
    if (payload.kind !== policy.policyKind) failure("FINANCIAL_SNAPSHOT_INTEGRITY_FAILED", 500);
    if (payload.kind === "TAX") {
      const provenance = payload.sourceProvenance;
      if (policy.jurisdiction !== payload.jurisdiction || policy.sourceReference !== provenance.sourceReference
        || effectiveFrom !== provenance.effectiveFrom || effectiveTo !== provenance.effectiveTo
        || verifiedAt !== provenance.verifiedAt || snapshot.effectiveAt < provenance.effectiveFrom
        || (provenance.effectiveTo !== null && snapshot.effectiveAt >= provenance.effectiveTo)) {
        failure("FINANCIAL_SNAPSHOT_INTEGRITY_FAILED", 500);
      }
    } else if (policy.jurisdiction !== null
      || (payload.kind === "CURRENCY" && verifiedAt !== payload.verifiedAt)) {
      failure("FINANCIAL_SNAPSHOT_INTEGRITY_FAILED", 500);
    }
    return {
      reference: { id: policy.policyId, version: policy.policyVersion, contentHash: policy.contentHash },
      payload,
    } as ResolvedFinancialPolicy;
  });

  const components = new Map(snapshot.components.map(component => [component.componentId, component]));
  let rebuilt: ReturnType<typeof buildCompleteFinancialSnapshot>;
  try {
    rebuilt = buildCompleteFinancialSnapshot({
      snapshotId: financial.id,
      businessVersion: version,
      tenantId: session.workspaceId,
      resourceId: row.id,
      effectiveAt: current.effectiveAt,
      jurisdiction: snapshot.jurisdiction,
      currencyPolicy: {
        id: snapshot.currencyDefinition.registryReference.id,
        version: snapshot.currencyDefinition.registryReference.version,
      },
      roundingPolicy: { id: snapshot.roundingPolicy.id, version: snapshot.roundingPolicy.version },
      pricingReference: expectedPricingReference,
      provenance: {
        sourceSystem: "novalure-crm",
        sourceRecordId: current.offerId,
        sourceVersion: String(current.revision),
        sourceHash: current.contentDigest,
        recordedAt: current.recordedAt,
        recordedBy: current.recordedBy,
      },
      lines: current.content.items.map((item, index) => {
        const componentId = `line:${String(index + 1).padStart(3, "0")}`;
        const component = components.get(componentId);
        if (!component || component.kind !== "LINE") failure("FINANCIAL_SNAPSHOT_INTEGRITY_FAILED", 500);
        return {
          componentId,
          kind: "LINE" as const,
          netMinorUnits: (BigInt(item.quantity) * BigInt(item.unitNetCents)).toString(),
          pricingReference: expectedPricingReference,
          taxComponents: component.taxComponents.map(tax => ({
            componentId: tax.componentId,
            jurisdiction: snapshot.jurisdiction,
            policy: { id: tax.policy.reference.id, version: tax.policy.reference.version },
          })),
        };
      }),
      policies,
    });
  } catch (error) {
    if (error instanceof CrmCommandError) throw error;
    failure("FINANCIAL_SNAPSHOT_INTEGRITY_FAILED", 500);
  }
  if (components.size !== current.content.items.length || rebuilt.snapshotHash !== financial.snapshotHash) {
    failure("FINANCIAL_SNAPSHOT_INTEGRITY_FAILED", 500);
  }
}

async function read(
  tx: TenantTransaction,
  session: AppSession,
  input: EvelynContractV2ActionInput,
  options: EvelynContractV2Options,
  receiptOnly = false,
): Promise<V2Snapshot> {
  const row = await tx.queryOne<ActionRow>(`
    select a.id,a.project_id as "projectId",a.offer_id as "offerId",a.offer_version as "offerVersion",
      a.offer_revision as "offerRevision",a.source_approval_id as "sourceApprovalId",
      a.source_content_digest as "sourceContentDigest",a.correlation_id as "correlationId",
      a.version as "currentVersion",r.version,r.action,r.action_hash as "actionHash",
      r.approval_contract_version as "approvalContractVersion",r.financial_snapshot_id as "financialSnapshotId",
      r.financial_snapshot_hash as "financialSnapshotHash",p.approval_reference as "approvalReference"
    from crm_evelyn_contract_actions a
    join crm_evelyn_contract_revisions r on r.workspace_id=a.workspace_id and r.action_id=a.id and r.version=$3
    left join crm_evelyn_contract_approvals p on p.workspace_id=a.workspace_id and p.action_id=a.id and p.version=r.version
    where a.workspace_id=$1::uuid and a.id=$2::uuid for update of a
  `, [session.workspaceId, assertCrmUuid(input.actionId, "actionId"), assertExpectedVersion(input.expectedVersion)]);
  if (!row) failure("EVELYN_ACTION_NOT_ACCESSIBLE", 404);
  await guard(tx, session, row.projectId, options);
  if (row.approvalContractVersion !== "v2" || !row.financialSnapshotId || !row.financialSnapshotHash) {
    failure("EVELYN_CONTRACT_VERSION_MISMATCH");
  }
  const version = Number(row.version);
  const currentVersion = Number(row.currentVersion);
  const offerVersion = Number(row.offerVersion);
  const offerRevision = Number(row.offerRevision);
  if (!receiptOnly && currentVersion !== input.expectedVersion) failure("VERSION_MISMATCH");
  if (row.correlationId !== input.correlationId) failure("CORRELATION_MISMATCH");
  const current = await source(tx, session, row.offerId, row.projectId);
  if (current.version !== offerVersion || current.revision !== offerRevision
    || current.approvalId !== row.sourceApprovalId || current.contentDigest !== row.sourceContentDigest) {
    failure("EVELYN_SOURCE_CHANGED");
  }
  const parsed = approvalActionV2InputSchema.safeParse(row.action);
  if (!parsed.success) failure("ACTION_MISMATCH", 500);
  const action = parsed.data;
  const financial = await readFinancialSnapshotInTransaction(tx, session.workspaceId, row.financialSnapshotId);
  if (financial.snapshotHash !== row.financialSnapshotHash || action.financialSnapshotHash !== financial.snapshotHash
    || action.financialSnapshot.snapshotId !== financial.id || actionHash(action) !== row.actionHash
    || action.actionVersion !== version || action.resourceVersion !== version || action.tenantId !== session.workspaceId
    || action.correlationId !== row.correlationId) {
    failure("ACTION_MISMATCH", 500);
  }
  if (financial.reviewState !== "VERIFIED" || financial.snapshot.reviewState !== "COMPLETE") {
    failure("FINANCIAL_SNAPSHOT_NEEDS_REVIEW");
  }
  await assertFinancialBinding(tx, session, row, version, action,
    financial as FinancialSnapshotRecord & { snapshot: Extract<FinancialSnapshotRecord["snapshot"], { reviewState: "COMPLETE" }> },
    current);
  return { ...row, version, currentVersion, offerVersion, offerRevision, action, financial };
}

function command(operation: string, input: EvelynContractV2ActionInput, snapshot: V2Snapshot): CrmCommandInput {
  return {
    operation,
    resourceId: input.actionId,
    projectId: snapshot.projectId,
    expectedVersion: input.expectedVersion,
    idempotencyKey: input.idempotencyKey,
    correlationId: input.correlationId,
    payload: {
      approvalContractVersion: "v2",
      actionId: input.actionId,
      actionVersion: input.expectedVersion,
      actionHash: snapshot.actionHash,
      financialSnapshotHash: snapshot.financialSnapshotHash,
      approvalReference: input.approvalReference ?? null,
    },
    capability: "pipeline:write",
  };
}

/**
 * The snapshot used to derive a command is only a request-side hint.  Before
 * an external call the action row is locked and read again; every value that
 * Evelyn will see must still be the value that was used to derive the command.
 */
function assertPreparedSnapshot(expected: V2Snapshot, current: V2Snapshot) {
  if (current.id !== expected.id || current.projectId !== expected.projectId
    || current.version !== expected.version || current.actionHash !== expected.actionHash
    || current.financial.snapshotHash !== expected.financial.snapshotHash
    || current.correlationId !== expected.correlationId
    || current.offerVersion !== expected.offerVersion || current.offerRevision !== expected.offerRevision
    || current.sourceApprovalId !== expected.sourceApprovalId
    || current.sourceContentDigest !== expected.sourceContentDigest) {
    failure("ACTION_MISMATCH");
  }
}

function approvalReferenceFor(
  input: EvelynContractV2ActionInput,
  current: V2Snapshot,
): string {
  const approvalReference = input.approvalReference ?? current.approvalReference;
  if (!approvalReference) failure("APPROVAL_REFERENCE_REQUIRED");
  assertCrmUuid(approvalReference, "approvalReference");
  if (approvalReference !== current.approvalReference) failure("APPROVAL_REFERENCE_MISMATCH");
  return approvalReference;
}

function verificationRequest(snapshot: V2Snapshot, approvalReference: string): EvelynVerifyRequestV2 {
  return {
    contractVersion: "verify-approval-v2",
    approvalReference,
    tenantId: snapshot.action.tenantId,
    actionId: snapshot.id,
    actionType: "contract.send",
    resourceId: snapshot.action.resourceId,
    actionVersion: snapshot.version,
    actionHash: snapshot.actionHash,
    financialSnapshotSchemaVersion: "financial-snapshot-v1",
    financialSnapshotHash: snapshot.financial.snapshotHash,
    economicCommitment: snapshot.action.economicCommitment,
    correlationId: snapshot.correlationId,
  };
}

function exposeVerificationReceipt(receipt: {
  data: V2VerificationResult;
  replayed: boolean;
  auditReference: string;
  commandId: string;
}) {
  // Keep the historical verify response flat while exposing the durable
  // command replay marker used by the other CRM commands.
  return {
    ...receipt.data,
    replayed: receipt.replayed,
    auditReference: receipt.auditReference,
    commandId: receipt.commandId,
  };
}

async function recordContractEvent(
  tx: TenantTransaction,
  session: AppSession,
  snapshot: V2Snapshot,
  stage: "REQUEST" | "VERIFY" | "EXECUTE",
  code: string,
  reference: string | null,
) {
  await tx.execute(`
    insert into crm_evelyn_contract_events(
      workspace_id,project_id,action_id,version,recorded_by,correlation_id,stage,result_code,approval_reference
    ) values($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6::uuid,$7,$8,$9::uuid)
  `, [session.workspaceId, snapshot.projectId, snapshot.id, snapshot.version, session.userId,
    snapshot.correlationId, stage, /^[A-Z][A-Z0-9_]{0,99}$/.test(code) ? code : "EVELYN_UNAVAILABLE", reference]);
}

async function denial(
  session: AppSession,
  snapshot: V2Snapshot,
  stage: "REQUEST" | "VERIFY" | "EXECUTE",
  error: unknown,
  options: EvelynContractV2Options,
) {
  await withCrmRead(session, async (tx, fresh) => {
    await guard(tx, fresh, snapshot.projectId, options);
    await recordContractEvent(tx, fresh, snapshot, stage, safeCode(error), snapshot.approvalReference);
  }, options);
}

function client(options: EvelynContractV2Options) {
  const configured = target(options);
  return options.testOnly?.client ?? createEvelynApprovalV2Client(configured.tenantId);
}

function v2Action(input: {
  session: AppSession;
  origin: Pick<EvelynApprovalActionV2, "requestingActorId" | "workflowId">;
  actionId: string;
  version: number;
  correlationId: string;
  source: Source;
  financial: FinancialSnapshotRecord;
}): EvelynApprovalActionV2 {
  if (input.financial.snapshot.reviewState !== "COMPLETE") failure("FINANCIAL_SNAPSHOT_NEEDS_REVIEW");
  return approvalActionV2InputSchema.parse({
    actionContractVersion: "approval-action-v2",
    actionId: input.actionId,
    workflowId: assertCrmUuid(input.origin.workflowId),
    tenantId: input.session.workspaceId,
    requestingActorId: assertCrmUuid(input.origin.requestingActorId),
    correlationId: input.correlationId,
    actionType: "contract.send",
    resourceType: "Contract",
    resourceId: input.actionId,
    actionVersion: input.version,
    resourceVersion: input.version,
    payload: {
      recipient: { id: input.source.contactId, email: input.source.content.recipientEmail },
      contract: {
        id: input.actionId,
        version: input.version,
        content: `SYNTHETIC contract derived from accepted offer ${input.source.offerId}; revision ${input.source.revision}; digest ${input.source.contentDigest}; financial snapshot ${input.financial.id}`,
      },
      scope: {
        projectId: input.source.projectId,
        description: "SYNTHETIC Preview contract approval verification; no delivery",
      },
    },
    financialSnapshot: input.financial.snapshot,
    financialSnapshotHash: input.financial.snapshotHash,
    economicCommitment: { basis: "NET", amount: input.financial.snapshot.totals.net },
  });
}

async function insertRevision(tx: TenantTransaction, input: {
  session: AppSession;
  actionId: string;
  projectId: string;
  version: number;
  action: EvelynApprovalActionV2;
  actionHash: string;
  financial: FinancialSnapshotRecord;
}) {
  await tx.execute(`
    insert into crm_evelyn_contract_revisions(
      workspace_id,project_id,action_id,version,created_by,action,action_hash,
      approval_contract_version,financial_snapshot_id,financial_snapshot_hash
    ) values($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6::jsonb,$7,'v2',$8::uuid,$9)
  `, [input.session.workspaceId, input.projectId, input.actionId, input.version, input.session.userId,
    JSON.stringify(input.action), input.actionHash, input.financial.id, input.financial.snapshotHash]);
}

export async function createEvelynContractActionV2(
  session: AppSession,
  input: Extract<EvelynContractV2Command, { operation: "create" }>,
  options: EvelynContractV2Options = {},
) {
  target(options);
  return executeCrmCommand(session, {
    operation: "evelyn.contract.v2.create",
    resourceId: input.offerId,
    projectId: input.projectId,
    expectedVersion: assertExpectedVersion(input.expectedOfferVersion),
    idempotencyKey: input.idempotencyKey,
    correlationId: input.correlationId,
    payload: { approvalContractVersion: "v2", offerId: input.offerId,
      expectedOfferVersion: input.expectedOfferVersion, policySelection: input.policySelection },
    capability: "pipeline:write",
  }, async (tx, context) => {
    await guard(tx, context.session, input.projectId, options);
    const origin = await source(tx, context.session, input.offerId, input.projectId);
    if (origin.version !== input.expectedOfferVersion) failure("VERSION_MISMATCH");
    const actionId = derivedId(origin.offerId, "contract");
    const existing = await tx.queryOne<{
      version: number | string; correlationId: string; contractVersion: string;
      action: Pick<EvelynApprovalActionV2, "requestingActorId" | "workflowId">;
      approvalReference: string | null;
    }>(`
      select a.version,a.correlation_id as "correlationId",r.approval_contract_version as "contractVersion",
        r.action,p.approval_reference as "approvalReference"
      from crm_evelyn_contract_actions a
      join crm_evelyn_contract_revisions r on r.workspace_id=a.workspace_id and r.action_id=a.id and r.version=a.version
      left join crm_evelyn_contract_approvals p on p.workspace_id=a.workspace_id and p.action_id=a.id and p.version=r.version
      where a.workspace_id=$1::uuid and a.id=$2::uuid for update of a
    `, [session.workspaceId, actionId]);
    if (existing?.contractVersion === "v2") failure("EVELYN_ACTION_ALREADY_EXISTS");
    if (existing && existing.correlationId !== input.correlationId) failure("CORRELATION_MISMATCH");
    if (existing && await tx.queryOne(
      "select id from crm_evelyn_contract_executions where workspace_id=$1::uuid and action_id=$2::uuid",
      [session.workspaceId, actionId],
    )) failure("EVELYN_ALREADY_EXECUTED");
    // Evelyn accepts version 1 first, then only the next registered action/resource
    // version. Keep the locked local lineage recoverable until registration commits.
    if (existing && !existing.approvalReference) failure("EVELYN_REGISTRATION_REQUIRED");
    const version = existing ? Number(existing.version) + 1 : 1;
    const snapshotId = derivedId(actionId, `financial:${version}`);
    const financial = await createOfferContractSnapshotInTransaction(tx, {
      session: context.session,
      actionId,
      snapshotId,
      businessVersion: version,
      source: origin,
      selection: input.policySelection,
      correlationId: input.correlationId,
    });
    const action = v2Action({ session: context.session,
      origin: existing?.action ?? { requestingActorId: context.session.userId, workflowId: actionId }, actionId, version,
      correlationId: input.correlationId, source: origin, financial });
    const hash = actionHash(action);
    assertEvelynApprovalV2RequestSize(approvalRequest({
      requestId: input.idempotencyKey,
      correlationId: input.correlationId,
      action,
      actionHash: hash,
      source: origin,
    }));
    if (!existing) {
      await tx.execute(`
        insert into crm_evelyn_contract_actions(
          id,workspace_id,project_id,offer_id,created_by,correlation_id,offer_version,offer_revision,
          source_approval_id,source_content_digest
        ) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7,$8,$9::uuid,$10)
      `, [actionId, session.workspaceId, input.projectId, origin.offerId, session.userId, input.correlationId,
        origin.version, origin.revision, origin.approvalId, origin.contentDigest]);
    }
    await insertRevision(tx, { session: context.session, actionId, projectId: input.projectId,
      version, action, actionHash: hash, financial });
    if (existing) await tx.execute(
      "update crm_evelyn_contract_actions set version=$3 where workspace_id=$1::uuid and id=$2::uuid",
      [session.workspaceId, actionId, version],
    );
    return {
      actionId,
      actionVersion: version,
      actionHash: hash,
      approvalContractVersion: "v2" as const,
      financialSnapshotId: financial.id,
      financialSnapshotHash: financial.snapshotHash,
      economicCommitment: action.economicCommitment,
      correlationId: input.correlationId,
      synthetic: true,
      externalEffect: false,
    };
  }, options);
}

export async function reviseEvelynContractActionV2(
  session: AppSession,
  input: Extract<EvelynContractV2Command, { operation: "revise" }>,
  options: EvelynContractV2Options = {},
) {
  const snapshot = await withCrmRead(session, (tx, fresh) => read(tx, fresh, input, options, true), options);
  const revisionCommand: CrmCommandInput = {
    ...command("evelyn.contract.v2.revise", input, snapshot),
    payload: { approvalContractVersion: "v2", actionId: input.actionId,
      expectedVersion: input.expectedVersion, policySelection: input.policySelection },
  };
  const prior = await reconcileCrmCommand(session, revisionCommand, options);
  if (prior.status === "COMMITTED") return prior;
  return executeCrmCommand(session, revisionCommand, async (tx, context) => {
    const current = await read(tx, context.session, input, options);
    if (await tx.queryOne(
      "select id from crm_evelyn_contract_executions where workspace_id=$1::uuid and action_id=$2::uuid",
      [session.workspaceId, current.id],
    )) failure("EVELYN_ALREADY_EXECUTED");
    if (!current.approvalReference) failure("EVELYN_REGISTRATION_REQUIRED");
    const origin = await source(tx, context.session, current.offerId, current.projectId);
    const version = current.version + 1;
    const financial = await createOfferContractSnapshotInTransaction(tx, {
      session: context.session,
      actionId: current.id,
      snapshotId: derivedId(current.id, `financial:${version}`),
      businessVersion: version,
      source: origin,
      selection: input.policySelection,
      correlationId: input.correlationId,
      supersedesSnapshotId: current.financial.id,
    });
    const action = v2Action({ session: context.session, origin: current.action, actionId: current.id, version,
      correlationId: current.correlationId, source: origin, financial });
    const hash = actionHash(action);
    assertEvelynApprovalV2RequestSize(approvalRequest({
      requestId: input.idempotencyKey,
      correlationId: current.correlationId,
      action,
      actionHash: hash,
      source: origin,
    }));
    await insertRevision(tx, { session: context.session, actionId: current.id, projectId: current.projectId,
      version, action, actionHash: hash, financial });
    await tx.execute(
      "update crm_evelyn_contract_actions set version=$3 where workspace_id=$1::uuid and id=$2::uuid",
      [session.workspaceId, current.id, version],
    );
    return {
      actionId: current.id,
      actionVersion: version,
      actionHash: hash,
      approvalContractVersion: "v2" as const,
      financialSnapshotId: financial.id,
      financialSnapshotHash: financial.snapshotHash,
      economicCommitment: action.economicCommitment,
      correlationId: current.correlationId,
      approvalReference: null,
    };
  }, options);
}

async function prepare(
  session: AppSession,
  input: EvelynContractV2ActionInput,
  operation: string,
  options: EvelynContractV2Options,
) {
  const snapshot = await withCrmRead(session, (tx, fresh) => read(tx, fresh, input, options), options);
  const threshold = v2ThresholdContext({ ...snapshot.action, environment: "preview", synthetic: true });
  if (threshold.status === "NEEDS_REVIEW") failure("FINANCIAL_SNAPSHOT_NEEDS_REVIEW");
  if (threshold.status === "POLICY_REQUIRED") failure("POLICY_REQUIRED");
  await executeCrmCommand(session, {
    ...command(`${operation}.intent`, input, snapshot),
    idempotencyKey: derivedId(input.idempotencyKey, "intent"),
  }, async (tx, context) => {
    const current = await read(tx, context.session, input, options);
    return { actionId: current.id, actionVersion: current.version, actionHash: current.actionHash,
      financialSnapshotHash: current.financial.snapshotHash };
  }, options);
  return snapshot;
}

export async function requestEvelynContractApprovalV2(
  session: AppSession,
  input: EvelynContractV2ActionInput,
  options: EvelynContractV2Options = {},
) {
  const snapshot = await prepare(session, input, "evelyn.contract.v2.request", options);
  const requestCommand = command("evelyn.contract.v2.request", input, snapshot);
  const prior = await reconcileCrmCommand<EvelynCreateApprovalResponseV2>(session, requestCommand, options);
  if (prior.status === "COMMITTED") return prior;
  try {
    return await executeCrmCommand(session, requestCommand, async (tx, context) => {
      // Keep the action lock until the remote call and the local receipt are
      // committed.  Revision commands use the same FOR UPDATE lock, so a
      // revision cannot slip in between this authority check and Evelyn.
      const current = await read(tx, context.session, input, options);
      assertPreparedSnapshot(snapshot, current);
      // A committed approval always has a command receipt in the same
      // transaction.  Seeing one without a replayed receipt means another
      // request already owns this action; do not issue a second remote call.
      if (current.approvalReference) {
        failure("APPROVAL_REFERENCE_CONFLICT");
      }
      const origin = await source(tx, context.session, current.offerId, current.projectId);
      await assertFinancialBinding(tx, context.session, current, current.version, current.action,
        current.financial as FinancialSnapshotRecord & {
          snapshot: Extract<FinancialSnapshotRecord["snapshot"], { reviewState: "COMPLETE" }>;
        }, origin);
      const request = approvalRequest({
        requestId: input.idempotencyKey,
        correlationId: current.correlationId,
        action: current.action,
        actionHash: current.actionHash,
        source: origin,
      });
      const remote = await client(options).requestApprovalV2(request);
      if (!current.approvalReference) {
        await tx.execute(`
          insert into crm_evelyn_contract_approvals(
            workspace_id,project_id,action_id,version,recorded_by,approval_reference,correlation_id
          ) values($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6::uuid,$7::uuid)
        `, [session.workspaceId, current.projectId, current.id, current.version, session.userId,
          remote.approvalReference, current.correlationId]);
      }
      await recordContractEvent(tx, context.session, current, "REQUEST", remote.status, remote.approvalReference);
      await recordFinancialApprovalEventInTransaction(tx, { session: context.session, snapshot: current.financial,
        correlationId: current.correlationId, stage: "REQUESTED", actionHash: current.actionHash });
      return remote;
    }, options);
  } catch (error) {
    await denial(session, snapshot, "REQUEST", error, options);
    throw error;
  }
}

export async function verifyEvelynContractApprovalV2(
  session: AppSession,
  input: EvelynContractV2ActionInput,
  options: EvelynContractV2Options = {},
) {
  const snapshot = await prepare(session, input, "evelyn.contract.v2.verify", options);
  const verifyCommand = command("evelyn.contract.v2.verify", input, snapshot);
  const prior = await reconcileCrmCommand<V2VerificationResult>(session, verifyCommand, options);
  if (prior.status === "COMMITTED") return exposeVerificationReceipt(prior);
  try {
    const committed = await executeCrmCommand<V2VerificationResult>(session, verifyCommand, async (tx, context) => {
      // The locked re-read is deliberately in the same transaction as the
      // external Verify and the audit writes.  A concurrent revise therefore
      // waits, and a stale action cannot reach Evelyn.
      const current = await read(tx, context.session, input, options);
      assertPreparedSnapshot(snapshot, current);
      const approvalReference = approvalReferenceFor(input, current);
      const result = await client(options).verifyApprovalV2(verificationRequest(current, approvalReference));
      await recordContractEvent(tx, context.session, current, "VERIFY", "VALID", approvalReference);
      await recordFinancialApprovalEventInTransaction(tx, { session: context.session, snapshot: current.financial,
        correlationId: current.correlationId, stage: "VERIFIED", actionHash: current.actionHash });
      return { ...result, actionVersion: current.version, actionHash: current.actionHash,
        financialSnapshotHash: current.financial.snapshotHash };
    }, options);
    return exposeVerificationReceipt(committed);
  } catch (error) {
    await denial(session, snapshot, "VERIFY", error, options);
    throw error;
  }
}

export async function executeEvelynContractActionV2(
  session: AppSession,
  input: EvelynContractV2ActionInput,
  options: EvelynContractV2Options = {},
) {
  const snapshot = await prepare(session, input, "evelyn.contract.v2.execute", options);
  const execution = command("evelyn.contract.v2.execute", input, snapshot);
  const prior = await reconcileCrmCommand(session, execution, options);
  if (prior.status === "COMMITTED") return prior;
  try {
    return await executeCrmCommand(session, execution, async (tx, context) => {
      // Hold the action lock through Verify and the synthetic execution write;
      // no revision can invalidate the authority after the remote check.
      const current = await read(tx, context.session, input, options);
      assertPreparedSnapshot(snapshot, current);
      const approvalReference = approvalReferenceFor(input, current);
      if (await tx.queryOne(
        "select id from crm_evelyn_contract_executions where workspace_id=$1::uuid and action_id=$2::uuid",
        [session.workspaceId, current.id],
      )) failure("EVELYN_ALREADY_EXECUTED");
      await client(options).verifyApprovalV2(verificationRequest(current, approvalReference));
      const effect = await tx.queryOne<{ id: string }>(`
        insert into crm_evelyn_contract_executions(
          workspace_id,project_id,action_id,version,executed_by,approval_reference,correlation_id
        ) values($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6::uuid,$7::uuid) returning id
      `, [session.workspaceId, current.projectId, current.id, current.version, session.userId,
        approvalReference, current.correlationId]);
      if (!effect) failure("EVELYN_EXECUTION_WRITE_FAILED", 500);
      await recordContractEvent(tx, context.session, current, "EXECUTE", "VALID", approvalReference);
      return { id: effect.id, actionId: current.id, actionVersion: current.version,
        approvalContractVersion: "v2" as const, financialSnapshotId: current.financial.id,
        financialSnapshotHash: current.financial.snapshotHash, approvalReference,
        correlationId: current.correlationId, effect: "SYNTHETIC_CONTRACT_SEND",
        externalEffect: false, contractDelivered: false };
    }, options);
  } catch (error) {
    await denial(session, snapshot, "EXECUTE", error, options);
    throw error;
  }
}

export async function getEvelynContractActionV2(
  session: AppSession,
  actionId: string,
  options: EvelynContractV2Options = {},
) {
  return withCrmRead(session, async (tx, fresh) => {
    const row = await tx.queryOne<{ version: number | string; correlationId: string }>(
      "select version,correlation_id as \"correlationId\" from crm_evelyn_contract_actions where workspace_id=$1::uuid and id=$2::uuid",
      [fresh.workspaceId, assertCrmUuid(actionId, "actionId")],
    );
    if (!row) failure("EVELYN_ACTION_NOT_ACCESSIBLE", 404);
    const snapshot = await read(tx, fresh, { actionId, expectedVersion: Number(row.version),
      correlationId: row.correlationId, idempotencyKey: randomUUID() }, options);
    return { actionId: snapshot.id, projectId: snapshot.projectId, offerId: snapshot.offerId,
      actionVersion: snapshot.version, actionHash: snapshot.actionHash, approvalContractVersion: "v2" as const,
      financialSnapshotId: snapshot.financial.id, financialSnapshotHash: snapshot.financial.snapshotHash,
      economicCommitment: snapshot.action.economicCommitment, correlationId: snapshot.correlationId,
      approvalReference: snapshot.approvalReference, reviewState: snapshot.financial.reviewState,
      synthetic: true, externalEffect: false };
  }, options);
}

export async function executeEvelynContractV2Command(
  session: AppSession,
  input: EvelynContractV2Command,
  options: EvelynContractV2Options = {},
) {
  const configured = target(options);
  if (input.projectId !== configured.projectId) failure("EVELYN_QA_SCOPE_DENIED", 403);
  switch (input.operation) {
    case "create": return createEvelynContractActionV2(session, input, options);
    case "revise": return reviseEvelynContractActionV2(session, input, options);
    case "request": return requestEvelynContractApprovalV2(session, input, options);
    case "verify": return verifyEvelynContractApprovalV2(session, input, options);
    case "execute": return executeEvelynContractActionV2(session, input, options);
  }
}
