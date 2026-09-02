import { NextResponse } from "next/server";
import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import {
  enqueuePropertyExport,
  getPropertyExportJob,
  isPropertyExportIdempotencyKey,
  listPropertyExportJobs,
  PropertyExportRuntimeError,
  transitionPropertyExportChannel,
} from "@/lib/db/property-export-repositories";
import {
  getPropertyExportAvailability,
  isPropertyExportQaSinkEnabled,
} from "@/lib/property-export/provider-adapters";
import { canAccessPropertyExports } from "@/lib/property-export/access";
import { evaluateLaunchScope } from "@/lib/launch-scope";
import { processDuePropertyExports } from "@/lib/property-export/runner";
import { PROPERTY_EXPORT_QA_PROVIDER } from "@/lib/property-export/types";
import type { LanguageCode } from "@/lib/i18n";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const noStoreHeaders = { "Cache-Control": "private, no-store" };

function normalizePropertyId(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/^listing:/, "");
  return uuidPattern.test(normalized) ? normalized : null;
}

function parseLanguage(value: unknown): LanguageCode {
  return value === "en" ? "en" : "de";
}

function runtimeErrorResponse(error: PropertyExportRuntimeError) {
  if (error.code === "external_portal_launch_off") {
    return NextResponse.json(
      {
        code: error.code,
        configurationState: "not_configured",
        error: error.message,
        launchState: "launch_off",
        persisted: false,
      },
      { headers: noStoreHeaders, status: 503 },
    );
  }
  const status = error.code === "database_unavailable"
    ? 503
    : error.code === "forbidden"
      ? 403
    : error.code === "not_found"
      ? 404
    : error.code === "idempotency_conflict" ||
        error.code === "invalid_transition" ||
        error.code === "job_not_retryable" ||
        error.code === "stale_write"
        ? 409
        : error.code === "preflight_blocked"
          ? 422
          : 400;
  return NextResponse.json(
    {
      code: error.code,
      error: error.message,
      ...(error.preflight ? { preflight: error.preflight } : {}),
    },
    { headers: noStoreHeaders, status },
  );
}

function externalPortalLaunchOff(providerKey: string) {
  return NextResponse.json(
    {
      code: "external_portal_launch_off",
      configurationState: "not_configured",
      error: "External portal delivery is not configured and remains launch-off.",
      launchState: "launch_off",
      persisted: false,
      providerKey,
    },
    { headers: noStoreHeaders, status: 503 },
  );
}

function propertyExportQueueLaunchOff() {
  const launchScope = evaluateLaunchScope("propertyExportQueue");
  if (launchScope.allowed) return null;
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

export async function GET(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" });
  if (!auth.ok) return auth.response;
  if (!canAccessPropertyExports(auth.session)) {
    return NextResponse.json(
      { code: "forbidden", error: "Property export requires publish and administration rights." },
      { headers: noStoreHeaders, status: 403 },
    );
  }

  const url = new URL(request.url);
  const propertyId = normalizePropertyId(url.searchParams.get("propertyId"));
  if (!propertyId) {
    return NextResponse.json(
      { code: "invalid_request", error: "A valid propertyId is required." },
      { headers: noStoreHeaders, status: 400 },
    );
  }
  const requestedLimit = Number(url.searchParams.get("limit") ?? 25);
  try {
    const jobs = await listPropertyExportJobs({
      limit: Number.isFinite(requestedLimit) ? requestedLimit : 25,
      propertyId,
      session: auth.session,
    });
    return NextResponse.json(
      {
        availability: getPropertyExportAvailability(),
        data: { jobs },
        mode: "preview_qa_only",
        persisted: true,
      },
      { headers: noStoreHeaders },
    );
  } catch (error) {
    if (error instanceof PropertyExportRuntimeError) return runtimeErrorResponse(error);
    throw error;
  }
}

export async function POST(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, {
    capability: "workspace:operate",
    permission: "crm:write",
  });
  if (!auth.ok) return auth.response;
  const launchOffResponse = propertyExportQueueLaunchOff();
  if (launchOffResponse) return launchOffResponse;
  if (!canAccessPropertyExports(auth.session)) {
    return NextResponse.json(
      { code: "forbidden", error: "Property export requires publish and administration rights." },
      { headers: noStoreHeaders, status: 403 },
    );
  }

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) {
    return NextResponse.json(
      { code: "invalid_request", error: "Invalid JSON." },
      { headers: noStoreHeaders, status: 400 },
    );
  }
  const providerKey = typeof body.providerKey === "string" && body.providerKey.trim()
    ? body.providerKey.trim()
    : PROPERTY_EXPORT_QA_PROVIDER;
  if (providerKey !== PROPERTY_EXPORT_QA_PROVIDER) {
    return externalPortalLaunchOff(providerKey);
  }
  if (!isPropertyExportQaSinkEnabled()) {
    return NextResponse.json(
      {
        code: "qa_sink_not_configured",
        error: "Preview QA property export sink is disabled for this runtime.",
        persisted: false,
      },
      { headers: noStoreHeaders, status: 503 },
    );
  }

  const propertyId = normalizePropertyId(body.propertyId);
  if (!propertyId) {
    return NextResponse.json(
      { code: "invalid_request", error: "A valid propertyId is required." },
      { headers: noStoreHeaders, status: 400 },
    );
  }
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
  if (!isPropertyExportIdempotencyKey(idempotencyKey)) {
    return NextResponse.json(
      { code: "invalid_request", error: "A valid Idempotency-Key header is required." },
      { headers: noStoreHeaders, status: 400 },
    );
  }

  try {
    const queued = await enqueuePropertyExport({
      idempotencyKey,
      language: parseLanguage(body.language),
      propertyId,
      scheduledAt: body.scheduledAt,
      session: auth.session,
    });
    const kickStarted = queued.job.scheduledAt === null &&
      (queued.job.status === "queued" || queued.job.status === "retry");
    const worker = kickStarted
      ? await processDuePropertyExports({
        jobIds: [queued.job.id],
        limit: 1,
        workspaceId: auth.session.workspaceId,
      })
      : null;
    const job = await getPropertyExportJob({ jobId: queued.job.id, session: auth.session });
    if (!job) throw new Error("Processed property export could not be reloaded");
    return NextResponse.json(
      {
        availability: getPropertyExportAvailability(),
        created: queued.created,
        job,
        kickStarted,
        mode: "preview_qa_only",
        preflight: queued.preflight,
        productionPublication: false,
        worker,
      },
      { headers: noStoreHeaders, status: queued.created ? 201 : 200 },
    );
  } catch (error) {
    if (error instanceof PropertyExportRuntimeError) return runtimeErrorResponse(error);
    throw error;
  }
}

