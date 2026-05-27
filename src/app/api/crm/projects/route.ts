import { NextResponse } from "next/server";
import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { createProjectRecord, updateProjectRecord } from "@/lib/db/crm-write-repositories";

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function getProjectWriteStatus(reason: string) {
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

export async function POST(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write", capability: "settings:manage" });
  if (!auth.ok) return auth.response;

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

export async function PATCH(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write", capability: "settings:manage" });
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const project = typeof input.project === "object" && input.project ? input.project as Record<string, unknown> : input;
  const result = await updateProjectRecord({ project, session: auth.session });

  if (!result.persisted) {
    return NextResponse.json({ error: result.reason }, { status: getProjectWriteStatus(result.reason) });
  }

  return NextResponse.json({ persisted: true, project: result.data });
}
