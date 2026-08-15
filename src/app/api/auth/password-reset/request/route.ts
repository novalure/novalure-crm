import { NextResponse } from "next/server";
import { requestPasswordReset } from "@/lib/auth/password-reset";
import { resolveLanguage } from "@/lib/i18n";

function getFormValue(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const email = getFormValue(formData, "email");
  const language = resolveLanguage(getFormValue(formData, "lang"));
  const result = await requestPasswordReset({ email, language, request });
  const redirectUrl = new URL("/login/forgot-password", request.url);

  redirectUrl.searchParams.set("lang", language);
  if (email) redirectUrl.searchParams.set("email", email);

  if (result.status === "rate_limited") {
    redirectUrl.searchParams.set("error", "rate_limited");
  } else if (result.status === "unavailable") {
    redirectUrl.searchParams.set("error", "reset_unavailable");
  } else {
    redirectUrl.searchParams.set("sent", "1");
  }

  return NextResponse.redirect(redirectUrl, 303);
}
