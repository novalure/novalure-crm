import type { AppSession } from "@/lib/auth/session";
import type {
  CalendarEvent,
  Contact,
  CrmBot,
  Deal,
  DealCloseReasonCategory,
  DealStage,
  DealStageHistoryEntry,
  Funnel,
  FunnelStep,
  Lead,
  LeadSource,
  NewsletterCampaign,
  Project,
  Task,
} from "@/lib/crm-types";
import { writeCrmAnalyticsEvent } from "@/lib/db/analytics-event-repositories";
import { syncBrokerEntityForLead } from "@/lib/db/broker-entity-repositories";
import { hasDatabaseUrl, queryOne, queryRows } from "@/lib/db/client";
import { recordSpeedToLeadEvent } from "@/lib/db/speed-to-lead-repositories";
import { canPersist, isUuid, writeAuditLog } from "@/lib/db/runtime-repositories";
import { queueDealStageChangeGoogleNotification } from "@/lib/db/google-notification-repositories";
import { ensureProjectDefaultPipelines } from "@/lib/db/pipeline-default-repositories";
import { queueDealStageChangeTeamsNotification } from "@/lib/db/teams-notification-repositories";
import { defaultLanguage, getLocale } from "@/lib/i18n";
import {
  isCalendarProviderChoice,
  isWorkspaceCustomerType,
  isWorkspaceOperatingModel,
  isWorkspaceTeamStructure,
} from "@/lib/product-model";

type IdRow = { id: string };

type CountRow = { count: number | string };

type DashboardViewRow = {
  filters: unknown;
  id: string;
  isDefault: boolean;
  layout: unknown;
  name: string;
  projectId: string | null;
  updatedAt: string | Date;
};

type DealRow = {
  closedAt: string | Date | null;
  contactId: string | null;
  expectedCloseDate: string | Date | null;
  id: string;
  leadId: string | null;
  lostAt: string | Date | null;
  lostReasonCategory: DealCloseReasonCategory | null;
  lostReasonDetail: string | null;
  name: string;
  nextAction: string;
  organizationId: string | null;
  ownerUserId: string | null;
  probability: number | string;
  projectId: string | null;
  riskLevel: Deal["riskLevel"];
  source: LeadSource;
  stage: DealStage;
  valueCents: number | string;
  workspaceId: string;
};

type DealStageHistoryRow = {
  changedAt: string | Date;
  changedByName: string | null;
  changedByUserId: string | null;
  dealId: string;
  fromStage: DealStage | null;
  id: string;
  projectId: string | null;
  reason: string | null;
  reasonCategory: DealCloseReasonCategory | null;
  reasonDetail: string | null;
  toStage: DealStage;
  workspaceId: string;
};

type PipelinePermissionRow = {
  canCloseDeals: boolean;
  canEditDeals: boolean;
  canMoveDeals: boolean;
  canReopenDeals: boolean;
};

type PipelineStageValidationRow = {
  category: string;
  name: string;
  probability: number | string;
};

type CountPipelineStageRow = {
  count: number | string;
};

type BotPublishEvaluationRow = {
  hallucinationFailures: number | string;
  handoffFailures: number | string;
  redTeamFailures: number | string;
  score: number | string;
  sourceCoverage: number | string;
};

type ContactRow = {
  consent: string;
  email: string | null;
  id: string;
  intent: string;
  name: string;
  organizationId: string | null;
  phone: string | null;
  project: string | null;
  projectId: string | null;
  role: Contact["role"];
  source: Contact["source"];
  workspaceId: string;
};

type LeadRow = {
  areaSqm: number | string | null;
  assignedToUserId: string | null;
  budget: string | null;
  buyerProfile: Lead["buyerProfile"] | null;
  contactId: string | null;
  hotStatus: boolean;
  id: string;
  intent: string;
  investorProfile: Lead["investorProfile"] | null;
  lastContactAt: string | Date | null;
  nextAction: string;
  nextContactAt: string | Date | null;
  objectType: Lead["objectType"] | null;
  projectId: string | null;
  receivedAt: string | Date;
  region: Lead["region"] | null;
  rooms: number | string | null;
  score: number | string;
  sellerProfile: Lead["sellerProfile"] | null;
  slaDueAt: string | Date | null;
  source: Lead["source"];
  status: Lead["status"];
  type: Lead["type"];
  workspaceId: string;
};

type TaskRow = {
  contactId: string | null;
  due: string | Date | null;
  id: string;
  leadId: string | null;
  ownerUserId: string | null;
  priority: Task["priority"];
  project: string | null;
  projectId: string | null;
  status: Task["status"];
  title: string;
  workspaceId: string;
};

type FunnelRow = {
  audience: Funnel["audience"];
  conversionRate: number | string;
  entryChannel: Funnel["entryChannel"];
  goal: string;
  id: string;
  leads: number | string;
  name: string;
  ownerUserId: string | null;
  projectId: string | null;
  status: Funnel["status"];
  visits: number | string;
  workspaceId: string;
};

type NoteRow = {
  channel: string;
  contactId: string;
  detail: string;
  id: string;
  metadata: Record<string, unknown> | null;
  occurredAt: string | Date;
  organizationId: string | null;
  outcome: "offen" | "erledigt" | "risiko" | "info";
  projectId: string | null;
  title: string;
  workspaceId: string;
};

type CalendarEventWriteRow = {
  contactId: string | null;
  endsAt: string | Date;
  id: string;
  leadId: string | null;
  location: string;
  metadata: Record<string, unknown> | null;
  outcomeGoal: string;
  ownerUserId: string | null;
  preparation: unknown;
  projectId: string | null;
  startsAt: string | Date;
  status: string;
  teamsJoinUrl: string | null;
  title: string;
  workspaceId: string;
};

type ProjectWriteRow = {
  customerType: Project["customerType"] | null;
  defaultOperatingModel: Project["defaultOperatingModel"] | null;
  defaultPipelineId: string | null;
  id: string;
  name: string;
  setupDefaults: Project["setupDefaults"] | null;
  status: Project["status"];
  type: string;
  workspaceId: string;
};

export type DashboardViewRecord = {
  filters: unknown;
  id: string;
  isDefault: boolean;
  layout: unknown[];
  name: string;
  projectId?: string;
  updatedAt: string;
  widgets: string[];
};

export type RepositoryWriteResult<T> =
  | { data: T; persisted: true }
  | { persisted: false; reason: string };

export type CrmNoteRecord = {
  contactId: string;
  detail: string;
  id: string;
  leadId?: string;
  occurredAt: string;
  outcome: "offen" | "erledigt" | "risiko" | "info";
  projectId?: string;
  title: string;
  workspaceId: string;
};

export function normalizeWriteProjectId(value: unknown) {
  return typeof value === "string" && isUuid(value) ? value : null;
}

function canManageWorkspaceRecords(session: AppSession) {
  if (session.role === "owner" || session.role === "admin") return true;

  return [
    "platform_admin",
    "novalure_onboarding",
    "novalure_customer_success",
    "novalure_operator",
    "customer_owner",
    "workspace_admin",
    "team_member",
  ].includes(session.productRole);
}

function isOwnRecordOnlySession(session: AppSession) {
  return session.productRole === "broker_agent";
}

function isProjectScopedSalesSession(session: AppSession) {
  return session.productRole === "developer_sales" || session.productRole === "project_sales_member";
}

async function hasProjectEditPermission(input: { projectId: string | null | undefined; session: AppSession }) {
  if (!isUuid(input.session.userId) || !isUuid(input.projectId)) return false;

  try {
    const permission = await queryOne<{ canEditDeals: boolean }>(
      `
        select can_edit_deals as "canEditDeals"
        from project_pipeline_permissions
        where workspace_id = $1
          and project_id = $2
          and user_id = $3
        limit 1
      `,
      [input.session.workspaceId, input.projectId, input.session.userId],
    );

    return Boolean(permission?.canEditDeals);
  } catch {
    return false;
  }
}

async function assertRecordWriteAccess(input: {
  entityLabel: string;
  existingOwnerUserId?: string | null;
  ownerUserId?: string | null;
  projectId?: string | null;
  session: AppSession;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (canManageWorkspaceRecords(input.session)) {
    return { ok: true };
  }

  const effectiveOwnerUserId = input.existingOwnerUserId ?? input.ownerUserId ?? null;

  if (isOwnRecordOnlySession(input.session)) {
    return effectiveOwnerUserId === input.session.userId
      ? { ok: true }
      : { ok: false, reason: `${input.entityLabel} can only be changed by the assigned owner` };
  }

  if (isProjectScopedSalesSession(input.session)) {
    if (effectiveOwnerUserId === input.session.userId) {
      return { ok: true };
    }

    return await hasProjectEditPermission({ projectId: input.projectId, session: input.session })
      ? { ok: true }
      : { ok: false, reason: `${input.entityLabel} requires project edit permission` };
  }

  return { ok: false, reason: `${input.entityLabel} write permission is not allowed for this role` };
}

const dealStages: DealStage[] = [
  "Neu",
  "Qualifizieren",
  "Termin vereinbaren",
  "Termin gebucht",
  "Besichtigung/Beratung",
  "Beratung / Besichtigung",
  "Besichtigung / Bewertung",
  "Angebot/Reservierung",
  "Reservierung",
  "Angebot / Mandat",
  "Abschlussprüfung",
  "Abschlusspruefung",
  "Vertragsprüfung",
  "Vertragspruefung",
  "Anfrage",
  "Audit geplant",
  "Angebot",
  "Onboarding",
  "Aktiv",
  "Pausiert / Verloren",
  "Gewonnen",
  "Verloren",
  "Disqualifiziert",
];

const dealCloseReasonCategories: DealCloseReasonCategory[] = [
  "budget",
  "timing",
  "competitor",
  "no_response",
  "not_qualified",
  "project_mismatch",
  "duplicate",
  "won",
  "other",
];
const maxShortTextLength = 180;
const maxLongTextLength = 1200;
const maxDealValueCents = 500_000_000 * 100;

function hasExplicitInput(value: unknown) {
  return value !== undefined && value !== null && String(value).trim().length > 0;
}

function isValidEmailAddress(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validateTextLength(value: unknown, field: string, maxLength: number) {
  if (!hasExplicitInput(value)) return null;
  return String(value).trim().length <= maxLength ? null : `${field} is too long`;
}

function validateEmailInput(value: unknown) {
  if (!hasExplicitInput(value)) return null;
  const email = String(value).trim();
  return isValidEmailAddress(email) ? null : "Invalid email address";
}

function validateDealValueInput(value: unknown) {
  if (!hasExplicitInput(value)) return null;
  const cents = toCents(value);
  if (cents <= 0) return "Deal value must be greater than zero";
  if (cents > maxDealValueCents) return "Deal value is implausibly high";
  return null;
}

function validateFutureDateInput(value: unknown, field: string) {
  if (!hasExplicitInput(value)) return null;
  const parsed = new Date(cleanDateInput(value)).getTime();
  if (!Number.isFinite(parsed)) return `${field} is invalid`;
  return parsed >= Date.now() - 60_000 ? null : `${field} cannot be in the past`;
}

export async function listDashboardViews(input: {
  session: AppSession;
}): Promise<{ source: "database" | "fallback"; views: DashboardViewRecord[]; error?: string }> {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return { source: "fallback", views: [] };
  }

  try {
    const rows = await queryRows<DashboardViewRow>(
      `
        select
          id,
          project_id as "projectId",
          name,
          filters,
          layout,
          is_default as "isDefault",
          updated_at as "updatedAt"
        from dashboard_views
        where workspace_id = $1
          and (user_id is null or user_id = $2::uuid)
        order by is_default desc, updated_at desc
        limit 100
      `,
      [input.session.workspaceId, isUuid(input.session.userId) ? input.session.userId : null],
    );

    return { source: "database", views: rows.map(toDashboardViewRecord) };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Dashboard views could not be loaded",
      source: "fallback",
      views: [],
    };
  }
}

export async function upsertDashboardView(input: {
  filters: unknown;
  id?: string;
  isDefault?: boolean;
  layout: unknown[];
  name: string;
  projectId?: string | null;
  session: AppSession;
  widgets: string[];
}): Promise<RepositoryWriteResult<DashboardViewRecord>> {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return { persisted: false, reason: "DATABASE_URL is not configured" };
  }

  const name = cleanString(input.name);
  if (!name) return { persisted: false, reason: "Dashboard view name is required" };

  const userId = isUuid(input.session.userId) ? input.session.userId : null;
  const projectId = normalizeWriteProjectId(input.projectId);
  const existingId = await resolveDashboardViewId({
    id: input.id,
    name,
    projectId,
    session: input.session,
    userId,
  });

  if (input.isDefault) {
    await queryOne<IdRow>(
      `
        update dashboard_views
        set is_default = false, updated_at = now()
        where workspace_id = $1
          and (user_id is null or user_id = $2::uuid)
          and project_id is not distinct from $3::uuid
        returning id
      `,
      [input.session.workspaceId, userId, projectId],
    );
  }

  const layoutPayload = {
    layout: Array.isArray(input.layout) ? input.layout : [],
    savedAt: new Date().toISOString(),
    widgets: Array.isArray(input.widgets) ? input.widgets : [],
  };
  const filters = input.filters && typeof input.filters === "object" ? input.filters : {};
  const row = existingId
    ? await queryOne<DashboardViewRow>(
        `
          update dashboard_views
          set
            project_id = $4::uuid,
            name = $5,
            filters = $6::jsonb,
            layout = $7::jsonb,
            is_default = $8,
            updated_at = now()
          where id = $1 and workspace_id = $2 and (user_id is null or user_id = $3::uuid)
          returning
            id,
            project_id as "projectId",
            name,
            filters,
            layout,
            is_default as "isDefault",
            updated_at as "updatedAt"
        `,
        [
          existingId,
          input.session.workspaceId,
          userId,
          projectId,
          name,
          JSON.stringify(filters),
          JSON.stringify(layoutPayload),
          Boolean(input.isDefault),
        ],
      )
    : await queryOne<DashboardViewRow>(
        `
          insert into dashboard_views (
            workspace_id,
            user_id,
            project_id,
            name,
            filters,
            layout,
            is_default
          )
          values ($1, $2::uuid, $3::uuid, $4, $5::jsonb, $6::jsonb, $7)
          returning
            id,
            project_id as "projectId",
            name,
            filters,
            layout,
            is_default as "isDefault",
            updated_at as "updatedAt"
        `,
        [
          input.session.workspaceId,
          userId,
          projectId,
          name,
          JSON.stringify(filters),
          JSON.stringify(layoutPayload),
          Boolean(input.isDefault),
        ],
      );

  if (!row) return { persisted: false, reason: "Dashboard view could not be saved" };

  await Promise.all([
    writeAuditLog({
      action: existingId ? "dashboard_view.updated" : "dashboard_view.created",
      after: {
        filters,
        projectId,
        userId,
        widgets: layoutPayload.widgets,
      },
      entityId: row.id,
      entityType: "dashboard_view",
      session: input.session,
    }),
    recordAnalyticsEvent({
      entityId: row.id,
      entityType: "dashboard_view",
      eventType: existingId ? "dashboard_view_updated" : "dashboard_view_created",
      metadata: { viewId: row.id, widgets: layoutPayload.widgets },
      module: "dashboard",
      projectId,
      session: input.session,
      source: "crm_dashboard",
    }),
  ]);

  return { data: toDashboardViewRecord(row), persisted: true };
}

