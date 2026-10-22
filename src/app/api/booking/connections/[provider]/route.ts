import { requirePermissionAndProductCapability } from "@/lib/auth/session";
import { BookingConnectionError, disconnectBookingConnection, getBookingConnection, refreshBookingCalendars, selectBookingCalendars,
  type BookingProvider } from "@/lib/booking/connections";

type Context = {params:Promise<{provider:string}>};
async function selectionInput(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new BookingConnectionError("calendar_selection_invalid",400);
  const chunks: Uint8Array[] = []; let bytes=0;
  for (;;) {
    const part = await reader.read(); if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes>16_384) { await reader.cancel(); throw new BookingConnectionError("calendar_selection_invalid",413); }
    chunks.push(part.value);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string,unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      Object.keys(parsed).some(key => !["writeCalendarId","conflictCalendarIds"].includes(key))) throw new Error("invalid");
    return parsed as {writeCalendarId:string;conflictCalendarIds:string[]};
  } catch { throw new BookingConnectionError("calendar_selection_invalid",400); }
}
async function handle(request: Request,context:Context) {
  const auth = await requirePermissionAndProductCapability(request,"crm:write","calendar:manage");
  if (!auth.ok) return auth.response;
  const requestedWorkspace = new URL(request.url).searchParams.get("workspaceId");
  if (requestedWorkspace && requestedWorkspace !== auth.session.workspaceId)
    return Response.json({error:"calendar_scope_forbidden"},{status:403,headers:{"cache-control":"private, no-store"}});
  const {provider} = await context.params;
  if (provider !== "google" && provider !== "microsoft") return Response.json({error:"calendar_provider_invalid"},{status:400});
  const scope = {workspaceId:auth.session.workspaceId,actorId:auth.session.userId};
  try {
    let body: unknown;
    if (request.method === "DELETE") body = await disconnectBookingConnection(scope,provider as BookingProvider);
    else if (request.method === "PUT") {
      const input = await selectionInput(request);
      body = {connection:await selectBookingCalendars(scope,provider,input)};
    } else if (request.method === "POST") body = {connection:(await refreshBookingCalendars(scope,provider)).connection};
    else body = {connection:await getBookingConnection(scope,provider)};
    return Response.json(body,{headers:{"cache-control":"private, no-store"}});
  } catch (error) {
    return Response.json({error:error instanceof BookingConnectionError ? error.code : "calendar_unavailable"},
      {status:error instanceof BookingConnectionError ? error.status : 503,headers:{"cache-control":"private, no-store"}});
  }
}
export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
