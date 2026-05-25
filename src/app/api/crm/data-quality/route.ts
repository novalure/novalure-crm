import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/session";
import {
  createDataQualityActionTask,
  listOpenDataQualityIssues,
  syncDataQualityIssues,
  updateDataQualityIssueStatus,
  type DataQualityActionId,
  type DataQualityIssueInput,
} from "@/lib/db/data-quality-repositories";

const dataQualityActions = new Set<DataQualityActionId>([
  "checkConsent",
  "closeLead",
  "completeContact",
  "notifyOwner",
]);

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const auth = await requirePermission(request, "crm:read");
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const issues = await listOpenDataQualityIssues({
    projectId: url.searchParams.get("projectId"),
    session: auth.session,
  });

  return NextResponse.json({ issues, persisted: true });
}

export async function POST(request: Request) {
  const auth = await requirePermission(request, "crm:write");
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const operation = typeof input.operation === "string" ? input.operation : "sync";

  if (operation === "sync") {
    const issues = Array.isArray(input.issues)
      ? input.issues.filter(isIssueInput)
      : [];
    const result = await syncDataQualityIssues({ issues, session: auth.session });

    if (!result.persisted) {
      return NextResponse.json({ error: result.reason }, { status: 503 });
    }

    return NextResponse.json({ issues: result.issues, persisted: true });
  }

  if (operation === "resolve" || operation === "ignore") {
    const issue = isIssueInput(input.issue) ? input.issue : null;
    if (!issue) {
      return NextResponse.json({ error: "Issue is required" }, { status: 400 });
    }

    const result = await updateDataQualityIssueStatus({
      issue,
      session: auth.session,
      status: operation === "resolve" ? "resolved" : "ignored",
    });

    if (!result.persisted) {
      return NextResponse.json({ error: result.reason }, { status: 503 });
    }

    return NextResponse.json({ issue: result.issue, persisted: true });
  }

  if (operation === "action") {
    const actionId = typeof input.actionId === "string" ? input.actionId : "";
    const issue = isIssueInput(input.issue) ? input.issue : null;
    if (!issue || !dataQualityActions.has(actionId as DataQualityActionId)) {
      return NextResponse.json({ error: "Action and issue are required" }, { status: 400 });
    }

    const result = await createDataQualityActionTask({
      actionId: actionId as DataQualityActionId,
      actionLabel: typeof input.actionLabel === "string" ? input.actionLabel : actionId,
      issue,
      session: auth.session,
    });

    if (!result.persisted) {
      return NextResponse.json({ error: result.reason }, { status: 503 });
    }

    return NextResponse.json({
      issue: result.issue,
      persisted: true,
      taskId: result.taskId,
    });
  }

  return NextResponse.json({ error: "Unsupported operation" }, { status: 400 });
}

function isIssueInput(value: unknown): value is DataQualityIssueInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const issue = value as Record<string, unknown>;
  return typeof issue.entityType === "string" && typeof issue.issueType === "string";
}
