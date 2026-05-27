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

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(languageRequestHeaderName, language);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

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
