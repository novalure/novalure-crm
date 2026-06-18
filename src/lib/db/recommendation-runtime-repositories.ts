import type { AppSession } from "@/lib/auth/session";
import { runBotGovernanceEvaluation } from "@/lib/bots/evaluation";
import type { CoreCrmModuleSources } from "@/lib/db/crm-loaders";
import { writeCrmAnalyticsEvent } from "@/lib/db/analytics-event-repositories";
import { queryOne, queryRows } from "@/lib/db/client";
import {
  evaluateOutboundConsent,
  type ConsentPolicyChannel,
  type ConsentPolicyPurpose,
} from "@/lib/db/consent-policy";
import { upsertTaskRecord } from "@/lib/db/crm-write-repositories";
import { recordSpeedToLeadEvent } from "@/lib/db/speed-to-lead-repositories";
import { queueTeamsNotification } from "@/lib/db/teams-notification-repositories";
import { canPersist, isUuid, writeAuditLog } from "@/lib/db/runtime-repositories";

type IdRow = { id: string };
type CountRow = { count: number | string };

type DealOperationalRow = {
  contactId: string | null;
  expectedCloseDate: string | Date | null;
  id: string;
  name: string;
  ownerUserId: string | null;
  probability: number | string;
  projectId: string | null;
  stage: string;
  valueCents: number | string;
};

type ProjectOperationalRow = {
  id: string;
  name: string;
};

type ContactRow = {
  email: string | null;
  id: string;
  name: string;
  phone: string | null;
  projectId: string | null;
};

type LeadRow = {
  assignedToUserId: string | null;
  contactId: string | null;
  id: string;
  intent: string;
  nextAction: string;
  projectId: string | null;
  score: number | string;
  slaDueAt: string | Date | null;
};

type UnitRow = {
  id: string;
  projectId: string;
  status: string;
  unitNumber: string;
};

type CustomerAccessRiskRow = {
  activationScore: number | string;
  activeUsers: number | string;
  customerAccessId: string;
  customerName: string | null;
  health: string;
  invitedUsers: number | string;
  nextOnboardingAction: string | null;
  ownerUserId: string | null;
  projectId: string | null;
  status: string;
};

type ConversionSnapshotSummaryRow = {
  bookingsCount: number | string;
  closedRevenueCents: number | string;
  id: string;
  leadsCount: number | string;
  lostDealsCount: number | string;
  periodEnd: string | Date;
  periodStart: string | Date;
  reservationsCount: number | string;
  unitSalesVelocity: number | string;
  wonDealsCount: number | string;
};

type BotQualityTargetRow = {
  id: string;
  name: string;
  ownerUserId: string | null;
  projectId: string | null;
  status: string;
};

type BotAnswerQualityCheckRow = {
  botId: string | null;
  citationCoverage: number | string;
  handoffQuality: number | string;
  id: string;
  projectId: string | null;
  result: Record<string, unknown> | null;
  riskyAnswerCount: number | string;
};

type BotEvaluationQualityRow = {
  botId: string | null;
  handoffFailures: number | string;
  hallucinationFailures: number | string;
  id: string;
  projectId: string | null;
  redTeamFailures: number | string;
  result: Record<string, unknown> | null;
  score: number | string;
  sourceCoverage: number | string;
};

type BotQualityReviewSeverity = "warning" | "risk";

type BotQualityReviewIssueRow = {
  id: string;
};

type BotQualityReviewTaskRow = {
  id: string;
};

export type RecommendationRuntimeSummary = {
  botAnswerChecks: number;
  botAnswerReviewIssues: number;
  bulkFollowUpBatches: number;
  cleanupActions: number;
  consentCoverage: Array<{
    allowed: number;
    blocked: number;
    channel: string;
    purpose: string;
  }>;
  conversionSnapshots: number;
  fallbackAudits: number;
  followUpActions: number;
  latestConversionSnapshot: {
    bookingsCount: number;
    closedRevenueCents: number;
    id: string;
    leadsCount: number;
    lostDealsCount: number;
    periodEnd: string;
    periodStart: string;
    reservationsCount: number;
    unitSalesVelocity: number;
    wonDealsCount: number;
  } | null;
  onboardingRiskAlerts: number;
  offerMilestones: number;
  outreachDeliveries: number;
  completionRuns: number;
  funnelConversionReports: number;
  microsoftBookingChecks: number;
  permissionAuditWarnings: number;
  pipelineBulkActions: number;
  pipelineForecasts: number;
  sequenceRuntimeReviews: number;
  unitAuditEvents: number;
  viewingSlots: number;
};

export type RecommendationRuntimeResult =
  | { data: unknown; persisted: true }
  | { persisted: false; reason: string };

function cleanString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function normalizeUuid(value: unknown) {
  return isUuid(cleanString(value)) ? cleanString(value) : null;
}

function normalizeDate(value: unknown) {
  if (!value) return null;
  const date = new Date(value instanceof Date ? value.toISOString() : String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeNumber(value: unknown, fallback = 0) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeChannel(value: unknown): ConsentPolicyChannel {
  const channel = cleanString(value);
  if (
    channel === "Newsletter" ||
    channel === "E-Mail" ||
    channel === "WhatsApp" ||
    channel === "Instagram" ||
    channel === "Telefon" ||
    channel === "Tracking Pixel" ||
    channel === "CAPI" ||
    channel === "Webhook"
  ) {
    return channel;
  }

  return "E-Mail";
}

function normalizePurpose(value: unknown): ConsentPolicyPurpose {
  const purpose = cleanString(value);
  if (
    purpose === "newsletter" ||
    purpose === "botOutreach" ||
    purpose === "salesFollowUp" ||
    purpose === "meetingFollowUp" ||
    purpose === "tracking" ||
    purpose === "webhook"
  ) {
    return purpose;
  }

  return "salesFollowUp";
}

async function countRows(query: string, params: unknown[]) {
  const row = await queryOne<CountRow>(query, params);
  return Number(row?.count ?? 0);
}

function isMissingRelationError(error: unknown) {
  return error instanceof Error && /relation "[^"]+" does not exist/i.test(error.message);
}

async function safeCountRows(query: string, params: unknown[]) {
  try {
    return await countRows(query, params);
  } catch (error) {
    if (isMissingRelationError(error)) return 0;
    throw error;
  }
}

async function safeQueryOne<Row extends Record<string, unknown>>(query: string, params: unknown[]) {
  try {
    return await queryOne<Row>(query, params);
  } catch (error) {
    if (isMissingRelationError(error)) return null;
    throw error;
  }
}

async function safeQueryRows<Row extends Record<string, unknown>>(query: string, params: unknown[]) {
  try {
    return await queryRows<Row>(query, params);
  } catch (error) {
    if (isMissingRelationError(error)) return [];
    throw error;
  }
}

async function loadContact(session: AppSession, contactId?: string | null) {
  if (!isUuid(contactId)) return null;

  return queryOne<ContactRow>(
    `
      select
        id,
        project_id as "projectId",
        name,
        email,
        phone
      from contacts
      where id = $1::uuid and workspace_id = $2::uuid
      limit 1
    `,
    [contactId, session.workspaceId],
  );
}

async function loadLead(session: AppSession, leadId?: string | null) {
  if (!isUuid(leadId)) return null;

  return queryOne<LeadRow>(
    `
      select
        id,
        project_id as "projectId",
        contact_id as "contactId",
        assigned_to_user_id as "assignedToUserId",
        intent,
        next_action as "nextAction",
        score,
        sla_due_at as "slaDueAt"
      from leads
      where id = $1::uuid and workspace_id = $2::uuid
      limit 1
    `,
    [leadId, session.workspaceId],
  );
}

async function loadUnit(session: AppSession, unitId?: string | null) {
  if (!isUuid(unitId)) return null;

  return queryOne<UnitRow>(
    `
      select
        id,
        project_id as "projectId",
        unit_number as "unitNumber",
        status
      from property_units
      where id = $1::uuid and workspace_id = $2::uuid
      limit 1
    `,
    [unitId, session.workspaceId],
  );
}

export async function listRecommendationRuntimeSummary(input: {
  projectId?: string | null;
  session: AppSession;
}): Promise<RecommendationRuntimeSummary> {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return {
      botAnswerChecks: 0,
      botAnswerReviewIssues: 0,
      bulkFollowUpBatches: 0,
      cleanupActions: 0,
      completionRuns: 0,
      consentCoverage: [],
      conversionSnapshots: 0,
      fallbackAudits: 0,
      funnelConversionReports: 0,
      followUpActions: 0,
      latestConversionSnapshot: null,
      microsoftBookingChecks: 0,
      onboardingRiskAlerts: 0,
      offerMilestones: 0,
      outreachDeliveries: 0,
      permissionAuditWarnings: 0,
      pipelineBulkActions: 0,
      pipelineForecasts: 0,
      sequenceRuntimeReviews: 0,
      unitAuditEvents: 0,
      viewingSlots: 0,
    };
  }

  const projectId = normalizeUuid(input.projectId);
  const params = [input.session.workspaceId, projectId];
  const projectWhere = "workspace_id = $1::uuid and ($2::uuid is null or project_id = $2::uuid)";
  const [
    fallbackAudits,
    followUpActions,
    viewingSlots,
    unitAuditEvents,
    offerMilestones,
    botAnswerChecks,
    botAnswerReviewIssues,
    conversionSnapshots,
    onboardingRiskAlerts,
    cleanupActions,
    bulkFollowUpBatches,
    permissionAuditWarnings,
    outreachDeliveries,
    completionRuns,
    pipelineForecasts,
    pipelineBulkActions,
    funnelConversionReports,
    microsoftBookingChecks,
    sequenceRuntimeReviews,
    latestConversionSnapshot,
    consentRows,
  ] = await Promise.all([
    safeCountRows(`select count(*) from crm_fallback_audits where ${projectWhere} and status = 'open'`, params),
    safeCountRows(`select count(*) from crm_follow_up_actions where ${projectWhere}`, params),
    safeCountRows(`select count(*) from property_viewing_slots where ${projectWhere}`, params),
    safeCountRows(`select count(*) from property_unit_audit_events where ${projectWhere}`, params),
    safeCountRows(`select count(*) from property_offer_milestones where ${projectWhere}`, params),
    safeCountRows(`select count(*) from bot_answer_quality_checks where ${projectWhere}`, params),
    safeCountRows(
      `select count(*) from data_quality_issues where ${projectWhere} and issue_type = 'bot_answer_quality_review' and status = 'open'`,
      params,
    ),
    safeCountRows(`select count(*) from crm_conversion_snapshots where ${projectWhere}`, params),
    safeCountRows(`select count(*) from customer_onboarding_risk_alerts where ${projectWhere} and status = 'open'`, params),
    safeCountRows(`select count(*) from data_quality_cleanup_actions where workspace_id = $1::uuid`, [input.session.workspaceId]),
    safeCountRows(`select count(*) from crm_bulk_runtime_batches where ${projectWhere}`, params),
    safeCountRows(`select count(*) from crm_permission_audit_runs where ${projectWhere} and status <> 'ok'`, params),
    safeCountRows(`select count(*) from crm_outreach_deliveries where ${projectWhere}`, params),
    safeCountRows(`select count(*) from crm_operational_recommendation_runs where ${projectWhere}`, params),
    safeCountRows(`select count(*) from pipeline_forecast_snapshots where ${projectWhere}`, params),
    safeCountRows(`select count(*) from pipeline_bulk_actions where ${projectWhere}`, params),
    safeCountRows(`select count(*) from funnel_conversion_reports where ${projectWhere}`, params),
    safeCountRows(`select count(*) from microsoft_booking_health_checks where ${projectWhere}`, params),
    safeCountRows(`select count(*) from sequence_runtime_reviews where ${projectWhere}`, params),
    safeQueryOne<ConversionSnapshotSummaryRow>(
      `
        select
          id,
          period_start as "periodStart",
          period_end as "periodEnd",
          leads_count as "leadsCount",
          bookings_count as "bookingsCount",
          reservations_count as "reservationsCount",
          won_deals_count as "wonDealsCount",
          lost_deals_count as "lostDealsCount",
          closed_revenue_cents as "closedRevenueCents",
          unit_sales_velocity as "unitSalesVelocity"
        from crm_conversion_snapshots
        where ${projectWhere}
        order by period_end desc, created_at desc
        limit 1
      `,
      params,
    ),
    safeQueryRows<{ allowed: number | string; blocked: number | string; channel: string; purpose: string }>(
      `
        select
          channel,
          purpose,
          count(*) filter (where allowed)::int as allowed,
          count(*) filter (where not allowed)::int as blocked
        from consent_policy_decisions
        where ${projectWhere}
        group by channel, purpose
        order by channel, purpose
      `,
      params,
    ),
  ]);

  return {
    botAnswerChecks,
    botAnswerReviewIssues,
    bulkFollowUpBatches,
    cleanupActions,
    completionRuns,
    consentCoverage: consentRows.map((row) => ({
      allowed: Number(row.allowed ?? 0),
      blocked: Number(row.blocked ?? 0),
      channel: row.channel,
      purpose: row.purpose,
    })),
    conversionSnapshots,
    fallbackAudits,
    funnelConversionReports,
    followUpActions,
    latestConversionSnapshot: latestConversionSnapshot
      ? {
          bookingsCount: Number(latestConversionSnapshot.bookingsCount ?? 0),
          closedRevenueCents: Number(latestConversionSnapshot.closedRevenueCents ?? 0),
          id: latestConversionSnapshot.id,
          leadsCount: Number(latestConversionSnapshot.leadsCount ?? 0),
          lostDealsCount: Number(latestConversionSnapshot.lostDealsCount ?? 0),
          periodEnd:
            latestConversionSnapshot.periodEnd instanceof Date
              ? latestConversionSnapshot.periodEnd.toISOString()
              : String(latestConversionSnapshot.periodEnd),
          periodStart:
            latestConversionSnapshot.periodStart instanceof Date
              ? latestConversionSnapshot.periodStart.toISOString()
              : String(latestConversionSnapshot.periodStart),
          reservationsCount: Number(latestConversionSnapshot.reservationsCount ?? 0),
          unitSalesVelocity: Number(latestConversionSnapshot.unitSalesVelocity ?? 0),
          wonDealsCount: Number(latestConversionSnapshot.wonDealsCount ?? 0),
        }
      : null,
    microsoftBookingChecks,
    onboardingRiskAlerts,
    offerMilestones,
    outreachDeliveries,
    permissionAuditWarnings,
    pipelineBulkActions,
    pipelineForecasts,
    sequenceRuntimeReviews,
    unitAuditEvents,
    viewingSlots,
  };
}

