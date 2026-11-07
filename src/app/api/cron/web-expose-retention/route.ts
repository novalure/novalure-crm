import { handleWebExposeRetentionCron } from "@/lib/web-expose-maintenance";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function GET(request: Request) { return handleWebExposeRetentionCron(request); }
