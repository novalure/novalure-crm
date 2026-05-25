import type { AppSession } from "@/lib/auth/session";
import type {
  EditorPreflightCheck,
  EditorPreflightRun,
  EditorPreflightStatus,
  EditorPreflightType,
} from "@/lib/crm-types";
import { queryOne } from "@/lib/db/client";
import { canPersist, isUuid, writeAuditLog } from "@/lib/db/runtime-repositories";

type EditorPreflightRunRow = {
  blockers: string[] | null;
  checks: EditorPreflightCheck[] | null;
  createdAt: string | Date;
  editorType: EditorPreflightType;
  entityId: string | null;
  id: string;
  metadata: Record<string, unknown> | null;
  projectId: string | null;
  status: EditorPreflightStatus;
  warnings: string[] | null;
  workspaceId: string;
};

export async function runEditorPreflight(input: {
  editorType: EditorPreflightType;
  entityId?: string | null;
  payload?: unknown;
  projectId?: string | null;
  session: AppSession;
}): Promise<EditorPreflightRun> {
  const payload = asObject(input.payload);
  const projectId = normalizeUuid(input.projectId ?? payload.projectId);
  const checks = await buildChecks({
    editorType: input.editorType,
    payload,
    projectId,
    session: input.session,
  });
  const blockers = checks
    .filter((check) => check.required && check.status === "blocked")
    .map((check) => check.id);
  const warnings = checks
    .filter((check) => !check.required && check.status !== "pass")
    .map((check) => check.id);
  const status: EditorPreflightStatus = blockers.length > 0
    ? "blocked"
    : warnings.length > 0
      ? "warning"
      : "pass";

  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return {
      blockers,
      checks,
      createdAt: new Date().toISOString(),
      editorType: input.editorType,
      entityId: input.entityId ?? text(payload.id) ?? undefined,
      id: `preflight_local_${Date.now()}`,
      metadata: { source: "fallback" },
      projectId: projectId ?? undefined,
      status,
      warnings,
      workspaceId: input.session.workspaceId,
    };
  }

  const row = await queryOne<EditorPreflightRunRow>(
    `
      insert into editor_preflight_runs (
        workspace_id,
        project_id,
        editor_type,
        entity_id,
        status,
        checks,
        blockers,
        warnings,
        metadata,
        created_by_user_id
      )
      values ($1, $2::uuid, $3, $4, $5, $6::jsonb, $7::text[], $8::text[], $9::jsonb, $10::uuid)
      returning
        id,
        workspace_id as "workspaceId",
        project_id as "projectId",
        editor_type as "editorType",
        entity_id as "entityId",
        status,
        checks,
        blockers,
        warnings,
        metadata,
        created_at as "createdAt"
    `,
    [
      input.session.workspaceId,
      projectId,
      input.editorType,
      input.entityId ?? text(payload.id) ?? null,
      status,
      JSON.stringify(checks),
      blockers,
      warnings,
      JSON.stringify({
        source: "editor_preflight",
        targetStatus: text(payload.status),
      }),
      isUuid(input.session.userId) ? input.session.userId : null,
    ],
  );

  const run = row ? toEditorPreflightRun(row) : {
    blockers,
    checks,
    createdAt: new Date().toISOString(),
    editorType: input.editorType,
    entityId: input.entityId ?? text(payload.id) ?? undefined,
    id: `preflight_local_${Date.now()}`,
    metadata: { source: "insert_failed" },
    projectId: projectId ?? undefined,
    status,
    warnings,
    workspaceId: input.session.workspaceId,
  };

  await writeAuditLog({
    action: "editor.preflight_ran",
    after: {
      blockers,
      editorType: input.editorType,
      entityId: run.entityId ?? null,
      status,
      warnings,
    },
    entityId: isUuid(run.entityId) ? run.entityId : undefined,
    entityType: "editor_preflight",
    projectId,
    session: input.session,
  });

  return run;
}

