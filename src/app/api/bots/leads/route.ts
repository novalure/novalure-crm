import { requirePermission } from "@/lib/auth/session";
import {
  createApprovalRequest,
  insertLeadWorkflowRun,
  listLeadWorkflowRuns,
  writeAuditLog,
} from "@/lib/db/runtime-repositories";
import { getApiSystemCopy, resolveRequestLanguage } from "@/lib/i18n";

export const maxDuration = 60;

type LeadRequest = {
  name?: unknown;
  email?: unknown;
  company?: unknown;
  website?: unknown;
  need?: unknown;
  budget?: unknown;
  timeline?: unknown;
  source?: unknown;
};

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function scoreLead(lead: LeadRequest) {
  const budget = String(lead.budget || "").toLowerCase();
  const timeline = String(lead.timeline || "").toLowerCase();
  const need = String(lead.need || "").toLowerCase();
  let score = 45;

  if (budget.includes("450") || budget.includes("500") || budget.includes("20")) score += 20;
  if (timeline.includes("now") || timeline.includes("sofort") || timeline.includes("this month")) score += 18;
  if (need.includes("buy") || need.includes("investment") || need.includes("crm") || need.includes("kaufen")) score += 12;

  return Math.min(100, score);
}

export async function GET(request: Request) {
  const auth = await requirePermission(request, "workflows:run");

  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const statusParam = url.searchParams.get("status");
  const status =
    statusParam === "running" ||
    statusParam === "approval_required" ||
    statusParam === "completed" ||
    statusParam === "failed"
      ? statusParam
      : "all";
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 25)));
  const runs = await listLeadWorkflowRuns({
    session: auth.session,
    status,
    limit,
  });

  return Response.json({
    source: "database",
    counts: {
      runs: runs.length,
      approvalRequired: runs.filter((run) => run.status === "approval_required").length,
      completed: runs.filter((run) => run.status === "completed").length,
      failed: runs.filter((run) => run.status === "failed").length,
    },
    runs,
  });
}

export async function POST(request: Request) {
  const language = resolveRequestLanguage(request);
  const copy = getApiSystemCopy(language);
  const auth = await requirePermission(request, "workflows:run");

  if (!auth.ok) return auth.response;

  const body = await readJson(request);

  if (!body || typeof body !== "object") {
    return Response.json({ error: copy.invalidJson }, { status: 400 });
  }

  const lead = "lead" in body && typeof body.lead === "object" && body.lead ? body.lead as LeadRequest : null;

  if (!lead || !String(lead.name || "").trim() || !String(lead.need || "").trim()) {
    return Response.json({ error: copy.leadRequired }, { status: 400 });
  }

  const requireHumanApproval = "requireHumanApproval" in body ? Boolean(body.requireHumanApproval) : false;
  const score = scoreLead(lead);
  const qualification =
    score >= 80 ? "qualified" : score >= 62 ? "follow_up" : score >= 45 ? "nurture" : "disqualified";
  const leadName = String(lead.name);
  const company = String(lead.company || "unknown company");
  const workflowSteps = [
    "capture",
    "research",
    "qualify",
    "draft_email",
    ...(requireHumanApproval ? ["human_approval"] : []),
    "create_deal",
    "handoff",
  ];
  const result = {
    qualification,
    score,
    reasoning:
      language === "de"
        ? "Deterministischer CRM-Pre-Check nach Bedarf, Budget und Zeitplan. Externe KI kann über denselben Vertrag angebunden werden."
        : "Deterministic CRM pre-check based on need, budget and timeline. External AI execution can be attached behind this contract.",
    researchBrief: `${leadName} from ${company}: ${String(lead.need)}.`,
    recommendedOwner: score >= 80 ? "Sales Graz" : "Customer Success",
    nextAction:
      language === "de"
        ? score >= 80
        ? "Follow-up-Entwurf prüfen und Termin vorschlagen."
          : "Eine qualifizierende Rückfrage stellen."
        : score >= 80
          ? "Review follow-up draft and propose a meeting."
          : "Ask one qualifying follow-up question.",
    emailDraft: {
      subject:
        language === "de"
          ? `Nächster Schritt für ${leadName}`
          : `Next step for ${leadName}`,
      body:
        language === "de"
          ? `Hallo ${leadName}, danke für den Kontext. Auf Basis Ihrer Anfrage schlage ich ein kurzes Follow-up vor, um Fit und nächste Schritte zu bestätigen.`
          : `Hello ${leadName}, thank you for the context. Based on your request, I suggest a short follow-up to confirm fit and next steps.`,
      requiresApproval: requireHumanApproval,
    },
    auditEvents: ["lead.captured", "lead.researched", "lead.scored", "email.draft_created"],
  };
  const workflowRunId = await insertLeadWorkflowRun({
    session: auth.session,
    projectId: "projectId" in body && typeof body.projectId === "string" ? body.projectId : null,
    workflowId: "workflowId" in body && typeof body.workflowId === "string" ? body.workflowId : null,
    leadId: "leadId" in body && typeof body.leadId === "string" ? body.leadId : null,
    status: requireHumanApproval ? "approval_required" : "completed",
    workflowName: "Lead qualification and follow-up",
    workflowSteps,
    workflowTrigger: "manual",
    humanApprovalRequired: requireHumanApproval,
    input: lead,
    result,
    auditEvents: result.auditEvents,
  });
  const approvalId = requireHumanApproval
    ? await createApprovalRequest({
        session: auth.session,
        projectId: "projectId" in body && typeof body.projectId === "string" ? body.projectId : null,
        entityType: "lead_workflow_run",
        entityId: workflowRunId,
        action: "lead_automation.follow_up.approve",
        summary:
          language === "de"
            ? `Follow-up für ${leadName} freigeben`
            : `Approve follow-up for ${leadName}`,
        payload: { lead, result },
      })
    : null;

  await writeAuditLog({
    session: auth.session,
    action: "lead_automation.workflow.completed",
    entityType: "lead_workflow_run",
    entityId: workflowRunId,
    after: { qualification, score, approvalId },
  });

  return Response.json({
    workflowRunId: workflowRunId ?? crypto.randomUUID(),
    workflowId: workflowRunId,
    approvalId,
    persisted: Boolean(workflowRunId),
    status: requireHumanApproval ? "approval_required" : "completed",
    steps: workflowSteps,
    result,
  });
}
