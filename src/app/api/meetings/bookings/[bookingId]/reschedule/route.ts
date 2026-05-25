import { NextResponse } from "next/server";
import { reschedulePublicMeetingBooking } from "@/lib/db/meeting-repositories";
import { processDueMeetingNotifications } from "@/lib/meetings/notification-runner";

type RouteContext = {
  params: Promise<{ bookingId: string }>;
};

function getFormValue(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

function getRedirectUrl(request: Request, slug: string, params: Record<string, string>) {
  const url = new URL(`/book/${slug || "meeting"}`, request.url);
  Object.entries(params).forEach(([key, value]) => {
    if (value) url.searchParams.set(key, value);
  });
  return url;
}

export async function POST(request: Request, context: RouteContext) {
  const { bookingId } = await context.params;
  const formData = await request.formData();
  const token = getFormValue(formData, "token");
  const slug = getFormValue(formData, "slug");
  const selectedDate = getFormValue(formData, "selectedDate");
  const slot = getFormValue(formData, "slot");

  const result = await reschedulePublicMeetingBooking({
    bookingId,
    requestUrl: request.url,
    selectedDate,
    slot,
    token,
  });
  if (result.ok && result.notificationJobId) {
    await processDueMeetingNotifications({ jobIds: [result.notificationJobId] });
  }

  const redirectUrl = getRedirectUrl(request, result.booking?.pageSlug || slug, {
    booking: bookingId,
    date: result.ok ? selectedDate : "",
    error: result.ok ? "" : result.error || "reschedule_failed",
    reschedule: result.ok ? "" : "1",
    rescheduled: result.ok ? "1" : "",
    token,
  });

  return NextResponse.redirect(redirectUrl, 303);
}
