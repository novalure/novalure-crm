import { NextResponse } from "next/server";
import { getTrustedAppOrigin } from "@/lib/auth/app-origin";
import { requirePermissionAndProductCapability } from "@/lib/auth/session";
import {
  createOAuthState,
  getOAuthAuthorizationUrl,
  type CalendarOAuthProvider,
} from "@/lib/integrations/calendar-connections";
import { evaluateLaunchScope } from "@/lib/launch-scope";
import { resolveSafeLocalRedirect } from "@/lib/security/redirects";

type RouteContext = {
  params: Promise<{ provider: string }>;
};

function getProvider(value: string): CalendarOAuthProvider | null {
  if (value === "google" || value === "microsoft") return value;
  return null;
}

export async function GET(request: Request, context: RouteContext) {
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

  const url = new URL(request.url);
  const trustedOrigin = getTrustedAppOrigin();
  const returnTo = resolveSafeLocalRedirect(url.searchParams.get("returnTo"), {
    blockedPathPrefixes: ["/api", "/login"],
    fallback: "/#calendar",
    trustedOrigin,
  });
  try {
    const { codeChallenge, state } = await createOAuthState({
      provider,
      returnTo,
      userId: auth.session.userId,
      workspaceId: auth.session.workspaceId,
    });

    return NextResponse.redirect(
      getOAuthAuthorizationUrl({
        codeChallenge,
        provider,
        requestUrl: trustedOrigin,
        state,
      }),
    );
  } catch (error) {
    const redirectUrl = new URL(returnTo, trustedOrigin);
    console.error("calendar_oauth_start_failed", {
      errorType: error instanceof Error ? error.name : "unknown",
      provider,
    });
    redirectUrl.searchParams.set("calendar_error", "OAuth setup failed");
    return NextResponse.redirect(redirectUrl);
  }
}
