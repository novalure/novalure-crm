import { createHash } from "node:crypto";
import { getRequestSession } from "@/lib/auth/session";
import { writeAuthAuditEvent } from "@/lib/auth/auth-audit";
import { runQaBatchReset, QaResetGuardError } from "@/lib/db/qa-reset-repository";
import {
  assertQaResetExecutionAuthorized,
  assertQaResetWorkspaceAllowlisted,
  canAdministerQaReset,
  parseQaResetRequest,
  QaResetContractError,
  resolveQaResetWorkspaceAllowlist,
  type QaResetRequest,
} from "@/lib/qa-reset-contract";
import { enforceCsrfForSession } from "@/lib/security/csrf";

export const runtime = "nodejs";

const privateHeaders = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};
const maximumPayloadBytes = 4_096;

function targetFingerprint(request: QaResetRequest | null) {
  if (!request) return null;
  return createHash("sha256")
    .update(`${request.workspaceId}\0${request.batchId}`)
    .digest("hex")
    .slice(0, 24);
}

async function recordBlockedAttempt(input: {
  code: string;
  parsedRequest: QaResetRequest | null;
  request: Request;
  session: NonNullable<Awaited<ReturnType<typeof getRequestSession>>>;
}) {
  await writeAuthAuditEvent({
    authIdentityId: input.session.authIdentityId ?? null,
    eventType: "qa_reset.blocked",
    metadata: {
      mode: input.parsedRequest?.mode ?? null,
      reason: input.code,
      targetFingerprint: targetFingerprint(input.parsedRequest),
    },
    outcome: "blocked",
    request: input.request,
    sessionId: input.session.authSessionId ?? null,
    workspaceId: input.session.workspaceId,
    workspaceUserId: input.session.userId,
  });
}

function json(body: unknown, status = 200) {
  return Response.json(body, { headers: privateHeaders, status });
}

export async function POST(request: Request) {
  const session = await getRequestSession(request);
  if (!session) return json({ error: "Unauthorized" }, 401);

  const csrf = await enforceCsrfForSession(request, session);
  if (!csrf.ok) return csrf.response;

  if (!canAdministerQaReset(session)) {
    return json({ error: "Forbidden" }, 403);
  }

  let parsedRequest: QaResetRequest | null = null;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > maximumPayloadBytes) {
      throw new QaResetContractError("invalid_payload", "QA reset payload is too large");
    }
    parsedRequest = parseQaResetRequest(text ? JSON.parse(text) : {});
  } catch (error) {
    const code = error instanceof QaResetContractError ? error.code : "invalid_payload";
    try {
      await recordBlockedAttempt({ code, parsedRequest, request, session });
    } catch {
      return json({ error: "QA reset audit unavailable" }, 503);
    }
    return json({ code, error: "Invalid QA reset request" }, 400);
  }

  try {
    const allowlistedWorkspaceIds = resolveQaResetWorkspaceAllowlist();
    assertQaResetWorkspaceAllowlisted(parsedRequest.workspaceId, allowlistedWorkspaceIds);
    assertQaResetExecutionAuthorized(parsedRequest);

    const result = await runQaBatchReset({
      actorId: session.userId,
      allowlistedWorkspaceIds,
      batchId: parsedRequest.batchId,
      mode: parsedRequest.mode,
      workspaceId: parsedRequest.workspaceId,
    });

    return json(
      {
        auditEventId: result.auditEventId,
        deletedCounts: result.deletedCounts,
        mode: result.mode,
        outcome: result.outcome,
        plan: result.plan,
      },
      result.outcome === "blocked" ? 409 : 200,
    );
  } catch (error) {
    if (error instanceof QaResetContractError || error instanceof QaResetGuardError) {
      try {
        await recordBlockedAttempt({ code: error.code, parsedRequest, request, session });
      } catch {
        return json({ error: "QA reset audit unavailable" }, 503);
      }
      const configurationError =
        error instanceof QaResetContractError &&
        (error.code === "qa_allowlist_not_configured" ||
          error.code === "qa_allowlist_too_small" ||
          error.code === "qa_production_allowlist_overlap");
      return json(
        { code: error.code, error: configurationError ? "QA reset is not safely configured" : "QA reset rejected" },
        configurationError ? 503 : 403,
      );
    }

    return json({ error: "QA reset unavailable" }, 503);
  }
}
