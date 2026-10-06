import { z } from "zod";
import type { AppSession } from "@/lib/auth/session";
import {
  assertProjectGrant,
  assertCrmUuid,
  CrmCommandError,
  executeCrmCommand,
  withCrmRead,
  type TenantTransaction,
  type TenantTransactionOptions,
} from "@/lib/crm-command";
import {
  buildCompleteFinancialSnapshot,
  financialPolicyContentHash,
  financialPolicyPayloadSchema,
  type AuthoritativeFinancialLine,
  type FinancialPolicyPayload,
  type ResolvedFinancialPolicy,
  FinancialSnapshotError,
} from "@/lib/financial-snapshot";
import {
  financialSnapshotHash,
  normalizeFinancialSnapshotV1,
  type CompleteFinancialSnapshotV1,
  type FinancialSnapshotV1,
} from "@/lib/evelyn-money-tax-v2";
import { parseOfferContent, type OfferContent } from "@/lib/offer-workflow";

export type FinancialResourceType = "OFFER" | "PROPERTY_SALE" | "DEAL" | "CONTRACT" | "PROPERTY_COST_MATRIX";
export type FinancialReviewState = "NEEDS_REVIEW" | "VERIFIED";
export type FinancialPolicyRegistrationInput = Readonly<{
  projectId: string;
  policyId: string;
  policyVersion: string;
  payload: FinancialPolicyPayload;
  sourceReference: string;
  verifiedAt: string;
  idempotencyKey: string;
  correlationId: string;
}>;

export type LegacyFinancialSnapshotResolutionInput = Readonly<{
  projectId: string;
  priorSnapshotId: string;
  expectedPriorSnapshotHash: string;
  policySelection: ContractFinancialPolicySelection;
  reviewDecision: "VERIFY_EVIDENCED_NET";
  idempotencyKey: string;
  correlationId: string;
}>;

const referencePart = z.string().min(1).max(200).regex(/^\S(?:[^\u0000-\u001f\u007f]*\S)?$/u);
const canonicalInstant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const financialPolicyRegistrationSchema = z.strictObject({
  projectId: z.uuid(),
  policyId: referencePart,
  policyVersion: referencePart,
  payload: financialPolicyPayloadSchema,
  sourceReference: referencePart,
  verifiedAt: canonicalInstant,
  idempotencyKey: z.uuid(),
  correlationId: z.uuid(),
});
const policySelector = z.strictObject({ id: referencePart, version: referencePart });
const canonicalMinorUnits = z.string().regex(/^(?:0|-?[1-9][0-9]{0,77})$/);
const contractPolicySelectionSchema = z.strictObject({
  jurisdiction: z.string().regex(/^[A-Z0-9][A-Z0-9._:-]{0,79}$/),
  currencyPolicy: policySelector,
  roundingPolicy: policySelector,
  taxPolicies: z.array(z.strictObject({
    componentId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,49}$/),
    policy: policySelector,
  })).min(1).max(20),
}).superRefine((value, context) => {
  const ids = value.taxPolicies.map(item => item.componentId);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "DUPLICATE_TAX_COMPONENT_ID" });
  const selectors = [value.currencyPolicy, value.roundingPolicy, ...value.taxPolicies.map(item => item.policy)];
  const keys = selectors.map(item => `${item.id}\u0000${item.version}`);
  if (new Set(keys).size !== keys.length) context.addIssue({ code: "custom", message: "DUPLICATE_POLICY_REFERENCE" });
});
export type ContractFinancialPolicySelection = z.infer<typeof contractPolicySelectionSchema>;

const legacyFinancialSnapshotResolutionSchema = z.strictObject({
  projectId: z.uuid(),
  priorSnapshotId: z.uuid(),
  expectedPriorSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  policySelection: contractPolicySelectionSchema,
  reviewDecision: z.literal("VERIFY_EVIDENCED_NET"),
  idempotencyKey: z.uuid(),
  correlationId: z.uuid(),
});

export type AcceptedOfferFinancialSource = Readonly<{
  offerId: string;
  projectId: string;
  revision: number;
  contentDigest: string;
  content: OfferContent;
  totalNetMinorUnits: string;
  recordedAt: string;
  recordedBy: string;
  effectiveAt: string;
}>;

export type FinancialSnapshotRecord = Readonly<{
  id: string;
  projectId: string | null;
  resourceType: FinancialResourceType;
  resourceId: string;
  businessVersion: number;
  reviewState: FinancialReviewState;
  snapshot: FinancialSnapshotV1;
  snapshotHash: string;
  supersedesSnapshotId: string | null;
  legacyClassification: "A" | "B" | "C" | null;
  createdAt: string;
}>;

