import { NextResponse } from "next/server";
import { requirePermission, type AppSession } from "@/lib/auth/session";
import { findFunnelBlueprint } from "@/lib/funnel-builder-adapter";
import { funnelSteps, funnels, projects, users } from "@/lib/crm-source";
import { persistFunnelSubmission, persistFunnelTestSubmission } from "@/lib/db/runtime-repositories";
import { getStoredFunnel } from "@/lib/funnel-store";
import type { FunnelBlueprint, FunnelSubmissionPayload } from "@/lib/funnel-schema";
import { getApiSystemCopy, resolveRequestLanguage } from "@/lib/i18n";
import { getProductRoleCapabilities } from "@/lib/product-model";

type RouteContext = {
  params: Promise<{ funnelId: string }>;
};

function hasRequiredConsent(payload: FunnelSubmissionPayload) {
  return payload.consent.privacy === true;
}

function scoreAnswers(payload: FunnelSubmissionPayload) {
  return Object.values(payload.answers).reduce<number>((score, value) => {
    if (value === true) return score + 5;
    if (typeof value === "number" && value > 0) return score + Math.min(20, value);
    if (typeof value === "string" && value.trim()) return score + 10;
    if (Array.isArray(value) && value.length > 0) return score + value.length * 5;
    return score;
  }, 0);
}

function cleanString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function getRequestToken(request: Request) {
  const url = new URL(request.url);

  return cleanString(url.searchParams.get("token"))
    || cleanString(request.headers.get("x-novalure-funnel-token"))
    || cleanString(request.headers.get("x-funnel-token"));
}

function getTrackingToken(blueprint: FunnelBlueprint, storedTracking: Record<string, unknown> | undefined) {
  const blueprintTracking = blueprint.tracking as Record<string, unknown>;

  return cleanString(storedTracking?.publishToken)
    || cleanString(storedTracking?.publicToken)
    || cleanString(blueprintTracking.publishToken)
    || cleanString(blueprintTracking.publicToken);
}

function canUsePublicLiveFunnel(input: {
  blueprint: FunnelBlueprint;
  request: Request;
  stored: Awaited<ReturnType<typeof getStoredFunnel>>;
}) {
  if (!input.stored || input.stored.source !== "database") return false;

  const token = getRequestToken(input.request);
  const expectedToken = getTrackingToken(input.blueprint, input.stored.tracking);
  if (expectedToken && token && expectedToken === token) return true;

  return input.stored.status === "aktiv" || input.blueprint.status === "aktiv";
}

function runFunnelPreflight(blueprint: FunnelBlueprint) {
  const blockers: string[] = [];
  const formFields = collectFunnelFormFields(blueprint);

  if (!cleanString(blueprint.name)) blockers.push("name_missing");
  if (!cleanString(blueprint.projectId)) blockers.push("project_missing");
  if (formFields.length === 0) blockers.push("contact_form_missing");
  if (!hasPrivacyConsentField(formFields)) blockers.push("privacy_consent_missing");
  if (!cleanString(blueprint.crmHandover?.destination)) blockers.push("crm_handover_missing");

  for (const field of formFields) {
    const required = Boolean(field.required);
    const label = cleanString(field.label);
    if (required && !label) blockers.push(`required_field_label_missing:${cleanString(field.id) || "unknown"}`);
  }

  return { blockers, ok: blockers.length === 0 };
}

function collectFunnelFormFields(blueprint: FunnelBlueprint) {
  const fields: Array<Record<string, unknown>> = [];
  for (const page of blueprint.pages ?? []) {
    for (const section of page.sections ?? []) {
      for (const row of section.rows ?? []) {
        for (const column of row.columns ?? []) {
          for (const element of column.elements ?? []) {
            const candidate = element as Record<string, unknown>;
            if (candidate.type !== "form") continue;
            const elementFields = Array.isArray(candidate.fields) ? candidate.fields : [];
            fields.push(...elementFields.filter((field): field is Record<string, unknown> => Boolean(field) && typeof field === "object"));
          }
        }
      }
    }
  }

  return fields;
}

function hasPrivacyConsentField(fields: Array<Record<string, unknown>>) {
  return fields.some((field) => {
    const searchable = [
      field.type,
      field.crmField,
      field.name,
      field.label,
      field.helpText,
    ].map((value) => String(value ?? "").toLowerCase()).join(" ");

    return searchable.includes("privacy")
      || searchable.includes("datenschutz")
      || searchable.includes("consent")
      || searchable.includes("dsgvo")
      || searchable.includes("gdpr");
  });
}

