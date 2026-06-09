import { NextResponse } from "next/server";
import { cancelPublicMeetingBooking } from "@/lib/db/meeting-repositories";
import { processDueMeetingNotifications } from "@/lib/meetings/notification-runner";
import { buildPublicMeetingPath } from "@/lib/public-routing";

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
  const { bookingId } = await context.params;
  const formData = await request.formData();
  const token = getFormValue(formData, "token");
  const slug = getFormValue(formData, "slug");
  const workspacePublicKey = getFormValue(formData, "workspace_public_key");
  const reason = getFormValue(formData, "reason");

  const result = await cancelPublicMeetingBooking({
    bookingId,
    reason,
    requestUrl: request.url,
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
    cancel: result.ok ? "" : "1",
    cancelled: result.ok ? "1" : "",
    error: result.ok ? "" : result.error || "cancel_failed",
    token,
  });

  return NextResponse.redirect(redirectUrl, 303);
}