export async function upsertDealRecord(input: {
  deal: Partial<Deal>;
  reason?: string;
  reasonCategory?: unknown;
  reasonDetail?: string;
  session: AppSession;
}): Promise<RepositoryWriteResult<Deal>> {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return { persisted: false, reason: "DATABASE_URL is not configured" };
  }

  const validationError =
    validateTextLength(input.deal.name, "Deal name", maxShortTextLength) ??
    validateTextLength(input.deal.nextAction, "Next action", maxLongTextLength) ??
    validateDealValueInput(input.deal.value);
  if (validationError) return { persisted: false, reason: validationError };

  const existing = isUuid(input.deal.id)
    ? await queryOne<DealRow>(
        `${dealSelectSql}
        where d.id = $1 and d.workspace_id = $2
        limit 1`,
        [input.deal.id, input.session.workspaceId],
      )
    : null;
  const contact = await resolveContactForWrite(input.session.workspaceId, input.deal.contactId ?? existing?.contactId);
  const projectId = normalizeWriteProjectId(input.deal.projectId) ?? existing?.projectId ?? contact?.projectId ?? null;
  const ownerUserId = normalizeWriteProjectId(input.deal.ownerUserId) ?? existing?.ownerUserId ?? normalizeWriteProjectId(input.session.userId);
  const contactId = contact?.id ?? existing?.contactId ?? null;
  const stageResult = await resolveValidDealStageForWrite({
    projectId,
    requestedStage: input.deal.stage,
    session: input.session,
    fallbackStage: existing?.stage ?? "Neu",
  });
  if (!stageResult.ok) return { persisted: false, reason: stageResult.reason };
  const stage = stageResult.stage;
  const valueCents = toCents(input.deal.value ?? (existing ? formatEuroFromCents(existing.valueCents) : "0"));
  const probability = clampNumber(input.deal.probability ?? existing?.probability ?? 50, 0, 100);
  const riskLevel = normalizeRiskLevel(input.deal.riskLevel ?? existing?.riskLevel, probability);
  const source = cleanString(input.deal.source) || existing?.source || contact?.source || "Manual";
  const name = cleanString(input.deal.name) || existing?.name || (contact ? `${contact.name} Deal` : "");

  if (!name || (!existing && !contactId)) {
    return { persisted: false, reason: "Deal name and contact are required" };
  }

  const writeAccess = await assertRecordWriteAccess({
    entityLabel: "Deal",
    existingOwnerUserId: existing?.ownerUserId,
    ownerUserId,
    projectId,
    session: input.session,
  });
  if (!writeAccess.ok) return { persisted: false, reason: writeAccess.reason };

  const stageChanged = Boolean(existing && existing.stage !== stage);
  const closeState = resolveDealCloseState({
    existing,
    reason: input.reason,
    reasonCategory: input.reasonCategory,
    reasonDetail: input.reasonDetail,
    stageChanged: stageChanged || !existing,
    targetStage: stage,
  });
  if (!closeState.ok) {
    return { persisted: false, reason: closeState.reason };
  }

  if (stageChanged && existing) {
    const permission = await assertPipelineStagePermission({
      deal: existing,
      session: input.session,
      targetStage: stage,
    });
    if (!permission.ok) {
      return { persisted: false, reason: permission.reason };
    }
  }

  const row = existing
    ? await queryOne<DealRow>(
        `${dealUpdateSql}
        where id = $1 and workspace_id = $2
        returning
          id,
          workspace_id as "workspaceId",
          project_id as "projectId",
          contact_id as "contactId",
          organization_id as "organizationId",
          owner_user_id as "ownerUserId",
          lead_id as "leadId",
          name,
          stage,
          value_cents as "valueCents",
          probability,
          expected_close_date::text as "expectedCloseDate",
          lost_reason_category as "lostReasonCategory",
          lost_reason_detail as "lostReasonDetail",
          lost_at as "lostAt",
          closed_at as "closedAt",
          risk_level as "riskLevel",
          source,
          next_action as "nextAction"`,
        [
          existing.id,
          input.session.workspaceId,
          projectId,
          contactId,
          normalizeWriteProjectId(input.deal.organizationId) ?? existing.organizationId,
          ownerUserId,
          normalizeWriteProjectId(input.deal.leadId) ?? existing.leadId,
          name,
          stage,
          valueCents,
          probability,
          normalizeDateOnly(input.deal.expectedCloseDate) || normalizeDateOnly(existing.expectedCloseDate) || null,
          riskLevel,
          source,
          cleanString(input.deal.nextAction) || existing.nextAction,
          JSON.stringify({ updatedFrom: "crm_pipeline", updatedByUserId: input.session.userId }),
          closeState.data.lostReasonCategory,
          closeState.data.lostReasonDetail,
          closeState.data.lostAt,
          closeState.data.closedAt,
        ],
      )
    : await queryOne<DealRow>(
        `
          insert into deals (
            workspace_id,
            project_id,
            contact_id,
            organization_id,
            owner_user_id,
            lead_id,
            name,
            stage,
            value_cents,
            probability,
            expected_close_date,
            lost_reason_category,
            lost_reason_detail,
            lost_at,
            closed_at,
            risk_level,
            source,
            next_action,
            metadata
          )
          values (
            $1,
            $2::uuid,
            $3::uuid,
            $4::uuid,
            $5::uuid,
            $6::uuid,
            $7,
            $8,
            $9,
            $10,
            $11::date,
            $12,
            $13,
            $14::timestamptz,
            $15::timestamptz,
            $16,
            $17,
            $18,
            $19::jsonb
          )
          returning
            id,
            workspace_id as "workspaceId",
            project_id as "projectId",
            contact_id as "contactId",
            organization_id as "organizationId",
            owner_user_id as "ownerUserId",
            lead_id as "leadId",
            name,
            stage,
            value_cents as "valueCents",
            probability,
            expected_close_date::text as "expectedCloseDate",
            lost_reason_category as "lostReasonCategory",
            lost_reason_detail as "lostReasonDetail",
            lost_at as "lostAt",
            closed_at as "closedAt",
            risk_level as "riskLevel",
            source,
            next_action as "nextAction"
        `,
        [
          input.session.workspaceId,
          projectId,
          contactId,
          normalizeWriteProjectId(input.deal.organizationId),
          ownerUserId,
          normalizeWriteProjectId(input.deal.leadId),
          name,
          stage,
          valueCents,
          probability,
          normalizeDateOnly(input.deal.expectedCloseDate) || null,
          closeState.data.lostReasonCategory,
          closeState.data.lostReasonDetail,
          closeState.data.lostAt,
          closeState.data.closedAt,
          riskLevel,
          source,
          cleanString(input.deal.nextAction) || "Deal nächsten Schritt planen",
          JSON.stringify({ createdFrom: "crm_pipeline", legacyId: input.deal.id ?? null }),
        ],
      );

  if (!row) return { persisted: false, reason: "Deal could not be saved" };

  if (stageChanged || !existing) {
    await insertDealStageHistory({
      dealId: row.id,
      fromStage: existing?.stage ?? null,
      projectId: row.projectId,
      reason: input.reason,
      reasonCategory: closeState.data.lostReasonCategory,
      reasonDetail: closeState.data.lostReasonDetail,
      session: input.session,
      toStage: row.stage,
    });
  }

  await Promise.all([
    writeAuditLog({
      action: existing ? "deal.updated" : "deal.created",
      after: toDeal(row),
      before: existing ? toDeal(existing) : null,
      dealId: row.id,
      entityId: row.id,
      entityType: "deal",
      projectId: row.projectId,
      session: input.session,
    }),
    recordAnalyticsEvent({
      dealId: row.id,
      entityId: row.id,
      entityType: "deal",
      eventType: stageChanged ? "deal_stage_changed" : existing ? "deal_updated" : "deal_created",
      metadata: {
        fromStage: existing?.stage ?? null,
        reason: input.reason ?? null,
        reasonCategory: closeState.data.lostReasonCategory,
        stage: row.stage,
      },
      module: "pipeline",
      projectId: row.projectId,
      session: input.session,
      source: row.source,
      valueCents,
    }),
    stageChanged || !existing
      ? recordDealOutcomeAnalyticsEvent({
          deal: row,
          fromStage: existing?.stage ?? null,
          reason: input.reason,
          session: input.session,
          valueCents,
        })
      : null,
  ]);

  return { data: toDeal(row), persisted: true };
}

export async function listDealStageHistory(input: {
  dealId: string;
  session: AppSession;
}): Promise<{ history: DealStageHistoryEntry[]; source: "database" | "fallback"; error?: string }> {
  if (!canPersist() || !isUuid(input.session.workspaceId) || !isUuid(input.dealId)) {
    return { history: [], source: "fallback" };
  }

  try {
    const rows = await queryRows<DealStageHistoryRow>(
      `
        select
          h.id,
          h.workspace_id as "workspaceId",
          h.project_id as "projectId",
          h.deal_id as "dealId",
          h.from_stage as "fromStage",
          h.to_stage as "toStage",
          h.changed_by_user_id as "changedByUserId",
          wu.name as "changedByName",
          h.reason,
          h.reason_category as "reasonCategory",
          h.reason_detail as "reasonDetail",
          h.changed_at as "changedAt"
        from deal_stage_history h
        join deals d on d.id = h.deal_id and d.workspace_id = h.workspace_id
        left join workspace_users wu on wu.id = h.changed_by_user_id
        where h.workspace_id = $1 and h.deal_id = $2
        order by h.changed_at desc
      `,
      [input.session.workspaceId, input.dealId],
    );

    return { history: rows.map(toDealStageHistoryEntry), source: "database" };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Deal stage history could not be loaded",
      history: [],
      source: "fallback",
    };
  }
}

export async function changeDealStageRecord(input: {
  dealId: string;
  reason?: string;
  reasonCategory?: unknown;
  reasonDetail?: string;
  session: AppSession;
  toStage: unknown;
}): Promise<RepositoryWriteResult<{ deal: Deal; history: DealStageHistoryEntry | null }>> {
  if (!canPersist() || !isUuid(input.session.workspaceId) || !isUuid(input.dealId)) {
    return { persisted: false, reason: "DATABASE_URL is not configured" };
  }

  const existing = await queryOne<DealRow>(
    `${dealSelectSql}
    where d.id = $1 and d.workspace_id = $2
    limit 1`,
    [input.dealId, input.session.workspaceId],
  );
  if (!existing) return { persisted: false, reason: "Deal not found" };

  const stageResult = await resolveValidDealStageForWrite({
    projectId: existing.projectId,
    requestedStage: input.toStage,
    session: input.session,
  });
  if (!stageResult.ok) return { persisted: false, reason: stageResult.reason };
  const targetStage = stageResult.stage;

  if (existing.stage === targetStage && !cleanString(input.reason) && !cleanString(input.reasonDetail)) {
    return { data: { deal: toDeal(existing), history: null }, persisted: true };
  }

  const permission = await assertPipelineStagePermission({
    deal: existing,
    session: input.session,
    targetStage,
  });
  if (!permission.ok) return { persisted: false, reason: permission.reason };

  const closeState = resolveDealCloseState({
    existing,
    reason: input.reason,
    reasonCategory: input.reasonCategory,
    reasonDetail: input.reasonDetail,
    stageChanged: true,
    targetStage,
  });
  if (!closeState.ok) return { persisted: false, reason: closeState.reason };

  const row = await queryOne<DealRow>(
    `
      update deals
      set
        stage = $3,
        lost_reason_category = $4,
        lost_reason_detail = $5,
        lost_at = $6::timestamptz,
        closed_at = $7::timestamptz,
        metadata = metadata || $8::jsonb,
        updated_at = now()
      where id = $1 and workspace_id = $2
      returning
        id,
        workspace_id as "workspaceId",
        project_id as "projectId",
        contact_id as "contactId",
        organization_id as "organizationId",
        owner_user_id as "ownerUserId",
        lead_id as "leadId",
        name,
        stage,
        value_cents as "valueCents",
        probability,
        expected_close_date::text as "expectedCloseDate",
        lost_reason_category as "lostReasonCategory",
        lost_reason_detail as "lostReasonDetail",
        lost_at as "lostAt",
        closed_at as "closedAt",
        risk_level as "riskLevel",
        source,
        next_action as "nextAction"
    `,
    [
      existing.id,
      input.session.workspaceId,
      targetStage,
      closeState.data.lostReasonCategory,
      closeState.data.lostReasonDetail,
      closeState.data.lostAt,
      closeState.data.closedAt,
      JSON.stringify({
        stageChangedByUserId: input.session.userId,
        stageChangedFrom: existing.stage,
        stageChangedTo: targetStage,
      }),
    ],
  );
  if (!row) return { persisted: false, reason: "Deal stage could not be saved" };

  const history = await insertDealStageHistory({
    dealId: row.id,
    fromStage: existing.stage,
    projectId: row.projectId,
    reason: input.reason,
    reasonCategory: closeState.data.lostReasonCategory,
    reasonDetail: closeState.data.lostReasonDetail,
    session: input.session,
    toStage: row.stage,
  });

  await Promise.all([
    writeAuditLog({
      action: "deal.stage_changed",
      after: {
        closedAt: row.closedAt,
        dealId: row.id,
        fromStage: existing.stage,
        lostAt: row.lostAt,
        lostReasonCategory: row.lostReasonCategory,
        lostReasonDetail: row.lostReasonDetail,
        projectId: row.projectId,
        toStage: row.stage,
        userId: input.session.userId,
      },
      before: {
        closedAt: existing.closedAt,
        lostAt: existing.lostAt,
        lostReasonCategory: existing.lostReasonCategory,
        lostReasonDetail: existing.lostReasonDetail,
        stage: existing.stage,
      },
      dealId: row.id,
      entityId: row.id,
      entityType: "deal",
      projectId: row.projectId,
      session: input.session,
    }),
    recordAnalyticsEvent({
      dealId: row.id,
      entityId: row.id,
      entityType: "deal",
      eventType: "deal_stage_changed",
      metadata: {
        fromStage: existing.stage,
        reason: input.reason ?? null,
        reasonCategory: row.lostReasonCategory,
        reasonDetail: row.lostReasonDetail,
        toStage: row.stage,
      },
      module: "pipeline",
      projectId: row.projectId,
      session: input.session,
      source: row.source,
      valueCents: Number(row.valueCents ?? 0),
    }),
    recordDealOutcomeAnalyticsEvent({
      deal: row,
      fromStage: existing.stage,
      reason: input.reason,
      session: input.session,
      valueCents: Number(row.valueCents ?? 0),
    }),
    queueDealStageChangeTeamsNotification({
      dealId: row.id,
      fromStage: existing.stage,
      historyId: history?.id ?? null,
      reason: input.reason ?? input.reasonDetail ?? null,
      session: input.session,
      toStage: row.stage,
    }),
    queueDealStageChangeGoogleNotification({
      dealId: row.id,
      fromStage: existing.stage,
      historyId: history?.id ?? null,
      reason: input.reason ?? input.reasonDetail ?? null,
      session: input.session,
      toStage: row.stage,
    }),
  ]);

  return { data: { deal: toDeal(row), history }, persisted: true };
}

