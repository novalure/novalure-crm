import type { AppSession } from "@/lib/auth/session";
import { hasDatabaseUrl, queryOne, queryRows } from "@/lib/db/client";
import { isUuid, writeAuditLog } from "@/lib/db/runtime-repositories";
import { recordSpeedToLeadEvent } from "@/lib/db/speed-to-lead-repositories";
import { getProductRoleCapabilities } from "@/lib/product-model";

export type TeamsAlertType =
  | "lead_sla_overdue"
  | "lead_sla_due_soon"
  | "meeting_booked"
  | "customer_access_risk"
  | "deal_stage_changed"
  | "reservation_workflow";

export type TeamsNotificationSeverity = "info" | "warning" | "critical";
export type TeamsNotificationStatus = "queued" | "pending_config" | "sending" | "sent" | "failed" | "cancelled";
export type TeamsDestinationType = "incoming_webhook" | "channel" | "chat";

export type TeamsFact = {
  name: string;
  value: string;
};

export type TeamsNotificationTarget = {
  alertTypes: TeamsAlertType[];
  channelId?: string;
  channelName?: string;
  chatId?: string;
  destinationType: TeamsDestinationType;
  enabled: boolean;
  hasWebhookUrl: boolean;
  id: string;
  label: string;
  projectId?: string;
  teamId?: string;
  workspaceId: string;
};

export type TeamsNotificationJob = {
  alertType: TeamsAlertType;
  attempts: number;
  createdAt: string;
  error?: string;
  facts: TeamsFact[];
  id: string;
  message: string;
  projectId?: string;
  scheduledFor: string;
  sentAt?: string;
  severity: TeamsNotificationSeverity;
  status: TeamsNotificationStatus;
  summary: string;
  targetId?: string;
  title: string;
  workspaceId: string;
};

type TargetRow = {
  alertTypes: string[] | null;
  channelId: string | null;
  channelName: string | null;
  chatId: string | null;
  destinationType: TeamsDestinationType;
  enabled: boolean;
  hasWebhookUrl?: boolean | null;
  id: string;
  label: string;
  projectId: string | null;
  teamId: string | null;
  webhookUrl?: string | null;
  workspaceId: string;
};

type JobRow = {
  alertType: TeamsAlertType;
  attempts: number | string;
  createdAt: string | Date;
  error: string | null;
  facts: unknown;
  id: string;
  message: string;
  projectId: string | null;
  scheduledFor: string | Date;
  sentAt: string | Date | null;
  severity: TeamsNotificationSeverity;
  status: TeamsNotificationStatus;
  summary: string;
  targetId: string | null;
  title: string;
  workspaceId: string;
};

type ClaimedJobRow = JobRow & {
  destinationType: TeamsDestinationType | null;
  webhookUrl: string | null;
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
  workspaceId: string;
};

type TaskIdRow = { id: string };

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
  workspaceId: string;
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
  workspaceId: string;
};

const allAlertTypes: TeamsAlertType[] = [
  "lead_sla_overdue",
  "lead_sla_due_soon",
  "meeting_booked",
  "customer_access_risk",
  "deal_stage_changed",
  "reservation_workflow",
];

function cleanString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function toIso(value: string | Date | null | undefined) {
  if (!value) return "";
  return value instanceof Date ? value.toISOString() : String(value);
}

function normalizeAlertType(value: unknown): TeamsAlertType | null {
  return allAlertTypes.includes(value as TeamsAlertType) ? value as TeamsAlertType : null;
}

function normalizeSeverity(value: unknown): TeamsNotificationSeverity {
  return value === "info" || value === "warning" || value === "critical" ? value : "warning";
}

function normalizeDestinationType(value: unknown): TeamsDestinationType {
  return value === "channel" || value === "chat" || value === "incoming_webhook" ? value : "incoming_webhook";
}

function normalizeAlertTypes(value: unknown): TeamsAlertType[] {
  const values = Array.isArray(value) ? value : allAlertTypes;
  const normalized = values.map(normalizeAlertType).filter(Boolean) as TeamsAlertType[];

  return normalized.length ? normalized : allAlertTypes;
}

