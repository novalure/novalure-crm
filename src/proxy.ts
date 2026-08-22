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
import {
  contentSecurityPolicyModeHeader,
  createContentSecurityPolicy,
} from "@/lib/security/content-security-policy";

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
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const contentSecurityPolicy = createContentSecurityPolicy({
    development: process.env.NODE_ENV === "development",
    nonce,
    pathName: request.nextUrl.pathname,
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(languageRequestHeaderName, language);
  requestHeaders.set(publicLanguageRequestHeaderName, publicLanguage);
  requestHeaders.set("content-security-policy", contentSecurityPolicy);
  requestHeaders.set("x-nonce", nonce);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
  response.headers.set("content-security-policy", contentSecurityPolicy);
  response.headers.set("x-content-security-policy-mode", contentSecurityPolicyModeHeader);

  if (isPublicLanguageCode(requestedLanguage)) {
    response.cookies.set(languageCookieName, requestedLanguage, {
      maxAge: 31536000,
      path: "/",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    });
  }

  return response;
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|icon.svg|landing-assets).*)"],
};
