import { requirePermissionAndProductCapability } from "@/lib/auth/session";
import {
  insertCalendarSyncEvent,
  listCalendarSyncEvents,
  upsertProviderConnection,
  writeAuditLog,
} from "@/lib/db/runtime-repositories";
import { getApiSystemCopy, resolveRequestLanguage } from "@/lib/i18n";
import {
  getMicrosoftCalendarProviderStatus,
  syncMicrosoftCalendarEvent,
} from "@/lib/integrations/microsoft-calendar";

export const maxDuration = 60;

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function getLimit(url: URL) {
  const limit = Number(url.searchParams.get("limit") ?? 25);

  return Number.isFinite(limit) ? Math.max(1, Math.min(100, limit)) : 25;
}

export async function GET(request: Request) {
  const auth = await requirePermissionAndProductCapability(request, "calendar:sync", "calendar:manage");

  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const provider = getMicrosoftCalendarProviderStatus();
  const syncEvents = await listCalendarSyncEvents({
    session: auth.session,
    limit: getLimit(url),
    status: url.searchParams.get("status"),
  });
  const providerConnection = await upsertProviderConnection({
    session: auth.session,
    provider: "microsoft-365",
    status: provider.configured ? "connected" : "not_configured",
    accountLabel: provider.accountLabel,
    scopes: provider.scopes,
    config: {
      mode: provider.mode,
      external: provider.external,
    },
  });

  return Response.json({
    source: "database",
    provider,
    providerConnection,
    counts: {
      syncEvents: syncEvents.length,
      synced: syncEvents.filter((event) => event.status === "synced").length,
      pending: syncEvents.filter((event) => event.status === "pending").length,
      failed: syncEvents.filter((event) => event.status === "failed").length,
    },
    syncEvents,
  });
}

export async function POST(request: Request) {
  const language = resolveRequestLanguage(request);
  const copy = getApiSystemCopy(language);
  const auth = await requirePermissionAndProductCapability(request, "calendar:sync", "calendar:manage");

  if (!auth.ok) return auth.response;

  const body = await readJson(request);

  if (!body || typeof body !== "object") {
    return Response.json({ error: copy.invalidJson }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const subject = String(input.subject ?? "").trim();
  const startsAt = String(input.startsAt ?? "").trim();
  const endsAt = String(input.endsAt ?? "").trim();

  if (!subject || !startsAt || !endsAt) {
    return Response.json({ error: copy.calendarEventRequired }, { status: 400 });
  }

  const provider = getMicrosoftCalendarProviderStatus();
  const result = await syncMicrosoftCalendarEvent({
    subject,
    startsAt,
    endsAt,
    body: typeof input.body === "string" ? input.body : undefined,
    createOnlineMeeting: input.createOnlineMeeting === true,
    location: typeof input.location === "string" ? input.location : undefined,
    attendees: Array.isArray(input.attendees) ? input.attendees.map(String) : undefined,
    workspaceId: auth.session.workspaceId,
  });
  const syncId = await insertCalendarSyncEvent({
    session: auth.session,
    calendarEventId: typeof input.calendarEventId === "string" ? input.calendarEventId : null,
    provider: result.provider,
    providerEventId: result.eventId ?? null,
    operation: "create_event",
    status: result.status,
    payload: {
      subject,
      startsAt,
      endsAt,
      attendees: input.attendees ?? [],
      createOnlineMeeting: input.createOnlineMeeting === true,
      onlineMeetingUrl: result.onlineMeetingUrl ?? null,
      webLink: result.webLink ?? null,
    },
    error: result.error ?? null,
  });
  const connectionStatus =
    !provider.configured ? "not_configured" : result.status === "failed" ? "failed" : "connected";
  const providerConnection = await upsertProviderConnection({
    session: auth.session,
    provider: "microsoft-365",
    status: connectionStatus,
    accountLabel: provider.accountLabel,
    scopes: provider.scopes,
    config: {
      mode: provider.mode,
      lastStatus: result.status,
    },
  });

  await writeAuditLog({
    session: auth.session,
    action: "calendar.microsoft.sync_requested",
    entityType: "calendar_sync_event",
    entityId: syncId,
    after: { subject, status: result.status, provider: result.provider },
  });

  return Response.json({
    ok: result.status !== "failed",
    syncId,
    providerStatus: provider,
    providerConnection,
    persisted: Boolean(syncId),
    provider: result.provider,
    status: result.status,
    providerEventId: result.eventId ?? null,
    onlineMeetingUrl: result.onlineMeetingUrl ?? null,
    webLink: result.webLink ?? null,
    error: result.error ?? null,
  });
}
