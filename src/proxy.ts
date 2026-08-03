import { NextResponse, type NextRequest } from "next/server";
import {
  defaultLanguage,
  isLanguageCode,
  languageCookieName,
  languageRequestHeaderName,
  resolveLanguage,
} from "@/lib/language-runtime";

export function proxy(request: NextRequest) {
  const requestedLanguage = request.nextUrl.searchParams.get("lang");
  const cookieLanguage = request.cookies.get(languageCookieName)?.value;
  const language = resolveLanguage(requestedLanguage, resolveLanguage(cookieLanguage, defaultLanguage));
  const requestId = crypto.randomUUID();

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(languageRequestHeaderName, language);
  requestHeaders.set("x-request-id", requestId);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
  response.headers.set("x-request-id", requestId);

  if (isLanguageCode(requestedLanguage)) {
    response.cookies.set(languageCookieName, requestedLanguage, {
      maxAge: 31536000,
      path: "/",
      sameSite: "lax",
    });
  }

  return response;
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|icon.svg|landing-assets).*)"],
};
