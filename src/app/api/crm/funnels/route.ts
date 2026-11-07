import { NextResponse } from "next/server";
import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { getStoredFunnel } from "@/lib/funnel-store";
import { upsertFunnelDraft } from "@/lib/db/crm-write-repositories";
import { runEditorPreflight } from "@/lib/db/editor-preflight-repositories";

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function getFunnelWriteStatus(reason: string) {
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
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write", capability: "funnels:publish" });
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const funnel = typeof input.funnel === "object" && input.funnel ? input.funnel as Record<string, unknown> : null;
  const steps = Array.isArray(input.steps) ? input.steps.filter((step) => step && typeof step === "object") as Array<Record<string, unknown>> : [];

  if (!funnel) {
    return NextResponse.json({ error: "Missing funnel" }, { status: 400 });
  }

  // This endpoint saves the overview draft. Publication is a separate reviewed
  // designer action; preserve a previously published immutable blueprint.
  const existing = typeof funnel.id === "string" ? await getStoredFunnel(funnel.id, auth.session) : null;
  const hasPublication = Boolean(existing?.tracking.livePublication);
  const draftFunnel = { ...funnel, status: "entwurf" };
  const preflight = await runEditorPreflight({
    editorType: "funnel",
    entityId: typeof funnel.id === "string" ? funnel.id : null,
    payload: draftFunnel,
    projectId: typeof funnel.projectId === "string" ? funnel.projectId : null,
    session: auth.session,
  });
  const result = await upsertFunnelDraft({ funnel: { ...draftFunnel, status: hasPublication ? "aktiv" : "entwurf" }, session: auth.session, steps });

  if (!result.persisted) {
    return NextResponse.json({ error: result.reason }, { status: getFunnelWriteStatus(result.reason) });
  }

  return NextResponse.json({ persisted: true, preflight, ...result.data });
}
