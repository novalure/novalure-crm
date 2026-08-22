import { getRequestSession } from "@/lib/auth/session";
import { canAdministerQaReset } from "@/lib/qa-reset-contract";
import { withTenantTransaction } from "@/lib/db/tenant-client";
import { evaluateLaunchScope } from "@/lib/launch-scope";
import {
  qaBatchCapabilityVersion,
  qaBatchHeader,
  qaBatchRuntimeErrorResponse,
  resolveQaBatchCapabilityConfig,
} from "@/lib/qa-batch-runtime";

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
    if (!config.allowlistedWorkspaceIds.has(session.workspaceId.toLowerCase())) {
      return json({ error: "Forbidden" }, 403);
    }

    const capability = await withTenantTransaction(
      { actorId: session.userId, workspaceId: session.workspaceId },
      (transaction) => transaction.queryOne<{
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
      ),
    );
    if (!capability?.isQa || !capability.ledgerReady || !capability.permissionsReady) {
      return json({ code: "QA_BATCH_CAPABILITY_UNAVAILABLE", error: "QA batch capability unavailable" }, 503);
    }

    return json({
      atomicRegistration: true,
      gitSha: config.gitSha,
      header: qaBatchHeader,
      version: qaBatchCapabilityVersion,
    });
  } catch (error) {
    return qaBatchRuntimeErrorResponse(error) ?? json({ error: "QA batch capability unavailable" }, 503);
  }
}
