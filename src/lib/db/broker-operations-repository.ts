import { createHash } from "node:crypto";
import type { AppSession } from "@/lib/auth/session";
import { canViewAllWorkspaceContacts } from "@/lib/contact-access";
import {
  tenantQuery,
  withTenantTransaction,
  type TenantTransaction,
} from "@/lib/db/tenant-client";
import { canPersist, writeAuditLog } from "@/lib/db/runtime-repositories";
import {
  canManageContent,
  communicationTemplateReadAccessSql,
  contentDocumentReadAccessSql,
} from "@/lib/db/content-library-repositories";
import {
  BrokerDomainError,
  activityTypes,
  asRecord,
  booleanValue,
  cleanString,
  closingStatuses,
  enumValue,
  expectedVersion,
  isValidTimeZone,
  matchDecisionStatuses,
  offerStatuses,
  optionalFiniteNumber,
  optionalInteger,
  optionalIsoDate,
  optionalString,
  optionalUuid,
  paymentStatuses,
  requiredString,
  requiredUuid,
  searchProfileStatuses,
  stringList,
  uuidList,
  viewingStatuses,
  type Pagination,
} from "@/lib/broker-flow/contracts";
import {
  brokerMatchingAlgorithmVersion,
  evaluateBrokerMatch,
  type MatchCandidate,
  type SearchProfileForMatching,
} from "@/lib/broker-flow/matching";
import {
  parseCommissionSplits,
  parseMinorUnits,
  validateClosingMoney,
  validateCommissionSplits,
} from "@/lib/broker-flow/money";
import { evaluateQaOfferDelivery } from "@/lib/broker-flow/provider-policy";
import {
  canManageBrokerFinancials,
  canUseBrokerProjectEditScope,
} from "@/lib/broker-flow/access-policy";
import {
  assertInitialState,
  assertMutableState,
  assertTransition,
  closingTransitions,
  matchDecisionTransitions,
  offerTransitions,
  paymentTransitions,
  searchProfileTransitions,
  viewingTransitions,
} from "@/lib/broker-flow/state-machines";

type JsonObject = Record<string, unknown>;

export type BrokerMutationResult<T> = Readonly<{
  data: T;
  httpStatus: number;
  replayed: boolean;
}>;

type IdempotencyRow = {
  entityId: string | null;
  entityType: string | null;
  operationType: string;
  requestHash: string;
  responsePayload: TJson | null;
  responseStatus: number | null;
};

type TJson = JsonObject | unknown[] | string | number | boolean | null;

type EntityReference = "closing" | "contact" | "deal" | "lead" | "listing" | "offer" | "organization" | "owner" | "reservation" | "unit" | "viewing";

const referenceTables: Record<EntityReference, { projectColumn: boolean; table: string }> = Object.freeze({
  closing: { projectColumn: true, table: "broker_closings" },
  contact: { projectColumn: true, table: "contacts" },
  deal: { projectColumn: true, table: "deals" },
  lead: { projectColumn: true, table: "leads" },
  listing: { projectColumn: true, table: "seller_listings" },
  offer: { projectColumn: true, table: "broker_offers" },
  organization: { projectColumn: true, table: "organizations" },
  owner: { projectColumn: false, table: "workspace_users" },
  reservation: { projectColumn: true, table: "property_reservations" },
  unit: { projectColumn: true, table: "property_units" },
  viewing: { projectColumn: true, table: "property_viewing_slots" },
});

function assertPersistence(session: AppSession) {
  if (!canPersist()) {
    throw new BrokerDomainError("database_not_configured", "Database persistence is not configured.", 503);
  }
  if (!session.workspaceId) {
    throw new BrokerDomainError("invalid_workspace", "A workspace-scoped session is required.", 403);
  }
}

async function hasBrokerProjectEditPermission(
  transaction: TenantTransaction,
  session: AppSession,
  projectId: string | null,
) {
  if (!projectId || !canUseBrokerProjectEditScope(session)) return false;
  const permission = await transaction.queryOne<{ canEditDeals: boolean }>(
    `
      select can_edit_deals as "canEditDeals"
      from project_pipeline_permissions
      where workspace_id = $1::uuid and project_id = $2::uuid and user_id = $3::uuid
      limit 1
      for share
    `,
    [session.workspaceId, projectId, session.userId],
  );
  return permission?.canEditDeals === true;
}

async function assertBrokerProjectEditAccess(input: {
  projectId: string;
  session: AppSession;
  transaction: TenantTransaction;
}) {
  if (canViewAllWorkspaceContacts(input.session)) return;
  if (await hasBrokerProjectEditPermission(input.transaction, input.session, input.projectId)) return;
  throw new BrokerDomainError(
    "project_scope_forbidden",
    "This broker operation requires explicit project-edit scope.",
    403,
  );
}

async function assertBrokerRecordAccess(input: {
  desiredOwnerUserId?: string | null;
  existingOwnerUserId?: string | null;
  projectId: string | null;
  session: AppSession;
  transaction: TenantTransaction;
}) {
  if (canViewAllWorkspaceContacts(input.session)) return;
  const projectEditor = await hasBrokerProjectEditPermission(input.transaction, input.session, input.projectId);
  const existingAllowed = input.existingOwnerUserId === undefined
    || input.existingOwnerUserId === input.session.userId
    || projectEditor;
  if (!existingAllowed) {
    throw new BrokerDomainError(
      "record_scope_forbidden",
      "This broker record is outside your owner or project-edit scope.",
      403,
    );
  }
  if (input.desiredOwnerUserId === undefined) return;
  const ownerAssignmentAllowed = input.existingOwnerUserId === undefined
    ? input.desiredOwnerUserId === input.session.userId
    : input.desiredOwnerUserId === input.existingOwnerUserId;
  if (!ownerAssignmentAllowed) {
    throw new BrokerDomainError(
      "owner_reassignment_forbidden",
      "Only a workspace manager can assign or reassign a broker record owner.",
      403,
    );
  }
}

type BrokerOwnedReference = "contact" | "deal" | "lead" | "organization";

const brokerOwnedReferences: Record<BrokerOwnedReference, { ownerColumn: string; table: string }> = Object.freeze({
  contact: { ownerColumn: "owner_user_id", table: "contacts" },
  deal: { ownerColumn: "owner_user_id", table: "deals" },
  lead: { ownerColumn: "assigned_to_user_id", table: "leads" },
  organization: { ownerColumn: "owner_user_id", table: "organizations" },
});

async function assertBrokerReferenceAccess(input: {
  id: string | null;
  kind: BrokerOwnedReference;
  projectId: string;
  session: AppSession;
  transaction: TenantTransaction;
}) {
  if (!input.id || canViewAllWorkspaceContacts(input.session)) return;
  if (await hasBrokerProjectEditPermission(input.transaction, input.session, input.projectId)) return;
  const reference = brokerOwnedReferences[input.kind];
  const row = await input.transaction.queryOne<{ ownerUserId: string | null }>(
    `
      select ${reference.ownerColumn} as "ownerUserId"
      from ${reference.table}
      where workspace_id = $1::uuid and (project_id = $2::uuid or project_id is null) and id = $3::uuid
    `,
    [input.session.workspaceId, input.projectId, input.id],
  );
  if (row?.ownerUserId !== input.session.userId) {
    throw new BrokerDomainError(
      "reference_scope_forbidden",
      `${input.kind} is outside your owner or project-edit scope.`,
      403,
    );
  }
}

async function assertBrokerPartyRelationships(input: {
  contactId: string;
  dealId?: string | null;
  leadId?: string | null;
  projectId: string;
  session: AppSession;
  transaction: TenantTransaction;
}) {
  if (input.leadId) {
    const lead = await input.transaction.queryOne<{ contactId: string | null }>(
      `
        select contact_id as "contactId"
        from leads
        where workspace_id = $1::uuid and (project_id = $2::uuid or project_id is null) and id = $3::uuid
      `,
      [input.session.workspaceId, input.projectId, input.leadId],
    );
    if (lead?.contactId && lead.contactId !== input.contactId) {
      throw new BrokerDomainError("lead_contact_mismatch", "Lead and broker contact do not match.", 409);
    }
  }
  if (input.dealId) {
    const deal = await input.transaction.queryOne<{ contactId: string | null; leadId: string | null }>(
      `
        select contact_id as "contactId", lead_id as "leadId"
        from deals
        where workspace_id = $1::uuid and (project_id = $2::uuid or project_id is null) and id = $3::uuid
      `,
      [input.session.workspaceId, input.projectId, input.dealId],
    );
    if (deal?.contactId !== input.contactId) {
      throw new BrokerDomainError("deal_contact_mismatch", "Deal and broker contact do not match.", 409);
    }
    if (input.leadId && deal.leadId && deal.leadId !== input.leadId) {
      throw new BrokerDomainError("deal_lead_mismatch", "Deal and broker lead do not match.", 409);
    }
  }
}

function toJsonValue(value: unknown): TJson {
  return JSON.parse(JSON.stringify(value, (_key, entry) => typeof entry === "bigint" ? entry.toString() : entry)) as TJson;
}