export async function upsertTaskRecord(input: {
  session: AppSession;
  task: Partial<Task>;
}): Promise<RepositoryWriteResult<Task>> {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return { persisted: false, reason: "DATABASE_URL is not configured" };
  }

  const validationError = validateTextLength(input.task.title, "Task title", maxShortTextLength);
  if (validationError) return { persisted: false, reason: validationError };

  const existing = isUuid(input.task.id)
    ? await queryOne<TaskRow>(
        `${taskSelectSql}
        where t.id = $1 and t.workspace_id = $2
        limit 1`,
        [input.task.id, input.session.workspaceId],
      )
    : null;
  const projectId = normalizeWriteProjectId(input.task.projectId) ?? existing?.projectId ?? await resolveFallbackProjectId(input.session.workspaceId);
  const contactId = normalizeWriteProjectId(input.task.contactId) ?? existing?.contactId ?? null;
  const leadId = normalizeWriteProjectId(input.task.leadId) ?? existing?.leadId ?? null;
  const ownerUserId = existing?.ownerUserId ?? normalizeWriteProjectId(input.session.userId);
  const title = cleanString(input.task.title) || existing?.title || "";

  if (!title) return { persisted: false, reason: "Task title is required" };

  const writeAccess = await assertRecordWriteAccess({
    entityLabel: "Task",
    existingOwnerUserId: existing?.ownerUserId,
    ownerUserId,
    projectId,
    session: input.session,
  });
  if (!writeAccess.ok) return { persisted: false, reason: writeAccess.reason };

  const row = existing
    ? await queryOne<TaskRow>(
        `
          update tasks
          set
            project_id = $3::uuid,
            contact_id = $4::uuid,
            lead_id = $5::uuid,
            title = $6,
            due_at = $7::timestamptz,
            priority = $8,
            status = $9,
            metadata = metadata || $10::jsonb,
            updated_at = now()
          where id = $1 and workspace_id = $2
          returning
            id,
            workspace_id as "workspaceId",
            project_id as "projectId",
            contact_id as "contactId",
            lead_id as "leadId",
            owner_user_id as "ownerUserId",
            title,
            due_at as due,
            priority,
            status,
            (select name from projects p where p.id = tasks.project_id) as project
        `,
        [
          existing.id,
          input.session.workspaceId,
          projectId,
          contactId,
          leadId,
          title,
          cleanDateInput(input.task.due) || cleanDateInput(existing.due) || null,
          input.task.priority ?? existing.priority,
          input.task.status ?? existing.status,
          JSON.stringify({ updatedFrom: "crm_tasks", updatedByUserId: input.session.userId }),
        ],
      )
    : await queryOne<TaskRow>(
        `
          insert into tasks (
            workspace_id,
            project_id,
            contact_id,
            lead_id,
            owner_user_id,
            title,
            due_at,
            priority,
            status,
            metadata
          )
          values ($1, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7::timestamptz, $8, $9, $10::jsonb)
          returning
            id,
            workspace_id as "workspaceId",
            project_id as "projectId",
            contact_id as "contactId",
            lead_id as "leadId",
            owner_user_id as "ownerUserId",
            title,
            due_at as due,
            priority,
            status,
            (select name from projects p where p.id = tasks.project_id) as project
        `,
        [
          input.session.workspaceId,
          projectId,
          contactId,
          leadId,
          ownerUserId,
          title,
          cleanDateInput(input.task.due) || null,
          input.task.priority ?? "Normal",
          input.task.status ?? "open",
          JSON.stringify({ createdFrom: "crm_tasks", legacyId: input.task.id ?? null }),
        ],
      );

  if (!row) return { persisted: false, reason: "Task could not be saved" };

  await Promise.all([
    writeAuditLog({
      action: existing ? "task.updated" : "task.created",
      after: toTask(row),
      before: existing ? toTask(existing) : null,
      entityId: row.id,
      entityType: "task",
      session: input.session,
    }),
    recordAnalyticsEvent({
      entityId: row.id,
      entityType: "task",
      eventType: row.status === "done" ? "task_completed" : existing ? "task_updated" : "task_created",
      leadId: row.leadId,
      metadata: { priority: row.priority, status: row.status, title: row.title },
      module: "task",
      projectId: row.projectId,
      session: input.session,
      source: "crm_tasks",
    }),
  ]);

  return { data: toTask(row), persisted: true };
}

export async function listNoteRecords(input: {
  contactId?: string | null;
  leadId?: string | null;
  session: AppSession;
}): Promise<{ notes: CrmNoteRecord[]; persisted: true } | { persisted: false; reason: string }> {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return { persisted: false, reason: "DATABASE_URL is not configured" };
  }

  const leadId = normalizeWriteProjectId(input.leadId);
  const contactId = normalizeWriteProjectId(input.contactId);
  if (!leadId && !contactId) return { persisted: false, reason: "Lead or contact id is required" };

  const rows = await queryRows<NoteRow>(
    `
      select
        id,
        workspace_id as "workspaceId",
        contact_id as "contactId",
        project_id as "projectId",
        organization_id as "organizationId",
        channel,
        title,
        detail,
        outcome,
        occurred_at as "occurredAt",
        metadata
      from contact_timeline_items
      where workspace_id = $1
        and channel = 'Notiz'
        and ($2::uuid is null or metadata->>'leadId' = $2::text)
        and ($3::uuid is null or contact_id = $3::uuid)
      order by occurred_at desc
      limit 100
    `,
    [input.session.workspaceId, leadId, contactId],
  );

  return { notes: rows.map(toNoteRecord), persisted: true };
}

export async function upsertNoteRecord(input: {
  note: Record<string, unknown>;
  session: AppSession;
}): Promise<RepositoryWriteResult<CrmNoteRecord>> {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return { persisted: false, reason: "DATABASE_URL is not configured" };
  }

  const validationError =
    validateTextLength(input.note.title, "Note title", maxShortTextLength) ??
    validateTextLength(input.note.detail, "Note detail", maxLongTextLength);
  if (validationError) return { persisted: false, reason: validationError };

  const existing = isUuid(String(input.note.id ?? ""))
    ? await queryOne<NoteRow>(
        `
          select
            id,
            workspace_id as "workspaceId",
            contact_id as "contactId",
            project_id as "projectId",
            organization_id as "organizationId",
            channel,
            title,
            detail,
            outcome,
            occurred_at as "occurredAt",
            metadata
          from contact_timeline_items
          where id = $1 and workspace_id = $2 and channel = 'Notiz'
          limit 1
        `,
        [input.note.id, input.session.workspaceId],
      )
    : null;

  const leadId = normalizeWriteProjectId(input.note.leadId) ?? normalizeWriteProjectId(existing?.metadata?.leadId);
  const lead = leadId
    ? await queryOne<{
        assignedToUserId: string | null;
        contactId: string | null;
        projectId: string | null;
      }>(
        `
          select
            assigned_to_user_id as "assignedToUserId",
            contact_id as "contactId",
            project_id as "projectId"
          from leads
          where id = $1 and workspace_id = $2
          limit 1
        `,
        [leadId, input.session.workspaceId],
      )
    : null;
  if (leadId && !lead) return { persisted: false, reason: "Lead not found" };

  const requestedContactId =
    normalizeWriteProjectId(input.note.contactId) ??
    existing?.contactId ??
    lead?.contactId ??
    null;
  if (!requestedContactId) {
    return { persisted: false, reason: "Note requires a contact or a lead with contact" };
  }

  const contact = await queryOne<{ id: string; organizationId: string | null; projectId: string | null }>(
    `
      select id, organization_id as "organizationId", project_id as "projectId"
      from contacts
      where id = $1 and workspace_id = $2 and archived_at is null
      limit 1
    `,
    [requestedContactId, input.session.workspaceId],
  );
  if (!contact) return { persisted: false, reason: "Contact not found" };

  const projectId =
    normalizeWriteProjectId(input.note.projectId) ??
    existing?.projectId ??
    lead?.projectId ??
    contact.projectId ??
    null;
  const writeAccess = await assertRecordWriteAccess({
    entityLabel: "Note",
    existingOwnerUserId: lead?.assignedToUserId,
    ownerUserId: lead?.assignedToUserId ?? normalizeWriteProjectId(input.session.userId),
    projectId,
    session: input.session,
  });
  if (!writeAccess.ok) return { persisted: false, reason: writeAccess.reason };

  const detail = cleanString(input.note.detail);
  const title = cleanString(input.note.title) || detail.slice(0, maxShortTextLength) || existing?.title || "Notiz";
  if (!detail && !existing?.detail) return { persisted: false, reason: "Note detail is required" };

  const outcome = normalizeTimelineOutcome(input.note.outcome ?? existing?.outcome);
  const occurredAt =
    cleanDateInput(input.note.occurredAt) ||
    toIso(existing?.occurredAt ?? null) ||
    new Date().toISOString();
  const metadata = {
    ...(existing?.metadata ?? {}),
    ...asObject(input.note.metadata),
    leadId,
    source: "crm_notes",
    updatedByUserId: input.session.userId,
  };

  const row = existing
    ? await queryOne<NoteRow>(
        `
          update contact_timeline_items
          set
            contact_id = $3::uuid,
            project_id = $4::uuid,
            organization_id = $5::uuid,
            title = $6,
            detail = $7,
            outcome = $8,
            occurred_at = $9::timestamptz,
            metadata = $10::jsonb
          where id = $1 and workspace_id = $2 and channel = 'Notiz'
          returning
            id,
            workspace_id as "workspaceId",
            contact_id as "contactId",
            project_id as "projectId",
            organization_id as "organizationId",
            channel,
            title,
            detail,
            outcome,
            occurred_at as "occurredAt",
            metadata
        `,
        [
          existing.id,
          input.session.workspaceId,
          requestedContactId,
          projectId,
          contact.organizationId,
          title,
          detail || existing.detail,
          outcome,
          occurredAt,
          JSON.stringify(metadata),
        ],
      )
    : await queryOne<NoteRow>(
        `
          insert into contact_timeline_items (
            workspace_id,
            contact_id,
            project_id,
            organization_id,
            channel,
            title,
            detail,
            outcome,
            occurred_at,
            metadata
          )
          values ($1, $2::uuid, $3::uuid, $4::uuid, 'Notiz', $5, $6, $7, $8::timestamptz, $9::jsonb)
          returning
            id,
            workspace_id as "workspaceId",
            contact_id as "contactId",
            project_id as "projectId",
            organization_id as "organizationId",
            channel,
            title,
            detail,
            outcome,
            occurred_at as "occurredAt",
            metadata
        `,
        [
          input.session.workspaceId,
          requestedContactId,
          projectId,
          contact.organizationId,
          title,
          detail,
          outcome,
          occurredAt,
          JSON.stringify({ ...metadata, createdByUserId: input.session.userId }),
        ],
      );

  if (!row) return { persisted: false, reason: "Note could not be saved" };

  const note = toNoteRecord(row);
  await writeAuditLog({
    action: existing ? "note.updated" : "note.created",
    after: note,
    before: existing ? toNoteRecord(existing) : null,
    entityId: note.id,
    entityType: "note",
    projectId: note.projectId,
    session: input.session,
  });

  return { data: note, persisted: true };
}

export async function listCalendarEventRecords(input: {
  contactId?: string | null;
  leadId?: string | null;
  session: AppSession;
}): Promise<{ events: CalendarEvent[]; persisted: true } | { persisted: false; reason: string }> {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return { persisted: false, reason: "DATABASE_URL is not configured" };
  }

  const leadId = normalizeWriteProjectId(input.leadId);
  const contactId = normalizeWriteProjectId(input.contactId);
  if (!leadId && !contactId) return { persisted: false, reason: "Lead or contact id is required" };

  const rows = await queryRows<CalendarEventWriteRow>(
    `
      select
        id,
        workspace_id as "workspaceId",
        project_id as "projectId",
        contact_id as "contactId",
        lead_id as "leadId",
        owner_user_id as "ownerUserId",
        title,
        starts_at as "startsAt",
        ends_at as "endsAt",
        location,
        status,
        preparation,
        outcome_goal as "outcomeGoal",
        teams_join_url as "teamsJoinUrl",
        metadata
      from calendar_events
      where workspace_id = $1
        and ($2::uuid is null or lead_id = $2::uuid)
        and ($3::uuid is null or contact_id = $3::uuid)
      order by starts_at asc
      limit 100
    `,
    [input.session.workspaceId, leadId, contactId],
  );

  return { events: rows.map(toCalendarEventRecord), persisted: true };
}

