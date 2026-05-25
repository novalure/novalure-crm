import { NextResponse } from "next/server";
import { requirePermissionAndProductCapability } from "@/lib/auth/session";
import {
  createOAuthState,
  getOAuthAuthorizationUrl,
  type CalendarOAuthProvider,
} from "@/lib/integrations/calendar-connections";

type RouteContext = {
  params: Promise<{ provider: string }>;
};

function getProvider(value: string): CalendarOAuthProvider | null {
  if (value === "google" || value === "microsoft") return value;
  return null;
}

function safeReturnTo(value: string | null) {
  if (!value || !value.startsWith("/")) return "/#calendar";
  if (value.startsWith("//")) return "/#calendar";
  return value;
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
    returnTo: safeReturnTo(url.searchParams.get("returnTo")),
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
    const redirectUrl = new URL(safeReturnTo(url.searchParams.get("returnTo")), request.url);
    redirectUrl.searchParams.set(
      "calendar_error",
      error instanceof Error ? error.message : "OAuth setup failed",
    );
    return NextResponse.redirect(redirectUrl);
  }
}
