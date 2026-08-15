import type { AppSession } from "@/lib/auth/session";
import { hasDatabaseUrl, queryOne, queryRows } from "@/lib/db/client";
import { isUuid, writeAuditLog } from "@/lib/db/runtime-repositories";
import { getProductRoleCapabilities } from "@/lib/product-model";
import {
  classifyDeliveryError,
  createLeaseOwner,
  PROVIDER_TIMEOUT_MS,
  retryDelaySeconds,
  sanitizeJobError,
} from "@/lib/jobs/durable-queue";
import {
  runNotificationTestSinkProbe,
  validateNotificationTargetReadiness,
} from "@/lib/notifications/provider-target-readiness";

export type GoogleAlertType =
  | "lead_sla_overdue"
  | "meeting_booked"
  | "customer_access_risk"
  | "deal_stage_changed";

export type GoogleNotificationSeverity = "info" | "warning" | "critical";
export type GoogleNotificationStatus =
  | "queued"
  | "retry"
  | "pending_config"
  | "sending"
  | "sent"
  | "failed"
  | "dead_letter"
  | "cancelled";
export type GoogleDestinationType = "google_chat_webhook" | "space" | "calendar";

export type GoogleFact = {
  name: string;
  value: string;
};

export type GoogleNotificationTarget = {
  alertTypes: GoogleAlertType[];
  calendarId?: string;
  destinationType: GoogleDestinationType;
  enabled: boolean;
  hasWebhookUrl: boolean;
  id: string;
  label: string;
  projectId?: string;
  spaceId?: string;
  workspaceId: string;
};

export type GoogleNotificationJob = {
  adminAction?: string;
  alertType: GoogleAlertType;
  attempts: number;
  configurationCode?: string;
  createdAt: string;
  error?: string;
  facts: GoogleFact[];
  id: string;
  message: string;
  projectId?: string;
  scheduledFor: string;
  sentAt?: string;
  severity: GoogleNotificationSeverity;
  status: GoogleNotificationStatus;
  summary: string;
  targetId?: string;
  title: string;
  workspaceId: string;
};

type TargetRow = {
  alertTypes: string[] | null;
  calendarId: string | null;
  destinationType: GoogleDestinationType;
  enabled: boolean;
  hasWebhookUrl?: boolean | null;
  id: string;
  label: string;
  projectId: string | null;
  spaceId: string | null;
  webhookUrl?: string | null;
  workspaceId: string;
};

type JobRow = {
  adminAction: string | null;
  alertType: GoogleAlertType;
  attempts: number | string;
  configurationCode: string | null;
  createdAt: string | Date;
  error: string | null;
  facts: unknown;
  id: string;
  message: string;
  projectId: string | null;
  scheduledFor: string | Date;
  sentAt: string | Date | null;
  severity: GoogleNotificationSeverity;
  status: GoogleNotificationStatus;
  summary: string;
  targetId: string | null;
  title: string;
  workspaceId: string;
};

type ClaimedJobRow = JobRow & {
  attemptCount: number | string;
  destinationType: GoogleDestinationType | null;
  leaseOwner: string;
  targetAlertTypes: string[] | null;
  targetEnabled: boolean | null;
  targetProjectId: string | null;
  targetWorkspaceId: string | null;
  webhookUrl: string | null;
};

type ReconcileJobRow = JobRow & {
  attemptCount: number | string;
  idempotencyKey: string;
  lastErrorCategory: string | null;
  providerMessageId: string | null;
};

type LeadAlertRow = {
  contactEmail: string | null;
  contactId: string | null;
  contactName: string | null;
  dueAt: string | Date;
  id: string;
  intent: string;
  nextAction: string;
  ownerName: string | null;
  ownerUserId: string | null;
  projectId: string;
  projectName: string | null;
  source: string;
};

type CustomerAccessRiskRow = {
  activationScore: number | string;
  customerAccessId: string;
  customerName: string | null;
  nextOnboardingAction: string;
  ownerName: string | null;
  ownerUserId: string | null;
  projectId: string | null;
  projectName: string | null;
  risks: unknown;
};

type DealAlertRow = {
  contactId: string | null;
  contactName: string | null;
  dealId: string;
  dealName: string;
  leadId: string | null;
  nextAction: string;
  ownerName: string | null;
  ownerUserId: string | null;
  projectId: string;
  projectName: string | null;
};

const allAlertTypes: GoogleAlertType[] = [
  "lead_sla_overdue",
  "meeting_booked",
  "customer_access_risk",
  "deal_stage_changed",
];

function cleanString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function toIso(value: string | Date | null | undefined) {
  if (!value) return "";
  return value instanceof Date ? value.toISOString() : String(value);
}

function normalizeAlertType(value: unknown): GoogleAlertType | null {
  return allAlertTypes.includes(value as GoogleAlertType) ? value as GoogleAlertType : null;
}

function normalizeSeverity(value: unknown): GoogleNotificationSeverity {
  return value === "info" || value === "warning" || value === "critical" ? value : "warning";
}

function normalizeDestinationType(value: unknown): GoogleDestinationType {
  return value === "space" || value === "calendar" || value === "google_chat_webhook"
    ? value
    : "google_chat_webhook";
}

function normalizeAlertTypes(value: unknown): GoogleAlertType[] {
  const values = Array.isArray(value) ? value : allAlertTypes;
  const normalized = values.map(normalizeAlertType).filter(Boolean) as GoogleAlertType[];

  return normalized.length ? normalized : allAlertTypes;
}

function normalizeFacts(value: unknown): GoogleFact[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const name = cleanString(record.name);
      const factValue = cleanString(record.value);
      return name && factValue ? { name, value: factValue } : null;
    })
    .filter(Boolean) as GoogleFact[];
}

function compactFacts(facts: Array<GoogleFact | null | undefined>) {
  return facts.filter((fact): fact is GoogleFact => Boolean(fact?.name && fact.value));
}

function toTarget(row: TargetRow): GoogleNotificationTarget {
  return {
    alertTypes: normalizeAlertTypes(row.alertTypes),
    calendarId: row.calendarId ?? undefined,
    destinationType: row.destinationType,
    enabled: row.enabled,
    hasWebhookUrl: Boolean(row.hasWebhookUrl ?? row.webhookUrl),
    id: row.id,
    label: row.label,
    projectId: row.projectId ?? undefined,
    spaceId: row.spaceId ?? undefined,
    workspaceId: row.workspaceId,
  };
}

function toJob(row: JobRow): GoogleNotificationJob {
  return {
    adminAction: row.adminAction ?? undefined,
    alertType: row.alertType,
    attempts: Number(row.attempts ?? 0),
    configurationCode: row.configurationCode ?? undefined,
    createdAt: toIso(row.createdAt),
    error: row.error ?? undefined,
    facts: normalizeFacts(row.facts),
    id: row.id,
    message: row.message,
    projectId: row.projectId ?? undefined,
    scheduledFor: toIso(row.scheduledFor),
    sentAt: row.sentAt ? toIso(row.sentAt) : undefined,
    severity: row.severity,
    status: row.status,
    summary: row.summary,
    targetId: row.targetId ?? undefined,
    title: row.title,
    workspaceId: row.workspaceId,
  };
}

