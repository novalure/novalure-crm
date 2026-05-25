import { writeCrmAnalyticsEvent } from "@/lib/db/analytics-event-repositories";
import { hasDatabaseUrl, queryOne } from "@/lib/db/client";

type IdRow = { id: string };
type SpeedToLeadState = "covered" | "dueSoon" | "overdue";

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizeState(value: unknown): SpeedToLeadState {
  if (value === "dueSoon" || value === "overdue") return value;
  return "covered";
}

function normalizeDateTime(value: unknown) {
  if (!value) return null;
  const parsed = new Date(value instanceof Date ? value.toISOString() : String(value));

  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function minutesUntil(value: string | null) {
  if (!value) return 0;
  const diff = new Date(value).getTime() - Date.now();

  return Number.isFinite(diff) ? Math.round(diff / 60000) : 0;
}

export async function recordSpeedToLeadEvent(input: {
  analyticsEventType?: string;
  channel?: string | null;
  contactId?: string | null;
  dueAt?: string | Date | null;
  firstResponseAt?: string | Date | null;
  leadId?: string | null;
  metadata?: Record<string, unknown>;
  notificationChannel?: string | null;
  ownerUserId?: string | null;
  projectId?: string | null;
  source?: string | null;
  state?: SpeedToLeadState | string | null;
  userId?: string | null;
  workspaceId?: string | null;
}) {
  if (!hasDatabaseUrl() || !isUuid(input.workspaceId)) return null;

  const dueAt = normalizeDateTime(input.dueAt);
  const firstResponseAt = normalizeDateTime(input.firstResponseAt);
  const state = normalizeState(input.state);
  const metadata = {
    ...(input.metadata ?? {}),
    analyticsEventType: input.analyticsEventType ?? null,
    source: input.source ?? null,
  };

  let speedEventId: string | null = null;
  try {
    const row = await queryOne<IdRow>(
      `
        insert into speed_to_lead_events (
          workspace_id,
          project_id,
          lead_id,
          contact_id,
          owner_user_id,
          state,
          due_at,
          first_response_at,
          minutes_until_due,
          notification_channel,
          metadata
        )
        values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7::timestamptz, $8::timestamptz, $9, $10, $11::jsonb)
        returning id
      `,
      [
        input.workspaceId,
        isUuid(input.projectId) ? input.projectId : null,
        isUuid(input.leadId) ? input.leadId : null,
        isUuid(input.contactId) ? input.contactId : null,
        isUuid(input.ownerUserId) ? input.ownerUserId : null,
        state,
        dueAt,
        firstResponseAt,
        minutesUntil(dueAt),
        input.notificationChannel || "teams",
        JSON.stringify(metadata),
      ],
    );
    speedEventId = row?.id ?? null;
  } catch {
    return null;
  }

  if (input.analyticsEventType) {
    await writeCrmAnalyticsEvent({
      channel: input.channel ?? input.source ?? null,
      contactId: input.contactId,
      entityId: input.leadId ?? input.contactId ?? speedEventId,
      entityType: input.leadId ? "lead" : "speed_to_lead_event",
      eventType: input.analyticsEventType,
      leadId: input.leadId,
      metadata: {
        ...metadata,
        dueAt,
        firstResponseAt,
        speedToLeadEventId: speedEventId,
        state,
      },
      module: "lead_inbox",
      projectId: input.projectId,
      source: input.source,
      userId: input.userId,
      workspaceId: input.workspaceId,
    });
  }

  return speedEventId;
}