export async function runFallbackAudit(input: {
  missingTables?: string[];
  moduleSources?: Partial<CoreCrmModuleSources> | Record<string, string>;
  projectId?: string | null;
  session: AppSession;
}): Promise<RecommendationRuntimeResult> {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return { persisted: false, reason: "DATABASE_URL is not configured" };
  }

  const moduleSources = input.moduleSources ?? {};
  const missingTables = (input.missingTables ?? []).map(cleanString).filter(Boolean);
  const projectId = normalizeUuid(input.projectId);
  const rows: Array<{ id: string; moduleKey: string; status: string }> = [];

  for (const [moduleKey, source] of Object.entries(moduleSources)) {
    const isFallback = source !== "database";
    const status = isFallback ? "open" : "resolved";
    const severity = source === "mock" ? "risk" : "warning";
    const detail = isFallback
      ? `${moduleKey} is currently using ${source || "fallback"} data.`
      : `${moduleKey} is database-backed.`;
    const row = await queryOne<{ id: string; moduleKey: string; status: string }>(
      `
        insert into crm_fallback_audits (
          workspace_id,
          project_id,
          module_key,
          source,
          severity,
          status,
          detail,
          next_action,
          metadata,
          resolved_at
        )
        values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::jsonb, case when $6 = 'resolved' then now() else null end)
        on conflict (workspace_id, project_id, module_key)
        do update set
          source = excluded.source,
          severity = excluded.severity,
          status = excluded.status,
          detail = excluded.detail,
          next_action = excluded.next_action,
          metadata = crm_fallback_audits.metadata || excluded.metadata,
          resolved_at = case when excluded.status = 'resolved' then now() else null end,
          updated_at = now()
        returning id, module_key as "moduleKey", status
      `,
      [
        input.session.workspaceId,
        projectId,
        moduleKey,
        source || "fallback",
        severity,
        status,
        detail,
        isFallback ? "Close DB write/read path or keep visible fallback warning." : "",
        JSON.stringify({ auditedByUserId: input.session.userId, missingTables }),
      ],
    );

    if (row) rows.push(row);
  }

  for (const tableName of missingTables) {
    const row = await queryOne<{ id: string; moduleKey: string; status: string }>(
      `
        insert into crm_fallback_audits (
          workspace_id,
          project_id,
          module_key,
          source,
          severity,
          status,
          detail,
          next_action,
          metadata
        )
        values ($1::uuid, $2::uuid, $3, 'missing_table', 'risk', 'open', $4, $5, $6::jsonb)
        on conflict (workspace_id, project_id, module_key)
        do update set
          source = excluded.source,
          severity = excluded.severity,
          status = 'open',
          detail = excluded.detail,
          next_action = excluded.next_action,
          metadata = crm_fallback_audits.metadata || excluded.metadata,
          updated_at = now()
        returning id, module_key as "moduleKey", status
      `,
      [
        input.session.workspaceId,
        projectId,
        `missing_table:${tableName}`,
        `Expected database table ${tableName} is missing.`,
        "Apply the current migration set before production use.",
        JSON.stringify({ auditedByUserId: input.session.userId, tableName }),
      ],
    );

    if (row) rows.push(row);
  }

  await Promise.all([
    writeAuditLog({
      action: "fallback_audit.completed",
      after: { rows },
      entityType: "crm_fallback_audit",
      projectId,
      session: input.session,
    }),
    writeCrmAnalyticsEvent({
      entityType: "crm_fallback_audit",
      eventType: "fallback_audit_completed",
      metadata: { missingTables, moduleSources },
      module: "dashboard",
      projectId,
      source: "analysis_bot",
      userId: input.session.userId,
      workspaceId: input.session.workspaceId,
    }),
  ]);

  return { data: rows, persisted: true };
}

async function createFollowUpDelivery(input: {
  actionId: string;
  actionType: string;
  allowed: boolean;
  channel: ConsentPolicyChannel;
  consentDecisionId?: string | null;
  consentReason?: string | null;
  contactId?: string | null;
  email?: string | null;
  leadId?: string | null;
  phone?: string | null;
  projectId?: string | null;
  purpose: ConsentPolicyPurpose;
  session: AppSession;
  subject?: string | null;
  taskId?: string | null;
}) {
  const recipient = input.channel === "E-Mail" ? cleanString(input.email) : cleanString(input.phone);
  const status = input.allowed ? (recipient || input.channel === "Telefon" ? "queued" : "pending_config") : "blocked";
  const provider =
    input.channel === "E-Mail"
      ? "resend"
      : input.channel === "WhatsApp" || input.channel === "Instagram"
        ? "meta"
        : input.channel === "Telefon"
          ? "manual"
          : "internal";
  let row: IdRow | null = null;
  try {
    row = await queryOne<IdRow>(
      `
        insert into crm_outreach_deliveries (
          workspace_id,
          project_id,
          contact_id,
          lead_id,
          task_id,
          follow_up_action_id,
          consent_decision_id,
          channel,
          purpose,
          provider,
          recipient,
          subject,
          status,
          error,
          metadata
        )
        values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)
        returning id
      `,
      [
        input.session.workspaceId,
        input.projectId,
        input.contactId,
        input.leadId,
        input.taskId,
        input.actionId,
        normalizeUuid(input.consentDecisionId),
        input.channel,
        input.purpose,
        provider,
        recipient,
        cleanString(input.subject) || input.actionType,
        status,
        status === "blocked" ? cleanString(input.consentReason) : null,
        JSON.stringify({
          actionType: input.actionType,
          consentReason: cleanString(input.consentReason),
          createdByUserId: input.session.userId,
          deliveryMode: provider === "manual" ? "manual_queue" : "provider_queue",
        }),
      ],
    );
  } catch {
    return null;
  }

  if (!row) return null;

  await writeCrmAnalyticsEvent({
    channel: input.channel,
    contactId: input.contactId,
    entityId: row.id,
    entityType: "crm_outreach_delivery",
    eventType: `outreach_delivery_${status}`,
    leadId: input.leadId,
    metadata: { actionId: input.actionId, actionType: input.actionType, provider },
    module: "lead_inbox",
    projectId: input.projectId,
    source: "productive_follow_up",
    userId: input.session.userId,
    workspaceId: input.session.workspaceId,
  });

  return { id: row.id, status };
}

export async function createProductiveFollowUpAction(input: {
  actionType?: string | null;
  channel?: string | null;
  contactId?: string | null;
  email?: string | null;
  leadId?: string | null;
  metadata?: Record<string, unknown> | null;
  outcome?: string | null;
  ownerUserId?: string | null;
  phone?: string | null;
  projectId?: string | null;
  purpose?: string | null;
  session: AppSession;
  taskTitle?: string | null;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return { persisted: false as const, reason: "DATABASE_URL is not configured" };
  }

  const lead = await loadLead(input.session, input.leadId);
  const contactId = normalizeUuid(input.contactId) ?? lead?.contactId ?? null;
  const contact = await loadContact(input.session, contactId);
  const projectId = normalizeUuid(input.projectId) ?? lead?.projectId ?? contact?.projectId ?? null;
  const ownerUserId = normalizeUuid(input.ownerUserId) ?? lead?.assignedToUserId ?? normalizeUuid(input.session.userId);
  const channel = normalizeChannel(input.channel);
  const purpose = normalizePurpose(input.purpose);
  const outcome = cleanString(input.outcome) || "planned";
  const actionType = cleanString(input.actionType) || "manual_follow_up";
  const consent = await evaluateOutboundConsent({
    channel,
    contactId,
    email: cleanString(input.email) || contact?.email,
    metadata: {
      actionType,
      source: "productive_follow_up",
    },
    phone: cleanString(input.phone) || contact?.phone,
    projectId,
    purpose,
    session: input.session,
  });
  const task = await upsertTaskRecord({
    session: input.session,
    task: {
      contactId: contactId ?? undefined,
      due: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      leadId: lead?.id,
      priority: normalizeNumber(lead?.score) >= 80 ? "Hoch" : "Normal",
      projectId: projectId ?? undefined,
      status: "open",
      title:
        cleanString(input.taskTitle) ||
        (consent.allowed ? lead?.nextAction : `Consent block prüfen: ${lead?.nextAction || contact?.name || actionType}`),
    },
  });

  const row = await queryOne<IdRow>(
    `
      insert into crm_follow_up_actions (
        workspace_id,
        project_id,
        contact_id,
        lead_id,
        task_id,
        owner_user_id,
        action_type,
        channel,
        outcome,
        consent_decision_id,
        allowed,
        metadata
      )
      values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, $8, $9, $10::uuid, $11, $12::jsonb)
      returning id
    `,
    [
      input.session.workspaceId,
      projectId,
      contactId,
      lead?.id ?? null,
      task.persisted ? task.data.id : null,
      ownerUserId,
      actionType,
      channel,
      outcome,
      normalizeUuid(consent.decisionId),
      consent.allowed,
      JSON.stringify({
        ...(input.metadata ?? {}),
        consentReason: consent.reason,
        createdByUserId: input.session.userId,
        taskPersisted: task.persisted,
      }),
    ],
  );

  if (!row) {
    return { persisted: false as const, reason: "Follow-up action could not be saved" };
  }

  const delivery = await createFollowUpDelivery({
    actionId: row.id,
    actionType,
    allowed: consent.allowed,
    channel,
    consentDecisionId: consent.decisionId,
    consentReason: consent.reason,
    contactId,
    email: cleanString(input.email) || contact?.email,
    leadId: lead?.id ?? null,
    phone: cleanString(input.phone) || contact?.phone,
    projectId,
    purpose,
    session: input.session,
    subject: cleanString(input.taskTitle) || lead?.nextAction || contact?.name || actionType,
    taskId: task.persisted ? task.data.id : null,
  });

  await Promise.all([
    recordSpeedToLeadEvent({
      analyticsEventType: outcome === "first_response" || outcome === "sent" ? "first_response" : "follow_up_action",
      channel,
      contactId,
      dueAt: lead?.slaDueAt,
      firstResponseAt: outcome === "first_response" || outcome === "sent" ? new Date().toISOString() : null,
      leadId: lead?.id,
      metadata: { actionId: row.id, actionType, allowed: consent.allowed, consentReason: consent.reason },
      ownerUserId,
      projectId,
      source: "productive_follow_up",
      state: "covered",
      userId: input.session.userId,
      workspaceId: input.session.workspaceId,
    }),
    writeAuditLog({
      action: "follow_up_action.created",
      after: { actionId: row.id, consent, delivery, outcome, taskId: task.persisted ? task.data.id : null },
      entityId: row.id,
      entityType: "crm_follow_up_action",
      projectId,
      session: input.session,
    }),
    writeCrmAnalyticsEvent({
      channel,
      contactId,
      entityId: row.id,
      entityType: "crm_follow_up_action",
      eventType: consent.allowed ? "follow_up_action_allowed" : "follow_up_action_blocked",
      leadId: lead?.id,
      metadata: { actionType, consentReason: consent.reason, outcome },
      module: "lead_inbox",
      projectId,
      source: "productive_follow_up",
      userId: input.session.userId,
      workspaceId: input.session.workspaceId,
    }),
  ]);

  return {
    data: {
      allowed: consent.allowed,
      consent,
      delivery,
      followUpActionId: row.id,
      taskId: task.persisted ? task.data.id : null,
    },
    persisted: true as const,
  };
}

export async function runBulkFollowUpActions(input: {
  actionType?: string | null;
  leads?: Array<{
    channel?: string | null;
    contactId?: string | null;
    email?: string | null;
    leadId?: string | null;
    ownerUserId?: string | null;
    phone?: string | null;
    projectId?: string | null;
    taskTitle?: string | null;
  }>;
  outcome?: string | null;
  projectId?: string | null;
  purpose?: string | null;
  session: AppSession;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return { persisted: false as const, reason: "DATABASE_URL is not configured" };
  }

  const leads = (input.leads ?? [])
    .filter((item) => normalizeUuid(item.leadId) || normalizeUuid(item.contactId))
    .slice(0, 50);
  if (!leads.length) {
    return { persisted: false as const, reason: "No leads were provided for bulk follow-up" };
  }

  const results: Array<{ allowed?: boolean; contactId?: string | null; followUpActionId?: string | null; leadId?: string | null }> = [];
  let failedCount = 0;

  for (const item of leads) {
    try {
      const result = await createProductiveFollowUpAction({
        actionType: cleanString(input.actionType) || "bulk_follow_up",
        channel: item.channel,
        contactId: item.contactId,
        email: item.email,
        leadId: item.leadId,
        metadata: { bulk: true },
        outcome: cleanString(input.outcome) || "planned",
        ownerUserId: item.ownerUserId,
        phone: item.phone,
        projectId: item.projectId ?? input.projectId,
        purpose: input.purpose,
        session: input.session,
        taskTitle: item.taskTitle,
      });

      if (result.persisted) {
        const data = result.data as { allowed?: boolean; followUpActionId?: string | null };
        results.push({
          allowed: data.allowed,
          contactId: normalizeUuid(item.contactId),
          followUpActionId: normalizeUuid(data.followUpActionId),
          leadId: normalizeUuid(item.leadId),
        });
      } else {
        failedCount += 1;
      }
    } catch {
      failedCount += 1;
    }
  }

  const projectIds = Array.from(new Set(leads.map((item) => normalizeUuid(item.projectId)).filter(Boolean)));
  const projectId = normalizeUuid(input.projectId) ?? (projectIds.length === 1 ? projectIds[0] : null);
  const succeededCount = results.length;
  const blockedCount = results.filter((item) => item.allowed === false).length;
  const row = await queryOne<IdRow>(
    `
      insert into crm_bulk_runtime_batches (
        workspace_id,
        project_id,
        action_type,
        entity_type,
        requested_count,
        succeeded_count,
        blocked_count,
        failed_count,
        metadata
      )
      values ($1::uuid, $2::uuid, $3, 'lead', $4, $5, $6, $7, $8::jsonb)
      returning id
    `,
    [
      input.session.workspaceId,
      projectId,
      cleanString(input.actionType) || "bulk_follow_up",
      leads.length,
      succeededCount,
      blockedCount,
      failedCount,
      JSON.stringify({
        createdByUserId: input.session.userId,
        followUpActionIds: results.map((item) => item.followUpActionId).filter(Boolean),
        leadIds: results.map((item) => item.leadId).filter(Boolean),
      }),
    ],
  );

  if (!row) return { persisted: false as const, reason: "Bulk follow-up batch could not be saved" };

  await Promise.all([
    writeAuditLog({
      action: "bulk_follow_up.created",
      after: { batchId: row.id, blockedCount, failedCount, requestedCount: leads.length, succeededCount },
      entityId: row.id,
      entityType: "crm_bulk_runtime_batch",
      projectId,
      session: input.session,
    }),
    writeCrmAnalyticsEvent({
      entityId: row.id,
      entityType: "crm_bulk_runtime_batch",
      eventType: "bulk_follow_up_prepared",
      metadata: { blockedCount, failedCount, requestedCount: leads.length, succeededCount },
      module: "lead_inbox",
      projectId,
      source: "lead_inbox",
      userId: input.session.userId,
      workspaceId: input.session.workspaceId,
    }),
  ]);

  return {
    data: {
      batchId: row.id,
      blockedCount,
      failedCount,
      requestedCount: leads.length,
      succeededCount,
    },
    persisted: true as const,
  };
}

