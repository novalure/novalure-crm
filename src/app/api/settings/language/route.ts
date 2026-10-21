import { NextResponse } from "next/server";
import { getRequestSession } from "@/lib/auth/session";
import { protectAuthResponse } from "@/lib/auth/response-security";
import { isLanguagePreference } from "@/lib/crm-language";
import { saveAccountLanguagePreference } from "@/lib/db/language-preference-repository";
import { enforceCsrfForSession } from "@/lib/security/csrf";

export async function POST(request: Request) {
  const session = await getRequestSession(request);
  if (!session) return protectAuthResponse(NextResponse.json({ error: "unauthorized" }, { status: 401 }));
  const csrf = await enforceCsrfForSession(request, session);
  if (!csrf.ok) return protectAuthResponse(csrf.response);
  if (!session.authIdentityId || session.serviceIdentity) {
    return protectAuthResponse(NextResponse.json({ error: "personal_account_required" }, { status: 403 }));
  }
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return protectAuthResponse(NextResponse.json({ error: "invalid_preference" }, { status: 400 }));
  }
  if (!body || !isLanguagePreference(body.preference)) {
    return protectAuthResponse(NextResponse.json({ error: "invalid_preference" }, { status: 400 }));
  }
  // A pending UI from a previous login must never write to the new account.
  if (body.expectedUserId !== session.userId) {
    return protectAuthResponse(NextResponse.json({ error: "account_changed" }, { status: 409 }));
  }
  try {
    const preference = await saveAccountLanguagePreference(session, body.preference);
    return protectAuthResponse(NextResponse.json({ preference, persisted: true }));
  } catch {
    return protectAuthResponse(NextResponse.json({ error: "language_save_unavailable", persisted: false }, { status: 503 }));
  }
}
