import { runG27IsolationProbe } from "@/lib/g27-preview-isolation-probe";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return runG27IsolationProbe(request);
}
