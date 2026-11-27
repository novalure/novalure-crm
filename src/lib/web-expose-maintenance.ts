import "server-only";
import { assertCrmUuid, CrmCommandError, type TenantTransactionOptions } from "@/lib/crm-command";
import { withTenantTransaction } from "@/lib/db/tenant-client";
import { areQueueWorkersPaused, createCronRun, isCronAuthorized } from "@/lib/cron/runtime";

type RetentionScope = { workspaceId: string; actorId: string };
function configuredScopes(env: NodeJS.ProcessEnv): RetentionScope[] {
  const raw: unknown = JSON.parse(env.NOVALURE_ANALYTICS_RETENTION_SCOPES || "[]");
  if (!Array.isArray(raw) || raw.length > 50) throw new Error("invalid_scopes");
  const seen = new Set<string>();
  return raw.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).sort().join() !== "actorId,workspaceId") throw new Error("invalid_scope");
    const row = item as Record<string, unknown>;
    const scope = { workspaceId: assertCrmUuid(row.workspaceId), actorId: assertCrmUuid(row.actorId) };
    if (seen.has(scope.workspaceId)) throw new Error("duplicate_scope");
    seen.add(scope.workspaceId); return scope;
  });
}
export function webExposeRetentionScheduled(workspaceId: string, env: NodeJS.ProcessEnv = process.env) {
  if (!env.CRON_SECRET?.trim() || areQueueWorkersPaused(env)) return false;
  try { return configuredScopes(env).some(scope => scope.workspaceId === workspaceId); } catch { return false; }
}

/** Host configuration narrows maintenance to explicit workspace/manager pairs. The database rechecks the active manager. */
export async function handleWebExposeRetentionCron(request: Request, env: NodeJS.ProcessEnv = process.env, options: TenantTransactionOptions = {}) {
  if (request.method !== "GET" || new URL(request.url).search || !env.CRON_SECRET?.trim() || !isCronAuthorized(request, env)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  let scopes: RetentionScope[];
  try { scopes = configuredScopes(env); } catch { return Response.json({ ok: false, code: "RETENTION_SCOPE_INVALID" }, { status: 503 }); }
  const host = createCronRun({ route: "web-expose-retention" });
  // The daily cron rotates its first workspace so time-limited runs make progress across scopes.
  const results: { workspaceId: string; status: "completed" | "blocked"; data?: unknown; code?: string }[] = [];
  let interruption: "RETENTION_PAUSED" | "RETENTION_DEADLINE" | undefined;
  for (const scope of host.dailyScopeOrder(scopes)) {
    if (areQueueWorkersPaused(env)) {
      interruption = "RETENTION_PAUSED";
      break;
    }
    if (!host.shouldContinue()) {
      interruption = "RETENTION_DEADLINE";
      break;
    }
    try {
      const data = await withTenantTransaction({ workspaceId: scope.workspaceId, actorId: scope.actorId }, async tx => {
        const member = await tx.queryOne(`select role from crm_lock_active_member($1::uuid,$2::uuid)`, [scope.workspaceId, scope.actorId]);
        if (!member) throw new CrmCommandError("RETENTION_ACTOR_REVOKED", "Berechtigung für die Bereinigung fehlt.", 403);
        return (await tx.queryOne<{ data: unknown }>(`select crm_web_expose_prune($1::uuid) as data`, [scope.workspaceId]))?.data;
      }, options);
      results.push({ workspaceId: scope.workspaceId, status: "completed", data });
    } catch (error) { results.push({ workspaceId: scope.workspaceId, status: "blocked", code: error instanceof CrmCommandError ? error.code : "RETENTION_UNAVAILABLE" }); }
  }
  const remaining = scopes.length - results.length;
  const ok = remaining === 0 && results.every(r => r.status === "completed");
  return Response.json({
    ok,
    configured: scopes.length,
    attempted: results.length,
    remaining,
    results,
    code: interruption ?? (ok ? undefined : "RETENTION_SCOPE_FAILED"),
    paused: interruption === "RETENTION_PAUSED" || undefined,
  }, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