function buildMessage(input: {
  contactName?: string | null;
  leadLabel?: string | null;
  nextAction?: string | null;
  ownerName?: string | null;
  projectName?: string | null;
  summary: string;
}) {
  return [
    input.summary,
    input.leadLabel ? `Lead: ${input.leadLabel}` : "",
    input.contactName ? `Kontakt: ${input.contactName}` : "",
    input.projectName ? `Projekt: ${input.projectName}` : "",
    input.ownerName ? `Owner: ${input.ownerName}` : "",
    input.nextAction ? `Nächste Aktion: ${input.nextAction}` : "",
  ].filter(Boolean).join("\n");
}

function buildGoogleChatPayload(input: {
  facts: GoogleFact[];
  message: string;
  severity: GoogleNotificationSeverity;
  summary: string;
  title: string;
}) {
  const severityLabel = input.severity === "critical" ? "Kritisch" : input.severity === "warning" ? "Warnung" : "Info";
  const factsText = input.facts.map((fact) => `${fact.name}: ${fact.value}`).join("\n");
  const text = [`*${severityLabel}: ${input.title}*`, input.message, factsText].filter(Boolean).join("\n\n");

  return {
    text,
    cardsV2: [
      {
        cardId: "novalure-crm-alert",
        card: {
          header: {
            title: `${severityLabel}: ${input.title}`,
            subtitle: input.summary,
          },
          sections: [
            {
              widgets: [
                {
                  textParagraph: {
                    text: input.message.replaceAll("\n", "<br>"),
                  },
                },
                ...input.facts.map((fact) => ({
                  decoratedText: {
                    topLabel: fact.name,
                    text: fact.value,
                  },
                })),
              ],
            },
          ],
        },
      },
    ],
  };
}

async function projectBelongsToWorkspace(workspaceId: string, projectId?: string | null) {
  if (!projectId) return true;
  if (!isUuid(projectId)) return false;

  const row = await queryOne<{ id: string }>(
    `
      select id
      from projects
      where id = $1::uuid and workspace_id = $2::uuid
      limit 1
    `,
    [projectId, workspaceId],
  );

  return Boolean(row);
}

async function findGoogleTarget(input: {
  alertType: GoogleAlertType;
  projectId?: string | null;
  workspaceId: string;
}) {
  return queryOne<TargetRow>(
    `
      select
        id,
        workspace_id as "workspaceId",
        project_id as "projectId",
        label,
        destination_type as "destinationType",
        webhook_url as "webhookUrl",
        space_id as "spaceId",
        calendar_id as "calendarId",
        enabled,
        alert_types as "alertTypes"
      from google_notification_targets
      where workspace_id = $1::uuid
        and (
          ($2::uuid is not null and project_id = $2::uuid)
          or project_id is null
        )
      order by
        case when project_id = $2::uuid then 0 else 1 end,
        enabled desc,
        case when $3 = any(alert_types) then 0 else 1 end,
        updated_at desc
      limit 1
    `,
    [input.workspaceId, input.projectId ?? null, input.alertType],
  );
}

async function getGoogleTargetById(input: { targetId: string; workspaceId: string }) {
  if (!isUuid(input.targetId) || !isUuid(input.workspaceId)) return null;
  return queryOne<TargetRow>(
    `
      select
        id,
        workspace_id as "workspaceId",
        project_id as "projectId",
        label,
        destination_type as "destinationType",
        webhook_url as "webhookUrl",
        space_id as "spaceId",
        calendar_id as "calendarId",
        enabled,
        alert_types as "alertTypes"
      from google_notification_targets
      where id = $1::uuid and workspace_id = $2::uuid
      limit 1
    `,
    [input.targetId, input.workspaceId],
  );
}

export async function listGoogleNotificationTargets(input: {
  session: AppSession;
}): Promise<{ source: "database" | "fallback"; targets: GoogleNotificationTarget[]; error?: string }> {
  if (!hasDatabaseUrl() || !isUuid(input.session.workspaceId)) {
    return { source: "fallback", targets: [] };
  }

  try {
    const rows = await queryRows<TargetRow>(
      `
        select
          id,
          workspace_id as "workspaceId",
          project_id as "projectId",
          label,
          destination_type as "destinationType",
          null::text as "webhookUrl",
          (webhook_url is not null and webhook_url <> '') as "hasWebhookUrl",
          space_id as "spaceId",
          calendar_id as "calendarId",
          enabled,
          alert_types as "alertTypes"
        from google_notification_targets
        where workspace_id = $1::uuid
        order by project_id nulls first, label asc
      `,
      [input.session.workspaceId],
    );

    return { source: "database", targets: rows.map(toTarget) };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Google targets could not be loaded",
      source: "fallback",
      targets: [],
    };
  }
}

export async function upsertGoogleNotificationTarget(input: {
  session: AppSession;
  target: {
    alertTypes?: unknown;
    calendarId?: unknown;
    destinationType?: unknown;
    enabled?: unknown;
    label?: unknown;
    projectId?: unknown;
    spaceId?: unknown;
    webhookUrl?: unknown;
  };
}): Promise<{ persisted: boolean; reason?: string; target?: GoogleNotificationTarget }> {
  if (!hasDatabaseUrl() || !isUuid(input.session.workspaceId)) {
    return { persisted: false, reason: "DATABASE_URL is not configured" };
  }

  const projectId = isUuid(cleanString(input.target.projectId)) ? cleanString(input.target.projectId) : null;
  const projectIsValid = await projectBelongsToWorkspace(input.session.workspaceId, projectId);
  if (!projectIsValid) {
    return { persisted: false, reason: "Project does not belong to this workspace" };
  }

  const existing = await queryOne<TargetRow>(
    `
      select
        id,
        workspace_id as "workspaceId",
        project_id as "projectId",
        label,
        destination_type as "destinationType",
        webhook_url as "webhookUrl",
        space_id as "spaceId",
        calendar_id as "calendarId",
        enabled,
        alert_types as "alertTypes"
      from google_notification_targets
      where workspace_id = $1::uuid
        and (($2::uuid is null and project_id is null) or project_id = $2::uuid)
      order by updated_at desc
      limit 1
    `,
    [input.session.workspaceId, projectId],
  );
  const alertTypes = normalizeAlertTypes(input.target.alertTypes);
  const destinationType = normalizeDestinationType(input.target.destinationType);
  const label = cleanString(input.target.label) || (projectId ? "Project Google" : "Workspace Google");
  const webhookUrl = cleanString(input.target.webhookUrl) || existing?.webhookUrl || null;
  const spaceId = cleanString(input.target.spaceId) || null;
  const calendarId = cleanString(input.target.calendarId) || null;
  const enabled = input.target.enabled === false ? false : true;
  if (enabled) {
    const readiness = validateNotificationTargetReadiness({
      alertType: alertTypes[0],
      projectId,
      provider: "google",
      target: {
        alertTypes,
        destinationType,
        enabled,
        projectId,
        webhookUrl,
        workspaceId: input.session.workspaceId,
      },
      workspaceId: input.session.workspaceId,
    });
    if (!readiness.ok) {
      return {
        persisted: false,
        reason: `${readiness.reason} ${readiness.adminAction}`,
      };
    }
  }

  const row = existing
    ? await queryOne<TargetRow>(
        `
          update google_notification_targets
          set
            label = $3,
            destination_type = $4,
            webhook_url = $5,
            space_id = $6,
            calendar_id = $7,
            enabled = $8,
            alert_types = $9::text[],
            metadata = metadata || $10::jsonb,
            updated_at = now()
          where id = $1::uuid and workspace_id = $2::uuid
          returning
            id,
            workspace_id as "workspaceId",
            project_id as "projectId",
            label,
            destination_type as "destinationType",
            webhook_url as "webhookUrl",
            space_id as "spaceId",
            calendar_id as "calendarId",
            enabled,
            alert_types as "alertTypes"
        `,
        [
          existing.id,
          input.session.workspaceId,
          label,
          destinationType,
          webhookUrl,
          spaceId,
          calendarId,
          enabled,
          alertTypes,
          JSON.stringify({ updatedByUserId: input.session.userId }),
        ],
      )
    : await queryOne<TargetRow>(
        `
          insert into google_notification_targets (
            workspace_id,
            project_id,
            label,
            destination_type,
            webhook_url,
            space_id,
            calendar_id,
            enabled,
            alert_types,
            created_by_user_id,
            metadata
          )
          values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::text[], $10::uuid, $11::jsonb)
          returning
            id,
            workspace_id as "workspaceId",
            project_id as "projectId",
            label,
            destination_type as "destinationType",
            webhook_url as "webhookUrl",
            space_id as "spaceId",
            calendar_id as "calendarId",
            enabled,
            alert_types as "alertTypes"
        `,
        [
          input.session.workspaceId,
          projectId,
          label,
          destinationType,
          webhookUrl,
          spaceId,
          calendarId,
          enabled,
          alertTypes,
          isUuid(input.session.userId) ? input.session.userId : null,
          JSON.stringify({ createdByUserId: input.session.userId }),
        ],
      );

  if (!row) {
    return { persisted: false, reason: "Google target could not be saved" };
  }

  await writeAuditLog({
    action: "google_notification.target_saved",
    after: toTarget(row),
    entityId: row.id,
    entityType: "google_notification_target",
    projectId: row.projectId,
    session: input.session,
  });

  return { persisted: true, target: toTarget(row) };
}