export async function PATCH(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, {
    capability: "workspace:operate",
    permission: "crm:write",
  });
  if (!auth.ok) return auth.response;
  const launchOffResponse = propertyExportQueueLaunchOff();
  if (launchOffResponse) return launchOffResponse;
  if (!canAccessPropertyExports(auth.session)) {
    return NextResponse.json(
      { code: "forbidden", error: "Property export requires publish and administration rights." },
      { headers: noStoreHeaders, status: 403 },
    );
  }

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) {
    return NextResponse.json(
      { code: "invalid_request", error: "Invalid JSON." },
      { headers: noStoreHeaders, status: 400 },
    );
  }
  const providerKey = typeof body.providerKey === "string" && body.providerKey.trim()
    ? body.providerKey.trim()
    : PROPERTY_EXPORT_QA_PROVIDER;
  if (providerKey !== PROPERTY_EXPORT_QA_PROVIDER) {
    return externalPortalLaunchOff(providerKey);
  }
  const jobId = normalizePropertyId(body.jobId);
  if (!jobId) {
    return NextResponse.json(
      { code: "invalid_request", error: "A valid jobId is required." },
      { headers: noStoreHeaders, status: 400 },
    );
  }
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
  if (!isPropertyExportIdempotencyKey(idempotencyKey)) {
    return NextResponse.json(
      { code: "invalid_request", error: "A valid Idempotency-Key header is required." },
      { headers: noStoreHeaders, status: 400 },
    );
  }

  try {
    const transitioned = await transitionPropertyExportChannel({
      action: body.action,
      expectedChannelStatus: body.expectedChannelStatus,
      expectedChannelUpdatedAt: body.expectedChannelUpdatedAt,
      idempotencyKey,
      jobId,
      session: auth.session,
    });
    const isDue = Date.parse(transitioned.job.availableAt) <= Date.now();
    const kickStarted = body.action === "resume" &&
      isDue &&
      isPropertyExportQaSinkEnabled() &&
      (transitioned.job.status === "queued" || transitioned.job.status === "retry");
    const worker = kickStarted
      ? await processDuePropertyExports({
        jobIds: [transitioned.job.id],
        limit: 1,
        workspaceId: auth.session.workspaceId,
      })
      : null;
    const job = kickStarted
      ? await getPropertyExportJob({ jobId: transitioned.job.id, session: auth.session })
      : transitioned.job;
    if (!job) throw new Error("Updated property export could not be reloaded");
    return NextResponse.json(
      {
        availability: getPropertyExportAvailability(),
        externalPublication: false,
        externalWithdrawalPerformed: false,
        job,
        kickStarted,
        mode: "preview_qa_only",
        replayed: transitioned.replayed,
        worker,
      },
      { headers: noStoreHeaders },
    );
  } catch (error) {
    if (error instanceof PropertyExportRuntimeError) return runtimeErrorResponse(error);
    throw error;
  }
}