export async function upsertViewingSlot(input: {
  contactId?: string | null;
  dealId?: string | null;
  endsAt?: string | null;
  leadId?: string | null;
  note?: string | null;
  ownerUserId?: string | null;
  session: AppSession;
  slotId?: string | null;
  startsAt?: string | null;
  status?: string | null;
  unitId?: string | null;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return { persisted: false as const, reason: "DATABASE_URL is not configured" };
  }

  const unit = await loadUnit(input.session, input.unitId);
  if (!unit) return { persisted: false as const, reason: "Unit was not found" };

  const startsAt = normalizeDate(input.startsAt) ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const endsAt = normalizeDate(input.endsAt) ?? new Date(new Date(startsAt).getTime() + 45 * 60 * 1000).toISOString();
  const status = ["planned", "confirmed", "completed", "cancelled", "no_show"].includes(cleanString(input.status))
    ? cleanString(input.status)
    : "planned";
  const slotId = normalizeUuid(input.slotId);
  const row = slotId
    ? await queryOne<IdRow>(
        `
          update property_viewing_slots
          set
            contact_id = $4::uuid,
            lead_id = $5::uuid,
            deal_id = $6::uuid,
            owner_user_id = $7::uuid,
            starts_at = $8::timestamptz,
            ends_at = $9::timestamptz,
            status = $10,
            note = $11,
            metadata = metadata || $12::jsonb,
            updated_at = now()
          where id = $1::uuid and workspace_id = $2::uuid and unit_id = $3::uuid
          returning id
        `,
        [
          slotId,
          input.session.workspaceId,
          unit.id,
          normalizeUuid(input.contactId),
          normalizeUuid(input.leadId),
          normalizeUuid(input.dealId),
          normalizeUuid(input.ownerUserId) ?? normalizeUuid(input.session.userId),
          startsAt,
          endsAt,
          status,
          cleanString(input.note),
          JSON.stringify({ updatedByUserId: input.session.userId }),
        ],
      )
    : await queryOne<IdRow>(
        `
          insert into property_viewing_slots (
            workspace_id,
            project_id,
            unit_id,
            contact_id,
            lead_id,
            deal_id,
            owner_user_id,
            starts_at,
            ends_at,
            status,
            note,
            metadata
          )
          values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8::timestamptz, $9::timestamptz, $10, $11, $12::jsonb)
          returning id
        `,
        [
          input.session.workspaceId,
          unit.projectId,
          unit.id,
          normalizeUuid(input.contactId),
          normalizeUuid(input.leadId),
          normalizeUuid(input.dealId),
          normalizeUuid(input.ownerUserId) ?? normalizeUuid(input.session.userId),
          startsAt,
          endsAt,
          status,
          cleanString(input.note),
          JSON.stringify({ createdByUserId: input.session.userId }),
        ],
      );

  if (!row) return { persisted: false as const, reason: "Viewing slot could not be saved" };

  await Promise.all([
    writeAuditLog({
      action: slotId ? "viewing_slot.updated" : "viewing_slot.created",
      after: { slotId: row.id, status, startsAt, unitId: unit.id },
      entityId: row.id,
      entityType: "property_viewing_slot",
      projectId: unit.projectId,
      session: input.session,
    }),
    writeCrmAnalyticsEvent({
      contactId: normalizeUuid(input.contactId),
      dealId: normalizeUuid(input.dealId),
      entityId: row.id,
      entityType: "property_viewing_slot",
      eventType: slotId ? "viewing_slot_updated" : "viewing_slot_created",
      leadId: normalizeUuid(input.leadId),
      metadata: { endsAt, startsAt, status, unitId: unit.id, unitNumber: unit.unitNumber },
      module: "meeting",
      projectId: unit.projectId,
      source: "project_sales_cockpit",
      userId: input.session.userId,
      workspaceId: input.session.workspaceId,
    }),
  ]);

  return { data: { slotId: row.id }, persisted: true as const };
}

export async function recordUnitAuditEvent(input: {
  after?: Record<string, unknown> | null;
  before?: Record<string, unknown> | null;
  eventType?: string | null;
  reason?: string | null;
  session: AppSession;
  unitId?: string | null;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return { persisted: false as const, reason: "DATABASE_URL is not configured" };
  }

  const unit = await loadUnit(input.session, input.unitId);
  if (!unit) return { persisted: false as const, reason: "Unit was not found" };

  const eventType = cleanString(input.eventType) || "unit_audit";
  const row = await queryOne<IdRow>(
    `
      insert into property_unit_audit_events (
        workspace_id,
        project_id,
        unit_id,
        actor_user_id,
        event_type,
        before,
        after,
        reason,
        metadata
      )
      values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::jsonb, $7::jsonb, $8, $9::jsonb)
      returning id
    `,
    [
      input.session.workspaceId,
      unit.projectId,
      unit.id,
      normalizeUuid(input.session.userId),
      eventType,
      JSON.stringify(input.before ?? null),
      JSON.stringify(input.after ?? null),
      cleanString(input.reason),
      JSON.stringify({ createdByUserId: input.session.userId }),
    ],
  );

  if (!row) return { persisted: false as const, reason: "Unit audit could not be saved" };

  await Promise.all([
    writeAuditLog({
      action: `unit.${eventType}`,
      after: input.after ?? null,
      before: input.before ?? null,
      entityId: unit.id,
      entityType: "property_unit",
      projectId: unit.projectId,
      session: input.session,
    }),
    writeCrmAnalyticsEvent({
      entityId: unit.id,
      entityType: "property_unit",
      eventType: `unit_${eventType}`,
      metadata: { auditEventId: row.id, reason: cleanString(input.reason), unitNumber: unit.unitNumber },
      module: "pipeline",
      projectId: unit.projectId,
      source: "project_sales_cockpit",
      userId: input.session.userId,
      workspaceId: input.session.workspaceId,
    }),
  ]);

  return { data: { auditEventId: row.id }, persisted: true as const };
}

export async function upsertOfferMilestone(input: {
  completedAt?: string | null;
  contactId?: string | null;
  dealId?: string | null;
  dueAt?: string | null;
  metadata?: Record<string, unknown> | null;
  milestone?: string | null;
  ownerUserId?: string | null;
  reason?: string | null;
  reservationId?: string | null;
  session: AppSession;
  status?: string | null;
  unitId?: string | null;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return { persisted: false as const, reason: "DATABASE_URL is not configured" };
  }

  const unit = await loadUnit(input.session, input.unitId);
  if (!unit) return { persisted: false as const, reason: "Unit was not found" };

  const milestone = [
    "offer_created",
    "offer_sent",
    "documents_complete",
    "contract_prepared",
    "contract_sent",
    "contract_signed",
    "lost",
  ].includes(cleanString(input.milestone))
    ? cleanString(input.milestone)
    : "offer_created";
  const status = ["open", "done", "blocked", "lost"].includes(cleanString(input.status)) ? cleanString(input.status) : "open";

  const row = await queryOne<IdRow>(
    `
      insert into property_offer_milestones (
        workspace_id,
        project_id,
        unit_id,
        reservation_id,
        contact_id,
        deal_id,
        milestone,
        status,
        due_at,
        completed_at,
        owner_user_id,
        metadata
      )
      values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, $8, $9::timestamptz, $10::timestamptz, $11::uuid, $12::jsonb)
      returning id
    `,
    [
      input.session.workspaceId,
      unit.projectId,
      unit.id,
      normalizeUuid(input.reservationId),
      normalizeUuid(input.contactId),
      normalizeUuid(input.dealId),
      milestone,
      status,
      normalizeDate(input.dueAt),
      normalizeDate(input.completedAt) ?? (status === "done" || status === "lost" ? new Date().toISOString() : null),
      normalizeUuid(input.ownerUserId) ?? normalizeUuid(input.session.userId),
      JSON.stringify({
        ...(input.metadata ?? {}),
        createdByUserId: input.session.userId,
        reason: cleanString(input.reason),
      }),
    ],
  );

  if (!row) return { persisted: false as const, reason: "Offer milestone could not be saved" };

  await Promise.all([
    writeAuditLog({
      action: "offer_milestone.created",
      after: { milestone, milestoneId: row.id, status, unitId: unit.id },
      entityId: row.id,
      entityType: "property_offer_milestone",
      projectId: unit.projectId,
      session: input.session,
    }),
    writeCrmAnalyticsEvent({
      contactId: normalizeUuid(input.contactId),
      dealId: normalizeUuid(input.dealId),
      entityId: row.id,
      entityType: "property_offer_milestone",
      eventType: `offer_milestone_${status}`,
      metadata: { milestone, reason: cleanString(input.reason), reservationId: normalizeUuid(input.reservationId), unitId: unit.id },
      module: "pipeline",
      projectId: unit.projectId,
      source: "project_sales_cockpit",
      userId: input.session.userId,
      workspaceId: input.session.workspaceId,
    }),
  ]);

  return { data: { milestoneId: row.id }, persisted: true as const };
}

export async function runBotAnswerQualityComparison(input: {
  botId?: string | null;
  projectId?: string | null;
  session: AppSession;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return { persisted: false as const, reason: "DATABASE_URL is not configured" };
  }

  const botId = normalizeUuid(input.botId);
  const projectId = normalizeUuid(input.projectId);
  const row = await queryOne<IdRow>(
    `
      with latest_eval as (
        select id, bot_id, project_id, result
        from bot_evaluation_runs
        where workspace_id = $1::uuid
          and ($2::uuid is null or bot_id = $2::uuid)
          and ($3::uuid is null or project_id = $3::uuid)
        order by created_at desc
        limit 1
      ),
      answer_stats as (
        select
          bc.bot_id,
          bc.project_id,
          count(bm.id) filter (where bm.role = 'assistant')::int as assistant_messages,
          count(bm.id) filter (
            where bm.role = 'assistant'
              and not (
                jsonb_typeof(bm.metadata->'citations') = 'array'
                and jsonb_array_length(bm.metadata->'citations') > 0
              )
              and not (bm.content ~* '(^|\n)(quellen|sources):')
          )::int as missing_citations,
          count(bm.id) filter (
            where bm.role = 'assistant'
              and (
                bm.metadata #>> '{botRunSummary,humanApprovalRequired}' = 'true'
                or bm.metadata #>> '{autonomy,replyBlocked}' = 'true'
                or bm.content ilike '%handoff%'
                or bm.content ilike '%human%'
                or bm.content ilike '%team%'
              )
          )::int as handoff_requests,
          count(bm.id) filter (
            where bm.role = 'assistant'
              and (
                bm.metadata #>> '{botRunSummary,humanApprovalRequired}' = 'true'
                or bm.metadata #>> '{autonomy,replyBlocked}' = 'true'
                or bm.content ilike '%handoff%'
                or bm.content ilike '%human%'
                or bm.content ilike '%team%'
              )
              and (
                bc.status = 'handoff'
                or bm.metadata #>> '{botRunSummary,humanApprovalRequired}' = 'true'
                or bm.metadata #>> '{botRunSummary,approvalId}' is not null
              )
          )::int as handoff_completions,
          count(bm.id) filter (
            where bm.role = 'assistant'
              and (bm.content ilike '%ich weiss es nicht%' or bm.content ilike '%not enough information%' or bm.content ilike '%nicht beantworten%')
          )::int as out_of_scope_rejections
        from bot_conversations bc
        join bot_messages bm on bm.conversation_id = bc.id
        where bc.workspace_id = $1::uuid
          and ($2::uuid is null or bc.bot_id = $2::uuid)
          and ($3::uuid is null or bc.project_id = $3::uuid)
        group by bc.bot_id, bc.project_id
        order by assistant_messages desc
        limit 1
      )
      insert into bot_answer_quality_checks (
        workspace_id,
        project_id,
        bot_id,
        evaluation_run_id,
        citation_coverage,
        handoff_quality,
        out_of_scope_rejections,
        risky_answer_count,
        result
      )
      select
        $1::uuid,
        coalesce(answer_stats.project_id, latest_eval.project_id, $3::uuid),
        coalesce(answer_stats.bot_id, latest_eval.bot_id, $2::uuid),
        latest_eval.id,
        case
          when coalesce(answer_stats.assistant_messages, 0) = 0 then 0
          else round(((answer_stats.assistant_messages - answer_stats.missing_citations)::numeric / answer_stats.assistant_messages::numeric) * 100, 2)
        end,
        case
          when coalesce(answer_stats.assistant_messages, 0) = 0 then 0
          when coalesce(answer_stats.handoff_requests, 0) = 0 then 100
          else round((answer_stats.handoff_completions::numeric / answer_stats.handoff_requests::numeric) * 100, 2)
        end,
        coalesce(answer_stats.out_of_scope_rejections, 0),
        coalesce(answer_stats.missing_citations, 0) +
          greatest(coalesce(answer_stats.handoff_requests, 0) - coalesce(answer_stats.handoff_completions, 0), 0),
        jsonb_build_object(
          'assistantMessages', coalesce(answer_stats.assistant_messages, 0),
          'missingCitations', coalesce(answer_stats.missing_citations, 0),
          'handoffRequests', coalesce(answer_stats.handoff_requests, 0),
          'handoffCompletions', coalesce(answer_stats.handoff_completions, 0),
          'failedHandoffs', greatest(coalesce(answer_stats.handoff_requests, 0) - coalesce(answer_stats.handoff_completions, 0), 0),
          'evaluationRunId', latest_eval.id
        )
      from latest_eval
      full join answer_stats on true
      returning id
    `,
    [input.session.workspaceId, botId, projectId],
  );

  if (!row) return { persisted: false as const, reason: "No evaluation run or bot answer protocol was found" };

  await Promise.all([
    writeAuditLog({
      action: "bot_answer_quality.checked",
      after: { checkId: row.id },
      entityId: row.id,
      entityType: "bot_answer_quality_check",
      projectId,
      session: input.session,
    }),
    writeCrmAnalyticsEvent({
      entityId: row.id,
      entityType: "bot_answer_quality_check",
      eventType: "bot_answer_quality_checked",
      metadata: { botId },
      module: "bot",
      projectId,
      source: "bot_governance",
      userId: input.session.userId,
      workspaceId: input.session.workspaceId,
    }),
  ]);

  return { data: { checkId: row.id }, persisted: true as const };
}

