import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/session";
import {
  createMeetingBookingWithNotifications,
  listMeetingBookingOverview,
} from "@/lib/db/meeting-repositories";
import { processDueMeetingNotifications } from "@/lib/meetings/notification-runner";

function getFormValue(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

function getLimit(url: URL) {
  const limit = Number(url.searchParams.get("limit") ?? 50);
  return Number.isFinite(limit) ? Math.max(1, Math.min(100, limit)) : 50;
}

function resolveCalendarProvider(formData: FormData) {
  const calendarProvider = getFormValue(formData, "calendar");
  const meetingProvider = getFormValue(formData, "meeting");

  if (calendarProvider === "microsoft" || calendarProvider === "google") return calendarProvider;
  if (meetingProvider === "microsoft-teams") return "microsoft";
  if (meetingProvider === "google-meet") return "google";
  return "none";
}

function resolveMeetingProvider(formData: FormData) {
  const meetingProvider = getFormValue(formData, "meeting");
  const calendarProvider = getFormValue(formData, "calendar");

  if (meetingProvider === "microsoft-teams" || meetingProvider === "google-meet" || meetingProvider === "manual-link") {
    return meetingProvider;
  }

  if (calendarProvider === "microsoft") return "microsoft-teams";
  if (calendarProvider === "google") return "google-meet";
  return "manual-link";
}

export async function GET(request: Request) {
  const auth = await requirePermission(request, "crm:read");
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const payload = await listMeetingBookingOverview({
    limit: getLimit(url),
    session: auth.session,
  });

  return NextResponse.json(payload);
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const slug = getFormValue(formData, "slug");
  const redirectUrl = new URL(`/book/${slug || "pipeline-audit"}`, request.url);

  const result = await createMeetingBookingWithNotifications({
    calendarProvider: resolveCalendarProvider(formData),
    contactEmail: getFormValue(formData, "email"),
    contactName: getFormValue(formData, "name"),
    contactNote: getFormValue(formData, "note"),
    meetingProvider: resolveMeetingProvider(formData),
    requestUrl: request.url,
    selectedDate: getFormValue(formData, "selectedDate") || "2026-05-20",
    slot: getFormValue(formData, "slot") || "10:00",
    slug,
    source: getFormValue(formData, "utm_source") || "booking_page",
  });

  if (!result.persisted) {
    redirectUrl.searchParams.set("submitted", "0");
    redirectUrl.searchParams.set("error", result.reason || "booking_failed");
    redirectUrl.searchParams.set("date", getFormValue(formData, "selectedDate"));
    return NextResponse.redirect(redirectUrl, 303);
  }

  const processed = result.finalConfirmationJobId
    ? await processDueMeetingNotifications({ jobIds: [result.finalConfirmationJobId] })
    : { checked: 0, failed: 0, sent: 0 };

  redirectUrl.searchParams.set("submitted", "1");
  redirectUrl.searchParams.set("booking", result.bookingId || "");
  redirectUrl.searchParams.set("confirmed", result.autoConfirmed ? "1" : "0");
  redirectUrl.searchParams.set("date", getFormValue(formData, "selectedDate"));
  redirectUrl.searchParams.set("meeting_link", result.onlineMeetingUrl ? "1" : "0");
  redirectUrl.searchParams.set("queued", String(result.jobsQueued ?? 0));
  redirectUrl.searchParams.set("sent", String(processed.sent));

  return NextResponse.redirect(redirectUrl, 303);
}
