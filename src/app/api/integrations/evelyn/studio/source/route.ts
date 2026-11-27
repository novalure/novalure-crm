import { readStudioSource } from "@/lib/studio-source-reader";

export const runtime = "nodejs";
export const POST = (request: Request) => readStudioSource(request);
