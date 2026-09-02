import "server-only";

import type { AppSession } from "@/lib/auth/session";
import { canPersist, writeAuditLog } from "@/lib/db/runtime-repositories";
import { withTenantTransaction, type TenantTransaction } from "@/lib/db/tenant-client";
import {
  claimSafeMutation,
  completeSafeMutation,
  ContentRepositoryError,
} from "@/lib/db/content-library-repositories";
import { hasProductCapability } from "@/lib/product-model";
import type {
  DataSubjectRequestStatus,
  DataSubjectRequestType,
  PrivacyEntityType,
  RetentionAction,
  RetentionReviewStatus,
} from "@/lib/privacy-lifecycle";
import {
  dataSubjectRequestStatusRequiresIdentity,
  dataSubjectRequestStatusRequiresOperationEvidence,
  isAllowedDataSubjectRequestTransition,
  isAllowedRetentionReviewTransition,
  requiredRetentionApprovalStatus,
} from "@/lib/privacy-lifecycle";

type DateValue = Date | string;

type RetentionPolicyRow = {
  id: string;
  entityType: PrivacyEntityType;
  inactivityDays: number;
  proposedAction: RetentionAction;
  legalBasis: string;
  manualReviewRequired: true;
  isActive: boolean;
  createdAt: DateValue;
  updatedAt: DateValue;
};

type RetentionReviewRow = {
  id: string;
  policyId: string | null;
  entityType: PrivacyEntityType;
  entityId: string;
  proposedAction: RetentionAction;
  rationale: string;
  status: RetentionReviewStatus;
  legalHoldBlocked: boolean;
  dueAt: DateValue | null;
  reviewedByUserId: string | null;
  reviewedAt: DateValue | null;
  decisionNote: string | null;
  createdAt: DateValue;
  updatedAt: DateValue;
};

type LegalHoldRow = {
  id: string;
  entityType: PrivacyEntityType | "workspace";
  entityId: string | null;
  reason: string;
  reference: string;
  startsAt: DateValue;
  expiresAt: DateValue | null;
  releasedAt: DateValue | null;
  releasedByUserId: string | null;
  releaseNote: string | null;
  createdAt: DateValue;
  updatedAt: DateValue;
};

export type DataSubjectRequestRow = {
  id: string;
  contactId: string | null;
  requestReference: string;
  requestType: DataSubjectRequestType;
  status: DataSubjectRequestStatus;
  identityVerifiedAt: DateValue | null;
  dueAt: DateValue | null;
  exportJobMetadata: Record<string, unknown>;
  legalHoldBlocked: boolean;
  reviewNote: string;
  reviewedByUserId: string | null;
  reviewedAt: DateValue | null;
  createdAt: DateValue;
  updatedAt: DateValue;
};

