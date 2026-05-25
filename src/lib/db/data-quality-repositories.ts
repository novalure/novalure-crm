import type { AppSession } from "@/lib/auth/session";
import { writeCrmAnalyticsEvent } from "@/lib/db/analytics-event-repositories";
import { queryOne, queryRows } from "@/lib/db/client";
import { canPersist, isUuid, writeAuditLog } from "@/lib/db/runtime-repositories";

export type DataQualityIssueStatus = "open" | "resolved" | "ignored";
export type DataQualityIssueSeverity = "warning" | "risk";
export type DataQualityActionId =
  | "checkConsent"
  | "closeLead"
  | "completeContact"
  | "notifyOwner";

export type DataQualityIssueInput = {
  clientIssueId?: string | null;
  contactId?: string | null;
  detail?: string | null;
  entityId?: string | null;
  entityLabel?: string | null;
  entityType?: string | null;
  issueType?: string | null;
  leadId?: string | null;
  metadata?: Record<string, unknown> | null;
  nextAction?: string | null;
  ownerUserId?: string | null;
  projectId?: string | null;
  severity?: string | null;
};

export type DataQualityIssueRecord = {
  id: string;
  clientIssueId: string;
  entityId: string | null;
  entityType: string;
  issueType: string;
  projectId: string | null;
  status: DataQualityIssueStatus;
};

type DataQualityIssueRow = {
  id: string;
  workspaceId: string;
  projectId: string | null;
  entityType: string;
  entityId: string | null;
  issueType: string;
  severity: DataQualityIssueSeverity;
  status: DataQualityIssueStatus;
  detail: string;
  nextAction: string;
  metadata: unknown;
};

type IdRow = {
  id: string;
};

type TaskIdRow = {
  id: string;
};

type NormalizedIssue = {
  clientIssueId: string;
  contactId: string | null;
  detail: string;
  entityId: string | null;
  entityLabel: string;
  entityType: "contact" | "lead";
  issueType: string;
  leadId: string | null;
  metadata: Record<string, unknown>;
  nextAction: string;
  ownerUserId: string | null;
  projectId: string | null;
  severity: DataQualityIssueSeverity;
};

export async function syncDataQualityIssues(input: {
  issues: DataQualityIssueInput[];
  session: AppSession;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return { persisted: false as const, reason: "DATABASE_URL is not configured" };
  }

  const uniqueIssues = dedupeIssues(input.issues).slice(0, 200);
  const records: DataQualityIssueRecord[] = [];

  for (const issue of uniqueIssues) {
    const normalized = await normalizeIssue(input.session, issue);
    if (!normalized) continue;

    const row = await findOrCreateDataQualityIssue({
      issue: normalized,
      session: input.session,
    });

    if (row) {
      records.push(toIssueRecord(row));
    }
  }

  return { issues: records, persisted: true as const };
}

export async function updateDataQualityIssueStatus(input: {
  issue: DataQualityIssueInput;
  session: AppSession;
  status: Exclude<DataQualityIssueStatus, "open">;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return { persisted: false as const, reason: "DATABASE_URL is not configured" };
  }

  const normalized = await normalizeIssue(input.session, input.issue);
  if (!normalized) {
    return { persisted: false as const, reason: "Issue is not valid" };
  }

  const existing = await findOrCreateDataQualityIssue({
    issue: normalized,
    session: input.session,
  });

  if (!existing) {
    return { persisted: false as const, reason: "Issue could not be saved" };
  }

  const metadata = {
    ...asPlainObject(existing.metadata),
    ...normalized.metadata,
    statusChangedAt: new Date().toISOString(),
    statusChangedByUserId: input.session.userId,
  };

  const row = await queryOne<DataQualityIssueRow>(
    `
      update data_quality_issues
      set
        status = $3,
        resolved_at = now(),
        metadata = metadata || $4::jsonb
      where id = $1 and workspace_id = $2
      returning
        id,
        workspace_id as "workspaceId",
        project_id as "projectId",
        entity_type as "entityType",
        entity_id as "entityId",
        issue_type as "issueType",
        severity,
        status,
        detail,
        next_action as "nextAction",
        metadata
    `,
    [existing.id, input.session.workspaceId, input.status, JSON.stringify(metadata)],
  );

  if (!row) {
    return { persisted: false as const, reason: "Issue status could not be saved" };
  }

  await Promise.all([
    writeAuditLog({
      action: `data_quality_issue.${input.status}`,
      after: toIssueRecord(row),
      before: toIssueRecord(existing),
      entityId: row.id,
      entityType: "data_quality_issue",
      projectId: row.projectId,
      session: input.session,
    }),
    writeCrmAnalyticsEvent({
      entityId: row.id,
      entityType: "data_quality_issue",
      eventType: `data_quality_issue_${input.status}`,
      metadata: {
        clientIssueId: normalized.clientIssueId,
        issueType: row.issueType,
        status: row.status,
      },
      module: "dashboard",
      projectId: row.projectId,
      source: "data_hygiene_board",
      userId: input.session.userId,
      workspaceId: input.session.workspaceId,
    }),
  ]);

  return { issue: toIssueRecord(row), persisted: true as const };
}