export async function upsertCalendarEventRecord(input: {
  event: Record<string, unknown>;
  session: AppSession;
}): Promise<RepositoryWriteResult<CalendarEvent>> {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return { persisted: false, reason: "DATABASE_URL is not configured" };
  }

  const validationError =
    validateTextLength(input.event.title, "Calendar event title", maxShortTextLength) ??
    validateTextLength(input.event.outcomeGoal, "Calendar event outcome goal", maxLongTextLength);
  if (validationError) return { persisted: false, reason: validationError };

  const existing = isUuid(String(input.event.id ?? ""))
    ? await queryOne<CalendarEventWriteRow>(
        `
          select
            id,
            workspace_id as "workspaceId",
            project_id as "projectId",
            contact_id as "contactId",
            lead_id as "leadId",
            owner_user_id as "ownerUserId",
            title,
            starts_at as "startsAt",
            ends_at as "endsAt",
            location,
            status,
            preparation,
            outcome_goal as "outcomeGoal",
            teams_join_url as "teamsJoinUrl",
            metadata
          from calendar_events
          where id = $1 and workspace_id = $2
          limit 1
        `,
        [input.event.id, input.session.workspaceId],
      )
    : null;

  const leadId = normalizeWriteProjectId(input.event.leadId) ?? existing?.leadId ?? null;
  const lead = leadId
    ? await queryOne<{
        assignedToUserId: string | null;
        contactId: string | null;
        projectId: string | null;
      }>(
        `
          select
            assigned_to_user_id as "assignedToUserId",
            contact_id as "contactId",
            project_id as "projectId"
          from leads
          where id = $1 and workspace_id = $2
          limit 1
        `,
        [leadId, input.session.workspaceId],
      )
    : null;
  if (leadId && !lead) return { persisted: false, reason: "Lead not found" };

  const contactId = normalizeWriteProjectId(input.event.contactId) ?? existing?.contactId ?? lead?.contactId ?? null;
  const contact = contactId
    ? await queryOne<{ id: string; projectId: string | null }>(
        `
          select id, project_id as "projectId"
          from contacts
          where id = $1 and workspace_id = $2 and archived_at is null
          limit 1
        `,
        [contactId, input.session.workspaceId],
      )
    : null;
  if (contactId && !contact) return { persisted: false, reason: "Contact not found" };

  const projectId =
    normalizeWriteProjectId(input.event.projectId) ??
    existing?.projectId ??
    lead?.projectId ??
    contact?.projectId ??
    await resolveFallbackProjectId(input.session.workspaceId);
  const ownerUserId =
    normalizeWriteProjectId(input.event.ownerUserId) ??
    existing?.ownerUserId ??
    lead?.assignedToUserId ??
    normalizeWriteProjectId(input.session.userId);
  const title = cleanString(input.event.title) || existing?.title || "";
  if (!title) return { persisted: false, reason: "Calendar event title is required" };

  const startsAt = cleanDateInput(input.event.startsAt) || toIso(existing?.startsAt ?? null);
  const endsAt = cleanDateInput(input.event.endsAt) || toIso(existing?.endsAt ?? null);
  if (!startsAt || !endsAt) return { persisted: false, reason: "Calendar event start and end are required" };
  if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
    return { persisted: false, reason: "Calendar event end must be after start" };
  }

  const writeAccess = await assertRecordWriteAccess({
    entityLabel: "Calendar event",
    existingOwnerUserId: existing?.ownerUserId ?? lead?.assignedToUserId,
    ownerUserId,
    projectId,
    session: input.session,
  });
  if (!writeAccess.ok) return { persisted: false, reason: writeAccess.reason };

  const metadata = {
    ...(existing?.metadata ?? {}),
    ...asObject(input.event.metadata),
    calendarProvider: "manual",
    externalCommunication: false,
    meetingProvider: cleanString(input.event.meetingProvider) || "manual-link",
    source: "crm_internal_calendar_event",
    updatedByUserId: input.session.userId,
  };

  const row = existing
    ? await queryOne<CalendarEventWriteRow>(
        `
          update calendar_events
          set
            project_id = $3::uuid,
            contact_id = $4::uuid,
            lead_id = $5::uuid,
            owner_user_id = $6::uuid,
            title = $7,
            starts_at = $8::timestamptz,
            ends_at = $9::timestamptz,
            location = $10,
            status = $11,
            preparation = $12::jsonb,
            outcome_goal = $13,
            teams_join_url = null,
            metadata = $14::jsonb,
            updated_at = now()
          where id = $1 and workspace_id = $2
          returning
            id,
            workspace_id as "workspaceId",
            project_id as "projectId",
            contact_id as "contactId",
            lead_id as "leadId",
            owner_user_id as "ownerUserId",
            title,
            starts_at as "startsAt",
            ends_at as "endsAt",
            location,
            status,
            preparation,
            outcome_goal as "outcomeGoal",
            teams_join_url as "teamsJoinUrl",
            metadata
        `,
        [
          existing.id,
          input.session.workspaceId,
          projectId,
          contactId,
          leadId,
          ownerUserId,
          title,
          startsAt,
          endsAt,
          normalizeCalendarEventLocation(input.event.location ?? existing.location),
          normalizeCalendarEventStatus(input.event.status ?? existing.status),
          JSON.stringify(normalizeStringArray(input.event.preparation ?? existing.preparation)),
          cleanString(input.event.outcomeGoal) || existing.outcomeGoal || "",
          JSON.stringify(metadata),
        ],
      )
    : await queryOne<CalendarEventWriteRow>(
        `
          insert into calendar_events (
            workspace_id,
            project_id,
            contact_id,
            lead_id,
            owner_user_id,
            title,
            starts_at,
            ends_at,
            location,
            status,
            preparation,
            outcome_goal,
            teams_join_url,
            metadata
          )
          values ($1, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7::timestamptz, $8::timestamptz, $9, $10, $11::jsonb, $12, null, $13::jsonb)
          returning
            id,
            workspace_id as "workspaceId",
            project_id as "projectId",
            contact_id as "contactId",
            lead_id as "leadId",
            owner_user_id as "ownerUserId",
            title,
            starts_at as "startsAt",
            ends_at as "endsAt",
            location,
            status,
            preparation,
            outcome_goal as "outcomeGoal",
            teams_join_url as "teamsJoinUrl",
            metadata
        `,
        [
          input.session.workspaceId,
          projectId,
          contactId,
          leadId,
          ownerUserId,
          title,
          startsAt,
          endsAt,
          normalizeCalendarEventLocation(input.event.location),
          normalizeCalendarEventStatus(input.event.status),
          JSON.stringify(normalizeStringArray(input.event.preparation)),
          cleanString(input.event.outcomeGoal),
          JSON.stringify({ ...metadata, createdByUserId: input.session.userId }),
        ],
      );

  if (!row) return { persisted: false, reason: "Calendar event could not be saved" };

  const event = toCalendarEventRecord(row);
  await writeAuditLog({
    action: existing ? "calendar_event.updated" : "calendar_event.created",
    after: event,
    before: existing ? toCalendarEventRecord(existing) : null,
    entityId: event.id,
    entityType: "calendar_event",
    projectId: event.projectId,
    session: input.session,
  });

  return { data: event, persisted: true };
}

export async function upsertLeadRecord(input: {
  lead: Partial<Lead>;
  session: AppSession;
}): Promise<RepositoryWriteResult<Lead>> {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return { persisted: false, reason: "DATABASE_URL is not configured" };
  }

  const validationError =
    validateTextLength(input.lead.intent, "Lead intent", maxLongTextLength) ??
    validateTextLength(input.lead.nextAction, "Lead next action", maxLongTextLength) ??
    validateFutureDateInput(input.lead.nextContactAt, "Next contact date");
  if (validationError) return { persisted: false, reason: validationError };

  const existing = isUuid(input.lead.id)
    ? await queryOne<LeadRow>(
        `${leadSelectSql}
        where l.id = $1 and l.workspace_id = $2
        limit 1`,
        [input.lead.id, input.session.workspaceId],
      )
    : null;
  const contact = await resolveContactForWrite(input.session.workspaceId, input.lead.contactId ?? existing?.contactId);
  const projectId =
    normalizeWriteProjectId(input.lead.projectId) ??
    existing?.projectId ??
    contact?.projectId ??
    await resolveFallbackProjectId(input.session.workspaceId);
  const contactId = contact?.id ?? existing?.contactId ?? normalizeWriteProjectId(input.lead.contactId);
  const ownerUserId =
    normalizeWriteProjectId(input.lead.assignedToUserId) ??
    existing?.assignedToUserId ??
    normalizeWriteProjectId(input.session.userId);
  const score = clampNumber(input.lead.score ?? existing?.score ?? 0, 0, 100);
  const receivedAt = cleanDateInput(input.lead.receivedAt) || toIso(existing?.receivedAt ?? null) || new Date().toISOString();
  const slaDueAt =
    cleanDateInput(input.lead.slaDueAt) ||
    toIso(existing?.slaDueAt ?? null) ||
    new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const manualFirstResponseAt = cleanDateInput(input.lead.lastContactAt);
  const lastContactAt = manualFirstResponseAt || toNullableIso(existing?.lastContactAt ?? null);
  const nextContactAt = cleanDateInput(input.lead.nextContactAt) || toNullableIso(existing?.nextContactAt ?? null);
  const intent = cleanString(input.lead.intent) || existing?.intent || "Neuer Lead";
  const nextAction = cleanString(input.lead.nextAction) || existing?.nextAction || "Kontakt aufnehmen";
  const source = (cleanString(input.lead.source) || existing?.source || contact?.source || "Manual") as Lead["source"];
  const type = (cleanString(input.lead.type) || existing?.type || contact?.role || "Käufer") as Lead["type"];
  const status = (cleanString(input.lead.status) || existing?.status || "Neu") as Lead["status"];
  const hotStatus = Boolean(input.lead.hotStatus ?? existing?.hotStatus ?? score >= 80);

  const writeAccess = await assertRecordWriteAccess({
    entityLabel: "Lead",
    existingOwnerUserId: existing?.assignedToUserId,
    ownerUserId,
    projectId,
    session: input.session,
  });
  if (!writeAccess.ok) return { persisted: false, reason: writeAccess.reason };

  const row = existing
    ? await queryOne<LeadRow>(
        `
          update leads
          set
            project_id = $3::uuid,
            contact_id = $4::uuid,
            assigned_to_user_id = $5::uuid,
            source = $6,
            type = $7,
            status = $8,
            score = $9,
            budget = nullif($10, ''),
            intent = $11,
            next_action = $12,
            received_at = $13::timestamptz,
            sla_due_at = $14::timestamptz,
            last_contact_at = $15::timestamptz,
            next_contact_at = $16::timestamptz,
            region = nullif($17, ''),
            object_type = nullif($18, ''),
            rooms = $19::numeric,
            area_sqm = $20::numeric,
            hot_status = $21,
            buyer_profile = $22::jsonb,
            seller_profile = $23::jsonb,
            investor_profile = $24::jsonb,
            metadata = metadata || $25::jsonb,
            updated_at = now()
          where id = $1 and workspace_id = $2
          returning ${leadReturningSql}
        `,
        [
          existing.id,
          input.session.workspaceId,
          projectId,
          contactId,
          ownerUserId,
          source,
          type,
          status,
          score,
          cleanString(input.lead.budget) || existing.budget || "",
          intent,
          nextAction,
          receivedAt,
          slaDueAt,
          lastContactAt,
          nextContactAt,
          cleanString(input.lead.region) || existing.region || "",
          cleanString(input.lead.objectType) || existing.objectType || "",
          input.lead.rooms ?? existing.rooms ?? null,
          input.lead.areaSqm ?? existing.areaSqm ?? null,
          hotStatus,
          JSON.stringify(input.lead.buyerProfile ?? existing.buyerProfile ?? {}),
          JSON.stringify(input.lead.sellerProfile ?? existing.sellerProfile ?? {}),
          JSON.stringify(input.lead.investorProfile ?? existing.investorProfile ?? {}),
          JSON.stringify({ updatedByUserId: input.session.userId }),
        ],
      )
    : await queryOne<LeadRow>(
        `
          insert into leads (
            workspace_id,
            project_id,
            contact_id,
            assigned_to_user_id,
            source,
            type,
            status,
            score,
            budget,
            intent,
            next_action,
            received_at,
            sla_due_at,
            last_contact_at,
            next_contact_at,
            region,
            object_type,
            rooms,
            area_sqm,
            hot_status,
            buyer_profile,
            seller_profile,
            investor_profile,
            metadata
          )
          values (
            $1,
            $2::uuid,
            $3::uuid,
            $4::uuid,
            $5,
            $6,
            $7,
            $8,
            nullif($9, ''),
            $10,
            $11,
            $12::timestamptz,
            $13::timestamptz,
            $14::timestamptz,
            $15::timestamptz,
            nullif($16, ''),
            nullif($17, ''),
            $18::numeric,
            $19::numeric,
            $20,
            $21::jsonb,
            $22::jsonb,
            $23::jsonb,
            $24::jsonb
          )
          returning ${leadReturningSql}
        `,
        [
          input.session.workspaceId,
          projectId,
          contactId,
          ownerUserId,
          source,
          type,
          status,
          score,
          cleanString(input.lead.budget),
          intent,
          nextAction,
          receivedAt,
          slaDueAt,
          cleanDateInput(input.lead.lastContactAt) || null,
          cleanDateInput(input.lead.nextContactAt) || null,
          cleanString(input.lead.region),
          cleanString(input.lead.objectType),
          input.lead.rooms ?? null,
          input.lead.areaSqm ?? null,
          hotStatus,
          JSON.stringify(input.lead.buyerProfile ?? {}),
          JSON.stringify(input.lead.sellerProfile ?? {}),
          JSON.stringify(input.lead.investorProfile ?? {}),
          JSON.stringify({ createdFrom: "crm_lead_inbox", legacyId: input.lead.id ?? null }),
        ],
      );

  if (!row) return { persisted: false, reason: "Lead could not be saved" };

  const savedLead = toLead(row);

  await Promise.all([
    writeAuditLog({
      action: existing ? "lead.updated" : "lead.created",
      after: savedLead,
      before: existing ? toLead(existing) : null,
      entityId: row.id,
      entityType: "lead",
      projectId: row.projectId,
      session: input.session,
    }),
    recordAnalyticsEvent({
      contactId: row.contactId,
      entityId: row.id,
      entityType: "lead",
      eventType: existing ? "lead_updated" : "lead_created",
      leadId: row.id,
      metadata: { score: row.score, source: row.source, status: row.status },
      module: "lead",
      projectId: row.projectId,
      session: input.session,
      source: row.source,
    }),
    !existing
      ? recordSpeedToLeadEvent({
          channel: row.source,
          contactId: row.contactId,
          dueAt: row.slaDueAt,
          leadId: row.id,
          metadata: {
            score: row.score,
            sourcePayload: "crm_lead_write",
            status: row.status,
            trigger: "manual_or_api_lead",
          },
          ownerUserId: row.assignedToUserId,
          projectId: row.projectId,
          source: row.source,
          state: "covered",
          userId: input.session.userId,
          workspaceId: input.session.workspaceId,
        })
      : null,
    existing && manualFirstResponseAt
      ? Promise.all([
          writeCrmAnalyticsEvent({
            channel: row.source,
            contactId: row.contactId,
            entityId: row.id,
            entityType: "lead",
            eventType: "first_response",
            leadId: row.id,
            metadata: {
              firstResponseAt: manualFirstResponseAt,
              sourcePayload: "manual_lead_update",
            },
            module: "lead_inbox",
            projectId: row.projectId,
            source: row.source,
            userId: input.session.userId,
            workspaceId: input.session.workspaceId,
          }),
          recordSpeedToLeadEvent({
            channel: row.source,
            contactId: row.contactId,
            firstResponseAt: manualFirstResponseAt,
            leadId: row.id,
            metadata: {
              sourcePayload: "manual_lead_update",
              trigger: "owner_first_response",
            },
            ownerUserId: row.assignedToUserId,
            projectId: row.projectId,
            source: row.source,
            state: "covered",
            userId: input.session.userId,
            workspaceId: input.session.workspaceId,
          }),
        ])
      : null,
  ]);

  await syncBrokerEntityForLead({ lead: savedLead, session: input.session });

  return { data: savedLead, persisted: true };
}