function iso(value: DateValue | null) {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapDates<Row extends Record<string, unknown>>(row: Row, names: readonly (keyof Row)[]) {
  const mapped: Record<string, unknown> = { ...row };
  for (const name of names) mapped[String(name)] = iso(row[name] as DateValue | null);
  return mapped as Row;
}

function mapPolicy(row: RetentionPolicyRow) {
  return mapDates(row, ["createdAt", "updatedAt"]);
}

function mapReview(row: RetentionReviewRow) {
  return mapDates(row, ["dueAt", "reviewedAt", "createdAt", "updatedAt"]);
}

function mapHold(row: LegalHoldRow) {
  return mapDates(row, ["startsAt", "expiresAt", "releasedAt", "createdAt", "updatedAt"]);
}

export function mapDataSubjectRequest(row: DataSubjectRequestRow) {
  return mapDates(row, ["identityVerifiedAt", "dueAt", "reviewedAt", "createdAt", "updatedAt"]);
}

function assertPersistence() {
  if (!canPersist()) {
    throw new ContentRepositoryError("PERSISTENCE_UNAVAILABLE", "Privacy lifecycle persistence is unavailable");
  }
}

export function canManagePrivacyLifecycle(session: AppSession) {
  return session.role === "owner"
    || session.role === "admin"
    || hasProductCapability(session.productRole, "settings:manage");
}

function assertPrivacyManager(session: AppSession) {
  if (!canManagePrivacyLifecycle(session)) {
    throw new ContentRepositoryError("FORBIDDEN", "Privacy lifecycle access is not permitted");
  }
}

function activeHoldPredicate(input: {
  entityIdSql: string;
  entityTypeSql: string;
  workspaceIdSql: string;
}) {
  const targetProjectId = `case ${input.entityTypeSql}
    when 'contact' then (select project_id from contacts where workspace_id = ${input.workspaceIdSql} and id = ${input.entityIdSql})
    when 'organization' then (select project_id from organizations where workspace_id = ${input.workspaceIdSql} and id = ${input.entityIdSql})
    when 'lead' then (select project_id from leads where workspace_id = ${input.workspaceIdSql} and id = ${input.entityIdSql})
    when 'property' then (select project_id from seller_listings where workspace_id = ${input.workspaceIdSql} and id = ${input.entityIdSql})
    when 'unit' then (select project_id from property_units where workspace_id = ${input.workspaceIdSql} and id = ${input.entityIdSql})
    when 'deal' then (select project_id from deals where workspace_id = ${input.workspaceIdSql} and id = ${input.entityIdSql})
    when 'task' then (select project_id from tasks where workspace_id = ${input.workspaceIdSql} and id = ${input.entityIdSql})
    when 'document' then (select project_id from crm_content_documents where workspace_id = ${input.workspaceIdSql} and id = ${input.entityIdSql})
    when 'template' then (select project_id from crm_communication_templates where workspace_id = ${input.workspaceIdSql} and id = ${input.entityIdSql})
    else null
  end`;
  return `hold.workspace_id = ${input.workspaceIdSql}
    and hold.released_at is null
    and hold.starts_at <= now()
    and (hold.expires_at is null or hold.expires_at > now())
    and (
      hold.entity_type = 'workspace'
      or (hold.entity_type = ${input.entityTypeSql} and hold.entity_id = ${input.entityIdSql})
      or (hold.entity_type = 'project' and hold.entity_id = (${targetProjectId}))
      or (
        ${input.entityTypeSql} = 'document' and exists (
          select 1 from crm_content_links link
           where link.workspace_id = ${input.workspaceIdSql}
             and link.document_id = ${input.entityIdSql}
             and (
               (link.target_type = hold.entity_type and link.target_id = hold.entity_id)
               or (hold.entity_type = 'project' and link.project_id = hold.entity_id)
             )
        )
      )
    )`;
}

const effectiveReviewHoldSql = `exists (
  select 1 from privacy_legal_holds hold
  where ${activeHoldPredicate({
    entityIdSql: "review.entity_id",
    entityTypeSql: "review.entity_type",
    workspaceIdSql: "review.workspace_id",
  })}
)`;

const effectiveRequestHoldSql = `exists (
  select 1 from privacy_legal_holds hold
  where ${activeHoldPredicate({
    entityIdSql: "request.contact_id",
    entityTypeSql: "'contact'::text",
    workspaceIdSql: "request.workspace_id",
  })}
)`;

const policySelect = `select id, entity_type as "entityType", inactivity_days as "inactivityDays",
  proposed_action as "proposedAction", legal_basis as "legalBasis",
  manual_review_required as "manualReviewRequired", is_active as "isActive",
  created_at as "createdAt", updated_at as "updatedAt" from privacy_retention_policies`;
const reviewSelect = `select review.id, review.policy_id as "policyId",
  review.entity_type as "entityType", review.entity_id as "entityId",
  review.proposed_action as "proposedAction", review.rationale, review.status,
  ${effectiveReviewHoldSql} as "legalHoldBlocked",
  review.due_at as "dueAt", review.reviewed_by_user_id as "reviewedByUserId",
  review.reviewed_at as "reviewedAt", review.decision_note as "decisionNote",
  review.created_at as "createdAt", review.updated_at as "updatedAt"
  from privacy_retention_reviews review`;
const holdSelect = `select id, entity_type as "entityType", entity_id as "entityId", reason, reference,
  starts_at as "startsAt", expires_at as "expiresAt", released_at as "releasedAt",
  released_by_user_id as "releasedByUserId", release_note as "releaseNote",
  created_at as "createdAt", updated_at as "updatedAt" from privacy_legal_holds`;
const requestSelect = `select request.id, request.contact_id as "contactId",
  request.request_reference as "requestReference", request.request_type as "requestType", request.status,
  request.identity_verified_at as "identityVerifiedAt", request.due_at as "dueAt",
  request.export_job_metadata as "exportJobMetadata", ${effectiveRequestHoldSql} as "legalHoldBlocked",
  request.review_note as "reviewNote", request.reviewed_by_user_id as "reviewedByUserId",
  request.reviewed_at as "reviewedAt", request.created_at as "createdAt", request.updated_at as "updatedAt"
  from privacy_data_subject_requests request`;

export async function getPrivacyLifecycleOverview(input: { session: AppSession }) {
  assertPersistence();
  assertPrivacyManager(input.session);
  return withTenantTransaction(
    { actorId: input.session.userId, workspaceId: input.session.workspaceId },
    async (transaction) => {
      const [policies, reviews, holds, requests] = await Promise.all([
        transaction.query<RetentionPolicyRow>(
          `${policySelect} where workspace_id = $1 order by entity_type`, [input.session.workspaceId]),
        transaction.query<RetentionReviewRow>(
          `${reviewSelect} where review.workspace_id = $1 order by
             case review.status when 'proposed' then 0 when 'in_review' then 1 else 2 end,
             review.due_at nulls last, review.created_at desc limit 100`, [input.session.workspaceId]),
        transaction.query<LegalHoldRow>(
          `${holdSelect} where workspace_id = $1 order by (released_at is null) desc, created_at desc limit 100`,
          [input.session.workspaceId]),
        transaction.query<DataSubjectRequestRow>(
          `${requestSelect} where request.workspace_id = $1 order by
             case when request.status in ('completed', 'cancelled', 'rejected') then 1 else 0 end,
             request.due_at nulls last, request.created_at desc limit 100`, [input.session.workspaceId]),
      ]);
      return {
        policies: policies.map(mapPolicy),
        reviews: reviews.map(mapReview),
        legalHolds: holds.map(mapHold),
        dataSubjectRequests: requests.map(mapDataSubjectRequest),
        automaticHardDeleteEnabled: false as const,
      };
    },
  );
}

const entityTable: Record<PrivacyEntityType, string> = {
  contact: "contacts",
  organization: "organizations",
  lead: "leads",
  project: "projects",
  property: "seller_listings",
  unit: "property_units",
  deal: "deals",
  task: "tasks",
  document: "crm_content_documents",
  template: "crm_communication_templates",
};

async function requireEntity(transaction: TenantTransaction, workspaceId: string, entityType: PrivacyEntityType, entityId: string) {
  const table = entityTable[entityType];
  const found = await transaction.queryOne<{ id: string }>(
    `select id from ${table} where workspace_id = $1 and id = $2`,
    [workspaceId, entityId],
  );
  if (!found) throw new ContentRepositoryError("NOT_FOUND", "Privacy target was not found in this workspace");
}

async function activeLegalHold(transaction: TenantTransaction, workspaceId: string, entityType: PrivacyEntityType, entityId: string) {
  return transaction.queryOne<{ id: string }>(
    `select hold.id from privacy_legal_holds hold where ${activeHoldPredicate({
      workspaceIdSql: "$1::uuid",
      entityTypeSql: "$2::text",
      entityIdSql: "$3::uuid",
    })} limit 1`,
    [workspaceId, entityType, entityId],
  );
}

async function activeDataSubjectRequestHold(
  transaction: TenantTransaction,
  workspaceId: string,
  contactId: string | null,
) {
  return transaction.queryOne<{ id: string }>(
    `select hold.id from privacy_legal_holds hold where ${activeHoldPredicate({
      workspaceIdSql: "$1::uuid",
      entityTypeSql: "'contact'::text",
      entityIdSql: "$2::uuid",
    })} limit 1`,
    [workspaceId, contactId],
  );
}

async function refreshLegalHoldSnapshots(transaction: TenantTransaction, workspaceId: string) {
  await transaction.execute(
    `with effective as (
       select review.id, ${effectiveReviewHoldSql} as is_blocked
         from privacy_retention_reviews review
        where review.workspace_id = $1
     )
     update privacy_retention_reviews review
        set legal_hold_blocked = effective.is_blocked, updated_at = now()
       from effective
      where review.workspace_id = $1 and review.id = effective.id
        and review.legal_hold_blocked is distinct from effective.is_blocked`,
    [workspaceId],
  );
  await transaction.execute(
    `with effective as (
       select request.id, ${effectiveRequestHoldSql} as is_blocked
         from privacy_data_subject_requests request
        where request.workspace_id = $1
     )
     update privacy_data_subject_requests request
        set legal_hold_blocked = effective.is_blocked, updated_at = now()
       from effective
      where request.workspace_id = $1 and request.id = effective.id
        and request.legal_hold_blocked is distinct from effective.is_blocked`,
    [workspaceId],
  );
}

export async function saveRetentionPolicy(input: {
  session: AppSession;
  idempotencyKey: string;
  policy: {
    entityType: PrivacyEntityType;
    inactivityDays: number;
    proposedAction: RetentionAction;
    legalBasis: string;
    isActive: boolean;
    expectedUpdatedAt?: string | null;
  };
}) {
  assertPersistence();
  assertPrivacyManager(input.session);
  return withTenantTransaction(
    { actorId: input.session.userId, workspaceId: input.session.workspaceId },
    async (transaction) => {
      const operation = "privacy.retention_policy.save";
      const claim = await claimSafeMutation({ transaction, session: input.session, operation,
        idempotencyKey: input.idempotencyKey, payload: input.policy });
      if (claim.kind === "replayed") return { ...(claim.response as object), replayed: true };
      const before = await transaction.queryOne<RetentionPolicyRow>(
        `${policySelect} where workspace_id = $1 and entity_type = $2 for update`,
        [input.session.workspaceId, input.policy.entityType],
      );
      if (before && (!input.policy.expectedUpdatedAt || iso(before.updatedAt) !== iso(input.policy.expectedUpdatedAt))) {
        throw new ContentRepositoryError("CONFLICT", "Retention policy changed since it was loaded");
      }
      if (before && (before.proposedAction !== input.policy.proposedAction || !input.policy.isActive)) {
        const openReview = await transaction.queryOne<{ id: string }>(
          `select id from privacy_retention_reviews
            where workspace_id = $1 and policy_id = $2 and status in ('proposed', 'in_review')
            limit 1`,
          [input.session.workspaceId, before.id],
        );
        if (openReview) {
          throw new ContentRepositoryError(
            "REFERENCE_BLOCKED",
            "Complete or reject open reviews before changing or deactivating their retention policy",
          );
        }
      }
      const policy = await transaction.queryOne<RetentionPolicyRow>(
        `insert into privacy_retention_policies (
           workspace_id, entity_type, inactivity_days, proposed_action, legal_basis,
           manual_review_required, is_active, created_by_user_id, updated_by_user_id
         ) values ($1, $2, $3, $4, $5, true, $6, $7, $7)
         on conflict (workspace_id, entity_type) do update set
           inactivity_days = excluded.inactivity_days, proposed_action = excluded.proposed_action,
           legal_basis = excluded.legal_basis, manual_review_required = true,
           is_active = excluded.is_active, updated_by_user_id = excluded.updated_by_user_id, updated_at = now()
         returning id, entity_type as "entityType", inactivity_days as "inactivityDays",
           proposed_action as "proposedAction", legal_basis as "legalBasis",
           manual_review_required as "manualReviewRequired", is_active as "isActive",
           created_at as "createdAt", updated_at as "updatedAt"`,
        [input.session.workspaceId, input.policy.entityType, input.policy.inactivityDays,
          input.policy.proposedAction, input.policy.legalBasis, input.policy.isActive, input.session.userId],
      );
      if (!policy) throw new ContentRepositoryError("CONFLICT", "Retention policy could not be saved");
      const response = { policy: mapPolicy(policy), replayed: false };
      await writeAuditLog({ session: input.session, action: before ? "privacy.policy.updated" : "privacy.policy.created",
        entityType: "privacy_retention_policy", entityId: policy.id,
        before: before ? mapPolicy(before) : null, after: response.policy, transaction });
      await completeSafeMutation({ transaction, session: input.session, operation,
        idempotencyKey: input.idempotencyKey, response });
      return response;
    },
  );
}

export async function createRetentionReview(input: {
  session: AppSession;
  idempotencyKey: string;
  review: {
    policyId?: string | null;
    entityType: PrivacyEntityType;
    entityId: string;
    proposedAction: RetentionAction;
    rationale: string;
    dueAt?: string | null;
  };
}) {
  assertPersistence();
  assertPrivacyManager(input.session);
  return withTenantTransaction(
    { actorId: input.session.userId, workspaceId: input.session.workspaceId },
    async (transaction) => {
      const operation = "privacy.retention_review.create";
      const claim = await claimSafeMutation({ transaction, session: input.session, operation,
        idempotencyKey: input.idempotencyKey, payload: input.review });
      if (claim.kind === "replayed") return { ...(claim.response as object), replayed: true };
      await requireEntity(transaction, input.session.workspaceId, input.review.entityType, input.review.entityId);
      if (input.review.policyId) {
        const policy = await transaction.queryOne<{
          id: string;
          entityType: PrivacyEntityType;
          proposedAction: RetentionAction;
          isActive: boolean;
        }>(
          `select id, entity_type as "entityType", proposed_action as "proposedAction", is_active as "isActive"
             from privacy_retention_policies where workspace_id = $1 and id = $2 for share`,
          [input.session.workspaceId, input.review.policyId],
        );
        if (!policy) throw new ContentRepositoryError("NOT_FOUND", "Retention policy was not found");
        if (!policy.isActive) {
          throw new ContentRepositoryError("CONFLICT", "Inactive retention policies cannot create reviews");
        }
        if (policy.entityType !== input.review.entityType || policy.proposedAction !== input.review.proposedAction) {
          throw new ContentRepositoryError(
            "CONFLICT",
            "Retention policy, entity type, and proposed action must match",
          );
        }
      }
      const hold = await activeLegalHold(transaction, input.session.workspaceId,
        input.review.entityType, input.review.entityId);
      const review = await transaction.queryOne<RetentionReviewRow>(
        `insert into privacy_retention_reviews (
           workspace_id, policy_id, entity_type, entity_id, proposed_action, rationale,
           legal_hold_blocked, due_at, created_by_user_id
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (workspace_id, entity_type, entity_id)
           where status in ('proposed', 'in_review')
         do nothing
         returning id, policy_id as "policyId", entity_type as "entityType", entity_id as "entityId",
           proposed_action as "proposedAction", rationale, status,
           legal_hold_blocked as "legalHoldBlocked", due_at as "dueAt",
           reviewed_by_user_id as "reviewedByUserId", reviewed_at as "reviewedAt",
           decision_note as "decisionNote", created_at as "createdAt", updated_at as "updatedAt"`,
        [input.session.workspaceId, input.review.policyId ?? null, input.review.entityType,
          input.review.entityId, input.review.proposedAction, input.review.rationale,
          Boolean(hold), input.review.dueAt ?? null, input.session.userId],
      );
      if (!review) {
        throw new ContentRepositoryError(
          "CONFLICT",
          "An open retention review already exists for this target",
        );
      }
      const response = { review: mapReview(review), hardDeletePerformed: false as const, replayed: false };
      await writeAuditLog({ session: input.session, action: hold
        ? "privacy.retention_review.legal_hold_blocked" : "privacy.retention_review.proposed",
        entityType: input.review.entityType, entityId: input.review.entityId,
        after: response, transaction });
      await completeSafeMutation({ transaction, session: input.session, operation,
        idempotencyKey: input.idempotencyKey, response });
      return response;
    },
  );
}

export async function decideRetentionReview(input: {
  session: AppSession;
  idempotencyKey: string;
  reviewId: string;
  expectedUpdatedAt: string;
  status: RetentionReviewStatus;
  decisionNote: string;
}) {
  assertPersistence();
  assertPrivacyManager(input.session);
  return withTenantTransaction(
    { actorId: input.session.userId, workspaceId: input.session.workspaceId },
    async (transaction) => {
      const operation = "privacy.retention_review.decide";
      const payload = { reviewId: input.reviewId, expectedUpdatedAt: input.expectedUpdatedAt,
        status: input.status, decisionNote: input.decisionNote };
      const claim = await claimSafeMutation({ transaction, session: input.session, operation,
        idempotencyKey: input.idempotencyKey, payload });
      if (claim.kind === "replayed") return { ...(claim.response as object), replayed: true };
      const before = await transaction.queryOne<RetentionReviewRow>(
        `${reviewSelect} where review.workspace_id = $1 and review.id = $2 for update of review`,
        [input.session.workspaceId, input.reviewId],
      );
      if (!before) throw new ContentRepositoryError("NOT_FOUND", "Retention review was not found");
      if (iso(before.updatedAt) !== iso(input.expectedUpdatedAt)) {
        throw new ContentRepositoryError("CONFLICT", "Retention review changed since it was loaded");
      }
      if (input.status === "completed") {
        throw new ContentRepositoryError(
          "CONFLICT",
          "Completion requires a separate host-side operation and immutable evidence",
        );
      }
      if (!isAllowedRetentionReviewTransition(before.status, input.status)) {
        throw new ContentRepositoryError(
          "CONFLICT",
          `Retention review cannot transition from ${before.status} to ${input.status}`,
        );
      }
      const expectedApproval = requiredRetentionApprovalStatus(before.proposedAction);
      if (input.status.startsWith("approved_") && input.status !== expectedApproval) {
        throw new ContentRepositoryError(
          "CONFLICT",
          `The proposed action requires the ${expectedApproval} decision`,
        );
      }
      const hold = await activeLegalHold(transaction, input.session.workspaceId, before.entityType, before.entityId);
      if (hold && input.status.startsWith("approved_")) {
        throw new ContentRepositoryError("REFERENCE_BLOCKED", "An active legal hold blocks this decision");
      }
      const review = await transaction.queryOne<RetentionReviewRow>(
        `update privacy_retention_reviews set status = $3, decision_note = $4,
           legal_hold_blocked = $5, reviewed_by_user_id = $6, reviewed_at = now(), updated_at = now()
         where workspace_id = $1 and id = $2
         returning id, policy_id as "policyId", entity_type as "entityType", entity_id as "entityId",
           proposed_action as "proposedAction", rationale, status,
           legal_hold_blocked as "legalHoldBlocked", due_at as "dueAt",
           reviewed_by_user_id as "reviewedByUserId", reviewed_at as "reviewedAt",
           decision_note as "decisionNote", created_at as "createdAt", updated_at as "updatedAt"`,
        [input.session.workspaceId, input.reviewId, input.status, input.decisionNote, Boolean(hold), input.session.userId],
      );
      if (!review) throw new ContentRepositoryError("CONFLICT", "Retention review could not be updated");
      const response = { review: mapReview(review), automaticActionPerformed: false as const,
        hardDeletePerformed: false as const, replayed: false };
      await writeAuditLog({ session: input.session, action: "privacy.retention_review.decided",
        entityType: before.entityType, entityId: before.entityId,
        before: mapReview(before), after: response, transaction });
      await completeSafeMutation({ transaction, session: input.session, operation,
        idempotencyKey: input.idempotencyKey, response });
      return response;
    },
  );
}

export async function createLegalHold(input: {
  session: AppSession;
  idempotencyKey: string;
  hold: {
    entityType: PrivacyEntityType | "workspace";
    entityId: string | null;
    reason: string;
    reference: string;
    startsAt: string;
    expiresAt: string | null;
  };
}) {
  assertPersistence();
  assertPrivacyManager(input.session);
  return withTenantTransaction(
    { actorId: input.session.userId, workspaceId: input.session.workspaceId },
    async (transaction) => {
      const operation = "privacy.legal_hold.create";
      const claim = await claimSafeMutation({ transaction, session: input.session, operation,
        idempotencyKey: input.idempotencyKey, payload: input.hold });
      if (claim.kind === "replayed") return { ...(claim.response as object), replayed: true };
      if (input.hold.entityType !== "workspace" && input.hold.entityId) {
        await requireEntity(transaction, input.session.workspaceId, input.hold.entityType, input.hold.entityId);
      }
      const targetLockKey = [input.session.workspaceId, input.hold.entityType,
        input.hold.entityId ?? "workspace"].join(":");
      await transaction.query(
        "select pg_advisory_xact_lock(hashtextextended($1, 0))",
        [targetLockKey],
      );
      const overlapping = await transaction.queryOne<{ id: string }>(
        `select id from privacy_legal_holds
          where workspace_id = $1 and entity_type = $2 and entity_id is not distinct from $3::uuid
            and released_at is null
            and tstzrange(starts_at, expires_at, '[)')
              && tstzrange($4::timestamptz, $5::timestamptz, '[)')
          limit 1`,
        [input.session.workspaceId, input.hold.entityType, input.hold.entityId,
          input.hold.startsAt, input.hold.expiresAt],
      );
      if (overlapping) {
        throw new ContentRepositoryError(
          "CONFLICT",
          "An overlapping unreleased legal hold already exists for this target",
        );
      }
      const hold = await transaction.queryOne<LegalHoldRow>(
        `insert into privacy_legal_holds (
           workspace_id, entity_type, entity_id, reason, reference, starts_at, expires_at, created_by_user_id
         ) values ($1, $2, $3, $4, $5, $6, $7, $8)
         returning id, entity_type as "entityType", entity_id as "entityId", reason, reference,
           starts_at as "startsAt", expires_at as "expiresAt", released_at as "releasedAt",
           released_by_user_id as "releasedByUserId", release_note as "releaseNote",
           created_at as "createdAt", updated_at as "updatedAt"`,
        [input.session.workspaceId, input.hold.entityType, input.hold.entityId, input.hold.reason,
          input.hold.reference, input.hold.startsAt, input.hold.expiresAt, input.session.userId],
      );
      if (!hold) throw new ContentRepositoryError("CONFLICT", "Legal hold could not be created");
      await refreshLegalHoldSnapshots(transaction, input.session.workspaceId);
      const response = { legalHold: mapHold(hold), replayed: false };
      await writeAuditLog({ session: input.session, action: "privacy.legal_hold.created",
        entityType: input.hold.entityType, entityId: input.hold.entityId,
        after: response.legalHold, transaction });
      await completeSafeMutation({ transaction, session: input.session, operation,
        idempotencyKey: input.idempotencyKey, response });
      return response;
    },
  );
}

export async function releaseLegalHold(input: {
  session: AppSession;
  idempotencyKey: string;
  holdId: string;
  expectedUpdatedAt: string;
  releaseNote: string;
}) {
  assertPersistence();
  assertPrivacyManager(input.session);
  return withTenantTransaction(
    { actorId: input.session.userId, workspaceId: input.session.workspaceId },
    async (transaction) => {
      const operation = "privacy.legal_hold.release";
      const payload = { holdId: input.holdId, expectedUpdatedAt: input.expectedUpdatedAt,
        releaseNote: input.releaseNote };
      const claim = await claimSafeMutation({ transaction, session: input.session, operation,
        idempotencyKey: input.idempotencyKey, payload });
      if (claim.kind === "replayed") return { ...(claim.response as object), replayed: true };
      const before = await transaction.queryOne<LegalHoldRow>(
        `${holdSelect} where workspace_id = $1 and id = $2 for update`,
        [input.session.workspaceId, input.holdId],
      );
      if (!before) throw new ContentRepositoryError("NOT_FOUND", "Legal hold was not found");
      if (before.releasedAt) throw new ContentRepositoryError("CONFLICT", "Legal hold is already released");
      if (iso(before.updatedAt) !== iso(input.expectedUpdatedAt)) {
        throw new ContentRepositoryError("CONFLICT", "Legal hold changed since it was loaded");
      }
      const hold = await transaction.queryOne<LegalHoldRow>(
        `update privacy_legal_holds set released_at = now(), released_by_user_id = $3,
           release_note = $4, updated_at = now() where workspace_id = $1 and id = $2
         returning id, entity_type as "entityType", entity_id as "entityId", reason, reference,
           starts_at as "startsAt", expires_at as "expiresAt", released_at as "releasedAt",
           released_by_user_id as "releasedByUserId", release_note as "releaseNote",
           created_at as "createdAt", updated_at as "updatedAt"`,
        [input.session.workspaceId, input.holdId, input.session.userId, input.releaseNote],
      );
      if (!hold) throw new ContentRepositoryError("CONFLICT", "Legal hold could not be released");
      await refreshLegalHoldSnapshots(transaction, input.session.workspaceId);
      const response = { legalHold: mapHold(hold), replayed: false };
      await writeAuditLog({ session: input.session, action: "privacy.legal_hold.released",
        entityType: before.entityType, entityId: before.entityId,
        before: mapHold(before), after: response.legalHold, transaction });
      await completeSafeMutation({ transaction, session: input.session, operation,
        idempotencyKey: input.idempotencyKey, response });
      return response;
    },
  );
}

export async function createDataSubjectRequest(input: {
  session: AppSession;
  idempotencyKey: string;
  request: {
    contactId: string | null;
    requestReference: string;
    requestType: DataSubjectRequestType;
    dueAt: string | null;
    reviewNote: string;
  };
}) {
  assertPersistence();
  assertPrivacyManager(input.session);
  return withTenantTransaction(
    { actorId: input.session.userId, workspaceId: input.session.workspaceId },
    async (transaction) => {
      const operation = "privacy.data_subject_request.create";
      const claim = await claimSafeMutation({ transaction, session: input.session, operation,
        idempotencyKey: input.idempotencyKey, payload: input.request });
      if (claim.kind === "replayed") return { ...(claim.response as object), replayed: true };
      if (input.request.contactId) {
        await requireEntity(transaction, input.session.workspaceId, "contact", input.request.contactId);
      }
      const hold = await activeDataSubjectRequestHold(
        transaction,
        input.session.workspaceId,
        input.request.contactId,
      );
      const request = await transaction.queryOne<DataSubjectRequestRow>(
        `insert into privacy_data_subject_requests (
           workspace_id, contact_id, request_reference, request_type, due_at,
           legal_hold_blocked, review_note, created_by_user_id
         ) values ($1, $2, $3, $4, $5, $6, $7, $8)
         returning id, contact_id as "contactId", request_reference as "requestReference",
           request_type as "requestType", status, identity_verified_at as "identityVerifiedAt",
           due_at as "dueAt", export_job_metadata as "exportJobMetadata",
           legal_hold_blocked as "legalHoldBlocked", review_note as "reviewNote",
           reviewed_by_user_id as "reviewedByUserId", reviewed_at as "reviewedAt",
           created_at as "createdAt", updated_at as "updatedAt"`,
        [input.session.workspaceId, input.request.contactId, input.request.requestReference,
          input.request.requestType, input.request.dueAt, Boolean(hold), input.request.reviewNote,
          input.session.userId],
      );
      if (!request) throw new ContentRepositoryError("CONFLICT", "Data-subject request could not be created");
      const response = { request: mapDataSubjectRequest(request), automaticActionPerformed: false as const,
        replayed: false };
      await writeAuditLog({ session: input.session, action: "privacy.data_subject_request.created",
        entityType: "data_subject_request", entityId: request.id,
        after: response.request, transaction });
      await completeSafeMutation({ transaction, session: input.session, operation,
        idempotencyKey: input.idempotencyKey, response });
      return response;
    },
  );
}

export async function updateDataSubjectRequest(input: {
  session: AppSession;
  idempotencyKey: string;
  requestId: string;
  expectedUpdatedAt: string;
  status: DataSubjectRequestStatus;
  identityVerifiedAt?: string | null;
  exportJobMetadata?: Record<string, unknown>;
  reviewNote?: string;
}) {
  assertPersistence();
  assertPrivacyManager(input.session);
  return withTenantTransaction(
    { actorId: input.session.userId, workspaceId: input.session.workspaceId },
    async (transaction) => {
      const operation = "privacy.data_subject_request.update";
      const payload = { requestId: input.requestId, expectedUpdatedAt: input.expectedUpdatedAt,
        status: input.status, identityVerifiedAt: input.identityVerifiedAt,
        exportJobMetadata: input.exportJobMetadata, reviewNote: input.reviewNote };
      const claim = await claimSafeMutation({ transaction, session: input.session, operation,
        idempotencyKey: input.idempotencyKey, payload });
      if (claim.kind === "replayed") return { ...(claim.response as object), replayed: true };
      const before = await transaction.queryOne<DataSubjectRequestRow>(
        `${requestSelect} where request.workspace_id = $1 and request.id = $2 for update of request`,
        [input.session.workspaceId, input.requestId],
      );
      if (!before) throw new ContentRepositoryError("NOT_FOUND", "Data-subject request was not found");
      if (iso(before.updatedAt) !== iso(input.expectedUpdatedAt)) {
        throw new ContentRepositoryError("CONFLICT", "Data-subject request changed since it was loaded");
      }
      if (dataSubjectRequestStatusRequiresOperationEvidence(input.status)) {
        throw new ContentRepositoryError(
          "CONFLICT",
          "This status requires a separate host-side operation and immutable evidence",
        );
      }
      if (!isAllowedDataSubjectRequestTransition(before.status, input.status)) {
        throw new ContentRepositoryError(
          "CONFLICT",
          `Data-subject request cannot transition from ${before.status} to ${input.status}`,
        );
      }
      if (input.exportJobMetadata !== undefined) {
        throw new ContentRepositoryError(
          "CONFLICT",
          "Export evidence can only be recorded by the host-side execution service",
        );
      }
      const previousIdentityVerifiedAt = iso(before.identityVerifiedAt);
      if (previousIdentityVerifiedAt && input.identityVerifiedAt !== undefined
        && input.identityVerifiedAt !== previousIdentityVerifiedAt) {
        throw new ContentRepositoryError("CONFLICT", "Identity verification evidence is immutable");
      }
      if (!previousIdentityVerifiedAt && input.identityVerifiedAt
        && !(before.status === "identity_check" && input.status === "in_review")) {
        throw new ContentRepositoryError(
          "CONFLICT",
          "Identity verification may only be recorded when identity check advances to review",
        );
      }
      const identityVerifiedAt = input.identityVerifiedAt === undefined
        ? previousIdentityVerifiedAt
        : input.identityVerifiedAt;
      if (dataSubjectRequestStatusRequiresIdentity(input.status) && !identityVerifiedAt) {
        throw new ContentRepositoryError(
          "CONFLICT",
          "Identity must be verified before this status transition",
        );
      }
      const hold = await activeDataSubjectRequestHold(
        transaction,
        input.session.workspaceId,
        before.contactId,
      );
      if (hold && input.status === "approved" && before.requestType === "erasure") {
        throw new ContentRepositoryError("REFERENCE_BLOCKED", "An active legal hold blocks this erasure request");
      }
      const request = await transaction.queryOne<DataSubjectRequestRow>(
        `update privacy_data_subject_requests set status = $3, identity_verified_at = $4,
           legal_hold_blocked = $5, review_note = coalesce($6, review_note),
           reviewed_by_user_id = $7, reviewed_at = now(), updated_at = now()
         where workspace_id = $1 and id = $2
         returning id, contact_id as "contactId", request_reference as "requestReference",
           request_type as "requestType", status, identity_verified_at as "identityVerifiedAt",
           due_at as "dueAt", export_job_metadata as "exportJobMetadata",
           legal_hold_blocked as "legalHoldBlocked", review_note as "reviewNote",
           reviewed_by_user_id as "reviewedByUserId", reviewed_at as "reviewedAt",
           created_at as "createdAt", updated_at as "updatedAt"`,
        [input.session.workspaceId, input.requestId, input.status, identityVerifiedAt,
          Boolean(hold), input.reviewNote ?? null, input.session.userId],
      );
      if (!request) throw new ContentRepositoryError("CONFLICT", "Data-subject request could not be updated");
      const response = { request: mapDataSubjectRequest(request), automaticActionPerformed: false as const,
        hardDeletePerformed: false as const, replayed: false };
      await writeAuditLog({ session: input.session, action: "privacy.data_subject_request.updated",
        entityType: "data_subject_request", entityId: input.requestId,
        before: mapDataSubjectRequest(before), after: response, transaction });
      await completeSafeMutation({ transaction, session: input.session, operation,
        idempotencyKey: input.idempotencyKey, response });
      return response;
    },
  );
}

export async function getDataSubjectRequest(input: { session: AppSession; requestId: string }) {
  assertPersistence();
  assertPrivacyManager(input.session);
  return withTenantTransaction(
    { actorId: input.session.userId, workspaceId: input.session.workspaceId },
    async (transaction) => {
      const request = await transaction.queryOne<DataSubjectRequestRow>(
        `${requestSelect} where request.workspace_id = $1 and request.id = $2`,
        [input.session.workspaceId, input.requestId],
      );
      return request ? mapDataSubjectRequest(request) : null;
    },
  );
}
