import { NextResponse } from "next/server";
import { requirePermissionAndProductCapability } from "@/lib/auth/session";
import {
  FunnelLivePreflightError,
  runFunnelLivePreflight,
} from "@/lib/funnel-live-preflight";
import type { FunnelBlueprint } from "@/lib/funnel-schema";
import { getStoredFunnel, restoreStoredFunnelVersion, saveStoredFunnel } from "@/lib/funnel-store";
import { getApiSystemCopy, resolveRequestLanguage } from "@/lib/i18n";

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
    stored = await getStoredFunnel(funnelId, auth.session.workspaceId);
  } catch {
    return NextResponse.json({ error: "Funnel database is unavailable" }, { status: 503 });
  }

  if (!stored) {
    return NextResponse.json({ error: text.funnelNotFound }, { status: 404 });
  }

  return NextResponse.json({
    blueprint: stored.blueprint,
    blueprintOrigin: stored.blueprintOrigin,
    versions: stored.versions,
    updatedAt: stored.updatedAt,
    source: "database",
  });
}

export async function PUT(request: Request, context: RouteContext) {
  const auth = await requirePermissionAndProductCapability(request, "funnels:write", "funnels:publish");
  if (!auth.ok) return auth.response;

  const text = getApiSystemCopy(resolveRequestLanguage(request));
  const { funnelId } = await context.params;
  let body: { blueprint?: FunnelBlueprint; label?: string; restoreVersionId?: string };

  try {
    body = (await request.json()) as { blueprint?: FunnelBlueprint; label?: string; restoreVersionId?: string };
  } catch {
    return NextResponse.json({ error: text.invalidJson }, { status: 400 });
  }

  if (body.restoreVersionId) {
    let restored;
    try {
      restored = await restoreStoredFunnelVersion(funnelId, body.restoreVersionId, auth.session);
    } catch (error) {
      if (error instanceof FunnelLivePreflightError) {
        return NextResponse.json(
          { error: error.message, preflight: error.preflight },
          { status: 409 },
        );
      }
      return NextResponse.json({ error: "Funnel database is unavailable" }, { status: 503 });
    }
    if (!restored) return NextResponse.json({ error: text.versionNotFound }, { status: 404 });
    return NextResponse.json(restored);
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
    existing = await getStoredFunnel(funnelId, auth.session.workspaceId);
  } catch {
    return NextResponse.json({ error: "Funnel database is unavailable" }, { status: 503 });
  }
  if (!existing) return NextResponse.json({ error: text.funnelNotFound }, { status: 404 });

  let saved;
  try {
    saved = await saveStoredFunnel(body.blueprint, body.label, auth.session);
  } catch (error) {
    if (error instanceof FunnelLivePreflightError) {
      return NextResponse.json(
        { error: error.message, preflight: error.preflight },
        { status: 409 },
      );
    }
    const reason = error instanceof Error ? error.message : "Funnel blueprint could not be saved";
    const status = reason.includes("not found") ? 404 : 503;
    return NextResponse.json({ error: reason }, { status });
  }
  return NextResponse.json({ ...saved, preflight });
}