function normalizeFacts(value: unknown): TeamsFact[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const name = cleanString(record.name);
      const factValue = cleanString(record.value);
      return name && factValue ? { name, value: factValue } : null;
    })
    .filter(Boolean) as TeamsFact[];
}

function compactFacts(facts: Array<TeamsFact | null | undefined>) {
  return facts.filter((fact): fact is TeamsFact => Boolean(fact?.name && fact.value));
}

function toTarget(row: TargetRow): TeamsNotificationTarget {
  return {
    alertTypes: normalizeAlertTypes(row.alertTypes),
    channelId: row.channelId ?? undefined,
    channelName: row.channelName ?? undefined,
    chatId: row.chatId ?? undefined,
    destinationType: row.destinationType,
    enabled: row.enabled,
    hasWebhookUrl: Boolean(row.hasWebhookUrl ?? row.webhookUrl),
    id: row.id,
    label: row.label,
    projectId: row.projectId ?? undefined,
    teamId: row.teamId ?? undefined,
    workspaceId: row.workspaceId,
  };
}

function toJob(row: JobRow): TeamsNotificationJob {
  return {
    alertType: row.alertType,
    attempts: Number(row.attempts ?? 0),
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

function themeColor(severity: TeamsNotificationSeverity) {
  if (severity === "critical") return "dc2626";
  if (severity === "warning") return "d97706";
  return "2563eb";
}

function buildTeamsPayload(input: {
  facts: TeamsFact[];
  message: string;
  severity: TeamsNotificationSeverity;
  summary: string;
  title: string;
}) {
  return {
    "@context": "https://schema.org/extensions",
    "@type": "MessageCard",
    summary: input.summary || input.title,
    themeColor: themeColor(input.severity),
    title: input.title,
    sections: [
      {
        facts: input.facts,
        markdown: true,
        text: input.message,
      },
    ],
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

async function findTeamsTarget(input: {
  alertType: TeamsAlertType;
  projectId?: string | null;
  workspaceId: string;
}) {
  const row = await queryOne<TargetRow>(
    `
      select
        id,
        workspace_id as "workspaceId",
        project_id as "projectId",
        label,
        destination_type as "destinationType",
        webhook_url as "webhookUrl",
        team_id as "teamId",
        channel_id as "channelId",
        chat_id as "chatId",
        channel_name as "channelName",
        enabled,
        alert_types as "alertTypes"
      from teams_notification_targets
      where workspace_id = $1::uuid
        and enabled = true
        and $3 = any(alert_types)
        and (
          ($2::uuid is not null and project_id = $2::uuid)
          or project_id is null
        )
      order by case when project_id = $2::uuid then 0 else 1 end, updated_at desc
      limit 1
    `,
    [input.workspaceId, input.projectId ?? null, input.alertType],
  );

  return row;
}

export async function listTeamsNotificationTargets(input: {
  session: AppSession;
}): Promise<{ source: "database" | "fallback"; targets: TeamsNotificationTarget[]; error?: string }> {
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
          team_id as "teamId",
          channel_id as "channelId",
          chat_id as "chatId",
          channel_name as "channelName",
          enabled,
          alert_types as "alertTypes"
        from teams_notification_targets
        where workspace_id = $1::uuid
        order by project_id nulls first, label asc
      `,
      [input.session.workspaceId],
    );

    return { source: "database", targets: rows.map(toTarget) };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Teams targets could not be loaded",
      source: "fallback",
      targets: [],
    };
  }
}

export async function upsertTeamsNotificationTarget(input: {
  session: AppSession;
  target: {
    alertTypes?: unknown;
    channelId?: unknown;
    channelName?: unknown;
    chatId?: unknown;
    destinationType?: unknown;
    enabled?: unknown;
    label?: unknown;
    projectId?: unknown;
    teamId?: unknown;
    webhookUrl?: unknown;
  };
}): Promise<{ persisted: boolean; reason?: string; target?: TeamsNotificationTarget }> {
  if (!hasDatabaseUrl() || !isUuid(input.session.workspaceId)) {
    return { persisted: false, reason: "DATABASE_URL is not configured" };
  }

  const projectId = isUuid(cleanString(input.target.projectId)) ? cleanString(input.target.projectId) : null;
  const projectIsValid = await projectBelongsToWorkspace(input.session.workspaceId, projectId);
  if (!projectIsValid) {
    return { persisted: false, reason: "Project does not belong to this workspace" };
  }

  const existing = await queryOne<{ id: string }>(
    `
      select id
      from teams_notification_targets
      where workspace_id = $1::uuid
        and (($2::uuid is null and project_id is null) or project_id = $2::uuid)
      order by updated_at desc
      limit 1
    `,
    [input.session.workspaceId, projectId],
  );
  const alertTypes = normalizeAlertTypes(input.target.alertTypes);
  const destinationType = normalizeDestinationType(input.target.destinationType);
  const label = cleanString(input.target.label) || (projectId ? "Project Teams" : "Workspace Teams");
  const webhookUrl = cleanString(input.target.webhookUrl) || null;
  const teamId = cleanString(input.target.teamId) || null;
  const channelId = cleanString(input.target.channelId) || null;
  const chatId = cleanString(input.target.chatId) || null;
  const channelName = cleanString(input.target.channelName) || null;
  const enabled = input.target.enabled === false ? false : true;

  const row = existing
    ? await queryOne<TargetRow>(
        `
          update teams_notification_targets
          set
            label = $3,
            destination_type = $4,
            webhook_url = coalesce($5, webhook_url),
            team_id = $6,
            channel_id = $7,
            chat_id = $8,
            channel_name = $9,
            enabled = $10,
            alert_types = $11::text[],
            metadata = metadata || $12::jsonb,
            updated_at = now()
          where id = $1::uuid and workspace_id = $2::uuid
          returning
            id,
            workspace_id as "workspaceId",
            project_id as "projectId",
            label,
            destination_type as "destinationType",
            webhook_url as "webhookUrl",
            team_id as "teamId",
            channel_id as "channelId",
            chat_id as "chatId",
            channel_name as "channelName",
            enabled,
            alert_types as "alertTypes"
        `,
        [
          existing.id,
          input.session.workspaceId,
          label,
          destinationType,
          webhookUrl,
          teamId,
          channelId,
          chatId,
          channelName,
          enabled,
          alertTypes,
          JSON.stringify({ updatedByUserId: input.session.userId }),
        ],
      )
    : await queryOne<TargetRow>(
        `
          insert into teams_notification_targets (
            workspace_id,
            project_id,
            label,
            destination_type,
            webhook_url,
            team_id,
            channel_id,
            chat_id,
            channel_name,
            enabled,
            alert_types,
            created_by_user_id,
            metadata
          )
          values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11::text[], $12::uuid, $13::jsonb)
          returning
            id,
            workspace_id as "workspaceId",
            project_id as "projectId",
            label,
            destination_type as "destinationType",
            webhook_url as "webhookUrl",
            team_id as "teamId",
            channel_id as "channelId",
            chat_id as "chatId",
            channel_name as "channelName",
            enabled,
            alert_types as "alertTypes"
        `,
        [
          input.session.workspaceId,
          projectId,
          label,
          destinationType,
          webhookUrl,
          teamId,
          channelId,
          chatId,
          channelName,
          enabled,
          alertTypes,
          isUuid(input.session.userId) ? input.session.userId : null,
          JSON.stringify({ createdByUserId: input.session.userId }),
        ],
      );

  if (!row) {
    return { persisted: false, reason: "Teams target could not be saved" };
  }

  await writeAuditLog({
    action: "teams_notification.target_saved",
    after: toTarget(row),
    entityId: row.id,
    entityType: "teams_notification_target",
    projectId: row.projectId,
    session: input.session,
  });

  return { persisted: true, target: toTarget(row) };
}

export async function listTeamsNotificationJobs(input: {
  limit?: number;
  session: AppSession;
  status?: TeamsNotificationStatus | "all";
}): Promise<{ jobs: TeamsNotificationJob[]; source: "database" | "fallback"; error?: string }> {
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
          scheduled_for as "scheduledFor",
          sent_at as "sentAt",
          error,
          title,
          summary,
          message,
          facts,
          created_at as "createdAt"
        from teams_notification_jobs
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
      error: error instanceof Error ? error.message : "Teams notifications could not be loaded",
      jobs: [],
      source: "fallback",
    };
  }
}

export async function queueTeamsNotification(input: {
  alertType: TeamsAlertType;
  calendarEventId?: string | null;
  contactId?: string | null;
  customerAccessId?: string | null;
  dealId?: string | null;
  entityId?: string | null;
  entityType: string;
  facts?: TeamsFact[];
  idempotencyKey?: string;
  leadId?: string | null;
  message?: string;
  ownerUserId?: string | null;
  payload?: Record<string, unknown>;
  projectId?: string | null;
  session: AppSession;
  severity?: TeamsNotificationSeverity;
  summary: string;
  title: string;
}): Promise<{ job?: TeamsNotificationJob; queued: boolean; reason?: string }> {
  if (!hasDatabaseUrl() || !isUuid(input.session.workspaceId)) {
    return { queued: false, reason: "DATABASE_URL is not configured" };
  }

  try {
    const projectId = isUuid(input.projectId) ? input.projectId : null;
    const projectIsValid = await projectBelongsToWorkspace(input.session.workspaceId, projectId);
    if (!projectIsValid) {
      return { queued: false, reason: "Project does not belong to this workspace" };
    }

    const target = await findTeamsTarget({
      alertType: input.alertType,
      projectId,
      workspaceId: input.session.workspaceId,
    });
    const severity = normalizeSeverity(input.severity);
    const facts = input.facts ?? [];
    const message = input.message || input.summary;
    const teamsPayload = buildTeamsPayload({
      facts,
      message,
      severity,
      summary: input.summary,
      title: input.title,
    });
    const idempotencyKey =
      input.idempotencyKey ||
      `${input.alertType}:${input.entityType}:${input.entityId ?? input.leadId ?? input.dealId ?? input.customerAccessId ?? input.calendarEventId ?? "unknown"}`;
    const targetMissing = !target;

    const row = await queryOne<JobRow>(
      `
        insert into teams_notification_jobs (
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
          $21
        )
        on conflict (workspace_id, idempotency_key)
        do update set
          target_id = coalesce(excluded.target_id, teams_notification_jobs.target_id),
          status = case
            when teams_notification_jobs.status in ('failed', 'pending_config') and excluded.target_id is not null then 'queued'
            when teams_notification_jobs.status = 'failed' and excluded.target_id is null then 'pending_config'
            else teams_notification_jobs.status
          end,
          error = case
            when teams_notification_jobs.status in ('failed', 'pending_config') and excluded.target_id is not null then null
            when teams_notification_jobs.status = 'failed' and excluded.target_id is null then excluded.error
            else teams_notification_jobs.error
          end,
          title = excluded.title,
          summary = excluded.summary,
          message = excluded.message,
          facts = excluded.facts,
          payload = excluded.payload,
          updated_at = now()
        returning
          id,
          workspace_id as "workspaceId",
          project_id as "projectId",
          target_id as "targetId",
          alert_type as "alertType",
          severity,
          status,
          attempts,
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
        target?.id ?? null,
        input.alertType,
        severity,
        targetMissing ? "pending_config" : "queued",
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
          teams: {
            destinationType: target?.destinationType ?? null,
            targetId: target?.id ?? null,
            teamId: target?.teamId ?? null,
            channelId: target?.channelId ?? null,
            chatId: target?.chatId ?? null,
            channelName: target?.channelName ?? null,
            webhookReady: Boolean(target?.webhookUrl),
          },
          webhookPayload: teamsPayload,
        }),
        targetMissing ? "No Teams notification target configured for this workspace or project" : null,
        idempotencyKey,
      ],
    );

    if (!row) {
      return { queued: false, reason: "Teams notification could not be queued" };
    }

    return { job: toJob(row), queued: row.status === "queued", reason: row.error ?? undefined };
  } catch (error) {
    return {
      queued: false,
      reason: error instanceof Error ? error.message : "Teams notification queue failed",
    };
  }
}

