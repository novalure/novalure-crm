import { requirePermission } from "@/lib/auth/session";
import { createApprovalRequest, insertCallInsight, writeAuditLog } from "@/lib/db/runtime-repositories";
import { getApiSystemCopy, resolveRequestLanguage } from "@/lib/i18n";

export const maxDuration = 60;

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function splitActionItems(transcript: string) {
  const lower = transcript.toLowerCase();
  const items = ["Send follow-up summary"];

  if (lower.includes("demo") || lower.includes("besichtigung")) items.push("Offer appointment window");
  if (lower.includes("financing") || lower.includes("finanzierung")) items.push("Confirm financing status");
  if (lower.includes("decision") || lower.includes("entscheider")) items.push("Identify decision maker");

  return items.slice(0, 4).map((title, index) => ({
    title,
    owner: index === 0 ? "Franz" : "Sales Graz",
    priority: index === 0 ? "high" : "normal",
  }));
}

export async function POST(request: Request) {
  const language = resolveRequestLanguage(request);
  const copy = getApiSystemCopy(language);
  const auth = await requirePermission(request, "bots:run");

  if (!auth.ok) return auth.response;

  const body = await readJson(request);

  if (!body || typeof body !== "object") {
    return Response.json({ error: copy.invalidJson }, { status: 400 });
  }

  const transcript = String("transcript" in body ? body.transcript : "").trim();

  if (transcript.length < 20) {
    return Response.json({ error: copy.transcriptRequired }, { status: 400 });
  }

  const lower = transcript.toLowerCase();
  const sentiment = lower.includes("urgent") || lower.includes("dringend") ? "high_interest" : "neutral";
  const requireHumanApproval = "requireHumanApproval" in body ? Boolean(body.requireHumanApproval) : false;
  const result = {
    summary: transcript.slice(0, 260),
    sentiment,
    objections: [
      lower.includes("price") || lower.includes("preis") ? "Price or ROI needs clarification" : "Decision criteria need clarification",
      lower.includes("privacy") || lower.includes("datenschutz") ? "Privacy and data processing need confirmation" : "Timeline needs confirmation",
    ],
    actionItems: splitActionItems(transcript),
    dealSignals: [
      lower.includes("budget") ? "Budget mentioned" : "Budget not confirmed",
      lower.includes("second call") || lower.includes("zweiter call") ? "Second call requested" : "Follow-up required",
    ],
    crmUpdates: [
      { entity: "note", field: "call_summary", value: transcript.slice(0, 140), requiresApproval: false },
      { entity: "task", field: "next_action", value: "Review call insights", requiresApproval: requireHumanApproval },
    ],
    knowledgeGaps: lower.includes("financing") || lower.includes("finanzierung")
      ? ["Approved financing answer is missing"]
      : ["No knowledge gap detected"],
  };
  const storedAnalysisId = await insertCallInsight({
    session: auth.session,
    projectId: "projectId" in body && typeof body.projectId === "string" ? body.projectId : null,
    contactId: "contactId" in body && typeof body.contactId === "string" ? body.contactId : null,
    leadId: "leadId" in body && typeof body.leadId === "string" ? body.leadId : null,
    source: String("source" in body ? body.source : "Manual"),
    transcript,
    summary: result.summary,
    sentiment: result.sentiment,
    objections: result.objections,
    actionItems: result.actionItems,
    dealSignals: result.dealSignals,
    crmUpdates: result.crmUpdates,
    knowledgeGaps: result.knowledgeGaps,
    metadata: { language },
  });
  const analysisId = storedAnalysisId ?? crypto.randomUUID();
  const approvalId = requireHumanApproval
    ? await createApprovalRequest({
        session: auth.session,
        projectId: "projectId" in body && typeof body.projectId === "string" ? body.projectId : null,
        entityType: "call_insight",
        entityId: analysisId,
        action: "call_intelligence.crm_updates.approve",
        summary:
          language === "de"
            ? "CRM-Updates aus Call Intelligence prüfen"
            : "Review CRM updates from call intelligence",
        payload: { result },
      })
    : null;

  await writeAuditLog({
    session: auth.session,
    action: "call_intelligence.analysis.completed",
    entityType: "call_insight",
    entityId: analysisId,
    after: { approvalId, requireHumanApproval, sentiment },
  });

  return Response.json({
    analysisId,
    status: requireHumanApproval ? "ready_for_review" : "completed",
    persisted: Boolean(storedAnalysisId),
    approvalId,
    source: "source" in body ? body.source : "Manual",
    result,
  });
}
