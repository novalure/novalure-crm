import { hasDatabaseUrl, queryOne, queryRows } from "@/lib/db/client";

export const crmAnalyticsEventTypes = [
  "lead_created",
  "first_response",
  "funnel_submit",
  "booking_created",
  "deal_stage_changed",
  "deal_lost",
  "deal_won",
  "newsletter_event",
] as const;

export type CrmAnalyticsEventType = (typeof crmAnalyticsEventTypes)[number];

export type CrmAnalyticsModule =
  | "bot"
  | "contact"
  | "dashboard"
  | "funnel"
  | "lead_inbox"
  | "meeting"
  | "newsletter"
  | "pipeline"
  | "task";

export type CrmAnalyticsEvent = {
  channel?: string;
  contactId?: string;
  dealId?: string;
  entityId?: string;
  entityType?: string;
  eventType: string;
  funnelId?: string;
  id: string;
  leadId?: string;
  metadata: Record<string, unknown>;
  module?: CrmAnalyticsModule | string;
  occurredAt: string;
  projectId?: string;
  source?: string;
  userId?: string;
  valueCents: number;
  workspaceId: string;
};

type AnalyticsEventRow = {
  channel: string | null;
  contactId: string | null;
  dealId: string | null;
  entityId: string | null;
  entityType: string | null;
  eventType: string;
  funnelId: string | null;
  id: string;
  leadId: string | null;
  metadata: unknown;
  module: string | null;
  occurredAt: string | Date;
  projectId: string | null;
  source: string | null;
  userId: string | null;
  valueCents: number | string;
  workspaceId: string;
};

type IdRow = { id: string };

export async function writeCrmAnalyticsEvent(input: {
  channel?: string | null;
  contactId?: string | null;
  dealId?: string | null;
  entityId?: string | null;
  entityType?: string | null;
  eventType: CrmAnalyticsEventType | string;
  funnelId?: string | null;
  leadId?: string | null;
  metadata?: unknown;
  module?: CrmAnalyticsModule | string | null;
  occurredAt?: string | Date | null;
  projectId?: string | null;
  source?: string | null;
  userId?: string | null;
  valueCents?: number | string | null;
  workspaceId?: string | null;
}) {
  if (!hasDatabaseUrl() || !isUuid(input.workspaceId)) return null;

  const metadata = asObject(input.metadata);
  const occurredAt = normalizeDateTime(input.occurredAt) || new Date().toISOString();
  const eventType = cleanString(input.eventType);
  if (!eventType) return null;

  const entityId = normalizeUuid(input.entityId);
  const entityType = cleanString(input.entityType) || inferEntityType(input);
  const eventModule = cleanString(input.module) || inferEventModule(eventType, entityType);
  const valueCents = normalizeInteger(input.valueCents);

  try {
    const row = await queryOne<IdRow>(
      `
        insert into analytics_events (
          workspace_id,
          project_id,
          entity_id,
          entity_type,
          user_id,
          contact_id,
          lead_id,
          deal_id,
          funnel_id,
          event_type,
          module,
          source,
          channel,
          value_cents,
          occurred_at,
          metadata
        )
        values (
          $1,
          $2::uuid,
          $3::uuid,
          $4,
          $5::uuid,
          $6::uuid,
          $7::uuid,
          $8::uuid,
          $9::uuid,
          $10,
          $11,
          $12,
          $13,
          $14,
          $15::timestamptz,
          $16::jsonb
        )
        returning id
      `,
      [
        input.workspaceId,
        normalizeUuid(input.projectId),
        entityId,
        entityType || null,
        normalizeUuid(input.userId),
        normalizeUuid(input.contactId),
        normalizeUuid(input.leadId),
        normalizeUuid(input.dealId),
        normalizeUuid(input.funnelId),
        eventType,
        eventModule || null,
        cleanString(input.source) || null,
        cleanString(input.channel) || null,
        valueCents,
        occurredAt,
        JSON.stringify({
          ...metadata,
          analyticsVersion: 1,
          entityId: entityId ?? metadata.entityId ?? null,
          entityType: entityType || metadata.entityType || null,
        }),
      ],
    );

    return row?.id ?? null;
  } catch {
    return null;
  }
}

