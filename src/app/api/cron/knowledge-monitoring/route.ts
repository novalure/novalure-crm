import { handleKnowledgeMonitoringCron } from "@/lib/knowledge-center/monitoring-delegation";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  return handleKnowledgeMonitoringCron(request);
}
