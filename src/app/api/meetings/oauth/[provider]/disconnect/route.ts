import { NextResponse } from "next/server";
import { requirePermissionAndProductCapability } from "@/lib/auth/session";
import {
  disconnectCalendarOAuthConnection,
  type CalendarOAuthProvider,
} from "@/lib/integrations/calendar-connections";
import { evaluateLaunchScope } from "@/lib/launch-scope";

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

  const launchScope = evaluateLaunchScope("calendarProviderMutation");
  if (!launchScope.allowed) {
    return NextResponse.json(
      { code: launchScope.code, error: "calendar_provider_mutation_launch_off", ok: false },
      { headers: { "Cache-Control": "private, no-store" }, status: 503 },
    );
  }

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
