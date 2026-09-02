import { NextResponse } from "next/server";

import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { listRecentRecords } from "@/lib/db/list-productivity-repository";

const privateHeaders = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

export async function GET(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" });
  if (!auth.ok) return auth.response;
  const parsedLimit = Number(new URL(request.url).searchParams.get("limit"));
  const records = await listRecentRecords({
    limit: Number.isSafeInteger(parsedLimit) ? parsedLimit : 8,
    session: auth.session,
  });
  return NextResponse.json({ records }, { headers: privateHeaders });
}