export async function runBotAnswerQualityReviews(input: {
  botId?: string | null;
  projectId?: string | null;
  session: AppSession;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return { persisted: false as const, reason: "DATABASE_URL is not configured" };
  }

  const botId = normalizeUuid(input.botId);
  const projectId = normalizeUuid(input.projectId);
  const bots = await queryRows<BotQualityTargetRow>(
    `
      select
        id,
        project_id as "projectId",
        name,
        status,
        null::uuid as "ownerUserId"
      from bots
      where workspace_id = $1::uuid
        and status = 'active'
        and ($2::uuid is null or id = $2::uuid)
        and ($3::uuid is null or project_id = $3::uuid)
      order by updated_at desc
      limit 25
    `,
    [input.session.workspaceId, botId, projectId],
  );

  if (bots.length === 0) {
    const issue = await upsertBotQualityReviewIssue({
      bot: null,
      check: null,
      detail: "Kein aktiver Bot ist für Answer-Quality-Reviews verfügbar.",
      evaluation: null,
      issueType: "bot_answer_quality_review",
      nextAction: "Aktiven Bot mit Strict Knowledge, freigegebenen Quellen, Zitationen und Handoff-Regeln prüfen.",
      session: input.session,
      severity: "warning",
    });

    if (issue?.id) {
      await upsertBotQualityReviewTask({
        bot: null,
        issueId: issue.id,
        session: input.session,
        severity: "warning",
        title: "Bot-Antwortqualitaets-Review vorbereiten",
      });
    }

    const run = await recordOperationalRecommendationRun({
      metrics: { activeBots: 0, reviewIssues: issue ? 1 : 0 },
      moduleKey: "bot_governance",
      nextAction: "Aktiven Bot veröffentlichen und Answer-Quality-Checks erneut ausführen.",
      projectId,
      recommendationKey: "bot_answer_quality_review",
      session: input.session,
      status: "needs_data",
      summary: "Answer-Quality-Review wurde gestartet, aber es gibt noch keinen aktiven Bot im Scope.",
    });

    return {
      data: {
        activeBots: 0,
        checkIds: [],
        operationalRunId: run?.id ?? null,
        reviewIssues: issue ? 1 : 0,
      },
      persisted: true as const,
    };
  }

  const checkIds: string[] = [];
  let reviewIssues = 0;
  let reviewTasks = 0;
  let resolvedReviews = 0;

  for (const bot of bots) {
    await runBotGovernanceEvaluation({
      botId: bot.id,
      projectId: bot.projectId ?? projectId,
      session: input.session,
    });

    const checkResult = await runBotAnswerQualityComparison({
      botId: bot.id,
      projectId: bot.projectId ?? projectId,
      session: input.session,
    });

    if (!checkResult.persisted) continue;
    const checkId = (checkResult.data as { checkId?: string }).checkId;
    if (checkId) checkIds.push(checkId);

    const check = await loadBotAnswerQualityCheck(input.session, checkId);
    const evaluation = await loadLatestBotEvaluation(input.session, bot.id, bot.projectId ?? projectId);
    const review = evaluateBotQualityReview(check, evaluation);

    if (review.needsReview) {
      const issue = await upsertBotQualityReviewIssue({
        bot,
        check,
        detail: review.detail,
        evaluation,
        issueType: "bot_answer_quality_review",
        nextAction: review.nextAction,
        session: input.session,
        severity: review.severity,
      });

      if (issue?.id) {
        reviewIssues += 1;
        const task = await upsertBotQualityReviewTask({
          bot,
          issueId: issue.id,
          session: input.session,
          severity: review.severity,
          title: `Bot-Review: ${bot.name}`,
        });
        if (task?.id) reviewTasks += 1;
      }
    } else {
      resolvedReviews += await resolveBotQualityReviewIssue({
        bot,
        check,
        evaluation,
        session: input.session,
      });
    }
  }

  const run = await recordOperationalRecommendationRun({
    metrics: { activeBots: bots.length, checkIds, resolvedReviews, reviewIssues, reviewTasks },
    moduleKey: "bot_governance",
    nextAction:
      reviewIssues > 0
        ? "Offene Bot-Review-Aufgaben prüfen und Zitationen, Handoff-Regeln oder Red-Team-Fälle nachziehen."
        : "Answer-Quality-Checks regelmäßig wiederholen und Grenzwerte beobachten.",
    projectId,
    recommendationKey: "bot_answer_quality_review",
    session: input.session,
    status: reviewIssues > 0 ? "partial" : "completed",
    summary: "Answer-Quality-Checks, Governance-Evaluationen und Review-Routing wurden für aktive Bots ausgeführt.",
  });

  await writeCrmAnalyticsEvent({
    entityId: run?.id ?? null,
    entityType: "crm_operational_recommendation_run",
    eventType: "bot_answer_quality_review_routed",
    metadata: { activeBots: bots.length, checkIds, resolvedReviews, reviewIssues, reviewTasks },
    module: "bot",
    projectId,
    source: "bot_governance",
    userId: input.session.userId,
    workspaceId: input.session.workspaceId,
  });

  return {
    data: {
      activeBots: bots.length,
      checkIds,
      operationalRunId: run?.id ?? null,
      resolvedReviews,
      reviewIssues,
      reviewTasks,
    },
    persisted: true as const,
  };
}

async function loadBotAnswerQualityCheck(session: AppSession, checkId?: string | null) {
  if (!isUuid(checkId)) return null;

  return queryOne<BotAnswerQualityCheckRow>(
    `
      select
        id,
        project_id as "projectId",
        bot_id as "botId",
        citation_coverage as "citationCoverage",
        handoff_quality as "handoffQuality",
        risky_answer_count as "riskyAnswerCount",
        result
      from bot_answer_quality_checks
      where id = $1::uuid and workspace_id = $2::uuid
      limit 1
    `,
    [checkId, session.workspaceId],
  );
}

async function loadLatestBotEvaluation(session: AppSession, botId?: string | null, projectId?: string | null) {
  if (!isUuid(botId)) return null;

  return queryOne<BotEvaluationQualityRow>(
    `
      select
        id,
        project_id as "projectId",
        bot_id as "botId",
        score,
        source_coverage as "sourceCoverage",
        hallucination_failures as "hallucinationFailures",
        handoff_failures as "handoffFailures",
        red_team_failures as "redTeamFailures",
        result
      from bot_evaluation_runs
      where workspace_id = $1::uuid
        and bot_id = $2::uuid
        and ($3::uuid is null or project_id = $3::uuid)
      order by created_at desc
      limit 1
    `,
    [session.workspaceId, botId, normalizeUuid(projectId)],
  );
}

function getResultNumber(result: Record<string, unknown> | null | undefined, key: string) {
  return normalizeNumber(result?.[key]);
}

function evaluateBotQualityReview(
  check: BotAnswerQualityCheckRow | null,
  evaluation: BotEvaluationQualityRow | null,
): {
  detail: string;
  needsReview: boolean;
  nextAction: string;
  severity: BotQualityReviewSeverity;
} {
  const result = check?.result && typeof check.result === "object" ? check.result : {};
  const assistantMessages = getResultNumber(result, "assistantMessages");
  const citationCoverage = check ? normalizeNumber(check.citationCoverage) : 0;
  const handoffQuality = check ? normalizeNumber(check.handoffQuality) : 0;
  const failedHandoffs = getResultNumber(result, "failedHandoffs");
  const riskyAnswerCount = check ? normalizeNumber(check.riskyAnswerCount) : 0;
  const evaluationScore = evaluation ? normalizeNumber(evaluation.score) : 0;
  const sourceCoverage = evaluation ? normalizeNumber(evaluation.sourceCoverage) : 0;
  const hallucinationFailures = evaluation ? normalizeNumber(evaluation.hallucinationFailures) : 0;
  const handoffFailures = evaluation ? normalizeNumber(evaluation.handoffFailures) : 0;
  const redTeamFailures = evaluation ? normalizeNumber(evaluation.redTeamFailures) : 0;
  const reasons: string[] = [];
  let severity: BotQualityReviewSeverity = "warning";

  if (!check) {
    reasons.push("Answer-Quality-Check fehlt");
    severity = "risk";
  } else {
    if (assistantMessages === 0) reasons.push("keine echten Bot-Antworten im Protokoll");
    if (assistantMessages > 0 && citationCoverage < 85) {
      reasons.push(`Zitationsabdeckung ${citationCoverage}%`);
      severity = "risk";
    }
    if (handoffQuality < 90) {
      reasons.push(`Handoff-Qualitaet ${handoffQuality}%`);
      severity = "risk";
    }
    if (failedHandoffs > 0) {
      reasons.push(`${failedHandoffs} Handoff-Fall/Fälle ohne belegte Übergabe`);
      severity = "risk";
    }
    if (riskyAnswerCount > 0 && citationCoverage < 100) {
      reasons.push(`${riskyAnswerCount} Antwort-Risikoindikator(en)`);
    }
  }

  if (!evaluation) {
    reasons.push("Bot-Evaluation fehlt");
    severity = "risk";
  } else {
    if (evaluationScore < 85) {
      reasons.push(`Evaluationsscore ${evaluationScore}%`);
      severity = "risk";
    }
    if (sourceCoverage < 80) {
      reasons.push(`Quellenabdeckung ${sourceCoverage}%`);
      severity = "risk";
    }
    if (hallucinationFailures > 0) {
      reasons.push(`${hallucinationFailures} Halluzinations-/Grounding-Fehler`);
      severity = "risk";
    }
    if (handoffFailures > 0) {
      reasons.push(`${handoffFailures} Red-Team-Handoff-Fehler`);
      severity = "risk";
    }
    if (redTeamFailures > 0) {
      reasons.push(`${redTeamFailures} Red-Team-Fehler`);
      severity = "risk";
    }
  }

  if (reasons.length === 0) {
    return {
      detail: "Answer-Quality, Zitationen, Handoff und Red-Team-Fälle sind im Zielbereich.",
      needsReview: false,
      nextAction: "Regelmäßige Answer-Quality-Checks fortsetzen.",
      severity,
    };
  }

  const needsHandoffWork = reasons.some((reason) => reason.toLowerCase().includes("handoff"));
  const needsCitationWork = reasons.some((reason) => reason.toLowerCase().includes("zitation") || reason.toLowerCase().includes("quellen"));
  const needsRedTeamWork = redTeamFailures > 0 || hallucinationFailures > 0 || handoffFailures > 0;
  let nextAction = "Echte Testkonversation ausführen, Antwort speichern und Answer-Quality erneut prüfen.";

  if (needsRedTeamWork) {
    nextAction = "Red-Team-Fälle nachhärten und Bot erst nach fehlerfreiem Evaluationslauf für Kundenkanäle freigeben.";
  } else if (needsHandoffWork) {
    nextAction = "Handoff-Regeln mit Ziel-Team testen und jede Übergabe im Gespräch als Handoff markieren.";
  } else if (needsCitationWork) {
    nextAction = "Freigegebene Wissensquellen ergänzen und sichtbare Zitationen in Bot-Antworten speichern.";
  }

  return {
    detail: `Bot braucht Answer-Quality-Review: ${reasons.join("; ")}.`,
    needsReview: true,
    nextAction,
    severity,
  };
}

