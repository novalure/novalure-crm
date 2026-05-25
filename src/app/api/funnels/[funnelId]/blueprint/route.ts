import { NextResponse } from "next/server";
import { requirePermissionAndProductCapability } from "@/lib/auth/session";
import { findFunnelBlueprint } from "@/lib/funnel-builder-adapter";
import { funnelSteps, funnels, projects, users } from "@/lib/crm-source";
import type { FunnelBlueprint } from "@/lib/funnel-schema";
import { getStoredFunnel, restoreStoredFunnelVersion, saveStoredFunnel } from "@/lib/funnel-store";
import { getApiSystemCopy, resolveRequestLanguage } from "@/lib/i18n";

type RouteContext = {
  params: Promise<{ funnelId: string }>;
};

function runFunnelPreflight(blueprint: FunnelBlueprint) {
  const fields = blueprint.pages.flatMap((page) =>
    page.sections.flatMap((section) =>
      section.rows.flatMap((row) =>
        row.columns.flatMap((column) =>
          column.elements.flatMap((element) => element.type === "form" ? element.fields ?? [] : []),
        ),
      ),
    ),
  );
  const blockers: string[] = [];

  if (!blueprint.name.trim()) blockers.push("name_missing");
  if (!blueprint.projectId.trim()) blockers.push("project_missing");
  if (fields.length === 0) blockers.push("contact_form_missing");
  if (!fields.some((field) => {
    const searchable = [field.type, field.crmField, field.label, field.helpText]
      .map((value) => String(value ?? "").toLowerCase())
      .join(" ");
    return searchable.includes("privacy") || searchable.includes("datenschutz") || searchable.includes("consent") || searchable.includes("dsgvo") || searchable.includes("gdpr");
  })) blockers.push("privacy_consent_missing");
  if (!blueprint.crmHandover.destination.trim()) blockers.push("crm_handover_missing");
  if (fields.some((field) => field.required && !field.label.trim())) blockers.push("required_field_label_missing");

  return { blockers: Array.from(new Set(blockers)), ok: blockers.length === 0 };
}

export async function GET(_request: Request, context: RouteContext) {
  const text = getApiSystemCopy(resolveRequestLanguage(_request));
  const { funnelId } = await context.params;
  const stored = await getStoredFunnel(funnelId);
  const fallback = findFunnelBlueprint(funnelId, { funnels, projects, steps: funnelSteps, users });

  if (!stored && !fallback) {
    return NextResponse.json({ error: text.funnelNotFound }, { status: 404 });
  }

  return NextResponse.json({
    blueprint: stored?.blueprint ?? fallback,
    versions: stored?.versions ?? [],
    updatedAt: stored?.updatedAt ?? null,
    source: stored?.source ?? "crm-data",
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
    const restored = await restoreStoredFunnelVersion(funnelId, body.restoreVersionId);
    if (!restored) return NextResponse.json({ error: text.versionNotFound }, { status: 404 });
    return NextResponse.json(restored);
  }

  if (!body.blueprint || body.blueprint.id !== funnelId) {
    return NextResponse.json({ error: text.invalidBlueprint }, { status: 400 });
  }

  const preflight = runFunnelPreflight(body.blueprint);
  if (body.blueprint.status === "aktiv" && !preflight.ok) {
    return NextResponse.json({ error: "Funnel preflight blocked publish", preflight }, { status: 409 });
  }

  const saved = await saveStoredFunnel(body.blueprint, body.label, auth.session);
  return NextResponse.json({ ...saved, preflight });
}
