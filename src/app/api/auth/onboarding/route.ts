import { NextResponse } from "next/server";
import { getRequestSession } from "@/lib/auth/session";
import { executeQuery, hasDatabaseUrl, queryOne } from "@/lib/db/client";
import {
  getNextOnboardingStepId,
  getOnboardingAudience,
  getOnboardingSteps,
  normalizeOnboardingStepId,
  type OnboardingStepId,
} from "@/lib/onboarding-checklist";
import type { LanguageCode } from "@/lib/i18n";

type OnboardingRow = {
  completedAt: string | null;
  completedStepIds: string[] | null;
  currentStepId: string | null;
  dismissedAt: string | null;
  roleContext: string | null;
  skippedStepIds: string[] | null;
};

type OnboardingAction = "complete_all" | "complete_step" | "dismiss" | "skip_step" | "start";

function unique(values: string[]) {
  return [...new Set(values)];
}

function without(values: string[], value: string) {
  return values.filter((item) => item !== value);
}

function isOnboardingAction(value: unknown): value is OnboardingAction {
  return (
    value === "complete_all" ||
    value === "complete_step" ||
    value === "dismiss" ||
    value === "skip_step" ||
    value === "start"
  );
}

async function getOnboardingRow(userId: string, workspaceId: string) {
  return queryOne<OnboardingRow>(
    `
      select
        onboarding_completed_at as "completedAt",
        onboarding_current_step as "currentStepId",
        onboarding_completed_steps as "completedStepIds",
        onboarding_skipped_steps as "skippedStepIds",
        onboarding_dismissed_at as "dismissedAt",
        onboarding_role_context as "roleContext"
      from workspace_users
      where id = $1::uuid
        and workspace_id = $2::uuid
      limit 1
    `,
    [userId, workspaceId],
  );
}

function serializeProgress(
  row: OnboardingRow | null,
  allowedStepIds: OnboardingStepId[],
  fallbackCurrentStepId: OnboardingStepId,
  roleContext: string,
) {
  const completedStepIds = (row?.completedStepIds ?? []).filter((stepId) => allowedStepIds.includes(stepId as OnboardingStepId));
  const skippedStepIds = (row?.skippedStepIds ?? []).filter((stepId) => allowedStepIds.includes(stepId as OnboardingStepId));
  const currentStepId =
    row?.currentStepId && allowedStepIds.includes(row.currentStepId as OnboardingStepId)
      ? row.currentStepId as OnboardingStepId
      : fallbackCurrentStepId;

  return {
    completedAt: row?.completedAt ?? null,
    completedStepIds,
    currentStepId,
    dismissedAt: row?.dismissedAt ?? null,
    roleContext: row?.roleContext ?? roleContext,
    skippedStepIds,
    source: "database" as const,
  };
}

async function readBody(request: Request) {
  try {
    return await request.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function GET(request: Request) {
  const session = await getRequestSession(request);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!hasDatabaseUrl()) {
    return NextResponse.json({ completedAt: null, source: "fallback" });
  }

  try {
    const steps = getOnboardingSteps(session.productRole, session.role, "de");
    const allowedStepIds = steps.map((step) => step.id);
    const row = await getOnboardingRow(session.userId, session.workspaceId);
    const completedStepIds = row?.completedStepIds ?? [];
    const skippedStepIds = row?.skippedStepIds ?? [];
    const currentStepId = getNextOnboardingStepId(steps, completedStepIds, skippedStepIds);

    return NextResponse.json(
      serializeProgress(
        row,
        allowedStepIds,
        currentStepId,
        getOnboardingAudience(session.productRole, session.role),
      ),
    );
  } catch {
    return NextResponse.json({ completedAt: null, source: "migration_pending" });
  }
}

export async function POST(request: Request) {
  const session = await getRequestSession(request);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!hasDatabaseUrl()) {
    return NextResponse.json({ completedAt: new Date().toISOString(), persisted: false, source: "fallback" });
  }

  const body = await readBody(request);
  const action = isOnboardingAction(body.action) ? body.action : "complete_all";
  const language: LanguageCode = body.language === "en" ? "en" : "de";
  const steps = getOnboardingSteps(session.productRole, session.role, language);
  const allowedStepIds = steps.map((step) => step.id);
  const roleContext = getOnboardingAudience(session.productRole, session.role);
  const requestedStepId = normalizeOnboardingStepId(body.stepId, allowedStepIds);

  if ((action === "complete_step" || action === "skip_step" || action === "start") && !requestedStepId) {
    return NextResponse.json({ error: "onboarding_step_forbidden" }, { status: 403 });
  }

  const requestedStep = requestedStepId ? steps.find((step) => step.id === requestedStepId) : null;
  if (action === "skip_step" && requestedStep && !requestedStep.canSkip) {
    return NextResponse.json({ error: "onboarding_step_required" }, { status: 409 });
  }

  try {
    const existing = await getOnboardingRow(session.userId, session.workspaceId);
    let completedStepIds = (existing?.completedStepIds ?? []).filter((stepId) => allowedStepIds.includes(stepId as OnboardingStepId));
    let skippedStepIds = (existing?.skippedStepIds ?? []).filter((stepId) => allowedStepIds.includes(stepId as OnboardingStepId));
    let currentStepId: OnboardingStepId =
      existing?.currentStepId && allowedStepIds.includes(existing.currentStepId as OnboardingStepId)
        ? existing.currentStepId as OnboardingStepId
        : getNextOnboardingStepId(steps, completedStepIds, skippedStepIds);
    const shouldDismiss = action === "dismiss";
    const shouldCompleteAll = action === "complete_all";

    if (action === "start" && requestedStepId) {
      currentStepId = requestedStepId;
    }

    if (action === "skip_step" && requestedStepId) {
      skippedStepIds = unique([...skippedStepIds, requestedStepId]);
      completedStepIds = without(completedStepIds, requestedStepId);
      currentStepId = getNextOnboardingStepId(steps, completedStepIds, skippedStepIds);
    }

    if (action === "complete_step" && requestedStepId) {
      completedStepIds = unique([...completedStepIds, requestedStepId]);
      skippedStepIds = without(skippedStepIds, requestedStepId);
      currentStepId = getNextOnboardingStepId(steps, completedStepIds, skippedStepIds);
    }

    if (shouldCompleteAll) {
      completedStepIds = allowedStepIds;
      skippedStepIds = [];
      currentStepId = "finish";
    }

    const shouldComplete =
      shouldCompleteAll ||
      (action === "complete_step" && requestedStepId === "finish");

    await executeQuery(
      `
        update workspace_users
        set onboarding_current_step = $3,
            onboarding_completed_steps = $4::text[],
            onboarding_skipped_steps = $5::text[],
            onboarding_role_context = $6,
            onboarding_dismissed_at = case when $7::boolean then now() else onboarding_dismissed_at end,
            onboarding_completed_at = case when $8::boolean then coalesce(onboarding_completed_at, now()) else onboarding_completed_at end,
            updated_at = now()
        where id = $1::uuid
          and workspace_id = $2::uuid
      `,
      [
        session.userId,
        session.workspaceId,
        currentStepId,
        completedStepIds,
        skippedStepIds,
        roleContext,
        shouldDismiss,
        shouldComplete,
      ],
    );
    const row = await getOnboardingRow(session.userId, session.workspaceId);

    return NextResponse.json({
      ...serializeProgress(row, allowedStepIds, currentStepId, roleContext),
      persisted: true,
    });
  } catch {
    return NextResponse.json(
      { error: "onboarding_not_persisted", persisted: false, source: "migration_pending" },
      { status: 503 },
    );
  }
}