export async function queueLeadSlaOverdueAlerts(input: {
  limit?: number;
  session: AppSession;
}): Promise<{ checked: number; failed: number; pendingConfig: number; queued: number }> {
  if (!hasDatabaseUrl() || !isUuid(input.session.workspaceId)) {
    return { checked: 0, failed: 0, pendingConfig: 0, queued: 0 };
  }

  const rows = await queryRows<LeadAlertRow>(
    `
      select
        l.id,
        l.workspace_id as "workspaceId",
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
          from teams_notification_jobs tn
          where tn.workspace_id = l.workspace_id
            and tn.alert_type = 'lead_sla_overdue'
            and tn.lead_id = l.id
            and tn.status in ('queued', 'pending_config', 'sending', 'sent')
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
    const result = await queueTeamsNotification({
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
    if (result.job?.status === "pending_config") pendingConfig += 1;
    else if (result.queued) queued += 1;
    else failed += 1;

    const escalationTaskId = await upsertLeadSlaEscalationTask({
      dueAt,
      notificationJobId: result.job?.id ?? null,
      row,
      session: input.session,
    });

    if (result.queued || result.job?.status === "pending_config") {
      await recordSpeedToLeadEvent({
        analyticsEventType: "sla_overdue",
        channel: "teams",
        contactId: row.contactId,
        dueAt,
        leadId: row.id,
        metadata: {
          notificationJobId: result.job?.id ?? null,
          ownerName: row.ownerName ?? null,
          projectName: row.projectName ?? null,
          sourcePayload: "teams_sla_queue",
        },
        notificationChannel: "teams",
        ownerUserId: row.ownerUserId,
        projectId: row.projectId,
        source: row.source,
        state: "overdue",
        userId: input.session.userId,
        workspaceId: input.session.workspaceId,
      });
    }

    if (escalationTaskId) {
      await recordSpeedToLeadEvent({
        analyticsEventType: "owner_escalated",
        channel: "crm_task",
        contactId: row.contactId,
        dueAt,
        leadId: row.id,
        metadata: {
          escalationTaskId,
          notificationJobId: result.job?.id ?? null,
          ownerName: row.ownerName ?? null,
          projectName: row.projectName ?? null,
          sourcePayload: "sla_owner_escalation",
        },
        notificationChannel: "crm_task",
        ownerUserId: row.ownerUserId,
        projectId: row.projectId,
        source: row.source,
        state: "overdue",
        userId: input.session.userId,
        workspaceId: input.session.workspaceId,
      });
    }
  }

  return { checked: rows.length, failed, pendingConfig, queued };
}

async function upsertLeadSlaEscalationTask(input: {
  dueAt: string;
  notificationJobId?: string | null;
  row: LeadAlertRow;
  session: AppSession;
}) {
  if (!isUuid(input.row.id)) return null;

  const existing = await queryOne<TaskIdRow>(
    `
      select id
      from tasks
      where workspace_id = $1
        and lead_id = $2
        and status = 'open'
        and metadata->>'speedToLeadEscalation' = 'true'
      order by created_at desc
      limit 1
    `,
    [input.session.workspaceId, input.row.id],
  );
  const ownerUserId = isUuid(input.row.ownerUserId)
    ? input.row.ownerUserId
    : isUuid(input.session.userId)
      ? input.session.userId
      : null;
  const title = `SLA Eskalation: ${input.row.contactName ?? input.row.contactEmail ?? input.row.intent ?? input.row.id}`;
  const metadata = {
    dueAt: input.dueAt,
    notificationJobId: input.notificationJobId ?? null,
    source: "speed_to_lead_autopilot",
    speedToLeadEscalation: true,
  };
  const row = existing
    ? await queryOne<TaskIdRow>(
        `
          update tasks
          set
            title = $3,
            due_at = now(),
            priority = 'Hoch',
            metadata = metadata || $4::jsonb,
            updated_at = now()
          where id = $1 and workspace_id = $2
          returning id
        `,
        [existing.id, input.session.workspaceId, title, JSON.stringify(metadata)],
      )
    : await queryOne<TaskIdRow>(
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
          values ($1, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, now(), 'Hoch', 'open', $7::jsonb)
          returning id
        `,
        [
          input.session.workspaceId,
          isUuid(input.row.projectId) ? input.row.projectId : null,
          isUuid(input.row.contactId) ? input.row.contactId : null,
          input.row.id,
          ownerUserId,
          title,
          JSON.stringify(metadata),
        ],
      );

  if (!row) return null;

  await writeAuditLog({
    action: existing ? "speed_to_lead.escalation_task_updated" : "speed_to_lead.escalation_task_created",
    after: {
      dueAt: input.dueAt,
      leadId: input.row.id,
      notificationJobId: input.notificationJobId ?? null,
      ownerUserId,
      taskId: row.id,
    },
    entityId: row.id,
    entityType: "task",
    projectId: input.row.projectId,
    session: input.session,
  });

  return row.id;
}

