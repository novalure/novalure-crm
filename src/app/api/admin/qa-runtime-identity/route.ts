import { queryOne } from "@/lib/db/client";
import {
  qaBatchRuntimeErrorResponse,
  qaBatchCapabilityVersion,
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
  "Cache-Control": "private, no-store, max-age=0",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
};

function json(body: unknown, status = 200) {
  return Response.json(body, { headers: privateHeaders, status });
}

export async function GET() {
  try {
    const config = resolveQaBatchCapabilityConfig();
    const databaseIdentity = evaluateQaRuntimeDatabaseIdentity(
      await queryOne<QaRuntimeDatabaseIdentityRow>(qaRuntimeDatabaseIdentitySql),
    );
    if (
      !isQaRuntimeDatabaseIdentityReady(databaseIdentity)
      || !matchesQaRuntimeDatabaseTarget(databaseIdentity, config.databaseTarget)
    ) {
      return json({ code: "QA_RUNTIME_IDENTITY_UNAVAILABLE", error: "QA runtime identity unavailable" }, 503);
    }

    return json({
      databaseLeastPrivilege: databaseIdentity.leastPrivilege,
      databaseRlsActive: databaseIdentity.rlsActive,
      databaseTargetDigest: databaseIdentity.databaseTargetDigest,
      deploymentHost: config.deploymentHost,
      deploymentId: config.deploymentId,
      gitBranch: config.gitBranch,
      gitSha: config.gitSha,
      version: qaBatchCapabilityVersion,
    });
  } catch (error) {
    return qaBatchRuntimeErrorResponse(error)
      ?? json({ code: "QA_RUNTIME_IDENTITY_UNAVAILABLE", error: "QA runtime identity unavailable" }, 503);
  }
}
