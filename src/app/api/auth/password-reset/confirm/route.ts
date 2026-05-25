import { NextResponse } from "next/server";
import { confirmPasswordReset } from "@/lib/auth/password-reset";
import { resolveLanguage } from "@/lib/i18n";

function getFormValue(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const language = resolveLanguage(getFormValue(formData, "lang"));
  const token = getFormValue(formData, "token");
  const result = await confirmPasswordReset({
    confirmation: getFormValue(formData, "confirmPassword"),
    password: getFormValue(formData, "password"),
    token,
  });

  if (result.status === "ok") {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("lang", language);
    loginUrl.searchParams.set("reset", "password_reset");
    loginUrl.searchParams.set("email", result.email);
    return NextResponse.redirect(loginUrl, 303);
  }

  const resetUrl = new URL("/login/reset-password", request.url);
  resetUrl.searchParams.set("lang", language);
  resetUrl.searchParams.set(
    "error",
    result.status === "unavailable" ? "reset_unavailable" : result.status,
  );

  if (result.status !== "invalid_token" && token) {
    resetUrl.searchParams.set("token", token);
  }

  return NextResponse.redirect(resetUrl, 303);
}