function canonicalize(value: unknown): string {
  if (value === undefined) return '"__undefined__"';
  if (value === null || typeof value !== "object") {
    return JSON.stringify(typeof value === "bigint" ? value.toString() : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.entries(value as JsonObject)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
    .join(",")}}`;
}

function sha256(value: unknown) {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

async function withIdempotentMutation<T>(input: {
  entityType: string;
  idempotencyKey: string;
  operationType: string;
  payload: unknown;
  session: AppSession;
  write: (transaction: TenantTransaction) => Promise<{ data: T; entityId?: string | null; httpStatus?: number }>;
}): Promise<BrokerMutationResult<T>> {
  assertPersistence(input.session);
  const requestHash = sha256({ operationType: input.operationType, payload: input.payload });
  return withTenantTransaction({
    actorId: input.session.userId,
    workspaceId: input.session.workspaceId,
  }, async (transaction) => {
    const claimed = await transaction.queryOne<{ id: string }>(
      `
        insert into broker_operation_requests (
          workspace_id, actor_user_id, idempotency_key, operation_type, request_hash
        ) values ($1::uuid, $2::uuid, $3, $4, $5)
        on conflict (workspace_id, actor_user_id, idempotency_key) do nothing
        returning id
      `,
      [input.session.workspaceId, input.session.userId, input.idempotencyKey, input.operationType, requestHash],
    );

    if (!claimed) {
      const existing = await transaction.queryOne<IdempotencyRow>(
        `
          select
            operation_type as "operationType",
            request_hash as "requestHash",
            entity_type as "entityType",
            entity_id as "entityId",
            response_status as "responseStatus",
            response_payload as "responsePayload"
          from broker_operation_requests
          where workspace_id = $1::uuid and actor_user_id = $2::uuid and idempotency_key = $3
          for update
        `,
        [input.session.workspaceId, input.session.userId, input.idempotencyKey],
      );
      if (!existing) throw new BrokerDomainError("idempotency_conflict", "Idempotency claim disappeared.", 409);
      if (existing.requestHash !== requestHash || existing.operationType !== input.operationType) {
        throw new BrokerDomainError(
          "idempotency_conflict",
          "Idempotency-Key was already used for a different request.",
          409,
        );
      }
      if (existing.responseStatus === null || existing.responsePayload === null) {
        throw new BrokerDomainError("operation_in_progress", "An identical operation is still in progress.", 409);
      }
      return {
        data: existing.responsePayload as T,
        httpStatus: existing.responseStatus,
        replayed: true,
      };
    }

    const written = await input.write(transaction);
    const payload = toJsonValue(written.data);
    const httpStatus = written.httpStatus ?? 200;
    await transaction.execute(
      `
        update broker_operation_requests
        set entity_type = $4, entity_id = $5::uuid, response_status = $6,
            response_payload = $7::jsonb, completed_at = now()
        where workspace_id = $1::uuid and actor_user_id = $2::uuid and idempotency_key = $3
      `,
      [
        input.session.workspaceId,
        input.session.userId,
        input.idempotencyKey,
        input.entityType,
        written.entityId ?? null,
        httpStatus,
        JSON.stringify(payload),
      ],
    );
    return { data: payload as T, httpStatus, replayed: false };
  });
}

async function assertProject(transaction: TenantTransaction, session: AppSession, projectId: string) {
  const row = await transaction.queryOne<{ id: string }>(
    `select id from projects where workspace_id = $1::uuid and id = $2::uuid`,
    [session.workspaceId, projectId],
  );
  if (!row) throw new BrokerDomainError("project_not_found", "Project was not found in this workspace.", 404);
}

async function assertReference(
  transaction: TenantTransaction,
  session: AppSession,
  kind: EntityReference,
  id: string | null,
  projectId?: string | null,
) {
  if (!id) return null;
  const reference = referenceTables[kind];
  const row = await transaction.queryOne<{ id: string; projectId: string | null }>(
    reference.projectColumn
      ? `select id, project_id as "projectId" from ${reference.table} where workspace_id = $1::uuid and id = $2::uuid`
      : `select id, null::uuid as "projectId" from ${reference.table} where workspace_id = $1::uuid and id = $2::uuid`,
    [session.workspaceId, id],
  );
  if (!row) throw new BrokerDomainError("reference_not_found", `${kind} was not found in this workspace.`, 404, { id, kind });
  if (projectId && row.projectId && row.projectId !== projectId) {
    throw new BrokerDomainError("project_scope_mismatch", `${kind} belongs to a different project.`, 400, { id, kind });
  }
  return row;
}

function optionalMinor(value: unknown, field: string, fallback: string | null = null) {
  if (value === undefined) return fallback;
  if (value === null || value === "") return null;
  return parseMinorUnits(value, field, { allowZero: true }).toString();
}

function numberFromDb(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringFromDb(value: unknown) {
  return value === null || value === undefined ? null : String(value);
}

function dateOnly(value: unknown, field: string, fallback: string | null = null) {
  if (value === undefined) return fallback;
  const iso = optionalIsoDate(value, field);
  return iso?.slice(0, 10) ?? null;
}

type SearchProfileRow = {
  accessibility: string;
  areaFromSqm: number | string | null;
  areaSqm: number | string | null;
  areaToSqm: number | string | null;
  autoMatchEnabled: boolean;
  budgetFromMinor: number | string | null;
  budgetToMinor: number | string | null;
  buyerLeadId: string | null;
  contactId: string | null;
  desiredLocation: string | null;
  equipment: string[] | null;
  exclusionCriteria: string[] | null;
  expiresAt: string | Date | null;
  financingStatus: string | null;
  id: string;
  intentType: string;
  municipality: string | null;
  mustHaveCriteria: string[] | null;
  niceToHaveCriteria: string[] | null;
  organizationId: string | null;
  ownerUserId: string | null;
  postalCode: string | null;
  projectId: string | null;
  propertyType: string | null;
  purchaseTimeline: string | null;
  radiusKm: number | string | null;
  region: string | null;
  rooms: number | string | null;
  roomsFrom: number | string | null;
  roomsTo: number | string | null;
  status: string;
  subObjectType: string | null;
  targetYieldBasisPoints: number | string | null;
  title: string;
  updatedAt: string | Date;
  version: number | string;
  workspaceId: string;
  yearBuiltFrom: number | string | null;
  yearBuiltTo: number | string | null;
};

const searchProfileReturningSql = `
  id,
  workspace_id as "workspaceId",
  project_id as "projectId",
  buyer_lead_id as "buyerLeadId",
  contact_id as "contactId",
  organization_id as "organizationId",
  owner_user_id as "ownerUserId",
  title,
  budget_from_cents as "budgetFromMinor",
  budget_to_cents as "budgetToMinor",
  financing_status as "financingStatus",
  desired_location as "desiredLocation",
  property_type as "propertyType",
  rooms,
  area_sqm as "areaSqm",
  must_have_criteria as "mustHaveCriteria",
  nice_to_have_criteria as "niceToHaveCriteria",
  purchase_timeline as "purchaseTimeline",
  expires_at as "expiresAt",
  intent_type as "intentType",
  sub_object_type as "subObjectType",
  area_from_sqm as "areaFromSqm",
  area_to_sqm as "areaToSqm",
  rooms_from as "roomsFrom",
  rooms_to as "roomsTo",
  region,
  municipality,
  postal_code as "postalCode",
  radius_km as "radiusKm",
  year_built_from as "yearBuiltFrom",
  year_built_to as "yearBuiltTo",
  equipment,
  accessibility,
  target_yield_basis_points as "targetYieldBasisPoints",
  exclusion_criteria as "exclusionCriteria",
  auto_match_enabled as "autoMatchEnabled",
  status,
  version,
  updated_at as "updatedAt"
`;

function toSearchProfile(row: SearchProfileRow) {
  return {
    accessibility: row.accessibility,
    areaFromSqm: numberFromDb(row.areaFromSqm),
    areaToSqm: numberFromDb(row.areaToSqm),
    autoMatchEnabled: row.autoMatchEnabled,
    budgetFromMinor: stringFromDb(row.budgetFromMinor),
    budgetToMinor: stringFromDb(row.budgetToMinor),
    buyerLeadId: row.buyerLeadId,
    contactId: row.contactId,
    equipment: row.equipment ?? [],
    exclusionCriteria: row.exclusionCriteria ?? [],
    expiresAt: row.expiresAt ? new Date(row.expiresAt).toISOString().slice(0, 10) : null,
    financingStatus: row.financingStatus,
    id: row.id,
    intentType: row.intentType,
    municipality: row.municipality,
    mustHaveCriteria: row.mustHaveCriteria ?? [],
    niceToHaveCriteria: row.niceToHaveCriteria ?? [],
    organizationId: row.organizationId,
    ownerUserId: row.ownerUserId,
    postalCode: row.postalCode,
    projectId: row.projectId,
    propertyType: row.propertyType,
    purchaseTimeline: row.purchaseTimeline,
    radiusKm: numberFromDb(row.radiusKm),
    region: row.region,
    roomsFrom: numberFromDb(row.roomsFrom),
    roomsTo: numberFromDb(row.roomsTo),
    status: row.status,
    subObjectType: row.subObjectType,
    targetYieldBasisPoints: numberFromDb(row.targetYieldBasisPoints),
    title: row.title,
    updatedAt: new Date(row.updatedAt).toISOString(),
    version: Number(row.version),
    workspaceId: row.workspaceId,
    yearBuiltFrom: numberFromDb(row.yearBuiltFrom),
    yearBuiltTo: numberFromDb(row.yearBuiltTo),
  };
}

async function loadSearchProfileForUpdate(transaction: TenantTransaction, workspaceId: string, profileId: string) {
  return transaction.queryOne<SearchProfileRow>(
    `select ${searchProfileReturningSql} from buyer_search_profiles where workspace_id = $1::uuid and id = $2::uuid for update`,
    [workspaceId, profileId],
  );
}

function normalizeProfilePayload(payload: JsonObject, existing?: SearchProfileRow | null) {
  const fallback = existing ? toSearchProfile(existing) : null;
  const projectId = optionalUuid(payload.projectId ?? fallback?.projectId, "projectId");
  if (!projectId) throw new BrokerDomainError("project_required", "projectId is required.");
  const contactId = optionalUuid(payload.contactId ?? fallback?.contactId, "contactId");
  const organizationId = optionalUuid(payload.organizationId ?? fallback?.organizationId, "organizationId");
  if (!contactId && !organizationId) {
    throw new BrokerDomainError("profile_party_required", "A contactId or organizationId is required.");
  }
  const areaFromSqm = optionalFiniteNumber(payload.areaFromSqm ?? fallback?.areaFromSqm, "areaFromSqm", 0, 1_000_000);
  const areaToSqm = optionalFiniteNumber(payload.areaToSqm ?? fallback?.areaToSqm, "areaToSqm", 0, 1_000_000);
  const roomsFrom = optionalFiniteNumber(payload.roomsFrom ?? fallback?.roomsFrom, "roomsFrom", 0, 10_000);
  const roomsTo = optionalFiniteNumber(payload.roomsTo ?? fallback?.roomsTo, "roomsTo", 0, 10_000);
  const budgetFromMinor = optionalMinor(payload.budgetFromMinor, "budgetFromMinor", fallback?.budgetFromMinor ?? null);
  const budgetToMinor = optionalMinor(payload.budgetToMinor, "budgetToMinor", fallback?.budgetToMinor ?? null);
  if (areaFromSqm !== null && areaToSqm !== null && areaFromSqm > areaToSqm) {
    throw new BrokerDomainError("invalid_range", "areaFromSqm cannot exceed areaToSqm.");
  }
  if (roomsFrom !== null && roomsTo !== null && roomsFrom > roomsTo) {
    throw new BrokerDomainError("invalid_range", "roomsFrom cannot exceed roomsTo.");
  }
  if (budgetFromMinor !== null && budgetToMinor !== null && BigInt(budgetFromMinor) > BigInt(budgetToMinor)) {
    throw new BrokerDomainError("invalid_range", "budgetFromMinor cannot exceed budgetToMinor.");
  }
  const yearBuiltFrom = optionalInteger(payload.yearBuiltFrom ?? fallback?.yearBuiltFrom, "yearBuiltFrom", 1000, 3000);
  const yearBuiltTo = optionalInteger(payload.yearBuiltTo ?? fallback?.yearBuiltTo, "yearBuiltTo", 1000, 3000);
  if (yearBuiltFrom !== null && yearBuiltTo !== null && yearBuiltFrom > yearBuiltTo) {
    throw new BrokerDomainError("invalid_range", "yearBuiltFrom cannot exceed yearBuiltTo.");
  }
  const status = enumValue(payload.status ?? fallback?.status, "status", searchProfileStatuses, "draft");
  const expiresAt = dateOnly(payload.expiresAt, "expiresAt", fallback?.expiresAt ?? null);
  if (status === "active" && expiresAt && new Date(`${expiresAt}T23:59:59.999Z`).getTime() < Date.now()) {
    throw new BrokerDomainError("profile_expired", "An active profile cannot have a past expiry date.");
  }
  return {
    accessibility: enumValue(payload.accessibility ?? fallback?.accessibility, "accessibility", ["none", "preferred", "required"] as const, "none"),
    areaFromSqm,
    areaToSqm,
    autoMatchEnabled: booleanValue(payload.autoMatchEnabled, fallback?.autoMatchEnabled ?? false),
    budgetFromMinor,
    budgetToMinor,
    buyerLeadId: optionalUuid(payload.buyerLeadId ?? fallback?.buyerLeadId, "buyerLeadId"),
    contactId,
    equipment: payload.equipment === undefined ? fallback?.equipment ?? [] : stringList(payload.equipment, "equipment"),
    exclusionCriteria: payload.exclusionCriteria === undefined ? fallback?.exclusionCriteria ?? [] : stringList(payload.exclusionCriteria, "exclusionCriteria"),
    expiresAt,
    financingStatus: optionalString(payload.financingStatus ?? fallback?.financingStatus, 100),
    intentType: enumValue(payload.intentType ?? fallback?.intentType, "intentType", ["purchase", "rent", "investment"] as const, "purchase"),
    municipality: optionalString(payload.municipality ?? fallback?.municipality, 160),
    mustHaveCriteria: payload.mustHaveCriteria === undefined ? fallback?.mustHaveCriteria ?? [] : stringList(payload.mustHaveCriteria, "mustHaveCriteria"),
    niceToHaveCriteria: payload.niceToHaveCriteria === undefined ? fallback?.niceToHaveCriteria ?? [] : stringList(payload.niceToHaveCriteria, "niceToHaveCriteria"),
    organizationId,
    ownerUserId: optionalUuid(payload.ownerUserId ?? fallback?.ownerUserId, "ownerUserId"),
    postalCode: optionalString(payload.postalCode ?? fallback?.postalCode, 32),
    projectId,
    propertyType: optionalString(payload.propertyType ?? fallback?.propertyType, 120),
    purchaseTimeline: optionalString(payload.purchaseTimeline ?? fallback?.purchaseTimeline, 160),
    radiusKm: optionalFiniteNumber(payload.radiusKm ?? fallback?.radiusKm, "radiusKm", 0, 10_000),
    region: optionalString(payload.region ?? fallback?.region, 160),
    roomsFrom,
    roomsTo,
    status,
    subObjectType: optionalString(payload.subObjectType ?? fallback?.subObjectType, 160),
    targetYieldBasisPoints: optionalInteger(payload.targetYieldBasisPoints ?? fallback?.targetYieldBasisPoints, "targetYieldBasisPoints", 0, 100_000),
    title: requiredString(payload.title ?? fallback?.title, "title", 200),
    yearBuiltFrom,
    yearBuiltTo,
  };
}

export async function listBrokerSearchProfiles(input: {
  contactId?: string | null;
  leadId?: string | null;
  pagination: Pagination;
  projectId?: string | null;
  q?: string | null;
  session: AppSession;
  status?: string | null;
}) {
  assertPersistence(input.session);
  const projectId = input.projectId ? requiredUuid(input.projectId, "projectId") : null;
  const contactId = input.contactId ? requiredUuid(input.contactId, "contactId") : null;
  const leadId = input.leadId ? requiredUuid(input.leadId, "leadId") : null;
  const status = input.status ? enumValue(input.status, "status", searchProfileStatuses) : null;
  const q = optionalString(input.q, 160);
  const rows = await tenantQuery<SearchProfileRow & { totalCount: number | string }>(
    { actorId: input.session.userId, workspaceId: input.session.workspaceId },
    `
      select ${searchProfileReturningSql}, count(*) over() as "totalCount"
      from buyer_search_profiles
      where workspace_id = $1::uuid
        and ($2::uuid is null or project_id = $2::uuid)
        and ($3::text is null or status = $3)
        and ($4::uuid is null or contact_id = $4::uuid)
        and ($5::uuid is null or buyer_lead_id = $5::uuid)
        and ($6::text is null or title ilike '%' || $6 || '%')
        and (
          $9::boolean or owner_user_id = $10::uuid
          or ($11::boolean and exists (
            select 1 from project_pipeline_permissions permission
            where permission.workspace_id = buyer_search_profiles.workspace_id
              and permission.project_id = buyer_search_profiles.project_id
              and permission.user_id = $10::uuid and permission.can_edit_deals = true
          ))
        )
      order by updated_at desc, id
      limit $7 offset $8
    `,
    [input.session.workspaceId, projectId, status, contactId, leadId, q, input.pagination.limit, input.pagination.offset,
      canViewAllWorkspaceContacts(input.session), input.session.userId,
      canUseBrokerProjectEditScope(input.session)],
  );
  return {
    items: rows.map(toSearchProfile),
    pagination: {
      hasMore: input.pagination.offset + rows.length < Number(rows[0]?.totalCount ?? 0),
      limit: input.pagination.limit,
      offset: input.pagination.offset,
      total: Number(rows[0]?.totalCount ?? 0),
    },
  };
}

export async function saveBrokerSearchProfile(input: {
  idempotencyKey: string;
  payload: JsonObject;
  session: AppSession;
}) {
  const profileId = optionalUuid(input.payload.id, "id");
  return withIdempotentMutation({
    entityType: "buyer_search_profile",
    idempotencyKey: input.idempotencyKey,
    operationType: profileId ? "broker.search_profile.update" : "broker.search_profile.create",
    payload: input.payload,
    session: input.session,
    write: async (transaction) => {
      const existing = profileId
        ? await loadSearchProfileForUpdate(transaction, input.session.workspaceId, profileId)
        : null;
      if (profileId && !existing) throw new BrokerDomainError("profile_not_found", "Search profile was not found.", 404);
      if (existing && Number(existing.version) !== expectedVersion(input.payload.expectedVersion)) {
        throw new BrokerDomainError("version_conflict", "Search profile changed since it was loaded.", 409);
      }
      const profile = normalizeProfilePayload({
        ...input.payload,
        ownerUserId: input.payload.ownerUserId === undefined
          ? existing ? existing.ownerUserId : input.session.userId
          : input.payload.ownerUserId,
      }, existing);
      await assertProject(transaction, input.session, profile.projectId);
      if (existing) {
        await assertBrokerRecordAccess({
          existingOwnerUserId: existing.ownerUserId,
          projectId: existing.projectId,
          session: input.session,
          transaction,
        });
      }
      if (!existing || existing.projectId !== profile.projectId) {
        await assertBrokerProjectEditAccess({
          projectId: profile.projectId,
          session: input.session,
          transaction,
        });
      }
      await assertBrokerRecordAccess({
        desiredOwnerUserId: profile.ownerUserId,
        existingOwnerUserId: existing?.ownerUserId,
        projectId: profile.projectId,
        session: input.session,
        transaction,
      });
      await Promise.all([
        assertReference(transaction, input.session, "contact", profile.contactId, profile.projectId),
        assertReference(transaction, input.session, "organization", profile.organizationId, profile.projectId),
        assertReference(transaction, input.session, "lead", profile.buyerLeadId, profile.projectId),
        assertReference(transaction, input.session, "owner", profile.ownerUserId),
      ]);
      await Promise.all([
        assertBrokerReferenceAccess({ id: profile.contactId, kind: "contact", projectId: profile.projectId, session: input.session, transaction }),
        assertBrokerReferenceAccess({ id: profile.organizationId, kind: "organization", projectId: profile.projectId, session: input.session, transaction }),
        assertBrokerReferenceAccess({ id: profile.buyerLeadId, kind: "lead", projectId: profile.projectId, session: input.session, transaction }),
      ]);
      if (profile.contactId) {
        await assertBrokerPartyRelationships({
          contactId: profile.contactId,
          leadId: profile.buyerLeadId,
          projectId: profile.projectId,
          session: input.session,
          transaction,
        });
      }
      if (existing) {
        assertMutableState(existing.status as (typeof searchProfileStatuses)[number], ["archived"], "search profile");
        assertTransition(searchProfileTransitions, existing.status as (typeof searchProfileStatuses)[number], profile.status, "search profile");
        if (existing.status === "expired" && profile.status === "active" && !optionalString(input.payload.renewalReason, 1_000)) {
          throw new BrokerDomainError("renewal_reason_required", "Renewing an expired search profile requires renewalReason.");
        }
      } else {
        assertInitialState(profile.status, "draft", "search profile");
      }

      const params = [
        input.session.workspaceId,
        profile.projectId,
        profile.buyerLeadId,
        profile.contactId,
        profile.organizationId,
        profile.ownerUserId,
        profile.title,
        profile.budgetFromMinor,
        profile.budgetToMinor,
        profile.financingStatus,
        profile.propertyType,
        profile.subObjectType,
        profile.areaFromSqm,
        profile.areaToSqm,
        profile.roomsFrom,
        profile.roomsTo,
        profile.region,
        profile.municipality,
        profile.postalCode,
        profile.radiusKm,
        profile.yearBuiltFrom,
        profile.yearBuiltTo,
        profile.equipment,
        profile.accessibility,
        profile.targetYieldBasisPoints,
        profile.mustHaveCriteria,
        profile.niceToHaveCriteria,
        profile.exclusionCriteria,
        profile.purchaseTimeline,
        profile.expiresAt,
        profile.intentType,
        profile.autoMatchEnabled,
        profile.status,
      ] as const;

      const row = existing
        ? await transaction.queryOne<SearchProfileRow>(
            `
              update buyer_search_profiles set
                project_id = $2::uuid, buyer_lead_id = $3::uuid, contact_id = $4::uuid,
                organization_id = $5::uuid, owner_user_id = $6::uuid, title = $7,
                budget_from_cents = $8::bigint, budget_to_cents = $9::bigint,
                financing_status = $10, property_type = $11, sub_object_type = $12,
                area_from_sqm = $13::numeric, area_to_sqm = $14::numeric,
                rooms_from = $15::numeric, rooms_to = $16::numeric,
                area_sqm = $13::numeric, rooms = $15::numeric,
                region = $17, municipality = $18, postal_code = $19, radius_km = $20::numeric,
                year_built_from = $21, year_built_to = $22, equipment = $23::text[],
                accessibility = $24, target_yield_basis_points = $25,
                must_have_criteria = $26::text[], nice_to_have_criteria = $27::text[],
                exclusion_criteria = $28::text[], purchase_timeline = $29, expires_at = $30::date,
                intent_type = $31, auto_match_enabled = $32, status = $33,
                matching_status = $33, desired_location = concat_ws(', ', $18, $19, $17),
                version = version + 1, broker_operations_managed = true, updated_at = now()
              where workspace_id = $1::uuid and id = $34::uuid and version = $35
              returning ${searchProfileReturningSql}
            `,
            [...params, existing.id, Number(existing.version)],
          )
        : await transaction.queryOne<SearchProfileRow>(
            `
              insert into buyer_search_profiles (
                workspace_id, project_id, buyer_lead_id, contact_id, organization_id, owner_user_id,
                title, budget_from_cents, budget_to_cents, financing_status, property_type,
                sub_object_type, area_from_sqm, area_to_sqm, rooms_from, rooms_to, area_sqm, rooms,
                region, municipality, postal_code, radius_km, year_built_from, year_built_to,
                equipment, accessibility, target_yield_basis_points, must_have_criteria,
                nice_to_have_criteria, exclusion_criteria, purchase_timeline, expires_at, intent_type,
                auto_match_enabled, status, matching_status, desired_location,
                broker_operations_managed
              ) values (
                $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7,
                $8::bigint, $9::bigint, $10, $11, $12, $13::numeric, $14::numeric,
                $15::numeric, $16::numeric, $13::numeric, $15::numeric, $17, $18, $19,
                $20::numeric, $21, $22, $23::text[], $24, $25, $26::text[], $27::text[],
                $28::text[], $29, $30::date, $31, $32, $33, $33,
                concat_ws(', ', $18, $19, $17), true
              ) returning ${searchProfileReturningSql}
            `,
            params,
          );
      if (!row) throw new BrokerDomainError("version_conflict", "Search profile changed concurrently.", 409);
      const saved = toSearchProfile(row);
      await writeAuditLog({
        action: existing?.status === "expired" && profile.status === "active"
          ? "broker.search_profile.renewed"
          : existing ? "broker.search_profile.updated" : "broker.search_profile.created",
        after: existing?.status === "expired" && profile.status === "active"
          ? { profile: saved, renewalReason: optionalString(input.payload.renewalReason, 1_000) }
          : saved,
        before: existing ? toSearchProfile(existing) : null,
        entityId: row.id,
        entityType: "buyer_search_profile",
        projectId: profile.projectId,
        session: input.session,
        transaction,
      });
      return { data: saved, entityId: row.id, httpStatus: existing ? 200 : 201 };
    },
  });
}

type CandidateRow = {
  accessibility: boolean | null;
  activeReservationContactId: string | null;
  areaSqm: number | string | null;
  equipment: unknown;
  id: string;
  intentType: string | null;
  municipality: string | null;
  objectType: string | null;
  postalCode: string | null;
  priceMinor: number | string | null;
  region: string | null;
  rooms: number | string | null;
  searchableText: string;
  status: string;
  subObjectType: string | null;
  targetKind: "listing" | "unit";
  yearBuilt: number | string | null;
  yieldPercent: number | string | null;
};

function equipmentFromDb(value: unknown) {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  if (value && typeof value === "object") {
    return Object.entries(value as JsonObject).filter(([, enabled]) => Boolean(enabled)).map(([key]) => key);
  }
  return [];
}

function availabilityFromCandidate(row: CandidateRow, profileContactId: string | null): MatchCandidate["availability"] {
  if (row.status === "sold") return "sold";
  if (row.status === "blocked") return "blocked";
  if (row.status === "reserved" || row.activeReservationContactId) {
    return profileContactId && row.activeReservationContactId === profileContactId ? "reserved_same" : "reserved_other";
  }
  return "available";
}

function toMatchCandidate(row: CandidateRow, profileContactId: string | null): MatchCandidate {
  return {
    accessibility: row.accessibility,
    areaSqm: numberFromDb(row.areaSqm),
    availability: availabilityFromCandidate(row, profileContactId),
    equipment: equipmentFromDb(row.equipment),
    id: row.id,
    intentType: row.intentType,
    municipality: row.municipality,
    objectType: row.objectType,
    postalCode: row.postalCode,
    priceMinor: row.priceMinor === null ? null : BigInt(row.priceMinor),
    region: row.region,
    rooms: numberFromDb(row.rooms),
    searchableText: row.searchableText,
    subObjectType: row.subObjectType,
    targetKind: row.targetKind,
    yieldBasisPoints: row.yieldPercent === null ? null : Math.round(Number(row.yieldPercent) * 100),
    yearBuilt: numberFromDb(row.yearBuilt),
  };
}

function toMatchingProfile(row: SearchProfileRow): SearchProfileForMatching {
  return {
    accessibility: row.accessibility,
    areaFromSqm: numberFromDb(row.areaFromSqm),
    areaToSqm: numberFromDb(row.areaToSqm),
    budgetFromMinor: row.budgetFromMinor === null ? null : BigInt(row.budgetFromMinor),
    budgetToMinor: row.budgetToMinor === null ? null : BigInt(row.budgetToMinor),
    desiredLocation: row.desiredLocation,
    equipment: row.equipment ?? [],
    exclusionCriteria: row.exclusionCriteria ?? [],
    id: row.id,
    intentType: row.intentType,
    municipality: row.municipality,
    mustHaveCriteria: row.mustHaveCriteria ?? [],
    niceToHaveCriteria: row.niceToHaveCriteria ?? [],
    objectType: row.propertyType,
    postalCode: row.postalCode,
    radiusKm: numberFromDb(row.radiusKm),
    region: row.region,
    roomsFrom: numberFromDb(row.roomsFrom),
    roomsTo: numberFromDb(row.roomsTo),
    subObjectType: row.subObjectType,
    targetYieldBasisPoints: numberFromDb(row.targetYieldBasisPoints),
    yearBuiltFrom: numberFromDb(row.yearBuiltFrom),
    yearBuiltTo: numberFromDb(row.yearBuiltTo),
  };
}

async function loadCandidateRows(
  transaction: TenantTransaction,
  input: { limit: number; profile: SearchProfileRow; session: AppSession },
) {
  if (!input.profile.projectId) throw new BrokerDomainError("project_required", "Profile must belong to a project.");
  return transaction.query<CandidateRow>(
    `
      with candidates as (
        select
          sl.id,
          'listing'::text as "targetKind",
          sl.object_type as "objectType",
          sl.sub_object_type as "subObjectType",
          case when $3 = 'rent'
            then coalesce(nullif(sl.rent_price_cents, 0), nullif(sl.public_price_cents, 0), nullif(sl.target_price_cents, 0))
            else coalesce(nullif(sl.public_price_cents, 0), nullif(sl.target_price_cents, 0), nullif(sl.market_value_cents, 0))
          end as "priceMinor",
          sl.area_sqm as "areaSqm",
          sl.rooms,
          sl.region,
          sl.city as municipality,
          sl.postal_code as "postalCode",
          sl.year_built as "yearBuilt",
          sl.expected_gross_yield as "yieldPercent",
          sl.equipment,
          concat_ws(' ', sl.title, sl.address, sl.orientation, sl.furnishing, sl.noise_level,
            sl.condition_label, sl.equipment::text) as "searchableText",
          sl.is_accessible as accessibility,
          sl.marketing_type as "intentType",
          case
            when target_unit.status = 'sold' then 'sold'
            when target_unit.status = 'blocked' then 'blocked'
            when active_reservation.contact_id is not null then 'reserved'
            when sl.property_status in ('ready', 'published') then 'available'
            else 'blocked'
          end as status,
          active_reservation.contact_id as "activeReservationContactId"
        from seller_listings sl
        left join property_units target_unit
          on target_unit.workspace_id = sl.workspace_id
         and target_unit.project_id = sl.project_id
         and target_unit.id = sl.unit_id
        left join lateral (
          select pr.contact_id
          from property_reservations pr
          where pr.workspace_id = sl.workspace_id
            and pr.project_id = sl.project_id
            and pr.status in ('hold', 'reserved')
            and pr.expires_at > now()
            and sl.unit_id is not null
            and pr.unit_id = sl.unit_id
          order by pr.created_at desc
          limit 1
        ) active_reservation on true
        where sl.workspace_id = $1::uuid and sl.project_id = $2::uuid

        union all

        select
          pu.id,
          'unit'::text as "targetKind",
          listing.object_type as "objectType",
          listing.sub_object_type as "subObjectType",
          case when $3 = 'rent'
            then coalesce(nullif(listing.rent_price_cents, 0), nullif(pu.price_cents, 0))
            else coalesce(nullif(pu.price_cents, 0), nullif(listing.public_price_cents, 0), nullif(listing.target_price_cents, 0))
          end as "priceMinor",
          pu.area_sqm as "areaSqm",
          pu.rooms,
          listing.region,
          listing.city as municipality,
          listing.postal_code as "postalCode",
          listing.year_built as "yearBuilt",
          listing.expected_gross_yield as "yieldPercent",
          listing.equipment,
          concat_ws(' ', listing.title, listing.address, listing.orientation, listing.furnishing,
            listing.noise_level, listing.condition_label, listing.equipment::text, pu.metadata::text)
            as "searchableText",
          listing.is_accessible as accessibility,
          listing.marketing_type as "intentType",
          case
            when pu.status in ('sold', 'blocked') then pu.status
            when active_reservation.contact_id is not null then 'reserved'
            else 'available'
          end as status,
          active_reservation.contact_id as "activeReservationContactId"
        from property_units pu
        left join lateral (
          select sl.*
          from seller_listings sl
          where sl.workspace_id = pu.workspace_id
            and sl.project_id = pu.project_id
            and sl.unit_id = pu.id
          order by sl.updated_at desc
          limit 1
        ) listing on true
        left join lateral (
          select pr.contact_id
          from property_reservations pr
          where pr.workspace_id = pu.workspace_id and pr.unit_id = pu.id
            and pr.status in ('hold', 'reserved')
            and pr.expires_at > now()
          order by pr.created_at desc
          limit 1
        ) active_reservation on true
        where pu.workspace_id = $1::uuid and pu.project_id = $2::uuid
          and coalesce(pu.metadata->>'hidden', 'false') <> 'true'
      )
      select * from candidates
      order by "targetKind", id
      limit $4
    `,
    [input.session.workspaceId, input.profile.projectId, input.profile.intentType, input.limit],
  );
}

type MatchDecisionRow = {
  id: string;
  reason: string | null;
  sellerListingId: string | null;
  status: string;
  unitId: string | null;
  version: number | string;
};

async function loadMatchDecisionMap(
  transaction: TenantTransaction,
  workspaceId: string,
  profileId: string,
  candidates: readonly CandidateRow[],
) {
  if (candidates.length === 0) return new Map<string, { id: string; reason: string | null; status: string; version: number }>();
  const listingIds = candidates.filter((row) => row.targetKind === "listing").map((row) => row.id);
  const unitIds = candidates.filter((row) => row.targetKind === "unit").map((row) => row.id);
  const rows = await transaction.query<MatchDecisionRow>(
    `
      select id, seller_listing_id as "sellerListingId", unit_id as "unitId", status, reason, version
      from buyer_match_decisions
      where workspace_id = $1::uuid and search_profile_id = $2::uuid
        and (seller_listing_id = any($3::uuid[]) or unit_id = any($4::uuid[]))
    `,
    [workspaceId, profileId, listingIds, unitIds],
  );
  return new Map(rows.map((row) => [`${row.sellerListingId ? "listing" : "unit"}:${row.sellerListingId ?? row.unitId}`, {
    id: row.id,
    reason: row.reason,
    status: row.status,
    version: Number(row.version),
  }]));
}

async function loadMatchEngagementMap(
  transaction: TenantTransaction,
  workspaceId: string,
  profile: SearchProfileRow,
  candidates: readonly CandidateRow[],
) {
  const engagement = new Map<string, { offered: boolean; viewed: boolean }>();
  if (candidates.length === 0 || !profile.projectId || !profile.contactId) return engagement;
  const listingIds = candidates.filter((row) => row.targetKind === "listing").map((row) => row.id);
  const unitIds = candidates.filter((row) => row.targetKind === "unit").map((row) => row.id);
  const rows = await transaction.query<{
    offered: boolean;
    targetId: string;
    targetKind: "listing" | "unit";
    viewed: boolean;
  }>(
    `
      with targets as (
        select 'listing'::text as target_kind, unnest($4::uuid[]) as target_id
        union all
        select 'unit'::text, unnest($5::uuid[])
      )
      select targets.target_kind as "targetKind", targets.target_id as "targetId",
        exists (
          select 1
          from broker_offer_items item
          join broker_offers offer
            on offer.workspace_id = item.workspace_id and offer.id = item.offer_id
          where item.workspace_id = $1::uuid and item.project_id = $2::uuid
            and offer.contact_id = $3::uuid and offer.status <> 'withdrawn'
            and exists (
              select 1 from broker_offer_deliveries delivery
              where delivery.workspace_id = offer.workspace_id and delivery.offer_id = offer.id
                and delivery.status = 'accepted' and delivery.provider_receipt_id is not null
                and delivery.accepted_at is not null
            )
            and ((targets.target_kind = 'listing' and item.seller_listing_id = targets.target_id)
              or (targets.target_kind = 'unit' and item.unit_id = targets.target_id))
        ) as offered,
        exists (
          select 1
          from property_viewing_slots viewing
          where viewing.workspace_id = $1::uuid and viewing.project_id = $2::uuid
            and viewing.contact_id = $3::uuid and viewing.status = 'completed'
            and ((targets.target_kind = 'listing' and viewing.property_id = targets.target_id)
              or (targets.target_kind = 'unit' and viewing.unit_id = targets.target_id))
        ) as viewed
      from targets
    `,
    [workspaceId, profile.projectId, profile.contactId, listingIds, unitIds],
  );
  for (const row of rows) engagement.set(`${row.targetKind}:${row.targetId}`, { offered: row.offered, viewed: row.viewed });
  return engagement;
}

const maximumMatchingCandidates = 2_000;

async function calculateMatches(
  transaction: TenantTransaction,
  input: { pagination: Pagination; profileId: string; projectId: string; session: AppSession },
) {
  const profileRow = await transaction.queryOne<SearchProfileRow>(
    `select ${searchProfileReturningSql} from buyer_search_profiles where workspace_id = $1::uuid and id = $2::uuid for share`,
    [input.session.workspaceId, input.profileId],
  );
  if (!profileRow) throw new BrokerDomainError("profile_not_found", "Search profile was not found.", 404);
  await assertBrokerRecordAccess({
    existingOwnerUserId: profileRow.ownerUserId,
    projectId: profileRow.projectId,
    session: input.session,
    transaction,
  });
  if (!profileRow.projectId) {
    throw new BrokerDomainError("project_required", "Profile must belong to a project.");
  }
  await assertBrokerProjectEditAccess({
    projectId: profileRow.projectId,
    session: input.session,
    transaction,
  });
  if (profileRow.projectId !== input.projectId) {
    throw new BrokerDomainError("project_scope_mismatch", "Search profile belongs to a different project.", 400);
  }
  const expiryDate = profileRow.expiresAt ? new Date(profileRow.expiresAt).toISOString().slice(0, 10) : null;
  if (profileRow.status !== "active" || (expiryDate && new Date(`${expiryDate}T23:59:59.999Z`).getTime() < Date.now())) {
    throw new BrokerDomainError("profile_not_active", "Only an active, unexpired search profile can be matched.", 409);
  }
  const candidateRows = await loadCandidateRows(transaction, {
    limit: maximumMatchingCandidates + 1,
    profile: profileRow,
    session: input.session,
  });
  if (candidateRows.length > maximumMatchingCandidates) {
    throw new BrokerDomainError(
      "matching_candidate_limit_exceeded",
      "The project contains too many matching candidates; narrow the inventory before recalculating.",
      409,
      { maximumMatchingCandidates },
    );
  }
  const [decisions, engagement] = await Promise.all([
    loadMatchDecisionMap(transaction, input.session.workspaceId, profileRow.id, candidateRows),
    loadMatchEngagementMap(transaction, input.session.workspaceId, profileRow, candidateRows),
  ]);
  const profile = toMatchingProfile(profileRow);
  const evaluatedAll = candidateRows.map((row) => {
    const candidate = toMatchCandidate(row, profileRow.contactId);
    const evaluation = evaluateBrokerMatch(profile, candidate);
    const engagementState = engagement.get(`${candidate.targetKind}:${candidate.id}`) ?? { offered: false, viewed: false };
    return {
      candidateRow: row,
      match: {
        ...evaluation,
        decision: decisions.get(`${candidate.targetKind}:${candidate.id}`) ?? { id: null, reason: null, status: "new", version: 0 },
        offered: engagementState.offered,
        viewed: engagementState.viewed,
      },
    };
  }).sort((left, right) => {
    if (left.match.eligible !== right.match.eligible) return left.match.eligible ? -1 : 1;
    if (left.match.score !== right.match.score) return right.match.score - left.match.score;
    const kindComparison = left.match.targetKind.localeCompare(right.match.targetKind);
    return kindComparison || left.match.targetId.localeCompare(right.match.targetId);
  });
  const evaluated = evaluatedAll.slice(input.pagination.offset, input.pagination.offset + input.pagination.limit);
  return {
    candidateRows: evaluated.map((row) => row.candidateRow),
    hasMore: input.pagination.offset + evaluated.length < evaluatedAll.length,
    matches: evaluated.map((row) => row.match),
    profile,
    profileRow,
  };
}

export async function listLiveBrokerMatches(input: {
  pagination: Pagination;
  profileId: string;
  projectId: string;
  session: AppSession;
}) {
  assertPersistence(input.session);
  const profileId = requiredUuid(input.profileId, "profileId");
  const projectId = requiredUuid(input.projectId, "projectId");
  return withTenantTransaction({
    actorId: input.session.userId,
    workspaceId: input.session.workspaceId,
  }, async (transaction) => {
    const calculated = await calculateMatches(transaction, { ...input, profileId, projectId });
    return {
      algorithmVersion: brokerMatchingAlgorithmVersion,
      items: calculated.matches,
      pagination: { hasMore: calculated.hasMore, limit: input.pagination.limit, offset: input.pagination.offset },
      recalculatedAt: new Date().toISOString(),
      source: "server_live_evaluation",
    };
  });
}

export async function persistBrokerMatchEvaluation(input: {
  idempotencyKey: string;
  pagination: Pagination;
  profileId: string;
  projectId: string;
  session: AppSession;
}) {
  const profileId = requiredUuid(input.profileId, "profileId");
  const projectId = requiredUuid(input.projectId, "projectId");
  return withIdempotentMutation({
    entityType: "buyer_match_evaluation",
    idempotencyKey: input.idempotencyKey,
    operationType: "broker.matches.recalculate",
    payload: { pagination: input.pagination, profileId, projectId },
    session: input.session,
    write: async (transaction) => {
      const calculated = await calculateMatches(transaction, { ...input, profileId, projectId });
      const criteriaHash = sha256(calculated.profile);
      const persistedIds: string[] = [];
      for (let index = 0; index < calculated.matches.length; index += 1) {
        const match = calculated.matches[index];
        const candidate = calculated.candidateRows[index];
        const objectHash = sha256(candidate);
        const params = [
          input.session.workspaceId,
          calculated.profileRow.projectId,
          profileId,
          match.targetKind,
          match.targetKind === "listing" ? match.targetId : null,
          match.targetKind === "unit" ? match.targetId : null,
          brokerMatchingAlgorithmVersion,
          criteriaHash,
          objectHash,
          match.score,
          match.eligible,
          match.availability,
          JSON.stringify(match.matchedCriteria),
          JSON.stringify(match.violatedCriteria),
        ];
        const row = await transaction.queryOne<{ id: string }>(
          match.targetKind === "listing"
            ? `
                insert into buyer_match_evaluations (
                  workspace_id, project_id, search_profile_id, target_kind, seller_listing_id, unit_id,
                  algorithm_version, criteria_hash, object_hash, score, eligible, availability,
                  matched_criteria, violated_criteria
                ) values ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6::uuid, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb)
                on conflict (workspace_id, search_profile_id, seller_listing_id, algorithm_version, criteria_hash, object_hash)
                  where seller_listing_id is not null
                do update set evaluated_at = now(), score = excluded.score, eligible = excluded.eligible,
                  availability = excluded.availability, matched_criteria = excluded.matched_criteria,
                  violated_criteria = excluded.violated_criteria
                returning id
              `
            : `
                insert into buyer_match_evaluations (
                  workspace_id, project_id, search_profile_id, target_kind, seller_listing_id, unit_id,
                  algorithm_version, criteria_hash, object_hash, score, eligible, availability,
                  matched_criteria, violated_criteria
                ) values ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6::uuid, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb)
                on conflict (workspace_id, search_profile_id, unit_id, algorithm_version, criteria_hash, object_hash)
                  where unit_id is not null
                do update set evaluated_at = now(), score = excluded.score, eligible = excluded.eligible,
                  availability = excluded.availability, matched_criteria = excluded.matched_criteria,
                  violated_criteria = excluded.violated_criteria
                returning id
              `,
          params,
        );
        if (!row) throw new BrokerDomainError("match_persistence_failed", "Match evaluation could not be persisted.", 503);
        persistedIds.push(row.id);
      }
      await writeAuditLog({
        action: "broker.matches.recalculated",
        after: { algorithmVersion: brokerMatchingAlgorithmVersion, count: persistedIds.length, criteriaHash },
        before: null,
        entityId: profileId,
        entityType: "buyer_search_profile",
        projectId: calculated.profileRow.projectId,
        session: input.session,
        transaction,
      });
      return {
        data: {
          algorithmVersion: brokerMatchingAlgorithmVersion,
          evaluationIds: persistedIds,
          items: calculated.matches,
          recalculatedAt: new Date().toISOString(),
        },
        entityId: profileId,
      };
    },
  });
}

export async function saveBrokerMatchDecision(input: {
  idempotencyKey: string;
  payload: JsonObject;
  session: AppSession;
}) {
  const profileId = requiredUuid(input.payload.profileId, "profileId");
  const projectId = requiredUuid(input.payload.projectId, "projectId");
  const targetKind = enumValue(input.payload.targetKind, "targetKind", ["listing", "unit"] as const);
  const targetId = requiredUuid(input.payload.targetId, "targetId");
  const desiredStatus = enumValue(input.payload.status, "status", matchDecisionStatuses);
  return withIdempotentMutation({
    entityType: "buyer_match_decision",
    idempotencyKey: input.idempotencyKey,
    operationType: "broker.match_decision.save",
    payload: input.payload,
    session: input.session,
    write: async (transaction) => {
      const profile = await transaction.queryOne<{ id: string; ownerUserId: string | null; projectId: string | null }>(
        `select id, owner_user_id as "ownerUserId", project_id as "projectId" from buyer_search_profiles where workspace_id = $1::uuid and id = $2::uuid for share`,
        [input.session.workspaceId, profileId],
      );
      if (!profile?.projectId) throw new BrokerDomainError("profile_not_found", "Project-scoped profile was not found.", 404);
      await assertBrokerRecordAccess({
        existingOwnerUserId: profile.ownerUserId,
        projectId: profile.projectId,
        session: input.session,
        transaction,
      });
      await assertBrokerProjectEditAccess({
        projectId: profile.projectId,
        session: input.session,
        transaction,
      });
      if (profile.projectId !== projectId) {
        throw new BrokerDomainError("project_scope_mismatch", "Search profile belongs to a different project.", 400);
      }
      await assertReference(transaction, input.session, targetKind, targetId, profile.projectId);
      const existing = await transaction.queryOne<MatchDecisionRow>(
        `
          select id, seller_listing_id as "sellerListingId", unit_id as "unitId", status, reason, version
          from buyer_match_decisions
          where workspace_id = $1::uuid and search_profile_id = $2::uuid
            and (($3 = 'listing' and seller_listing_id = $4::uuid) or ($3 = 'unit' and unit_id = $4::uuid))
          for update
        `,
        [input.session.workspaceId, profileId, targetKind, targetId],
      );
      if (existing) {
        if (Number(existing.version) !== expectedVersion(input.payload.expectedVersion)) {
          throw new BrokerDomainError("version_conflict", "Match decision changed since it was loaded.", 409);
        }
        assertTransition(matchDecisionTransitions, existing.status as (typeof matchDecisionStatuses)[number], desiredStatus, "match decision");
      } else {
        assertInitialState(desiredStatus, "new", "match decision");
      }
      const reason = optionalString(input.payload.reason ?? existing?.reason, 1_000);
      if (["declined", "archived"].includes(desiredStatus) && !reason) {
        throw new BrokerDomainError("match_decision_reason_required", "Declined or archived matches require a reason.");
      }
      const row = existing
        ? await transaction.queryOne<MatchDecisionRow>(
            `
              update buyer_match_decisions
              set status = $4, reason = $5, updated_by_user_id = $6::uuid,
                  version = version + 1, updated_at = now()
              where workspace_id = $1::uuid and id = $2::uuid and version = $3
              returning id, seller_listing_id as "sellerListingId", unit_id as "unitId", status, reason, version
            `,
            [input.session.workspaceId, existing.id, Number(existing.version), desiredStatus, reason, input.session.userId],
          )
        : await transaction.queryOne<MatchDecisionRow>(
            `
              insert into buyer_match_decisions (
                workspace_id, project_id, search_profile_id, target_kind, seller_listing_id, unit_id,
                status, reason, created_by_user_id, updated_by_user_id
              ) values ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6::uuid, $7, $8, $9::uuid, $9::uuid)
              returning id, seller_listing_id as "sellerListingId", unit_id as "unitId", status, reason, version
            `,
            [
              input.session.workspaceId,
              profile.projectId,
              profileId,
              targetKind,
              targetKind === "listing" ? targetId : null,
              targetKind === "unit" ? targetId : null,
              desiredStatus,
              reason,
              input.session.userId,
            ],
          );
      if (!row) throw new BrokerDomainError("version_conflict", "Match decision changed concurrently.", 409);
      const saved = {
        id: row.id,
        profileId,
        reason: row.reason,
        status: row.status,
        targetId,
        targetKind,
        version: Number(row.version),
      };
      await writeAuditLog({
        action: existing ? "broker.match_decision.updated" : "broker.match_decision.created",
        after: saved,
        before: existing,
        entityId: row.id,
        entityType: "buyer_match_decision",
        projectId: profile.projectId,
        session: input.session,
        transaction,
      });
      return { data: saved, entityId: row.id, httpStatus: existing ? 200 : 201 };
    },
  });
}

type OfferRow = {
  addressVisibility: string;
  bodyText: string;
  commissionNotice: string;
  contactId: string;
  copyOwner: boolean;
  createdAt: string | Date;
  currentVersion: number | string;
  dealId: string | null;
  id: string;
  leadId: string | null;
  ownerUserId: string | null;
  priceReleased: boolean;
  projectId: string;
  recipientEmail: string;
  status: string;
  subject: string;
  templateKey: string | null;
  updatedAt: string | Date;
  version: number | string;
  workspaceId: string;
};

type OfferItemRow = {
  displayAddress: string;
  id: string;
  pdfDocumentId: string | null;
  position: number;
  priceMinor: number | string | null;
  priceReleased: boolean;
  selectedDocumentIds: string[] | null;
  selectedMediaIds: string[] | null;
  sellerListingId: string | null;
  targetKind: "listing" | "unit";
  unitId: string | null;
  webOfferUrl: string | null;
};

type ApprovedOfferTemplate = Readonly<{
  body: string;
  id: string;
  key: string;
  language: string;
  name: string;
  subject: string;
  versionNumber: number;
}>;

const offerTemplateReferencePattern = /^content-template:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):v([1-9][0-9]*)$/i;

function parseOfferTemplateReference(value: string): { id: string; versionNumber: number } {
  const match = offerTemplateReferencePattern.exec(value);
  const versionNumber = Number(match?.[2] ?? 0);
  if (!match || !Number.isSafeInteger(versionNumber)) {
    throw new BrokerDomainError(
      "invalid_offer_template_reference",
      "templateKey must reference an approved content template and exact version.",
    );
  }
  return { id: match[1].toLowerCase(), versionNumber };
}

async function requireApprovedOfferTemplate(input: {
  projectId: string;
  session: AppSession;
  templateKey: string | null;
  transaction: TenantTransaction;
}) {
  if (!input.templateKey) {
    throw new BrokerDomainError(
      "approved_offer_template_required",
      "A ready offer requires an approved central communication template.",
      409,
    );
  }
  const reference = parseOfferTemplateReference(input.templateKey);
  const template = await input.transaction.queryOne<{
    body: string;
    id: string;
    language: string;
    name: string;
    subject: string;
    versionNumber: number | string;
  }>(
    `
      select template.id, template.name, version.version_number as "versionNumber",
             version.language, version.subject, version.body
        from crm_communication_templates template
        join crm_communication_template_versions version
          on version.workspace_id = template.workspace_id
         and version.template_id = template.id
         and version.version_number = $4
        join workspace_users template_actor
          on template_actor.workspace_id = template.workspace_id
         and template_actor.id = $2::uuid
         and template_actor.status = 'active'
         and template_actor.product_role not in ('external_partner', 'viewer')
       where template.workspace_id = $1::uuid
         and template.id = $3::uuid
         and template.channel = 'email'
         and template.approval_status = 'approved'
         and template.archived_at is null
         and template.current_version_number = $4
         and (template.project_id is null or template.project_id = $5::uuid)
         and ${communicationTemplateReadAccessSql("template", "$2", "$6")}
       for share of template, version, template_actor
    `,
    [
      input.session.workspaceId,
      input.session.userId,
      reference.id,
      reference.versionNumber,
      input.projectId,
      canManageContent(input.session),
    ],
  );
  if (!template) {
    throw new BrokerDomainError(
      "offer_template_not_released",
      "The selected template is no longer approved, current, or available in this project scope.",
      409,
    );
  }
  return {
    ...template,
    key: input.templateKey,
    versionNumber: Number(template.versionNumber),
  } satisfies ApprovedOfferTemplate;
}

const offerReturningSql = `
  id, workspace_id as "workspaceId", project_id as "projectId", contact_id as "contactId",
  lead_id as "leadId", deal_id as "dealId", owner_user_id as "ownerUserId",
  template_key as "templateKey", recipient_email as "recipientEmail", subject,
  body_text as "bodyText", address_visibility as "addressVisibility",
  price_released as "priceReleased", commission_notice as "commissionNotice",
  copy_owner as "copyOwner", status, current_version as "currentVersion", version,
  created_at as "createdAt", updated_at as "updatedAt"
