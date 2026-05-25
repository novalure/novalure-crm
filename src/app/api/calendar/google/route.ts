import { requirePermissionAndProductCapability } from "@/lib/auth/session";
import {
  insertCalendarSyncEvent,
  writeAuditLog,
} from "@/lib/db/runtime-repositories";
import { getApiSystemCopy, resolveRequestLanguage } from "@/lib/i18n";
import { syncGoogleCalendarEvent } from "@/lib/integrations/google-calendar";

export const maxDuration = 60;

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
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

  const result = await syncGoogleCalendarEvent({
    attendees: Array.isArray(input.attendees) ? input.attendees.map(String) : undefined,
    body: typeof input.body === "string" ? input.body : undefined,
    createOnlineMeeting: input.createOnlineMeeting === true,
    endsAt,
    location: typeof input.location === "string" ? input.location : undefined,
    startsAt,
    subject,
    workspaceId: auth.session.workspaceId,
  });
  const syncId = await insertCalendarSyncEvent({
    calendarEventId: typeof input.calendarEventId === "string" ? input.calendarEventId : null,
    error: result.error ?? null,
    operation: "create_event",
    payload: {
      attendees: input.attendees ?? [],
      createOnlineMeeting: input.createOnlineMeeting === true,
      onlineMeetingUrl: result.onlineMeetingUrl ?? null,
      startsAt,
      subject,
      webLink: result.webLink ?? null,
    },
    provider: result.provider,
    providerEventId: result.eventId ?? null,
    session: auth.session,
    status: result.status,
  });

  await writeAuditLog({
    action: "calendar.google.sync_requested",
    after: { provider: result.provider, status: result.status, subject },
    entityId: syncId,
    entityType: "calendar_sync_event",
    session: auth.session,
  });

  return Response.json({
    error: result.error ?? null,
    ok: result.status !== "failed",
    onlineMeetingUrl: result.onlineMeetingUrl ?? null,
    persisted: Boolean(syncId),
    provider: result.provider,
    providerEventId: result.eventId ?? null,
    status: result.status,
    syncId,
    webLink: result.webLink ?? null,
  });
}
