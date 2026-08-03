import { NextResponse } from "next/server";
import {
  authenticateLogin,
  createSessionCookie,
  getSessionCookieOptions,
} from "@/lib/auth/session";
import { isLanguageCode, type LanguageCode } from "@/lib/language-runtime";
import { checkRequestAuthLimits, clearLoginAuthLimits } from "@/lib/auth/rate-limit";
import { sanitizeLocalRedirect } from "@/lib/auth/redirects";

function getFormValue(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

function getLanguageValue(value: string): LanguageCode | "" {
  const normalized = value.trim().toLowerCase();
  return isLanguageCode(normalized) ? normalized : "";
}

function getLoginRedirect(
  request: Request,
  input: { error?: string; language?: LanguageCode | ""; returnTo?: string },
) {
  const url = new URL("/login", request.url);
  if (input.language) url.searchParams.set("lang", input.language);
  if (input.error) url.searchParams.set("error", input.error);
  if (input.returnTo) url.searchParams.set("returnTo", sanitizeLocalRedirect(input.returnTo));
  return url;
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const email = getFormValue(formData, "email");
  const password = getFormValue(formData, "password") || getFormValue(formData, "passcode");
  const language = getLanguageValue(getFormValue(formData, "language") || getFormValue(formData, "lang"));
  const returnTo = sanitizeLocalRedirect(getFormValue(formData, "returnTo"));
  const rateLimit = await checkRequestAuthLimits({
    account: email,
    accountAction: "login_account",
    ipAction: "login_ip",
    request,
  });
  const result = await authenticateLogin({
    email: rateLimit.allowed ? email : `blocked-${crypto.randomUUID()}@invalid.local`,
    password,
  });

  if (!rateLimit.allowed || !result.session) {
    const response = NextResponse.redirect(
      getLoginRedirect(request, {
        error: "invalid_credentials",
        language,
        returnTo,
      }),
      303,
    );
    response.headers.set("Cache-Control", "no-store");
    if (!rateLimit.allowed) response.headers.set("Retry-After", String(rateLimit.retryAfter));
    return response;
  }

  await clearLoginAuthLimits({ account: email, request });
  const cookie = createSessionCookie(result.session);
  const response = NextResponse.redirect(new URL(returnTo, request.url), 303);
  response.cookies.set(cookie.name, cookie.value, getSessionCookieOptions(cookie.maxAge));
  response.headers.set("Cache-Control", "no-store");
  return response;
}