function buildCheck(input: {
  id: string;
  label: string;
  message: string;
  passed: boolean;
  required?: boolean;
}): EditorPreflightCheck {
  const required = input.required !== false;

  return {
    id: input.id,
    label: input.label,
    message: input.message,
    required,
    status: input.passed ? "pass" : required ? "blocked" : "warning",
  };
}

async function buildChecks(input: {
  editorType: EditorPreflightType;
  payload: Record<string, unknown>;
  projectId: string | null;
  session: AppSession;
}) {
  if (input.editorType === "newsletter") return buildNewsletterChecks(input.payload);
  if (input.editorType === "bot") return buildBotChecks(input);
  if (input.editorType === "funnel") return buildFunnelChecks(input.payload, input.projectId);
  return buildCalendarChecks(input.payload, input.session);
}

function buildNewsletterChecks(payload: Record<string, unknown>) {
  const html = text(payload.html) || text(payload.body) || "";
  const recipients = Array.isArray(payload.recipients)
    ? payload.recipients.filter((recipient) => text(recipient)).length
    : text(payload.to)
      ? 1
      : 0;
  const subject = text(payload.subject);
  const hasUnsubscribe = /unsubscribe|abmelden|NOVALURE_UNSUBSCRIBE_URL|RESEND_UNSUBSCRIBE_URL/i.test(html);

  return [
    buildCheck({
      id: "newsletter:segment_or_recipients",
      label: "Segment / recipients",
      message: "Newsletter needs a segment or explicit recipients.",
      passed: recipients > 0 || Boolean(text(payload.segmentId)),
    }),
    buildCheck({
      id: "newsletter:subject",
      label: "Subject",
      message: "Subject is required before send.",
      passed: Boolean(subject),
    }),
    buildCheck({
      id: "newsletter:content",
      label: "Content",
      message: "HTML/body content is required before send.",
      passed: Boolean(html),
    }),
    buildCheck({
      id: "newsletter:unsubscribe",
      label: "Unsubscribe",
      message: "An unsubscribe placeholder or link is required.",
      passed: hasUnsubscribe,
    }),
    buildCheck({
      id: "newsletter:provider",
      label: "Provider",
      message: "Provider status should be connected before productive delivery.",
      passed: Boolean(payload.providerConfigured ?? process.env.RESEND_API_KEY),
      required: false,
    }),
    buildCheck({
      id: "newsletter:double_opt_in",
      label: "Double opt-in",
      message: "Double opt-in/consent policy is checked during recipient evaluation.",
      passed: true,
      required: false,
    }),
  ];
}

async function buildBotChecks(input: {
  payload: Record<string, unknown>;
  projectId: string | null;
  session: AppSession;
}) {
  const status = text(input.payload.status);
  const isPublish = status === "active";
  const strictKnowledge = input.payload.strictKnowledge !== false;
  const channels = Array.isArray(input.payload.channels) ? input.payload.channels : [];
  const hasHandoff = channels.some((channel) => {
    const rules = asObject(channel).handoffRules;
    return Array.isArray(rules) && rules.some((rule) => Boolean(text(rule)));
  });
  const approvedKnowledge = isPublish
    ? await countApprovedKnowledgeSources({ projectId: input.projectId, session: input.session })
    : 1;

  return [
    buildCheck({
      id: "bot:strict_knowledge",
      label: "Strict knowledge",
      message: "Customer bots must use approved workspace/project knowledge only.",
      passed: strictKnowledge,
    }),
    buildCheck({
      id: "bot:approved_knowledge",
      label: "Approved knowledge",
      message: "At least one approved knowledge source is required for publish.",
      passed: approvedKnowledge > 0,
    }),
    buildCheck({
      id: "bot:handoff",
      label: "Handoff",
      message: "At least one handoff rule should exist before publish.",
      passed: hasHandoff,
      required: isPublish,
    }),
    buildCheck({
      id: "bot:test",
      label: "Test",
      message: "A passing test or governance evaluation should be present before publish.",
      passed: Boolean(input.payload.testPassed ?? !isPublish),
      required: false,
    }),
  ];
}

