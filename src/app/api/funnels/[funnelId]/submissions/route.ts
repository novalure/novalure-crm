import { NextResponse } from "next/server";
import { findFunnelBlueprint } from "@/lib/funnel-builder-adapter";
import { funnelSteps, funnels, projects, users } from "@/lib/crm-data";
import type { FunnelSubmissionPayload } from "@/lib/funnel-schema";

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

export async function POST(request: Request, context: RouteContext) {
  const { funnelId } = await context.params;
  const blueprint = findFunnelBlueprint(funnelId, { funnels, projects, steps: funnelSteps, users });

  if (!blueprint) {
    return NextResponse.json({ error: "Funnel not found" }, { status: 404 });
  }

  let payload: FunnelSubmissionPayload;
  try {
    payload = (await request.json()) as FunnelSubmissionPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (payload.funnelId !== funnelId) {
    return NextResponse.json({ error: "Funnel mismatch" }, { status: 400 });
  }

  if (!hasRequiredConsent(payload)) {
    return NextResponse.json({ error: "Privacy consent required" }, { status: 422 });
  }

  const score = scoreAnswers(payload);
  const submissionId = `${payload.mode}_submission_${Date.now()}`;
  const eventId = `${funnelId}_${submissionId}`;

  return NextResponse.json({
    ok: true,
    mode: payload.mode,
    submissionId,
    eventId,
    persisted: payload.mode === "live" ? "pending-db" : false,
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