type PolicyRow = {
  id: string;
  projectId: string;
  policyKind: string;
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

type SnapshotRow = {
  id: string;
  projectId: string | null;
  resourceType: FinancialResourceType;
  resourceId: string;
  businessVersion: number | string;
  reviewState: FinancialReviewState;
  snapshot: unknown;
  snapshotHash: string;
  supersedesSnapshotId: string | null;
  legacyClassification: "A" | "B" | "C" | null;
  createdAt: string | Date;
};

function fail(code: string, status = 409): never {
  throw new CrmCommandError(code, code, status);
}

function iso(value: string | Date): string {
  const result = value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  if (!canonicalInstant.safeParse(result).success) fail("INVALID_FINANCIAL_TIMESTAMP", 400);
  return result;
}

function policyKind(payload: FinancialPolicyPayload): FinancialPolicyPayload["kind"] {
  return payload.kind;
}

function policyMetadata(payload: FinancialPolicyPayload) {
  if (payload.kind === "TAX") {
    return {
      jurisdiction: payload.jurisdiction,
      effectiveFrom: payload.sourceProvenance.effectiveFrom,
      effectiveTo: payload.sourceProvenance.effectiveTo,
    };
  }
  return { jurisdiction: null, effectiveFrom: null, effectiveTo: null };
}

function assertPolicyRow(row: PolicyRow): { recordId: string; policy: ResolvedFinancialPolicy } {
  const payload = financialPolicyPayloadSchema.parse(row.payload);
  if (row.policyKind !== policyKind(payload) || row.contentHash !== financialPolicyContentHash(payload)) {
    fail("FINANCIAL_POLICY_INTEGRITY_FAILED", 500);
  }
  const metadata = policyMetadata(payload);
  const from = row.effectiveFrom === null ? null : iso(row.effectiveFrom);
  const to = row.effectiveTo === null ? null : iso(row.effectiveTo);
  if (row.jurisdiction !== metadata.jurisdiction || from !== metadata.effectiveFrom || to !== metadata.effectiveTo) {
    fail("FINANCIAL_POLICY_METADATA_MISMATCH", 500);
  }
  if (payload.kind === "TAX" && iso(row.verifiedAt) !== payload.sourceProvenance.verifiedAt) {
    fail("FINANCIAL_POLICY_METADATA_MISMATCH", 500);
  }
  if (payload.kind === "TAX" && row.sourceReference !== payload.sourceProvenance.sourceReference) {
    fail("FINANCIAL_POLICY_METADATA_MISMATCH", 500);
  }
  if (payload.kind === "CURRENCY" && iso(row.verifiedAt) !== payload.verifiedAt) {
    fail("FINANCIAL_POLICY_METADATA_MISMATCH", 500);
  }
  return {
    recordId: row.id,
    policy: {
      reference: { id: row.policyId, version: row.policyVersion, contentHash: row.contentHash },
      payload,
    } as ResolvedFinancialPolicy,
  };
}

export async function registerFinancialPolicyVersion(
  session: AppSession,
  rawInput: FinancialPolicyRegistrationInput,
  options: TenantTransactionOptions = {},
) {
  const parsed = financialPolicyRegistrationSchema.safeParse(rawInput);
  if (!parsed.success) fail("INVALID_FINANCIAL_POLICY", 400);
  const input = parsed.data;
  const payload = input.payload;
  const projectId = input.projectId;
  const policyId = input.policyId;
  const policyVersion = input.policyVersion;
  const sourceReference = input.sourceReference;
  const verifiedAt = input.verifiedAt;
  if (payload.kind === "TAX") {
    if (payload.sourceProvenance.policyVersion !== policyVersion
      || payload.sourceProvenance.verifiedAt !== verifiedAt
      || payload.sourceProvenance.sourceReference !== sourceReference) {
      fail("FINANCIAL_POLICY_METADATA_MISMATCH", 400);
    }
  } else if (payload.kind === "CURRENCY" && payload.verifiedAt !== verifiedAt) {
    fail("FINANCIAL_POLICY_METADATA_MISMATCH", 400);
  }
  const hash = financialPolicyContentHash(payload);
  const metadata = policyMetadata(payload);
  return executeCrmCommand(session, {
    operation: "financial.policy.register",
    projectId,
    idempotencyKey: input.idempotencyKey,
    correlationId: input.correlationId,
    payload: { policyId, policyVersion, payload, sourceReference, verifiedAt },
    capability: "settings:manage",
  }, async (tx, context) => {
    const inserted = await tx.queryOne<{ id: string }>(`
      insert into crm_financial_policy_versions(
        workspace_id,project_id,policy_kind,policy_id,policy_version,content_hash,contract_payload,
        jurisdiction,effective_from,effective_to,source_reference,verified_at,created_by,correlation_id
      ) values($1::uuid,$2::uuid,$3,$4,$5,$6,$7::jsonb,$8,$9::timestamptz,$10::timestamptz,$11,$12::timestamptz,$13::uuid,$14::uuid)
      returning id
    `, [
      session.workspaceId, projectId, policyKind(payload), policyId, policyVersion, hash, JSON.stringify(payload),
      metadata.jurisdiction, metadata.effectiveFrom, metadata.effectiveTo, sourceReference, verifiedAt,
      context.actorId, context.correlationId,
    ]);
    if (!inserted) fail("FINANCIAL_POLICY_WRITE_FAILED", 500);
    return { id: inserted.id, projectId, policyId, policyVersion, kind: payload.kind, contentHash: hash };
  }, options);
}

async function resolvePolicySelection(
  tx: TenantTransaction,
  workspaceId: string,
  projectId: string,
  selection: ContractFinancialPolicySelection,
) {
  const wanted = [selection.currencyPolicy, selection.roundingPolicy, ...selection.taxPolicies.map(item => item.policy)];
  const rows = await tx.query<PolicyRow>(`
    select id,project_id as "projectId",policy_kind as "policyKind",policy_id as "policyId",
      policy_version as "policyVersion",content_hash as "contentHash",contract_payload as payload,
      jurisdiction,effective_from as "effectiveFrom",effective_to as "effectiveTo",
      source_reference as "sourceReference",verified_at as "verifiedAt"
    from crm_financial_policy_versions
    where workspace_id=$1::uuid and project_id=$2::uuid
      and exists (
        select 1
        from jsonb_to_recordset($3::jsonb) as requested(id text, version text)
        where requested.id=policy_id and requested.version=policy_version
      )
    order by policy_kind,policy_id,policy_version,id
  `, [workspaceId, projectId, JSON.stringify(wanted)]);
  const checked = rows.map(assertPolicyRow);
  const selected = wanted.map(selector => {
    const matches = checked.filter(item => item.policy.reference.id === selector.id && item.policy.reference.version === selector.version);
    if (matches.length === 0) fail("UNKNOWN_FINANCIAL_POLICY", 409);
    if (matches.length !== 1) fail("DUPLICATE_FINANCIAL_POLICY", 500);
    return matches[0];
  });
  return { policies: selected.map(item => item.policy), records: selected };
}

function mapSnapshotRow(row: SnapshotRow): FinancialSnapshotRecord {
  const snapshot = normalizeFinancialSnapshotV1(row.snapshot);
  const hash = financialSnapshotHash(snapshot);
  const businessVersion = Number(row.businessVersion);
  if (!Number.isSafeInteger(businessVersion) || businessVersion < 1
    || hash !== row.snapshotHash || snapshot.snapshotId !== row.id
    || snapshot.resourceId !== row.resourceId || snapshot.businessVersion !== businessVersion
    || (snapshot.reviewState === "COMPLETE" ? "VERIFIED" : "NEEDS_REVIEW") !== row.reviewState) {
    fail("FINANCIAL_SNAPSHOT_INTEGRITY_FAILED", 500);
  }
  return Object.freeze({
    id: row.id,
    projectId: row.projectId,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    businessVersion,
    reviewState: row.reviewState,
    snapshot,
    snapshotHash: hash,
    supersedesSnapshotId: row.supersedesSnapshotId,
    legacyClassification: row.legacyClassification,
    createdAt: iso(row.createdAt),
  });
}

async function insertEvent(tx: TenantTransaction, input: {
  session: AppSession;
  projectId: string;
  snapshotId: string;
  eventType: "SNAPSHOT_RECORDED" | "LEGACY_NEEDS_REVIEW" | "REVIEW_VERIFIED" | "POLICY_BOUND" | "SUPERSEDED" | "APPROVAL_REQUESTED" | "APPROVAL_VERIFIED";
  snapshotHash: string;
  correlationId: string;
  policyVersionId?: string | null;
  relatedSnapshotId?: string | null;
  approvalContractVersion?: "v1" | "v2" | null;
  actionHash?: string | null;
  details?: Record<string, unknown>;
}) {
  await tx.execute(`
    insert into crm_financial_events(
      workspace_id,project_id,snapshot_id,event_type,policy_version_id,related_snapshot_id,
      approval_contract_version,action_hash,financial_snapshot_hash,actor_id,correlation_id,details
    ) values($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6::uuid,$7,$8,$9,$10::uuid,$11::uuid,$12::jsonb)
  `, [input.session.workspaceId, input.projectId, input.snapshotId, input.eventType,
    input.policyVersionId ?? null, input.relatedSnapshotId ?? null, input.approvalContractVersion ?? null,
    input.actionHash ?? null, input.snapshotHash, input.session.userId, input.correlationId,
    JSON.stringify(input.details ?? {})]);
}

/**
 * Build and persist a contract snapshot from an immutable accepted offer. The caller
 * supplies only registry selectors; every amount comes from the locked server source.
 */
export async function createOfferContractSnapshotInTransaction(tx: TenantTransaction, input: {
  session: AppSession;
  actionId: string;
  snapshotId: string;
  businessVersion: number;
  source: AcceptedOfferFinancialSource;
  selection: ContractFinancialPolicySelection;
  correlationId: string;
  supersedesSnapshotId?: string | null;
}): Promise<FinancialSnapshotRecord & { snapshot: CompleteFinancialSnapshotV1 }> {
  const actionId = assertCrmUuid(input.actionId, "actionId");
  const snapshotId = assertCrmUuid(input.snapshotId, "snapshotId");
  const projectId = assertCrmUuid(input.source.projectId, "projectId");
  assertCrmUuid(input.source.offerId, "offerId");
  assertCrmUuid(input.source.recordedBy, "recordedBy");
  if (!Number.isSafeInteger(input.businessVersion) || input.businessVersion < 1) fail("VERSION_REQUIRED");
  const selection = contractPolicySelectionSchema.parse(input.selection);
  const content = parseOfferContent(input.source.content);
  const calculatedNet = content.items.reduce(
    (sum, item) => sum + BigInt(item.quantity) * BigInt(item.unitNetCents),
    BigInt(0),
  ).toString();
  if (calculatedNet !== input.source.totalNetMinorUnits) fail("FINANCIAL_SOURCE_MISMATCH");
  const legacySource = await tx.queryOne<{ id: string }>(`
    select id from crm_financial_snapshots
    where workspace_id=$1::uuid and resource_type='OFFER' and resource_id=$2::uuid and review_state='NEEDS_REVIEW'
    order by business_version desc,id desc limit 1
  `, [input.session.workspaceId, input.source.offerId]);
  const resolved = await resolvePolicySelection(tx, input.session.workspaceId, projectId, selection);
  const selectedCurrency = resolved.policies.find(policy =>
    policy.reference.id === selection.currencyPolicy.id
      && policy.reference.version === selection.currencyPolicy.version,
  );
  if (selectedCurrency?.payload.kind !== "CURRENCY"
    || selectedCurrency.payload.code !== content.currency
    || selectedCurrency.payload.minorUnitExponent !== 2) {
    // The immutable offer revision is the monetary source. A policy may validate
    // that source, but it cannot reinterpret EUR minor units as another currency.
    fail("POLICY_REQUIRED");
  }
  const pricingReference = {
    id: input.source.offerId,
    version: String(input.source.revision),
    contentHash: input.source.contentDigest,
  };
  const built = buildCompleteFinancialSnapshot({
    snapshotId,
    businessVersion: input.businessVersion,
    tenantId: input.session.workspaceId,
    resourceId: actionId,
    effectiveAt: canonicalInstant.parse(input.source.effectiveAt),
    jurisdiction: selection.jurisdiction,
    currencyPolicy: selection.currencyPolicy,
    roundingPolicy: selection.roundingPolicy,
    pricingReference,
    provenance: {
      sourceSystem: "novalure-crm",
      sourceRecordId: input.source.offerId,
      sourceVersion: String(input.source.revision),
      sourceHash: input.source.contentDigest,
      recordedAt: canonicalInstant.parse(input.source.recordedAt),
      recordedBy: input.source.recordedBy,
    },
    lines: content.items.map((item, index) => {
      const lineId = `line:${String(index + 1).padStart(3, "0")}`;
      return {
        componentId: lineId,
        kind: "LINE" as const,
        netMinorUnits: (BigInt(item.quantity) * BigInt(item.unitNetCents)).toString(),
        pricingReference,
        taxComponents: selection.taxPolicies.map(tax => ({
          componentId: `${lineId}:tax:${tax.componentId}`,
          jurisdiction: selection.jurisdiction,
          policy: tax.policy,
        })),
      };
    }),
    policies: resolved.policies,
  });
  const row = await tx.queryOne<SnapshotRow>(`
    insert into crm_financial_snapshots(
      id,workspace_id,project_id,resource_type,resource_id,business_version,review_state,
      canonical_snapshot,snapshot_hash,supersedes_snapshot_id,created_by,correlation_id
    ) values($1::uuid,$2::uuid,$3::uuid,'CONTRACT',$4::uuid,$5,'VERIFIED',$6::jsonb,$7,$8::uuid,$9::uuid,$10::uuid)
    returning id,project_id as "projectId",resource_type as "resourceType",resource_id as "resourceId",
      business_version as "businessVersion",review_state as "reviewState",canonical_snapshot as snapshot,
      snapshot_hash as "snapshotHash",supersedes_snapshot_id as "supersedesSnapshotId",
      legacy_classification as "legacyClassification",created_at as "createdAt"
  `, [snapshotId, input.session.workspaceId, projectId, actionId, input.businessVersion,
    JSON.stringify(built.snapshot), built.snapshotHash, input.supersedesSnapshotId ?? null,
    input.session.userId, input.correlationId]);
  if (!row) fail("FINANCIAL_SNAPSHOT_WRITE_FAILED", 500);
  await insertEvent(tx, { session: input.session, projectId, snapshotId, eventType: "SNAPSHOT_RECORDED",
    snapshotHash: built.snapshotHash, correlationId: input.correlationId,
    relatedSnapshotId: input.supersedesSnapshotId ?? null,
    details: { resourceType: "CONTRACT", businessVersion: input.businessVersion } });
  if (input.supersedesSnapshotId) {
    await insertEvent(tx, { session: input.session, projectId, snapshotId, eventType: "SUPERSEDED",
      snapshotHash: built.snapshotHash, correlationId: input.correlationId,
      relatedSnapshotId: input.supersedesSnapshotId,
      details: { priorSnapshotId: input.supersedesSnapshotId } });
  }
  if (legacySource) {
    await insertEvent(tx, { session: input.session, projectId, snapshotId, eventType: "REVIEW_VERIFIED",
      snapshotHash: built.snapshotHash, correlationId: input.correlationId,
      relatedSnapshotId: legacySource.id,
      details: { resolvedResourceType: "OFFER", resolutionTargetType: "CONTRACT",
        sourceOfferId: input.source.offerId } });
  }
  for (const policy of resolved.records) {
    await insertEvent(tx, { session: input.session, projectId, snapshotId, eventType: "POLICY_BOUND",
      snapshotHash: built.snapshotHash, correlationId: input.correlationId,
      policyVersionId: policy.recordId,
      details: { policyId: policy.policy.reference.id, policyVersion: policy.policy.reference.version,
        policyKind: policy.policy.payload.kind } });
  }
  return mapSnapshotRow(row) as FinancialSnapshotRecord & { snapshot: CompleteFinancialSnapshotV1 };
}

function evidenceRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function evidenceMinorUnits(value: unknown): string {
  const parsed = canonicalMinorUnits.safeParse(value);
  if (!parsed.success || parsed.data.startsWith("-")) fail("FINANCIAL_EVIDENCE_REQUIRED", 409);
  return parsed.data;
}

function taxApplications(componentId: string, selection: ContractFinancialPolicySelection) {
  return selection.taxPolicies.map(tax => ({
    componentId: `${componentId}:tax:${tax.componentId}`,
    jurisdiction: selection.jurisdiction,
    policy: tax.policy,
  }));
}

function runtimeCostPeriodNet(item: Record<string, unknown>, periodName: "monthly" | "oneTime") {
  const period = evidenceRecord(item[periodName]);
  if (!period) return null;
  const provided = evidenceRecord(period.provided);
  const derived = Array.isArray(period.derived) ? period.derived : [];
  if (provided?.net !== true && !derived.includes("net")) return null;
  return evidenceMinorUnits(period.net);
}

/**
 * Convert only immutable, server-read evidence into reviewed net lines. The caller can
 * attest that the evidenced amounts are NET and select policies, but cannot submit money,
 * timestamps or source references.
 */
function deriveLegacyReviewAuthority(input: {
  prior: FinancialSnapshotRecord;
  legacyEvidence: unknown;
  evidenceHash: string;
  selection: ContractFinancialPolicySelection;
}) {
  const { prior, selection } = input;
  const evidence = evidenceRecord(input.legacyEvidence);
  if (!evidence || (prior.legacyClassification !== "A" && prior.legacyClassification !== "B")) {
    fail("FINANCIAL_EVIDENCE_REQUIRED", 409);
  }
  const source = typeof evidence.source === "string" ? evidence.source : "";
  const allowedSources: Record<FinancialResourceType, readonly string[]> = {
    OFFER: [],
    CONTRACT: [],
    DEAL: ["won-deal-bound-accepted-offer", "deal-won-transition-bound-accepted-offer"],
    PROPERTY_SALE: ["property-sale-bound-unit-audit"],
    PROPERTY_COST_MATRIX: ["legacy-property-cost-items", "property-cost-items-v1"],
  };
  if (!allowedSources[prior.resourceType].includes(source)) fail("FINANCIAL_EVIDENCE_REQUIRED", 409);

  const effectiveAt = prior.snapshot.effectiveAt ?? prior.snapshot.provenance?.recordedAt;
  if (!effectiveAt || !canonicalInstant.safeParse(effectiveAt).success) {
    fail("FINANCIAL_EVIDENCE_REQUIRED", 409);
  }
  const pricingReference = {
    id: prior.id,
    version: String(prior.businessVersion),
    contentHash: input.evidenceHash,
  };
  const line = (componentId: string, netMinorUnits: string): AuthoritativeFinancialLine => ({
    componentId,
    kind: "LINE",
    netMinorUnits,
    pricingReference,
    taxComponents: taxApplications(componentId, selection),
  });

  const priorNet = prior.snapshot.totals.net;
  let lines: AuthoritativeFinancialLine[];
  if (priorNet !== null) {
    lines = [line("evidence:net", evidenceMinorUnits(priorNet.minorUnits))];
  } else if (prior.resourceType === "PROPERTY_SALE") {
    lines = [line("evidence:sale-price", evidenceMinorUnits(evidence.saleTimePriceMinorUnits))];
  } else if (prior.resourceType === "PROPERTY_COST_MATRIX") {
    if (!Array.isArray(evidence.items) || evidence.items.length === 0 || evidence.items.length > 50) {
      fail("FINANCIAL_EVIDENCE_REQUIRED", 409);
    }
    lines = evidence.items.flatMap((rawItem, index) => {
      const item = evidenceRecord(rawItem);
      if (!item) fail("FINANCIAL_EVIDENCE_REQUIRED", 409);
      const position = String(index + 1).padStart(3, "0");
      const legacyMonthly = item.monthlyNetMinorUnits === undefined
        ? null : evidenceMinorUnits(item.monthlyNetMinorUnits);
      const legacyOneTime = item.oneTimeNetMinorUnits === undefined
        ? null : evidenceMinorUnits(item.oneTimeNetMinorUnits);
      const monthly = legacyMonthly ?? runtimeCostPeriodNet(item, "monthly");
      const oneTime = legacyOneTime ?? runtimeCostPeriodNet(item, "oneTime");
      return [
        ...(monthly === null ? [] : [line(`evidence:cost:${position}:monthly`, monthly)]),
        ...(oneTime === null ? [] : [line(`evidence:cost:${position}:one-time`, oneTime)]),
      ];
    });
    if (lines.length === 0) fail("FINANCIAL_EVIDENCE_REQUIRED", 409);
  } else {
    fail("FINANCIAL_EVIDENCE_REQUIRED", 409);
  }

  return {
    effectiveAt,
    evidencedCurrency: priorNet?.currency ?? prior.snapshot.currency,
    evidencedExponent: priorNet?.minorUnitExponent ?? prior.snapshot.minorUnitExponent,
    lines,
    pricingReference,
  };
}

/**
 * Resolve one immutable legacy NEEDS_REVIEW snapshot without reusing mutable CRM totals.
 * The reviewer selects policies and attests that locked evidence is NET. Amounts,
 * effective time, source reference, tax, gross and every persisted hash are server derived.
 */
export async function resolveLegacyFinancialSnapshot(
  session: AppSession,
  rawInput: LegacyFinancialSnapshotResolutionInput,
  options: TenantTransactionOptions = {},
) {
  const parsed = legacyFinancialSnapshotResolutionSchema.safeParse(rawInput);
  if (!parsed.success) fail("INVALID_FINANCIAL_REVIEW", 400);
  const input = parsed.data;
  const policyProjectId = assertCrmUuid(input.projectId, "projectId");
  const priorSnapshotId = assertCrmUuid(input.priorSnapshotId, "priorSnapshotId");
  return executeCrmCommand(session, {
    operation: "financial.snapshot.resolve_legacy",
    resourceId: priorSnapshotId,
    projectId: policyProjectId,
    idempotencyKey: input.idempotencyKey,
    correlationId: input.correlationId,
    payload: {
      priorSnapshotId,
      expectedPriorSnapshotHash: input.expectedPriorSnapshotHash,
      policySelection: input.policySelection,
      reviewDecision: input.reviewDecision,
    },
    capability: "settings:manage",
  }, async (tx, context) => {
    // Snapshot rows are append-only, so serialize by logical identity without taking
    // a row lock that would require UPDATE permission on the immutable relation.
    await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `financial-review:${context.workspaceId}:${priorSnapshotId}`,
    ]);
    const prior = await readFinancialSnapshotInTransaction(tx, context.workspaceId, priorSnapshotId);
    // A projectless DEAL has owner-scoped read authority but no immutable relationship
    // to a project-scoped policy registry. Keep it out of review rather than selecting a
    // caller-provided registry and weakening the snapshot/policy foreign-key binding.
    if (prior.projectId === null) fail("FINANCIAL_PROJECTLESS_REVIEW_UNSUPPORTED", 409);
    if (prior.projectId !== policyProjectId) fail("FINANCIAL_SNAPSHOT_NOT_ACCESSIBLE", 404);
    const snapshotProjectId = prior.projectId;
    if (prior.snapshotHash !== input.expectedPriorSnapshotHash) {
      fail("FINANCIAL_SNAPSHOT_HASH_MISMATCH", 409);
    }
    if (prior.reviewState !== "NEEDS_REVIEW" || prior.snapshot.reviewState !== "NEEDS_REVIEW"
      || prior.legacyClassification === null) {
      fail("FINANCIAL_SNAPSHOT_NOT_REVIEWABLE", 409);
    }
    if (prior.resourceType !== "DEAL" && prior.resourceType !== "PROPERTY_SALE"
      && prior.resourceType !== "PROPERTY_COST_MATRIX") {
      fail("FINANCIAL_RESOURCE_NOT_REVIEWABLE", 409);
    }
    if (prior.businessVersion >= Number.MAX_SAFE_INTEGER) fail("VERSION_REQUIRED", 409);
    const evidenceRow = await tx.queryOne<{ legacyEvidence: unknown; evidenceHash: string }>(`
      select legacy_evidence as "legacyEvidence",
        crm_financial_sha256(jsonb_build_object(
          'contractVersion','legacy-financial-review-evidence-v1',
          'priorSnapshotHash',snapshot_hash,
          'legacyEvidence',legacy_evidence
        )) as "evidenceHash"
      from crm_financial_snapshots
      where workspace_id=$1::uuid and id=$2::uuid
    `, [context.workspaceId, prior.id]);
    if (!evidenceRow) fail("FINANCIAL_EVIDENCE_REQUIRED", 409);
    const businessVersion = prior.businessVersion + 1;
    const existing = await tx.queryOne<{ id: string }>(`
      select id from crm_financial_snapshots
      where workspace_id=$1::uuid and (
        supersedes_snapshot_id=$2::uuid
        or (resource_type=$3 and resource_id=$4::uuid and business_version=$5)
      )
      order by id limit 1
    `, [context.workspaceId, prior.id, prior.resourceType, prior.resourceId, businessVersion]);
    if (existing) fail("FINANCIAL_SNAPSHOT_ALREADY_RESOLVED", 409);

    const identity = await tx.queryOne<{ id: string }>(`
      select crm_financial_deterministic_uuid($1) as id
    `, [`review-resolution:${context.workspaceId}:${prior.id}:${businessVersion}`]);
    if (!identity) fail("FINANCIAL_SNAPSHOT_WRITE_FAILED", 500);
    const recorded = await tx.queryOne<{ recordedAt: string | Date }>(`
      select transaction_timestamp() as "recordedAt"
    `);
    if (!recorded) fail("FINANCIAL_SNAPSHOT_WRITE_FAILED", 500);
    const resolved = await resolvePolicySelection(tx, context.workspaceId, policyProjectId, input.policySelection);
    const authority = deriveLegacyReviewAuthority({
      prior,
      legacyEvidence: evidenceRow.legacyEvidence,
      evidenceHash: evidenceRow.evidenceHash,
      selection: input.policySelection,
    });
    const selectedCurrency = resolved.policies.find(policy =>
      policy.reference.id === input.policySelection.currencyPolicy.id
        && policy.reference.version === input.policySelection.currencyPolicy.version,
    );
    if (selectedCurrency?.payload.kind !== "CURRENCY"
      || (authority.evidencedCurrency !== null
        && selectedCurrency.payload.code !== authority.evidencedCurrency)
      || (authority.evidencedExponent !== null
        && selectedCurrency.payload.minorUnitExponent !== authority.evidencedExponent)) {
      fail("FINANCIAL_EVIDENCE_CURRENCY_MISMATCH", 409);
    }
    let built: { snapshot: CompleteFinancialSnapshotV1; snapshotHash: string };
    try {
      built = buildCompleteFinancialSnapshot({
        snapshotId: identity.id,
        businessVersion,
        tenantId: context.workspaceId,
        resourceId: prior.resourceId,
        effectiveAt: authority.effectiveAt,
        jurisdiction: input.policySelection.jurisdiction,
        currencyPolicy: input.policySelection.currencyPolicy,
        roundingPolicy: input.policySelection.roundingPolicy,
        pricingReference: authority.pricingReference,
        provenance: {
          sourceSystem: "novalure-crm-financial-review",
          sourceRecordId: prior.id,
          sourceVersion: String(prior.businessVersion),
          sourceHash: evidenceRow.evidenceHash,
          recordedAt: iso(recorded.recordedAt),
          recordedBy: context.actorId,
        },
        lines: authority.lines,
        policies: resolved.policies,
      });
    } catch (error) {
      if (error instanceof FinancialSnapshotError) fail(error.code, 409);
      throw error;
    }
    const row = await tx.queryOne<SnapshotRow>(`
      insert into crm_financial_snapshots(
        id,workspace_id,project_id,resource_type,resource_id,business_version,review_state,
        canonical_snapshot,snapshot_hash,supersedes_snapshot_id,created_by,correlation_id
      ) values($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6,'VERIFIED',$7::jsonb,$8,$9::uuid,$10::uuid,$11::uuid)
      returning id,project_id as "projectId",resource_type as "resourceType",resource_id as "resourceId",
        business_version as "businessVersion",review_state as "reviewState",canonical_snapshot as snapshot,
        snapshot_hash as "snapshotHash",supersedes_snapshot_id as "supersedesSnapshotId",
        legacy_classification as "legacyClassification",created_at as "createdAt"
    `, [identity.id, context.workspaceId, snapshotProjectId, prior.resourceType, prior.resourceId, businessVersion,
      JSON.stringify(built.snapshot), built.snapshotHash, prior.id, context.actorId, context.correlationId]);
    if (!row) fail("FINANCIAL_SNAPSHOT_WRITE_FAILED", 500);
    await insertEvent(tx, {
      session: context.session,
      projectId: snapshotProjectId,
      snapshotId: identity.id,
      eventType: "SNAPSHOT_RECORDED",
      snapshotHash: built.snapshotHash,
      correlationId: context.correlationId,
      relatedSnapshotId: prior.id,
      details: { resourceType: prior.resourceType, businessVersion, resolutionOf: prior.id },
    });
    await insertEvent(tx, {
      session: context.session,
      projectId: snapshotProjectId,
      snapshotId: identity.id,
      eventType: "SUPERSEDED",
      snapshotHash: built.snapshotHash,
      correlationId: context.correlationId,
      relatedSnapshotId: prior.id,
      details: { priorSnapshotId: prior.id, priorSnapshotHash: prior.snapshotHash },
    });
    await insertEvent(tx, {
      session: context.session,
      projectId: snapshotProjectId,
      snapshotId: identity.id,
      eventType: "REVIEW_VERIFIED",
      snapshotHash: built.snapshotHash,
      correlationId: context.correlationId,
      relatedSnapshotId: prior.id,
      details: { priorReviewState: "NEEDS_REVIEW", legacyClassification: prior.legacyClassification },
    });
    for (const policy of resolved.records) {
      await insertEvent(tx, {
        session: context.session,
        projectId: snapshotProjectId,
        snapshotId: identity.id,
        eventType: "POLICY_BOUND",
        snapshotHash: built.snapshotHash,
        correlationId: context.correlationId,
        policyVersionId: policy.recordId,
        details: {
          policyId: policy.policy.reference.id,
          policyVersion: policy.policy.reference.version,
          policyKind: policy.policy.payload.kind,
        },
      });
    }
    return mapSnapshotRow(row) as FinancialSnapshotRecord & { snapshot: CompleteFinancialSnapshotV1 };
  }, options);
}

