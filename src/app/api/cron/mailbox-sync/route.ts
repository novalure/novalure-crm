import { handleMailboxSyncCron } from "@/lib/crm-mailbox-sync-worker";
export const runtime="nodejs";
export const maxDuration=60;
export async function GET(request:Request){return handleMailboxSyncCron(request);}
