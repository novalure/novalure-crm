import { NextResponse } from "next/server";
import { requirePermissionAndProductCapability } from "@/lib/auth/session";
import { getTrustedAppOrigin } from "@/lib/auth/app-origin";
import { BookingConnectionError, bookingMicrosoftAuthority, createBookingOAuthState } from "@/lib/booking/connections";
import { getOAuthAuthorizationUrl } from "@/lib/integrations/calendar-connections";

export async function GET(request:Request,context:{params:Promise<{provider:string}>}) {
  const auth = await requirePermissionAndProductCapability(request,"crm:write","calendar:manage");
  if (!auth.ok) return auth.response;
  const requestedWorkspace = new URL(request.url).searchParams.get("workspaceId");
  if (requestedWorkspace && requestedWorkspace !== auth.session.workspaceId)
    return Response.json({error:"calendar_scope_forbidden"},{status:403,headers:{"cache-control":"private, no-store"}});
  const {provider} = await context.params;
  if (provider !== "google" && provider !== "microsoft") return Response.json({error:"calendar_provider_invalid"},{status:400});
  try {
    const {state,codeChallenge} = await createBookingOAuthState({workspaceId:auth.session.workspaceId,actorId:auth.session.userId},provider);
    const trustedOrigin = getTrustedAppOrigin();
    return NextResponse.redirect(getOAuthAuthorizationUrl({provider,state,codeChallenge,requestUrl:trustedOrigin,
      trustedOrigin,...(provider === "microsoft" ? {microsoftAuthority:bookingMicrosoftAuthority()} : {})}));
  } catch (error) {
    return Response.json({error:error instanceof BookingConnectionError ? error.code : "calendar_oauth_unavailable"},
      {status:error instanceof BookingConnectionError ? error.status : 503,headers:{"cache-control":"private, no-store"}});
  }
}