export async function recordFinancialApprovalEventInTransaction(tx: TenantTransaction, input: {
  session: AppSession;
  snapshot: FinancialSnapshotRecord;
  correlationId: string;
  stage: "REQUESTED" | "VERIFIED";
  actionHash: string;
}) {
  if (input.snapshot.reviewState !== "VERIFIED" || input.snapshot.snapshot.reviewState !== "COMPLETE") {
    fail("FINANCIAL_SNAPSHOT_NEEDS_REVIEW");
  }
  await insertEvent(tx, {
    session: input.session,
    projectId: assertCrmUuid(input.snapshot.projectId, "projectId"),
    snapshotId: input.snapshot.id,
    eventType: input.stage === "REQUESTED" ? "APPROVAL_REQUESTED" : "APPROVAL_VERIFIED",
    snapshotHash: input.snapshot.snapshotHash,
    correlationId: input.correlationId,
    approvalContractVersion: "v2",
    actionHash: input.actionHash,
    details: { actionContractVersion: "approval-action-v2" },
  });
}

export async function readFinancialSnapshotInTransaction(
  tx: TenantTransaction,
  workspaceId: string,
  snapshotId: string,
): Promise<FinancialSnapshotRecord> {
  const row = await tx.queryOne<SnapshotRow>(`
    select id,project_id as "projectId",resource_type as "resourceType",resource_id as "resourceId",
      business_version as "businessVersion",review_state as "reviewState",canonical_snapshot as snapshot,
      snapshot_hash as "snapshotHash",supersedes_snapshot_id as "supersedesSnapshotId",
      legacy_classification as "legacyClassification",created_at as "createdAt"
    from crm_financial_snapshots where workspace_id=$1::uuid and id=$2::uuid
  `, [workspaceId, assertCrmUuid(snapshotId, "snapshotId")]);
  if (!row) fail("FINANCIAL_SNAPSHOT_NOT_ACCESSIBLE", 404);
  return mapSnapshotRow(row);
}