export async function listCrmAnalyticsEvents(input: {
  eventTypes?: string[];
  from?: string | Date | null;
  limit?: number;
  module?: string | null;
  projectId?: string | null;
  source?: string | null;
  to?: string | Date | null;
  workspaceId?: string | null;
}): Promise<CrmAnalyticsEvent[]> {
  if (!hasDatabaseUrl() || !isUuid(input.workspaceId)) return [];

  const params: unknown[] = [input.workspaceId];
  const where = ["workspace_id = $1"];
  const projectId = normalizeUuid(input.projectId);
  if (projectId) {
    where.push(`project_id = ${addParam(params, projectId)}::uuid`);
  }

  const eventTypes = Array.from(new Set((input.eventTypes ?? []).map(cleanString).filter(Boolean)));
  if (eventTypes.length) {
    where.push(`event_type = any(${addParam(params, eventTypes)}::text[])`);
  }

  const eventModule = cleanString(input.module);
  if (eventModule) {
    where.push(`module = ${addParam(params, eventModule)}`);
  }

  const source = cleanString(input.source);
  if (source) {
    where.push(`source = ${addParam(params, source)}`);
  }

  const from = normalizeDateTime(input.from);
  if (from) {
    where.push(`occurred_at >= ${addParam(params, from)}::timestamptz`);
  }

  const to = normalizeDateTime(input.to);
  if (to) {
    where.push(`occurred_at <= ${addParam(params, to)}::timestamptz`);
  }

  const parsedLimit = Number(input.limit ?? 100);
  const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 500)) : 100;
  const limitSql = addParam(params, limit);
  const rows = await queryRows<AnalyticsEventRow>(
    `
      select
        id,
        workspace_id as "workspaceId",
        project_id as "projectId",
        entity_id as "entityId",
        entity_type as "entityType",
        user_id as "userId",
        contact_id as "contactId",
        lead_id as "leadId",
        deal_id as "dealId",
        funnel_id as "funnelId",
        event_type as "eventType",
        module,
        source,
        channel,
        value_cents as "valueCents",
        occurred_at as "occurredAt",
        metadata
      from analytics_events
      where ${where.join(" and ")}
      order by occurred_at desc
      limit ${limitSql}
    `,
    params,
  );

  return rows.map(toCrmAnalyticsEvent);
}

function addParam(params: unknown[], value: unknown) {
  params.push(value);
  return `$${params.length}`;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function cleanString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function inferEntityType(input: {
  contactId?: string | null;
  dealId?: string | null;
  entityId?: string | null;
  funnelId?: string | null;
  leadId?: string | null;
}) {
  if (normalizeUuid(input.dealId)) return "deal";
  if (normalizeUuid(input.leadId)) return "lead";
  if (normalizeUuid(input.contactId)) return "contact";
  if (normalizeUuid(input.funnelId)) return "funnel";
  return normalizeUuid(input.entityId) ? "crm_entity" : "";
}

function inferEventModule(eventType: string, entityType: string) {
  if (eventType === "booking_created" || eventType.startsWith("meeting_")) return "meeting";
  if (eventType === "funnel_submit" || eventType.startsWith("funnel_")) return "funnel";
  if (eventType === "newsletter_event" || eventType.startsWith("newsletter_")) return "newsletter";
  if (eventType.startsWith("deal_") || entityType === "deal") return "pipeline";
  if (eventType === "lead_created" || eventType === "first_response" || entityType === "lead") return "lead_inbox";
  if (eventType.startsWith("dashboard_")) return "dashboard";
  if (eventType.startsWith("task_")) return "task";
  if (eventType.startsWith("bot_")) return "bot";
  if (entityType === "contact") return "contact";
  return "";
}

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizeDateTime(value: unknown) {
  if (!value) return "";
  const raw = value instanceof Date ? value.toISOString() : String(value);
  const parsed = new Date(raw);

  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

function normalizeInteger(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

function normalizeUuid(value: unknown) {
  return isUuid(value) ? value : null;
}

function toCrmAnalyticsEvent(row: AnalyticsEventRow): CrmAnalyticsEvent {
  return {
    channel: row.channel ?? undefined,
    contactId: row.contactId ?? undefined,
    dealId: row.dealId ?? undefined,
    entityId: row.entityId ?? undefined,
    entityType: row.entityType ?? undefined,
    eventType: row.eventType,
    funnelId: row.funnelId ?? undefined,
    id: row.id,
    leadId: row.leadId ?? undefined,
    metadata: asObject(row.metadata),
    module: row.module ?? undefined,
    occurredAt: row.occurredAt instanceof Date ? row.occurredAt.toISOString() : String(row.occurredAt),
    projectId: row.projectId ?? undefined,
    source: row.source ?? undefined,
    userId: row.userId ?? undefined,
    valueCents: Number(row.valueCents ?? 0),
    workspaceId: row.workspaceId,
  };
}
