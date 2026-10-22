import { requirePermissionAndProductCapability } from "@/lib/auth/session";
import { BookingConnectionError, listBookingConnections } from "@/lib/booking/connections";
import { bookingOAuthReadiness, bookingRuntimeMode } from "@/lib/booking/runtime";

export async function GET(request: Request) {
  const auth = await requirePermissionAndProductCapability(request,"crm:write","calendar:manage");
  if (!auth.ok) return auth.response;
  const requestedWorkspace = new URL(request.url).searchParams.get("workspaceId");
  if (requestedWorkspace && requestedWorkspace !== auth.session.workspaceId)
    return Response.json({error:"calendar_scope_forbidden"},{status:403,headers:{"cache-control":"private, no-store"}});
  try {
    return Response.json({connections:await listBookingConnections({workspaceId:auth.session.workspaceId,actorId:auth.session.userId}),
      runtime:{mode:bookingRuntimeMode(),providers:{microsoft:bookingOAuthReadiness("microsoft"),google:bookingOAuthReadiness("google")}}},
      {headers:{"cache-control":"private, no-store"}});
  } catch (error) {
    return Response.json({error:error instanceof BookingConnectionError ? error.code : "calendar_unavailable"},
      {status:error instanceof BookingConnectionError ? error.status : 503,headers:{"cache-control":"private, no-store"}});
  }
}
