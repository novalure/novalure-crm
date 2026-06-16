import { NextResponse } from "next/server";
import {
  getRequestSession,
  resolveWorkspaceScopedSession,
} from "@/lib/auth/session";
import {
  getCompanyProfilePayload,
  saveCompanyProfile,
} from "@/lib/db/company-profile-repositories";

function getProfileScope(request: Request) {
  const url = new URL(request.url);
  return url.searchParams.get("scope") ?? "workspace_owner";
}

function getOrganizationId(request: Request) {
  const url = new URL(request.url);
  return url.searchParams.get("organizationId") ?? undefined;
}

function isOperatorScope(scope: unknown) {
  return scope === "platform_operator";
}

function canReadOperatorProfile(session: Awaited<ReturnType<typeof getRequestSession>>) {
  return session?.productRole === "platform_admin" || session?.productRole === "novalureAdmin";
}

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const session = await getRequestSession(request);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const profileScope = getProfileScope(request);
  if (isOperatorScope(profileScope) && !canReadOperatorProfile(session)) {
    return NextResponse.json({ error: "operator_profile_forbidden" }, { status: 403 });
  }

  const payload = await getCompanyProfilePayload({
    organizationId: getOrganizationId(request),
    profileScope,
    session,
  });

  return NextResponse.json(payload);
}

export async function PATCH(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write", capability: "settings:manage" });
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const profileScope = input.profileScope ?? getProfileScope(request);
  if (isOperatorScope(profileScope) && !canReadOperatorProfile(auth.session)) {
    return NextResponse.json({ error: "operator_profile_forbidden" }, { status: 403 });
  }

  const result = await saveCompanyProfile({
    body: input,
    organizationId: typeof input.organizationId === "string" ? input.organizationId : getOrganizationId(request),
    profileScope,
    session: auth.session,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: result.status });
  }

  return NextResponse.json(result.payload);
}
