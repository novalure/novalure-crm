import { NextResponse } from "next/server";
import { getRequestSession } from "@/lib/auth/session";
import { changeOwnWorkspacePassword } from "@/lib/db/settings-access-repositories";

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function PATCH(request: Request) {
  const session = await getRequestSession(request);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const result = await changeOwnWorkspacePassword({
    confirmation: input.confirmation,
    currentPassword: input.currentPassword,
    password: input.password,
    session,
  });

  if (!result.ok) return NextResponse.json({ error: result.reason }, { status: result.status });

  return NextResponse.json({ ok: true });
}
