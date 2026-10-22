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
import { crmEntryRequestHeaderName, getTrustedCrmCountry, guestCrmPreferenceCookieName, isLanguagePreference, resolveCrmLanguage } from "@/lib/crm-language";
import { bookingFrameAncestors } from "@/lib/booking/public-frame-policy";

function getRequestCountry(headers: Headers) {
  return headers.get("x-vercel-ip-country") ?? headers.get("cf-ipcountry") ?? headers.get("x-country-code");
}

export function proxy(request: NextRequest) {
  const requestedLanguage = request.nextUrl.searchParams.get("lang");
  const cookieLanguage = request.cookies.get(languageCookieName)?.value;
  let publicLanguage = resolvePublicSiteLanguage({
    acceptLanguage: request.headers.get("accept-language"),
    country: getRequestCountry(request.headers),
    persistedLanguage: cookieLanguage,
    requestedLanguage,
  });
  const isCrmLogin = request.nextUrl.pathname === "/login" || request.nextUrl.pathname.startsWith("/login/");
  const appointment = /^\/appointments\/([a-zA-Z0-9_-]{10,100})\/?$/.exec(request.nextUrl.pathname);
  const requestedCrmPreference = request.nextUrl.searchParams.get("languagePreference");
  const isPrefetch = request.headers.has("next-router-prefetch") ||
    /\bprefetch\b/i.test(`${request.headers.get("purpose") ?? ""} ${request.headers.get("sec-purpose") ?? ""}`);
  if (isCrmLogin) {
    const preference = isLanguagePreference(requestedCrmPreference)
      ? requestedCrmPreference
      : request.cookies.get(guestCrmPreferenceCookieName)?.value;
    publicLanguage = resolveCrmLanguage(preference, getTrustedCrmCountry(request.headers, process.env.VERCEL === "1"));
  }
  const language = toAppLanguage(publicLanguage);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(crmEntryRequestHeaderName, request.nextUrl.pathname === "/" || request.nextUrl.pathname === "/booking" ? "1" : "0");
  requestHeaders.set(languageRequestHeaderName, language);
  requestHeaders.set(publicLanguageRequestHeaderName, publicLanguage);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  if (!isPrefetch && isCrmLogin && isLanguagePreference(requestedCrmPreference)) {
    response.cookies.set(guestCrmPreferenceCookieName, requestedCrmPreference, {
      maxAge: 31536000,
      path: "/",
      sameSite: "lax",
      secure: request.nextUrl.protocol === "https:",
    });
  }
  if (!isPrefetch && !isCrmLogin && !appointment && isPublicLanguageCode(requestedLanguage)) {
    response.cookies.set(languageCookieName, requestedLanguage, {
      maxAge: 31536000,
      path: "/",
      sameSite: "lax",
    });
  }

  if (appointment) return applyAppointmentFramePolicy(response, appointment[1]);
  return response;
}

async function applyAppointmentFramePolicy(response: NextResponse, publicId: string) {
  const publication = await import("@/lib/booking/publication").then(({ getPublicBookingPublication }) => getPublicBookingPublication(publicId)).catch(() => null);
  const policy = bookingFrameAncestors(publication?.allowedOrigins ?? [], process.env.NODE_ENV !== "production");
  response.headers.set("Content-Security-Policy", `object-src 'none'; base-uri 'self'; form-action 'self'; ${policy}`);
  if (!publication?.allowedOrigins.length) response.headers.set("X-Frame-Options", "SAMEORIGIN");
  else response.headers.delete("X-Frame-Options");
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|icon.svg|landing-assets).*)"],
};