`;

const offerItemReturningSql = `
  id, position, target_kind as "targetKind", seller_listing_id as "sellerListingId",
  unit_id as "unitId", display_address as "displayAddress", price_minor as "priceMinor",
  price_released as "priceReleased", selected_media_ids as "selectedMediaIds",
  selected_document_ids as "selectedDocumentIds", web_offer_url as "webOfferUrl",
  pdf_document_id as "pdfDocumentId"
`;

function toOffer(row: OfferRow, items: OfferItemRow[] = [], deliveries: unknown[] = []) {
  return {
    addressVisibility: row.addressVisibility,
    bodyText: row.bodyText,
    commissionNotice: row.commissionNotice,
    contactId: row.contactId,
    copyOwner: row.copyOwner,
    createdAt: new Date(row.createdAt).toISOString(),
    currentVersion: Number(row.currentVersion),
    dealId: row.dealId,
    deliveries,
    id: row.id,
    items: items.map((item) => ({
      ...item,
      priceMinor: stringFromDb(item.priceMinor),
      selectedDocumentIds: item.selectedDocumentIds ?? [],
      selectedMediaIds: item.selectedMediaIds ?? [],
      targetId: item.sellerListingId ?? item.unitId,
    })),
    leadId: row.leadId,
    ownerUserId: row.ownerUserId,
    priceReleased: row.priceReleased,
    projectId: row.projectId,
    recipientEmail: row.recipientEmail,
    status: row.status,
    subject: row.subject,
    templateKey: row.templateKey,
    updatedAt: new Date(row.updatedAt).toISOString(),
    version: Number(row.version),
    workspaceId: row.workspaceId,
  };
}

async function loadOfferItems(transaction: TenantTransaction, workspaceId: string, offerIds: readonly string[]) {
  if (offerIds.length === 0) return new Map<string, OfferItemRow[]>();
  const rows = await transaction.query<OfferItemRow & { offerId: string }>(
    `
      select offer_id as "offerId", ${offerItemReturningSql}
      from broker_offer_items
      where workspace_id = $1::uuid and offer_id = any($2::uuid[])
      order by offer_id, position
    `,
    [workspaceId, offerIds],
  );
  const grouped = new Map<string, OfferItemRow[]>();
  for (const row of rows) {
    const bucket = grouped.get(row.offerId) ?? [];
    bucket.push(row);
    grouped.set(row.offerId, bucket);
  }
  return grouped;
}

async function loadOfferDeliveries(transaction: TenantTransaction, workspaceId: string, offerIds: readonly string[]) {
  if (offerIds.length === 0) return new Map<string, unknown[]>();
  const rows = await transaction.query<{
    attemptedAt: string | Date;
    failureCode: string | null;
    id: string;
    offerId: string;
    offerVersion: number;
    providerMessage: string | null;
    recipientEmail: string;
    status: string;
  }>(
    `
      select delivery.id, requested.offer_id as "offerId", delivery.offer_version as "offerVersion",
        delivery.recipient_email as "recipientEmail", delivery.status,
        delivery.failure_code as "failureCode", delivery.provider_message as "providerMessage",
        delivery.attempted_at as "attemptedAt"
      from unnest($2::uuid[]) as requested(offer_id)
      cross join lateral (
        select candidate.*
        from broker_offer_deliveries candidate
        where candidate.workspace_id = $1::uuid and candidate.offer_id = requested.offer_id
        order by candidate.attempted_at desc, candidate.id
        limit 10
      ) delivery
      order by requested.offer_id, delivery.attempted_at desc, delivery.id
    `,
    [workspaceId, offerIds],
  );
  const grouped = new Map<string, unknown[]>();
  for (const row of rows) {
    const bucket = grouped.get(row.offerId) ?? [];
    if (bucket.length < 10) bucket.push({ ...row, attemptedAt: new Date(row.attemptedAt).toISOString() });
    grouped.set(row.offerId, bucket);
  }
  return grouped;
}

export async function listBrokerOffers(input: {
  contactId?: string | null;
  leadId?: string | null;
  pagination: Pagination;
  projectId?: string | null;
  session: AppSession;
  status?: string | null;
}) {
  assertPersistence(input.session);
  const projectId = input.projectId ? requiredUuid(input.projectId, "projectId") : null;
  const contactId = input.contactId ? requiredUuid(input.contactId, "contactId") : null;
  const leadId = input.leadId ? requiredUuid(input.leadId, "leadId") : null;
  const status = input.status ? enumValue(input.status, "status", offerStatuses) : null;
  return withTenantTransaction({
    actorId: input.session.userId,
    workspaceId: input.session.workspaceId,
  }, async (transaction) => {
    const rows = await transaction.query<OfferRow & { totalCount: number | string }>(
      `
        select ${offerReturningSql}, count(*) over() as "totalCount"
        from broker_offers
        where workspace_id = $1::uuid
          and ($2::uuid is null or project_id = $2::uuid)
          and ($3::uuid is null or contact_id = $3::uuid)
          and ($4::uuid is null or lead_id = $4::uuid)
          and ($5::text is null or status = $5)
          and (
            $8::boolean or owner_user_id = $9::uuid
            or ($10::boolean and exists (
              select 1 from project_pipeline_permissions permission
              where permission.workspace_id = broker_offers.workspace_id
                and permission.project_id = broker_offers.project_id
                and permission.user_id = $9::uuid and permission.can_edit_deals = true
            ))
          )
        order by updated_at desc, id
        limit $6 offset $7
      `,
      [input.session.workspaceId, projectId, contactId, leadId, status, input.pagination.limit, input.pagination.offset,
        canViewAllWorkspaceContacts(input.session), input.session.userId,
        canUseBrokerProjectEditScope(input.session)],
    );
    const ids = rows.map((row) => row.id);
    const [items, deliveries] = await Promise.all([
      loadOfferItems(transaction, input.session.workspaceId, ids),
      loadOfferDeliveries(transaction, input.session.workspaceId, ids),
    ]);
    const total = Number(rows[0]?.totalCount ?? 0);
    return {
      items: rows.map((row) => toOffer(row, items.get(row.id), deliveries.get(row.id))),
      pagination: {
        hasMore: input.pagination.offset + rows.length < total,
        limit: input.pagination.limit,
        offset: input.pagination.offset,
        total,
      },
    };
  });
}

function normalizeEmail(value: unknown) {
  const email = requiredString(value, "recipientEmail", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw new BrokerDomainError("invalid_email", "recipientEmail must be a valid email address.");
  }
  return email;
}

function optionalHttpsUrl(value: unknown, field: string) {
  const normalized = optionalString(value, 2_000);
  if (!normalized) return null;
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new BrokerDomainError("invalid_url", `${field} must be a valid HTTPS URL.`);
  }
  if (url.protocol !== "https:") throw new BrokerDomainError("invalid_url", `${field} must use HTTPS.`);
  return url.toString();
}

type NormalizedOfferItem = {
  displayAddress: string;
  pdfDocumentId: string | null;
  position: number;
  priceMinor: string | null;
  priceReleased: boolean;
  selectedDocumentIds: string[];
  selectedMediaIds: string[];
  targetId: string;
  targetKind: "listing" | "unit";
  webOfferUrl: string | null;
};

function normalizeOfferItems(value: unknown): NormalizedOfferItem[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
    throw new BrokerDomainError("invalid_offer_items", "items must contain 1-50 concrete listings or units.");
  }
  return value.map((entry, position) => {
    const item = asRecord(entry, `items[${position}]`);
    return {
      displayAddress: cleanString(item.displayAddress, 500),
      pdfDocumentId: optionalUuid(item.pdfDocumentId, `items[${position}].pdfDocumentId`),
      position,
      priceMinor: optionalMinor(item.priceMinor, `items[${position}].priceMinor`),
      priceReleased: booleanValue(item.priceReleased, false),
      selectedDocumentIds: uuidList(item.selectedDocumentIds, `items[${position}].selectedDocumentIds`, 100),
      selectedMediaIds: uuidList(item.selectedMediaIds, `items[${position}].selectedMediaIds`, 100),
      targetId: requiredUuid(item.targetId, `items[${position}].targetId`),
      targetKind: enumValue(item.targetKind, `items[${position}].targetKind`, ["listing", "unit"] as const),
      webOfferUrl: optionalHttpsUrl(item.webOfferUrl, `items[${position}].webOfferUrl`),
    };
  });
}

async function validateOfferItem(
  transaction: TenantTransaction,
  session: AppSession,
  projectId: string,
  item: NormalizedOfferItem,
) {
  await assertReference(transaction, session, item.targetKind, item.targetId, projectId);
  if (item.targetKind === "unit" && (item.selectedMediaIds.length > 0 || item.selectedDocumentIds.length > 0 || item.pdfDocumentId)) {
    throw new BrokerDomainError(
      "unit_attachment_requires_listing",
      "Unit offer items cannot reference listing media/documents without a concrete listing target.",
    );
  }
  if (item.targetKind === "listing") {
    if (item.selectedMediaIds.length > 0) {
      const media = await transaction.query<{ id: string }>(
        `select media.id
           from property_media media
           join media_assets asset
             on asset.workspace_id = media.workspace_id::text and asset.id = media.media_asset_id
          where media.workspace_id = $1::uuid
            and media.property_id = $2::uuid
            and media.id = any($3::uuid[])
            and media.visibility in ('public', 'channel')
            and media.status in ('approved', 'published')
            and asset.deletion_state = 'active'
          for share of media, asset`,
        [session.workspaceId, item.targetId, item.selectedMediaIds],
      );
      if (media.length !== item.selectedMediaIds.length) {
        throw new BrokerDomainError(
          "invalid_media_reference",
          "One or more selected media records are not released, active, or inside the listing scope.",
        );
      }
    }
    const propertyDocumentIds = [...item.selectedDocumentIds, ...(item.pdfDocumentId ? [item.pdfDocumentId] : [])];
    if (propertyDocumentIds.length > 0) {
      const releasedPropertyDocuments = await transaction.query<{ id: string }>(
        `select document.id
           from property_documents document
           join media_assets asset
             on asset.workspace_id = document.workspace_id::text and asset.id = document.media_asset_id
          where document.workspace_id = $1::uuid
            and document.property_id = $2::uuid
            and document.id = any($3::uuid[])
            and document.visibility in ('public', 'channel')
            and document.status in ('approved', 'sent')
            and asset.deletion_state = 'active'
          for share of document, asset`,
        [session.workspaceId, item.targetId, propertyDocumentIds],
      );
      const releasedPropertyIds = new Set(releasedPropertyDocuments.map((document) => document.id));
      if (item.pdfDocumentId && !releasedPropertyIds.has(item.pdfDocumentId)) {
        throw new BrokerDomainError(
          "invalid_pdf_document_reference",
          "The selected PDF is not a released, active listing document.",
        );
      }

      const releasedContentDocuments = item.selectedDocumentIds.length === 0
        ? []
        : await transaction.query<{ id: string }>(
            `select document.id
               from crm_content_documents document
               join crm_content_document_versions version
                 on version.workspace_id = document.workspace_id
                and version.document_id = document.id
                and version.version_number = document.current_version_number
               join media_assets asset
                 on asset.workspace_id = document.workspace_id::text and asset.id = version.media_asset_id
               join workspace_users content_actor
                 on content_actor.workspace_id = document.workspace_id
                and content_actor.id = $2::uuid
                and content_actor.status = 'active'
                and content_actor.product_role not in ('external_partner', 'viewer')
              where document.workspace_id = $1::uuid
                and document.id = any($4::uuid[])
                and document.approval_status = 'approved'
                and document.archived_at is null
                and ${contentDocumentReadAccessSql("document", "$2", "$5")}
                and (
                  (document.visibility = 'customer' and document.project_id = $3::uuid)
                  or (
                    document.visibility = 'public'
                    and (document.project_id is null or document.project_id = $3::uuid)
                  )
                )
                and asset.deletion_state = 'active'
              for share of document, version, asset, content_actor`,
            [
              session.workspaceId,
              session.userId,
              projectId,
              item.selectedDocumentIds,
              canManageContent(session),
            ],
          );
      const releasedIds = new Set([
        ...releasedPropertyIds,
        ...releasedContentDocuments.map((document) => document.id),
      ]);
      if (item.selectedDocumentIds.some((documentId) => !releasedIds.has(documentId))) {
        throw new BrokerDomainError(
          "invalid_document_reference",
          "One or more selected documents are not released, visible, active, or inside the offer scope.",
        );
      }
    }
  }
}

export async function saveBrokerOffer(input: {
  idempotencyKey: string;
  payload: JsonObject;
  session: AppSession;
}) {
  const offerId = optionalUuid(input.payload.id, "id");
  return withIdempotentMutation({
    entityType: "broker_offer",
    idempotencyKey: input.idempotencyKey,
    operationType: offerId ? "broker.offer.update" : "broker.offer.create",
    payload: input.payload,
    session: input.session,
    write: async (transaction) => {
      const existing = offerId
        ? await transaction.queryOne<OfferRow>(
            `select ${offerReturningSql} from broker_offers where workspace_id = $1::uuid and id = $2::uuid for update`,
            [input.session.workspaceId, offerId],
          )
        : null;
      if (offerId && !existing) throw new BrokerDomainError("offer_not_found", "Offer was not found.", 404);
      if (existing) {
        await assertBrokerRecordAccess({
          existingOwnerUserId: existing.ownerUserId,
          projectId: existing.projectId,
          session: input.session,
          transaction,
        });
      }
      if (existing && Number(existing.version) !== expectedVersion(input.payload.expectedVersion)) {
        throw new BrokerDomainError("version_conflict", "Offer changed since it was loaded.", 409);
      }
      const existingItems = existing
        ? await transaction.query<OfferItemRow>(
            `select ${offerItemReturningSql} from broker_offer_items where workspace_id = $1::uuid and offer_id = $2::uuid order by position`,
            [input.session.workspaceId, existing.id],
          )
        : [];
      const projectId = requiredUuid(input.payload.projectId ?? existing?.projectId, "projectId");
      const contactId = requiredUuid(input.payload.contactId ?? existing?.contactId, "contactId");
      const leadId = optionalUuid(input.payload.leadId ?? existing?.leadId, "leadId");
      const dealId = optionalUuid(input.payload.dealId ?? existing?.dealId, "dealId");
      const ownerUserId = optionalUuid(
        input.payload.ownerUserId === undefined
          ? existing ? existing.ownerUserId : input.session.userId
          : input.payload.ownerUserId,
        "ownerUserId",
      );
      const status = enumValue(input.payload.status ?? existing?.status, "status", offerStatuses, "draft");
      await assertProject(transaction, input.session, projectId);
      if (!existing || existing.projectId !== projectId) {
        await assertBrokerProjectEditAccess({
          projectId,
          session: input.session,
          transaction,
        });
      }
      await assertBrokerRecordAccess({
        desiredOwnerUserId: ownerUserId,
        existingOwnerUserId: existing?.ownerUserId,
        projectId,
        session: input.session,
        transaction,
      });
      const templateKey = optionalString(
        input.payload.templateKey === undefined ? existing?.templateKey : input.payload.templateKey,
        160,
      );
      if (templateKey || status === "ready") {
        await requireApprovedOfferTemplate({
          projectId,
          session: input.session,
          templateKey,
          transaction,
        });
      }
      const recipientEmail = normalizeEmail(input.payload.recipientEmail ?? existing?.recipientEmail);
      const subject = requiredString(input.payload.subject ?? existing?.subject, "subject", 300);
      const bodyText = requiredString(input.payload.bodyText ?? existing?.bodyText, "bodyText", 50_000);
      const items = input.payload.items === undefined && existing
        ? existingItems.map((row) => ({
            displayAddress: row.displayAddress,
            pdfDocumentId: row.pdfDocumentId,
            position: row.position,
            priceMinor: stringFromDb(row.priceMinor),
            priceReleased: row.priceReleased,
            selectedDocumentIds: row.selectedDocumentIds ?? [],
            selectedMediaIds: row.selectedMediaIds ?? [],
            targetId: row.sellerListingId ?? row.unitId ?? "",
            targetKind: row.targetKind,
            webOfferUrl: row.webOfferUrl,
          }))
        : normalizeOfferItems(input.payload.items);
      await Promise.all([
        assertReference(transaction, input.session, "contact", contactId, projectId),
        assertReference(transaction, input.session, "lead", leadId, projectId),
        assertReference(transaction, input.session, "deal", dealId, projectId),
        assertReference(transaction, input.session, "owner", ownerUserId),
        ...items.map((item) => validateOfferItem(transaction, input.session, projectId, item)),
      ]);
      await Promise.all([
        assertBrokerReferenceAccess({ id: contactId, kind: "contact", projectId, session: input.session, transaction }),
        assertBrokerReferenceAccess({ id: leadId, kind: "lead", projectId, session: input.session, transaction }),
        assertBrokerReferenceAccess({ id: dealId, kind: "deal", projectId, session: input.session, transaction }),
      ]);
      await assertBrokerPartyRelationships({ contactId, dealId, leadId, projectId, session: input.session, transaction });
      if (existing) {
        assertMutableState(existing.status as (typeof offerStatuses)[number], ["withdrawn"], "offer");
        assertTransition(offerTransitions, existing.status as (typeof offerStatuses)[number], status, "offer");
        if (existing.status === "ready" && status === "ready") {
          throw new BrokerDomainError(
            "ready_offer_immutable",
            "Move a ready offer back to draft before editing it.",
            409,
          );
        }
      } else {
        assertInitialState(status, "draft", "offer");
      }

      const addressVisibility = enumValue(
        input.payload.addressVisibility ?? existing?.addressVisibility,
        "addressVisibility",
        ["full", "reduced", "hidden"] as const,
        "reduced",
      );
      const priceReleased = booleanValue(input.payload.priceReleased, existing?.priceReleased ?? false);
      const commissionNotice = cleanString(input.payload.commissionNotice ?? existing?.commissionNotice, 5_000);
      const copyOwner = booleanValue(input.payload.copyOwner, existing?.copyOwner ?? false);
      const nextVersion = existing ? Number(existing.currentVersion) + 1 : 1;
      const row = existing
        ? await transaction.queryOne<OfferRow>(
            `
              update broker_offers set
                project_id = $3::uuid, contact_id = $4::uuid, lead_id = $5::uuid,
                deal_id = $6::uuid, owner_user_id = $7::uuid, template_key = $8,
                recipient_email = $9, subject = $10, body_text = $11,
                address_visibility = $12, price_released = $13, commission_notice = $14,
                copy_owner = $15, status = $16, current_version = $17,
                version = version + 1, updated_by_user_id = $18::uuid, updated_at = now()
              where workspace_id = $1::uuid and id = $2::uuid and version = $19
              returning ${offerReturningSql}
            `,
            [input.session.workspaceId, existing.id, projectId, contactId, leadId, dealId, ownerUserId, templateKey,
              recipientEmail, subject, bodyText, addressVisibility, priceReleased, commissionNotice, copyOwner,
              status, nextVersion, input.session.userId, Number(existing.version)],
          )
        : await transaction.queryOne<OfferRow>(
            `
              insert into broker_offers (
                workspace_id, project_id, contact_id, lead_id, deal_id, owner_user_id,
                template_key, recipient_email, subject, body_text, address_visibility,
                price_released, commission_notice, copy_owner, status, current_version,
                created_by_user_id, updated_by_user_id
              ) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
                $7, $8, $9, $10, $11, $12, $13, $14, $15, 1, $16::uuid, $16::uuid)
              returning ${offerReturningSql}
            `,
            [input.session.workspaceId, projectId, contactId, leadId, dealId, ownerUserId, templateKey,
              recipientEmail, subject, bodyText, addressVisibility, priceReleased, commissionNotice,
              copyOwner, status, input.session.userId],
          );
      if (!row) throw new BrokerDomainError("version_conflict", "Offer changed concurrently.", 409);

      if (existing) {
        await transaction.execute(
          `delete from broker_offer_items where workspace_id = $1::uuid and offer_id = $2::uuid`,
          [input.session.workspaceId, row.id],
        );
      }
      const savedItems: OfferItemRow[] = [];
      for (const item of items) {
        const savedItem = await transaction.queryOne<OfferItemRow>(
          `
            insert into broker_offer_items (
              workspace_id, project_id, offer_id, position, target_kind, seller_listing_id, unit_id,
              display_address, price_minor, price_released, selected_media_ids, selected_document_ids,
              web_offer_url, pdf_document_id
            ) values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid, $7::uuid,
              $8, $9::bigint, $10, $11::uuid[], $12::uuid[], $13, $14::uuid)
            returning ${offerItemReturningSql}
          `,
          [input.session.workspaceId, projectId, row.id, item.position, item.targetKind,
            item.targetKind === "listing" ? item.targetId : null,
            item.targetKind === "unit" ? item.targetId : null,
            item.displayAddress, item.priceMinor, item.priceReleased, item.selectedMediaIds,
            item.selectedDocumentIds, item.webOfferUrl, item.pdfDocumentId],
        );
        if (!savedItem) throw new BrokerDomainError("offer_item_failed", "Offer item could not be persisted.", 503);
        savedItems.push(savedItem);
      }
      const saved = toOffer(row, savedItems);
      await transaction.execute(
        `
          insert into broker_offer_versions (
            workspace_id, project_id, offer_id, version_number, snapshot, created_by_user_id
          ) values ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, $6::uuid)
        `,
        [input.session.workspaceId, projectId, row.id, nextVersion, JSON.stringify(saved), input.session.userId],
      );
      await writeAuditLog({
        action: existing ? "broker.offer.updated" : "broker.offer.created",
        after: saved,
        before: existing ? toOffer(existing, existingItems) : null,
        dealId,
        entityId: row.id,
        entityType: "broker_offer",
        projectId,
        session: input.session,
        transaction,
      });
      return { data: saved, entityId: row.id, httpStatus: existing ? 200 : 201 };
    },
  });
}

export async function requestBrokerOfferQaDelivery(input: {
  idempotencyKey: string;
  offerId: string;
  session: AppSession;
}) {
  const offerId = requiredUuid(input.offerId, "offerId");
  return withIdempotentMutation({
    entityType: "broker_offer_delivery",
    idempotencyKey: input.idempotencyKey,
    operationType: "broker.offer.qa_delivery",
    payload: { offerId },
    session: input.session,
    write: async (transaction) => {
      const offer = await transaction.queryOne<OfferRow>(
        `select ${offerReturningSql} from broker_offers where workspace_id = $1::uuid and id = $2::uuid for update`,
        [input.session.workspaceId, offerId],
      );
      if (!offer) throw new BrokerDomainError("offer_not_found", "Offer was not found.", 404);
      await assertBrokerRecordAccess({
        existingOwnerUserId: offer.ownerUserId,
        projectId: offer.projectId,
        session: input.session,
        transaction,
      });
      await assertBrokerProjectEditAccess({
        projectId: offer.projectId,
        session: input.session,
        transaction,
      });
      if (offer.status !== "ready") throw new BrokerDomainError("offer_not_ready", "Only a ready offer can enter QA delivery.", 409);
      await requireApprovedOfferTemplate({
        projectId: offer.projectId,
        session: input.session,
        templateKey: offer.templateKey,
        transaction,
      });
      const currentItems = await loadOfferItems(transaction, input.session.workspaceId, [offer.id]);
      await Promise.all((currentItems.get(offer.id) ?? []).map((item) => validateOfferItem(
        transaction,
        input.session,
        offer.projectId,
        {
          displayAddress: item.displayAddress,
          pdfDocumentId: item.pdfDocumentId,
          position: item.position,
          priceMinor: stringFromDb(item.priceMinor),
          priceReleased: item.priceReleased,
          selectedDocumentIds: item.selectedDocumentIds ?? [],
          selectedMediaIds: item.selectedMediaIds ?? [],
          targetId: item.sellerListingId ?? item.unitId ?? "",
          targetKind: item.targetKind,
          webOfferUrl: item.webOfferUrl,
        },
      )));
      const decision = evaluateQaOfferDelivery(offer.recipientEmail);
      const status = decision.code === "qa_target_not_allowed" ? "blocked_not_allowed" : "blocked_provider_unavailable";
      const row = await transaction.queryOne<{
        attemptedAt: string | Date;
        failureCode: string;
        id: string;
        providerMessage: string;
        recipientEmail: string;
        status: string;
      }>(
        `
          insert into broker_offer_deliveries (
            workspace_id, project_id, offer_id, offer_version, recipient_email,
            qa_only, status, failure_code, provider_message, attempted_by_user_id
          ) values ($1::uuid, $2::uuid, $3::uuid, $4, $5, true, $6, $7, $8, $9::uuid)
          returning id, recipient_email as "recipientEmail", status,
            failure_code as "failureCode", provider_message as "providerMessage", attempted_at as "attemptedAt"
        `,
        [input.session.workspaceId, offer.projectId, offer.id, Number(offer.currentVersion), offer.recipientEmail,
          status, decision.code, decision.message, input.session.userId],
      );
      if (!row) throw new BrokerDomainError("delivery_state_failed", "Blocked delivery state could not be persisted.", 503);
      const result = {
        delivered: false,
        delivery: { ...row, attemptedAt: new Date(row.attemptedAt).toISOString() },
        offerId,
        providerAccepted: false,
      };
      await writeAuditLog({
        action: "broker.offer.qa_delivery_blocked",
        after: result,
        before: null,
        dealId: offer.dealId,
        entityId: row.id,
        entityType: "broker_offer_delivery",
        projectId: offer.projectId,
        session: input.session,
        transaction,
      });
      return {
        data: result,
        entityId: row.id,
        httpStatus: decision.code === "qa_target_not_allowed" ? 403 : 503,
      };
    },
  });
}

type ActivityRow = {
  activityType: string;
  closingId: string | null;
  contactId: string;
  dealId: string | null;
  detail: string;
  id: string;
  leadId: string | null;
  occurredAt: string | Date;
  offerId: string | null;
  outcome: string;
  ownerUserId: string | null;
  projectId: string | null;
  propertyId: string | null;
  reservationId: string | null;
  title: string;
  unitId: string | null;
  version: number | string;
  viewingId: string | null;
  workspaceId: string;
};

const activityReturningSql = `
  id, workspace_id as "workspaceId", project_id as "projectId", contact_id as "contactId",
  lead_id as "leadId", property_id as "propertyId", unit_id as "unitId",
  deal_id as "dealId", reservation_id as "reservationId", offer_id as "offerId",
  viewing_id as "viewingId", closing_id as "closingId", owner_user_id as "ownerUserId",
  activity_type as "activityType", title, detail, outcome, occurred_at as "occurredAt", version
