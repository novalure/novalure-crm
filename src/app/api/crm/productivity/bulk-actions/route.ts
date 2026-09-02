import { NextResponse } from "next/server";

import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { executeBulkAction } from "@/lib/db/list-productivity-repository";
import {
  requiresPrivilegedBulkRole,
  validateBulkAction,
} from "@/lib/list-productivity";

const privateHeaders = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const idempotencyPattern = /^[A-Za-z0-9:_-]{8,160}$/;

export async function POST(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write" });
  if (!auth.ok) return auth.response;
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
  if (!idempotencyPattern.test(idempotencyKey)) {
    return NextResponse.json({ error: "A valid Idempotency-Key is required" }, { headers: privateHeaders, status: 400 });
  }
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    raw = null;
  }
  const validation = validateBulkAction(raw);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { headers: privateHeaders, status: 400 });
  }
  if (
    requiresPrivilegedBulkRole(validation.value.action) &&
    auth.session.role !== "owner" &&
    auth.session.role !== "admin"
  ) {
    return NextResponse.json({ error: "Workspace owner or admin role required" }, { headers: privateHeaders, status: 403 });
  }

  try {
    const result = await executeBulkAction({
      action: validation.value,
      idempotencyKey,
      session: auth.session,
    });
    return NextResponse.json(result, { headers: privateHeaders, status: result.reused ? 200 : 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Bulk action failed" },
      { headers: privateHeaders, status: 409 },
    );
  }
}
