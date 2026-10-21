import { handleWebsiteChatRequest, websiteChatOptions } from "@/lib/knowledge-center/website-chat";

export const runtime = "nodejs";
export const maxDuration = 30;
export async function POST(request: Request) { return handleWebsiteChatRequest(request); }
export const OPTIONS = websiteChatOptions;
