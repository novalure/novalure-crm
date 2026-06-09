import { NextResponse } from "next/server";
import { requireProductCapability } from "@/lib/auth/session";
import {
  inviteWorkspaceUser,
  listCustomerAccessCockpit,
  updateCustomerAccessRecord,
  updateWorkspaceUserAccess,
  upsertCustomerProjectGrant,
} from "@/lib/db/customer-access-repositories";
import { resolveRequestLanguage } from "@/lib/i18n";

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function getProjectId(request: Request) {
  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId");

  return projectId && projectId !== "all" ? projectId : null;
}

function getFailureStatus(result: unknown) {
  if (!result || typeof result !== "object" || !("status" in result)) return 400;
  const status = result.status;

  return typeof status === "number" ? status : 400;
}

export async function GET(request: Request) {
  const auth = await requireProductCapability(request, "customer-access:read");
  if (!auth.ok) return auth.response;

  const payload = await listCustomerAccessCockpit({
    projectId: getProjectId(request),
    session: auth.session,
  });

  return NextResponse.json(payload);
}

export async function PATCH(request: Request) {
  const auth = await requireProductCapability(request, "customer-access:manage");
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const operation = typeof input.operation === "string" ? input.operation : "access";
  const language = resolveRequestLanguage(request);
  const result =
    operation === "project_grant"
      ? await upsertCustomerProjectGrant({
          accessId: String(input.accessId ?? ""),
          accessLevel: input.accessLevel,
          canEditProject: input.canEditProject,
          canExportData: input.canExportData,
          canViewContacts: input.canViewContacts,
          canViewProject: input.canViewProject,
          projectId: String(input.projectId ?? ""),
          projectRole: input.projectRole,
          session: auth.session,
          status: input.status,
          userId: String(input.userId ?? ""),
        })
      : operation === "workspace_user"
        ? await updateWorkspaceUserAccess({
            productRole: input.productRole,
            role: input.role,
            session: auth.session,
            status: input.status,
            userId: String(input.userId ?? ""),
          })
        : operation === "invite_user"
          ? await inviteWorkspaceUser({
              email: input.email,
              language,
              name: input.name,
              origin: request.url,
              productRole: input.productRole,
              requestIp: request.headers.get("x-forwarded-for"),
              role: input.role,
              session: auth.session,
              userAgent: request.headers.get("user-agent"),
            })
        : await updateCustomerAccessRecord({
            accessId: String(input.accessId ?? input.id ?? ""),
            activeUsers: input.activeUsers,
            activationScore: input.activationScore,
            health: input.health,
            invitedUsers: input.invitedUsers,
            nextOnboardingAction: input.nextOnboardingAction,
            plan: input.plan,
            risks: input.risks,
            session: auth.session,
            status: input.status,
          });

  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: getFailureStatus(result) });
  }

  const payload = await listCustomerAccessCockpit({
    projectId: getProjectId(request),
    session: auth.session,
  });

  return NextResponse.json({ data: result.data, payload, persisted: true });
}

export async function POST(request: Request) {
  return PATCH(request);
}