export async function upsertContactRecord(input: {
  contact: Partial<Contact>;
  session: AppSession;
}): Promise<RepositoryWriteResult<Contact>> {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return { persisted: false, reason: "DATABASE_URL is not configured" };
  }

  const validationError =
    validateEmailInput(input.contact.email) ??
    validateTextLength(input.contact.name, "Contact name", maxShortTextLength) ??
    validateTextLength(input.contact.intent, "Contact intent", maxLongTextLength);
  if (validationError) return { persisted: false, reason: validationError };

  const existing = isUuid(input.contact.id)
    ? await queryOne<ContactRow>(
        `${contactSelectSql}
        where c.id = $1 and c.workspace_id = $2
          and c.archived_at is null
        limit 1`,
        [input.contact.id, input.session.workspaceId],
      )
    : null;
  const normalizedEmail = cleanString(input.contact.email);
  if (normalizedEmail) {
    const duplicate = await queryOne<IdRow>(
      `
        select id
        from contacts
        where workspace_id = $1
          and archived_at is null
          and lower(email) = lower($2)
          and ($3::uuid is null or id <> $3::uuid)
        limit 1
      `,
      [input.session.workspaceId, normalizedEmail, existing?.id ?? null],
    );

    if (duplicate) {
      return { persisted: false, reason: "Duplicate contact email" };
    }
  }

  const resolvedProject = await resolveContactProjectId({
    existingProjectId: existing?.projectId ?? null,
    requestedProjectId: input.contact.projectId,
    workspaceId: input.session.workspaceId,
  });
  if (!resolvedProject.ok) return { persisted: false, reason: resolvedProject.reason };
  const resolvedOrganization = await resolveContactOrganizationId({
    existingOrganizationId: existing?.organizationId ?? null,
    requestedOrganizationId: input.contact.organizationId,
    workspaceId: input.session.workspaceId,
  });
  if (!resolvedOrganization.ok) return { persisted: false, reason: resolvedOrganization.reason };

  const projectId = resolvedProject.projectId;
  const name = cleanString(input.contact.name) || existing?.name || cleanString(input.contact.email) || cleanString(input.contact.phone);

  if (!name) return { persisted: false, reason: "Contact name, email or phone is required" };

  const row = existing
    ? await queryOne<ContactRow>(
        `
          update contacts c
          set
            project_id = $3::uuid,
            organization_id = $4::uuid,
            name = $5,
            role = $6,
            source = $7,
            intent = $8,
            consent_label = $9,
            email = nullif($10, ''),
            phone = nullif($11, ''),
            metadata = metadata || $12::jsonb,
            updated_at = now()
          where c.id = $1 and c.workspace_id = $2
          returning
            c.id,
            c.workspace_id as "workspaceId",
            c.project_id as "projectId",
            c.organization_id as "organizationId",
            c.name,
            c.role,
            c.source,
            c.intent,
            c.consent_label as consent,
            c.email,
            c.phone,
            (select name from projects p where p.id = c.project_id) as project
        `,
        [
          existing.id,
          input.session.workspaceId,
          projectId,
          resolvedOrganization.organizationId,
          name,
          input.contact.role ?? existing.role,
          input.contact.source ?? existing.source,
          cleanString(input.contact.intent) || existing.intent,
          cleanString(input.contact.consent) || existing.consent,
          cleanString(input.contact.email),
          cleanString(input.contact.phone),
          JSON.stringify({ updatedFrom: "crm_contacts", updatedByUserId: input.session.userId }),
        ],
      )
    : await queryOne<ContactRow>(
        `
          insert into contacts (
            workspace_id,
            project_id,
            organization_id,
            name,
            role,
            source,
            intent,
            consent_label,
            email,
            phone,
            metadata
          )
          values ($1, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, nullif($9, ''), nullif($10, ''), $11::jsonb)
          returning
            id,
            workspace_id as "workspaceId",
            project_id as "projectId",
            organization_id as "organizationId",
            name,
            role,
            source,
            intent,
            consent_label as consent,
            email,
            phone,
            (select name from projects p where p.id = contacts.project_id) as project
        `,
        [
          input.session.workspaceId,
          projectId,
          resolvedOrganization.organizationId,
          name,
          input.contact.role ?? "Käufer",
          input.contact.source ?? "Manual",
          cleanString(input.contact.intent) || "Manuell erfasst",
          cleanString(input.contact.consent) || "Nur CRM",
          cleanString(input.contact.email),
          cleanString(input.contact.phone),
          JSON.stringify({ createdFrom: "crm_contacts", legacyId: input.contact.id ?? null }),
        ],
      );

  if (!row) return { persisted: false, reason: "Contact could not be saved" };

  await upsertConsentFromContact({
    contact: row,
    existingConsent: existing?.consent,
    session: input.session,
  });

  await Promise.all([
    writeAuditLog({
      action: existing ? "contact.updated" : "contact.created",
      after: toContact(row),
      before: existing ? toContact(existing) : null,
      entityId: row.id,
      entityType: "contact",
      session: input.session,
    }),
    recordAnalyticsEvent({
      contactId: row.id,
      entityId: row.id,
      entityType: "contact",
      eventType: existing ? "contact_updated" : "contact_created",
      metadata: { consent: row.consent, source: row.source },
      module: "contact",
      projectId: row.projectId,
      session: input.session,
      source: row.source,
    }),
  ]);

  return { data: toContact(row), persisted: true };
}

export async function archiveContactRecord(input: {
  contactId: string;
  session: AppSession;
}): Promise<RepositoryWriteResult<{ id: string }>> {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return { persisted: false, reason: "DATABASE_URL is not configured" };
  }

  if (!isUuid(input.contactId)) {
    return { persisted: false, reason: "Contact id is required" };
  }

  const existing = await queryOne<ContactRow>(
    `${contactSelectSql}
    where c.id = $1 and c.workspace_id = $2
      and c.archived_at is null
    limit 1`,
    [input.contactId, input.session.workspaceId],
  );

  if (!existing) {
    return { persisted: false, reason: "Contact not found" };
  }

  const row = await queryOne<IdRow>(
    `
      update contacts
      set
        archived_at = now(),
        archived_by_user_id = $3::uuid,
        metadata = metadata || $4::jsonb,
        updated_at = now()
      where id = $1 and workspace_id = $2 and archived_at is null
      returning id
    `,
    [
      existing.id,
      input.session.workspaceId,
      normalizeWriteProjectId(input.session.userId),
      JSON.stringify({ archivedByUserId: input.session.userId, archivedFrom: "crm_contacts" }),
    ],
  );

  if (!row) return { persisted: false, reason: "Contact could not be archived" };

  await Promise.all([
    writeAuditLog({
      action: "contact.archived",
      after: { archivedAt: new Date().toISOString(), contactId: row.id },
      before: toContact(existing),
      entityId: row.id,
      entityType: "contact",
      projectId: existing.projectId,
      session: input.session,
    }),
    recordAnalyticsEvent({
      contactId: row.id,
      entityId: row.id,
      entityType: "contact",
      eventType: "contact_archived",
      metadata: { source: existing.source },
      module: "contact",
      projectId: existing.projectId,
      session: input.session,
      source: existing.source,
    }),
  ]);

  return { data: { id: row.id }, persisted: true };
}

export async function upsertFunnelDraft(input: {
  funnel: Partial<Funnel> & Record<string, unknown>;
  session: AppSession;
  steps: Array<Partial<FunnelStep> & Record<string, unknown>>;
}): Promise<RepositoryWriteResult<{ funnel: Funnel; stepIds: string[] }>> {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return { persisted: false, reason: "DATABASE_URL is not configured" };
  }

  const existingId = await resolveFunnelId(input.session.workspaceId, input.funnel.id);
  const projectId = normalizeWriteProjectId(input.funnel.projectId) ?? await resolveFallbackProjectId(input.session.workspaceId);
  const ownerUserId = normalizeWriteProjectId(input.funnel.ownerUserId) ?? normalizeWriteProjectId(input.session.userId);
  const name = cleanString(input.funnel.name) || "CRM Funnel";
  const blueprint = {
    funnel: input.funnel,
    schemaVersion: 1,
    steps: input.steps,
    updatedAt: new Date().toISOString(),
    updatedByUserId: input.session.userId,
  };
  const tracking = {
    consentMode: cleanString(input.funnel.consentMode),
    gaMeasurementId: cleanString(input.funnel.gaMeasurementId),
    gtmId: cleanString(input.funnel.gtmId),
    legacyId: isUuid(input.funnel.id) ? undefined : input.funnel.id,
    metaPixelId: cleanString(input.funnel.metaPixelId),
    webhookUrl: cleanString(input.funnel.webhookUrl),
  };
  const row = existingId
    ? await queryOne<FunnelRow>(
        `
          update funnels
          set
            project_id = $3::uuid,
            owner_user_id = $4::uuid,
            name = $5,
            goal = $6,
            audience = $7,
            entry_channel = $8,
            status = $9,
            visits = $10,
            leads_count = $11,
            conversion_rate = $12,
            blueprint = $13::jsonb,
            tracking = tracking || $14::jsonb,
            updated_at = now()
          where id = $1 and workspace_id = $2
          returning
            id,
            workspace_id as "workspaceId",
            project_id as "projectId",
            owner_user_id as "ownerUserId",
            name,
            goal,
            audience,
            entry_channel as "entryChannel",
            status,
            visits,
            leads_count as leads,
            conversion_rate as "conversionRate"
        `,
        [
          existingId,
          input.session.workspaceId,
          projectId,
          ownerUserId,
          name,
          cleanString(input.funnel.goal) || "Lead generieren",
          cleanString(input.funnel.audience) || "Käufer",
          cleanString(input.funnel.entryChannel) || "Website",
          cleanString(input.funnel.status) || "entwurf",
          Number(input.funnel.visits ?? 0),
          Number(input.funnel.leads ?? 0),
          Number(input.funnel.conversionRate ?? 0),
          JSON.stringify(blueprint),
          JSON.stringify(tracking),
        ],
      )
    : await queryOne<FunnelRow>(
        `
          insert into funnels (
            workspace_id,
            project_id,
            owner_user_id,
            name,
            goal,
            audience,
            entry_channel,
            status,
            visits,
            leads_count,
            conversion_rate,
            blueprint,
            tracking
          )
          values ($1, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb)
          returning
            id,
            workspace_id as "workspaceId",
            project_id as "projectId",
            owner_user_id as "ownerUserId",
            name,
            goal,
            audience,
            entry_channel as "entryChannel",
            status,
            visits,
            leads_count as leads,
            conversion_rate as "conversionRate"
        `,
        [
          input.session.workspaceId,
          projectId,
          ownerUserId,
          name,
          cleanString(input.funnel.goal) || "Lead generieren",
          cleanString(input.funnel.audience) || "Käufer",
          cleanString(input.funnel.entryChannel) || "Website",
          cleanString(input.funnel.status) || "entwurf",
          Number(input.funnel.visits ?? 0),
          Number(input.funnel.leads ?? 0),
          Number(input.funnel.conversionRate ?? 0),
          JSON.stringify(blueprint),
          JSON.stringify(tracking),
        ],
      );

  if (!row) return { persisted: false, reason: "Funnel could not be saved" };

  await queryOne<IdRow>("delete from funnel_steps where funnel_id = $1 and workspace_id = $2 returning id", [
    row.id,
    input.session.workspaceId,
  ]);

  const stepIds: string[] = [];
  for (const [index, step] of input.steps.entries()) {
    const inserted = await queryOne<IdRow>(
      `
        insert into funnel_steps (
          workspace_id,
          project_id,
          funnel_id,
          name,
          channel,
          status,
          position,
          visits,
          leads_count,
          conversion_rate,
          drop_off_reason,
          next_optimization,
          bot_rule_id,
          config
        )
        values ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::uuid, $14::jsonb)
        returning id
      `,
      [
        input.session.workspaceId,
        row.projectId,
        row.id,
        cleanString(step.name) || `Step ${index + 1}`,
        cleanString(step.channel) || row.entryChannel,
        cleanString(step.status) || "entwurf",
        index,
        Number(step.visits ?? 0),
        Number(step.leads ?? 0),
        Number(step.conversionRate ?? 0),
        cleanString(step.dropOffReason),
        cleanString(step.nextOptimization),
        normalizeWriteProjectId(step.botRuleId),
        JSON.stringify({ ...step, legacyId: step.id ?? null }),
      ],
    );

    if (inserted?.id) stepIds.push(inserted.id);
  }

  await Promise.all([
    writeAuditLog({
      action: existingId ? "funnel.updated" : "funnel.created",
      after: { funnelId: row.id, projectId: row.projectId, steps: stepIds.length },
      entityId: row.id,
      entityType: "funnel",
      session: input.session,
    }),
    recordAnalyticsEvent({
      entityId: row.id,
      entityType: "funnel",
      eventType: existingId ? "funnel_updated" : "funnel_created",
      funnelId: row.id,
      metadata: { status: row.status, steps: stepIds.length },
      module: "funnel",
      projectId: row.projectId,
      session: input.session,
      source: "crm_funnel_builder",
    }),
  ]);

  return { data: { funnel: toFunnel(row), stepIds }, persisted: true };
}

export async function updateNewsletterCampaignStatus(input: {
  campaignId?: string | null;
  contentBlocks?: unknown;
  metrics?: unknown;
  recipients?: number;
  session: AppSession;
  status: NewsletterCampaign["status"] | "queued" | "failed";
  subject?: string;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId) || !isUuid(input.campaignId)) {
    return null;
  }

  const status = input.status === "queued" ? "geplant" : input.status === "failed" ? "bereit" : input.status;
  const row = await queryOne<{
    id: string;
    projectId: string | null;
    status: string;
  }>(
    `
      update newsletter_campaigns
      set
        status = $3,
        subject = coalesce(nullif($4, ''), subject),
        recipients = greatest(recipients, $5),
        metrics = metrics || $6::jsonb,
        content_blocks = case when $7::jsonb = 'null'::jsonb then content_blocks else $7::jsonb end,
        updated_at = now()
      where id = $1 and workspace_id = $2
      returning id, project_id as "projectId", status
    `,
    [
      input.campaignId,
      input.session.workspaceId,
      status,
      cleanString(input.subject),
      Number(input.recipients ?? 0),
      JSON.stringify(input.metrics ?? {}),
      JSON.stringify(input.contentBlocks ?? null),
    ],
  );

  if (!row) return null;

  await Promise.all([
    writeAuditLog({
      action: "newsletter_campaign.status_updated",
      after: { campaignId: row.id, metrics: input.metrics ?? {}, status: row.status },
      entityId: row.id,
      entityType: "newsletter_campaign",
      session: input.session,
    }),
    recordAnalyticsEvent({
      entityId: row.id,
      entityType: "newsletter_campaign",
      eventType: "newsletter_event",
      metadata: { campaignId: row.id, event: "campaign_status_updated", status: row.status },
      module: "newsletter",
      projectId: row.projectId,
      session: input.session,
      source: "crm_newsletter",
    }),
  ]);

  return row;
}

