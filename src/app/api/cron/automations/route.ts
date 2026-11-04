import { handleAutomationCron } from "@/lib/automation/scheduler";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function GET(request: Request) { return handleAutomationCron(request); }
