import "server-only";
import { canSwitchWorkspace, type AppSession } from "./auth/session";
import { assertCrmFields, assertCrmUuid, crmPayloadDigest, CrmCommandError, executeCrmCommand, withCrmRead, type TenantTransaction, type TenantTransactionOptions } from "./crm-command";
import { hasProductCapability } from "./product-model";

const VERSION = "qa-legacy-provenance-v1";
const digestPattern = /^[a-f0-9]{64}$/;
type Selectors = { sourceReceiptId: string; targetAuditId: string; ownDraftId: string };
type Target = { type: string; id: string };
export type QaLegacyInput = Selectors & ({ mode: "plan" } | {
  mode: "register_provenance"; planId: string; expectedPlanDigest: string;
  expectedTargets: Target[]; expectedCounts: Record<string, number>; confirmation: string;
});
type Snapshot = {
  version: typeof VERSION; originWorkspaceId: string; originActorId: string;
  sourceReceiptId: string; sourceAuditId: string; targetAuditId: string; provisionRequestId: string;
  targetIds: { workspace: string; project: string; bot: string; knowledgeArea: string; membership: string; ownDraft: string };
  stateDigests: Record<string, string>;
  unprovenRelations: { relation: string; rls: boolean; forced: boolean; schemaDigest: string }[];
  completeVisibility: false; classificationAllowed: false;
  externalResourceVisibility: "NOT_PROVEN"; settingsRestoreBaseline: "NOT_PROVEN";
};
export type QaLegacyPlan = {
  version: typeof VERSION; selectors: Selectors; snapshot: Snapshot;
  targets: Target[]; counts: Record<string, number>; digest: string;
};
type Metadata = { idempotencyKey: string; correlationId: string };
const denied = (code: string, message: string, status = 409): never => { throw new CrmCommandError(code, message, status); };

export function parseQaLegacyInput(value: unknown): QaLegacyInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return denied("INVALID_INPUT", "JSON object required", 400);
  const input = value as Record<string, unknown>;
  const common = ["mode", "sourceReceiptId", "targetAuditId", "ownDraftId", "idempotencyKey", "correlationId"];
  assertCrmFields(input, input.mode === "plan" ? common : [...common, "planId", "expectedPlanDigest", "expectedTargets", "expectedCounts", "confirmation"]);
  const selectors = { sourceReceiptId: assertCrmUuid(input.sourceReceiptId), targetAuditId: assertCrmUuid(input.targetAuditId), ownDraftId: assertCrmUuid(input.ownDraftId) };
  if (input.mode === "plan") return { mode: "plan", ...selectors };
  if (input.mode !== "register_provenance" || typeof input.expectedPlanDigest !== "string" || !digestPattern.test(input.expectedPlanDigest) || typeof input.confirmation !== "string") return denied("INVALID_INPUT", "Choose a provenance-only mode and exact plan", 400);
  if (!Array.isArray(input.expectedTargets) || input.expectedTargets.length !== 6) return denied("INVALID_TARGETS", "Six exact original target IDs required", 400);
  const targets = input.expectedTargets.map((value): Target => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return denied("INVALID_TARGETS", "Exact target required", 400);
    assertCrmFields(value, ["type", "id"]);
    const target = value as Record<string, unknown>;
    if (typeof target.type !== "string" || !/^[a-z_]+$/.test(target.type)) return denied("INVALID_TARGETS", "Invalid target type", 400);
    return { type: target.type, id: assertCrmUuid(target.id) };
  }).sort((a, b) => a.type.localeCompare(b.type));
  if (new Set(targets.map(target => target.type)).size !== 6) return denied("INVALID_TARGETS", "Distinct exact target types required", 400);
  if (!input.expectedCounts || typeof input.expectedCounts !== "object" || Array.isArray(input.expectedCounts) || Object.entries(input.expectedCounts).some(([key, count]) => !/^[a-z_]+$/.test(key) || count !== 1)) return denied("INVALID_COUNTS", "Exact original target counts required", 400);
  return { mode: "register_provenance", ...selectors, planId: assertCrmUuid(input.planId), expectedPlanDigest: input.expectedPlanDigest, expectedTargets: targets, expectedCounts: input.expectedCounts as Record<string, number>, confirmation: input.confirmation };
}

function originAuthority(session: AppSession) {
  if (!session.authenticated || !["cookie", "database"].includes(session.source) || session.serviceIdentity || !session.authSessionId || !session.authIdentityId || !session.mfaVerifiedAt || !["owner", "admin"].includes(session.role) || !session.permissions.includes("crm:write") || !canSwitchWorkspace(session) || !hasProductCapability(session.productRole, "settings:manage") || !hasProductCapability(session.productRole, "bots:publish")) return denied("QA_LEGACY_FORBIDDEN", "Current persisted internal administrator with fresh MFA required", 403);
}

async function snapshot(tx: TenantTransaction, session: AppSession, input: Selectors): Promise<Snapshot> {
  const row = await tx.queryOne<{ snapshot: Snapshot }>("select public.crm_qa_legacy_provenance_snapshot($1::uuid,$2::uuid,$3::uuid,$4::uuid) as snapshot", [session.authSessionId, input.sourceReceiptId, input.targetAuditId, input.ownDraftId]);
  const result = row?.snapshot;
  if (!result || result.version !== VERSION || result.originWorkspaceId !== session.workspaceId || result.originActorId !== session.userId || result.sourceReceiptId !== input.sourceReceiptId || result.targetAuditId !== input.targetAuditId || result.targetIds.ownDraft !== input.ownDraftId || result.completeVisibility !== false || result.classificationAllowed !== false) return denied("QA_LEGACY_SOURCE_INVALID", "Closed provenance contract required", 403);
  return result;
}