export async function getFinancialSnapshot(
  session: AppSession,
  snapshotId: string,
  options: TenantTransactionOptions = {},
) {
  return withCrmRead(session, (tx, fresh) => readFinancialSnapshotInTransaction(tx, fresh.workspaceId, snapshotId), options);
}

export async function getOfferFinancialSnapshot(
  session: AppSession,
  offerId: string,
  options: TenantTransactionOptions = {},
): Promise<FinancialSnapshotRecord | null> {
  const sourceOfferId = assertCrmUuid(offerId, "offerId");
  return withCrmRead(session, async (tx, fresh) => {
    const row = await tx.queryOne<SnapshotRow>(`
      select id,project_id as "projectId",resource_type as "resourceType",resource_id as "resourceId",
        business_version as "businessVersion",review_state as "reviewState",canonical_snapshot as snapshot,
        snapshot_hash as "snapshotHash",supersedes_snapshot_id as "supersedesSnapshotId",
        legacy_classification as "legacyClassification",created_at as "createdAt"
      from crm_financial_snapshots snapshot
      where snapshot.workspace_id=$1::uuid and (
        (
          snapshot.resource_type='CONTRACT'
          and snapshot.review_state='VERIFIED'
          and snapshot.canonical_snapshot->>'reviewState'='COMPLETE'
          and snapshot.canonical_snapshot#>>'{provenance,sourceRecordId}'=$2::text
        )
        or (snapshot.resource_type='OFFER' and snapshot.resource_id=$2::uuid)
      )
      order by
        case when snapshot.resource_type='CONTRACT' then 0 else 1 end,
        snapshot.business_version desc,
        snapshot.created_at desc,
        snapshot.id desc
      limit 1
    `, [fresh.workspaceId, sourceOfferId]);
    return row ? mapSnapshotRow(row) : null;
  }, options);
}

