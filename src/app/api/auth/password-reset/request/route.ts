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
  await requestPasswordReset({ email, language, request });
  const redirectUrl = new URL("/login/forgot-password", request.url);

  redirectUrl.searchParams.set("lang", language);
  redirectUrl.searchParams.set("sent", "1");

  const response = NextResponse.redirect(redirectUrl, 303);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