export async function createDataQualityActionTask(input: {
  actionId: DataQualityActionId;
  actionLabel: string;
  issue: DataQualityIssueInput;
  session: AppSession;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return { persisted: false as const, reason: "DATABASE_URL is not configured" };
  }

  const normalized = await normalizeIssue(input.session, input.issue);
  if (!normalized) {
    return { persisted: false as const, reason: "Issue is not valid" };
  }

  const issueRow = await findOrCreateDataQualityIssue({
    issue: normalized,
    session: input.session,
  });

  if (!issueRow) {
    return { persisted: false as const, reason: "Issue could not be saved" };
  }

  const ownerUserId = await resolveWorkspaceUserId(
    input.session,
    normalized.ownerUserId || input.session.userId,
  );
  const taskTitle = `${cleanString(input.actionLabel) || input.actionId}: ${normalized.entityLabel}`;
  const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const contactId = await resolveEntityId(input.session, "contact", normalized.contactId);
  const leadId = await resolveEntityId(input.session, "lead", normalized.leadId);
  const metadata = {
    actionId: input.actionId,
    actionLabel: input.actionLabel,
    clientIssueId: normalized.clientIssueId,
    createdFrom: "data_hygiene_board",
    dataQualityIssueId: issueRow.id,
    issueType: normalized.issueType,
  };

  const existingTask = await queryOne<TaskIdRow>(
    `
      select id
      from tasks
      where workspace_id = $1
        and status = 'open'
        and metadata->>'dataQualityIssueId' = $2
        and metadata->>'actionId' = $3
      order by created_at desc
      limit 1
    `,
    [input.session.workspaceId, issueRow.id, input.actionId],
  );

  const task = existingTask
    ? await queryOne<TaskIdRow>(
        `
          update tasks
          set
            title = $3,
            due_at = $4::timestamptz,
            priority = $5,
            metadata = metadata || $6::jsonb,
            updated_at = now()
          where id = $1 and workspace_id = $2
          returning id
        `,
        [
          existingTask.id,
          input.session.workspaceId,
          taskTitle,
          dueAt,
          normalized.severity === "risk" ? "Hoch" : "Normal",
          JSON.stringify(metadata),
        ],
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
          values ($1, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7::timestamptz, $8, 'open', $9::jsonb)
          returning id
        `,
        [
          input.session.workspaceId,
          normalized.projectId,
          contactId,
          leadId,
          ownerUserId,
          taskTitle,
          dueAt,
          normalized.severity === "risk" ? "Hoch" : "Normal",
          JSON.stringify(metadata),
        ],
      );

  if (!task) {
    return { persisted: false as const, reason: "Task could not be saved" };
  }

  await Promise.all([
    writeAuditLog({
      action: existingTask ? "data_quality_action.task_updated" : "data_quality_action.task_created",
      after: {
        actionId: input.actionId,
        issueId: issueRow.id,
        taskId: task.id,
      },
      entityId: task.id,
      entityType: "task",
      projectId: normalized.projectId,
      session: input.session,
    }),
    writeCrmAnalyticsEvent({
      entityId: issueRow.id,
      entityType: "data_quality_issue",
      eventType: existingTask ? "data_quality_task_updated" : "data_quality_task_created",
      leadId,
      contactId,
      metadata,
      module: "task",
      projectId: normalized.projectId,
      source: "data_hygiene_board",
      userId: input.session.userId,
      workspaceId: input.session.workspaceId,
    }),
  ]);

  return {
    issue: toIssueRecord(issueRow),
    persisted: true as const,
    taskId: task.id,
  };
}

export async function listOpenDataQualityIssues(input: {
  projectId?: string | null;
  session: AppSession;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return [];
  }

  const projectId = await resolveScopedProjectId(input.session, input.projectId);
  const params: unknown[] = [input.session.workspaceId];
  const where = ["workspace_id = $1", "status = 'open'"];

  if (projectId) {
    params.push(projectId);
    where.push(`project_id = $${params.length}::uuid`);
  }

  const rows = await queryRows<DataQualityIssueRow>(
    `
      select
        id,
        workspace_id as "workspaceId",
        project_id as "projectId",
        entity_type as "entityType",
        entity_id as "entityId",
        issue_type as "issueType",
        severity,
        status,
        detail,
        next_action as "nextAction",
        metadata
      from data_quality_issues
      where ${where.join(" and ")}
      order by severity desc, detected_at desc
      limit 250
    `,
    params,
  );

  return rows.map(toIssueRecord);
}

function dedupeIssues(issues: DataQualityIssueInput[]) {
  const unique = new Map<string, DataQualityIssueInput>();

  for (const issue of issues) {
    const key = cleanString(issue.clientIssueId)
      || `${cleanString(issue.entityType)}:${cleanString(issue.entityId)}:${cleanString(issue.issueType)}`;
    if (!key) continue;
    unique.set(key, issue);
  }

  return Array.from(unique.values());
}

async function normalizeIssue(
  session: AppSession,
  issue: DataQualityIssueInput,
): Promise<NormalizedIssue | null> {
  const entityType = normalizeEntityType(issue.entityType);
  const issueType = cleanString(issue.issueType);
  if (!entityType || !issueType) return null;

  const explicitEntityId = cleanString(issue.entityId);
  const entityId = await resolveEntityId(session, entityType, explicitEntityId);
  const contactId = await resolveEntityId(session, "contact", issue.contactId);
  const leadId = await resolveEntityId(session, "lead", issue.leadId);
  const projectId =
    await resolveScopedProjectId(session, issue.projectId)
    ?? await resolveProjectIdFromEntity(session, entityType, entityId);
  const ownerUserId = await resolveWorkspaceUserId(session, issue.ownerUserId);
  const clientIssueId = cleanString(issue.clientIssueId)
    || `${entityType}:${entityId ?? "unknown"}:${issueType}`;
  const metadata = {
    ...asPlainObject(issue.metadata),
    clientIssueId,
    contactId,
    entityLabel: cleanString(issue.entityLabel),
    leadId,
    ownerUserId,
  };

  return {
    clientIssueId,
    contactId,
    detail: cleanString(issue.detail),
    entityId,
    entityLabel: cleanString(issue.entityLabel) || clientIssueId,
    entityType,
    issueType,
    leadId,
    metadata,
    nextAction: cleanString(issue.nextAction),
    ownerUserId,
    projectId,
    severity: normalizeSeverity(issue.severity),
  };
}

async function findOrCreateDataQualityIssue(input: {
  issue: NormalizedIssue;
  session: AppSession;
}) {
  const existing = await findExistingDataQualityIssue(input);

  if (existing) {
    if (existing.status !== "open") {
      return existing;
    }

    const row = await queryOne<DataQualityIssueRow>(
      `
        update data_quality_issues
        set
          project_id = $3::uuid,
          entity_id = $4::uuid,
          severity = $5,
          detail = $6,
          next_action = $7,
          metadata = metadata || $8::jsonb
        where id = $1 and workspace_id = $2
        returning
          id,
          workspace_id as "workspaceId",
          project_id as "projectId",
          entity_type as "entityType",
          entity_id as "entityId",
          issue_type as "issueType",
          severity,
          status,
          detail,
          next_action as "nextAction",
          metadata
      `,
      [
        existing.id,
        input.session.workspaceId,
        input.issue.projectId,
        input.issue.entityId,
        input.issue.severity,
        input.issue.detail,
        input.issue.nextAction,
        JSON.stringify(input.issue.metadata),
      ],
    );

    return row ?? existing;
  }

  const row = await queryOne<DataQualityIssueRow>(
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
      values ($1, $2::uuid, $3, $4::uuid, $5, $6, 'open', $7, $8, $9::jsonb)
      returning
        id,
        workspace_id as "workspaceId",
        project_id as "projectId",
        entity_type as "entityType",
        entity_id as "entityId",
        issue_type as "issueType",
        severity,
        status,
        detail,
        next_action as "nextAction",
        metadata
    `,
    [
      input.session.workspaceId,
      input.issue.projectId,
      input.issue.entityType,
      input.issue.entityId,
      input.issue.issueType,
      input.issue.severity,
      input.issue.detail,
      input.issue.nextAction,
      JSON.stringify(input.issue.metadata),
    ],
  );

  if (row) {
    await Promise.all([
      writeAuditLog({
        action: "data_quality_issue.detected",
        after: toIssueRecord(row),
        entityId: row.id,
        entityType: "data_quality_issue",
        projectId: row.projectId,
        session: input.session,
      }),
      writeCrmAnalyticsEvent({
        entityId: row.id,
        entityType: "data_quality_issue",
        eventType: "data_quality_issue_detected",
        metadata: {
          clientIssueId: input.issue.clientIssueId,
          issueType: input.issue.issueType,
          severity: input.issue.severity,
        },
        module: "dashboard",
        projectId: input.issue.projectId,
        source: "data_hygiene_board",
        userId: input.session.userId,
        workspaceId: input.session.workspaceId,
      }),
    ]);
  }

  return row;
}

