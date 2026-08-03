import { NextResponse } from "next/server";
import { requirePermissionAndProductCapability } from "@/lib/auth/session";
import {
  createOAuthState,
  getOAuthAuthorizationUrl,
  type CalendarOAuthProvider,
} from "@/lib/integrations/calendar-connections";
import { sanitizeLocalRedirect } from "@/lib/auth/redirects";

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

  const { provider: providerParam } = await context.params;
  const provider = getProvider(providerParam);
  if (!provider) {
    return NextResponse.json({ error: "Unsupported calendar provider" }, { status: 400 });
  }

  const url = new URL(request.url);
  const state = createOAuthState({
    provider,
    returnTo: sanitizeLocalRedirect(url.searchParams.get("returnTo"), "/#calendar"),
    userId: auth.session.userId,
    workspaceId: auth.session.workspaceId,
  });

  try {
    return NextResponse.redirect(
      getOAuthAuthorizationUrl({
        provider,
        requestUrl: request.url,
        state,
      }),
    );
  } catch (error) {
    const redirectUrl = new URL(sanitizeLocalRedirect(url.searchParams.get("returnTo"), "/#calendar"), request.url);
    redirectUrl.searchParams.set(
      "calendar_error",
      error instanceof Error ? error.message : "OAuth setup failed",
    );
    return NextResponse.redirect(redirectUrl);
  }
}
