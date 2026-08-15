import { NextResponse } from "next/server";
import {
  exchangeOAuthCode,
  fetchCalendarAccountLabel,
  parseOAuthState,
  upsertCalendarOAuthConnection,
  type CalendarOAuthProvider,
} from "@/lib/integrations/calendar-connections";

type RouteContext = {
  params: Promise<{ provider: string }>;
};

function getProvider(value: string): CalendarOAuthProvider | null {
  if (value === "google" || value === "microsoft") return value;
  return null;
}

function safeReturnTo(value: string | null | undefined) {
  if (!value || !value.startsWith("/")) return "/#calendar";
  if (value.startsWith("//")) return "/#calendar";
  return value;
}

export async function GET(request: Request, context: RouteContext) {
  const { provider: providerParam } = await context.params;
  const provider = getProvider(providerParam);
  const url = new URL(request.url);
  const fallbackRedirect = new URL("/#calendar", request.url);

  if (!provider) {
    fallbackRedirect.searchParams.set("calendar_error", "Unsupported calendar provider");
    return NextResponse.redirect(fallbackRedirect);
  }

  const state = parseOAuthState(url.searchParams.get("state"), provider);
  const redirectUrl = new URL(safeReturnTo(state?.returnTo), request.url);

  if (!state) {
    redirectUrl.searchParams.set("calendar_error", "OAuth state is invalid");
    return NextResponse.redirect(redirectUrl);
  }

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
      provider,
      requestUrl: request.url,
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
    redirectUrl.searchParams.set(
      "calendar_error",
      error instanceof Error ? error.message : "Calendar OAuth failed",
    );
    return NextResponse.redirect(redirectUrl);
  }
}