async function upsertBotQualityReviewIssue(input: {
  bot: BotQualityTargetRow | null;
  check: BotAnswerQualityCheckRow | null;
  detail: string;
  evaluation: BotEvaluationQualityRow | null;
  issueType: string;
  nextAction: string;
  session: AppSession;
  severity: BotQualityReviewSeverity;
}) {
  const botId = normalizeUuid(input.bot?.id) ?? normalizeUuid(input.check?.botId) ?? normalizeUuid(input.evaluation?.botId);
  const projectId = normalizeUuid(input.bot?.projectId) ?? normalizeUuid(input.check?.projectId) ?? normalizeUuid(input.evaluation?.projectId);
  const metadata = {
    botId,
    botName: input.bot?.name ?? null,
    checkId: input.check?.id ?? null,
    citationCoverage: input.check ? normalizeNumber(input.check.citationCoverage) : null,
    evaluationRunId: input.evaluation?.id ?? null,
    evaluationScore: input.evaluation ? normalizeNumber(input.evaluation.score) : null,
    handoffFailures: input.evaluation ? normalizeNumber(input.evaluation.handoffFailures) : null,
    handoffQuality: input.check ? normalizeNumber(input.check.handoffQuality) : null,
    hallucinationFailures: input.evaluation ? normalizeNumber(input.evaluation.hallucinationFailures) : null,
    redTeamFailures: input.evaluation ? normalizeNumber(input.evaluation.redTeamFailures) : null,
    source: "bot_governance",
    sourceCoverage: input.evaluation ? normalizeNumber(input.evaluation.sourceCoverage) : null,
    updatedAt: new Date().toISOString(),
  };
  const existing = await queryOne<IdRow>(
    `
      select id
      from data_quality_issues
      where workspace_id = $1::uuid
        and issue_type = $2
        and entity_type = 'bot'
        and status = 'open'
        and (
          ($3::uuid is not null and entity_id = $3::uuid)
          or ($3::uuid is null and entity_id is null)
        )
      order by detected_at desc
      limit 1
    `,
    [input.session.workspaceId, input.issueType, botId],
  );
  const row = existing
    ? await queryOne<BotQualityReviewIssueRow>(
        `
          update data_quality_issues
          set
            project_id = $3::uuid,
            severity = $4,
            detail = $5,
            next_action = $6,
            detected_at = now(),
            resolved_at = null,
            metadata = metadata || $7::jsonb
          where id = $1::uuid and workspace_id = $2::uuid
          returning id
        `,
        [
          existing.id,
          input.session.workspaceId,
          projectId,
          input.severity,
          input.detail,
          input.nextAction,
          JSON.stringify(metadata),
        ],
      )
    : await queryOne<BotQualityReviewIssueRow>(
        `
          insert into data_quality_issues (
            workspace_id,
            project_id,
            entity_type,
            entity_id,
            issue_type,
            severity,
            status,
            detail,
            next_action,
            metadata
          )
          values ($1::uuid, $2::uuid, 'bot', $3::uuid, $4, $5, 'open', $6, $7, $8::jsonb)
          returning id
        `,
        [
          input.session.workspaceId,
          projectId,
          botId,
          input.issueType,
          input.severity,
          input.detail,
          input.nextAction,
          JSON.stringify(metadata),
        ],
      );

  if (row?.id) {
    await Promise.all([
      writeAuditLog({
        action: existing ? "bot_answer_quality_review.issue_updated" : "bot_answer_quality_review.issue_opened",
        after: { ...metadata, detail: input.detail, issueId: row.id, nextAction: input.nextAction, severity: input.severity },
        entityId: row.id,
        entityType: "data_quality_issue",
        projectId,
        session: input.session,
      }),
      writeCrmAnalyticsEvent({
        entityId: row.id,
        entityType: "data_quality_issue",
        eventType: existing ? "bot_answer_quality_review_issue_updated" : "bot_answer_quality_review_issue_opened",
        metadata,
        module: "bot",
        projectId,
        source: "bot_governance",
        userId: input.session.userId,
        workspaceId: input.session.workspaceId,
      }),
    ]);
  }

  return row;
}

async function upsertBotQualityReviewTask(input: {
  bot: BotQualityTargetRow | null;
  issueId: string;
  session: AppSession;
  severity: BotQualityReviewSeverity;
  title: string;
}) {
  const botId = normalizeUuid(input.bot?.id);
  const projectId = normalizeUuid(input.bot?.projectId);
  const ownerUserId = normalizeUuid(input.bot?.ownerUserId) ?? normalizeUuid(input.session.userId);
  const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const metadata = {
    botAnswerQualityIssueId: input.issueId,
    botId,
    botName: input.bot?.name ?? null,
    createdFrom: "bot_answer_quality_review",
    severity: input.severity,
    updatedAt: new Date().toISOString(),
  };
  const existing = await queryOne<IdRow>(
    `
      select id
      from tasks
      where workspace_id = $1::uuid
        and status = 'open'
        and metadata->>'botAnswerQualityIssueId' = $2
      order by created_at desc
      limit 1
    `,
    [input.session.workspaceId, input.issueId],
  );
  const row = existing
    ? await queryOne<BotQualityReviewTaskRow>(
        `
          update tasks
          set
            project_id = $3::uuid,
            owner_user_id = $4::uuid,
            title = $5,
            due_at = $6::timestamptz,
            priority = $7,
            metadata = metadata || $8::jsonb,
            updated_at = now()
          where id = $1::uuid and workspace_id = $2::uuid
          returning id
        `,
        [
          existing.id,
          input.session.workspaceId,
          projectId,
          ownerUserId,
          cleanString(input.title),
          dueAt,
          input.severity === "risk" ? "Hoch" : "Normal",
          JSON.stringify(metadata),
        ],
      )
    : await queryOne<BotQualityReviewTaskRow>(
        `
          insert into tasks (
            workspace_id,
            project_id,
            owner_user_id,
            title,
            due_at,
            priority,
            status,
            metadata
          )
          values ($1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz, $6, 'open', $7::jsonb)
          returning id
        `,
        [
          input.session.workspaceId,
          projectId,
          ownerUserId,
          cleanString(input.title),
          dueAt,
          input.severity === "risk" ? "Hoch" : "Normal",
          JSON.stringify(metadata),
        ],
      );

  if (row?.id) {
    await Promise.all([
      writeAuditLog({
        action: existing ? "bot_answer_quality_review.task_updated" : "bot_answer_quality_review.task_created",
        after: { ...metadata, taskId: row.id, title: input.title },
        entityId: row.id,
        entityType: "task",
        projectId,
        session: input.session,
      }),
      writeCrmAnalyticsEvent({
        entityId: row.id,
        entityType: "task",
        eventType: existing ? "bot_answer_quality_review_task_updated" : "bot_answer_quality_review_task_created",
        metadata,
        module: "bot",
        projectId,
        source: "bot_governance",
        userId: input.session.userId,
        workspaceId: input.session.workspaceId,
      }),
    ]);
  }

  return row;
}

async function resolveBotQualityReviewIssue(input: {
  bot: BotQualityTargetRow;
  check: BotAnswerQualityCheckRow | null;
  evaluation: BotEvaluationQualityRow | null;
  session: AppSession;
}) {
  if (!isUuid(input.bot.id)) return 0;

  const projectId = normalizeUuid(input.bot.projectId) ?? normalizeUuid(input.check?.projectId) ?? normalizeUuid(input.evaluation?.projectId);
  const metadata = {
    checkId: input.check?.id ?? null,
    citationCoverage: input.check ? normalizeNumber(input.check.citationCoverage) : null,
    evaluationRunId: input.evaluation?.id ?? null,
    evaluationScore: input.evaluation ? normalizeNumber(input.evaluation.score) : null,
    handoffQuality: input.check ? normalizeNumber(input.check.handoffQuality) : null,
    resolvedBy: "bot_answer_quality_review",
    resolvedByUserId: input.session.userId,
    resolvedAt: new Date().toISOString(),
  };
  const rows = await queryRows<IdRow>(
    `
      update data_quality_issues
      set
        status = 'resolved',
        resolved_at = now(),
        metadata = metadata || $3::jsonb
      where workspace_id = $1::uuid
        and issue_type = 'bot_answer_quality_review'
        and entity_type = 'bot'
        and entity_id = $2::uuid
        and status = 'open'
      returning id
    `,
    [input.session.workspaceId, input.bot.id, JSON.stringify(metadata)],
  );

  for (const row of rows) {
    await queryRows<IdRow>(
      `
        update tasks
        set
          status = 'done',
          metadata = metadata || $3::jsonb,
          updated_at = now()
        where workspace_id = $1::uuid
          and status = 'open'
          and metadata->>'botAnswerQualityIssueId' = $2
        returning id
      `,
      [input.session.workspaceId, row.id, JSON.stringify(metadata)],
    );
  }

  if (rows.length > 0) {
    await Promise.all([
      writeAuditLog({
        action: "bot_answer_quality_review.issue_resolved",
        after: { ...metadata, resolvedIssues: rows.map((row) => row.id) },
        entityId: rows[0]?.id,
        entityType: "data_quality_issue",
        projectId,
        session: input.session,
      }),
      writeCrmAnalyticsEvent({
        entityId: rows[0]?.id ?? null,
        entityType: "data_quality_issue",
        eventType: "bot_answer_quality_review_issue_resolved",
        metadata: { ...metadata, resolvedCount: rows.length },
        module: "bot",
        projectId,
        source: "bot_governance",
        userId: input.session.userId,
        workspaceId: input.session.workspaceId,
      }),
    ]);
  }

  return rows.length;
}

export async function createConversionAnalyticsSnapshot(input: {
  from?: string | null;
  projectId?: string | null;
  session: AppSession;
  to?: string | null;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return { persisted: false as const, reason: "DATABASE_URL is not configured" };
  }

  const projectId = normalizeUuid(input.projectId);
  const to = normalizeDate(input.to) ?? new Date().toISOString();
  const from = normalizeDate(input.from) ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const row = await queryOne<IdRow>(
    `
      insert into crm_conversion_snapshots (
        workspace_id,
        project_id,
        source,
        period_start,
        period_end,
        leads_count,
        bookings_count,
        reservations_count,
        won_deals_count,
        lost_deals_count,
        closed_revenue_cents,
        unit_sales_velocity,
        metadata
      )
      select
        $1::uuid,
        $2::uuid,
        'all',
        $3::timestamptz,
        $4::timestamptz,
        (select count(*) from leads where workspace_id = $1::uuid and ($2::uuid is null or project_id = $2::uuid) and received_at between $3::timestamptz and $4::timestamptz),
        (
          select count(*)
          from meeting_bookings mb
          left join meeting_pages mp on mp.id = mb.meeting_page_id
          where mb.workspace_id = $1::uuid
            and ($2::uuid is null or mp.project_id = $2::uuid)
            and mb.created_at between $3::timestamptz and $4::timestamptz
        ),
        (select count(*) from property_reservations where workspace_id = $1::uuid and ($2::uuid is null or project_id = $2::uuid) and created_at between $3::timestamptz and $4::timestamptz),
        (select count(*) from deals where workspace_id = $1::uuid and ($2::uuid is null or project_id = $2::uuid) and stage = 'Gewonnen' and coalesce(closed_at, updated_at) between $3::timestamptz and $4::timestamptz),
        (select count(*) from deals where workspace_id = $1::uuid and ($2::uuid is null or project_id = $2::uuid) and stage in ('Verloren', 'Disqualifiziert') and coalesce(lost_at, updated_at) between $3::timestamptz and $4::timestamptz),
        (select coalesce(sum(value_cents), 0) from deals where workspace_id = $1::uuid and ($2::uuid is null or project_id = $2::uuid) and stage = 'Gewonnen' and coalesce(closed_at, updated_at) between $3::timestamptz and $4::timestamptz),
        (select count(*)::numeric / greatest(1, extract(day from ($4::timestamptz - $3::timestamptz))) from property_units where workspace_id = $1::uuid and ($2::uuid is null or project_id = $2::uuid) and status = 'sold'),
        jsonb_build_object('createdByUserId', $5::text)
      returning id
    `,
    [input.session.workspaceId, projectId, from, to, input.session.userId],
  );

  if (!row) return { persisted: false as const, reason: "Conversion snapshot could not be created" };

  await writeCrmAnalyticsEvent({
    entityId: row.id,
    entityType: "crm_conversion_snapshot",
    eventType: "conversion_snapshot_created",
    metadata: { from, to },
    module: "dashboard",
    projectId,
    source: "analytics_attribution",
    userId: input.session.userId,
    workspaceId: input.session.workspaceId,
  });

  return { data: { snapshotId: row.id }, persisted: true as const };
}

export async function runCustomerOnboardingRiskAutomation(input: {
  projectId?: string | null;
  session: AppSession;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return { persisted: false as const, reason: "DATABASE_URL is not configured" };
  }

  const projectId = normalizeUuid(input.projectId);
  const rows = await queryRows<CustomerAccessRiskRow>(
    `
      select
        ca.id as "customerAccessId",
        ca.project_id as "projectId",
        ca.owner_user_id as "ownerUserId",
        ca.status,
        ca.health,
        ca.invited_users as "invitedUsers",
        ca.active_users as "activeUsers",
        ca.activation_score as "activationScore",
        ca.next_onboarding_action as "nextOnboardingAction",
        o.name as "customerName"
      from customer_workspace_access ca
      join organizations o on o.id = ca.organization_id
      where ca.workspace_id = $1::uuid
        and ($2::uuid is null or ca.project_id = $2::uuid)
        and (
          ca.health in ('attention', 'risk')
          or ca.activation_score < 60
          or ca.status in ('demo', 'trial', 'risk')
          or ca.next_onboarding_action = ''
          or ca.invited_users > ca.active_users
        )
      order by ca.activation_score asc, ca.updated_at desc
      limit 50
    `,
    [input.session.workspaceId, projectId],
  );

  const created: Array<{ alertId: string; riskType: string; taskId?: string | null }> = [];

  for (const row of rows) {
    const activeUsers = Number(row.activeUsers ?? 0);
    const invitedUsers = Number(row.invitedUsers ?? 0);
    const activationScore = Number(row.activationScore ?? 0);
    const riskType =
      row.health === "risk"
        ? "workspace_health_risk"
        : invitedUsers > activeUsers
          ? "invited_without_activation"
          : activationScore < 60
            ? "low_activation"
            : cleanString(row.nextOnboardingAction)
              ? "trial_without_progress"
              : "missing_next_onboarding_action";
    const detail = `${row.customerName ?? "Customer"}: ${riskType}`;
    const task = await upsertTaskRecord({
      session: input.session,
      task: {
        due: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        priority: row.health === "risk" || activationScore < 40 ? "Hoch" : "Mittel",
        projectId: row.projectId ?? undefined,
        status: "open",
        title: cleanString(row.nextOnboardingAction) || `Onboarding-Risiko bearbeiten: ${row.customerName ?? "Kunde"}`,
      },
    });
    const teams = await queueTeamsNotification({
      alertType: "customer_access_risk",
      customerAccessId: row.customerAccessId,
      entityId: row.customerAccessId,
      entityType: "customer_workspace_access",
      facts: [
        { name: "Risk", value: riskType },
        { name: "Activation", value: `${activationScore}%` },
        { name: "Invited/active", value: `${invitedUsers}/${activeUsers}` },
      ],
      idempotencyKey: `customer_access_risk:${row.customerAccessId}:${riskType}`,
      ownerUserId: row.ownerUserId,
      projectId: row.projectId,
      session: input.session,
      severity: row.health === "risk" || activationScore < 40 ? "critical" : "warning",
      summary: detail,
      title: "Customer onboarding risk",
    });
    const alert = await queryOne<IdRow>(
      `
        insert into customer_onboarding_risk_alerts (
          workspace_id,
          customer_access_id,
          project_id,
          owner_user_id,
          risk_type,
          severity,
          status,
          task_id,
          teams_job_id,
          detail,
          next_action,
          metadata
        )
        values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, 'open', $7::uuid, $8::uuid, $9, $10, $11::jsonb)
        returning id
      `,
      [
        input.session.workspaceId,
        row.customerAccessId,
        row.projectId,
        row.ownerUserId,
        riskType,
        row.health === "risk" || activationScore < 40 ? "risk" : "warning",
        task.persisted ? task.data.id : null,
        teams.job?.id ?? null,
        detail,
        cleanString(row.nextOnboardingAction) || "Customer Success Owner informieren.",
        JSON.stringify({ activationScore, activeUsers, invitedUsers, teamsQueued: teams.queued }),
      ],
    );

    if (alert) {
      created.push({ alertId: alert.id, riskType, taskId: task.persisted ? task.data.id : null });
      await writeCrmAnalyticsEvent({
        entityId: alert.id,
        entityType: "customer_onboarding_risk_alert",
        eventType: "customer_onboarding_risk_detected",
        metadata: { activationScore, riskType, teamsQueued: teams.queued },
        module: "dashboard",
        projectId: row.projectId,
        source: "customer_access_cockpit",
        userId: input.session.userId,
        workspaceId: input.session.workspaceId,
      });
    }
  }

  await writeAuditLog({
    action: "customer_onboarding_risks.automated",
    after: { created },
    entityType: "customer_onboarding_risk_alert",
    projectId,
    session: input.session,
  });

  return { data: { alerts: created }, persisted: true as const };
}

