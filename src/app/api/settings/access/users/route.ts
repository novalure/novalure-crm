import { NextResponse } from "next/server";
import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import {
  inviteSettingsWorkspaceUser,
  listWorkspaceAccessSettings,
  resendWorkspaceInvitation,
  revokeWorkspaceInvitation,
  triggerWorkspacePasswordReset,
  updateSettingsWorkspaceUser,
} from "@/lib/db/settings-access-repositories";
import { resolveRequestLanguage } from "@/lib/i18n";

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function getFailureStatus(result: unknown) {
  if (!result || typeof result !== "object" || !("status" in result)) return 400;
  const status = result.status;

  return typeof status === "number" ? status : 400;
}

async function requireSettingsAccess(request: Request) {
  return resolveWorkspaceScopedSession(request, { permission: "crm:write", capability: "settings:manage" });
}

export async function GET(request: Request) {
  const auth = await requireSettingsAccess(request);
  if (!auth.ok) return auth.response;

  return NextResponse.json(await listWorkspaceAccessSettings(auth.session));
}

export async function PATCH(request: Request) {
  const auth = await requireSettingsAccess(request);
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const result = await updateSettingsWorkspaceUser({
    productRole: input.productRole,
    role: input.role,
    session: auth.session,
    status: input.status,
    userId: String(input.userId ?? ""),
  });

  if (!result.ok) return NextResponse.json({ error: result.reason }, { status: getFailureStatus(result) });

  return NextResponse.json(await listWorkspaceAccessSettings(auth.session));
}

export async function POST(request: Request) {
  const auth = await requireSettingsAccess(request);
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const operation = typeof input.operation === "string" ? input.operation : "invite";
  const language = resolveRequestLanguage(request);
  const requestIp = request.headers.get("x-forwarded-for");
  const userAgent = request.headers.get("user-agent");

  const result =
    operation === "resend_invitation"
      ? await resendWorkspaceInvitation({
          language,
          requestIp,
          session: auth.session,
          userAgent,
          userId: String(input.userId ?? ""),
        })
      : operation === "revoke_invitation"
        ? await revokeWorkspaceInvitation({
            session: auth.session,
            userId: String(input.userId ?? ""),
          })
        : operation === "password_reset"
          ? await triggerWorkspacePasswordReset({
              language,
              requestIp,
              session: auth.session,
              userAgent,
              userId: String(input.userId ?? ""),
            })
          : await inviteSettingsWorkspaceUser({
              email: input.email,
              language,
              name: input.name,
              productRole: input.productRole,
              requestIp,
              role: input.role,
              session: auth.session,
              userAgent,
            });

  if (!result.ok) return NextResponse.json({ error: result.reason }, { status: getFailureStatus(result) });

  const payload = await listWorkspaceAccessSettings(auth.session);
  return NextResponse.json({
    ...payload,
    lastAction: "data" in result ? result.data : undefined,
  });
}
