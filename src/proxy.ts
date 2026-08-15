import { NextResponse, type NextRequest } from "next/server";
import {
  languageCookieName,
  languageRequestHeaderName,
} from "@/lib/language-runtime";
import {
  isPublicLanguageCode,
  publicLanguageRequestHeaderName,
  resolvePublicSiteLanguage,
  toAppLanguage,
} from "@/lib/public-language";

function getRequestCountry(headers: Headers) {
  return headers.get("x-vercel-ip-country") ?? headers.get("cf-ipcountry") ?? headers.get("x-country-code");
}

export function proxy(request: NextRequest) {
  const requestedLanguage = request.nextUrl.searchParams.get("lang");
  const cookieLanguage = request.cookies.get(languageCookieName)?.value;
  const publicLanguage = resolvePublicSiteLanguage({
    acceptLanguage: request.headers.get("accept-language"),
    country: getRequestCountry(request.headers),
    persistedLanguage: cookieLanguage,
    requestedLanguage,
  });
  const language = toAppLanguage(publicLanguage);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(languageRequestHeaderName, language);
  requestHeaders.set(publicLanguageRequestHeaderName, publicLanguage);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  if (isPublicLanguageCode(requestedLanguage)) {
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