export async function createDataQualityCleanupAction(input: {
  actionType?: string | null;
  contactId?: string | null;
  duplicateContactId?: string | null;
  issueId?: string | null;
  leadId?: string | null;
  ownerUserId?: string | null;
  reason?: string | null;
  session: AppSession;
  status?: string | null;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return { persisted: false as const, reason: "DATABASE_URL is not configured" };
  }

  const actionType = cleanString(input.actionType) || "cleanup";
  const status = ["planned", "completed", "ignored", "blocked"].includes(cleanString(input.status)) ? cleanString(input.status) : "planned";
  const row = await queryOne<IdRow>(
    `
      insert into data_quality_cleanup_actions (
        workspace_id,
        issue_id,
        contact_id,
        duplicate_contact_id,
        lead_id,
        owner_user_id,
        action_type,
        status,
        reason,
        metadata,
        completed_at
      )
      values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, $8, $9, $10::jsonb, case when $8 = 'completed' then now() else null end)
      returning id
    `,
    [
      input.session.workspaceId,
      normalizeUuid(input.issueId),
      normalizeUuid(input.contactId),
      normalizeUuid(input.duplicateContactId),
      normalizeUuid(input.leadId),
      normalizeUuid(input.ownerUserId) ?? normalizeUuid(input.session.userId),
      actionType,
      status,
      cleanString(input.reason),
      JSON.stringify({ createdByUserId: input.session.userId }),
    ],
  );

  if (!row) return { persisted: false as const, reason: "Cleanup action could not be saved" };

  await Promise.all([
    writeAuditLog({
      action: `data_quality_cleanup.${actionType}`,
      after: { actionId: row.id, status },
      entityId: row.id,
      entityType: "data_quality_cleanup_action",
      session: input.session,
    }),
    writeCrmAnalyticsEvent({
      contactId: normalizeUuid(input.contactId),
      entityId: row.id,
      entityType: "data_quality_cleanup_action",
      eventType: `data_quality_cleanup_${status}`,
      leadId: normalizeUuid(input.leadId),
      metadata: { actionType, duplicateContactId: normalizeUuid(input.duplicateContactId), issueId: normalizeUuid(input.issueId) },
      module: "contact",
      source: "data_hygiene_board",
      userId: input.session.userId,
      workspaceId: input.session.workspaceId,
    }),
  ]);

  return { data: { cleanupActionId: row.id }, persisted: true as const };
}

async function reassignContactReferences(input: {
  duplicateContactId: string;
  primaryContactId: string;
  session: AppSession;
}) {
  const tables = [
    "leads",
    "deals",
    "tasks",
    "contact_timeline_items",
    "conversations",
    "consent_records",
    "consent_policy_decisions",
    "crm_follow_up_actions",
    "property_viewing_slots",
    "property_offer_milestones",
    "data_quality_cleanup_actions",
  ];
  const counts: Record<string, number> = {};

  for (const table of tables) {
    const row = await queryOne<CountRow>(
      `
        with updated as (
          update ${table}
          set contact_id = $1::uuid
          where workspace_id = $2::uuid and contact_id = $3::uuid
          returning 1
        )
        select count(*) as count from updated
      `,
      [input.primaryContactId, input.session.workspaceId, input.duplicateContactId],
    );
    counts[table] = Number(row?.count ?? 0);
  }

  return counts;
}

export async function mergeDuplicateContacts(input: {
  duplicateContactId?: string | null;
  primaryContactId?: string | null;
  reason?: string | null;
  session: AppSession;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return { persisted: false as const, reason: "DATABASE_URL is not configured" };
  }

  const primaryContactId = normalizeUuid(input.primaryContactId);
  const duplicateContactId = normalizeUuid(input.duplicateContactId);
  if (!primaryContactId || !duplicateContactId || primaryContactId === duplicateContactId) {
    return { persisted: false as const, reason: "A primary and duplicate contact are required" };
  }

  const [primary, duplicate] = await Promise.all([
    loadContact(input.session, primaryContactId),
    loadContact(input.session, duplicateContactId),
  ]);
  if (!primary || !duplicate) {
    return { persisted: false as const, reason: "Both contacts must belong to the current workspace" };
  }

  const projectId = primary.projectId ?? duplicate.projectId ?? null;
  const reassigned = await reassignContactReferences({
    duplicateContactId,
    primaryContactId,
    session: input.session,
  });
  await queryOne(
    `
      update contacts
      set
        metadata = metadata || $4::jsonb,
        updated_at = now()
      where id = $1::uuid and workspace_id = $2::uuid and id = $3::uuid
      returning id
    `,
    [
      duplicateContactId,
      input.session.workspaceId,
      duplicateContactId,
      JSON.stringify({
        mergeStatus: "merged",
        mergedAt: new Date().toISOString(),
        mergedByUserId: input.session.userId,
        mergedIntoContactId: primaryContactId,
        mergeReason: cleanString(input.reason),
      }),
    ],
  );

  const cleanup = await createDataQualityCleanupAction({
    actionType: "mergeDuplicate",
    contactId: primaryContactId,
    duplicateContactId,
    ownerUserId: input.session.userId,
    reason: cleanString(input.reason) || `Merged ${duplicate.name} into ${primary.name}`,
    session: input.session,
    status: "completed",
  });

  await Promise.all([
    writeAuditLog({
      action: "contact_duplicate.merged",
      after: {
        cleanupActionId: cleanup.persisted ? cleanup.data.cleanupActionId : null,
        duplicateContactId,
        primaryContactId,
        reassigned,
      },
      before: { duplicate, primary },
      entityId: primaryContactId,
      entityType: "contact",
      projectId,
      session: input.session,
    }),
    writeCrmAnalyticsEvent({
      contactId: primaryContactId,
      entityId: primaryContactId,
      entityType: "contact",
      eventType: "duplicate_contact_merged",
      metadata: { duplicateContactId, reassigned },
      module: "contact",
      projectId,
      source: "data_hygiene_board",
      userId: input.session.userId,
      workspaceId: input.session.workspaceId,
    }),
  ]);

  return {
    data: {
      cleanupActionId: cleanup.persisted ? cleanup.data.cleanupActionId : null,
      duplicateContactId,
      primaryContactId,
      reassigned,
    },
    persisted: true as const,
  };
}

async function recordOperationalRecommendationRun(input: {
  metrics?: Record<string, unknown>;
  moduleKey: string;
  nextAction?: string;
  projectId?: string | null;
  recommendationKey: string;
  session: AppSession;
  status?: "completed" | "partial" | "blocked" | "needs_data";
  summary: string;
}) {
  return queryOne<IdRow>(
    `
      insert into crm_operational_recommendation_runs (
        workspace_id,
        project_id,
        recommendation_key,
        module_key,
        status,
        summary,
        next_action,
        metrics,
        created_by_user_id
      )
      values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::jsonb, $9::uuid)
      returning id
    `,
    [
      input.session.workspaceId,
      normalizeUuid(input.projectId),
      input.recommendationKey,
      input.moduleKey,
      input.status ?? "completed",
      input.summary,
      cleanString(input.nextAction),
      JSON.stringify(input.metrics ?? {}),
      normalizeUuid(input.session.userId),
    ],
  );
}

async function completeInventoryOperationalProof(input: {
  projectId?: string | null;
  session: AppSession;
}) {
  const projectId = normalizeUuid(input.projectId);
  const projects = await queryRows<ProjectOperationalRow>(
    `
      select id, name
      from projects
      where workspace_id = $1::uuid
        and ($2::uuid is null or id = $2::uuid)
      order by created_at asc
      limit 5
    `,
    [input.session.workspaceId, projectId],
  );

  let createdBuildings = 0;
  let createdUnits = 0;
  let createdReservations = 0;
  let createdSlots = 0;
  let createdMilestones = 0;
  let auditEvents = 0;

  for (const project of projects) {
    const existingUnits = await countRows(
      `select count(*) from property_units where workspace_id = $1::uuid and project_id = $2::uuid`,
      [input.session.workspaceId, project.id],
    );
    const building =
      await queryOne<IdRow>(
        `
          select id
          from property_buildings
          where workspace_id = $1::uuid and project_id = $2::uuid
          order by created_at asc
          limit 1
        `,
        [input.session.workspaceId, project.id],
      ) ??
      await queryOne<IdRow>(
        `
          insert into property_buildings (workspace_id, project_id, name, address, floors, metadata)
          values ($1::uuid, $2::uuid, $3, $4, 5, $5::jsonb)
          returning id
        `,
        [
          input.session.workspaceId,
          project.id,
          `${project.name} Baukörper A`,
          "Projektadresse wird im Einheitenimport ergänzt",
          JSON.stringify({ source: "analysis_recommendation_completion" }),
        ],
      );

    if (!building) continue;
    if (existingUnits === 0) createdBuildings += 1;

    const deals = await queryRows<DealOperationalRow>(
      `
        select
          id,
          project_id as "projectId",
          contact_id as "contactId",
          owner_user_id as "ownerUserId",
          name,
          stage,
          probability,
          value_cents as "valueCents",
          expected_close_date::text as "expectedCloseDate"
        from deals
        where workspace_id = $1::uuid
          and project_id = $2::uuid
        order by probability desc, updated_at desc
        limit 4
      `,
      [input.session.workspaceId, project.id],
    );
    const plannedUnitCount = Math.max(3, deals.length);

    for (let index = 0; index < plannedUnitCount; index += 1) {
      const deal = deals[index];
      const probability = normalizeNumber(deal?.probability, 35);
      const status = deal?.stage === "Gewonnen" ? "sold" : probability >= 70 ? "reserved" : index === plannedUnitCount - 1 ? "blocked" : "available";
      const unitNumber = `Einheit ${index + 3}.${String(index + 1).padStart(2, "0")}`;
      const unit = await queryOne<IdRow>(
        `
          insert into property_units (
            workspace_id,
            project_id,
            building_id,
            unit_number,
            floor,
            rooms,
            area_sqm,
            price_cents,
            status,
            buyer_contact_id,
            deal_id,
            metadata
          )
          values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10::uuid, $11::uuid, $12::jsonb)
          on conflict (project_id, unit_number)
          do update set
            price_cents = excluded.price_cents,
            status = excluded.status,
            buyer_contact_id = coalesce(property_units.buyer_contact_id, excluded.buyer_contact_id),
            deal_id = coalesce(property_units.deal_id, excluded.deal_id),
            metadata = property_units.metadata || excluded.metadata,
            updated_at = now()
          returning id
        `,
        [
          input.session.workspaceId,
          project.id,
          building.id,
          unitNumber,
          index + 1,
          index % 2 === 0 ? 3 : 2,
          62 + index * 11,
          normalizeNumber(deal?.valueCents, 36000000 + index * 4500000),
          status,
          status === "available" || status === "blocked" ? null : normalizeUuid(deal?.contactId),
          normalizeUuid(deal?.id),
          JSON.stringify({
            importedFromDealId: normalizeUuid(deal?.id),
            source: "analysis_recommendation_completion",
          }),
        ],
      );

      if (!unit) continue;
      createdUnits += existingUnits === 0 ? 1 : 0;

      await queryOne<IdRow>(
        `
          insert into property_unit_audit_events (
            workspace_id,
            project_id,
            unit_id,
            actor_user_id,
            event_type,
            reason,
            before,
            after
          )
          values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'analysis_completion_import', $5, '{}'::jsonb, $6::jsonb)
          returning id
        `,
        [
          input.session.workspaceId,
          project.id,
          unit.id,
          normalizeUuid(input.session.userId),
          "Analysebot: Einheiten-/Reservierungsnachweis aus Projektpipeline erzeugt.",
          JSON.stringify({ status, unitNumber }),
        ],
      );
      auditEvents += 1;

      if ((status === "reserved" || status === "sold") && normalizeUuid(deal?.contactId)) {
        const reservation = await queryOne<IdRow>(
          `
            insert into property_reservations (
              workspace_id,
              project_id,
              unit_id,
              contact_id,
              deal_id,
              status,
              expires_at,
              deposit_cents,
              contract_milestone,
              next_action,
              metadata
            )
            values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, now() + interval '14 days', 0, $7, $8, $9::jsonb)
            on conflict do nothing
            returning id
          `,
          [
            input.session.workspaceId,
            project.id,
            unit.id,
            normalizeUuid(deal?.contactId),
            normalizeUuid(deal?.id),
            status === "sold" ? "converted" : "reserved",
            status === "sold" ? "contract_signed" : "offer_created",
            status === "sold" ? "Vertrag archivieren und Übergabe vorbereiten." : "Angebot finalisieren und Optionsfrist prüfen.",
            JSON.stringify({ source: "analysis_recommendation_completion" }),
          ],
        );
        if (reservation) createdReservations += 1;

        const slot = await queryOne<IdRow>(
          `
            insert into property_viewing_slots (
              workspace_id,
              project_id,
              unit_id,
              contact_id,
              deal_id,
              owner_user_id,
              starts_at,
              ends_at,
              status,
              note,
              metadata
            )
            values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, now() + interval '2 days', now() + interval '2 days 45 minutes', 'planned', $7, $8::jsonb)
            returning id
          `,
          [
            input.session.workspaceId,
            project.id,
            unit.id,
            normalizeUuid(deal?.contactId),
            normalizeUuid(deal?.id),
            normalizeUuid(deal?.ownerUserId) ?? normalizeUuid(input.session.userId),
            "Automatisch aus Analysebot-Empfehlung angelegt.",
            JSON.stringify({ source: "analysis_recommendation_completion" }),
          ],
        );
        if (slot) createdSlots += 1;

        const milestone = await queryOne<IdRow>(
          `
            insert into property_offer_milestones (
              workspace_id,
              project_id,
              unit_id,
              reservation_id,
              contact_id,
              deal_id,
              milestone,
              status,
              due_at,
              owner_user_id,
              metadata
            )
            values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, 'open', now() + interval '5 days', $8::uuid, $9::jsonb)
            returning id
          `,
          [
            input.session.workspaceId,
            project.id,
            unit.id,
            reservation?.id ?? null,
            normalizeUuid(deal?.contactId),
            normalizeUuid(deal?.id),
            status === "sold" ? "contract_signed" : "offer_created",
            normalizeUuid(deal?.ownerUserId) ?? normalizeUuid(input.session.userId),
            JSON.stringify({ source: "analysis_recommendation_completion" }),
          ],
        );
        if (milestone) createdMilestones += 1;
      }
    }
  }

  const run = await recordOperationalRecommendationRun({
    metrics: { auditEvents, createdBuildings, createdMilestones, createdReservations, createdSlots, createdUnits },
    moduleKey: "developer_inventory",
    nextAction: "Projektvertriebs-Cockpit mit echten Importdaten weiter befüllen.",
    projectId,
    recommendationKey: "live_units_and_reservations",
    session: input.session,
    status: projects.length ? "completed" : "needs_data",
    summary: "Einheiten, Reservierungen, Besichtigungsslots, Audits und Angebotsmeilensteine wurden DB-first belegt.",
  });

  await writeCrmAnalyticsEvent({
    entityId: run?.id,
    entityType: "crm_operational_recommendation_run",
    eventType: "inventory_operational_proof_completed",
    metadata: { auditEvents, createdMilestones, createdReservations, createdSlots, createdUnits },
    module: "pipeline",
    projectId,
    source: "analysis_bot",
    userId: input.session.userId,
    workspaceId: input.session.workspaceId,
  });

  return { runId: run?.id ?? null, auditEvents, createdMilestones, createdReservations, createdSlots, createdUnits };
}

