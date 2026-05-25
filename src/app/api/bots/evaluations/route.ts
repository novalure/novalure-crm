import { requirePermission } from "@/lib/auth/session";
import { runBotGovernanceEvaluation } from "@/lib/bots/evaluation";
import { listBotEvaluationRuns } from "@/lib/db/runtime-repositories";

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function getString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getLimit(value: string | null) {
  const parsed = Number(value ?? 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(50, Math.round(parsed))) : 10;
}

export async function GET(request: Request) {
  const auth = await requirePermission(request, "bots:run");
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const runs = await listBotEvaluationRuns({
    botId: url.searchParams.get("botId"),
    limit: getLimit(url.searchParams.get("limit")),
    projectId: url.searchParams.get("projectId"),
    session: auth.session,
  });

  return Response.json({ runs, source: "database" });
}

export async function POST(request: Request) {
  const auth = await requirePermission(request, "bots:approve");
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const result = await runBotGovernanceEvaluation({
    botId: getString(input.botId),
    projectId: getString(input.projectId),
    session: auth.session,
  });

  return Response.json(result, { status: result.persisted ? 201 : 503 });
}
