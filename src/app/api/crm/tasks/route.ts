import { NextResponse } from "next/server";
import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { upsertTaskRecord } from "@/lib/db/crm-write-repositories";

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function getTaskWriteStatus(reason: string) {
  if (reason.includes("permission") || reason.includes("not allowed")) return 403;
  if (reason.includes("not found")) return 404;
  if (reason.includes("required") || reason.includes("Invalid") || reason.includes("too long")) return 400;
  return 503;
}

export async function POST(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write", capability: "workspace:operate" });
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const task = typeof input.task === "object" && input.task ? input.task as Record<string, unknown> : input;
  const result = await upsertTaskRecord({ session: auth.session, task });

  if (!result.persisted) {
    return NextResponse.json({ error: result.reason }, { status: getTaskWriteStatus(result.reason) });
  }

  return NextResponse.json({ persisted: true, task: result.data });
}

export async function PATCH(request: Request) {
  return POST(request);
}