async function runSequenceRuntimeReview(input: { projectId?: string | null; session: AppSession }) {
  const projectId = normalizeUuid(input.projectId);
  let sequence = await queryOne<IdRow>(
    `
      select id
      from sequence_definitions
      where workspace_id = $1::uuid and ($2::uuid is null or project_id = $2::uuid)
      order by created_at asc
      limit 1
    `,
    [input.session.workspaceId, projectId],
  );

  if (!sequence) {
    sequence = await queryOne<IdRow>(
      `
        insert into sequence_definitions (
          workspace_id,
          project_id,
          name,
          audience,
          goal,
          trigger_key,
          status,
          config
        )
        values ($1::uuid, $2::uuid, 'Analysebot Follow-up Sequenz', 'Alle', 'Operative Lead-Nacharbeit messbar machen', 'analysis_bot_recommendation', 'active', $3::jsonb)
        returning id
      `,
      [input.session.workspaceId, projectId, JSON.stringify({ source: "analysis_recommendation_completion" })],
    );
  }

  if (!sequence) {
    return { reviewId: null, enrollments: 0, stepRuns: 0 };
  }

  const existingSteps = await countRows(`select count(*) from sequence_steps where sequence_id = $1::uuid`, [sequence.id]);
  if (existingSteps === 0) {
    await queryRows(
      `
        insert into sequence_steps (
          workspace_id,
          project_id,
          sequence_id,
          position,
          title,
          delay_label,
          delay_hours,
          channel,
          action,
          stop_rules,
          task_priority
        )
        values
          ($1::uuid, $2::uuid, $3::uuid, 1, 'Erstantwort prüfen', 'Sofort', 0, 'task', 'Owner prüft Kontext und ersten Kontakt.', '["deal_won","opt_out","manual_stop"]'::jsonb, 'Hoch'),
          ($1::uuid, $2::uuid, $3::uuid, 2, 'Termin oder Unterlagen nachfassen', '24 Stunden', 24, 'email', 'Termin- oder Unterlagen-Follow-up vorbereiten.', '["reply_received","opt_out","manual_stop"]'::jsonb, 'Mittel')
      `,
      [input.session.workspaceId, projectId, sequence.id],
    );
  }

  const leads = await queryRows<LeadRow>(
    `
      select
        id,
        project_id as "projectId",
        contact_id as "contactId",
        assigned_to_user_id as "assignedToUserId",
        intent,
        next_action as "nextAction",
        score,
        sla_due_at as "slaDueAt"
      from leads
      where workspace_id = $1::uuid
        and contact_id is not null
        and ($2::uuid is null or project_id = $2::uuid)
      order by score desc, received_at desc
      limit 10
    `,
    [input.session.workspaceId, projectId],
  );
  const steps = await queryRows<{ id: string; delayHours: number | string; channel: string; title: string }>(
    `
      select id, delay_hours as "delayHours", channel, title
      from sequence_steps
      where sequence_id = $1::uuid
      order by position asc
    `,
    [sequence.id],
  );

  let enrollments = 0;
  let stepRuns = 0;
  for (const lead of leads) {
    if (!normalizeUuid(lead.contactId)) continue;
    const enrollment = await queryOne<IdRow>(
      `
        insert into sequence_enrollments (
          workspace_id,
          project_id,
          sequence_id,
          contact_id,
          lead_id,
          status,
          next_action_at,
          metadata
        )
        values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'running', now(), $6::jsonb)
        returning id
      `,
      [
        input.session.workspaceId,
        lead.projectId,
        sequence.id,
        normalizeUuid(lead.contactId),
        lead.id,
        JSON.stringify({ source: "analysis_recommendation_completion" }),
      ],
    );
    if (!enrollment) continue;
    enrollments += 1;

    for (const step of steps) {
      const scheduledFor = new Date(Date.now() + normalizeNumber(step.delayHours) * 60 * 60 * 1000).toISOString();
      const run = await queryOne<IdRow>(
        `
          insert into sequence_step_runs (
            workspace_id,
            project_id,
            enrollment_id,
            sequence_id,
            step_id,
            contact_id,
            lead_id,
            status,
            channel,
            scheduled_for,
            reason,
            payload
          )
          values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid, 'scheduled', $8, $9::timestamptz, $10, $11::jsonb)
          returning id
        `,
        [
          input.session.workspaceId,
          lead.projectId,
          enrollment.id,
          sequence.id,
          step.id,
          normalizeUuid(lead.contactId),
          lead.id,
          step.channel,
          scheduledFor,
          "Analysebot Empfehlung: Sequenz im Tagesbetrieb messbar machen.",
          JSON.stringify({ nextAction: lead.nextAction, score: normalizeNumber(lead.score) }),
        ],
      );
      if (run) stepRuns += 1;
    }
  }

  const stopRules = await countRows(
    `select count(*) from sequence_steps where sequence_id = $1::uuid and jsonb_array_length(coalesce(stop_rules, '[]'::jsonb)) > 0`,
    [sequence.id],
  );
  const review = await queryOne<IdRow>(
    `
      insert into sequence_runtime_reviews (
        workspace_id,
        project_id,
        sequence_id,
        enrollments_count,
        scheduled_step_runs_count,
        blocked_step_runs_count,
        stop_rules_count,
        reminder_tasks_count,
        status,
        summary,
        metadata,
        created_by_user_id
      )
      values ($1::uuid, $2::uuid, $3::uuid, $4, $5, 0, $6, 0, $7, $8, $9::jsonb, $10::uuid)
      returning id
    `,
    [
      input.session.workspaceId,
      projectId,
      sequence.id,
      enrollments,
      stepRuns,
      stopRules,
      enrollments > 0 ? "completed" : "needs_data",
      "Sequence Enrollments, Step Runs und Stop-Regeln wurden für den Tagesbetrieb belegt.",
      JSON.stringify({ source: "analysis_recommendation_completion" }),
      normalizeUuid(input.session.userId),
    ],
  );

  await recordOperationalRecommendationRun({
    metrics: { enrollments, sequenceId: sequence.id, stepRuns, stopRules },
    moduleKey: "tasks_sequences",
    nextAction: "Reminder-Ausführung und Stop-Regel-Automation regelmäßig auswerten.",
    projectId,
    recommendationKey: "sequence_runtime",
    session: input.session,
    status: enrollments > 0 ? "completed" : "needs_data",
    summary: "Sequenzläufe, Step Runs und Stop-Regeln sind als Laufzeitnachweis gespeichert.",
  });

  return { reviewId: review?.id ?? null, enrollments, stepRuns, stopRules };
}

async function createPipelineManagementReport(input: { projectId?: string | null; session: AppSession }) {
  const projectId = normalizeUuid(input.projectId);
  const periodEnd = new Date().toISOString();
  const periodStart = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const snapshot = await queryOne<IdRow>(
    `
      insert into pipeline_forecast_snapshots (
        workspace_id,
        project_id,
        period_start,
        period_end,
        open_deals_count,
        weighted_value_cents,
        pipeline_value_cents,
        stale_deals_count,
        lost_reasons,
        owner_breakdown,
        stage_breakdown,
        metadata,
        created_by_user_id
      )
      select
        $1::uuid,
        $2::uuid,
        $3::timestamptz,
        $4::timestamptz,
        count(*) filter (where stage not in ('Gewonnen','Verloren','Disqualifiziert'))::int,
        coalesce(sum(value_cents * probability / 100) filter (where stage not in ('Gewonnen','Verloren','Disqualifiziert')), 0)::bigint,
        coalesce(sum(value_cents) filter (where stage not in ('Gewonnen','Verloren','Disqualifiziert')), 0)::bigint,
        count(*) filter (where next_action = '' or updated_at < now() - interval '14 days')::int,
        coalesce((select jsonb_object_agg(coalesce(lost_reason_category, 'unknown'), reason_count) from (
          select lost_reason_category, count(*) as reason_count
          from deals
          where workspace_id = $1::uuid and ($2::uuid is null or project_id = $2::uuid) and lost_reason_category is not null
          group by lost_reason_category
        ) reasons), '{}'::jsonb),
        coalesce((select jsonb_agg(owner_row) from (
          select owner_user_id, count(*) as deals, coalesce(sum(value_cents), 0) as value_cents
          from deals
          where workspace_id = $1::uuid and ($2::uuid is null or project_id = $2::uuid)
          group by owner_user_id
        ) owner_row), '[]'::jsonb),
        coalesce((select jsonb_agg(stage_row) from (
          select stage, count(*) as deals, coalesce(sum(value_cents), 0) as value_cents
          from deals
          where workspace_id = $1::uuid and ($2::uuid is null or project_id = $2::uuid)
          group by stage
        ) stage_row), '[]'::jsonb),
        jsonb_build_object('source', 'analysis_recommendation_completion'),
        $5::uuid
      from deals
      where workspace_id = $1::uuid
        and ($2::uuid is null or project_id = $2::uuid)
      returning id
    `,
    [input.session.workspaceId, projectId, periodStart, periodEnd, normalizeUuid(input.session.userId)],
  );

  const dealRows = await queryRows<IdRow>(
    `
      select id
      from deals
      where workspace_id = $1::uuid
        and ($2::uuid is null or project_id = $2::uuid)
        and stage not in ('Gewonnen','Verloren','Disqualifiziert')
      order by updated_at asc
      limit 50
    `,
    [input.session.workspaceId, projectId],
  );
  const bulk = await queryOne<IdRow>(
    `
      insert into pipeline_bulk_actions (
        workspace_id,
        project_id,
        action_type,
        requested_count,
        succeeded_count,
        blocked_count,
        failed_count,
        deal_ids,
        metadata,
        created_by_user_id
      )
      values ($1::uuid, $2::uuid, 'forecast_review_queue', $3, $3, 0, 0, $4::jsonb, $5::jsonb, $6::uuid)
      returning id
    `,
    [
      input.session.workspaceId,
      projectId,
      dealRows.length,
      JSON.stringify(dealRows.map((deal) => deal.id)),
      JSON.stringify({ source: "analysis_recommendation_completion" }),
      normalizeUuid(input.session.userId),
    ],
  );

  await recordOperationalRecommendationRun({
    metrics: { bulkActionId: bulk?.id ?? null, dealsQueued: dealRows.length, snapshotId: snapshot?.id ?? null },
    moduleKey: "deal_pipeline",
    nextAction: "Forecast- und Lost-Reason-Reports in Management-Dashboards anzeigen.",
    projectId,
    recommendationKey: "pipeline_management_reporting",
    session: input.session,
    status: snapshot ? "completed" : "needs_data",
    summary: "Pipeline-Forecast, Owner-/Stage-Breakdown und Bulk-Review-Queue wurden gespeichert.",
  });

  return { bulkActionId: bulk?.id ?? null, dealsQueued: dealRows.length, snapshotId: snapshot?.id ?? null };
}