export async function listGoogleNotificationJobs(input: {
  limit?: number;
  session: AppSession;
  status?: GoogleNotificationStatus | "all";
}): Promise<{ jobs: GoogleNotificationJob[]; source: "database" | "fallback"; error?: string }> {
  if (!hasDatabaseUrl() || !isUuid(input.session.workspaceId)) {
    return { jobs: [], source: "fallback" };
  }

  const status = input.status && input.status !== "all" ? input.status : null;

  try {
    const rows = await queryRows<JobRow>(
      `
        select
          id,
          workspace_id as "workspaceId",
          project_id as "projectId",
          target_id as "targetId",
          alert_type as "alertType",
          severity,
          status,
          attempts,
          admin_action as "adminAction",
          configuration_code as "configurationCode",
          scheduled_for as "scheduledFor",
          sent_at as "sentAt",
          error,
          title,
          summary,
          message,
          facts,
          created_at as "createdAt"
        from google_notification_jobs
        where workspace_id = $1::uuid
          and ($2::text is null or status = $2)
        order by created_at desc
        limit $3
      `,
      [input.session.workspaceId, status, input.limit ?? 50],
    );

    return { jobs: rows.map(toJob), source: "database" };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Google notifications could not be loaded",
      jobs: [],
      source: "fallback",
    };
  }
}

export async function queueGoogleNotification(input: {
  alertType: GoogleAlertType;
  calendarEventId?: string | null;
  contactId?: string | null;
  customerAccessId?: string | null;
  dealId?: string | null;
  entityId?: string | null;
  entityType: string;
  facts?: GoogleFact[];
  idempotencyKey?: string;
  leadId?: string | null;
  message?: string;
  ownerUserId?: string | null;
  payload?: Record<string, unknown>;
  projectId?: string | null;
  session: AppSession;
  severity?: GoogleNotificationSeverity;
  summary: string;
  title: string;
}): Promise<{ job?: GoogleNotificationJob; queued: boolean; reason?: string }> {
  if (!hasDatabaseUrl() || !isUuid(input.session.workspaceId)) {
    return { queued: false, reason: "DATABASE_URL is not configured" };
  }

  try {
    const projectId = isUuid(input.projectId) ? input.projectId : null;
    const projectIsValid = await projectBelongsToWorkspace(input.session.workspaceId, projectId);
    if (!projectIsValid) {
      return { queued: false, reason: "Project does not belong to this workspace" };
    }

    const target = await findGoogleTarget({
      alertType: input.alertType,
      projectId,
      workspaceId: input.session.workspaceId,
    });
    const readiness = validateNotificationTargetReadiness({
      alertType: input.alertType,
      projectId,
      provider: "google",
      target,
      workspaceId: input.session.workspaceId,
    });
    const severity = normalizeSeverity(input.severity);
    const facts = input.facts ?? [];
    const message = input.message || input.summary;
    const googleChatPayload = buildGoogleChatPayload({
      facts,
      message,
      severity,
      summary: input.summary,
      title: input.title,
    });
    const idempotencyKey =
      input.idempotencyKey ||
      `${input.alertType}:${input.entityType}:${input.entityId ?? input.leadId ?? input.dealId ?? input.customerAccessId ?? input.calendarEventId ?? "unknown"}`;

    const row = await queryOne<JobRow>(
      `
        insert into google_notification_jobs (
          workspace_id,
          project_id,
          target_id,
          alert_type,
          severity,
          status,
          entity_type,
          entity_id,
          lead_id,
          contact_id,
          deal_id,
          calendar_event_id,
          customer_access_id,
          owner_user_id,
          title,
          summary,
          message,
          facts,
          payload,
          error,
          configuration_code,
          admin_action,
          idempotency_key
        )
        values (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          $4,
          $5,
          $6,
          $7,
          $8::uuid,
          $9::uuid,
          $10::uuid,
          $11::uuid,
          $12::uuid,
          $13::uuid,
          $14::uuid,
          $15,
          $16,
          $17,
          $18::jsonb,
          $19::jsonb,
          $20,
          $21,
          $22,
          $23
        )
        on conflict (workspace_id, idempotency_key)
        do update set
          idempotency_key = google_notification_jobs.idempotency_key
        returning
          id,
          admin_action as "adminAction",
          workspace_id as "workspaceId",
          project_id as "projectId",
          target_id as "targetId",
          alert_type as "alertType",
          severity,
          status,
          attempts,
          configuration_code as "configurationCode",
          scheduled_for as "scheduledFor",
          sent_at as "sentAt",
          error,
          title,
          summary,
          message,
          facts,
          created_at as "createdAt"
      `,
      [
        input.session.workspaceId,
        projectId,
        readiness.ok ? target?.id ?? null : null,
        input.alertType,
        severity,
        readiness.ok ? "queued" : "pending_config",
        input.entityType,
        isUuid(input.entityId) ? input.entityId : null,
        isUuid(input.leadId) ? input.leadId : null,
        isUuid(input.contactId) ? input.contactId : null,
        isUuid(input.dealId) ? input.dealId : null,
        isUuid(input.calendarEventId) ? input.calendarEventId : null,
        isUuid(input.customerAccessId) ? input.customerAccessId : null,
        isUuid(input.ownerUserId) ? input.ownerUserId : null,
        input.title,
        input.summary,
        message,
        JSON.stringify(facts),
        JSON.stringify({
          ...(input.payload ?? {}),
          google: {
            calendarId: target?.calendarId ?? null,
            destinationType: target?.destinationType ?? null,
            spaceId: target?.spaceId ?? null,
            targetId: target?.id ?? null,
            webhookReady: Boolean(target?.webhookUrl),
          },
          googleChatPayload,
        }),
        readiness.ok ? null : readiness.reason,
        readiness.ok ? null : readiness.code,
        readiness.ok ? null : readiness.adminAction,
        idempotencyKey,
      ],
    );

    if (!row) {
      return { queued: false, reason: "Google notification could not be queued" };
    }

    return { job: toJob(row), queued: row.status === "queued", reason: row.error ?? undefined };
  } catch (error) {
    return {
      queued: false,
      reason: error instanceof Error ? error.message : "Google notification queue failed",
    };
  }
}

