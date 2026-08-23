import type { AppSession } from "@/lib/auth/session";
import {
  assertQaResetWorkspaceAllowlisted,
  isUuid,
  resolveQaResetWorkspaceAllowlist,
} from "@/lib/qa-reset-contract";
import { evaluateLaunchScope } from "@/lib/launch-scope";

export const qaBatchHeader = "x-novalure-qa-batch-id";
export const qaBatchRegistrationHeader = "x-novalure-qa-batch-registration";
export const qaBatchCapabilityVersion = 2 as const;
export const qaPublicRuntimeAtomicSurfaces = Object.freeze({
  blueprint: true,
  formPublicSubmit: true,
  formUpsert: true,
  funnelCreate: true,
  funnelPublicSubmit: true,
  reset: true,
  tokenRotation: true,
});

export type QaBatchRegistrationStatus = "already-registered" | "committed";

export type QaRuntimeDatabaseTarget = Readonly<{
  branchId: string;
  databaseName: string;
  projectId: string;
  role: "novalure_app";
}>;

export class QaBatchRuntimeError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "QaBatchRuntimeError";
    this.code = code;
    this.status = status;
  }
}

function qaBatchRuntimeConfig(env: NodeJS.ProcessEnv) {
  if (env.VERCEL_ENV?.trim().toLowerCase() !== "preview") {
    throw new QaBatchRuntimeError(
      "QA_BATCH_PREVIEW_REQUIRED",
      "QA batch registration is available only in an isolated Preview runtime",
      403,
    );
  }
  if (env.NOVALURE_QA_BATCH_REGISTRATION_ENABLED?.trim().toLowerCase() !== "true") {
    throw new QaBatchRuntimeError(
      "QA_BATCH_REGISTRATION_DISABLED",
      "QA batch registration is not explicitly enabled",
      503,
    );
  }

  let allowlistedWorkspaceIds: ReadonlySet<string>;
  try {
    allowlistedWorkspaceIds = resolveQaResetWorkspaceAllowlist(env);
  } catch {
    throw new QaBatchRuntimeError(
      "QA_BATCH_ISOLATION_INVALID",
      "QA batch workspace isolation is not configured",
      503,
    );
  }

  const gitSha = env.VERCEL_GIT_COMMIT_SHA?.trim().toLowerCase() ?? "";
  if (!/^[a-f0-9]{40}$/.test(gitSha)) {
    throw new QaBatchRuntimeError(
      "QA_BATCH_GIT_SHA_INVALID",
      "The Preview candidate SHA is unavailable",
      503,
    );
  }

  return { allowlistedWorkspaceIds, gitSha };
}

export function resolveQaRuntimeDatabaseTarget(
  env: NodeJS.ProcessEnv = process.env,
): QaRuntimeDatabaseTarget {
  const projectId = env.NOVALURE_QA_PROJECT_ID?.trim() ?? "";
  const branchId = env.NOVALURE_QA_BRANCH_ID?.trim() ?? "";
  const databaseName = env.NOVALURE_QA_DATABASE_NAME?.trim() ?? "";
  const role = env.NOVALURE_QA_DATABASE_ROLE?.trim() ?? "";
  const productionProjectId = env.NOVALURE_PRODUCTION_PROJECT_ID?.trim() ?? "";
  const productionBranchId = env.NOVALURE_PRODUCTION_BRANCH_ID?.trim() ?? "";
  if (
    !/^[-A-Za-z0-9]{8,80}$/.test(projectId)
    || !/^br-[-A-Za-z0-9]{8,128}$/.test(branchId)
    || !/^[A-Za-z0-9_][A-Za-z0-9_-]{0,62}$/.test(databaseName)
    || role !== "novalure_app"
  ) {
    throw new QaBatchRuntimeError(
      "QA_BATCH_DATABASE_TARGET_INVALID",
      "The exact Preview database target is unavailable",
      503,
    );
  }
  if (
    !/^[-A-Za-z0-9]{8,80}$/.test(productionProjectId)
    || !/^br-[-A-Za-z0-9]{8,128}$/.test(productionBranchId)
    || projectId === productionProjectId
    || branchId === productionBranchId
  ) {
    throw new QaBatchRuntimeError(
      "QA_BATCH_DATABASE_ISOLATION_INVALID",
      "The Preview database target is not isolated from Production",
      503,
    );
  }
  return Object.freeze({ branchId, databaseName, projectId, role: "novalure_app" });
}