export async function listFinancialReviewQueue(
  session: AppSession,
  projectId: string,
  options: TenantTransactionOptions = {},
) {
  return withCrmRead(session, async (tx, fresh) => {
    const policyProjectId = assertCrmUuid(projectId, "projectId");
    await assertProjectGrant(tx, fresh, policyProjectId, false);
    const rows = await tx.query<SnapshotRow>(`
      select id,project_id as "projectId",resource_type as "resourceType",resource_id as "resourceId",
        business_version as "businessVersion",review_state as "reviewState",canonical_snapshot as snapshot,
        snapshot_hash as "snapshotHash",supersedes_snapshot_id as "supersedesSnapshotId",
        legacy_classification as "legacyClassification",created_at as "createdAt"
      from crm_financial_snapshots pending
      where pending.workspace_id=$1::uuid
        and pending.project_id=$2::uuid
        and pending.review_state='NEEDS_REVIEW'
        and not exists(
          select 1 from crm_financial_snapshots resolved
          where resolved.workspace_id=pending.workspace_id
            and resolved.supersedes_snapshot_id=pending.id
            and resolved.review_state='VERIFIED'
            and resolved.canonical_snapshot->>'reviewState'='COMPLETE'
            and exists(
              select 1 from crm_financial_events verified
              where verified.workspace_id=resolved.workspace_id
                and verified.project_id is not distinct from resolved.project_id
                and verified.snapshot_id=resolved.id
                and verified.event_type='REVIEW_VERIFIED'
                and verified.related_snapshot_id=pending.id
            )
        )
      order by pending.created_at,pending.id limit 200
    `, [fresh.workspaceId, policyProjectId]);
    return rows.map(mapSnapshotRow);
  }, options);
}
