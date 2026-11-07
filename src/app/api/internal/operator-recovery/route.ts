import { randomUUID } from "node:crypto";
import { withKnowledgeRequest, knowledgeJson, readKnowledgeBytes } from "@/lib/knowledge-center/http";
import { withCrmRead } from "@/lib/crm-command";
import { isPinnedRecoveryOperator, recoverySecretNames, sealOperatorRecovery } from "@/lib/operator-recovery";

export const runtime = "nodejs";
export async function POST(request: Request) {
  if (process.env.NOVALURE_OPERATOR_RECOVERY_EXPORT !== "1") return knowledgeJson({ error: "Not found" }, 404);
  // Existing durable cookie, CSRF, membership and MFA checks run before the pinned platform-operator check.
  return withKnowledgeRequest(request, async session => {
    if (!isPinnedRecoveryOperator(session)) return knowledgeJson({ error: "Forbidden" }, 403);
    if (new URL(request.url).search) {
      return knowledgeJson({ error: "No request parameters or body accepted" }, 400);
    }
    // A transported empty POST can have a stream. Reject actual bytes, while
    // accepting the empty stream emitted by a normal browser fetch.
    if (request.body) await readKnowledgeBytes(request, 0);
    else if (request.headers.has("content-length") && request.headers.get("content-length") !== "0") return knowledgeJson({ error: "No request body accepted" }, 400);
    return withCrmRead(session, async (tx, fresh) => {
      if (!isPinnedRecoveryOperator(fresh)) return knowledgeJson({ error: "Forbidden" }, 403);
      // Serializes the small fixed export and enforces a database-clock daily limit.
      await tx.query("select pg_advisory_xact_lock(hashtextextended('operator-recovery-v1',0))", []);
      const count = await tx.queryOne<{ n: number }>(`select count(*)::int as n from audit_logs where workspace_id=$1::uuid
        and action='operator.recovery.sealed' and created_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'`, [fresh.workspaceId]);
      if ((count?.n ?? 0) >= 3) return knowledgeJson({ error: "Recovery export daily limit reached" }, 429);
      let sealed;
      try { sealed = sealOperatorRecovery(process.env); }
      catch { return knowledgeJson({ error: "Recovery configuration is unavailable" }, 503); }
      await tx.execute(`insert into audit_logs(workspace_id,actor_user_id,action,entity_type,entity_id,after)
        values($1::uuid,$2::uuid,'operator.recovery.sealed','operator_recovery',$3::uuid,$4::jsonb)`,
        [fresh.workspaceId, fresh.userId, randomUUID(), JSON.stringify({ recipientSha256: sealed.recipientSha256, secretNames: recoverySecretNames, sourceRevision: sealed.sourceRevision })]);
      return knowledgeJson(sealed);
    });
  });
}