async function findExistingDataQualityIssue(input: {
  issue: NormalizedIssue;
  session: AppSession;
}) {
  return queryOne<DataQualityIssueRow>(
    `
      select
        id,
        workspace_id as "workspaceId",
        project_id as "projectId",
        entity_type as "entityType",
        entity_id as "entityId",
        issue_type as "issueType",
        severity,
        status,
        detail,
        next_action as "nextAction",
        metadata
      from data_quality_issues
      where workspace_id = $1
        and issue_type = $2
        and entity_type = $3
        and (
          metadata->>'clientIssueId' = $4
          or ($5::uuid is not null and entity_id = $5::uuid)
        )
      order by
        case status when 'open' then 0 when 'ignored' then 1 else 2 end,
        detected_at desc
      limit 1
    `,
    [
      input.session.workspaceId,
      input.issue.issueType,
      input.issue.entityType,
      input.issue.clientIssueId,
      input.issue.entityId,
    ],
  );
}

async function resolveScopedProjectId(session: AppSession, value: string | null | undefined) {
  if (!isUuid(value)) return null;

  const row = await queryOne<IdRow>(
    `
      select id
      from projects
      where id = $1 and workspace_id = $2
      limit 1
    `,
    [value, session.workspaceId],
  );

  return row?.id ?? null;
}

