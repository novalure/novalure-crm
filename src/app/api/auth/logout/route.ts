import { NextResponse } from "next/server";
import { getSessionCookieOptions, sessionCookieName } from "@/lib/auth/session";

export async function POST(request: Request) {
  const response = NextResponse.redirect(new URL("/login", request.url), 303);
  response.cookies.set(sessionCookieName, "", getSessionCookieOptions(0));
  return response;
}