function createPublicFunnelSession(input: {
  blueprint: FunnelBlueprint;
  stored: NonNullable<Awaited<ReturnType<typeof getStoredFunnel>>>;
}): AppSession {
  return {
    authenticated: true,
    email: "funnel@novalure.local",
    name: "Public Funnel Runtime",
    permissions: [],
    productPermissions: getProductRoleCapabilities("assistant_backoffice"),
    productRole: "assistant_backoffice",
    role: "owner",
    source: "database",
    userId: input.stored.ownerUserId ?? "public-funnel-runtime",
    workspaceId: input.stored.workspaceId ?? input.blueprint.workspaceId,
    workspaceName: input.stored.workspaceName ?? "Novalure",
  };
}

export async function POST(request: Request, context: RouteContext) {
  const text = getApiSystemCopy(resolveRequestLanguage(request));
  const { funnelId } = await context.params;
  const stored = await getStoredFunnel(funnelId);
  const fallback = findFunnelBlueprint(funnelId, { funnels, projects, steps: funnelSteps, users });
  const blueprint = stored?.blueprint ?? fallback;

  if (!blueprint) {
    return NextResponse.json({ error: text.funnelNotFound }, { status: 404 });
  }

  let payload: FunnelSubmissionPayload;
  try {
    payload = (await request.json()) as FunnelSubmissionPayload;
  } catch {
    return NextResponse.json({ error: text.invalidJson }, { status: 400 });
  }

  if (payload.funnelId !== funnelId) {
    return NextResponse.json({ error: text.funnelMismatch }, { status: 400 });
  }

  if (!hasRequiredConsent(payload)) {
    return NextResponse.json({ error: text.privacyConsentRequired }, { status: 422 });
  }

  const auth =
    payload.mode === "test"
      ? await requirePermission(request, "funnels:write")
      : null;

  if (auth && !auth.ok) return auth.response;

  if (payload.mode === "live") {
    if (!canUsePublicLiveFunnel({ blueprint, request, stored })) {
      return NextResponse.json({ error: "Funnel is not published or token is invalid." }, { status: 403 });
    }

    const preflight = runFunnelPreflight(blueprint);
    if (!preflight.ok) {
      return NextResponse.json({ error: "Funnel live preflight is blocked.", preflight }, { status: 403 });
    }
  }

  const score = scoreAnswers(payload);
  const submissionId = `${payload.mode}_submission_${new Date().getTime()}`;
  const eventId = `${funnelId}_${submissionId}`;
  const session =
    payload.mode === "live" && stored
      ? createPublicFunnelSession({ blueprint, stored })
      : auth?.session;

  if (!session) {
    return NextResponse.json({ error: "Funnel session could not be resolved." }, { status: 403 });
  }

  const persistence = payload.mode === "live"
    ? await persistFunnelSubmission({
        session,
        blueprint,
        payload,
        score,
      })
    : await persistFunnelTestSubmission({
        session,
        blueprint,
        payload,
        score,
      });

  return NextResponse.json({
    ok: true,
    mode: payload.mode,
    submissionId: persistence.persisted ? (persistence.ids.submissionId ?? submissionId) : submissionId,
    eventId,
    persisted: persistence.persisted,
    persistence,
    leadPreview: {
      funnelId,
      destination: blueprint.crmHandover.destination,
      pipelineStage: blueprint.crmHandover.pipelineStage,
      score,
      createsLeadInboxEntry: blueprint.crmHandover.createLeadInboxEntry,
      createsTask: blueprint.crmHandover.createTask,
      createsAppointment: blueprint.crmHandover.createAppointment,
    },
    trackingPreview: {
      consentMode: blueprint.tracking.consentMode,
      metaPixelReady: Boolean(blueprint.tracking.metaPixelId),
      metaCapiReady: Boolean(blueprint.tracking.metaCapiToken),
      ga4Ready: Boolean(blueprint.tracking.gaMeasurementId),
      gtmReady: Boolean(blueprint.tracking.gtmId),
      webhookReady: Boolean(blueprint.tracking.webhookUrl),
    },
  });
}