function buildFunnelChecks(payload: Record<string, unknown>, projectId: string | null) {
  const crmHandover = asObject(payload.crmHandover);

  return [
    buildCheck({
      id: "funnel:project",
      label: "Project",
      message: "Funnel needs a workspace/project target.",
      passed: Boolean(projectId),
    }),
    buildCheck({
      id: "funnel:lead_target",
      label: "Lead target",
      message: "Lead target/audience is required.",
      passed: Boolean(text(payload.audience) || text(payload.leadTarget)),
    }),
    buildCheck({
      id: "funnel:crm_handover",
      label: "CRM handover",
      message: "CRM destination and pipeline stage should be defined.",
      passed: Boolean(text(crmHandover.destination) || text(payload.crmStage)),
    }),
    buildCheck({
      id: "funnel:consent",
      label: "Consent",
      message: "Consent mode or privacy setup should be visible.",
      passed: Boolean(text(payload.consentMode) || payload.consentRequired !== false),
    }),
    buildCheck({
      id: "funnel:preview",
      label: "Preview",
      message: "Preview should be checked before publishing.",
      passed: Boolean(payload.previewChecked ?? payload.previewReady),
      required: false,
    }),
  ];
}

function buildCalendarChecks(payload: Record<string, unknown>, session: AppSession) {
  const provider = text(payload.provider) || text(payload.calendarProvider) || session.workspaceActiveCalendarProvider || "none";
  const integrations = asObject(payload.calendarIntegrations);
  const availability = asObject(payload.availability) || asObject(integrations.availability);
  const reminders = Array.isArray(payload.reminders) ? payload.reminders : asObject(payload.automation).reminders;

  return [
    buildCheck({
      id: "calendar:provider",
      label: "Calendar provider",
      message: "Microsoft, Google or connect-later must be set neutrally per workspace/page.",
      passed: provider === "microsoft" || provider === "google" || provider === "none",
    }),
    buildCheck({
      id: "calendar:connected",
      label: "Provider connected",
      message: "A connected provider is required before live booking sync.",
      passed: provider === "microsoft" || provider === "google",
      required: false,
    }),
    buildCheck({
      id: "calendar:availability",
      label: "Availability",
      message: "Availability windows should be configured.",
      passed: Object.keys(availability).length > 0,
      required: false,
    }),
    buildCheck({
      id: "calendar:meeting_link",
      label: "Meeting link",
      message: "Meeting link/provider should be available before publishing a booking page.",
      passed: Boolean(text(payload.meetingProvider) || text(payload.meetingLink) || text(integrations.meetingProvider)),
      required: false,
    }),
    buildCheck({
      id: "calendar:reminders",
      label: "Reminders",
      message: "Reminder configuration should be reviewed.",
      passed: Array.isArray(reminders) ? reminders.length > 0 : Boolean(reminders),
      required: false,
    }),
  ];
}

async function countApprovedKnowledgeSources(input: {
  projectId: string | null;
  session: AppSession;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId)) return 0;

  const row = await queryOne<{ count: number | string }>(
    `
      select count(*) as count
      from knowledge_sources
      where workspace_id = $1
        and status = 'approved'
        and ($2::uuid is null or project_id is null or project_id = $2::uuid)
    `,
    [input.session.workspaceId, input.projectId],
  );

  return Number(row?.count ?? 0);
}

function toEditorPreflightRun(row: EditorPreflightRunRow): EditorPreflightRun {
  return {
    blockers: row.blockers ?? [],
    checks: row.checks ?? [],
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    editorType: row.editorType,
    entityId: row.entityId ?? undefined,
    id: row.id,
    metadata: row.metadata ?? undefined,
    projectId: row.projectId ?? undefined,
    status: row.status,
    warnings: row.warnings ?? [],
    workspaceId: row.workspaceId,
  };
}

function normalizeUuid(value: unknown) {
  return typeof value === "string" && isUuid(value) ? value : null;
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