export async function upsertBotSetup(input: {
  bot: Partial<CrmBot> & Record<string, unknown>;
  session: AppSession;
}): Promise<RepositoryWriteResult<{ id: string; status: string }>> {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return { persisted: false, reason: "DATABASE_URL is not configured" };
  }

  const existingId = await resolveBotId(input.session.workspaceId, input.bot.id);
  const projectId = normalizeWriteProjectId(input.bot.projectId);
  const name = cleanString(input.bot.name) || "CRM Bot";
  const status = cleanString(input.bot.status) || "draft";
  const botModel = (input.bot as { model?: unknown }).model;
  const strictKnowledge = input.bot.strictKnowledge !== false;
  const config = {
    actionPolicies: input.bot.actionPolicies ?? [],
    channels: input.bot.channels ?? [],
    documentLibrary: input.bot.documentLibrary ?? [],
    modelConfig: input.bot.modelConfig ?? {},
    setupChecklist: input.bot.setupChecklist ?? [],
    tools: input.bot.tools ?? [],
    updatedAt: new Date().toISOString(),
    updatedByUserId: input.session.userId,
  };
  const publishReadiness = await evaluateBotPublishReadiness({
    botId: existingId,
    channels: config.channels,
    projectId,
    session: input.session,
    status,
    strictKnowledge,
  });

  if (!publishReadiness.allowed) {
    await Promise.all([
      writeAuditLog({
        action: "bot.publish.blocked",
        after: publishReadiness,
        entityId: existingId,
        entityType: "bot",
        projectId,
        session: input.session,
      }),
      recordAnalyticsEvent({
        entityId: existingId,
        entityType: "bot",
        eventType: "bot_publish_blocked",
        metadata: publishReadiness,
        module: "bot",
        projectId,
        session: input.session,
        source: "crm_bot_setup",
      }),
    ]);

    return {
      persisted: false,
      reason: `bot_publish_blocked:${publishReadiness.blockers.join(",")}`,
    };
  }

  const row = existingId
    ? await queryOne<{ id: string; projectId: string | null; status: string }>(
        `
          update bots
          set
            project_id = $3::uuid,
            name = $4,
            description = $5,
            role = $6,
            status = $7,
            model = $8,
            strict_knowledge = $9,
            audience = $10,
            language = $11,
            tone = $12,
            answer_length = $13,
            brand_voice = $14,
            config = config || $15::jsonb,
            updated_at = now()
          where id = $1 and workspace_id = $2
          returning id, project_id as "projectId", status
        `,
        [
          existingId,
          input.session.workspaceId,
          projectId,
          name,
          cleanString(input.bot.description),
          cleanString(input.bot.role) || "sales_qualifier",
          status,
          cleanString(botModel) || cleanString(asObject(input.bot.modelConfig).primaryModel) || "openai/gpt-5.4",
          strictKnowledge,
          cleanString(input.bot.audience),
          cleanString(input.bot.language) || "auto",
          cleanString(input.bot.tone),
          cleanString(input.bot.answerLength) || "normal",
          cleanString(input.bot.brandVoice),
          JSON.stringify(config),
        ],
      )
    : await queryOne<{ id: string; projectId: string | null; status: string }>(
        `
          insert into bots (
            workspace_id,
            project_id,
            name,
            description,
            role,
            status,
            model,
            strict_knowledge,
            audience,
            language,
            tone,
            answer_length,
            brand_voice,
            config
          )
          values ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
          returning id, project_id as "projectId", status
        `,
        [
          input.session.workspaceId,
          projectId,
          name,
          cleanString(input.bot.description),
          cleanString(input.bot.role) || "sales_qualifier",
          status,
          cleanString(botModel) || cleanString(asObject(input.bot.modelConfig).primaryModel) || "openai/gpt-5.4",
          strictKnowledge,
          cleanString(input.bot.audience),
          cleanString(input.bot.language) || "auto",
          cleanString(input.bot.tone),
          cleanString(input.bot.answerLength) || "normal",
          cleanString(input.bot.brandVoice),
          JSON.stringify({ ...config, legacyId: input.bot.id ?? null }),
        ],
      );

  if (!row) return { persisted: false, reason: "Bot setup could not be saved" };

  await Promise.all([
    writeAuditLog({
      action: existingId ? "bot.updated" : "bot.created",
      after: { botId: row.id, name, status: row.status },
      entityId: row.id,
      entityType: "bot",
      session: input.session,
    }),
    recordAnalyticsEvent({
      entityId: row.id,
      entityType: "bot",
      eventType: existingId ? "bot_updated" : "bot_created",
      metadata: { botId: row.id, status: row.status },
      module: "bot",
      projectId: row.projectId,
      session: input.session,
      source: "crm_bot_setup",
    }),
  ]);

  return { data: { id: row.id, status: row.status }, persisted: true };
}

async function evaluateBotPublishReadiness(input: {
  botId: string | null;
  channels: unknown;
  projectId: string | null;
  session: AppSession;
  status: string;
  strictKnowledge: boolean;
}) {
  if (input.status !== "active") {
    return {
      allowed: true,
      blockers: [] as string[],
      checks: {
        approvedKnowledge: true,
        evaluation: true,
        handoff: true,
        strictKnowledge: true,
      },
    };
  }

  const channels = Array.isArray(input.channels) ? input.channels : [];
  const handoffReady = channels.some((channel) => {
    const rules = asObject(channel).handoffRules;
    return Array.isArray(rules) && rules.some((rule) => cleanString(rule));
  });
  const approvedKnowledge = await countApprovedKnowledgeSources({
    projectId: input.projectId,
    session: input.session,
  });
  const latestEvaluation = input.botId
    ? await getLatestBotPublishEvaluation({
        botId: input.botId,
        projectId: input.projectId,
        session: input.session,
      })
    : null;
  const evaluationReady = Boolean(
    latestEvaluation &&
      Number(latestEvaluation.score) >= 80 &&
      Number(latestEvaluation.sourceCoverage) >= 80 &&
      Number(latestEvaluation.hallucinationFailures) === 0 &&
      Number(latestEvaluation.handoffFailures) === 0 &&
      Number(latestEvaluation.redTeamFailures) === 0,
  );
  const checks = {
    approvedKnowledge: approvedKnowledge > 0,
    evaluation: evaluationReady,
    handoff: handoffReady,
    strictKnowledge: input.strictKnowledge,
  };
  const blockers = Object.entries(checks)
    .filter(([, ready]) => !ready)
    .map(([key]) => key);

  return {
    allowed: blockers.length === 0,
    blockers,
    checks,
    latestEvaluation,
  };
}

async function countApprovedKnowledgeSources(input: {
  projectId: string | null;
  session: AppSession;
}) {
  const row = await queryOne<CountRow>(
    `
      select count(*) as count
      from knowledge_sources
      where workspace_id = $1
        and ($2::uuid is null or project_id is null or project_id = $2::uuid)
        and (
          status in ('Vector bereit', 'vector_ready', 'approved', 'synced')
          or lower(coalesce(metadata->>'approval', '')) in ('approved', 'freigegeben')
        )
    `,
    [input.session.workspaceId, input.projectId],
  );

  return Number(row?.count ?? 0);
}

async function getLatestBotPublishEvaluation(input: {
  botId: string;
  projectId: string | null;
  session: AppSession;
}) {
  return queryOne<BotPublishEvaluationRow>(
    `
      select
        score,
        source_coverage as "sourceCoverage",
        hallucination_failures as "hallucinationFailures",
        handoff_failures as "handoffFailures",
        red_team_failures as "redTeamFailures"
      from bot_evaluation_runs
      where workspace_id = $1
        and bot_id = $2
        and ($3::uuid is null or project_id is null or project_id = $3::uuid)
      order by created_at desc
      limit 1
    `,
    [input.session.workspaceId, input.botId, input.projectId],
  );
}

export async function createProjectRecord(input: {
  project: Partial<Project>;
  session: AppSession;
}): Promise<RepositoryWriteResult<Project>> {
  if (!hasDatabaseUrl() || !isUuid(input.session.workspaceId)) {
    return { persisted: false, reason: "DATABASE_URL is not configured" };
  }

  const name = cleanString(input.project.name);
  if (!name) return { persisted: false, reason: "Project name is required" };

  const customerType = isWorkspaceCustomerType(input.project.customerType)
    ? input.project.customerType
    : input.session.workspaceCustomerType ?? null;
  const defaultOperatingModel = isWorkspaceOperatingModel(input.project.defaultOperatingModel)
    ? input.project.defaultOperatingModel
    : input.session.workspaceOperatingModel ?? null;
  const rawSetupDefaults = asObject(input.project.setupDefaults);
  const setupDefaults = {
    ...createModeSetupDefaults(customerType, defaultOperatingModel),
    ...rawSetupDefaults,
    calendarProvider: isCalendarProviderChoice(rawSetupDefaults.calendarProvider)
      ? rawSetupDefaults.calendarProvider
      : input.session.workspaceActiveCalendarProvider ?? "none",
    meetingProvider: cleanString(rawSetupDefaults.meetingProvider) || undefined,
    teamStructure: isWorkspaceTeamStructure(rawSetupDefaults.teamStructure)
      ? rawSetupDefaults.teamStructure
      : input.session.workspaceTeamStructure ?? undefined,
  };
  const row = await queryOne<ProjectWriteRow>(
    `
      insert into projects (
        workspace_id,
        name,
        type,
        status,
        customer_type,
        default_operating_model,
        setup_defaults
      )
      values ($1, $2, $3, $4, $5, $6, $7::jsonb)
      returning
        id,
        workspace_id as "workspaceId",
        name,
        type,
        status,
        customer_type as "customerType",
        default_operating_model as "defaultOperatingModel",
        setup_defaults as "setupDefaults",
        default_pipeline_id as "defaultPipelineId"
    `,
    [
      input.session.workspaceId,
      name,
      cleanString(input.project.type) || "real_estate_project",
      cleanString(input.project.status) || "Aktiv",
      customerType,
      defaultOperatingModel,
      JSON.stringify(setupDefaults),
    ],
  );

  if (!row) return { persisted: false, reason: "Project could not be saved" };

  let pipelineSetup = { defaultPipelineId: row.defaultPipelineId, pipelineIds: [] as string[], stageCount: 0 };
  try {
    pipelineSetup = await ensureProjectDefaultPipelines({
      customerType: row.customerType,
      operatingModel: row.defaultOperatingModel,
      projectId: row.id,
      session: input.session,
      setupDefaults: row.setupDefaults,
    });
  } catch {
    pipelineSetup = { defaultPipelineId: row.defaultPipelineId, pipelineIds: [], stageCount: 0 };
  }

  await writeAuditLog({
    action: "project.created",
    after: { ...row, defaultPipelineId: pipelineSetup.defaultPipelineId ?? row.defaultPipelineId },
    entityId: row.id,
    entityType: "project",
    session: input.session,
  });

  return {
    data: toProjectWriteResult(row, pipelineSetup.defaultPipelineId),
    persisted: true,
  };
}

export async function updateProjectRecord(input: {
  project: Partial<Project>;
  session: AppSession;
}): Promise<RepositoryWriteResult<Project>> {
  if (!hasDatabaseUrl() || !isUuid(input.session.workspaceId)) {
    return { persisted: false, reason: "DATABASE_URL is not configured" };
  }

  if (!isUuid(input.project.id)) {
    return { persisted: false, reason: "Project id is required" };
  }

  const existing = await queryOne<ProjectWriteRow>(
    `
      select
        id,
        workspace_id as "workspaceId",
        name,
        type,
        status,
        customer_type as "customerType",
        default_operating_model as "defaultOperatingModel",
        setup_defaults as "setupDefaults",
        default_pipeline_id as "defaultPipelineId"
      from projects
      where id = $1 and workspace_id = $2
      limit 1
    `,
    [input.project.id, input.session.workspaceId],
  );

  if (!existing) return { persisted: false, reason: "Project not found" };

  const name = cleanString(input.project.name) || existing.name;
  if (!name) return { persisted: false, reason: "Project name is required" };

  const customerType = isWorkspaceCustomerType(input.project.customerType)
    ? input.project.customerType
    : existing.customerType;
  const defaultOperatingModel = isWorkspaceOperatingModel(input.project.defaultOperatingModel)
    ? input.project.defaultOperatingModel
    : existing.defaultOperatingModel;
  const rawSetupDefaults = asObject(input.project.setupDefaults);
  const setupDefaults = {
    ...(existing.setupDefaults ?? createModeSetupDefaults(customerType, defaultOperatingModel)),
    ...rawSetupDefaults,
    calendarProvider: isCalendarProviderChoice(rawSetupDefaults.calendarProvider)
      ? rawSetupDefaults.calendarProvider
      : existing.setupDefaults?.calendarProvider ?? input.session.workspaceActiveCalendarProvider ?? "none",
    meetingProvider:
      cleanString(rawSetupDefaults.meetingProvider) ||
      existing.setupDefaults?.meetingProvider ||
      undefined,
    teamStructure: isWorkspaceTeamStructure(rawSetupDefaults.teamStructure)
      ? rawSetupDefaults.teamStructure
      : existing.setupDefaults?.teamStructure ?? input.session.workspaceTeamStructure ?? undefined,
  };
  const defaultPipelineId = normalizeWriteProjectId(input.project.defaultPipelineId) ?? existing.defaultPipelineId;

  const row = await queryOne<ProjectWriteRow>(
    `
      update projects
      set
        name = $3,
        type = $4,
        status = $5,
        customer_type = $6,
        default_operating_model = $7,
        setup_defaults = $8::jsonb,
        default_pipeline_id = $9::uuid,
        updated_at = now()
      where id = $1 and workspace_id = $2
      returning
        id,
        workspace_id as "workspaceId",
        name,
        type,
        status,
        customer_type as "customerType",
        default_operating_model as "defaultOperatingModel",
        setup_defaults as "setupDefaults",
        default_pipeline_id as "defaultPipelineId"
    `,
    [
      existing.id,
      input.session.workspaceId,
      name,
      cleanString(input.project.type) || existing.type,
      cleanString(input.project.status) || existing.status,
      customerType,
      defaultOperatingModel,
      JSON.stringify(setupDefaults),
      defaultPipelineId,
    ],
  );

  if (!row) return { persisted: false, reason: "Project could not be saved" };

  await writeAuditLog({
    action: "project.updated",
    after: row,
    before: existing,
    entityId: row.id,
    entityType: "project",
    session: input.session,
  });

  return {
    data: toProjectWriteResult(row),
    persisted: true,
  };
}

function toProjectWriteResult(row: ProjectWriteRow, defaultPipelineId = row.defaultPipelineId): Project {
  return {
    defaultPipelineId: defaultPipelineId ?? "",
    customerType: row.customerType ?? undefined,
    defaultOperatingModel: row.defaultOperatingModel ?? undefined,
    id: row.id,
    leads: 0,
    name: row.name,
    revenue: "0",
    setupDefaults: row.setupDefaults ?? undefined,
    status: row.status,
    type: row.type,
    workspaceId: row.workspaceId,
  };
}

