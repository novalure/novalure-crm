import { NextResponse } from "next/server";
import { getTrustedAppOrigin } from "@/lib/auth/app-origin";
import { protectAuthResponse } from "@/lib/auth/response-security";
import {
  confirmPasswordReset,
  getPasswordResetExchangeCookieOptions,
  passwordResetExchangeCookieName,
} from "@/lib/auth/password-reset";
import { resolveLanguage } from "@/lib/i18n";

function getFormValue(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const language = resolveLanguage(getFormValue(formData, "lang"));
  const result = await confirmPasswordReset({
    confirmation: getFormValue(formData, "confirmPassword"),
    formToken: getFormValue(formData, "csrf"),
    password: getFormValue(formData, "password"),
    request,
  });

  if (result.status === "ok") {
    const loginUrl = new URL("/login", getTrustedAppOrigin());
    loginUrl.searchParams.set("lang", language);
    loginUrl.searchParams.set("reset", "password_reset");
    const response = NextResponse.redirect(loginUrl, 303);
    response.cookies.set(
      passwordResetExchangeCookieName,
      "",
      getPasswordResetExchangeCookieOptions(0),
    );
    return protectAuthResponse(response, { noReferrer: true });
  }

  const resetUrl = new URL("/login/reset-password", getTrustedAppOrigin());
  resetUrl.searchParams.set("lang", language);
  resetUrl.searchParams.set(
    "error",
    result.status === "unavailable" ? "reset_unavailable" : result.status,
  );

  const response = NextResponse.redirect(resetUrl, 303);
  if (result.status === "invalid_token") {
    response.cookies.set(
      passwordResetExchangeCookieName,
      "",
      getPasswordResetExchangeCookieOptions(0),
    );
  }
  return protectAuthResponse(response, { noReferrer: true });
}
