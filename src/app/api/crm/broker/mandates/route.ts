import { NextResponse } from "next/server";
import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { loadBrokerMandates } from "@/lib/db/crm-loaders";

export async function GET(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" });
  if (!auth.ok) return auth.response;

  const mandates = await loadBrokerMandates(auth.session);
  return NextResponse.json(
    { mandates, source: "database" },
    { headers: { "cache-control": "private, no-store" } },
  );
}

export async function POST(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, {
    permission: "crm:write",
    capability: "pipeline:write",
  });
  if (!auth.ok) return auth.response;
  return NextResponse.json(
    {
      code: "legacy_mandate_write_disabled",
      error: "Legacy mandate writes are disabled. Use the canonical broker workflow.",
      persisted: false,
    },
    { headers: { "cache-control": "private, no-store" }, status: 410 },
  );
}

export async function PATCH(request: Request) {
  return POST(request);
}