function createModeSetupDefaults(
  customerType: Project["customerType"] | null,
  operatingModel: Project["defaultOperatingModel"] | null,
) {
  if (operatingModel === "managed_by_novalure") {
    return {
      automations: ["sla_queue", "follow_up_queue", "approval_queue", "customer_report"],
      pipelines: ["SLA-Queue", "Follow-up-Queue", "Freigabequeue", "Kundenreport"],
      templates: ["Servicebetrieb Tagesreport", "Freigabeanfrage", "SLA-Follow-up"],
    };
  }

  if (customerType === "property_developer") {
    return {
      automations: ["reservation_deadline", "contract_milestone", "unit_status_change"],
      pipelines: ["Projektpipeline", "Reservierungsworkflow", "Vertragsmeilensteine"],
      templates: ["Beratungstermin", "Reservierung", "Kaufvertragsstatus"],
      unitStatuses: ["available", "reserved", "sold", "blocked"],
    };
  }

  if (customerType === "novalure_internal" || operatingModel === "novalure_internal") {
    return {
      automations: ["demo_follow_up", "trial_health", "onboarding_risk", "customer_success_next_action"],
      pipelines: ["Sales Pipeline", "Demos/Trials", "Onboarding", "Customer Success"],
      templates: ["Demo Einladung", "Trial Follow-up", "Onboarding Checkliste"],
    };
  }

  return {
    automations: ["seller_follow_up", "buyer_follow_up", "mandate_expiry"],
    pipelines: ["Verkaeufer-Pipeline", "Kaeufer-Pipeline", "Mandatsworkflow"],
    templates: ["Eigentuemer Follow-up", "Kaeufer Suchprofil", "Mandatscheck"],
  };
}

async function resolveDashboardViewId(input: {
  id?: string;
  name: string;
  projectId: string | null;
  session: AppSession;
  userId: string | null;
}) {
  if (isUuid(input.id)) {
    const row = await queryOne<IdRow>(
      `
        select id
        from dashboard_views
        where id = $1 and workspace_id = $2 and (user_id is null or user_id = $3::uuid)
        limit 1
      `,
      [input.id, input.session.workspaceId, input.userId],
    );
    if (row) return row.id;
  }

  const row = await queryOne<IdRow>(
    `
      select id
      from dashboard_views
      where workspace_id = $1
        and (user_id is null or user_id = $2::uuid)
        and project_id is not distinct from $3::uuid
        and lower(name) = lower($4)
      order by updated_at desc
      limit 1
    `,
    [input.session.workspaceId, input.userId, input.projectId, input.name],
  );

  return row?.id ?? null;
}

async function resolveFunnelId(workspaceId: string, id: unknown) {
  if (typeof id !== "string") return null;

  if (isUuid(id)) {
    const row = await queryOne<IdRow>(
      "select id from funnels where workspace_id = $1 and id = $2 limit 1",
      [workspaceId, id],
    );
    if (row) return row.id;
  }

  const legacy = await queryOne<IdRow>(
    "select id from funnels where workspace_id = $1 and tracking->>'legacyId' = $2 limit 1",
    [workspaceId, id],
  );

  return legacy?.id ?? null;
}

async function resolveBotId(workspaceId: string, id: unknown) {
  if (typeof id !== "string") return null;

  if (isUuid(id)) {
    const row = await queryOne<IdRow>(
      "select id from bots where workspace_id = $1 and id = $2 limit 1",
      [workspaceId, id],
    );
    if (row) return row.id;
  }

  const legacy = await queryOne<IdRow>(
    "select id from bots where workspace_id = $1 and config->>'legacyId' = $2 limit 1",
    [workspaceId, id],
  );

  return legacy?.id ?? null;
}

async function resolveContactForWrite(workspaceId: string, contactId: string | null | undefined) {
  if (!isUuid(contactId)) return null;

  return queryOne<ContactRow>(
    `${contactSelectSql}
    where c.id = $1 and c.workspace_id = $2
      and c.archived_at is null
    limit 1`,
    [contactId, workspaceId],
  );
}

async function resolveContactProjectId(input: {
  existingProjectId: string | null;
  requestedProjectId: unknown;
  workspaceId: string;
}): Promise<{ ok: true; projectId: string | null } | { ok: false; reason: string }> {
  const requestedProjectId = cleanString(input.requestedProjectId);

  if (requestedProjectId) {
    if (!isUuid(requestedProjectId)) {
      return { ok: false, reason: "Valid project is required" };
    }

    const project = await queryOne<IdRow>(
      "select id from projects where id = $1 and workspace_id = $2 limit 1",
      [requestedProjectId, input.workspaceId],
    );

    if (!project) {
      return { ok: false, reason: "Project is not available in this workspace" };
    }

    return { ok: true, projectId: project.id };
  }

  if (input.existingProjectId) {
    return { ok: true, projectId: input.existingProjectId };
  }

  return { ok: true, projectId: await resolveFallbackProjectId(input.workspaceId) };
}

async function resolveContactOrganizationId(input: {
  existingOrganizationId: string | null;
  requestedOrganizationId: unknown;
  workspaceId: string;
}): Promise<{ ok: true; organizationId: string | null } | { ok: false; reason: string }> {
  const requestedOrganizationId = cleanString(input.requestedOrganizationId);

  if (requestedOrganizationId) {
    if (!isUuid(requestedOrganizationId)) {
      return { ok: false, reason: "Valid organization is required" };
    }

    const organization = await queryOne<IdRow>(
      "select id from organizations where id = $1 and workspace_id = $2 limit 1",
      [requestedOrganizationId, input.workspaceId],
    );

    if (!organization) {
      return { ok: false, reason: "Organization is not available in this workspace" };
    }

    return { ok: true, organizationId: organization.id };
  }

  return { ok: true, organizationId: input.existingOrganizationId };
}

async function resolveFallbackProjectId(workspaceId: string) {
  const row = await queryOne<IdRow>(
    "select id from projects where workspace_id = $1 order by created_at asc limit 1",
    [workspaceId],
  );

  return row?.id ?? null;
}

async function insertDealStageHistory(input: {
  dealId: string;
  fromStage: string | null;
  projectId: string | null;
  reason?: string;
  reasonCategory?: DealCloseReasonCategory | null;
  reasonDetail?: string | null;
  session: AppSession;
  toStage: string;
}) {
  const row = await queryOne<DealStageHistoryRow>(
    `
      insert into deal_stage_history (
        workspace_id,
        project_id,
        deal_id,
        from_stage,
        to_stage,
        changed_by_user_id,
        reason,
        reason_category,
        reason_detail,
        metadata
      )
      values ($1, $2::uuid, $3, $4, $5, $6::uuid, $7, $8, $9, $10::jsonb)
      returning
        id,
        workspace_id as "workspaceId",
        project_id as "projectId",
        deal_id as "dealId",
        from_stage as "fromStage",
        to_stage as "toStage",
        changed_by_user_id as "changedByUserId",
        null::text as "changedByName",
        reason,
        reason_category as "reasonCategory",
        reason_detail as "reasonDetail",
        changed_at as "changedAt"
    `,
    [
      input.session.workspaceId,
      input.projectId,
      input.dealId,
      input.fromStage,
      input.toStage,
      normalizeWriteProjectId(input.session.userId),
      cleanString(input.reason) || null,
      input.reasonCategory ?? null,
      cleanString(input.reasonDetail) || "",
      JSON.stringify({ source: "crm_pipeline", userId: input.session.userId }),
    ],
  );

  return row ? toDealStageHistoryEntry({ ...row, changedByName: input.session.name || row.changedByName }) : null;
}

async function upsertConsentFromContact(input: {
  contact: ContactRow;
  existingConsent?: string | null;
  session: AppSession;
}) {
  const status = cleanString(input.contact.consent);
  if (!status || status === input.existingConsent) return;

  await queryOne<IdRow>(
    `
      insert into consent_records (
        workspace_id,
        contact_id,
        project_id,
        channel,
        status,
        source,
        metadata
      )
      values ($1, $2, $3::uuid, 'Newsletter', $4, 'CRM Kontaktpflege', $5::jsonb)
      returning id
    `,
    [
      input.session.workspaceId,
      input.contact.id,
      input.contact.projectId,
      status,
      JSON.stringify({ updatedByUserId: input.session.userId }),
    ],
  );
}

async function recordAnalyticsEvent(input: {
  channel?: string | null;
  contactId?: string | null;
  dealId?: string | null;
  entityId?: string | null;
  entityType?: string | null;
  eventType: string;
  funnelId?: string | null;
  leadId?: string | null;
  metadata?: unknown;
  module?: string | null;
  occurredAt?: string | Date | null;
  projectId?: string | null;
  session: AppSession;
  source?: string | null;
  valueCents?: number;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId)) return null;

  const metadata = asObject(input.metadata);

  return writeCrmAnalyticsEvent({
    channel: input.channel,
    contactId: input.contactId,
    dealId: input.dealId,
    entityId: input.entityId ?? inferAnalyticsEntityId(input, metadata),
    entityType: input.entityType ?? inferAnalyticsEntityType(input),
    eventType: input.eventType,
    funnelId: input.funnelId,
    leadId: input.leadId,
    metadata: {
      ...metadata,
      actorUserId: input.session.userId,
    },
    module: input.module,
    occurredAt: input.occurredAt,
    projectId: input.projectId,
    source: input.source,
    userId: input.session.userId,
    valueCents: input.valueCents ?? 0,
    workspaceId: input.session.workspaceId,
  });
}

async function recordDealOutcomeAnalyticsEvent(input: {
  deal: DealRow;
  fromStage: string | null;
  reason?: string;
  session: AppSession;
  valueCents: number;
}) {
  const eventType = input.deal.stage === "Gewonnen"
    ? "deal_won"
    : isLostDealStage(input.deal.stage)
      ? "deal_lost"
      : null;

  if (!eventType) return null;

  return recordAnalyticsEvent({
    dealId: input.deal.id,
    entityId: input.deal.id,
    entityType: "deal",
    eventType,
    metadata: {
      fromStage: input.fromStage,
      lostReasonCategory: input.deal.lostReasonCategory,
      lostReasonDetail: input.deal.lostReasonDetail,
      reason: input.reason ?? null,
      toStage: input.deal.stage,
    },
    module: "pipeline",
    occurredAt: input.deal.closedAt ?? input.deal.lostAt ?? new Date().toISOString(),
    projectId: input.deal.projectId,
    session: input.session,
    source: input.deal.source,
    valueCents: input.valueCents,
  });
}

function inferAnalyticsEntityId(
  input: {
    contactId?: string | null;
    dealId?: string | null;
    funnelId?: string | null;
    leadId?: string | null;
  },
  metadata: Record<string, unknown>,
) {
  if (isUuid(input.dealId)) return input.dealId;
  if (isUuid(input.leadId)) return input.leadId;
  if (isUuid(input.contactId)) return input.contactId;
  if (isUuid(input.funnelId)) return input.funnelId;
  if (isUuid(metadata.entityId as string)) return metadata.entityId as string;
  if (isUuid(metadata.viewId as string)) return metadata.viewId as string;
  if (isUuid(metadata.campaignId as string)) return metadata.campaignId as string;
  if (isUuid(metadata.botId as string)) return metadata.botId as string;

  return null;
}

function inferAnalyticsEntityType(input: {
  contactId?: string | null;
  dealId?: string | null;
  funnelId?: string | null;
  leadId?: string | null;
}) {
  if (isUuid(input.dealId)) return "deal";
  if (isUuid(input.leadId)) return "lead";
  if (isUuid(input.contactId)) return "contact";
  if (isUuid(input.funnelId)) return "funnel";

  return null;
}

const contactSelectSql = `
  select
    c.id,
    c.workspace_id as "workspaceId",
    c.project_id as "projectId",
    c.organization_id as "organizationId",
    c.name,
    c.role,
    c.source,
    c.intent,
    c.consent_label as consent,
    c.email,
    c.phone,
    p.name as project
  from contacts c
  left join projects p on p.id = c.project_id and p.workspace_id = c.workspace_id
`;

const leadReturningSql = `
  id,
  workspace_id as "workspaceId",
  project_id as "projectId",
  contact_id as "contactId",
  assigned_to_user_id as "assignedToUserId",
  source,
  type,
  status,
  score,
  budget,
  intent,
  next_action as "nextAction",
  received_at as "receivedAt",
  sla_due_at as "slaDueAt",
  last_contact_at as "lastContactAt",
  next_contact_at as "nextContactAt",
  region,
  object_type as "objectType",
  rooms,
  area_sqm as "areaSqm",
  hot_status as "hotStatus",
  buyer_profile as "buyerProfile",
  seller_profile as "sellerProfile",
  investor_profile as "investorProfile"
`;

const leadSelectSql = `
  select ${leadReturningSql}
  from leads l
`;

const dealSelectSql = `
  select
    d.id,
    d.workspace_id as "workspaceId",
    d.project_id as "projectId",
    d.contact_id as "contactId",
    d.organization_id as "organizationId",
    d.owner_user_id as "ownerUserId",
    d.lead_id as "leadId",
    d.name,
    d.stage,
    d.value_cents as "valueCents",
    d.probability,
    d.expected_close_date::text as "expectedCloseDate",
    d.lost_reason_category as "lostReasonCategory",
    d.lost_reason_detail as "lostReasonDetail",
    d.lost_at as "lostAt",
    d.closed_at as "closedAt",
    d.risk_level as "riskLevel",
    d.source,
    d.next_action as "nextAction"
  from deals d
`;

const dealUpdateSql = `
  update deals
  set
    project_id = $3::uuid,
    contact_id = $4::uuid,
    organization_id = $5::uuid,
    owner_user_id = $6::uuid,
    lead_id = $7::uuid,
    name = $8,
    stage = $9,
    value_cents = $10,
    probability = $11,
    expected_close_date = $12::date,
    risk_level = $13,
    source = $14,
    next_action = $15,
    metadata = metadata || $16::jsonb,
    lost_reason_category = $17,
    lost_reason_detail = $18,
    lost_at = $19::timestamptz,
    closed_at = $20::timestamptz,
    updated_at = now()
`;

const taskSelectSql = `
  select
    t.id,
    t.workspace_id as "workspaceId",
    t.project_id as "projectId",
    t.contact_id as "contactId",
    t.lead_id as "leadId",
    t.owner_user_id as "ownerUserId",
    t.title,
    p.name as project,
    t.due_at as due,
    t.priority,
    t.status
  from tasks t
  left join projects p on p.id = t.project_id
`;

function toDashboardViewRecord(row: DashboardViewRow): DashboardViewRecord {
  const payload = asObject(row.layout);
  const layout = Array.isArray(row.layout)
    ? row.layout
    : Array.isArray(payload.layout)
      ? payload.layout
      : [];
  const widgets = Array.isArray(payload.widgets)
    ? payload.widgets.map(String).filter(Boolean)
    : layout.map((item) => asObject(item).i).filter((item): item is string => typeof item === "string");

  return {
    filters: row.filters && typeof row.filters === "object" ? row.filters : {},
    id: row.id,
    isDefault: Boolean(row.isDefault),
    layout,
    name: row.name,
    projectId: row.projectId ?? undefined,
    updatedAt: toIso(row.updatedAt),
    widgets,
  };
}

