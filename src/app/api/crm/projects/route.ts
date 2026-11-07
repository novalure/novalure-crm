import { withCrmSalesWrite } from "@/lib/crm-sales-http";
import { NextResponse } from "next/server";
import { resolveWorkspaceScopedSession, type AppSession } from "@/lib/auth/session";
import { createProjectRecord, updateProjectRecord } from "@/lib/db/crm-write-repositories";
import { getProjectWizardDetails, getProjectWizardOptions } from "@/lib/db/project-wizard-repository";
import { crmCommandErrorResponse } from "@/lib/crm-command";
import type { WorkspaceCustomerType, WorkspaceOperatingModel } from "@/lib/product-model";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const operation = url.searchParams.get("operation");
  const auth = await resolveWorkspaceScopedSession(request, operation === "wizard-options"
    ? { permission: "crm:write", capability: "settings:manage" }
    : { permission: "crm:read" });
  if (!auth.ok) return auth.response;
  try {
    if (url.searchParams.getAll("operation").length !== 1) return NextResponse.json({ error: "Invalid project operation" }, { status: 400 });
    const data = operation === "wizard-options"
      ? await getProjectWizardOptions(auth.session, {
        customerType: (url.searchParams.get("customerType") ?? undefined) as WorkspaceCustomerType | undefined,
        operatingModel: (url.searchParams.get("operatingModel") ?? undefined) as WorkspaceOperatingModel | undefined,
      })
      : operation === "wizard-details"
        ? await getProjectWizardDetails(auth.session, url.searchParams.get("projectId") ?? "")
        : null;
    if (!data) return NextResponse.json({ error: "Invalid project operation" }, { status: 400 });
    return NextResponse.json({ data }, { headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } });
  } catch (error) {
    return crmCommandErrorResponse(error);
  }
}

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function getProjectWriteStatus(reason: string) {
  if (reason.includes("VERSION_CONFLICT")) return 409;
  const normalizedReason = reason.toLowerCase();
  if (
    reason.includes("not available in this workspace") ||
    normalizedReason.includes("permission") ||
    normalizedReason.includes("not allowed") ||
    normalizedReason.includes("only be changed")
  ) return 403;
  if (reason.includes("not found")) return 404;
  if (reason.includes("required") || reason.includes("Invalid") || reason.includes("too long")) return 400;
  return 503;
}

async function postHandler(request: Request, session: AppSession) {
  const auth = { session };

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const project = typeof input.project === "object" && input.project ? input.project as Record<string, unknown> : input;
  const result = await createProjectRecord({ project, session: auth.session });

  if (!result.persisted) {
    return NextResponse.json({ error: result.reason }, { status: getProjectWriteStatus(result.reason) });
  }

  return NextResponse.json({ persisted: true, project: result.data });
}

async function patchHandler(request: Request, session: AppSession) {
  const auth = { session };

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const project = typeof input.project === "object" && input.project ? input.project as Record<string, unknown> : input;
  const result = await updateProjectRecord({ project, expectedVersion: input.expectedVersion, session: auth.session });

  if (!result.persisted) {
    return NextResponse.json({ error: result.reason }, { status: getProjectWriteStatus(result.reason) });
  }

  return NextResponse.json({ persisted: true, project: result.data });
}

export const POST = withCrmSalesWrite(postHandler);
export const PATCH = withCrmSalesWrite(patchHandler);
