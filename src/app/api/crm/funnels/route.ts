import { NextResponse } from "next/server";
import { requirePermissionAndProductCapability } from "@/lib/auth/session";
import { upsertFunnelDraft } from "@/lib/db/crm-write-repositories";
import {
  evaluateEditorPreflight,
  runEditorPreflight,
} from "@/lib/db/editor-preflight-repositories";
import { evaluateLaunchScope } from "@/lib/launch-scope";
import {
  qaBatchRuntimeErrorResponse,
  qaBatchSuccessHeaders,
  readQaBatchMutationHeader,
} from "@/lib/qa-batch-runtime";

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function getFunnelWriteStatus(reason: string) {
  const normalizedReason = reason.toLowerCase();
  if (normalizedReason.includes("conflict")) return 409;
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
  const publicationScope = evaluateLaunchScope("publicFunnelPublication");
  if (!publicationScope.allowed) {
    return NextResponse.json({ error: publicationScope.code }, { status: 403 });
  }
  const auth = await requirePermissionAndProductCapability(request, "crm:write", "funnels:publish");
  if (!auth.ok) return auth.response;

  let qaBatchId: string | null;
  try {
    qaBatchId = readQaBatchMutationHeader(request, auth.session);
  } catch (error) {
    return qaBatchRuntimeErrorResponse(error)
      ?? NextResponse.json({ error: "QA batch validation failed" }, { status: 503 });
  }

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

  const launchScopedFunnel = { ...funnel };
  const webhookScope = evaluateLaunchScope("funnelWebhookDelivery");
  if (!webhookScope.allowed) delete launchScopedFunnel.webhookUrl;

  const preflight = await (qaBatchId ? evaluateEditorPreflight : runEditorPreflight)({
    editorType: "funnel",
    entityId: typeof launchScopedFunnel.id === "string" ? launchScopedFunnel.id : null,
    payload: launchScopedFunnel,
    projectId: typeof launchScopedFunnel.projectId === "string" ? launchScopedFunnel.projectId : null,
    session: auth.session,
  });
  const targetStatus = typeof launchScopedFunnel.status === "string" ? launchScopedFunnel.status : "";
  if (preflight.status === "blocked" && targetStatus !== "entwurf" && targetStatus !== "draft") {
    return NextResponse.json({ error: "Funnel preflight blocked publish", preflight }, { status: 409 });
  }

  let result;
  try {
    result = await upsertFunnelDraft({
      funnel: launchScopedFunnel,
      qaBatchId: qaBatchId ?? undefined,
      session: auth.session,
      steps,
    });
  } catch (error) {
    return qaBatchRuntimeErrorResponse(error)
      ?? NextResponse.json({ error: "Funnel could not be saved" }, { status: 503 });
  }

  if (!result.persisted) {
    return NextResponse.json({ error: result.reason }, { status: getFunnelWriteStatus(result.reason) });
  }

  return NextResponse.json(
    {
      persisted: true,
      preflight,
      launchScope: {
        funnelWebhookDelivery: webhookScope.allowed ? "on" : "off",
        policyDecision: webhookScope.decision,
      },
      ...result.data,
    },
    { headers: qaBatchSuccessHeaders(qaBatchId, result.qaBatchRegistration) },
  );
}