`;

function toActivity(row: ActivityRow) {
  return { ...row, occurredAt: new Date(row.occurredAt).toISOString(), version: Number(row.version) };
}

export async function listBrokerActivities(input: {
  activityType?: string | null;
  contactId?: string | null;
  leadId?: string | null;
  pagination: Pagination;
  projectId?: string | null;
  session: AppSession;
}) {
  assertPersistence(input.session);
  const projectId = input.projectId ? requiredUuid(input.projectId, "projectId") : null;
  const contactId = input.contactId ? requiredUuid(input.contactId, "contactId") : null;
  const leadId = input.leadId ? requiredUuid(input.leadId, "leadId") : null;
  const activityType = input.activityType ? enumValue(input.activityType, "activityType", activityTypes) : null;
  const rows = await tenantQuery<ActivityRow & { totalCount: number | string }>(
    { actorId: input.session.userId, workspaceId: input.session.workspaceId },
    `
      select ${activityReturningSql}, count(*) over() as "totalCount"
      from contact_timeline_items
      where workspace_id = $1::uuid and broker_operations_managed
        and ($2::uuid is null or project_id = $2::uuid)
        and ($3::uuid is null or contact_id = $3::uuid)
        and ($4::uuid is null or lead_id = $4::uuid)
        and ($5::text is null or activity_type = $5)
        and (
          $8::boolean or owner_user_id = $9::uuid
          or ($10::boolean and exists (
            select 1 from project_pipeline_permissions permission
            where permission.workspace_id = contact_timeline_items.workspace_id
              and permission.project_id = contact_timeline_items.project_id
              and permission.user_id = $9::uuid and permission.can_edit_deals = true
          ))
        )
      order by occurred_at desc, id
      limit $6 offset $7
    `,
    [input.session.workspaceId, projectId, contactId, leadId, activityType, input.pagination.limit, input.pagination.offset,
      canViewAllWorkspaceContacts(input.session), input.session.userId,
      canUseBrokerProjectEditScope(input.session)],
  );
  const total = Number(rows[0]?.totalCount ?? 0);
  return {
    items: rows.map(toActivity),
    pagination: {
      hasMore: input.pagination.offset + rows.length < total,
      limit: input.pagination.limit,
      offset: input.pagination.offset,
      total,
    },
  };
}

export async function createBrokerActivity(input: {
  idempotencyKey: string;
  payload: JsonObject;
  session: AppSession;
}) {
  return withIdempotentMutation({
    entityType: "broker_activity",
    idempotencyKey: input.idempotencyKey,
    operationType: "broker.activity.create",
    payload: input.payload,
    session: input.session,
    write: async (transaction) => {
      const projectId = requiredUuid(input.payload.projectId, "projectId");
      const contactId = requiredUuid(input.payload.contactId, "contactId");
      const leadId = optionalUuid(input.payload.leadId, "leadId");
      const propertyId = optionalUuid(input.payload.propertyId, "propertyId");
      const unitId = optionalUuid(input.payload.unitId, "unitId");
      const dealId = optionalUuid(input.payload.dealId, "dealId");
      const reservationId = optionalUuid(input.payload.reservationId, "reservationId");
      const offerId = optionalUuid(input.payload.offerId, "offerId");
      const viewingId = optionalUuid(input.payload.viewingId, "viewingId");
      const closingId = optionalUuid(input.payload.closingId, "closingId");
      const ownerUserId = optionalUuid(input.payload.ownerUserId ?? input.session.userId, "ownerUserId");
      await assertProject(transaction, input.session, projectId);
      await assertBrokerProjectEditAccess({
        projectId,
        session: input.session,
        transaction,
      });
      await assertBrokerRecordAccess({
        desiredOwnerUserId: ownerUserId,
        projectId,
        session: input.session,
        transaction,
      });
      await Promise.all([
        assertReference(transaction, input.session, "contact", contactId, projectId),
        assertReference(transaction, input.session, "lead", leadId, projectId),
        assertReference(transaction, input.session, "listing", propertyId, projectId),
        assertReference(transaction, input.session, "unit", unitId, projectId),
        assertReference(transaction, input.session, "deal", dealId, projectId),
        assertReference(transaction, input.session, "reservation", reservationId, projectId),
        assertReference(transaction, input.session, "offer", offerId, projectId),
        assertReference(transaction, input.session, "viewing", viewingId, projectId),
        assertReference(transaction, input.session, "closing", closingId, projectId),
        assertReference(transaction, input.session, "owner", ownerUserId),
      ]);
      await Promise.all([
        assertBrokerReferenceAccess({ id: contactId, kind: "contact", projectId, session: input.session, transaction }),
        assertBrokerReferenceAccess({ id: leadId, kind: "lead", projectId, session: input.session, transaction }),
        assertBrokerReferenceAccess({ id: dealId, kind: "deal", projectId, session: input.session, transaction }),
      ]);
      await assertBrokerPartyRelationships({ contactId, dealId, leadId, projectId, session: input.session, transaction });
      const activityType = enumValue(input.payload.activityType, "activityType", activityTypes);
      const title = requiredString(input.payload.title, "title", 300);
      const detail = cleanString(input.payload.detail, 10_000);
      const outcome = enumValue(input.payload.outcome, "outcome", ["open", "done", "risk", "info"] as const, "info");
      const occurredAt = optionalIsoDate(input.payload.occurredAt, "occurredAt") ?? new Date().toISOString();
      const row = await transaction.queryOne<ActivityRow>(
        `
          insert into contact_timeline_items (
            workspace_id, project_id, contact_id, lead_id, property_id, unit_id, deal_id,
            reservation_id, offer_id, viewing_id, closing_id, owner_user_id,
            activity_type, channel, title, detail, outcome, occurred_at, metadata,
            broker_operations_managed
          ) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid,
            $8::uuid, $9::uuid, $10::uuid, $11::uuid, $12::uuid,
            $13, $13, $14, $15, $16, $17::timestamptz,
            jsonb_build_object('brokerOperations', true, 'createdByUserId', $18::text), true)
          returning ${activityReturningSql}
        `,
        [input.session.workspaceId, projectId, contactId, leadId, propertyId, unitId, dealId,
          reservationId, offerId, viewingId, closingId, ownerUserId, activityType, title, detail,
          outcome, occurredAt, input.session.userId],
      );
      if (!row) throw new BrokerDomainError("activity_persistence_failed", "Activity could not be persisted.", 503);

      let followUpTask: unknown = null;
      if (input.payload.followUp !== undefined && input.payload.followUp !== null) {
        const followUp = asRecord(input.payload.followUp, "followUp");
        const taskOwnerId = optionalUuid(followUp.ownerUserId ?? ownerUserId, "followUp.ownerUserId");
        await assertBrokerRecordAccess({
          desiredOwnerUserId: taskOwnerId,
          projectId,
          session: input.session,
          transaction,
        });
        await assertReference(transaction, input.session, "owner", taskOwnerId);
        const task = await transaction.queryOne<{
          dueAt: string | Date | null;
          id: string;
          priority: string;
          status: string;
          title: string;
        }>(
          `
            insert into tasks (
              workspace_id, project_id, contact_id, lead_id, owner_user_id, title,
              due_at, priority, status, metadata, broker_activity_id, property_id, unit_id,
              deal_id, reservation_id, offer_id, viewing_id, closing_id
            ) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6,
              $8::timestamptz, $9, 'open', jsonb_build_object('brokerOperations', true, 'description', $7::text),
              $10::uuid, $11::uuid, $12::uuid, $13::uuid, $14::uuid, $15::uuid, $16::uuid, $17::uuid)
            returning id, title, due_at as "dueAt", priority, status
          `,
          [input.session.workspaceId, projectId, contactId, leadId, taskOwnerId,
            requiredString(followUp.title, "followUp.title", 300), cleanString(followUp.description, 5_000),
            optionalIsoDate(followUp.dueAt, "followUp.dueAt"),
            enumValue(followUp.priority, "followUp.priority", ["Niedrig", "Normal", "Hoch"] as const, "Normal"),
            row.id, propertyId, unitId, dealId, reservationId, offerId, viewingId, closingId],
        );
        if (!task) throw new BrokerDomainError("follow_up_persistence_failed", "Follow-up task could not be persisted.", 503);
        followUpTask = { ...task, dueAt: task.dueAt ? new Date(task.dueAt).toISOString() : null };
      }
      const activity = toActivity(row);
      const result = { activity, followUpTask };
      await writeAuditLog({
        action: "broker.activity.created",
        after: result,
        before: null,
        dealId,
        entityId: row.id,
        entityType: "contact_timeline_item",
        projectId,
        session: input.session,
        transaction,
      });
      return { data: result, entityId: row.id, httpStatus: 201 };
    },
  });
}

type ViewingRow = {
  addressMode: string;
  addressText: string;
  calendarEventId: string | null;
  cancellationReason: string | null;
  contactId: string | null;
  dealId: string | null;
  endsAt: string | Date;
  id: string;
  internalNote: string;
  invitationStatus: string;
  leadId: string | null;
  ownerUserId: string | null;
  personalNote: string;
  projectId: string;
  propertyId: string | null;
  reminderAt: string | Date | null;
  startsAt: string | Date;
  status: string;
  targetKind: "listing" | "unit";
  timezone: string;
  unitId: string | null;
  updatedAt: string | Date;
  version: number | string;
  workspaceId: string;
};

const viewingReturningSql = `
  id, workspace_id as "workspaceId", project_id as "projectId", target_kind as "targetKind",
  property_id as "propertyId", unit_id as "unitId", contact_id as "contactId",
  lead_id as "leadId", deal_id as "dealId", owner_user_id as "ownerUserId",
  starts_at as "startsAt", ends_at as "endsAt", timezone,
  address_mode as "addressMode", address_text as "addressText",
  personal_note as "personalNote", internal_note as "internalNote", status,
  invitation_status as "invitationStatus", reminder_at as "reminderAt",
  cancellation_reason as "cancellationReason", calendar_event_id as "calendarEventId",
  version, updated_at as "updatedAt"
