import { NextResponse } from "next/server";
import { getTrustedAppOrigin } from "@/lib/auth/app-origin";
import { requirePermissionAndProductCapability } from "@/lib/auth/session";
import {
  consumeOAuthState,
  exchangeOAuthCode,
  fetchCalendarAccountLabel,
  upsertCalendarOAuthConnection,
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
  const url = new URL(request.url);
  const trustedOrigin = getTrustedAppOrigin();
  const fallbackRedirect = new URL("/#calendar", trustedOrigin);

  if (!provider) {
    fallbackRedirect.searchParams.set("calendar_error", "Unsupported calendar provider");
    return NextResponse.redirect(fallbackRedirect);
  }

  let state: Awaited<ReturnType<typeof consumeOAuthState>> = null;
  try {
    state = await consumeOAuthState({
      expectedProvider: provider,
      sessionUserId: auth.session.userId,
      sessionWorkspaceId: auth.session.workspaceId,
      value: url.searchParams.get("state"),
    });
  } catch (error) {
    console.error("calendar_oauth_state_consume_failed", {
      errorType: error instanceof Error ? error.name : "unknown",
      provider,
    });
  }

  if (!state) {
    fallbackRedirect.searchParams.set("calendar_error", "OAuth state is invalid or expired");
    return NextResponse.redirect(fallbackRedirect);
  }

  const returnTo = resolveSafeLocalRedirect(state.returnTo, {
    blockedPathPrefixes: ["/api", "/login"],
    fallback: "/#calendar",
    trustedOrigin,
  });
  const redirectUrl = new URL(returnTo, trustedOrigin);

  const providerError = url.searchParams.get("error");
  if (providerError) {
    redirectUrl.searchParams.set("calendar_error", providerError);
    return NextResponse.redirect(redirectUrl);
  }

  const code = url.searchParams.get("code");
  if (!code) {
    redirectUrl.searchParams.set("calendar_error", "OAuth code is missing");
    return NextResponse.redirect(redirectUrl);
  }

  try {
    const token = await exchangeOAuthCode({
      code,
      codeVerifier: state.codeVerifier,
      provider,
      requestUrl: trustedOrigin,
    });
    const accountLabel = await fetchCalendarAccountLabel(provider, token.access_token ?? "");
    await upsertCalendarOAuthConnection({
      accountLabel,
      provider,
      token,
      userId: state.userId,
      workspaceId: state.workspaceId,
    });

    redirectUrl.searchParams.set("calendar_connected", provider);
    return NextResponse.redirect(redirectUrl);
  } catch (error) {
    console.error("calendar_oauth_callback_failed", {
      errorType: error instanceof Error ? error.name : "unknown",
      provider,
    });
    redirectUrl.searchParams.set("calendar_error", "Calendar OAuth failed");
    return NextResponse.redirect(redirectUrl);
  }
}
