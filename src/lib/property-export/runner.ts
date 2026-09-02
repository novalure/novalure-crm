import {
  claimPropertyExportJob,
  completePropertyExportJob,
  failPropertyExportJob,
  listDuePropertyExportJobIds,
} from "@/lib/db/property-export-repositories";
import {
  classifyDeliveryError,
  createLeaseOwner,
  retryDelaySeconds,
  sanitizeJobError,
} from "@/lib/jobs/durable-queue";
import {
  deliverPropertyExportToQaSink,
  isPropertyExportQaSinkEnabled,
  PropertyExportProviderConfigurationError,
} from "@/lib/property-export/provider-adapters";
import { evaluateLaunchScope } from "@/lib/launch-scope";

export type PropertyExportWorkerResult = Readonly<{
  checked: number;
  completed: number;
  deadLettered: number;
  failed: number;
  fenced: number;
  retried: number;
}>;

const emptyResult = (): PropertyExportWorkerResult => ({
  checked: 0,
  completed: 0,
  deadLettered: 0,
  failed: 0,
  fenced: 0,
  retried: 0,
});

export async function processDuePropertyExports(input: {
  env?: NodeJS.ProcessEnv;
  jobIds?: string[];
  limit?: number;
  shouldContinue?: () => boolean;
  workspaceId?: string | null;
} = {}): Promise<PropertyExportWorkerResult> {
  if (!evaluateLaunchScope("propertyExportQueue").allowed) return emptyResult();
  const env = input.env ?? process.env;
  if (!isPropertyExportQaSinkEnabled(env)) return emptyResult();

  const refs = await listDuePropertyExportJobIds({
    jobIds: input.jobIds,
    limit: input.limit ?? 25,
    workspaceId: input.workspaceId,
  });
  const result = {
    checked: 0,
    completed: 0,
    deadLettered: 0,
    failed: 0,
    fenced: 0,
    retried: 0,
  };

  for (const ref of refs) {
    if (input.shouldContinue && !input.shouldContinue()) break;
    result.checked += 1;
    const leaseOwner = createLeaseOwner("property-export");
    const job = await claimPropertyExportJob({
      actorId: ref.actorId,
      jobId: ref.id,
      leaseOwner,
      workspaceId: ref.workspaceId,
    });
    if (!job) continue;
    if (!evaluateLaunchScope("propertyExportQueue").allowed) {
      result.fenced += 1;
      break;
    }

    try {
      const delivery = await deliverPropertyExportToQaSink(job, env);
      const completed = await completePropertyExportJob({
        artifact: delivery.artifact,
        job,
        providerRequestId: delivery.providerRequestId,
        resultMetadata: delivery.resultMetadata,
      });
      if (completed) result.completed += 1;
      else result.fenced += 1;
    } catch (error) {
      const configurationError = error instanceof PropertyExportProviderConfigurationError;
      const category = configurationError ? "configuration" : classifyDeliveryError({ error });
      const nextStatus = await failPropertyExportJob({
        category,
        error: sanitizeJobError(error),
        job,
        retryDelaySeconds: retryDelaySeconds(job.attemptCount),
      });
      if (!nextStatus) {
        result.fenced += 1;
      } else if (nextStatus === "retry") {
        result.retried += 1;
      } else if (nextStatus === "dead_letter") {
        result.deadLettered += 1;
      } else {
        result.failed += 1;
      }
    }
  }

  return result;
}
