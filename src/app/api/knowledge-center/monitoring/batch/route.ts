import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { knowledgeJson, knowledgeQueryParams, readKnowledgeJson, withKnowledgeRequest } from "@/lib/knowledge-center/http";
import { listDueKnowledgeMonitoringJobs } from "@/lib/knowledge-center/monitoring";
import { runKnowledgeMonitoringBatch } from "@/lib/knowledge-center/scheduler";

export const runtime = "nodejs";
export const maxDuration = 60;

/** An explicit user-triggered batch, not a timer or a global scheduler identity. */
export async function POST(request: Request) {
  return withKnowledgeRequest(request, async session => {
    knowledgeQueryParams(request, []);
    await readKnowledgeJson(request, [], 1024);
    const jobs = await listDueKnowledgeMonitoringJobs(session);
    // Each unchanged scanner permits at most eight seconds of network work.
    // Keep the whole request bounded rather than accepting a caller's batch size.
    const selected = jobs.slice(0, 3);
    const results = await runKnowledgeMonitoringBatch(selected, {
      async rehydrateActor(job) {
        // CSRF was consumed by the outer authenticated POST. This internal read
        // re-resolves the same cookie and workspace without replaying that token.
        const current = await resolveWorkspaceScopedSession(
          new Request(request.url, { headers: request.headers }),
          { permission: "crm:read" },
        );
        if (!current.ok) return null;
        const fresh = current.session;
        return fresh.source === "cookie" && fresh.authenticated &&
          fresh.workspaceId === session.workspaceId && fresh.userId === session.userId &&
          fresh.workspaceId === job.workspaceId && fresh.userId === job.actorId &&
          fresh.authIdentityId === session.authIdentityId && fresh.authSessionId === session.authSessionId
          ? fresh : null;
      },
    });
    return knowledgeJson({ eligibleJobs: jobs.length, attemptedJobs: selected.length, results });
  });
}
