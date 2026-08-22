import { NextResponse } from "next/server";
import { reschedulePublicMeetingBooking } from "@/lib/db/meeting-repositories";
import { processDueMeetingNotifications } from "@/lib/meetings/notification-runner";
import { buildPublicMeetingPath } from "@/lib/public-routing";
import {
  publicBookingLifecycleLaunchOffCode,
  publicBookingLifecycleMutationsLaunchEnabled,
  resolveBookingCorrelationId,
} from "@/lib/meetings/booking-lifecycle";

type RouteContext = {
  params: Promise<{ bookingId: string }>;
};

function getFormValue(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

function getRedirectUrl(request: Request, input: { slug: string; workspacePublicKey?: string | null }, params: Record<string, string>) {
  const path = input.workspacePublicKey
    ? buildPublicMeetingPath({ slug: input.slug || "meeting", workspacePublicKey: input.workspacePublicKey })
    : `/book/${input.slug || "meeting"}`;
  const url = new URL(path, request.url);
  Object.entries(params).forEach(([key, value]) => {
    if (value) url.searchParams.set(key, value);
  });
  return url;
}

export async function POST(request: Request, context: RouteContext) {
  if (!publicBookingLifecycleMutationsLaunchEnabled) {
    return NextResponse.json(
      { code: publicBookingLifecycleLaunchOffCode, error: "public_action_launch_off", ok: false },
      {
        headers: { "cache-control": "private, no-store" },
        status: 503,
      },
    );
  }

  const { bookingId } = await context.params;
  const formData = await request.formData();
  const token = getFormValue(formData, "token");
  const slug = getFormValue(formData, "slug");
  const workspacePublicKey = getFormValue(formData, "workspace_public_key");
  const selectedDate = getFormValue(formData, "selectedDate");
  const slot = getFormValue(formData, "slot");
  const correlationId = resolveBookingCorrelationId(
    getFormValue(formData, "action_id") || request.headers.get("x-correlation-id"),
  );

  const result = await reschedulePublicMeetingBooking({
    bookingId,
    correlationId,
    requestUrl: request.url,
    selectedDate,
    slot,
    token,
  });
  if (result.ok && result.notificationJobId) {
    await processDueMeetingNotifications({ jobIds: [result.notificationJobId] });
  }

  const redirectUrl = getRedirectUrl(request, {
    slug: result.booking?.pageSlug || slug,
    workspacePublicKey: result.booking?.workspacePublicKey || workspacePublicKey,
  }, {
    booking: bookingId,
    date: result.ok ? selectedDate : "",
    error: result.ok ? "" : result.error || "reschedule_failed",
    lang: getFormValue(formData, "lang"),
    reschedule: result.ok ? "" : "1",
    rescheduled: result.ok ? "1" : "",
    token,
  });

  const response = NextResponse.redirect(redirectUrl, 303);
  response.headers.set("cache-control", "private, no-store");
  response.headers.set("x-correlation-id", result.correlationId ?? correlationId);
  return response;
}
