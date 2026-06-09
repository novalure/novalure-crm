import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/session";
import { evaluateBotAction, getBotRuntimeControls } from "@/lib/bots/policy";
import {
  createMeetingBookingWithNotifications,
  getMeetingPageSettings,
  getWorkspaceMeetingAvailability,
  listMeetingPageSettings,
  type MeetingPageSettings,
} from "@/lib/db/meeting-repositories";
import { createApprovalRequest, writeAuditLog } from "@/lib/db/runtime-repositories";

export const maxDuration = 60;

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

function getCalendarProvider(page: MeetingPageSettings | null) {
  const config = asRecord(page?.calendarIntegrations);
  return config.defaultProvider === "google" ? "google" : "microsoft";
}

function getMeetingProvider(page: MeetingPageSettings | null, calendarProvider: string) {
  const config = asRecord(page?.calendarIntegrations);
  const provider = typeof config.defaultMeetingProvider === "string" ? config.defaultMeetingProvider : "";
  if (["google-meet", "microsoft-teams", "manual-link", "phone"].includes(provider)) return provider;
  return calendarProvider === "google" ? "google-meet" : "microsoft-teams";
}

async function getMeetingSlots(input: { date?: string; session: Parameters<typeof listMeetingPageSettings>[0]["session"]; slug: string }) {
  const { date, session, slug } = input;
  if (!slug) return [];
  const availability = await getWorkspaceMeetingAvailability({ date, session, slug }).catch(() => null);
  return (
    availability?.slots
      .filter((slot) => slot.available)
      .map((slot) => ({
        date: availability.date,
        label: `${availability.date}, ${slot.time}`,
        value: slot.time,
      })) ?? []
  );
}

export async function GET(request: Request) {
  const auth = await requirePermission(request, "crm:read");
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const slug = url.searchParams.get("slug")?.trim() || "";
  const date = url.searchParams.get("date")?.trim() || undefined;
  const pages = await listMeetingPageSettings({ session: auth.session, limit: 50 });
  const resolvedSlug = slug || pages.pages[0]?.slug || "";
  const slots = await getMeetingSlots({ date, session: auth.session, slug: resolvedSlug });

  return NextResponse.json({
    pages: pages.pages,
    slots,
    source: pages.source,
  });
}

export async function POST(request: Request) {
  const auth = await requirePermission(request, "bots:run");
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const page = typeof input.slug === "string"
    ? await getMeetingPageSettings({ session: auth.session, slug: input.slug })
    : null;
  const calendarProvider = typeof input.calendarProvider === "string" ? input.calendarProvider : getCalendarProvider(page);
  const payload = {
    calendarProvider,
    contactEmail: typeof input.contactEmail === "string" ? input.contactEmail : "",
    contactName: typeof input.contactName === "string" ? input.contactName : "",
    contactNote: typeof input.contactNote === "string" ? input.contactNote : "",
    meetingProvider: typeof input.meetingProvider === "string" ? input.meetingProvider : getMeetingProvider(page, calendarProvider),
    selectedDate: typeof input.selectedDate === "string" ? input.selectedDate : "",
    slot: typeof input.slot === "string" ? input.slot : "",
    slug: typeof input.slug === "string" ? input.slug : "",
  };
  const controls = getBotRuntimeControls(input);
  const decision = evaluateBotAction({
    action: "meeting_book",
    controls,
    meeting: payload,
    risk: "high",
  });

  if (decision.reason === "kill_switch_active") {
    await writeAuditLog({
      session: auth.session,
      action: "bot.meeting_booking.policy_decision",
      entityType: "bot_meeting_booking",
      after: { decision, payload },
    });

    return NextResponse.json({ decision, payload, status: "blocked" }, { status: 409 });
  }

  if (controls.requireHumanApproval) {
    const approvalId = await createApprovalRequest({
      session: auth.session,
      projectId: typeof input.projectId === "string" ? input.projectId : null,
      entityType: "bot_meeting_booking",
      entityId: null,
      action: "bot.meeting_booking.approve",
      summary: `Terminbuchung freigeben: ${payload.contactName || "Kontakt"}`,
      payload,
    });

    await writeAuditLog({
      session: auth.session,
      action: "bot.meeting_booking.requested",
      entityType: "bot_meeting_booking",
      after: { approvalId, payload },
    });

    return NextResponse.json({ approvalId, payload, status: "approval_required" });
  }

  if (!decision.allowed || decision.mode === "test") {
    await writeAuditLog({
      session: auth.session,
      action: "bot.meeting_booking.policy_decision",
      entityType: "bot_meeting_booking",
      after: { decision, payload },
    });

    return NextResponse.json({
      decision,
      payload,
      slots: await getMeetingSlots({ date: payload.selectedDate, session: auth.session, slug: payload.slug }),
      status: decision.mode === "test" ? "test" : "blocked",
    }, { status: decision.mode === "block" ? 409 : 202 });
  }

  const result = await createMeetingBookingWithNotifications({
    ...payload,
    requestUrl: request.url,
    session: auth.session,
    source: "bot_autonomy",
  });

  await writeAuditLog({
    session: auth.session,
    action: result.persisted ? "bot.meeting_booking.created" : "bot.meeting_booking.failed",
    entityType: "meeting_booking",
    entityId: result.bookingId ?? null,
    after: { decision, payload, result },
  });

  return NextResponse.json(result, { status: result.persisted ? 201 : 503 });
}