export async function queueGoogleLeadSlaOverdueAlerts(input: {
  limit?: number;
  session: AppSession;
}): Promise<{ checked: number; queued: number; failed: number; pendingConfig: number }> {
  if (!hasDatabaseUrl() || !isUuid(input.session.workspaceId)) {
    return { checked: 0, failed: 0, pendingConfig: 0, queued: 0 };
  }

  const rows = await queryRows<LeadAlertRow>(
    `
      select
        l.id,
        l.project_id as "projectId",
        l.contact_id as "contactId",
        l.assigned_to_user_id as "ownerUserId",
        l.intent,
        l.next_action as "nextAction",
        l.sla_due_at as "dueAt",
        l.source,
        c.name as "contactName",
        c.email as "contactEmail",
        p.name as "projectName",
        wu.name as "ownerName"
      from leads l
      left join contacts c on c.id = l.contact_id and c.workspace_id = l.workspace_id
      left join projects p on p.id = l.project_id and p.workspace_id = l.workspace_id
      left join workspace_users wu on wu.id = l.assigned_to_user_id and wu.workspace_id = l.workspace_id
      where l.workspace_id = $1::uuid
        and l.sla_due_at is not null
        and l.sla_due_at < now()
        and l.status <> 'Archiviert'
        and not exists (
          select 1
          from google_notification_jobs gn
          where gn.workspace_id = l.workspace_id
            and gn.alert_type = 'lead_sla_overdue'
            and gn.lead_id = l.id
            and gn.status <> 'cancelled'
        )
      order by l.sla_due_at asc
      limit $2
    `,
    [input.session.workspaceId, input.limit ?? 25],
  );

  let queued = 0;
  let failed = 0;
  let pendingConfig = 0;
  for (const row of rows) {
    const dueAt = toIso(row.dueAt);
    const summary = `${row.contactName ?? "Lead"} ist seit ${dueAt} überfällig.`;
    const result = await queueGoogleNotification({
      alertType: "lead_sla_overdue",
      contactId: row.contactId,
      entityId: row.id,
      entityType: "lead",
      facts: compactFacts([
        { name: "Kontakt", value: row.contactName ?? row.contactEmail ?? row.id },
        { name: "Projekt", value: row.projectName ?? row.projectId },
        { name: "Owner", value: row.ownerName ?? "Nicht zugewiesen" },
        { name: "SLA fällig", value: dueAt },
        { name: "Quelle", value: row.source },
      ]),
      idempotencyKey: `lead_sla_overdue:${row.id}`,
      leadId: row.id,
      message: buildMessage({
        contactName: row.contactName,
        leadLabel: row.intent,
        nextAction: row.nextAction,
        ownerName: row.ownerName,
        projectName: row.projectName,
        summary,
      }),
      ownerUserId: row.ownerUserId,
      payload: { dueAt, source: row.source },
      projectId: row.projectId,
      session: input.session,
      severity: "critical",
      summary,
      title: "SLA überfällig",
    });
    if (result.queued) queued += 1;
    else if (result.job?.status === "pending_config") pendingConfig += 1;
    else failed += 1;
  }

  return { checked: rows.length, failed, pendingConfig, queued };
}

export async function queueGoogleCustomerAccessRiskAlerts(input: {
  limit?: number;
  session: AppSession;
}): Promise<{ checked: number; queued: number; failed: number; pendingConfig: number }> {
  if (!hasDatabaseUrl() || !isUuid(input.session.workspaceId)) {
    return { checked: 0, failed: 0, pendingConfig: 0, queued: 0 };
  }

  const rows = await queryRows<CustomerAccessRiskRow>(
    `
      select
        ca.id as "customerAccessId",
        ca.project_id as "projectId",
        ca.owner_user_id as "ownerUserId",
        ca.activation_score as "activationScore",
        ca.next_onboarding_action as "nextOnboardingAction",
        ca.risks,
        o.name as "customerName",
        p.name as "projectName",
        wu.name as "ownerName"
      from customer_workspace_access ca
      left join organizations o on o.id = ca.organization_id and o.workspace_id = ca.workspace_id
      left join projects p on p.id = ca.project_id and p.workspace_id = ca.workspace_id
      left join workspace_users wu on wu.id = ca.owner_user_id and wu.workspace_id = ca.workspace_id
      where ca.workspace_id = $1::uuid
        and (ca.health = 'risk' or ca.status = 'risk')
        and not exists (
          select 1
          from google_notification_jobs gn
          where gn.workspace_id = ca.workspace_id
            and gn.alert_type = 'customer_access_risk'
            and gn.customer_access_id = ca.id
            and gn.status <> 'cancelled'
        )
      order by ca.activation_score asc, ca.updated_at desc
      limit $2
    `,
    [input.session.workspaceId, input.limit ?? 25],
  );

  let queued = 0;
  let failed = 0;
  let pendingConfig = 0;
  for (const row of rows) {
    const risks = Array.isArray(row.risks) ? row.risks.map(String).join(", ") : "";
    const summary = `${row.customerName ?? "Customer Workspace"} ist im Risiko-Status.`;
    const result = await queueGoogleNotification({
      alertType: "customer_access_risk",
      customerAccessId: row.customerAccessId,
      entityId: row.customerAccessId,
      entityType: "customer_workspace_access",
      facts: compactFacts([
        { name: "Kunde", value: row.customerName ?? row.customerAccessId },
        { name: "Projekt", value: row.projectName ?? "Workspace" },
        { name: "Owner", value: row.ownerName ?? "Nicht zugewiesen" },
        { name: "Activation Score", value: String(row.activationScore ?? 0) },
        risks ? { name: "Risiken", value: risks } : null,
      ]),
      idempotencyKey: `customer_access_risk:${row.customerAccessId}`,
      message: buildMessage({
        contactName: row.customerName,
        nextAction: row.nextOnboardingAction,
        ownerName: row.ownerName,
        projectName: row.projectName,
        summary,
      }),
      ownerUserId: row.ownerUserId,
      payload: { activationScore: Number(row.activationScore ?? 0), risks },
      projectId: row.projectId,
      session: input.session,
      severity: "warning",
      summary,
      title: "Customer Access Risk",
    });
    if (result.queued) queued += 1;
    else if (result.job?.status === "pending_config") pendingConfig += 1;
    else failed += 1;
  }

  return { checked: rows.length, failed, pendingConfig, queued };
}

