import { withCrmSalesWrite } from "@/lib/crm-sales-http";
import { NextResponse } from "next/server";
import type { AppSession } from "@/lib/auth/session";
import { upsertTaskRecord } from "@/lib/db/crm-write-repositories";

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function getTaskWriteStatus(reason: string) {
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
  const task = typeof input.task === "object" && input.task ? input.task as Record<string, unknown> : input;
  const result = await upsertTaskRecord({ session: auth.session, task, expectedVersion: input.expectedVersion });

  if (!result.persisted) {
    return NextResponse.json({ error: result.reason }, { status: getTaskWriteStatus(result.reason) });
  }

  return NextResponse.json({ persisted: true, task: result.data });
}

async function patchHandler(request: Request, session: AppSession) {
  return postHandler(request, session);
}

export const POST = withCrmSalesWrite(postHandler);
export const PATCH = withCrmSalesWrite(patchHandler);
