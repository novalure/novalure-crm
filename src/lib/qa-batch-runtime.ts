import type { AppSession } from "@/lib/auth/session";
import {
  assertQaResetWorkspaceAllowlisted,
  isUuid,
  resolveQaResetWorkspaceAllowlist,
} from "@/lib/qa-reset-contract";
import { evaluateLaunchScope } from "@/lib/launch-scope";

export const qaBatchHeader = "x-novalure-qa-batch-id";
export const qaBatchRegistrationHeader = "x-novalure-qa-batch-registration";
export const qaBatchCapabilityVersion = 1 as const;

export type QaBatchRegistrationStatus = "already-registered" | "committed";

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

export function resolveQaBatchCapabilityConfig(env: NodeJS.ProcessEnv = process.env) {
  return qaBatchRuntimeConfig(env);
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

  const config = qaBatchRuntimeConfig(env);
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