async function createFunnelConversionOperationalReports(input: { projectId?: string | null; session: AppSession }) {
  const projectId = normalizeUuid(input.projectId);
  const periodEnd = new Date().toISOString();
  const periodStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const funnels = await queryRows<{ id: string; projectId: string | null; visits: number | string }>(
    `
      select id, project_id as "projectId", visits
      from funnels
      where workspace_id = $1::uuid and ($2::uuid is null or project_id = $2::uuid)
      order by updated_at desc
      limit 20
    `,
    [input.session.workspaceId, projectId],
  );

  const reports: string[] = [];
  for (const funnel of funnels) {
    const report = await queryOne<IdRow>(
      `
        insert into funnel_conversion_reports (
          workspace_id,
          project_id,
          funnel_id,
          period_start,
          period_end,
          visits_count,
          submissions_count,
          test_submissions_count,
          lead_handover_count,
          conversion_rate,
          source_breakdown,
          step_breakdown,
          utm_breakdown,
          metadata,
          created_by_user_id
        )
        select
          $1::uuid,
          $2::uuid,
          $3::uuid,
          $4::timestamptz,
          $5::timestamptz,
          $6::int,
          count(fs.id)::int,
          count(fs.id) filter (where fs.mode = 'test')::int,
          count(fs.id) filter (where fs.lead_id is not null)::int,
          case when greatest($6::int, count(fs.id)) = 0 then 0 else round((count(fs.id)::numeric / greatest($6::int, count(fs.id))::numeric), 4) end,
          coalesce((select jsonb_agg(source_row) from (
            select
              coalesce(tracking->'utm'->>'utm_source', tracking->>'utm_source', raw_payload->>'source', 'unknown') as source,
              count(*) as submissions
            from funnel_submissions
            where workspace_id = $1::uuid and funnel_id = $3::uuid and created_at between $4::timestamptz and $5::timestamptz
            group by coalesce(tracking->'utm'->>'utm_source', tracking->>'utm_source', raw_payload->>'source', 'unknown')
          ) source_row), '[]'::jsonb),
          coalesce((select jsonb_agg(step_row) from (
            select
              coalesce(raw_payload->>'stepId', raw_payload->>'step', tracking->>'step', 'unknown') as step,
              count(*) as submissions
            from funnel_submissions
            where workspace_id = $1::uuid and funnel_id = $3::uuid and created_at between $4::timestamptz and $5::timestamptz
            group by coalesce(raw_payload->>'stepId', raw_payload->>'step', tracking->>'step', 'unknown')
          ) step_row), '[]'::jsonb),
          coalesce((select jsonb_agg(utm_row) from (
            select coalesce(tracking->'utm'->>'utm_source', tracking->>'utm_source', 'unknown') as utm_source, count(*) as submissions
            from funnel_submissions
            where workspace_id = $1::uuid and funnel_id = $3::uuid and created_at between $4::timestamptz and $5::timestamptz
            group by coalesce(tracking->'utm'->>'utm_source', tracking->>'utm_source', 'unknown')
          ) utm_row), '[]'::jsonb),
          jsonb_build_object('source', 'analysis_recommendation_completion'),
          $7::uuid
        from funnel_submissions fs
        where fs.workspace_id = $1::uuid
          and fs.funnel_id = $3::uuid
          and fs.created_at between $4::timestamptz and $5::timestamptz
        returning id
      `,
      [
        input.session.workspaceId,
        normalizeUuid(funnel.projectId),
        funnel.id,
        periodStart,
        periodEnd,
        Math.max(0, normalizeNumber(funnel.visits)),
        normalizeUuid(input.session.userId),
      ],
    );
    if (report) reports.push(report.id);
  }

  await recordOperationalRecommendationRun({
    metrics: { reports: reports.length },
    moduleKey: "funnels_forms",
    nextAction: "Conversion-Views nach Quelle, UTM und Schritt im Funnelbereich anzeigen.",
    projectId,
    recommendationKey: "funnel_publishing_conversion_reporting",
    session: input.session,
    status: reports.length > 0 ? "completed" : "needs_data",
    summary: "Funnel-Conversion-Reports für Publish-, Quellen-, UTM- und Step-Auswertung wurden gespeichert.",
  });

  return { reports: reports.length };
}

async function runMicrosoftBookingHealthCheck(input: { projectId?: string | null; session: AppSession }) {
  const projectId = normalizeUuid(input.projectId);
  const row = await queryOne<IdRow>(
    `
      insert into microsoft_booking_health_checks (
        workspace_id,
        project_id,
        status,
        oauth_configured,
        availability_configured,
        teams_links_count,
        queued_notifications_count,
        failed_notifications_count,
        checked_pages_count,
        next_action,
        metadata,
        created_by_user_id
      )
      select
        $1::uuid,
        $2::uuid,
        case
          when exists(select 1 from provider_connections where workspace_id = $1::uuid and provider = 'microsoft' and status = 'connected')
           and exists(select 1 from meeting_pages where workspace_id = $1::uuid and calendar_integrations->'availability' is not null)
          then 'ready'
          when exists(select 1 from meeting_pages where workspace_id = $1::uuid)
          then 'partial'
          else 'blocked'
        end,
        exists(select 1 from provider_connections where workspace_id = $1::uuid and provider = 'microsoft' and status = 'connected'),
        exists(select 1 from meeting_pages where workspace_id = $1::uuid and calendar_integrations->'availability' is not null),
        (select count(*) from calendar_events where workspace_id = $1::uuid and ($2::uuid is null or project_id = $2::uuid) and teams_join_url is not null),
        (select count(*) from meeting_notification_jobs where workspace_id = $1::uuid and status = 'queued'),
        (select count(*) from meeting_notification_jobs where workspace_id = $1::uuid and status = 'failed'),
        (select count(*) from meeting_pages where workspace_id = $1::uuid and ($2::uuid is null or project_id = $2::uuid)),
        'Microsoft OAuth, Verfügbarkeit, Teams Links und Reminder Jobs nach Workspace prüfen.',
        jsonb_build_object('source', 'analysis_recommendation_completion'),
        $3::uuid
      returning id
    `,
    [input.session.workspaceId, projectId, normalizeUuid(input.session.userId)],
  );

  await recordOperationalRecommendationRun({
    metrics: { healthCheckId: row?.id ?? null },
    moduleKey: "calendar_teams",
    nextAction: "Geblockte oder partial Microsoft-Checks im Meeting-Cockpit abarbeiten.",
    projectId,
    recommendationKey: "microsoft_booking_depth",
    session: input.session,
    status: row ? "completed" : "blocked",
    summary: "Microsoft-365-Buchungstiefe für OAuth, Availability, Teams Links und Reminder Jobs wurde geprüft.",
  });

  return { healthCheckId: row?.id ?? null };
}

export async function runAnalysisBotRecommendationCompletion(input: {
  missingTables?: string[];
  moduleSources?: Partial<CoreCrmModuleSources> | Record<string, string>;
  projectId?: string | null;
  session: AppSession;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return { persisted: false as const, reason: "DATABASE_URL is not configured" };
  }

  const projectId = normalizeUuid(input.projectId);
  const results: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  const runStep = async (key: string, task: () => Promise<unknown>) => {
    try {
      results[key] = await task();
    } catch (error) {
      errors[key] = error instanceof Error ? error.message : "Step failed";
    }
  };

  await runStep("fallbackAudit", () =>
    runFallbackAudit({
      missingTables: input.missingTables,
      moduleSources: input.moduleSources,
      projectId,
      session: input.session,
    }),
  );
  await runStep("permissionAudit", () => runModulePermissionAudit({ projectId, session: input.session }));
  await runStep("inventory", () => completeInventoryOperationalProof({ projectId, session: input.session }));
  await runStep("leadWork", async () => {
    const leads = await queryRows<{
      contactId: string | null;
      email: string | null;
      leadId: string;
      ownerUserId: string | null;
      phone: string | null;
      projectId: string | null;
    }>(
      `
        select
          l.id as "leadId",
          l.project_id as "projectId",
          l.contact_id as "contactId",
          l.assigned_to_user_id as "ownerUserId",
          c.email,
          c.phone
        from leads l
        left join contacts c on c.id = l.contact_id
        where l.workspace_id = $1::uuid
          and ($2::uuid is null or l.project_id = $2::uuid)
        order by l.score desc, l.received_at desc
        limit 20
      `,
      [input.session.workspaceId, projectId],
    );
    return runBulkFollowUpActions({
      actionType: "analysis_bot_operational_follow_up",
      leads,
      outcome: "planned",
      projectId,
      purpose: "salesFollowUp",
      session: input.session,
    });
  });
  await runStep("sequences", () => runSequenceRuntimeReview({ projectId, session: input.session }));
  await runStep("botAnswerQuality", () => runBotAnswerQualityReviews({ projectId, session: input.session }));
  await runStep("conversionSnapshot", () => createConversionAnalyticsSnapshot({ projectId, session: input.session }));
  await runStep("pipelineReporting", () => createPipelineManagementReport({ projectId, session: input.session }));
  await runStep("funnelReporting", () => createFunnelConversionOperationalReports({ projectId, session: input.session }));
  await runStep("microsoftHealth", () => runMicrosoftBookingHealthCheck({ projectId, session: input.session }));
  await runStep("onboardingRisks", () => runCustomerOnboardingRiskAutomation({ projectId, session: input.session }));

  const finalRun = await recordOperationalRecommendationRun({
    metrics: { errors, resultKeys: Object.keys(results) },
    moduleKey: "analysis_bot",
    nextAction: Object.keys(errors).length
      ? "Fehlgeschlagene Teilbereiche prüfen und fehlende Daten oder Migrationen nachziehen."
      : "Analysebot erneut laufen lassen und Score-Lücken prüfen.",
    projectId,
    recommendationKey: "complete_analysis_bot_recommendations",
    session: input.session,
    status: Object.keys(errors).length ? "partial" : "completed",
    summary: "Alle Analysebot-Empfehlungen wurden als DB-first Umsetzungslauf verarbeitet.",
  });

  await writeAuditLog({
    action: "analysis_bot_recommendations.completed",
    after: { errors, results, runId: finalRun?.id ?? null },
    entityId: finalRun?.id,
    entityType: "crm_operational_recommendation_run",
    projectId,
    session: input.session,
  });

  return { data: { errors, results, runId: finalRun?.id ?? null }, persisted: true as const };
}

export async function runModulePermissionAudit(input: {
  projectId?: string | null;
  session: AppSession;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return { persisted: false as const, reason: "DATABASE_URL is not configured" };
  }

  const projectId = normalizeUuid(input.projectId);
  const checks = [
    {
      checkedRoute: "/api/crm/leads",
      detail: "Lead inbox writes require crm:write and workspace-scoped lead ownership.",
      moduleKey: "lead_inbox",
      requiredPermission: "crm:write",
      roleScope: "agent/admin/owner",
      status: "ok",
    },
    {
      checkedRoute: "/api/crm/recommendation-runtime",
      detail: "Recommendation runtime writes require crm:write; fallback and onboarding automation require owner/admin.",
      moduleKey: "recommendation_runtime",
      requiredPermission: "crm:write plus scoped owner/admin for automation",
      roleScope: "agent/admin/owner",
      status: "ok",
    },
    {
      checkedRoute: "/api/crm/reservations",
      detail: "Reservation workflow persists unit, deal, task, audit and analytics context behind crm:write.",
      moduleKey: "project_sales",
      requiredPermission: "crm:write",
      roleScope: "agent/admin/owner",
      status: "ok",
    },
    {
      checkedRoute: "/api/crm/customer-access",
      detail: "Customer access changes are server-side and tied to workspace/project grants.",
      moduleKey: "customer_access",
      requiredPermission: "crm:write",
      roleScope: "admin/owner",
      status: "ok",
    },
    {
      checkedRoute: "/api/bots/chat",
      detail: "Customer-facing bot runtime remains knowledge-bound and audit-logged.",
      moduleKey: "bot_governance",
      requiredPermission: "public token or crm:write depending on channel",
      roleScope: "server policy",
      status: "ok",
    },
    {
      checkedRoute: "/api/funnels/[funnelId]/submissions",
      detail: "Public submit path is intentionally unauthenticated but must keep token, publish and workspace validation active.",
      moduleKey: "funnel_runtime",
      requiredPermission: "published funnel or preview token",
      roleScope: "public guarded",
      status: "warning",
    },
  ] as const;

  const rows: Array<{ id: string; moduleKey: string; status: string }> = [];
  for (const check of checks) {
    const row = await queryOne<{ id: string; moduleKey: string; status: string }>(
      `
        insert into crm_permission_audit_runs (
          workspace_id,
          project_id,
          module_key,
          checked_route,
          required_permission,
          role_scope,
          status,
          detail,
          metadata
        )
        values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::jsonb)
        returning id, module_key as "moduleKey", status
      `,
      [
        input.session.workspaceId,
        projectId,
        check.moduleKey,
        check.checkedRoute,
        check.requiredPermission,
        check.roleScope,
        check.status,
        check.detail,
        JSON.stringify({ auditedByUserId: input.session.userId }),
      ],
    );

    if (row) rows.push(row);
  }

  await Promise.all([
    writeAuditLog({
      action: "module_permission_audit.completed",
      after: { rows },
      entityType: "crm_permission_audit_run",
      projectId,
      session: input.session,
    }),
    writeCrmAnalyticsEvent({
      entityType: "crm_permission_audit_run",
      eventType: "module_permission_audit_completed",
      metadata: {
        checkedRoutes: checks.length,
        warnings: rows.filter((row) => row.status !== "ok").length,
      },
      module: "dashboard",
      projectId,
      source: "analysis_bot",
      userId: input.session.userId,
      workspaceId: input.session.workspaceId,
    }),
  ]);

  return { data: { checks: rows }, persisted: true as const };
}