function isImportantStage(toStage: string) {
  return (
    toStage === "Termin gebucht" ||
    toStage === "Angebot/Reservierung" ||
    toStage.startsWith("Abschluss") ||
    toStage === "Gewonnen" ||
    toStage === "Verloren" ||
    toStage === "Disqualifiziert"
  );
}

export async function queueDealStageChangeGoogleNotification(input: {
  dealId: string;
  fromStage?: string | null;
  historyId?: string | null;
  reason?: string | null;
  session: AppSession;
  toStage: string;
}) {
  if (!isImportantStage(input.toStage) || !isUuid(input.dealId)) {
    return { queued: false, reason: "Stage is not configured as critical" };
  }

  const deal = await queryOne<DealAlertRow>(
    `
      select
        d.id as "dealId",
        d.project_id as "projectId",
        d.contact_id as "contactId",
        d.owner_user_id as "ownerUserId",
        d.lead_id as "leadId",
        d.name as "dealName",
        d.next_action as "nextAction",
        c.name as "contactName",
        p.name as "projectName",
        wu.name as "ownerName"
      from deals d
      left join contacts c on c.id = d.contact_id and c.workspace_id = d.workspace_id
      left join projects p on p.id = d.project_id and p.workspace_id = d.workspace_id
      left join workspace_users wu on wu.id = d.owner_user_id and wu.workspace_id = d.workspace_id
      where d.id = $1::uuid and d.workspace_id = $2::uuid
      limit 1
    `,
    [input.dealId, input.session.workspaceId],
  );

  if (!deal) return { queued: false, reason: "Deal not found" };

  const severity = input.toStage === "Verloren" || input.toStage === "Disqualifiziert" ? "critical" : "warning";
  const summary = `${deal.dealName} wechselte von ${input.fromStage ?? "unbekannt"} zu ${input.toStage}.`;

  return queueGoogleNotification({
    alertType: "deal_stage_changed",
    contactId: deal.contactId,
    dealId: deal.dealId,
    entityId: isUuid(input.historyId) ? input.historyId : deal.dealId,
    entityType: "deal_stage_history",
    facts: compactFacts([
      { name: "Deal", value: deal.dealName },
      { name: "Kontakt", value: deal.contactName ?? deal.contactId ?? "Kein Kontakt" },
      { name: "Projekt", value: deal.projectName ?? deal.projectId },
      { name: "Owner", value: deal.ownerName ?? "Nicht zugewiesen" },
      { name: "Stage", value: `${input.fromStage ?? "unbekannt"} -> ${input.toStage}` },
      input.reason ? { name: "Grund", value: input.reason } : null,
    ]),
    idempotencyKey: `deal_stage_changed:${input.historyId ?? deal.dealId}:${input.toStage}`,
    leadId: deal.leadId,
    message: buildMessage({
      contactName: deal.contactName,
      leadLabel: deal.dealName,
      nextAction: deal.nextAction,
      ownerName: deal.ownerName,
      projectName: deal.projectName,
      summary,
    }),
    ownerUserId: deal.ownerUserId,
    payload: { fromStage: input.fromStage ?? null, reason: input.reason ?? null, toStage: input.toStage },
    projectId: deal.projectId,
    session: input.session,
    severity,
    summary,
    title: "Wichtiger Stage-Wechsel",
  });
}

export async function queueMeetingBookedGoogleNotification(input: {
  bookingId: string;
  contactEmail: string;
  contactName: string;
  meetingProvider?: string | null;
  meetingTitle: string;
  onlineMeetingUrl?: string | null;
  ownerUserId?: string | null;
  projectId?: string | null;
  session: AppSession;
  startsAt: string;
}) {
  if (!isUuid(input.bookingId)) return { queued: false, reason: "Invalid booking" };

  const project = input.projectId && isUuid(input.projectId)
    ? await queryOne<{ name: string }>(
        "select name from projects where id = $1::uuid and workspace_id = $2::uuid limit 1",
        [input.projectId, input.session.workspaceId],
      )
    : null;
  const owner = input.ownerUserId && isUuid(input.ownerUserId)
    ? await queryOne<{ name: string }>(
        "select name from workspace_users where id = $1::uuid and workspace_id = $2::uuid limit 1",
        [input.ownerUserId, input.session.workspaceId],
      )
    : null;
  const summary = `${input.contactName} hat ${input.meetingTitle} gebucht.`;
  const linkLabel = input.meetingProvider === "google-meet" ? "Google-Meet-Link" : "Meeting-Link";

  return queueGoogleNotification({
    alertType: "meeting_booked",
    entityId: input.bookingId,
    entityType: "meeting_booking",
    facts: compactFacts([
      { name: "Kontakt", value: `${input.contactName} <${input.contactEmail}>` },
      { name: "Projekt", value: project?.name ?? input.projectId ?? "Workspace" },
      { name: "Owner", value: owner?.name ?? "Nicht zugewiesen" },
      { name: "Termin", value: input.startsAt },
      input.onlineMeetingUrl ? { name: linkLabel, value: input.onlineMeetingUrl } : null,
    ]),
    idempotencyKey: `meeting_booked:${input.bookingId}`,
    message: buildMessage({
      contactName: input.contactName,
      nextAction: "Termin vorbereiten und Kontaktkontext prüfen.",
      ownerName: owner?.name,
      projectName: project?.name,
      summary,
    }),
    ownerUserId: input.ownerUserId,
    payload: {
      contactEmail: input.contactEmail,
      meetingProvider: input.meetingProvider ?? null,
      onlineMeetingUrl: input.onlineMeetingUrl ?? null,
      startsAt: input.startsAt,
    },
    projectId: input.projectId,
    session: input.session,
    severity: "info",
    summary,
    title: "Termin gebucht",
  });
}

function createSystemSession(workspaceId: string): AppSession {
  return {
    authenticated: true,
    email: "system@novalure.local",
    name: "Novalure System",
    permissions: ["crm:read", "crm:write", "workflows:run"],
    productPermissions: getProductRoleCapabilities("novalure_operator"),
    productRole: "novalure_operator",
    role: "owner",
    source: "database",
    userId: "",
    workspaceId,
    workspaceName: "Novalure",
  };
}