`;

function toViewing(row: ViewingRow, history: unknown[] = []) {
  return {
    ...row,
    endsAt: new Date(row.endsAt).toISOString(),
    history,
    reminderAt: row.reminderAt ? new Date(row.reminderAt).toISOString() : null,
    startsAt: new Date(row.startsAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    version: Number(row.version),
  };
}

export async function listBrokerViewings(input: {
  contactId?: string | null;
  leadId?: string | null;
  pagination: Pagination;
  projectId?: string | null;
  session: AppSession;
  status?: string | null;
}) {
  assertPersistence(input.session);
  const projectId = input.projectId ? requiredUuid(input.projectId, "projectId") : null;
  const contactId = input.contactId ? requiredUuid(input.contactId, "contactId") : null;
  const leadId = input.leadId ? requiredUuid(input.leadId, "leadId") : null;
  const status = input.status ? enumValue(input.status, "status", viewingStatuses) : null;
  return withTenantTransaction({
    actorId: input.session.userId,
    workspaceId: input.session.workspaceId,
  }, async (transaction) => {
    const rows = await transaction.query<ViewingRow & { totalCount: number | string }>(
      `
        select ${viewingReturningSql}, count(*) over() as "totalCount"
        from property_viewing_slots
        where workspace_id = $1::uuid and broker_operations_managed
          and ($2::uuid is null or project_id = $2::uuid)
          and ($3::uuid is null or contact_id = $3::uuid)
          and ($4::uuid is null or lead_id = $4::uuid)
          and ($5::text is null or status = $5)
          and (
            $8::boolean or owner_user_id = $9::uuid
            or ($10::boolean and exists (
              select 1 from project_pipeline_permissions permission
              where permission.workspace_id = property_viewing_slots.workspace_id
                and permission.project_id = property_viewing_slots.project_id
                and permission.user_id = $9::uuid and permission.can_edit_deals = true
            ))
          )
        order by starts_at desc, id
        limit $6 offset $7
      `,
      [input.session.workspaceId, projectId, contactId, leadId, status, input.pagination.limit, input.pagination.offset,
        canViewAllWorkspaceContacts(input.session), input.session.userId,
        canUseBrokerProjectEditScope(input.session)],
    );
    const ids = rows.map((row) => row.id);
    const historyRows = ids.length === 0 ? [] : await transaction.query<{
      after: unknown;
      before: unknown;
      createdAt: string | Date;
      eventType: string;
      fromStatus: string | null;
      id: string;
      toStatus: string | null;
      viewingId: string;
    }>(
      `
        select history.id, requested.viewing_id as "viewingId", history.event_type as "eventType",
          history.from_status as "fromStatus", history.to_status as "toStatus",
          history.before, history.after, history.created_at as "createdAt"
        from unnest($2::uuid[]) as requested(viewing_id)
        cross join lateral (
          select candidate.*
          from broker_viewing_history candidate
          where candidate.workspace_id = $1::uuid and candidate.viewing_id = requested.viewing_id
          order by candidate.created_at desc, candidate.id
          limit 25
        ) history
        order by requested.viewing_id, history.created_at desc, history.id
      `,
      [input.session.workspaceId, ids],
    );
    const histories = new Map<string, unknown[]>();
    for (const history of historyRows) {
      const bucket = histories.get(history.viewingId) ?? [];
      if (bucket.length < 25) bucket.push({ ...history, createdAt: new Date(history.createdAt).toISOString() });
      histories.set(history.viewingId, bucket);
    }
    const total = Number(rows[0]?.totalCount ?? 0);
    return {
      items: rows.map((row) => toViewing(row, histories.get(row.id))),
      pagination: {
        hasMore: input.pagination.offset + rows.length < total,
        limit: input.pagination.limit,
        offset: input.pagination.offset,
        total,
      },
    };
  });
}

function calendarLocation(addressMode: string) {
  if (addressMode === "online") return "Extern";
  return "Vor Ort";
}

function calendarStatus(status: string) {
  if (status === "confirmed") return "bestätigt";
  if (status === "completed") return "nachfassen";
  if (status === "cancelled") return "abgesagt";
  if (status === "no_show") return "nicht erschienen";
  return "geplant";
}

export async function saveBrokerViewing(input: {
  idempotencyKey: string;
  payload: JsonObject;
  session: AppSession;
}) {
  const viewingId = optionalUuid(input.payload.id, "id");
  return withIdempotentMutation({
    entityType: "property_viewing_slot",
    idempotencyKey: input.idempotencyKey,
    operationType: viewingId ? "broker.viewing.update" : "broker.viewing.create",
    payload: input.payload,
    session: input.session,
    write: async (transaction) => {
      const existing = viewingId
        ? await transaction.queryOne<ViewingRow>(
            `select ${viewingReturningSql} from property_viewing_slots where workspace_id = $1::uuid and id = $2::uuid for update`,
            [input.session.workspaceId, viewingId],
          )
        : null;
      if (viewingId && !existing) throw new BrokerDomainError("viewing_not_found", "Viewing was not found.", 404);
      if (existing) {
        await assertBrokerRecordAccess({
          existingOwnerUserId: existing.ownerUserId,
          projectId: existing.projectId,
          session: input.session,
          transaction,
        });
      }
      if (existing && Number(existing.version) !== expectedVersion(input.payload.expectedVersion)) {
        throw new BrokerDomainError("version_conflict", "Viewing changed since it was loaded.", 409);
      }
      const projectId = requiredUuid(input.payload.projectId ?? existing?.projectId, "projectId");
      const targetKind = enumValue(input.payload.targetKind ?? existing?.targetKind, "targetKind", ["listing", "unit"] as const);
      const targetId = requiredUuid(input.payload.targetId ?? (existing?.propertyId ?? existing?.unitId), "targetId");
      const contactId = requiredUuid(input.payload.contactId ?? existing?.contactId, "contactId");
      const leadId = optionalUuid(input.payload.leadId ?? existing?.leadId, "leadId");
      const dealId = optionalUuid(input.payload.dealId ?? existing?.dealId, "dealId");
      const ownerUserId = optionalUuid(
        input.payload.ownerUserId === undefined
          ? existing ? existing.ownerUserId : input.session.userId
          : input.payload.ownerUserId,
        "ownerUserId",
      );
      await assertProject(transaction, input.session, projectId);
      if (!existing || existing.projectId !== projectId) {
        await assertBrokerProjectEditAccess({
          projectId,
          session: input.session,
          transaction,
        });
      }
      await assertBrokerRecordAccess({
        desiredOwnerUserId: ownerUserId,
        existingOwnerUserId: existing?.ownerUserId,
        projectId,
        session: input.session,
        transaction,
      });
      const startsAt = optionalIsoDate(input.payload.startsAt ?? existing?.startsAt, "startsAt");
      const endsAt = optionalIsoDate(input.payload.endsAt ?? existing?.endsAt, "endsAt");
      if (!startsAt || !endsAt || new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
        throw new BrokerDomainError("invalid_viewing_time", "endsAt must be after startsAt.");
      }
      const timezone = requiredString(input.payload.timezone ?? existing?.timezone ?? "Europe/Vienna", "timezone", 100);
      if (!isValidTimeZone(timezone)) throw new BrokerDomainError("invalid_timezone", "timezone is not an IANA time zone.");
      const status = enumValue(input.payload.status ?? existing?.status, "status", viewingStatuses, "planned");
      if (existing) {
        assertMutableState(
          existing.status as (typeof viewingStatuses)[number],
          ["completed", "cancelled", "no_show"],
          "viewing",
        );
        assertTransition(viewingTransitions, existing.status as (typeof viewingStatuses)[number], status, "viewing");
      } else {
        assertInitialState(status, "planned", "viewing");
      }
      const addressMode = enumValue(
        input.payload.addressMode ?? existing?.addressMode,
        "addressMode",
        ["property", "company", "alternative", "online"] as const,
        "property",
      );
      const addressText = requiredString(input.payload.addressText ?? existing?.addressText, "addressText", 1_000);
      const personalNote = cleanString(input.payload.personalNote ?? existing?.personalNote, 5_000);
      const internalNote = cleanString(input.payload.internalNote ?? existing?.internalNote, 10_000);
      const reminderAt = input.payload.reminderAt === undefined
        ? existing?.reminderAt ? new Date(existing.reminderAt).toISOString() : null
        : optionalIsoDate(input.payload.reminderAt, "reminderAt");
      const cancellationReason = optionalString(input.payload.cancellationReason ?? existing?.cancellationReason, 2_000);
      if (status === "cancelled" && !cancellationReason) {
        throw new BrokerDomainError("cancellation_reason_required", "Cancelled viewings require a reason.");
      }
      await Promise.all([
        assertReference(transaction, input.session, targetKind, targetId, projectId),
        assertReference(transaction, input.session, "contact", contactId, projectId),
        assertReference(transaction, input.session, "lead", leadId, projectId),
        assertReference(transaction, input.session, "deal", dealId, projectId),
        assertReference(transaction, input.session, "owner", ownerUserId),
      ]);
      await Promise.all([
        assertBrokerReferenceAccess({ id: contactId, kind: "contact", projectId, session: input.session, transaction }),
        assertBrokerReferenceAccess({ id: leadId, kind: "lead", projectId, session: input.session, transaction }),
        assertBrokerReferenceAccess({ id: dealId, kind: "deal", projectId, session: input.session, transaction }),
      ]);
      await assertBrokerPartyRelationships({ contactId, dealId, leadId, projectId, session: input.session, transaction });
      const invitationRequested = booleanValue(input.payload.invitationRequested, false);
      const invitationStatus = invitationRequested
        ? "blocked_provider_unavailable"
        : existing?.invitationStatus ?? "not_requested";
      const createCalendarProjection = booleanValue(
        input.payload.createCalendarProjection,
        Boolean(existing?.calendarEventId),
      );
      if (existing?.calendarEventId && !createCalendarProjection) {
        throw new BrokerDomainError(
          "calendar_projection_detach_unsupported",
          "An existing calendar projection must stay attached so viewing and calendar data cannot diverge.",
          409,
        );
      }
      const row = existing
        ? await transaction.queryOne<ViewingRow>(
            `
              update property_viewing_slots set
                project_id = $3::uuid, target_kind = $4, property_id = $5::uuid, unit_id = $6::uuid,
                contact_id = $7::uuid, lead_id = $8::uuid, deal_id = $9::uuid,
                owner_user_id = $10::uuid, starts_at = $11::timestamptz, ends_at = $12::timestamptz,
                timezone = $13, address_mode = $14, address_text = $15, personal_note = $16,
                internal_note = $17, status = $18, invitation_status = $19,
                reminder_at = $20::timestamptz, cancellation_reason = $21,
                note = $17, version = version + 1, broker_operations_managed = true, updated_at = now()
              where workspace_id = $1::uuid and id = $2::uuid and version = $22
              returning ${viewingReturningSql}
            `,
            [input.session.workspaceId, existing.id, projectId, targetKind,
              targetKind === "listing" ? targetId : null, targetKind === "unit" ? targetId : null,
              contactId, leadId, dealId, ownerUserId, startsAt, endsAt, timezone, addressMode,
              addressText, personalNote, internalNote, status, invitationStatus, reminderAt,
              cancellationReason, Number(existing.version)],
          )
        : await transaction.queryOne<ViewingRow>(
            `
              insert into property_viewing_slots (
                workspace_id, project_id, target_kind, property_id, unit_id, contact_id, lead_id,
                deal_id, owner_user_id, starts_at, ends_at, timezone, address_mode, address_text,
                personal_note, internal_note, status, invitation_status, reminder_at,
                cancellation_reason, note, metadata, broker_operations_managed
              ) values ($1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6::uuid, $7::uuid,
                $8::uuid, $9::uuid, $10::timestamptz, $11::timestamptz, $12, $13, $14,
                $15, $16, $17, $18, $19::timestamptz, $20, $16,
                jsonb_build_object('brokerOperations', true, 'externalCommunication', false), true)
              returning ${viewingReturningSql}
            `,
            [input.session.workspaceId, projectId, targetKind,
              targetKind === "listing" ? targetId : null, targetKind === "unit" ? targetId : null,
              contactId, leadId, dealId, ownerUserId, startsAt, endsAt, timezone, addressMode,
              addressText, personalNote, internalNote, status, invitationStatus, reminderAt, cancellationReason],
          );
      if (!row) throw new BrokerDomainError("version_conflict", "Viewing changed concurrently.", 409);

      let calendarEventId = row.calendarEventId;
      if (createCalendarProjection) {
        if (calendarEventId) {
          const updatedCalendar = await transaction.queryOne<{ id: string }>(
            `
              update calendar_events set
                project_id = $3::uuid, contact_id = $4::uuid, lead_id = $5::uuid,
                owner_user_id = $6::uuid, title = $7, starts_at = $8::timestamptz,
                ends_at = $9::timestamptz, location = $10, status = $11,
                outcome_goal = $12, metadata = coalesce(metadata, '{}'::jsonb) || $13::jsonb,
                updated_at = now()
              where workspace_id = $1::uuid and id = $2::uuid
              returning id
            `,
            [input.session.workspaceId, calendarEventId, projectId, contactId, leadId, ownerUserId,
              `Besichtigung: ${addressText}`, startsAt, endsAt, calendarLocation(addressMode),
              calendarStatus(status), personalNote,
              JSON.stringify({ brokerViewingId: row.id, calendarProvider: "manual", externalCommunication: false, timezone })],
          );
          if (!updatedCalendar) throw new BrokerDomainError("calendar_projection_failed", "Calendar projection could not be updated.", 503);
        } else {
          const calendar = await transaction.queryOne<{ id: string }>(
            `
              insert into calendar_events (
                workspace_id, project_id, contact_id, lead_id, owner_user_id, title,
                starts_at, ends_at, location, status, preparation, outcome_goal, teams_join_url, metadata
              ) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6,
                $7::timestamptz, $8::timestamptz, $9, $10, '[]'::jsonb, $11, null, $12::jsonb)
              returning id
            `,
            [input.session.workspaceId, projectId, contactId, leadId, ownerUserId,
              `Besichtigung: ${addressText}`, startsAt, endsAt, calendarLocation(addressMode),
              calendarStatus(status), personalNote,
              JSON.stringify({ brokerViewingId: row.id, calendarProvider: "manual", externalCommunication: false, timezone })],
          );
          if (!calendar) throw new BrokerDomainError("calendar_projection_failed", "Calendar projection could not be created.", 503);
          calendarEventId = calendar.id;
          await transaction.execute(
            `update property_viewing_slots set calendar_event_id = $3::uuid where workspace_id = $1::uuid and id = $2::uuid`,
            [input.session.workspaceId, row.id, calendar.id],
          );
          row.calendarEventId = calendar.id;
        }
      }

      const timesChanged = Boolean(existing) && (
        new Date(existing!.startsAt).toISOString() !== startsAt || new Date(existing!.endsAt).toISOString() !== endsAt
      );
      const statusChanged = Boolean(existing) && existing!.status !== status;
      const eventType = !existing ? "created" : statusChanged ? "status_changed" : timesChanged ? "rescheduled" : "updated";
      const viewing = toViewing(row);
      await transaction.execute(
        `
          insert into broker_viewing_history (
            workspace_id, project_id, viewing_id, actor_user_id, event_type,
            from_status, to_status, before, after
          ) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8::jsonb, $9::jsonb)
        `,
        [input.session.workspaceId, projectId, row.id, input.session.userId, eventType,
          existing?.status ?? null, status, JSON.stringify(existing ? toViewing(existing) : null), JSON.stringify(viewing)],
      );
      if (createCalendarProjection && !existing?.calendarEventId) {
        await transaction.execute(
          `
            insert into broker_viewing_history (
              workspace_id, project_id, viewing_id, actor_user_id, event_type, from_status, to_status, before, after
            ) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'calendar_projected', $5, $5, null, $6::jsonb)
          `,
          [input.session.workspaceId, projectId, row.id, input.session.userId, status,
            JSON.stringify({ calendarEventId, externalCommunication: false })],
        );
      }
      if (invitationRequested) {
        await transaction.execute(
          `
            insert into broker_viewing_history (
              workspace_id, project_id, viewing_id, actor_user_id, event_type, from_status, to_status, before, after
            ) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'invitation_blocked', $5, $5, null, $6::jsonb)
          `,
          [input.session.workspaceId, projectId, row.id, input.session.userId, status,
            JSON.stringify({ code: "provider_adapter_unavailable", externalCommunication: false })],
        );
      }
      const result = {
        calendarProjection: calendarEventId ? { calendarEventId, externalCommunication: false, persisted: true } : null,
        invitation: invitationRequested
          ? { code: "provider_adapter_unavailable", providerAccepted: false, sent: false }
          : { providerAccepted: false, requested: false, sent: false },
        viewing,
      };
      await writeAuditLog({
        action: existing ? "broker.viewing.updated" : "broker.viewing.created",
        after: result,
        before: existing ? toViewing(existing) : null,
        dealId,
        entityId: row.id,
        entityType: "property_viewing_slot",
        projectId,
        session: input.session,
        transaction,
      });
      return { data: result, entityId: row.id, httpStatus: existing ? 200 : 201 };
    },
  });
}

type ClosingRow = {
  baseAmountMinor: number | string;
  buyerCommissionMinor: number | string;
  buyerContactId: string;
  closingDate: string | Date | null;
  contractDate: string | Date | null;
  contractType: string;
  createdAt: string | Date;
  currency: string;
  dealId: string;
  grossCommissionMinor: number | string;
  id: string;
  internalNotes: string;
  netCommissionMinor: number | string;
  ownerUserId: string | null;
  paymentDueAt: string | Date | null;
  paymentStatus: string;
  projectId: string;
  reservationId: string | null;
  reversalReason: string | null;
  sellerCommissionMinor: number | string;
  sellerContactId: string;
  sellerListingId: string | null;
  servicePeriodEnd: string | Date | null;
  servicePeriodStart: string | Date | null;
  status: string;
  targetKind: "listing" | "unit";
  taxMinor: number | string;
  unitId: string | null;
  updatedAt: string | Date;
  version: number | string;
  workspaceId: string;
};

const closingReturningSql = `
  id, workspace_id as "workspaceId", project_id as "projectId", target_kind as "targetKind",
  seller_listing_id as "sellerListingId", unit_id as "unitId", deal_id as "dealId",
  buyer_contact_id as "buyerContactId", seller_contact_id as "sellerContactId",
  reservation_id as "reservationId", owner_user_id as "ownerUserId", contract_type as "contractType",
  contract_date as "contractDate", closing_date as "closingDate", base_amount_minor as "baseAmountMinor",
  buyer_commission_minor as "buyerCommissionMinor", seller_commission_minor as "sellerCommissionMinor",
  net_commission_minor as "netCommissionMinor", tax_minor as "taxMinor",
  gross_commission_minor as "grossCommissionMinor", currency,
  service_period_start as "servicePeriodStart", service_period_end as "servicePeriodEnd",
  payment_due_at as "paymentDueAt", payment_status as "paymentStatus", status,
  reversal_reason as "reversalReason", internal_notes as "internalNotes", version,
  created_at as "createdAt", updated_at as "updatedAt"