export async function queueLeadSlaDueSoonAlerts(input: {
  limit?: number;
  session: AppSession;
}): Promise<{ checked: number; failed: number; pendingConfig: number; queued: number }> {
  if (!hasDatabaseUrl() || !isUuid(input.session.workspaceId)) {
    return { checked: 0, failed: 0, pendingConfig: 0, queued: 0 };
  }

  const rows = await queryRows<LeadAlertRow>(
    `
      select
        l.id,
        l.workspace_id as "workspaceId",
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
        and l.sla_due_at >= now()
        and l.sla_due_at <= now() + interval '2 hours'
        and l.status <> 'Archiviert'
        and not exists (
          select 1
          from teams_notification_jobs tn
          where tn.workspace_id = l.workspace_id
            and tn.alert_type = 'lead_sla_due_soon'
            and tn.lead_id = l.id
            and tn.status in ('queued', 'pending_config', 'sending', 'sent')
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
    const summary = `${row.contactName ?? "Lead"} wird bis ${dueAt} fällig.`;
    const result = await queueTeamsNotification({
      alertType: "lead_sla_due_soon",
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
      idempotencyKey: `lead_sla_due_soon:${row.id}`,
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
      payload: { dueAt, source: row.source, state: "dueSoon" },
      projectId: row.projectId,
      session: input.session,
      severity: "warning",
      summary,
      title: "SLA bald fällig",
    });
    if (result.job?.status === "pending_config") pendingConfig += 1;
    else if (result.queued) queued += 1;
    else failed += 1;

    if (result.queued || result.job?.status === "pending_config") {
      await recordSpeedToLeadEvent({
        analyticsEventType: "sla_due_soon",
        channel: "teams",
        contactId: row.contactId,
        dueAt,
        leadId: row.id,
        metadata: {
          notificationJobId: result.job?.id ?? null,
          ownerName: row.ownerName ?? null,
          projectName: row.projectName ?? null,
          sourcePayload: "teams_sla_queue",
        },
        notificationChannel: "teams",
        ownerUserId: row.ownerUserId,
        projectId: row.projectId,
        source: row.source,
        state: "dueSoon",
        userId: input.session.userId,
        workspaceId: input.session.workspaceId,
      });
    }
  }

  return { checked: rows.length, failed, pendingConfig, queued };
}

export async function queueCustomerAccessRiskAlerts(input: {
  limit?: number;
  session: AppSession;
}): Promise<{ checked: number; failed: number; pendingConfig: number; queued: number }> {
  if (!hasDatabaseUrl() || !isUuid(input.session.workspaceId)) {
    return { checked: 0, failed: 0, pendingConfig: 0, queued: 0 };
  }

  const rows = await queryRows<CustomerAccessRiskRow>(
    `
      select
        ca.id as "customerAccessId",
        ca.workspace_id as "workspaceId",
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
          from teams_notification_jobs tn
          where tn.workspace_id = ca.workspace_id
            and tn.alert_type = 'customer_access_risk'
            and tn.customer_access_id = ca.id
            and tn.status in ('queued', 'pending_config', 'sending', 'sent')
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
    const result = await queueTeamsNotification({
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
    if (result.job?.status === "pending_config") pendingConfig += 1;
    else if (result.queued) queued += 1;
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

export async function queueDealStageChangeTeamsNotification(input: {
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
        d.workspace_id as "workspaceId",
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

  if (!deal) {
    return { queued: false, reason: "Deal not found" };
  }

  const severity = input.toStage === "Verloren" || input.toStage === "Disqualifiziert" ? "critical" : "warning";
  const summary = `${deal.dealName} wechselte von ${input.fromStage ?? "unbekannt"} zu ${input.toStage}.`;

  return queueTeamsNotification({
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

export async function queueMeetingBookedTeamsNotification(input: {
  bookingId: string;
  contactEmail: string;
  contactName: string;
  meetingTitle: string;
  onlineMeetingUrl?: string | null;
  ownerUserId?: string | null;
  projectId?: string | null;
  session: AppSession;
  startsAt: string;
}) {
  if (!isUuid(input.bookingId)) {
    return { queued: false, reason: "Invalid booking" };
  }

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

  return queueTeamsNotification({
    alertType: "meeting_booked",
    entityId: input.bookingId,
    entityType: "meeting_booking",
    facts: compactFacts([
      { name: "Kontakt", value: `${input.contactName} <${input.contactEmail}>` },
      { name: "Projekt", value: project?.name ?? input.projectId ?? "Workspace" },
      { name: "Owner", value: owner?.name ?? "Nicht zugewiesen" },
      { name: "Termin", value: input.startsAt },
      input.onlineMeetingUrl ? { name: "Teams-Link", value: input.onlineMeetingUrl } : null,
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
    payload: { contactEmail: input.contactEmail, onlineMeetingUrl: input.onlineMeetingUrl ?? null, startsAt: input.startsAt },
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

export async function queueScheduledCriticalTeamsAlerts(input: {
  limitPerWorkspace?: number;
  workspaceLimit?: number;
} = {}) {
  if (!hasDatabaseUrl()) {
    return { checked: 0, failed: 0, pendingConfig: 0, queued: 0, workspaces: 0 };
  }

  const workspaces = await queryRows<{ id: string }>(
    "select id from workspaces order by created_at desc limit $1",
    [input.workspaceLimit ?? 50],
  );
  let checked = 0;
  let queued = 0;
  let failed = 0;
  let pendingConfig = 0;

  for (const workspace of workspaces) {
    const session = createSystemSession(workspace.id);
    const [overdue, dueSoon, access] = await Promise.all([
      queueLeadSlaOverdueAlerts({ limit: input.limitPerWorkspace ?? 25, session }),
      queueLeadSlaDueSoonAlerts({ limit: input.limitPerWorkspace ?? 25, session }),
      queueCustomerAccessRiskAlerts({ limit: input.limitPerWorkspace ?? 25, session }),
    ]);

    checked += overdue.checked + dueSoon.checked + access.checked;
    queued += overdue.queued + dueSoon.queued + access.queued;
    failed += overdue.failed + dueSoon.failed + access.failed;
    pendingConfig += overdue.pendingConfig + dueSoon.pendingConfig + access.pendingConfig;
  }

  return { checked, failed, pendingConfig, queued, workspaces: workspaces.length };
}

export async function retryTeamsNotificationJob(input: {
  notificationId: string;
  session: AppSession;
}): Promise<{ error?: string; jobId?: string; ok: boolean }> {
  if (!hasDatabaseUrl() || !isUuid(input.session.workspaceId) || !isUuid(input.notificationId)) {
    return { error: "invalid_notification", ok: false };
  }

  const row = await queryOne<{ id: string }>(
    `
      update teams_notification_jobs
      set
        status = 'queued',
        scheduled_for = now(),
        error = null,
        retry_after = null,
        updated_at = now()
      where id = $1::uuid
        and workspace_id = $2::uuid
        and status in ('failed', 'pending_config')
      returning id
    `,
    [input.notificationId, input.session.workspaceId],
  );

  return row?.id
    ? { jobId: row.id, ok: true }
    : { error: "notification_not_found_or_not_retriable", ok: false };
}

async function claimTeamsNotificationJob(id: string, workspaceId?: string | null): Promise<ClaimedJobRow | null> {
  if (!hasDatabaseUrl() || !isUuid(id)) return null;

  return queryOne<ClaimedJobRow>(
    `
      with claimed as (
        update teams_notification_jobs
        set status = 'sending', attempts = attempts + 1, updated_at = now()
        where id = $1::uuid
          and ($2::uuid is null or workspace_id = $2::uuid)
          and status = 'queued'
          and scheduled_for <= now()
        returning *
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
        c.scheduled_for as "scheduledFor",
        c.sent_at as "sentAt",
        c.error,
        c.title,
        c.summary,
        c.message,
        c.facts,
        c.created_at as "createdAt",
        t.destination_type as "destinationType",
        t.webhook_url as "webhookUrl"
      from claimed c
      left join teams_notification_targets t on t.id = c.target_id and t.workspace_id = c.workspace_id and t.enabled = true
      limit 1
    `,
    [id, isUuid(workspaceId) ? workspaceId : null],
  );
}

async function listDueTeamsNotificationJobIds(limit = 25, workspaceId?: string | null) {
  if (!hasDatabaseUrl()) return [];

  return queryRows<{ id: string }>(
    `
      select id
      from teams_notification_jobs
      where status = 'queued'
        and scheduled_for <= now()
        and ($2::uuid is null or workspace_id = $2::uuid)
      order by scheduled_for asc
      limit $1
    `,
    [limit, isUuid(workspaceId) ? workspaceId : null],
  );
}

async function markTeamsNotificationSent(input: {
  id: string;
  messageId?: string | null;
}) {
  await queryOne(
    `
      update teams_notification_jobs
      set
        status = 'sent',
        provider_message_id = $2,
        sent_at = now(),
        error = null,
        updated_at = now()
      where id = $1::uuid
      returning id
    `,
    [input.id, input.messageId ?? null],
  );
}

async function markTeamsNotificationFailed(input: {
  error: string;
  id: string;
}) {
  await queryOne(
    `
      update teams_notification_jobs
      set
        status = 'failed',
        error = $2,
        retry_after = now() + interval '15 minutes',
        updated_at = now()
      where id = $1::uuid
      returning id
    `,
    [input.id, input.error],
  );
}

async function sendTeamsWebhook(job: ClaimedJobRow) {
  if (job.destinationType !== "incoming_webhook" || !job.webhookUrl) {
    return { error: "Teams target has no incoming webhook URL", ok: false as const };
  }

  const payload = buildTeamsPayload({
    facts: normalizeFacts(job.facts),
    message: job.message,
    severity: job.severity,
    summary: job.summary,
    title: job.title,
  });

  const response = await fetch(job.webhookUrl, {
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  if (!response.ok) {
    const error = await response.text().catch(() => "");
    return {
      error: `Teams webhook failed with ${response.status}${error ? `: ${error.slice(0, 240)}` : ""}`,
      ok: false as const,
    };
  }

  return {
    messageId: response.headers.get("request-id") ?? response.headers.get("x-ms-request-id"),
    ok: true as const,
  };
}

export async function processDueTeamsNotifications(
  input: { jobIds?: string[]; limit?: number; workspaceId?: string | null } = {},
): Promise<{ checked: number; failed: number; sent: number }> {
  const refs = input.jobIds?.length
    ? input.jobIds.map((id) => ({ id }))
    : await listDueTeamsNotificationJobIds(input.limit ?? 25, input.workspaceId);
  const result = { checked: refs.length, failed: 0, sent: 0 };

  for (const ref of refs) {
    const job = await claimTeamsNotificationJob(ref.id, input.workspaceId);
    if (!job) continue;

    const sendResult = await sendTeamsWebhook(job);
    if (!sendResult.ok) {
      result.failed += 1;
      await markTeamsNotificationFailed({ error: sendResult.error, id: job.id });
      continue;
    }

    result.sent += 1;
    await markTeamsNotificationSent({ id: job.id, messageId: sendResult.messageId ?? null });
  }

  return result;
}