export async function queueScheduledCriticalGoogleAlerts(input: {
  limitPerWorkspace?: number;
  shouldContinue?: () => boolean;
  workspaceLimit?: number;
} = {}) {
  if (!hasDatabaseUrl()) {
    return { checked: 0, failed: 0, pendingConfig: 0, queued: 0, workspaces: 0 };
  }

  const pageSize = Math.max(1, Math.min(100, input.workspaceLimit ?? 50));
  let cursor: string | null = null;
  let processedWorkspaces = 0;
  let checked = 0;
  let queued = 0;
  let failed = 0;
  let pendingConfig = 0;

  while (!input.shouldContinue || input.shouldContinue()) {
    const workspacePage: Array<{ id: string }> = await queryRows<{ id: string }>(
      `
        select id
        from workspaces
        where ($2::uuid is null or id > $2::uuid)
        order by id asc
        limit $1
      `,
      [pageSize, cursor],
    );
    if (!workspacePage.length) break;

    for (const workspaceRow of workspacePage) {
      if (input.shouldContinue && !input.shouldContinue()) break;
      const session = createSystemSession(workspaceRow.id);
      const sla = await queueGoogleLeadSlaOverdueAlerts({
        limit: input.limitPerWorkspace ?? 25,
        session,
      });
      const access = input.shouldContinue && !input.shouldContinue()
        ? { checked: 0, failed: 0, pendingConfig: 0, queued: 0 }
        : await queueGoogleCustomerAccessRiskAlerts({
            limit: input.limitPerWorkspace ?? 25,
            session,
          });

      checked += sla.checked + access.checked;
      queued += sla.queued + access.queued;
      failed += sla.failed + access.failed;
      pendingConfig += sla.pendingConfig + access.pendingConfig;
      processedWorkspaces += 1;
      cursor = workspaceRow.id;
    }

    if (workspacePage.length < pageSize || (input.shouldContinue && !input.shouldContinue())) break;
  }

  return { checked, failed, pendingConfig, queued, workspaces: processedWorkspaces };
}

export async function reconcileGoogleNotificationJob(input: {
  notificationId: string;
  session: AppSession;
  targetId: string;
}): Promise<{
  adminAction?: string;
  configurationCode?: string;
  error?: string;
  jobId?: string;
  ok: boolean;
  state?: "already_reconciled" | "blocked" | "reconciled";
}> {
  if (
    !hasDatabaseUrl() ||
    !isUuid(input.session.workspaceId) ||
    !isUuid(input.notificationId) ||
    !isUuid(input.targetId)
  ) {
    return { error: "invalid_notification_reconciliation", ok: false };
  }

  const job = await queryOne<ReconcileJobRow>(
    `
      select
        id,
        workspace_id as "workspaceId",
        project_id as "projectId",
        target_id as "targetId",
        alert_type as "alertType",
        severity,
        status,
        attempts,
        attempt_count as "attemptCount",
        last_error_category as "lastErrorCategory",
        scheduled_for as "scheduledFor",
        sent_at as "sentAt",
        provider_message_id as "providerMessageId",
        error,
        configuration_code as "configurationCode",
        admin_action as "adminAction",
        title,
        summary,
        message,
        facts,
        idempotency_key as "idempotencyKey",
        created_at as "createdAt"
      from google_notification_jobs
      where id = $1::uuid and workspace_id = $2::uuid
      limit 1
    `,
    [input.notificationId, input.session.workspaceId],
  );
  if (!job) return { error: "notification_not_found", ok: false };
  if (job.sentAt || job.providerMessageId || job.status === "sent") {
    return { error: "notification_already_delivered", ok: false };
  }
  if (
    Number(job.attemptCount) > 0 &&
    ["provider_timeout", "transient", "unknown"].includes(job.lastErrorCategory ?? "")
  ) {
    await writeAuditLog({
      action: "google_notification.reconciliation_blocked_uncertain_delivery",
      after: { jobId: job.id, targetId: input.targetId },
      entityId: job.id,
      entityType: "google_notification_job",
      projectId: job.projectId,
      session: input.session,
    });
    return {
      adminAction: "Verify the provider destination for a possible prior delivery, then close or reconcile the job through an authorized incident decision.",
      configurationCode: "delivery_outcome_uncertain",
      error: "The prior provider delivery outcome is uncertain; automatic reconciliation is blocked to prevent a duplicate message.",
      jobId: job.id,
      ok: false,
      state: "blocked",
    };
  }
  if (job.status === "queued" || job.status === "retry" || job.status === "sending") {
    return job.targetId === input.targetId
      ? { jobId: job.id, ok: true, state: "already_reconciled" }
      : { error: "notification_already_active_with_different_target", ok: false };
  }
  if (!(["failed", "pending_config", "dead_letter"] as GoogleNotificationStatus[]).includes(job.status)) {
    return { error: "notification_not_reconcilable", ok: false };
  }

  const target = await getGoogleTargetById({
    targetId: input.targetId,
    workspaceId: input.session.workspaceId,
  });
  const readiness = validateNotificationTargetReadiness({
    alertType: job.alertType,
    projectId: job.projectId,
    provider: "google",
    target,
    workspaceId: input.session.workspaceId,
  });
  if (!readiness.ok) {
    const blocked = await queryOne<{ id: string }>(
      `
        update google_notification_jobs
        set
          status = 'pending_config',
          error = $3,
          configuration_code = $4,
          admin_action = $5,
          retry_after = null,
          locked_by = null,
          lease_expires_at = null,
          updated_at = now()
        where id = $1::uuid
          and workspace_id = $2::uuid
          and status in ('failed', 'pending_config', 'dead_letter')
        returning id
      `,
      [job.id, input.session.workspaceId, readiness.reason, readiness.code, readiness.adminAction],
    );
    if (blocked) {
      await writeAuditLog({
        action: "google_notification.reconciliation_blocked",
        after: { configurationCode: readiness.code, jobId: job.id, targetId: input.targetId },
        entityId: job.id,
        entityType: "google_notification_job",
        projectId: job.projectId,
        session: input.session,
      });
    }
    return {
      adminAction: readiness.adminAction,
      configurationCode: readiness.code,
      error: readiness.reason,
      jobId: job.id,
      ok: false,
      state: "blocked",
    };
  }

  const row = await queryOne<{ id: string }>(
    `
      update google_notification_jobs
      set
        target_id = $3::uuid,
        status = 'queued',
        scheduled_for = now(),
        available_at = now(),
        error = null,
        configuration_code = null,
        admin_action = null,
        retry_after = null,
        attempt_count = 0,
        attempts = 0,
        locked_by = null,
        lease_expires_at = null,
        dead_lettered_at = null,
        last_error_category = null,
        last_error_message = null,
        reconciled_at = now(),
        reconciled_by_user_id = $4::uuid,
        updated_at = now()
      where id = $1::uuid
        and workspace_id = $2::uuid
        and idempotency_key = $5
        and provider_message_id is null
        and sent_at is null
        and status in ('failed', 'pending_config', 'dead_letter')
      returning id
    `,
    [
      job.id,
      input.session.workspaceId,
      input.targetId,
      isUuid(input.session.userId) ? input.session.userId : null,
      job.idempotencyKey,
    ],
  );
  if (!row) return { error: "notification_reconciliation_conflict", ok: false };

  await writeAuditLog({
    action: "google_notification.job_reconciled",
    after: { jobId: row.id, targetId: input.targetId },
    entityId: row.id,
    entityType: "google_notification_job",
    projectId: job.projectId,
    session: input.session,
  });

  return { jobId: row.id, ok: true, state: "reconciled" };
}

