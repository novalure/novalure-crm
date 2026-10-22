import { NextResponse } from "next/server";
import { getTrustedAppOrigin } from "@/lib/auth/app-origin";
import { requirePermissionAndProductCapability } from "@/lib/auth/session";
import {
  consumeOAuthState,
  exchangeOAuthCode,
  fetchCalendarAccountLabel,
  parseOAuthState,
  upsertCalendarOAuthConnection,
  type CalendarOAuthProvider,
} from "@/lib/integrations/calendar-connections";
import { bookingMicrosoftAuthority, consumeBookingOAuthState, saveBookingOAuthConnection } from "@/lib/booking/connections";
import { resolveSafeLocalRedirect } from "@/lib/security/redirects";

type RouteContext = {
  params: Promise<{ provider: string }>;
};

function getProvider(value: string): CalendarOAuthProvider | null {
  if (value === "google" || value === "microsoft") return value;
  return null;
}

export async function GET(request: Request, context: RouteContext) {
  const { provider: providerParam } = await context.params;
  const provider = getProvider(providerParam);
  const url = new URL(request.url);
  let bookingMode = false;
  try { bookingMode = Boolean(provider && parseOAuthState(url.searchParams.get("state"),provider)?.returnTo === "/booking"); }
  catch { /* Invalid state cannot select the booking callback. */ }
  const auth = await requirePermissionAndProductCapability(request, bookingMode ? "crm:write" : "calendar:sync", "calendar:manage");
  if (!auth.ok) return auth.response;
  const trustedOrigin = getTrustedAppOrigin();
  const fallbackRedirect = new URL("/#calendar", trustedOrigin);

  if (!provider) {
    fallbackRedirect.searchParams.set("calendar_error", "Unsupported calendar provider");
    return NextResponse.redirect(fallbackRedirect);
  }

  let state: Awaited<ReturnType<typeof consumeOAuthState>> = null;
  try {
    state = bookingMode ? await consumeBookingOAuthState({workspaceId:auth.session.workspaceId,actorId:auth.session.userId},provider,
      url.searchParams.get("state")) : await consumeOAuthState({
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
    redirectUrl.searchParams.set("calendar_error", bookingMode ? "calendar_consent_denied" : providerError);
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
      ...(bookingMode ? {trustedOrigin,...(provider === "microsoft" ? {microsoftAuthority:bookingMicrosoftAuthority()} : {})} : {}),
    });
    if (bookingMode) await saveBookingOAuthConnection({workspaceId:state.workspaceId,actorId:state.userId},provider,token);
    else {
      const accountLabel = await fetchCalendarAccountLabel(provider, token.access_token ?? "");
      await upsertCalendarOAuthConnection({accountLabel,provider,token,userId:state.userId,workspaceId:state.workspaceId});
    }

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
