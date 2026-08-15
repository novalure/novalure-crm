import { NextResponse } from "next/server";
import {
  getAuthRuntimeStatus,
  getRequestSession,
  getSessionCookieOptions,
  rotateRequestSession,
  serializeSession,
  touchRequestSession,
} from "@/lib/auth/session";
import { enforceCsrfForSession } from "@/lib/security/csrf";

function unauthorizedResponse() {
  return NextResponse.json(
    { authenticated: false, ...getAuthRuntimeStatus() },
    { headers: { "Cache-Control": "private, no-store" }, status: 401 },
  );
}

export async function GET(request: Request) {
  const session = await getRequestSession(request);

  if (!session) return unauthorizedResponse();

  return NextResponse.json(serializeSession(session), {
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function POST(request: Request) {
  const session = await getRequestSession(request);
  if (!session) return unauthorizedResponse();

  const csrf = await enforceCsrfForSession(request, session);
  if (!csrf.ok) return csrf.response;

  const response = NextResponse.json(serializeSession(session), {
    headers: { "Cache-Control": "private, no-store" },
  });
  if (session.source !== "cookie") return response;

  if (session.sessionRotationDue) {
    const rotated = await rotateRequestSession(request);
    if (!rotated) return unauthorizedResponse();
    response.cookies.set(
      rotated.name,
      rotated.value,
      getSessionCookieOptions(rotated.maxAge),
    );
  } else if (!(await touchRequestSession(request))) {
    return unauthorizedResponse();
  }
  return response;
}
