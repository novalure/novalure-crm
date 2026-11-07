import { handleCrmNotificationEmailCron } from "@/lib/crm-notification-email-worker";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function GET(request: Request) { return handleCrmNotificationEmailCron(request); }
