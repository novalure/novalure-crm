import { NextResponse } from "next/server";
import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { listDealStageHistory } from "@/lib/db/crm-write-repositories";

type RouteContext = {
  params: Promise<{ dealId: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" });
  if (!auth.ok) return auth.response;

  const { dealId } = await context.params;
  const result = await listDealStageHistory({ dealId, session: auth.session });

  return NextResponse.json(result);
}
