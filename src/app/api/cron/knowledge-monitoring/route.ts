import { handleKnowledgeMonitoringCron } from "@/lib/knowledge-center/monitoring-delegation";
import { dispatchScheduledBehaviorLearning } from "@/lib/shared-behavior/scheduler";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  if (process.env.NOVALURE_SHARED_LEARNING_ENABLED !== "1") return handleKnowledgeMonitoringCron(request);
  // Independent pools and authorization, concurrent inside the existing 60-second workload.
  const [monitoring, learning] = await Promise.all([
    handleKnowledgeMonitoringCron(request), dispatchScheduledBehaviorLearning(request),
  ]);
  if (monitoring.status === 401) return monitoring;
  const failed = ["failed", "unconfigured", "unauthorized"].includes(learning.status);
  const payload = await monitoring.json();
  return Response.json({ ...payload, learning }, { status: failed ? 503 : monitoring.status });
}
