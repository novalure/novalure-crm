import { NextResponse } from "next/server";
import { requirePermissionAndProductCapability } from "@/lib/auth/session";
import { getCalendarConnectionStatus } from "@/lib/integrations/calendar-connections";

export async function GET(request: Request) {
  const auth = await requirePermissionAndProductCapability(request, "calendar:sync", "calendar:manage");
  if (!auth.ok) return auth.response;

  const [microsoft, google] = await Promise.all([
    getCalendarConnectionStatus(auth.session.workspaceId, "microsoft"),
    getCalendarConnectionStatus(auth.session.workspaceId, "google"),
  ]);

  return NextResponse.json({ google, microsoft });
}