async function resolveEntityId(
  session: AppSession,
  entityType: "contact" | "lead",
  value: string | null | undefined,
) {
  if (!isUuid(value)) return null;

  const table = entityType === "contact" ? "contacts" : "leads";
  const row = await queryOne<IdRow>(
    `
      select id
      from ${table}
      where id = $1 and workspace_id = $2
      limit 1
    `,
    [value, session.workspaceId],
  );

  return row?.id ?? null;
}

async function resolveProjectIdFromEntity(
  session: AppSession,
  entityType: "contact" | "lead",
  entityId: string | null,
) {
  if (!entityId) return null;

  const table = entityType === "contact" ? "contacts" : "leads";
  const row = await queryOne<{ projectId: string | null }>(
    `
      select project_id as "projectId"
      from ${table}
      where id = $1 and workspace_id = $2
      limit 1
    `,
    [entityId, session.workspaceId],
  );

  return row?.projectId ?? null;
}

async function resolveWorkspaceUserId(session: AppSession, value: string | null | undefined) {
  if (!isUuid(value)) return null;

  const row = await queryOne<IdRow>(
    `
      select id
      from workspace_users
      where id = $1 and workspace_id = $2
      limit 1
    `,
    [value, session.workspaceId],
  );

  return row?.id ?? null;
}

function toIssueRecord(row: DataQualityIssueRow): DataQualityIssueRecord {
  const metadata = asPlainObject(row.metadata);

  return {
    clientIssueId: cleanString(metadata.clientIssueId) || row.id,
    entityId: row.entityId,
    entityType: row.entityType,
    id: row.id,
    issueType: row.issueType,
    projectId: row.projectId,
    status: row.status,
  };
}

function normalizeEntityType(value: string | null | undefined): "contact" | "lead" | null {
  const cleaned = cleanString(value);

  if (cleaned === "contact" || cleaned === "lead") {
    return cleaned;
  }

  return null;
}

function normalizeSeverity(value: string | null | undefined): DataQualityIssueSeverity {
  return value === "risk" ? "risk" : "warning";
}

function asPlainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function cleanString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}
