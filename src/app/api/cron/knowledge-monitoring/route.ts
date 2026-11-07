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
  if (failed) console.error(JSON.stringify({ code: "SHARED_LEARNING_TICK_FAILED", status: learning.status }));
  const payload = await monitoring.json();
  // Learning has its own categorical log/receipt. Never turn a successful website
  // monitoring run into an HTTP failure which could retrigger that independent work.
  return Response.json({ ...payload, learning }, { status: monitoring.status });
}
