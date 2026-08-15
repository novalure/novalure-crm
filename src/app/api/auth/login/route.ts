import { NextResponse } from "next/server";
import {
  authenticateLogin,
  createSessionCookie,
  getSessionCookieOptions,
} from "@/lib/auth/session";
import { isLanguageCode, type LanguageCode } from "@/lib/language-runtime";

function getFormValue(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

function getSafeReturnTo(value: string) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  if (value.startsWith("/api/")) return "/";
  return value;
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
  if (input.returnTo) url.searchParams.set("returnTo", getSafeReturnTo(input.returnTo));
  return url;
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const email = getFormValue(formData, "email");
  const password = getFormValue(formData, "password") || getFormValue(formData, "passcode");
  const language = getLanguageValue(getFormValue(formData, "language") || getFormValue(formData, "lang"));
  const returnTo = getSafeReturnTo(getFormValue(formData, "returnTo"));
  const result = await authenticateLogin({ email, password });

  if (!result.session) {
    return NextResponse.redirect(
      getLoginRedirect(request, {
        error: result.error ?? "invalid_credentials",
        language,
        returnTo,
      }),
      303,
    );
  }

  const cookie = createSessionCookie(result.session);
  const response = NextResponse.redirect(new URL(returnTo, request.url), 303);
  response.cookies.set(cookie.name, cookie.value, getSessionCookieOptions(cookie.maxAge));
  return response;
}
