import { NextResponse } from "next/server";
import { findFunnelBlueprint } from "@/lib/funnel-builder-adapter";
import { funnelSteps, funnels, projects, users } from "@/lib/crm-data";
import type { FunnelBlueprint } from "@/lib/funnel-schema";
import { getStoredFunnel, restoreStoredFunnelVersion, saveStoredFunnel } from "@/lib/funnel-store";

type RouteContext = {
  params: Promise<{ funnelId: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const { funnelId } = await context.params;
  const stored = await getStoredFunnel(funnelId);
  const fallback = findFunnelBlueprint(funnelId, { funnels, projects, steps: funnelSteps, users });

  if (!stored && !fallback) {
    return NextResponse.json({ error: "Funnel not found" }, { status: 404 });
  }

  return NextResponse.json({
    blueprint: stored?.blueprint ?? fallback,
    versions: stored?.versions ?? [],
    updatedAt: stored?.updatedAt ?? null,
    source: stored ? "store" : "crm-data",
  });
}

export async function PUT(request: Request, context: RouteContext) {
  const { funnelId } = await context.params;
  const body = (await request.json()) as { blueprint?: FunnelBlueprint; label?: string; restoreVersionId?: string };

  if (body.restoreVersionId) {
    const restored = await restoreStoredFunnelVersion(funnelId, body.restoreVersionId);
    if (!restored) return NextResponse.json({ error: "Version not found" }, { status: 404 });
    return NextResponse.json(restored);
  }

  if (!body.blueprint || body.blueprint.id !== funnelId) {
    return NextResponse.json({ error: "Invalid blueprint" }, { status: 400 });
  }

  const saved = await saveStoredFunnel(body.blueprint, body.label);
  return NextResponse.json(saved);
}
