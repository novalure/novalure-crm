import { NextResponse } from "next/server";
import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import {
  getPropertyExportJob,
  isPropertyExportIdempotencyKey,
  PropertyExportRuntimeError,
  retryPropertyExportJob,
} from "@/lib/db/property-export-repositories";
import { isPropertyExportQaSinkEnabled } from "@/lib/property-export/provider-adapters";
import { canAccessPropertyExports } from "@/lib/property-export/access";
import { evaluateLaunchScope } from "@/lib/launch-scope";
import { processDuePropertyExports } from "@/lib/property-export/runner";

type RouteContext = { params: Promise<{ jobId: string }> };
const noStoreHeaders = { "Cache-Control": "private, no-store" };

function errorStatus(error: PropertyExportRuntimeError) {
  if (error.code === "database_unavailable") return 503;
  if (error.code === "forbidden") return 403;
  if (error.code === "not_found") return 404;
  if (
    error.code === "job_not_retryable" ||
    error.code === "idempotency_conflict" ||
    error.code === "invalid_transition" ||
    error.code === "stale_write"
  ) return 409;
  return 400;
}

export async function POST(request: Request, context: RouteContext) {
  const auth = await resolveWorkspaceScopedSession(request, {
    capability: "workspace:operate",
    permission: "crm:write",
  });
  if (!auth.ok) return auth.response;
  const launchScope = evaluateLaunchScope("propertyExportQueue");
  if (!launchScope.allowed) {
    return NextResponse.json(
      {
        code: "property_export_queue_launch_off",
        error: launchScope.rule.reason,
        launchScopeCode: launchScope.code,
        persisted: false,
      },
      { headers: noStoreHeaders, status: 503 },
    );
  }
  if (!canAccessPropertyExports(auth.session)) {
    return NextResponse.json(
      { code: "forbidden", error: "Property export requires publish and administration rights." },
      { headers: noStoreHeaders, status: 403 },
    );
  }
  if (!isPropertyExportQaSinkEnabled()) {
    return NextResponse.json(
      { code: "qa_sink_not_configured", error: "Preview QA property export sink is disabled." },
      { headers: noStoreHeaders, status: 503 },
    );
  }

  const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
  if (!isPropertyExportIdempotencyKey(idempotencyKey)) {
    return NextResponse.json(
      { code: "invalid_request", error: "A valid Idempotency-Key header is required." },
      { headers: noStoreHeaders, status: 400 },
    );
  }
  const { jobId } = await context.params;
  try {
    const retried = await retryPropertyExportJob({ idempotencyKey, jobId, session: auth.session });
    const worker = await processDuePropertyExports({
      jobIds: [retried.job.id],
      limit: 1,
      workspaceId: auth.session.workspaceId,
    });
    const job = await getPropertyExportJob({ jobId: retried.job.id, session: auth.session });
    if (!job) throw new Error("Retried property export could not be reloaded");
    return NextResponse.json(
      { job, productionPublication: false, replayed: retried.replayed, worker },
      { headers: noStoreHeaders },
    );
  } catch (error) {
    if (error instanceof PropertyExportRuntimeError) {
      return NextResponse.json(
        { code: error.code, error: error.message },
        { headers: noStoreHeaders, status: errorStatus(error) },
      );
    }
    throw error;
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  return POST(request, context);
}
