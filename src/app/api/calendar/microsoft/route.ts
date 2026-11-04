import { requirePermissionAndProductCapability } from "@/lib/auth/session";
import {
  listCalendarSyncEvents,
  upsertProviderConnection,
} from "@/lib/db/runtime-repositories";
import {
  getMicrosoftCalendarProviderStatus,
} from "@/lib/integrations/microsoft-calendar";

export const maxDuration = 60;

function getLimit(url: URL) {
  const limit = Number(url.searchParams.get("limit") ?? 25);

  return Number.isFinite(limit) ? Math.max(1, Math.min(100, limit)) : 25;
}

export async function GET(request: Request) {
  const auth = await requirePermissionAndProductCapability(request, "calendar:sync", "calendar:manage");

  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const provider = getMicrosoftCalendarProviderStatus();
  const syncEvents = await listCalendarSyncEvents({
    session: auth.session,
    limit: getLimit(url),
    status: url.searchParams.get("status"),
  });
  const providerConnection = await upsertProviderConnection({
    session: auth.session,
    provider: "microsoft-365",
    status: provider.configured ? "connected" : "not_configured",
    accountLabel: provider.accountLabel,
    scopes: provider.scopes,
    config: {
      mode: provider.mode,
      external: provider.external,
    },
  });

  return Response.json({
    source: "database",
    provider,
    providerConnection,
    counts: {
      syncEvents: syncEvents.length,
      synced: syncEvents.filter((event) => event.status === "synced").length,
      pending: syncEvents.filter((event) => event.status === "pending").length,
      failed: syncEvents.filter((event) => event.status === "failed").length,
    },
    syncEvents,
  });
}

// Unjournaled workspace-primary writes are retired. Existing booking services
// retain their own scoped operations; standalone events use the personal ledger.
export async function POST(request: Request) {
  const auth=await requirePermissionAndProductCapability(request,"calendar:sync","calendar:manage");
  if(!auth.ok)return auth.response;
  return Response.json({ok:false,status:"not_started",error:"personal_calendar_workflow_required"},
    {status:409,headers:{"cache-control":"private, no-store"}});
}
