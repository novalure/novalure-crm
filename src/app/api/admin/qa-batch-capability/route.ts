import { getRequestSession } from "@/lib/auth/session";
import { canAdministerQaReset, isUuid } from "@/lib/qa-reset-contract";
import { withTenantTransaction } from "@/lib/db/tenant-client";
import { evaluateLaunchScope } from "@/lib/launch-scope";
import {
  qaBatchCapabilityVersion,
  qaBatchHeader,
  qaPublicRuntimeAtomicSurfaces,
  qaBatchRuntimeErrorResponse,
  resolveQaBatchCapabilityConfig,
} from "@/lib/qa-batch-runtime";
import {
  evaluateQaRuntimeDatabaseIdentity,
  isQaRuntimeDatabaseIdentityReady,
  matchesQaRuntimeDatabaseTarget,
  qaRuntimeDatabaseIdentitySql,
  type QaRuntimeDatabaseIdentityRow,
} from "@/lib/qa-runtime-identity";

export const runtime = "nodejs";

const privateHeaders = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};

function json(body: unknown, status = 200) {
  return Response.json(body, { headers: privateHeaders, status });
}

export async function GET(request: Request) {
  const session = await getRequestSession(request);
  if (!session) return json({ error: "Unauthorized" }, 401);
  if (!evaluateLaunchScope("qaBatchRegistration", session).allowed) {
    return json({ error: "Forbidden" }, 403);
  }
  if (!canAdministerQaReset(session)) {
    return json({ error: "Forbidden" }, 403);
  }

  try {
    const config = resolveQaBatchCapabilityConfig();
    const requestedBatchId = new URL(request.url).searchParams.get("batchId")?.trim().toLowerCase() ?? null;
    if (requestedBatchId && !isUuid(requestedBatchId)) {
      return json({ code: "QA_BATCH_ID_INVALID", error: "Invalid QA batch id" }, 400);
    }
    if (!config.allowlistedWorkspaceIds.has(session.workspaceId.toLowerCase())) {
      return json({ error: "Forbidden" }, 403);
    }

    const capability = await withTenantTransaction(
      { actorId: session.userId, workspaceId: session.workspaceId },
      async (transaction) => {
        const workspaceCapability = await transaction.queryOne<{
          isQa: boolean;
          ledgerReady: boolean;
          permissionsReady: boolean;
        }>(
          `
            select
              workspace.is_qa as "isQa",
              to_regclass('public.qa_batch_objects') is not null as "ledgerReady",
              has_table_privilege(current_user, 'public.qa_batches', 'SELECT')
                and has_table_privilege(current_user, 'public.qa_batch_objects', 'SELECT,INSERT')
                as "permissionsReady"
            from workspaces workspace
            where workspace.id = $1::uuid
            limit 1
          `,
          [session.workspaceId],
        );
        const databaseIdentity = evaluateQaRuntimeDatabaseIdentity(
          await transaction.queryOne<QaRuntimeDatabaseIdentityRow>(qaRuntimeDatabaseIdentitySql),
        );
        const batchCapability = requestedBatchId
          ? await transaction.queryOne<{
              auditCount: string | number;
              batchId: string;
              candidateSha: string | null;
              createdByUserId: string;
              deploymentId: string | null;
              executedCount: string | number;
              ledgerCount: string | number;
              purpose: string | null;
            }>(
              `
                select
                  batch.id as "batchId",
                  batch.created_by_user_id as "createdByUserId",
                  batch.metadata->>'candidate' as "candidateSha",
                  batch.metadata->>'deploymentId' as "deploymentId",
                  batch.metadata->>'purpose' as "purpose",
                  (select count(*) from qa_batch_objects object where object.workspace_id = batch.workspace_id and object.batch_id = batch.id) as "ledgerCount",
                  (select count(*) from qa_reset_audit_events audit where audit.workspace_id = batch.workspace_id and audit.batch_id = batch.id) as "auditCount",
                  (select count(*) from qa_reset_audit_events audit where audit.workspace_id = batch.workspace_id and audit.batch_id = batch.id and audit.outcome = 'executed') as "executedCount"
                from qa_batches batch
                where batch.workspace_id = $1::uuid
                  and batch.id = $2::uuid
                limit 1
              `,
              [session.workspaceId, requestedBatchId],
            )
          : null;
        return { batchCapability, databaseIdentity, workspaceCapability };
      },
    );
    if (
      !capability.workspaceCapability?.isQa
      || !capability.workspaceCapability.ledgerReady
      || !capability.workspaceCapability.permissionsReady
      || !isQaRuntimeDatabaseIdentityReady(capability.databaseIdentity)
      || !matchesQaRuntimeDatabaseTarget(capability.databaseIdentity, config.databaseTarget)
    ) {
      return json({ code: "QA_BATCH_CAPABILITY_UNAVAILABLE", error: "QA batch capability unavailable" }, 503);
    }
    const batchCapability = capability.batchCapability;
    if (
      requestedBatchId
      && (
        !batchCapability
        || batchCapability.batchId !== requestedBatchId
        || batchCapability.createdByUserId !== session.userId
        || batchCapability.candidateSha !== config.gitSha
        || batchCapability.deploymentId !== config.deploymentId
        || batchCapability.purpose !== "public-runtime-preview"
        || Number(batchCapability.ledgerCount) !== 0
        || Number(batchCapability.auditCount) !== 0
        || Number(batchCapability.executedCount) !== 0
      )
    ) {
      return json({ code: "QA_BATCH_NOT_FRESH_OR_BOUND", error: "QA batch is not fresh and deployment-bound" }, 409);
    }

    return json({
      atomicRegistration: true,
      batchCapability: requestedBatchId ? {
        batchId: requestedBatchId,
        candidateSha: batchCapability?.candidateSha,
        deploymentId: batchCapability?.deploymentId,
        fresh: true,
        purpose: batchCapability?.purpose,
      } : null,
      databaseBranchId: capability.databaseIdentity.databaseBranchId,
      databaseLeastPrivilege: capability.databaseIdentity.leastPrivilege,
      databaseRlsActive: capability.databaseIdentity.rlsActive,
      databaseTargetDigest: capability.databaseIdentity.databaseTargetDigest,
      deploymentHost: config.deploymentHost,
      deploymentId: config.deploymentId,
      gitBranch: config.gitBranch,
      gitSha: config.gitSha,
      header: qaBatchHeader,
      publicRuntimeAtomicSurfaces: qaPublicRuntimeAtomicSurfaces,
      sessionScope: {
        productRole: session.productRole,
        role: session.role,
        source: session.source,
        userId: session.userId,
        workspaceId: session.workspaceId,
      },
      version: qaBatchCapabilityVersion,
    });
  } catch (error) {
    return qaBatchRuntimeErrorResponse(error) ?? json({ error: "QA batch capability unavailable" }, 503);
  }
}