export async function runGoogleNotificationTargetTestSinkHealthcheck(input: {
  fetchImpl?: typeof fetch;
  session: AppSession;
  targetId: string;
}) {
  if (!hasDatabaseUrl() || !isUuid(input.session.workspaceId) || !isUuid(input.targetId)) {
    return { error: "invalid_google_target", ok: false as const };
  }
  const target = await getGoogleTargetById({
    targetId: input.targetId,
    workspaceId: input.session.workspaceId,
  });
  const alertType = normalizeAlertTypes(target?.alertTypes)[0];
  const readiness = validateNotificationTargetReadiness({
    alertType,
    projectId: target?.projectId,
    provider: "google",
    target,
    workspaceId: input.session.workspaceId,
  });
  if (!readiness.ok) {
    return {
      adminAction: readiness.adminAction,
      configurationCode: readiness.code,
      error: readiness.reason,
      ok: false as const,
    };
  }
  if (!target) {
    return { error: "invalid_google_target", ok: false as const };
  }

  const sinkUrl = process.env.NOVALURE_NOTIFICATION_TEST_SINK_URL ?? "";
  const probe = await runNotificationTestSinkProbe({
    allowInsecureLocalhost: process.env.NODE_ENV !== "production",
    fetchImpl: input.fetchImpl,
    provider: "google",
    sinkUrl,
    targetId: target.id,
  });
  await writeAuditLog({
    action: "google_notification.test_sink_healthcheck",
    after: { mode: "test_sink", ok: probe.ok, targetId: target.id },
    entityId: target.id,
    entityType: "google_notification_target",
    projectId: target.projectId,
    session: input.session,
  });
  return probe.ok
    ? {
        mode: probe.mode,
        ok: true as const,
        providerHealth: "not_probed" as const,
        providerReconnectPerformed: false,
      }
    : {
        ...probe,
        error: probe.reason,
        providerHealth: "not_probed" as const,
        providerReconnectPerformed: false,
      };
}

async function listDueGoogleNotificationJobIds(limit = 25, workspaceId?: string | null) {
  if (!hasDatabaseUrl()) return [];

  return queryRows<{ id: string }>(
    `
      select id
      from google_notification_jobs
      where (
        (
            status in ('queued', 'retry')
            and available_at <= now()
            and scheduled_for <= now()
            and attempt_count < max_attempts
          )
          or (
            status = 'sending'
            and lease_expires_at <= now()
            and attempt_count < max_attempts
          )
        )
        and ($2::uuid is null or workspace_id = $2::uuid)
      order by available_at asc, scheduled_for asc
      limit $1
    `,
    [limit, isUuid(workspaceId) ? workspaceId : null],
  );
}

async function prepareGoogleNotificationJobForDelivery(input: {
  id: string;
  workspaceId?: string | null;
}): Promise<"pending_config" | "ready" | "skipped"> {
  if (!hasDatabaseUrl() || !isUuid(input.id)) return "skipped";

  const row = await queryOne<{
    alertType: GoogleAlertType;
    destinationType: GoogleDestinationType | null;
    projectId: string | null;
    status: GoogleNotificationStatus;
    targetAlertTypes: string[] | null;
    targetEnabled: boolean | null;
    targetProjectId: string | null;
    targetWorkspaceId: string | null;
    webhookUrl: string | null;
    workspaceId: string;
  }>(
    `
      select
        j.workspace_id as "workspaceId",
        j.project_id as "projectId",
        j.alert_type as "alertType",
        j.status,
        t.workspace_id as "targetWorkspaceId",
        t.project_id as "targetProjectId",
        t.destination_type as "destinationType",
        t.webhook_url as "webhookUrl",
        t.enabled as "targetEnabled",
        t.alert_types as "targetAlertTypes"
      from google_notification_jobs j
      left join google_notification_targets t on t.id = j.target_id
      where j.id = $1::uuid
        and ($2::uuid is null or j.workspace_id = $2::uuid)
        and j.sent_at is null
        and j.provider_message_id is null
        and (
          j.status in ('queued', 'retry')
          or (j.status = 'sending' and j.lease_expires_at <= now())
        )
      limit 1
    `,
    [input.id, isUuid(input.workspaceId) ? input.workspaceId : null],
  );
  if (!row) return "skipped";

  const readiness = validateNotificationTargetReadiness({
    alertType: row.alertType,
    projectId: row.projectId,
    provider: "google",
    target: row.targetWorkspaceId && row.targetEnabled !== null
      ? {
          alertTypes: row.targetAlertTypes,
          destinationType: row.destinationType,
          enabled: row.targetEnabled,
          projectId: row.targetProjectId,
          webhookUrl: row.webhookUrl,
          workspaceId: row.targetWorkspaceId,
        }
      : null,
    workspaceId: row.workspaceId,
  });
  if (readiness.ok) return "ready";

  const updated = await queryOne<{ id: string }>(
    `
      update google_notification_jobs
      set
        status = 'pending_config',
        error = $2,
        configuration_code = $3,
        admin_action = $4,
        last_error_category = 'configuration',
        last_error_message = $2,
        retry_after = null,
        locked_by = null,
        lease_expires_at = null,
        updated_at = now()
      where id = $1::uuid
        and sent_at is null
        and provider_message_id is null
        and (
          status in ('queued', 'retry')
          or (status = 'sending' and lease_expires_at <= now())
        )
      returning id
    `,
    [input.id, readiness.reason, readiness.code, readiness.adminAction],
  );
  return updated ? "pending_config" : "skipped";
}

async function claimGoogleNotificationJob(input: {
  id: string;
  leaseOwner: string;
  workspaceId?: string | null;
}): Promise<ClaimedJobRow | null> {
  if (!hasDatabaseUrl() || !isUuid(input.id) || !input.leaseOwner) return null;

  return queryOne<ClaimedJobRow>(
    `
      with candidate as (
        select id
        from google_notification_jobs
        where id = $1::uuid
          and ($2::uuid is null or workspace_id = $2::uuid)
          and attempt_count < max_attempts
          and (
            (
              status in ('queued', 'retry')
              and available_at <= now()
              and scheduled_for <= now()
            )
            or (status = 'sending' and lease_expires_at <= now())
          )
        for update skip locked
      ), claimed as (
        update google_notification_jobs jobs
        set
          status = 'sending',
          attempts = jobs.attempts + 1,
          attempt_count = jobs.attempt_count + 1,
          locked_by = $3,
          lease_expires_at = now() + interval '45 seconds',
          last_attempt_at = now(),
          updated_at = now()
        from candidate
        where jobs.id = candidate.id
        returning jobs.*
      )
      select
        c.id,
        c.workspace_id as "workspaceId",
        c.project_id as "projectId",
        c.target_id as "targetId",
        c.alert_type as "alertType",
        c.severity,
        c.status,
        c.attempts,
        c.admin_action as "adminAction",
        c.configuration_code as "configurationCode",
        c.attempt_count as "attemptCount",
        c.locked_by as "leaseOwner",
        c.scheduled_for as "scheduledFor",
        c.sent_at as "sentAt",
        c.error,
        c.title,
        c.summary,
        c.message,
        c.facts,
        c.created_at as "createdAt",
        t.destination_type as "destinationType",
        t.webhook_url as "webhookUrl",
        t.alert_types as "targetAlertTypes",
        t.enabled as "targetEnabled",
        t.project_id as "targetProjectId",
        t.workspace_id as "targetWorkspaceId"
      from claimed c
      left join google_notification_targets t on t.id = c.target_id and t.workspace_id = c.workspace_id and t.enabled = true
      limit 1
    `,
    [input.id, isUuid(input.workspaceId) ? input.workspaceId : null, input.leaseOwner],
  );
}

