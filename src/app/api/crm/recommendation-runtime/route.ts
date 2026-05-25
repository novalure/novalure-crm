import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/session";
import { hasProductCapability } from "@/lib/product-model";
import {
  createConversionAnalyticsSnapshot,
  createDataQualityCleanupAction,
  createProductiveFollowUpAction,
  listRecommendationRuntimeSummary,
  mergeDuplicateContacts,
  recordUnitAuditEvent,
  runAnalysisBotRecommendationCompletion,
  runBulkFollowUpActions,
  runBotAnswerQualityComparison,
  runBotAnswerQualityReviews,
  runCustomerOnboardingRiskAutomation,
  runFallbackAudit,
  runModulePermissionAudit,
  upsertOfferMilestone,
  upsertViewingSlot,
} from "@/lib/db/recommendation-runtime-repositories";

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function getOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function getStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function getLeadArray(value: unknown) {
  return Array.isArray(value)
    ? value.map(getRecord).filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
}

export async function GET(request: Request) {
  const auth = await requirePermission(request, "crm:read");
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const summary = await listRecommendationRuntimeSummary({
    projectId: url.searchParams.get("projectId"),
    session: auth.session,
  });

  return NextResponse.json({ persisted: true, summary });
}

export async function POST(request: Request) {
  const auth = await requirePermission(request, "crm:write");
  if (!auth.ok) return auth.response;

  const body = getRecord(await readJson(request));
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const operation = getOptionalString(body.operation);
  if (!operation) {
    return NextResponse.json({ error: "Operation is required" }, { status: 400 });
  }

  if (
    (
      operation === "contact_merge" ||
      operation === "bot_answer_quality_reviews" ||
      operation === "complete_analysis_recommendations" ||
      operation === "customer_onboarding_risks" ||
      operation === "fallback_audit" ||
      operation === "permission_audit"
    ) &&
    !hasProductCapability(auth.session.productRole, "settings:manage")
  ) {
    return NextResponse.json({ error: "This operation requires workspace management rights" }, { status: 403 });
  }

  let result: { persisted: boolean; reason?: string } | null = null;

  if (operation === "fallback_audit") {
    result = await runFallbackAudit({
      missingTables: getStringArray(body.missingTables),
      moduleSources: (getRecord(body.moduleSources) as Record<string, string> | null) ?? undefined,
      projectId: getOptionalString(body.projectId),
      session: auth.session,
    });
  } else if (operation === "follow_up_action") {
    result = await createProductiveFollowUpAction({
      actionType: getOptionalString(body.actionType),
      channel: getOptionalString(body.channel),
      contactId: getOptionalString(body.contactId),
      email: getOptionalString(body.email),
      leadId: getOptionalString(body.leadId),
      metadata: getRecord(body.metadata),
      outcome: getOptionalString(body.outcome),
      ownerUserId: getOptionalString(body.ownerUserId),
      phone: getOptionalString(body.phone),
      projectId: getOptionalString(body.projectId),
      purpose: getOptionalString(body.purpose),
      session: auth.session,
      taskTitle: getOptionalString(body.taskTitle),
    });
  } else if (operation === "bulk_follow_up_actions") {
    result = await runBulkFollowUpActions({
      actionType: getOptionalString(body.actionType),
      leads: getLeadArray(body.leads).map((lead) => ({
        channel: getOptionalString(lead.channel),
        contactId: getOptionalString(lead.contactId),
        email: getOptionalString(lead.email),
        leadId: getOptionalString(lead.leadId),
        ownerUserId: getOptionalString(lead.ownerUserId),
        phone: getOptionalString(lead.phone),
        projectId: getOptionalString(lead.projectId),
        taskTitle: getOptionalString(lead.taskTitle),
      })),
      outcome: getOptionalString(body.outcome),
      projectId: getOptionalString(body.projectId),
      purpose: getOptionalString(body.purpose),
      session: auth.session,
    });
  } else if (operation === "viewing_slot") {
    result = await upsertViewingSlot({
      contactId: getOptionalString(body.contactId),
      dealId: getOptionalString(body.dealId),
      endsAt: getOptionalString(body.endsAt),
      leadId: getOptionalString(body.leadId),
      note: getOptionalString(body.note),
      ownerUserId: getOptionalString(body.ownerUserId),
      session: auth.session,
      slotId: getOptionalString(body.slotId),
      startsAt: getOptionalString(body.startsAt),
      status: getOptionalString(body.status),
      unitId: getOptionalString(body.unitId),
    });
  } else if (operation === "unit_audit") {
    result = await recordUnitAuditEvent({
      after: getRecord(body.after),
      before: getRecord(body.before),
      eventType: getOptionalString(body.eventType),
      reason: getOptionalString(body.reason),
      session: auth.session,
      unitId: getOptionalString(body.unitId),
    });
  } else if (operation === "offer_milestone") {
    result = await upsertOfferMilestone({
      completedAt: getOptionalString(body.completedAt),
      contactId: getOptionalString(body.contactId),
      dealId: getOptionalString(body.dealId),
      dueAt: getOptionalString(body.dueAt),
      metadata: getRecord(body.metadata),
      milestone: getOptionalString(body.milestone),
      ownerUserId: getOptionalString(body.ownerUserId),
      reason: getOptionalString(body.reason),
      reservationId: getOptionalString(body.reservationId),
      session: auth.session,
      status: getOptionalString(body.status),
      unitId: getOptionalString(body.unitId),
    });
  } else if (operation === "bot_answer_quality") {
    result = await runBotAnswerQualityComparison({
      botId: getOptionalString(body.botId),
      projectId: getOptionalString(body.projectId),
      session: auth.session,
    });
  } else if (operation === "bot_answer_quality_reviews") {
    result = await runBotAnswerQualityReviews({
      botId: getOptionalString(body.botId),
      projectId: getOptionalString(body.projectId),
      session: auth.session,
    });
  } else if (operation === "conversion_snapshot") {
    result = await createConversionAnalyticsSnapshot({
      from: getOptionalString(body.from),
      projectId: getOptionalString(body.projectId),
      session: auth.session,
      to: getOptionalString(body.to),
    });
  } else if (operation === "customer_onboarding_risks") {
    result = await runCustomerOnboardingRiskAutomation({
      projectId: getOptionalString(body.projectId),
      session: auth.session,
    });
  } else if (operation === "data_quality_cleanup") {
    result = await createDataQualityCleanupAction({
      actionType: getOptionalString(body.actionType),
      contactId: getOptionalString(body.contactId),
      duplicateContactId: getOptionalString(body.duplicateContactId),
      issueId: getOptionalString(body.issueId),
      leadId: getOptionalString(body.leadId),
      ownerUserId: getOptionalString(body.ownerUserId),
      reason: getOptionalString(body.reason),
      session: auth.session,
      status: getOptionalString(body.status),
    });
  } else if (operation === "contact_merge") {
    result = await mergeDuplicateContacts({
      duplicateContactId: getOptionalString(body.duplicateContactId),
      primaryContactId: getOptionalString(body.primaryContactId) ?? getOptionalString(body.contactId),
      reason: getOptionalString(body.reason),
      session: auth.session,
    });
  } else if (operation === "permission_audit") {
    result = await runModulePermissionAudit({
      projectId: getOptionalString(body.projectId),
      session: auth.session,
    });
  } else if (operation === "complete_analysis_recommendations") {
    result = await runAnalysisBotRecommendationCompletion({
      missingTables: getStringArray(body.missingTables),
      moduleSources: (getRecord(body.moduleSources) as Record<string, string> | null) ?? undefined,
      projectId: getOptionalString(body.projectId),
      session: auth.session,
    });
  }

  if (!result) {
    return NextResponse.json({ error: "Unsupported operation" }, { status: 400 });
  }

  if (!result.persisted) {
    const reason = result.reason ?? "Operation could not be persisted";
    const status = reason.toLowerCase().includes("database_url") ? 503 : 400;
    return NextResponse.json({ error: reason, persisted: false }, { status });
  }

  return NextResponse.json(result);
}
