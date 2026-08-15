import { NextResponse } from "next/server";
import { getTrustedAppOrigin } from "@/lib/auth/app-origin";
import { protectAuthResponse } from "@/lib/auth/response-security";
import {
  getRequestSession,
  getSessionCookieOptions,
  revokeRequestSession,
  sessionCookieName,
} from "@/lib/auth/session";
import { enforceCsrfForSession } from "@/lib/security/csrf";
import { hasCookieName, readCookieValue } from "@/lib/auth/auth-security";
import { validateCsrfRequestContext } from "@/lib/security/csrf-core";
import {
  defaultLanguage,
  isLanguageCode,
  languageCookieName,
  languageRequestHeaderName,
} from "@/lib/language-runtime";

function getLogoutLanguage(request: Request) {
  const requested = new URL(request.url).searchParams.get("lang");
  const forwarded = request.headers.get(languageRequestHeaderName);
  const persisted = readCookieValue(request.headers.get("cookie"), languageCookieName);
  const accepted = request.headers.get("accept-language")?.slice(0, 2).toLowerCase();
  return [requested, forwarded, persisted, accepted].find(isLanguageCode) ?? defaultLanguage;
}

export async function POST(request: Request) {
  const requestContext = validateCsrfRequestContext(request.headers, getTrustedAppOrigin());
  if (!requestContext.ok) {
    return protectAuthResponse(
      NextResponse.json({ error: "Logout request context is invalid" }, { status: 403 }),
    );
  }

  const cookieHeader = request.headers.get("cookie");
  const sessionCookiePresent = hasCookieName(cookieHeader, sessionCookieName);
  const session = await getRequestSession(request);
  if (sessionCookiePresent && session?.source !== "cookie") {
    return protectAuthResponse(
      NextResponse.json({ error: "Logout requires a valid session" }, { status: 403 }),
    );
  }

  if (session?.source === "cookie") {
    const csrf = await enforceCsrfForSession(request, session);
    if (!csrf.ok) return csrf.response;
    try {
      if (!(await revokeRequestSession(request, "logout"))) {
        return protectAuthResponse(
          NextResponse.json({ error: "Logout could not revoke the session" }, { status: 503 }),
        );
      }
    } catch {
      return protectAuthResponse(
        NextResponse.json({ error: "Logout could not revoke the session" }, { status: 503 }),
      );
    }
  }

  const language = getLogoutLanguage(request);
  const loginUrl = new URL("/login", getTrustedAppOrigin());
  loginUrl.searchParams.set("lang", language);
  const response = NextResponse.redirect(loginUrl, 303);
  if (sessionCookiePresent) {
    response.cookies.set(sessionCookieName, "", getSessionCookieOptions(0));
  }
  response.cookies.set(languageCookieName, language, {
    maxAge: 31_536_000,
    path: "/",
    sameSite: "lax",
  });
  return protectAuthResponse(response);
}