`;

function dateFromDb(value: string | Date | null) {
  return value ? new Date(value).toISOString().slice(0, 10) : null;
}

function toClosing(row: ClosingRow, input: { financialsVisible: boolean; participants?: unknown[]; splits?: unknown[] }) {
  const common = {
    buyerContactId: row.buyerContactId,
    closingDate: dateFromDb(row.closingDate),
    contractDate: dateFromDb(row.contractDate),
    contractType: row.contractType,
    createdAt: new Date(row.createdAt).toISOString(),
    currency: input.financialsVisible ? row.currency : null,
    dealId: row.dealId,
    financialsVisible: input.financialsVisible,
    id: row.id,
    internalNotes: input.financialsVisible ? row.internalNotes : null,
    ownerUserId: row.ownerUserId,
    participants: input.financialsVisible ? input.participants ?? [] : [],
    paymentDueAt: input.financialsVisible ? dateFromDb(row.paymentDueAt) : null,
    paymentStatus: input.financialsVisible ? row.paymentStatus : null,
    projectId: row.projectId,
    reservationId: row.reservationId,
    reversalReason: input.financialsVisible ? row.reversalReason : null,
    sellerContactId: row.sellerContactId,
    servicePeriodEnd: input.financialsVisible ? dateFromDb(row.servicePeriodEnd) : null,
    servicePeriodStart: input.financialsVisible ? dateFromDb(row.servicePeriodStart) : null,
    status: row.status,
    targetId: row.sellerListingId ?? row.unitId,
    targetKind: row.targetKind,
    updatedAt: new Date(row.updatedAt).toISOString(),
    version: Number(row.version),
    workspaceId: row.workspaceId,
  };
  if (!input.financialsVisible) {
    return {
      ...common,
      baseAmountMinor: null,
      buyerCommissionMinor: null,
      commissionSplits: [],
      grossCommissionMinor: null,
      netCommissionMinor: null,
      sellerCommissionMinor: null,
      taxMinor: null,
    };
  }
  return {
    ...common,
    baseAmountMinor: String(row.baseAmountMinor),
    buyerCommissionMinor: String(row.buyerCommissionMinor),
    commissionSplits: input.splits ?? [],
    grossCommissionMinor: String(row.grossCommissionMinor),
    netCommissionMinor: String(row.netCommissionMinor),
    sellerCommissionMinor: String(row.sellerCommissionMinor),
    taxMinor: String(row.taxMinor),
  };
}

async function loadClosingRelations(transaction: TenantTransaction, workspaceId: string, closingIds: readonly string[]) {
  const participants = new Map<string, unknown[]>();
  const splits = new Map<string, unknown[]>();
  if (closingIds.length === 0) return { participants, splits };
  const [participantRows, splitRows] = await Promise.all([
    transaction.query<{ closingId: string; id: string; participantRole: string; userId: string }>(
      `
        select id, closing_id as "closingId", user_id as "userId", participant_role as "participantRole"
        from broker_closing_participants
        where workspace_id = $1::uuid and closing_id = any($2::uuid[])
        order by created_at, id
      `,
      [workspaceId, closingIds],
    ),
    transaction.query<{
      allocationType: string;
      amountMinor: number | string | null;
      basisPoints: number | null;
      closingId: string;
      computedAmountMinor: number | string;
      id: string;
      label: string | null;
      side: string;
      sourceSide: string;
      userId: string | null;
    }>(
      `
        select id, closing_id as "closingId", user_id as "userId", label, side,
          source_side as "sourceSide",
          allocation_type as "allocationType", basis_points as "basisPoints",
          amount_minor as "amountMinor", computed_amount_minor as "computedAmountMinor"
        from broker_commission_splits
        where workspace_id = $1::uuid and closing_id = any($2::uuid[])
        order by created_at, id
      `,
      [workspaceId, closingIds],
    ),
  ]);
  for (const row of participantRows) {
    const bucket = participants.get(row.closingId) ?? [];
    bucket.push(row);
    participants.set(row.closingId, bucket);
  }
  for (const row of splitRows) {
    const bucket = splits.get(row.closingId) ?? [];
    bucket.push({
      ...row,
      amountMinor: stringFromDb(row.amountMinor),
      computedAmountMinor: String(row.computedAmountMinor),
    });
    splits.set(row.closingId, bucket);
  }
  return { participants, splits };
}

export async function listBrokerClosings(input: {
  closingId?: string | null;
  contactId?: string | null;
  pagination: Pagination;
  projectId?: string | null;
  session: AppSession;
  status?: string | null;
}) {
  assertPersistence(input.session);
  const closingId = input.closingId ? requiredUuid(input.closingId, "closingId") : null;
  const projectId = input.projectId ? requiredUuid(input.projectId, "projectId") : null;
  const contactId = input.contactId ? requiredUuid(input.contactId, "contactId") : null;
  const status = input.status ? enumValue(input.status, "status", closingStatuses) : null;
  return withTenantTransaction({
    actorId: input.session.userId,
    workspaceId: input.session.workspaceId,
  }, async (transaction) => {
    const rows = await transaction.query<ClosingRow & { totalCount: number | string }>(
      `
        select ${closingReturningSql}, count(*) over() as "totalCount"
        from broker_closings
        where workspace_id = $1::uuid
          and ($2::uuid is null or project_id = $2::uuid)
          and ($3::uuid is null or buyer_contact_id = $3::uuid or seller_contact_id = $3::uuid)
          and ($4::text is null or status = $4)
          and ($5::uuid is null or id = $5::uuid)
          and (
            $8::boolean or owner_user_id = $9::uuid
            or ($10::boolean and exists (
              select 1 from project_pipeline_permissions permission
              where permission.workspace_id = broker_closings.workspace_id
                and permission.project_id = broker_closings.project_id
                and permission.user_id = $9::uuid and permission.can_edit_deals = true
            ))
          )
        order by updated_at desc, id
        limit $6 offset $7
      `,
      [input.session.workspaceId, projectId, contactId, status, closingId, input.pagination.limit, input.pagination.offset,
        canViewAllWorkspaceContacts(input.session), input.session.userId,
        canUseBrokerProjectEditScope(input.session)],
    );
    const financialsVisible = canManageBrokerFinancials(input.session);
    const relations = financialsVisible
      ? await loadClosingRelations(transaction, input.session.workspaceId, rows.map((row) => row.id))
      : { participants: new Map<string, unknown[]>(), splits: new Map<string, unknown[]>() };
    const total = Number(rows[0]?.totalCount ?? 0);
    return {
      financialsVisible,
      items: rows.map((row) => toClosing(row, {
        financialsVisible,
        participants: relations.participants.get(row.id),
        splits: financialsVisible ? relations.splits.get(row.id) : [],
      })),
      pagination: {
        hasMore: input.pagination.offset + rows.length < total,
        limit: input.pagination.limit,
        offset: input.pagination.offset,
        total,
      },
    };
  });
}

function parseParticipants(value: unknown) {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > 100) {
    throw new BrokerDomainError("invalid_participants", "participants must contain at most 100 rows.");
  }
  const participants = value.map((entry, index) => {
    const row = asRecord(entry, `participants[${index}]`);
    return {
      participantRole: requiredString(row.participantRole, `participants[${index}].participantRole`, 120),
      userId: requiredUuid(row.userId, `participants[${index}].userId`),
    };
  });
  const keys = participants.map((participant) => `${participant.userId}:${participant.participantRole.toLowerCase()}`);
  if (new Set(keys).size !== keys.length) {
    throw new BrokerDomainError("duplicate_participant", "The same user and participant role may only occur once.");
  }
  return participants;
}

async function assertClosingRelationshipValidity(input: {
  buyerContactId: string;
  dealId: string;
  projectId: string;
  reservationId: string | null;
  sellerContactId: string;
  session: AppSession;
  status: (typeof closingStatuses)[number];
  targetId: string;
  targetKind: "listing" | "unit";
  transaction: TenantTransaction;
}) {
  const deal = await input.transaction.queryOne<{
    contactId: string | null;
    stage: string;
  }>(
    `
      select contact_id as "contactId", stage
      from deals
      where workspace_id = $1::uuid and project_id = $2::uuid and id = $3::uuid
      for update
    `,
    [input.session.workspaceId, input.projectId, input.dealId],
  );
  if (!deal) throw new BrokerDomainError("deal_not_found", "Closing deal was not found in the project.", 404);
  // Cancellation and reversal must remain available even when the live deal,
  // unit or reservation has drifted. Those terminal transitions cannot change
  // the closing's commercial identity and never synchronize launch-off records.
  if (["cancelled", "reversed"].includes(input.status)) return;
  if (deal.contactId !== input.buyerContactId) {
    throw new BrokerDomainError(
      "closing_deal_buyer_mismatch",
      "The closing buyer must be the contact assigned to the deal.",
      409,
    );
  }
  const lostDealStages = ["Verloren", "Disqualifiziert", "Pausiert / Verloren"];
  if (!["draft", "cancelled"].includes(input.status) && lostDealStages.includes(deal.stage)) {
    throw new BrokerDomainError("closing_deal_status_invalid", "A lost deal cannot advance a closing.", 409);
  }
  if (["signed", "invoiced", "paid"].includes(input.status) && deal.stage !== "Gewonnen") {
    throw new BrokerDomainError(
      "closing_deal_not_won",
      "Signed and later closings require the linked deal to be won.",
      409,
    );
  }

  let unitId: string | null = input.targetKind === "unit" ? input.targetId : null;
  if (input.targetKind === "listing") {
    const listing = await input.transaction.queryOne<{ ownerContactId: string | null; unitId: string | null }>(
      `
        select owner_contact_id as "ownerContactId", unit_id as "unitId"
        from seller_listings
        where workspace_id = $1::uuid and project_id = $2::uuid and id = $3::uuid
        for update
      `,
      [input.session.workspaceId, input.projectId, input.targetId],
    );
    if (!listing) throw new BrokerDomainError("listing_not_found", "Closing listing was not found in the project.", 404);
    if (listing.ownerContactId && listing.ownerContactId !== input.sellerContactId) {
      throw new BrokerDomainError(
        "closing_listing_seller_mismatch",
        "The closing seller must match the listing owner contact.",
        409,
      );
    }
    unitId = listing.unitId;
  }

  if (unitId) {
    const unit = await input.transaction.queryOne<{
      buyerContactId: string | null;
      dealId: string | null;
      status: string;
    }>(
      `
        select buyer_contact_id as "buyerContactId", deal_id as "dealId", status
        from property_units
        where workspace_id = $1::uuid and project_id = $2::uuid and id = $3::uuid
        for update
      `,
      [input.session.workspaceId, input.projectId, unitId],
    );
    if (!unit) throw new BrokerDomainError("unit_not_found", "Closing unit was not found in the project.", 404);
    if (unit.buyerContactId && unit.buyerContactId !== input.buyerContactId) {
      throw new BrokerDomainError("closing_unit_buyer_mismatch", "The unit is assigned to another buyer.", 409);
    }
    if (unit.dealId && unit.dealId !== input.dealId) {
      throw new BrokerDomainError("closing_unit_deal_mismatch", "The unit is assigned to another deal.", 409);
    }
    if (!["draft", "cancelled"].includes(input.status) && unit.status === "blocked") {
      throw new BrokerDomainError("closing_unit_blocked", "A blocked unit cannot advance a closing.", 409);
    }
    if (unit.status === "sold" && (unit.buyerContactId !== input.buyerContactId || unit.dealId !== input.dealId)) {
      throw new BrokerDomainError(
        "closing_unit_sale_mismatch",
        "A sold unit must already reference this closing's buyer and deal.",
        409,
      );
    }
  }

  let reservation: { contactId: string; dealId: string | null; expiresAt: string | Date; status: string; unitId: string } | null = null;
  if (input.reservationId) {
    reservation = await input.transaction.queryOne<{
      contactId: string;
      dealId: string | null;
      expiresAt: string | Date;
      status: string;
      unitId: string;
    }>(
      `
        select contact_id as "contactId", deal_id as "dealId", expires_at as "expiresAt", status,
          unit_id as "unitId"
        from property_reservations
        where workspace_id = $1::uuid and project_id = $2::uuid and id = $3::uuid
        for update
      `,
      [input.session.workspaceId, input.projectId, input.reservationId],
    );
    if (!reservation) throw new BrokerDomainError("reservation_not_found", "Closing reservation was not found in the project.", 404);
    if (!unitId || reservation.unitId !== unitId) {
      throw new BrokerDomainError("closing_reservation_target_mismatch", "Reservation and closing target unit do not match.", 409);
    }
    if (reservation.contactId !== input.buyerContactId || (reservation.dealId && reservation.dealId !== input.dealId)) {
      throw new BrokerDomainError("closing_reservation_party_mismatch", "Reservation, buyer and deal do not match.", 409);
    }
    if (reservation.status === "expired" || (
      ["hold", "reserved"].includes(reservation.status) && new Date(reservation.expiresAt).getTime() <= Date.now()
    )) {
      throw new BrokerDomainError("closing_reservation_expired", "An expired reservation cannot be used for a closing.", 409);
    }
  }

  if (unitId && !["draft", "cancelled"].includes(input.status)) {
    const activeReservation = await input.transaction.queryOne<{ id: string }>(
      `
        select id
        from property_reservations
        where workspace_id = $1::uuid and project_id = $2::uuid and unit_id = $3::uuid
          and status in ('hold', 'reserved') and expires_at > now()
        order by created_at desc, id
        limit 1
        for update
      `,
      [input.session.workspaceId, input.projectId, unitId],
    );
    if (activeReservation && activeReservation.id !== input.reservationId) {
      throw new BrokerDomainError(
        "closing_active_reservation_mismatch",
        "The active unit reservation must be linked to the closing.",
        409,
      );
    }
  }
}

export async function saveBrokerClosing(input: {
  idempotencyKey: string;
  payload: JsonObject;
  session: AppSession;
}) {
  if (!canManageBrokerFinancials(input.session)) {
    throw new BrokerDomainError("financial_permission_required", "Owner or admin permission is required for closing financials.", 403);
  }
  const closingId = optionalUuid(input.payload.id, "id");
  return withIdempotentMutation({
    entityType: "broker_closing",
    idempotencyKey: input.idempotencyKey,
    operationType: closingId ? "broker.closing.update" : "broker.closing.create",
    payload: input.payload,
    session: input.session,
    write: async (transaction) => {
      const existing = closingId
        ? await transaction.queryOne<ClosingRow>(
            `select ${closingReturningSql} from broker_closings where workspace_id = $1::uuid and id = $2::uuid for update`,
            [input.session.workspaceId, closingId],
          )
        : null;
      if (closingId && !existing) throw new BrokerDomainError("closing_not_found", "Closing was not found.", 404);
      if (existing && Number(existing.version) !== expectedVersion(input.payload.expectedVersion)) {
        throw new BrokerDomainError("version_conflict", "Closing changed since it was loaded.", 409);
      }
      const existingRelations = existing
        ? await loadClosingRelations(transaction, input.session.workspaceId, [existing.id])
        : null;
      const projectId = requiredUuid(input.payload.projectId ?? existing?.projectId, "projectId");
      const targetKind = enumValue(input.payload.targetKind ?? existing?.targetKind, "targetKind", ["listing", "unit"] as const);
      const targetId = requiredUuid(input.payload.targetId ?? (existing?.sellerListingId ?? existing?.unitId), "targetId");
      const dealId = requiredUuid(input.payload.dealId ?? existing?.dealId, "dealId");
      const buyerContactId = requiredUuid(input.payload.buyerContactId ?? existing?.buyerContactId, "buyerContactId");
      const sellerContactId = requiredUuid(input.payload.sellerContactId ?? existing?.sellerContactId, "sellerContactId");
      if (buyerContactId === sellerContactId) {
        throw new BrokerDomainError("closing_party_conflict", "Buyer and seller contacts must be different.");
      }
      const reservationId = optionalUuid(input.payload.reservationId ?? existing?.reservationId, "reservationId");
      const ownerUserId = optionalUuid(input.payload.ownerUserId ?? existing?.ownerUserId ?? input.session.userId, "ownerUserId");
      await assertBrokerRecordAccess({
        desiredOwnerUserId: ownerUserId,
        existingOwnerUserId: existing?.ownerUserId,
        projectId,
        session: input.session,
        transaction,
      });
      const status = enumValue(input.payload.status ?? existing?.status, "status", closingStatuses, "draft");
      const paymentStatus = enumValue(input.payload.paymentStatus ?? existing?.paymentStatus, "paymentStatus", paymentStatuses, "unpaid");
      if (existing) {
        assertMutableState(existing.status as (typeof closingStatuses)[number], ["cancelled", "reversed"], "closing");
        assertTransition(closingTransitions, existing.status as (typeof closingStatuses)[number], status, "closing");
        assertTransition(paymentTransitions, existing.paymentStatus as (typeof paymentStatuses)[number], paymentStatus, "payment");
      } else {
        assertInitialState(status, "draft", "closing");
        assertInitialState(paymentStatus, "unpaid", "closing payment");
      }
      if (status === "paid" && paymentStatus !== "paid") {
        throw new BrokerDomainError("payment_state_mismatch", "A paid closing requires paymentStatus paid.");
      }
      if (!["invoiced", "paid", "reversed"].includes(status) && paymentStatus !== "unpaid") {
        throw new BrokerDomainError("payment_state_mismatch", "Payment progress can only be recorded for invoiced or reversed closings.");
      }
      if (paymentStatus === "paid" && !["paid", "reversed"].includes(status)) {
        throw new BrokerDomainError("payment_state_mismatch", "paymentStatus paid requires closing status paid or reversed.");
      }
      if (paymentStatus === "refunded" && status !== "reversed") {
        throw new BrokerDomainError("payment_state_mismatch", "A refunded payment requires a reversed closing.");
      }
      const contractDate = dateOnly(input.payload.contractDate, "contractDate", dateFromDb(existing?.contractDate ?? null));
      const closingDate = dateOnly(input.payload.closingDate, "closingDate", dateFromDb(existing?.closingDate ?? null));
      if (["signed", "invoiced", "paid"].includes(status) && (!contractDate || !closingDate)) {
        throw new BrokerDomainError("closing_dates_required", "Signed and later closing states require contractDate and closingDate.");
      }
      const baseAmountMinor = parseMinorUnits(input.payload.baseAmountMinor ?? existing?.baseAmountMinor, "baseAmountMinor", { allowZero: true });
      const buyerCommissionMinor = parseMinorUnits(input.payload.buyerCommissionMinor ?? existing?.buyerCommissionMinor, "buyerCommissionMinor", { allowZero: true });
      const sellerCommissionMinor = parseMinorUnits(input.payload.sellerCommissionMinor ?? existing?.sellerCommissionMinor, "sellerCommissionMinor", { allowZero: true });
      const netCommissionMinor = parseMinorUnits(input.payload.netCommissionMinor ?? existing?.netCommissionMinor, "netCommissionMinor", { allowZero: true });
      const taxMinor = parseMinorUnits(input.payload.taxMinor ?? existing?.taxMinor, "taxMinor", { allowZero: true });
      const grossCommissionMinor = parseMinorUnits(input.payload.grossCommissionMinor ?? existing?.grossCommissionMinor, "grossCommissionMinor", { allowZero: true });
      validateClosingMoney({ baseAmountMinor, buyerCommissionMinor, grossCommissionMinor, netCommissionMinor, sellerCommissionMinor, taxMinor });
      const currency = requiredString(input.payload.currency ?? existing?.currency ?? "EUR", "currency", 3).toUpperCase();
      if (!/^[A-Z]{3}$/u.test(currency)) throw new BrokerDomainError("invalid_currency", "currency must be an ISO-style three-letter code.");
      const servicePeriodStart = dateOnly(input.payload.servicePeriodStart, "servicePeriodStart", dateFromDb(existing?.servicePeriodStart ?? null));
      const servicePeriodEnd = dateOnly(input.payload.servicePeriodEnd, "servicePeriodEnd", dateFromDb(existing?.servicePeriodEnd ?? null));
      if (servicePeriodStart && servicePeriodEnd && servicePeriodStart > servicePeriodEnd) {
        throw new BrokerDomainError("invalid_service_period", "servicePeriodStart cannot be after servicePeriodEnd.");
      }
      const reversalReason = optionalString(input.payload.reversalReason ?? existing?.reversalReason, 2_000);
      if (["cancelled", "reversed"].includes(status) && !reversalReason) {
        throw new BrokerDomainError("closing_reason_required", "A cancelled or reversed closing requires reversalReason.");
      }
      await assertProject(transaction, input.session, projectId);
      await Promise.all([
        assertReference(transaction, input.session, targetKind, targetId, projectId),
        assertReference(transaction, input.session, "deal", dealId, projectId),
        assertReference(transaction, input.session, "contact", buyerContactId, projectId),
        assertReference(transaction, input.session, "contact", sellerContactId, projectId),
        assertReference(transaction, input.session, "reservation", reservationId, projectId),
        assertReference(transaction, input.session, "owner", ownerUserId),
      ]);
      await assertClosingRelationshipValidity({
        buyerContactId,
        dealId,
        projectId,
        reservationId,
        sellerContactId,
        session: input.session,
        status,
        targetId,
        targetKind,
        transaction,
      });

      const participants = parseParticipants(input.payload.participants);
      if (participants) {
        await Promise.all(participants.map((participant) => assertReference(transaction, input.session, "owner", participant.userId)));
      }
      let validatedSplits = input.payload.commissionSplits === undefined
        ? null
        : validateCommissionSplits(
            { buyerCommissionMinor, sellerCommissionMinor },
            parseCommissionSplits(input.payload.commissionSplits, (value, field) => optionalUuid(value, field)),
          );
      if (!validatedSplits && existing) {
        const persisted = await transaction.query<{
          allocationType: "absolute" | "percentage";
          amountMinor: number | string | null;
          basisPoints: number | null;
          label: string | null;
          side: "buyer" | "seller" | "referral";
          sourceSide: "buyer" | "seller";
          userId: string | null;
        }>(
          `
            select allocation_type as "allocationType", amount_minor as "amountMinor",
              basis_points as "basisPoints", label, side, source_side as "sourceSide",
              user_id as "userId"
            from broker_commission_splits
            where workspace_id = $1::uuid and closing_id = $2::uuid
            order by created_at, id
          `,
          [input.session.workspaceId, existing.id],
        );
        if (persisted.length > 0) {
          validatedSplits = validateCommissionSplits({ buyerCommissionMinor, sellerCommissionMinor }, persisted.map((split) => ({
            ...split,
            amountMinor: split.amountMinor === null ? null : BigInt(split.amountMinor),
          })));
        }
      }
      if (!["draft", "cancelled"].includes(status) && (!validatedSplits || validatedSplits.length === 0)) {
        throw new BrokerDomainError("commission_splits_required", "Reviewed and later closings require a validated commission split.");
      }

      const contractType = enumValue(
        input.payload.contractType ?? existing?.contractType,
        "contractType",
        ["purchase", "rent", "lease", "other"] as const,
      );
      const paymentDueAt = dateOnly(input.payload.paymentDueAt, "paymentDueAt", dateFromDb(existing?.paymentDueAt ?? null));
      const internalNotes = cleanString(input.payload.internalNotes ?? existing?.internalNotes, 20_000);
      const commissionAmountsChanged = Boolean(existing) && (
        buyerCommissionMinor !== BigInt(existing!.buyerCommissionMinor) ||
        sellerCommissionMinor !== BigInt(existing!.sellerCommissionMinor)
      );
      if (existing && (
        ["signed", "invoiced", "paid", "reversed"].includes(existing.status) ||
        ["cancelled", "reversed"].includes(status)
      )) {
        const immutableCommercialFieldsChanged =
          projectId !== existing.projectId ||
          targetKind !== existing.targetKind ||
          targetId !== (existing.sellerListingId ?? existing.unitId) ||
          dealId !== existing.dealId ||
          buyerContactId !== existing.buyerContactId ||
          sellerContactId !== existing.sellerContactId ||
          reservationId !== existing.reservationId ||
          ownerUserId !== existing.ownerUserId ||
          contractType !== existing.contractType ||
          contractDate !== dateFromDb(existing.contractDate) ||
          closingDate !== dateFromDb(existing.closingDate) ||
          baseAmountMinor !== BigInt(existing.baseAmountMinor) ||
          buyerCommissionMinor !== BigInt(existing.buyerCommissionMinor) ||
          sellerCommissionMinor !== BigInt(existing.sellerCommissionMinor) ||
          netCommissionMinor !== BigInt(existing.netCommissionMinor) ||
          taxMinor !== BigInt(existing.taxMinor) ||
          grossCommissionMinor !== BigInt(existing.grossCommissionMinor) ||
          currency !== existing.currency;
        if (
          immutableCommercialFieldsChanged ||
          input.payload.commissionSplits !== undefined ||
          input.payload.participants !== undefined
        ) {
          throw new BrokerDomainError(
            "signed_closing_immutable",
            "Signed closing parties, contract facts, money and commission splits are immutable; reverse the closing instead.",
            409,
          );
        }
      }
      const row = existing
        ? await transaction.queryOne<ClosingRow>(
            `
              update broker_closings set
                project_id = $3::uuid, target_kind = $4, seller_listing_id = $5::uuid,
                unit_id = $6::uuid, deal_id = $7::uuid, buyer_contact_id = $8::uuid,
                seller_contact_id = $9::uuid, reservation_id = $10::uuid, owner_user_id = $11::uuid,
                contract_type = $12, contract_date = $13::date, closing_date = $14::date,
                base_amount_minor = $15::bigint, buyer_commission_minor = $16::bigint,
                seller_commission_minor = $17::bigint, net_commission_minor = $18::bigint,
                tax_minor = $19::bigint, gross_commission_minor = $20::bigint, currency = $21,
                service_period_start = $22::date, service_period_end = $23::date,
                payment_due_at = $24::date, payment_status = $25, status = $26,
                reversal_reason = $27, internal_notes = $28, version = version + 1,
                updated_by_user_id = $29::uuid, updated_at = now()
              where workspace_id = $1::uuid and id = $2::uuid and version = $30
              returning ${closingReturningSql}
            `,
            [input.session.workspaceId, existing.id, projectId, targetKind,
              targetKind === "listing" ? targetId : null, targetKind === "unit" ? targetId : null,
              dealId, buyerContactId, sellerContactId, reservationId, ownerUserId, contractType,
              contractDate, closingDate, baseAmountMinor.toString(), buyerCommissionMinor.toString(),
              sellerCommissionMinor.toString(), netCommissionMinor.toString(), taxMinor.toString(),
              grossCommissionMinor.toString(), currency, servicePeriodStart, servicePeriodEnd,
              paymentDueAt, paymentStatus, status, reversalReason, internalNotes, input.session.userId,
              Number(existing.version)],
          )
        : await transaction.queryOne<ClosingRow>(
            `
              insert into broker_closings (
                workspace_id, project_id, target_kind, seller_listing_id, unit_id, deal_id,
                buyer_contact_id, seller_contact_id, reservation_id, owner_user_id, contract_type,
                contract_date, closing_date, base_amount_minor, buyer_commission_minor,
                seller_commission_minor, net_commission_minor, tax_minor, gross_commission_minor,
                currency, service_period_start, service_period_end, payment_due_at, payment_status,
                status, reversal_reason, internal_notes, created_by_user_id, updated_by_user_id
              ) values ($1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6::uuid,
                $7::uuid, $8::uuid, $9::uuid, $10::uuid, $11, $12::date, $13::date,
                $14::bigint, $15::bigint, $16::bigint, $17::bigint, $18::bigint, $19::bigint,
                $20, $21::date, $22::date, $23::date, $24, 'draft', $25, $26,
                $27::uuid, $27::uuid)
              returning ${closingReturningSql}
            `,
            [input.session.workspaceId, projectId, targetKind,
              targetKind === "listing" ? targetId : null, targetKind === "unit" ? targetId : null,
              dealId, buyerContactId, sellerContactId, reservationId, ownerUserId, contractType,
              contractDate, closingDate, baseAmountMinor.toString(), buyerCommissionMinor.toString(),
              sellerCommissionMinor.toString(), netCommissionMinor.toString(), taxMinor.toString(),
              grossCommissionMinor.toString(), currency, servicePeriodStart, servicePeriodEnd,
              paymentDueAt, paymentStatus, reversalReason, internalNotes, input.session.userId],
          );
      if (!row) throw new BrokerDomainError("version_conflict", "Closing changed concurrently.", 409);

      if (participants !== null) {
        await transaction.execute(
          `delete from broker_closing_participants where workspace_id = $1::uuid and closing_id = $2::uuid`,
          [input.session.workspaceId, row.id],
        );
        for (const participant of participants) {
          await transaction.execute(
            `
              insert into broker_closing_participants (
                workspace_id, project_id, closing_id, user_id, participant_role
              ) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5)
            `,
            [input.session.workspaceId, projectId, row.id, participant.userId, participant.participantRole],
          );
        }
      }
      if (validatedSplits && (input.payload.commissionSplits !== undefined || commissionAmountsChanged)) {
        await transaction.execute(
          `delete from broker_commission_splits where workspace_id = $1::uuid and closing_id = $2::uuid`,
          [input.session.workspaceId, row.id],
        );
        for (const split of validatedSplits) {
          await assertReference(transaction, input.session, "owner", split.userId);
          await transaction.execute(
            `
              insert into broker_commission_splits (
                workspace_id, project_id, closing_id, user_id, label, side, source_side,
                allocation_type, basis_points, amount_minor, computed_amount_minor, created_by_user_id
              ) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7,
                $8, $9, $10::bigint, $11::bigint, $12::uuid)
            `,
            [input.session.workspaceId, projectId, row.id, split.userId, split.label, split.side,
              split.sourceSide, split.allocationType, split.basisPoints, split.amountMinor?.toString() ?? null,
              split.computedAmountMinor.toString(), input.session.userId],
          );
        }
      }
      const relations = await loadClosingRelations(transaction, input.session.workspaceId, [row.id]);
      const saved = toClosing(row, {
        financialsVisible: true,
        participants: relations.participants.get(row.id),
        splits: relations.splits.get(row.id),
      });
      await writeAuditLog({
        action: existing ? `broker.closing.${status}` : "broker.closing.created",
        after: saved,
        before: existing ? toClosing(existing, {
          financialsVisible: true,
          participants: existingRelations?.participants.get(existing.id),
          splits: existingRelations?.splits.get(existing.id),
        }) : null,
        dealId,
        entityId: row.id,
        entityType: "broker_closing",
        projectId,
        session: input.session,
        transaction,
      });
      // Deliberately no property_units, property_reservations or deals update:
      // their relationship synchronization remains centrally LAUNCH-OFF.
      return { data: saved, entityId: row.id, httpStatus: existing ? 200 : 201 };
    },
  });
}
