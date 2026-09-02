import { NextResponse } from "next/server";
import { requirePermissionAndProductCapability } from "@/lib/auth/session";
import {
  FunnelLivePreflightError,
  runFunnelLivePreflight,
} from "@/lib/funnel-live-preflight";
import type { FunnelBlueprint } from "@/lib/funnel-schema";
import { FunnelAccessError } from "@/lib/funnel-access";
import {
  getStoredFunnelForSession,
  restoreStoredFunnelVersion,
  saveStoredFunnel,
} from "@/lib/funnel-store";
import { toFunnelBlueprintResponse } from "@/lib/funnel-store-response";
import { getApiSystemCopy, resolveRequestLanguage } from "@/lib/i18n";
import { evaluateLaunchScope } from "@/lib/launch-scope";
import {
  qaBatchRuntimeErrorResponse,
  qaBatchSuccessHeaders,
  readQaBatchMutationHeader,
} from "@/lib/qa-batch-runtime";

type RouteContext = {
  params: Promise<{ funnelId: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const auth = await requirePermissionAndProductCapability(_request, "funnels:write", "funnels:publish");
  if (!auth.ok) return auth.response;

  const text = getApiSystemCopy(resolveRequestLanguage(_request));
  const { funnelId } = await context.params;
  let stored;

  try {
    stored = await getStoredFunnelForSession(funnelId, auth.session);
  } catch {
    return NextResponse.json({ error: "Funnel database is unavailable" }, { status: 503 });
  }

  if (!stored) {
    return NextResponse.json({ error: text.funnelNotFound }, { status: 404 });
  }

  return NextResponse.json(toFunnelBlueprintResponse(stored));
}

export async function PUT(request: Request, context: RouteContext) {
  const launchScope = evaluateLaunchScope("publicFunnelPublication");
  if (!launchScope.allowed) {
    return NextResponse.json({ error: launchScope.code }, { status: 403 });
  }
  const auth = await requirePermissionAndProductCapability(request, "funnels:write", "funnels:publish");
  if (!auth.ok) return auth.response;

  let qaBatchId: string | null;
  try {
    qaBatchId = readQaBatchMutationHeader(request, auth.session);
  } catch (error) {
    return qaBatchRuntimeErrorResponse(error)
      ?? NextResponse.json({ error: "QA batch validation failed" }, { status: 503 });
  }

  const text = getApiSystemCopy(resolveRequestLanguage(request));
  const { funnelId } = await context.params;
  let body: {
    blueprint?: FunnelBlueprint;
    expectedBlueprintRevision?: number;
    label?: string;
    restoreVersionId?: string;
  };

  try {
    body = (await request.json()) as {
      blueprint?: FunnelBlueprint;
      expectedBlueprintRevision?: number;
      label?: string;
      restoreVersionId?: string;
    };
  } catch {
    return NextResponse.json({ error: text.invalidJson }, { status: 400 });
  }

  const expectedBlueprintRevision = body.expectedBlueprintRevision;
  if (
    typeof expectedBlueprintRevision !== "number" ||
    !Number.isSafeInteger(expectedBlueprintRevision) ||
    expectedBlueprintRevision < 0
  ) {
    return NextResponse.json({ error: "A valid expected funnel content revision is required" }, { status: 400 });
  }

  if (body.restoreVersionId) {
    let restored;
    try {
      restored = await restoreStoredFunnelVersion(
        funnelId,
        body.restoreVersionId,
        auth.session,
        expectedBlueprintRevision,
        qaBatchId ?? undefined,
      );
    } catch (error) {
      const qaError = qaBatchRuntimeErrorResponse(error);
      if (qaError) return qaError;
      if (error instanceof FunnelAccessError) {
        return NextResponse.json({ error: text.funnelNotFound }, { status: 404 });
      }
      if (error instanceof FunnelLivePreflightError) {
        return NextResponse.json(
          { error: error.message, preflight: error.preflight },
          { status: 409 },
        );
      }
      const reason = error instanceof Error ? error.message : "Funnel database is unavailable";
      return NextResponse.json(
        { error: reason },
        { status: reason.toLowerCase().includes("conflict") ? 409 : 503 },
      );
    }
    if (!restored) return NextResponse.json({ error: text.versionNotFound }, { status: 404 });
    return NextResponse.json(
      toFunnelBlueprintResponse(restored),
      { headers: qaBatchSuccessHeaders(qaBatchId, qaBatchId ? "already-registered" : undefined) },
    );
  }

  if (!body.blueprint || body.blueprint.id !== funnelId) {
    return NextResponse.json({ error: text.invalidBlueprint }, { status: 400 });
  }

  const preflight = runFunnelLivePreflight(body.blueprint);
  if (body.blueprint.status === "aktiv" && !preflight.ok) {
    return NextResponse.json({ error: "Funnel preflight blocked publish", preflight }, { status: 409 });
  }

  let existing;
  try {
    existing = await getStoredFunnelForSession(funnelId, auth.session);
  } catch {
    return NextResponse.json({ error: "Funnel database is unavailable" }, { status: 503 });
  }
  if (!existing) return NextResponse.json({ error: text.funnelNotFound }, { status: 404 });

  let saved;
  try {
    saved = await saveStoredFunnel(
      body.blueprint,
      body.label,
      auth.session,
      expectedBlueprintRevision,
      "funnel.blueprint_saved",
      qaBatchId ?? undefined,
    );
  } catch (error) {
    const qaError = qaBatchRuntimeErrorResponse(error);
    if (qaError) return qaError;
    if (error instanceof FunnelAccessError) {
      return NextResponse.json({ error: text.funnelNotFound }, { status: 404 });
    }
    if (error instanceof FunnelLivePreflightError) {
      return NextResponse.json(
        { error: error.message, preflight: error.preflight },
        { status: 409 },
      );
    }
    const reason = error instanceof Error ? error.message : "Funnel blueprint could not be saved";
    const status = reason.toLowerCase().includes("conflict")
      ? 409
      : reason.includes("not found")
        ? 404
        : 503;
    return NextResponse.json({ error: reason }, { status });
  }
  return NextResponse.json({
    ...toFunnelBlueprintResponse(saved),
    preflight,
  }, {
    headers: qaBatchSuccessHeaders(qaBatchId, qaBatchId ? "already-registered" : undefined),
  });
}
