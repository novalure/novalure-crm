import { NextResponse } from "next/server";
import { requirePermissionAndProductCapability } from "@/lib/auth/session";
import {
  disconnectCalendarOAuthConnection,
  type CalendarOAuthProvider,
} from "@/lib/integrations/calendar-connections";

type RouteContext = {
  params: Promise<{ provider: string }>;
};

function getProvider(value: string): CalendarOAuthProvider | null {
  if (value === "google" || value === "microsoft") return value;
  return null;
}

export async function POST(request: Request, context: RouteContext) {
  const auth = await requirePermissionAndProductCapability(request, "calendar:sync", "calendar:manage");
  if (!auth.ok) return auth.response;

  const { provider: providerParam } = await context.params;
  const provider = getProvider(providerParam);
  if (!provider) {
    return NextResponse.json({ error: "Unsupported calendar provider" }, { status: 400 });
  }

  const result = await disconnectCalendarOAuthConnection({
    provider,
    workspaceId: auth.session.workspaceId,
  });

  return NextResponse.json({
    ok: result.ok,
    provider,
    reason: result.reason ?? null,
  });
}
