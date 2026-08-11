import { NextResponse } from "next/server";
import {
  getRequestSession,
  getSessionCookieOptions,
  revokeRequestSession,
  rotateRequestSession,
  sessionCookieName,
} from "@/lib/auth/session";
import { changeOwnWorkspacePassword } from "@/lib/db/settings-access-repositories";
import { enforceCsrfForSession } from "@/lib/security/csrf";

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
  const csrf = await enforceCsrfForSession(request, session);
  if (!csrf.ok) return csrf.response;

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

  const rotated = await rotateRequestSession(request);
  if (!rotated) {
    try {
      await revokeRequestSession(request, "password_change_rotation_failed");
    } catch {
      // The response still removes the browser credential and fails closed.
    }
    const response = NextResponse.json(
      { error: "Password changed; sign in again" },
      { status: 503 },
    );
    response.cookies.set(sessionCookieName, "", getSessionCookieOptions(0));
    return response;
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(rotated.name, rotated.value, getSessionCookieOptions(rotated.maxAge));
  return response;
}