export function resolveQaBatchCapabilityConfig(env: NodeJS.ProcessEnv = process.env) {
  const config = qaBatchRuntimeConfig(env);
  const databaseTarget = resolveQaRuntimeDatabaseTarget(env);
  const deploymentId = env.VERCEL_DEPLOYMENT_ID?.trim() ?? "";
  if (!/^dpl_[A-Za-z0-9]{20,80}$/.test(deploymentId)) {
    throw new QaBatchRuntimeError(
      "QA_BATCH_DEPLOYMENT_ID_INVALID",
      "The exact Preview deployment id is unavailable",
      503,
    );
  }
  const deploymentHost = env.VERCEL_URL?.trim().toLowerCase() ?? "";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.vercel\.app$/.test(deploymentHost)) {
    throw new QaBatchRuntimeError(
      "QA_BATCH_DEPLOYMENT_HOST_INVALID",
      "The exact Preview deployment host is unavailable",
      503,
    );
  }
  const gitBranch = env.VERCEL_GIT_COMMIT_REF?.trim() ?? "";
  if (!gitBranch || gitBranch.length > 250 || /[\u0000-\u001f\u007f]/.test(gitBranch)) {
    throw new QaBatchRuntimeError(
      "QA_BATCH_GIT_BRANCH_INVALID",
      "The Preview candidate branch is unavailable",
      503,
    );
  }
  return { ...config, databaseTarget, deploymentHost, deploymentId, gitBranch };
}

export function readQaBatchMutationHeader(
  request: Request,
  session: AppSession,
  env: NodeJS.ProcessEnv = process.env,
) {
  const rawBatchId = request.headers.get(qaBatchHeader)?.trim();
  if (!rawBatchId) return null;
  if (!isUuid(rawBatchId)) {
    throw new QaBatchRuntimeError("QA_BATCH_ID_INVALID", "Invalid QA batch id", 400);
  }
  if (session.source !== "cookie") {
    throw new QaBatchRuntimeError(
      "QA_BATCH_COOKIE_SESSION_REQUIRED",
      "QA batch mutations require a persisted cookie session",
      403,
    );
  }
  if (!isUuid(session.workspaceId) || !isUuid(session.userId)) {
    throw new QaBatchRuntimeError("QA_BATCH_SESSION_INVALID", "Invalid QA batch session scope", 403);
  }
  if (!evaluateLaunchScope("qaBatchMutation", session).allowed) {
    throw new QaBatchRuntimeError(
      "QA_BATCH_LAUNCH_SCOPE_DENIED",
      "QA batch mutation is outside the approved launch scope",
      403,
    );
  }

  const config = resolveQaBatchCapabilityConfig(env);
  try {
    assertQaResetWorkspaceAllowlisted(session.workspaceId, config.allowlistedWorkspaceIds);
  } catch {
    throw new QaBatchRuntimeError(
      "QA_BATCH_WORKSPACE_NOT_ALLOWLISTED",
      "QA batch workspace is not allowlisted",
      403,
    );
  }

  return rawBatchId.toLowerCase();
}

export function qaBatchRuntimeErrorResponse(error: unknown) {
  if (!(error instanceof QaBatchRuntimeError)) return null;
  return Response.json(
    { code: error.code, error: error.message },
    {
      headers: {
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
      status: error.status,
    },
  );
}

export function qaBatchSuccessHeaders(batchId: string | null, status?: QaBatchRegistrationStatus) {
  if (!batchId || !status) return undefined;
  return {
    [qaBatchHeader]: batchId,
    [qaBatchRegistrationHeader]: status,
  };
}