function toDealStageHistoryEntry(row: DealStageHistoryRow): DealStageHistoryEntry {
  return {
    changedAt: toIso(row.changedAt),
    changedByName: row.changedByName ?? undefined,
    changedByUserId: row.changedByUserId ?? undefined,
    dealId: row.dealId,
    fromStage: row.fromStage ?? undefined,
    id: row.id,
    projectId: row.projectId ?? undefined,
    reason: row.reason ?? undefined,
    reasonCategory: row.reasonCategory ?? undefined,
    reasonDetail: row.reasonDetail || undefined,
    toStage: row.toStage,
    workspaceId: row.workspaceId,
  };
}

function toDeal(row: DealRow): Deal {
  return {
    closedAt: toIso(row.closedAt) || undefined,
    contactId: row.contactId ?? "",
    expectedCloseDate: normalizeDateOnly(row.expectedCloseDate),
    id: row.id,
    leadId: row.leadId ?? undefined,
    lostAt: toIso(row.lostAt) || undefined,
    lostReasonCategory: row.lostReasonCategory ?? undefined,
    lostReasonDetail: row.lostReasonDetail || undefined,
    name: row.name,
    nextAction: row.nextAction,
    organizationId: row.organizationId ?? undefined,
    ownerUserId: row.ownerUserId ?? undefined,
    probability: Number(row.probability ?? 0),
    projectId: row.projectId ?? "",
    riskLevel: row.riskLevel,
    source: row.source,
    stage: row.stage,
    value: formatEuroFromCents(row.valueCents),
    workspaceId: row.workspaceId,
  };
}

function toContact(row: ContactRow): Contact {
  return {
    consent: row.consent,
    email: row.email ?? undefined,
    id: row.id,
    intent: row.intent,
    name: row.name,
    organizationId: row.organizationId ?? undefined,
    phone: row.phone ?? undefined,
    project: row.project ?? "",
    projectId: row.projectId ?? "",
    role: row.role,
    source: row.source,
    workspaceId: row.workspaceId,
  };
}

function toLead(row: LeadRow): Lead {
  return {
    areaSqm: toOptionalNumber(row.areaSqm),
    assignedToUserId: row.assignedToUserId ?? undefined,
    budget: row.budget ?? undefined,
    buyerProfile: row.buyerProfile ?? undefined,
    contactId: row.contactId ?? "",
    hotStatus: row.hotStatus,
    id: row.id,
    intent: row.intent,
    investorProfile: row.investorProfile ?? undefined,
    lastContactAt: toOptionalIso(row.lastContactAt),
    nextAction: row.nextAction,
    nextContactAt: toOptionalIso(row.nextContactAt),
    objectType: row.objectType ?? undefined,
    projectId: row.projectId ?? "",
    receivedAt: toIso(row.receivedAt),
    region: row.region ?? undefined,
    rooms: toOptionalNumber(row.rooms),
    score: Number(row.score ?? 0),
    sellerProfile: row.sellerProfile ?? undefined,
    slaDueAt: toIso(row.slaDueAt),
    source: row.source,
    status: row.status,
    type: row.type,
    workspaceId: row.workspaceId,
  };
}

function toTask(row: TaskRow): Task {
  return {
    contactId: row.contactId ?? undefined,
    due: toIso(row.due),
    id: row.id,
    leadId: row.leadId ?? undefined,
    priority: row.priority,
    project: row.project ?? "",
    projectId: row.projectId ?? "",
    status: row.status,
    title: row.title,
    workspaceId: row.workspaceId,
  };
}

function normalizeTimelineOutcome(value: unknown): CrmNoteRecord["outcome"] {
  return value === "offen" || value === "erledigt" || value === "risiko" || value === "info" ? value : "info";
}

function toNoteRecord(row: NoteRow): CrmNoteRecord {
  const metadata = asObject(row.metadata);
  return {
    contactId: row.contactId,
    detail: row.detail,
    id: row.id,
    leadId: normalizeWriteProjectId(metadata.leadId) ?? undefined,
    occurredAt: toIso(row.occurredAt),
    outcome: normalizeTimelineOutcome(row.outcome),
    projectId: row.projectId ?? undefined,
    title: row.title,
    workspaceId: row.workspaceId,
  };
}

function normalizeCalendarEventLocation(value: unknown): CalendarEvent["location"] {
  if (value === "Teams" || value === "Google Meet" || value === "Vor Ort" || value === "Telefon" || value === "Extern") {
    return value;
  }
  return "Telefon";
}

function normalizeCalendarEventStatus(value: unknown): CalendarEvent["status"] {
  if (value === "geplant" || value === "vorbereiten" || value === "bestätigt" || value === "nachfassen") {
    return value;
  }
  return "geplant";
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String).map((item) => item.trim()).filter(Boolean);
}

function toCalendarEventRecord(row: CalendarEventWriteRow): CalendarEvent {
  const metadata = asObject(row.metadata);
  const calendarProvider = metadata.calendarProvider === "microsoft" || metadata.calendarProvider === "google"
    ? metadata.calendarProvider
    : "manual";
  const meetingProvider = metadata.meetingProvider === "microsoft-teams" ||
    metadata.meetingProvider === "google-meet" ||
    metadata.meetingProvider === "manual-link" ||
    metadata.meetingProvider === "phone"
    ? metadata.meetingProvider
    : "manual-link";

  return {
    calendarProvider,
    contactId: row.contactId ?? undefined,
    endsAt: toIso(row.endsAt),
    externalCalendarId: typeof metadata.externalCalendarId === "string" ? metadata.externalCalendarId : undefined,
    googleMeetJoinUrl: typeof metadata.googleMeetJoinUrl === "string" ? metadata.googleMeetJoinUrl : undefined,
    id: row.id,
    leadId: row.leadId ?? undefined,
    location: normalizeCalendarEventLocation(row.location),
    meetingProvider,
    outcomeGoal: row.outcomeGoal,
    ownerUserId: row.ownerUserId ?? undefined,
    preparation: normalizeStringArray(row.preparation),
    projectId: row.projectId ?? "",
    startsAt: toIso(row.startsAt),
    status: normalizeCalendarEventStatus(row.status),
    teamsJoinUrl: row.teamsJoinUrl ?? undefined,
    title: row.title,
    workspaceId: row.workspaceId,
  };
}

function toFunnel(row: FunnelRow): Funnel {
  return {
    audience: row.audience,
    conversionRate: Number(row.conversionRate ?? 0),
    entryChannel: row.entryChannel,
    goal: row.goal,
    id: row.id,
    leads: Number(row.leads ?? 0),
    name: row.name,
    ownerUserId: row.ownerUserId ?? undefined,
    projectId: row.projectId ?? "",
    status: row.status,
    visits: Number(row.visits ?? 0),
    workspaceId: row.workspaceId,
  };
}

function cleanString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function normalizeDealStageForWrite(value: unknown): DealStage | null {
  return typeof value === "string" && dealStages.includes(value as DealStage) ? value as DealStage : null;
}

async function resolveValidDealStageForWrite(input: {
  fallbackStage?: DealStage;
  projectId: string | null;
  requestedStage: unknown;
  session: AppSession;
}): Promise<{ ok: true; stage: DealStage } | { ok: false; reason: string }> {
  const requestedStage = cleanString(input.requestedStage) || input.fallbackStage || "";
  if (!requestedStage) return { ok: false, reason: "Invalid deal stage" };

  if (isUuid(input.projectId)) {
    const dbStage = await findProjectPipelineStage({
      projectId: input.projectId,
      stage: requestedStage,
      workspaceId: input.session.workspaceId,
    });

    if (dbStage) return { ok: true, stage: dbStage.name as DealStage };

    const hasProjectStages = await projectHasPipelineStages({
      projectId: input.projectId,
      workspaceId: input.session.workspaceId,
    });

    if (hasProjectStages) {
      return { ok: false, reason: "Deal stage is not configured for this project pipeline" };
    }
  }

  const fallbackStage = normalizeDealStageForWrite(requestedStage);
  return fallbackStage ? { ok: true, stage: fallbackStage } : { ok: false, reason: "Invalid deal stage" };
}

async function findProjectPipelineStage(input: {
  projectId: string;
  stage: string;
  workspaceId: string;
}) {
  return queryOne<PipelineStageValidationRow>(
    `
      select
        s.name,
        s.category,
        s.probability
      from crm_pipeline_stages s
      join crm_pipelines p on p.id = s.pipeline_id and p.workspace_id = s.workspace_id
      where s.workspace_id = $1
        and (s.project_id = $2 or p.project_id = $2)
        and (lower(s.name) = lower($3) or lower(s.key) = lower($3))
      order by p.is_default desc, s.position asc
      limit 1
    `,
    [input.workspaceId, input.projectId, input.stage],
  );
}

async function projectHasPipelineStages(input: { projectId: string; workspaceId: string }) {
  const row = await queryOne<CountPipelineStageRow>(
    `
      select count(*) as count
      from crm_pipeline_stages s
      join crm_pipelines p on p.id = s.pipeline_id and p.workspace_id = s.workspace_id
      where s.workspace_id = $1
        and (s.project_id = $2 or p.project_id = $2)
    `,
    [input.workspaceId, input.projectId],
  );

  return Number(row?.count ?? 0) > 0;
}

function normalizeDealCloseReasonCategory(value: unknown): DealCloseReasonCategory | null {
  return typeof value === "string" && dealCloseReasonCategories.includes(value as DealCloseReasonCategory)
    ? value as DealCloseReasonCategory
    : null;
}

function isTerminalDealStage(stage: string | null | undefined) {
  return stage === "Gewonnen" || stage === "Verloren" || stage === "Disqualifiziert" || stage === "Pausiert / Verloren";
}

function isLostDealStage(stage: string | null | undefined) {
  return stage === "Verloren" || stage === "Disqualifiziert" || stage === "Pausiert / Verloren";
}

function resolveDealCloseState(input: {
  existing: DealRow | null;
  reason?: string;
  reasonCategory?: unknown;
  reasonDetail?: string;
  stageChanged: boolean;
  targetStage: DealStage;
}):
  | {
      data: {
        closedAt: string | null;
        lostAt: string | null;
        lostReasonCategory: DealCloseReasonCategory | null;
        lostReasonDetail: string;
      };
      ok: true;
    }
  | { ok: false; reason: string } {
  if (!input.stageChanged) {
    return {
      data: {
        closedAt: toIso(input.existing?.closedAt ?? null) || null,
        lostAt: toIso(input.existing?.lostAt ?? null) || null,
        lostReasonCategory: input.existing?.lostReasonCategory ?? null,
        lostReasonDetail: input.existing?.lostReasonDetail ?? "",
      },
      ok: true,
    };
  }

  if (!isTerminalDealStage(input.targetStage)) {
    return {
      data: {
        closedAt: null,
        lostAt: null,
        lostReasonCategory: null,
        lostReasonDetail: "",
      },
      ok: true,
    };
  }

  const changedAt = new Date().toISOString();
  const category =
    input.targetStage === "Gewonnen"
      ? normalizeDealCloseReasonCategory(input.reasonCategory) ?? "won"
      : normalizeDealCloseReasonCategory(input.reasonCategory);

  if (!category) {
    return { ok: false, reason: "Structured lost reason is required" };
  }

  const detail = cleanString(input.reasonDetail) || cleanString(input.reason) || "";
  if (isLostDealStage(input.targetStage) && detail.length < 3) {
    return { ok: false, reason: "Lost reason detail is required" };
  }

  return {
    data: {
      closedAt: changedAt,
      lostAt: isLostDealStage(input.targetStage) ? changedAt : null,
      lostReasonCategory: category,
      lostReasonDetail: detail || category,
    },
    ok: true,
  };
}

async function assertPipelineStagePermission(input: {
  deal: DealRow;
  session: AppSession;
  targetStage: DealStage;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (canManageWorkspaceRecords(input.session)) {
    return { ok: true };
  }

  if (!isUuid(input.session.userId) || !isUuid(input.deal.projectId)) {
    return { ok: false, reason: "Project pipeline permission is required" };
  }

  let permission: PipelinePermissionRow | null = null;
  try {
    permission = await queryOne<PipelinePermissionRow>(
      `
        select
          can_edit_deals as "canEditDeals",
          can_move_deals as "canMoveDeals",
          can_close_deals as "canCloseDeals",
          can_reopen_deals as "canReopenDeals"
        from project_pipeline_permissions
        where workspace_id = $1
          and project_id = $2
          and user_id = $3
        limit 1
      `,
      [input.session.workspaceId, input.deal.projectId, input.session.userId],
    );
  } catch {
    permission = null;
  }

  const isClosing = isTerminalDealStage(input.targetStage);
  const isReopening = isTerminalDealStage(input.deal.stage) && !isTerminalDealStage(input.targetStage);

  if (permission) {
    const allowed = isReopening
      ? permission.canReopenDeals
      : isClosing
        ? permission.canCloseDeals
        : permission.canMoveDeals;
    return allowed && permission.canEditDeals
      ? { ok: true }
      : { ok: false, reason: "Project pipeline permission denied" };
  }

  if (input.deal.ownerUserId === input.session.userId && !isClosing && !isReopening) {
    return { ok: true };
  }

  return { ok: false, reason: "Project pipeline permission is required" };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function clampNumber(value: unknown, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.max(min, Math.min(max, parsed));
}

function toCents(value: unknown) {
  const lowerValue = String(value ?? "0").toLowerCase();
  const isMillion = lowerValue.includes("mio");
  const normalized = lowerValue
    .replace(/mio\.?/g, "")
    .replace(/eur/g, "")
    .replace(/€/g, "")
    .replace(/\s/g, "")
    .replace(/\./g, "")
    .replace(",", ".");
  const parsed = Number(normalized.replace(/[^\d.]/g, ""));
  if (!Number.isFinite(parsed)) return 0;

  return Math.round((isMillion ? parsed * 1_000_000 : parsed) * 100);
}

function formatEuroFromCents(value: number | string) {
  const cents = Number(value || 0);
  return new Intl.NumberFormat(getLocale(defaultLanguage), {
    currency: "EUR",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(cents / 100);
}

function normalizeRiskLevel(value: unknown, probability: number): Deal["riskLevel"] {
  if (value === "hoch" || value === "mittel" || value === "niedrig") return value;
  if (probability < 45) return "hoch";
  if (probability < 65) return "mittel";
  return "niedrig";
}

function cleanDateInput(value: unknown) {
  if (!value) return "";
  const raw = value instanceof Date ? value.toISOString() : String(value);

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}T09:00:00.000Z`;

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

function normalizeDateOnly(value: unknown) {
  if (!value) return "";
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  const match = String(value).trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? "";
}

function toIso(value: string | Date | null) {
  if (!value) return "";
  return value instanceof Date ? value.toISOString() : String(value);
}

function toNullableIso(value: string | Date | null | undefined) {
  const iso = toIso(value ?? null);
  return iso || null;
}

function toOptionalIso(value: string | Date | null | undefined) {
  const iso = toIso(value ?? null);
  return iso || undefined;
}

function toOptionalNumber(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
