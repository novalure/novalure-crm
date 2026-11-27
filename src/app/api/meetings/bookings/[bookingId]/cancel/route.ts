import {getTrustedAppOrigin} from "@/lib/auth/app-origin";
import {isWebExposeOriginAllowed} from "@/lib/web-expose-http";
import {readCustomerRequestBody} from "@/lib/lead-customer-request-http";
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

function getRedirectUrl(input: { slug: string; workspacePublicKey?: string | null }, params: Record<string, string>) {
  const path = input.workspacePublicKey
    ? buildPublicMeetingPath({ slug: input.slug || "meeting", workspacePublicKey: input.workspacePublicKey })
    : `/book/${input.slug || "meeting"}`;
  const url = new URL(path, getTrustedAppOrigin());
  Object.entries(params).forEach(([key, value]) => {
    if (value) url.searchParams.set(key, value);
  });
  return url;
}

export async function POST(request: Request, context: RouteContext) {
  if(!isWebExposeOriginAllowed(request,getTrustedAppOrigin()))return NextResponse.json({error:"origin_denied"},{status:403,headers:{"Cache-Control":"private, no-store"}});
  const { bookingId } = await context.params;
  let formData:FormData;try{const bytes=await readCustomerRequestBody(request,20000);formData=await new Response(bytes,{headers:{"Content-Type":request.headers.get("content-type")??"application/x-www-form-urlencoded"}}).formData();}catch{return NextResponse.json({error:"invalid_request"},{status:400});}
  const token = getFormValue(formData, "token");
  const language=getFormValue(formData,"lang");
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

  const redirectUrl = getRedirectUrl({
    slug: result.booking?.pageSlug || slug,
    workspacePublicKey: result.booking?.workspacePublicKey || workspacePublicKey,
  }, {
    booking: bookingId,
    lang:["de","en","es"].includes(language)?language:"",
    cancel: result.ok ? "" : "1",
    cancelled: result.ok ? "1" : "",
    error: result.ok ? "" : result.error || "cancel_failed",
    token,
  });

  return NextResponse.redirect(redirectUrl, 303);
}