function makePlan(input: Selectors, source: Snapshot): QaLegacyPlan {
  const ids = source.targetIds;
  const targets = Object.entries({ workspaces: ids.workspace, projects: ids.project, bots: ids.bot, knowledge_areas: ids.knowledgeArea, workspace_users: ids.membership, crm_property_creation_drafts: ids.ownDraft }).map(([type, id]) => ({ type, id })).sort((a, b) => a.type.localeCompare(b.type));
  const counts = Object.fromEntries(targets.map(target => [target.type, 1]));
  const content: Omit<QaLegacyPlan, "digest"> = { version: VERSION, selectors: { sourceReceiptId: input.sourceReceiptId, targetAuditId: input.targetAuditId, ownDraftId: input.ownDraftId }, snapshot: source, targets, counts };
  return { ...content, digest: crmPayloadDigest(content) };
}

const restrictions = {
  classificationAllowed: false, qaFlagChanged: false, qaBatchCreated: false, cleanupAllowed: false,
  businessMutations: false, accountsAndRightsChanged: false, calendarsChanged: false,
  open: ["TENANT_COMPLETE_CURRENT_RESOURCE_VISIBILITY", "FOREIGN_AND_UNKNOWN_RESOURCE_DEPENDENCIES", "PROVIDER_BLOB_AND_GLOBAL_JOB_VISIBILITY", "EXACT_SETTINGS_RESTORE_BASELINE_AND_CAS", "EIGHT_GROUP_LIFECYCLE_NOT_EXECUTED"],
  groups: {
    workspace: "FINGERPRINT_ONLY_CLASSIFICATION_AND_RETIREMENT_DENIED",
    project: "EXACT_ORIGINAL_ID_NO_RETIREMENT",
    ownDraft: "CURRENT_PERSONAL_OWNER_AND_REVISION_HASH_NO_DISCARD",
    membership: "EXISTING_IDENTITY_PRESERVED_NOT_TEMPORARY",
    bot: "EXACT_ORIGINAL_ID_NO_PROVIDER_ACTION",
    knowledgeArea: "EXACT_ORIGINAL_ID_SOURCE_GRAPH_NOT_ADOPTED",
    settings: "CURRENT_FINGERPRINT_BASELINE_AND_RESTORE_UNPROVEN",
    audit: "IMMUTABLE_SOURCE_AND_TARGET_ANCHORS_PRESERVED",
  },
} as const;

/** Stores only original-provenance evidence in the origin's existing receipts. */
export async function runQaLegacyProvenance(session: AppSession, raw: unknown, metadata: Metadata, options: TenantTransactionOptions = {}) {
  const input = parseQaLegacyInput(raw);
  originAuthority(session);
  const budget = { ...options, statementTimeoutMs: 15_000, poolAcquireTimeoutMs: 5_000 };
  return withCrmRead(session, async (tx, fresh) => {
    originAuthority(fresh);
    // Revalidate both DB provenance sources, fresh MFA and target ownership
    // before exposing even a previously stored successful evidence receipt.
    const current = makePlan(input, await snapshot(tx, fresh, input));
    if (input.mode === "plan") return executeCrmCommand(fresh, {
      ...metadata, operation: "qa.legacy.provenance.plan", resourceId: input.sourceReceiptId,
      capability: "settings:manage", payload: input,
    }, async (_tx, context) => ({ version: VERSION, persisted: true, outcome: "provenance_plan", planId: context.commandId, plan: current, ...restrictions }), budget);
    const stored = await tx.queryOne<{ plan: QaLegacyPlan; expired: boolean }>(`select response->'plan' as plan,created_at<clock_timestamp()-interval '15 minutes' as expired from crm_command_receipts where id=$1::uuid and workspace_id=$2::uuid and actor_user_id=$3::uuid and operation='qa.legacy.provenance.plan' and resource_id=$4::uuid`, [input.planId, fresh.workspaceId, fresh.userId, input.sourceReceiptId]);
    if (!stored?.plan || stored.plan.version !== VERSION || stored.plan.digest !== input.expectedPlanDigest || crmPayloadDigest(stored.plan.selectors) !== crmPayloadDigest(current.selectors) || crmPayloadDigest(input.expectedCounts) !== crmPayloadDigest(stored.plan.counts) || crmPayloadDigest(input.expectedTargets) !== crmPayloadDigest(stored.plan.targets) || input.confirmation !== `REGISTER PROVENANCE ONLY ${stored.plan.snapshot.targetIds.workspace} ${stored.plan.digest}`) return denied("QA_LEGACY_PLAN_MISMATCH", "Exact own provenance-only plan, IDs, counts, hash and confirmation required");
    // A registration receipt is not a current CAS proof after state or expiry
    // changes. These checks also precede the generic command's replay lookup.
    if (stored.expired) return denied("QA_LEGACY_PLAN_EXPIRED", "Create a fresh provenance plan");
    if (current.digest !== stored.plan.digest || crmPayloadDigest(current) !== crmPayloadDigest(stored.plan)) return denied("QA_LEGACY_PLAN_STALE", "Original objects, settings or schema changed; create a fresh plan");
    return executeCrmCommand(fresh, {
      ...metadata, operation: "qa.legacy.provenance.register", resourceId: input.sourceReceiptId,
      capability: "settings:manage", payload: input,
    }, async () => {
      return { version: VERSION, persisted: true, outcome: "provenance_registered", sourcePlanId: input.planId, planDigest: stored.plan.digest, selectors: stored.plan.selectors, targets: stored.plan.targets, counts: stored.plan.counts, ...restrictions };
    }, budget);
  }, budget);
}
