import "server-only";
import type { AppSession } from "../auth/session";
import { KnowledgeCenterError } from "./policy";
import { runScheduledKnowledgeWebsiteScan, type KnowledgeMonitoringJob, type KnowledgeMonitoringOptions } from "./monitoring";

export type KnowledgeMonitoringSchedulerPorts = Readonly<{
  /** Trusted host rehydrates the persisted actor, never model or request input.
   * The resulting identity is revalidated by withCrmRead on claim and commit. */
  rehydrateActor(job: KnowledgeMonitoringJob): Promise<AppSession | null>;
}>;
export type KnowledgeMonitoringBatchResult = Readonly<{
  workspaceId: string; sourceId: string;
  outcome: "completed" | "busy" | "blocked";
  runId?: string; status?: string; errorCode?: string;
}>;
/** Isolated scheduler entry point. It discovers no tenants, installs no timer and
 * accepts only explicitly scoped descriptors loaded from persisted settings. */
export async function runKnowledgeMonitoringBatch(
  jobs: readonly KnowledgeMonitoringJob[], ports: KnowledgeMonitoringSchedulerPorts,
  options: KnowledgeMonitoringOptions = {},
): Promise<KnowledgeMonitoringBatchResult[]> {
  if (!Array.isArray(jobs) || jobs.length > 100 || !ports || typeof ports.rehydrateActor !== "function") throw new KnowledgeCenterError("VALIDATION_ERROR", "A bounded scoped monitoring batch and trusted actor adapter are required.");
  const results: KnowledgeMonitoringBatchResult[] = [], seen = new Set<string>();
  for (const job of jobs) {
    const key = `${job.workspaceId}:${job.sourceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const session = await ports.rehydrateActor(job);
      if (!session || session.userId !== job.actorId || session.workspaceId !== job.workspaceId || !session.authenticated || session.source === "demo") throw new KnowledgeCenterError("MONITORING_ACTOR_UNAVAILABLE", "Monitoring actor is unavailable.", 403);
      const result = await runScheduledKnowledgeWebsiteScan(session, job, options);
      results.push({ workspaceId: job.workspaceId, sourceId: job.sourceId, outcome: result.busy ? "busy" : "completed", runId: result.run.id, status: result.run.status });
    } catch (error) {
      const candidate = error && typeof error === "object" && "code" in error ? String(error.code) : "MONITORING_FAILED";
      results.push({ workspaceId: job.workspaceId, sourceId: job.sourceId, outcome: "blocked", errorCode: /^[a-zA-Z0-9_]{1,80}$/.test(candidate) ? candidate : "MONITORING_FAILED" });
    }
  }
  return results;
}

export type KnowledgeMaintenanceSchedulerScope = Readonly<{ workspaceId: string; actorId: string }>;
/** A host may supply its explicitly provisioned actor scopes to run opted-in
 * deterministic analysis. No scope/tenant enumeration or recurring job is added. */
export async function runKnowledgeMaintenanceBatch(
  scopes: readonly KnowledgeMaintenanceSchedulerScope[],
  ports: Readonly<{ rehydrateActor(scope: KnowledgeMaintenanceSchedulerScope): Promise<AppSession | null> }>,
  options: KnowledgeMonitoringOptions = {},
) {
  if (!Array.isArray(scopes) || scopes.length > 100 || !ports || typeof ports.rehydrateActor !== "function") throw new KnowledgeCenterError("VALIDATION_ERROR", "A bounded scoped maintenance batch and trusted actor adapter are required.");
  const { runConfiguredKnowledgeMaintenance } = await import("./workflow");
  const results: { workspaceId: string; actorId: string; outcome: "completed" | "blocked"; result?: Awaited<ReturnType<typeof runConfiguredKnowledgeMaintenance>>; errorCode?: string }[] = [];
  const seen = new Set<string>();
  for (const scope of scopes) {
    const key = `${scope.workspaceId}:${scope.actorId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const session = await ports.rehydrateActor(scope);
      if (!session || session.workspaceId !== scope.workspaceId || session.userId !== scope.actorId || !session.authenticated || session.source === "demo") throw new KnowledgeCenterError("MONITORING_ACTOR_UNAVAILABLE", "Maintenance actor is unavailable.", 403);
      const result = await runConfiguredKnowledgeMaintenance(session, {}, options);
      results.push({ ...scope, outcome: "completed", result });
    } catch (error) {
      const candidate = error && typeof error === "object" && "code" in error ? String(error.code) : "MAINTENANCE_FAILED";
      results.push({ ...scope, outcome: "blocked", errorCode: /^[a-zA-Z0-9_]{1,80}$/.test(candidate) ? candidate : "MAINTENANCE_FAILED" });
    }
  }
  return results;
}