async function markGoogleNotificationSent(input: {
  id: string;
  leaseOwner: string;
  messageId?: string | null;
}) {
  await queryOne(
    `
      update google_notification_jobs
      set
        status = 'sent',
        provider_message_id = $2,
        sent_at = now(),
        error = null,
        configuration_code = null,
        admin_action = null,
        last_error_category = null,
        last_error_message = null,
        locked_by = null,
        lease_expires_at = null,
        updated_at = now()
      where id = $1::uuid and status = 'sending' and locked_by = $3
      returning id
    `,
    [input.id, input.messageId ?? null, input.leaseOwner],
  );
}

async function markGoogleNotificationFailed(input: {
  adminAction?: string | null;
  category: string;
  configurationCode?: string | null;
  error: string;
  id: string;
  leaseOwner: string;
  retryDelaySeconds: number;
}) {
  await queryOne(
    `
      update google_notification_jobs
      set
        status = case
          when $3 = 'configuration' then 'pending_config'
          when attempt_count >= max_attempts then 'dead_letter'
          else 'retry'
        end,
        error = left($2, 500),
        configuration_code = case when $3 = 'configuration' then $6 else null end,
        admin_action = case when $3 = 'configuration' then $7 else null end,
        last_error_category = $3,
        last_error_message = left($2, 500),
        retry_after = case
          when $3 = 'configuration' or attempt_count >= max_attempts then null
          else now() + make_interval(secs => $5::int)
        end,
        available_at = case
          when $3 = 'configuration' or attempt_count >= max_attempts then available_at
          else now() + make_interval(secs => $5::int)
        end,
        dead_lettered_at = case
          when $3 <> 'configuration' and attempt_count >= max_attempts then now()
          else null
        end,
        locked_by = null,
        lease_expires_at = null,
        updated_at = now()
      where id = $1::uuid and status = 'sending' and locked_by = $4
      returning id
    `,
    [
      input.id,
      input.error,
      input.category,
      input.leaseOwner,
      input.retryDelaySeconds,
      input.configurationCode ?? null,
      input.adminAction ?? null,
    ],
  );
}

async function sendGoogleWebhook(job: ClaimedJobRow) {
  const readiness = validateNotificationTargetReadiness({
    alertType: job.alertType,
    projectId: job.projectId,
    provider: "google",
    target: job.targetWorkspaceId && job.targetEnabled !== null
      ? {
          alertTypes: job.targetAlertTypes,
          destinationType: job.destinationType,
          enabled: job.targetEnabled,
          projectId: job.targetProjectId,
          webhookUrl: job.webhookUrl,
          workspaceId: job.targetWorkspaceId,
        }
      : null,
    workspaceId: job.workspaceId,
  });
  if (!readiness.ok) {
    return {
      adminAction: readiness.adminAction,
      configurationCode: readiness.code,
      error: readiness.reason,
      ok: false as const,
      status: null,
    };
  }
  if (!job.webhookUrl) {
    return {
      adminAction: "Store a provider-issued webhook credential on the target, then reconcile the job explicitly.",
      configurationCode: "credential_missing",
      error: "The provider target has no webhook credential.",
      ok: false as const,
      status: null,
    };
  }

  const response = await fetch(job.webhookUrl, {
    body: JSON.stringify(buildGoogleChatPayload({
      facts: normalizeFacts(job.facts),
      message: job.message,
      severity: job.severity,
      summary: job.summary,
      title: job.title,
    })),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });

  if (!response.ok) {
    return {
      adminAction: undefined,
      configurationCode: undefined,
      error: `Google Chat webhook failed with HTTP ${response.status}`,
      ok: false as const,
      status: response.status,
    };
  }

  return {
    messageId: response.headers.get("x-request-id") ?? response.headers.get("x-guploader-uploadid"),
    ok: true as const,
    status: response.status,
  };
}

export async function processDueGoogleNotifications(
  input: {
    jobIds?: string[];
    limit?: number;
    shouldContinue?: () => boolean;
    workspaceId?: string | null;
  } = {},
): Promise<{ checked: number; failed: number; pendingConfig: number; sent: number }> {
  const refs = input.jobIds?.length
    ? input.jobIds.map((id) => ({ id }))
    : await listDueGoogleNotificationJobIds(input.limit ?? 25, input.workspaceId);
  const result = { checked: 0, failed: 0, pendingConfig: 0, sent: 0 };

  for (const ref of refs) {
    if (input.shouldContinue && !input.shouldContinue()) break;
    result.checked += 1;
    const preparation = await prepareGoogleNotificationJobForDelivery({
      id: ref.id,
      workspaceId: input.workspaceId,
    });
    if (preparation !== "ready") {
      if (preparation === "pending_config") result.pendingConfig += 1;
      continue;
    }
    const leaseOwner = createLeaseOwner("google-notification");
    let job: ClaimedJobRow | null;
    try {
      job = await claimGoogleNotificationJob({
        id: ref.id,
        leaseOwner,
        workspaceId: input.workspaceId,
      });
    } catch (error) {
      const afterConflict = await prepareGoogleNotificationJobForDelivery({
        id: ref.id,
        workspaceId: input.workspaceId,
      });
      if (afterConflict === "pending_config") {
        result.pendingConfig += 1;
        continue;
      }
      throw error;
    }
    if (!job) continue;

    let sendResult: Awaited<ReturnType<typeof sendGoogleWebhook>>;
    try {
      sendResult = await sendGoogleWebhook(job);
    } catch (error) {
      result.failed += 1;
      await markGoogleNotificationFailed({
        adminAction: "Repair the provider target and reconcile this job explicitly.",
        category: classifyDeliveryError({ error }),
        configurationCode: "provider_delivery_configuration_error",
        error: sanitizeJobError(error),
        id: job.id,
        leaseOwner: job.leaseOwner,
        retryDelaySeconds: retryDelaySeconds(Number(job.attemptCount)),
      });
      continue;
    }
    if (!sendResult.ok) {
      const deliveryCategory = sendResult.configurationCode
        ? "configuration"
        : classifyDeliveryError({ error: sendResult.error, status: sendResult.status });
      const providerRejectedCredential = deliveryCategory === "provider_auth" ||
        deliveryCategory === "provider_rejected";
      if (deliveryCategory === "configuration" || providerRejectedCredential) result.pendingConfig += 1;
      else result.failed += 1;
      await markGoogleNotificationFailed({
        adminAction: sendResult.adminAction ?? (providerRejectedCredential
          ? "Replace or repair the Google Chat webhook credential, validate it with the test sink, then reconcile explicitly."
          : null),
        category: providerRejectedCredential ? "configuration" : deliveryCategory,
        configurationCode: sendResult.configurationCode ?? (providerRejectedCredential
          ? "provider_credential_rejected"
          : null),
        error: sanitizeJobError(sendResult.error),
        id: job.id,
        leaseOwner: job.leaseOwner,
        retryDelaySeconds: retryDelaySeconds(Number(job.attemptCount)),
      });
      continue;
    }

    result.sent += 1;
    await markGoogleNotificationSent({
      id: job.id,
      leaseOwner: job.leaseOwner,
      messageId: sendResult.messageId ?? null,
    });
  }

  return result;
}
