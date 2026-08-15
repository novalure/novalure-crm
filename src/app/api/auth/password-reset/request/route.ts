import { NextResponse } from "next/server";
import { requestPasswordReset } from "@/lib/auth/password-reset";
import { getTrustedAppOrigin } from "@/lib/auth/app-origin";
import { protectAuthResponse } from "@/lib/auth/response-security";
import { resolveLanguage } from "@/lib/i18n";
import { validateCsrfRequestContext } from "@/lib/security/csrf-core";

function getFormValue(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

export async function POST(request: Request) {
  const trustedOrigin = getTrustedAppOrigin();
  const requestContext = validateCsrfRequestContext(request.headers, trustedOrigin);
  if (!requestContext.ok) {
    return protectAuthResponse(
      NextResponse.json({ error: "Reset request validation failed" }, { status: 403 }),
    );
  }
  const formData = await request.formData();
  const email = getFormValue(formData, "email");
  const language = resolveLanguage(getFormValue(formData, "lang"));
  await requestPasswordReset({ email, language, request });
  const redirectUrl = new URL("/login/forgot-password", trustedOrigin);

  redirectUrl.searchParams.set("lang", language);
  redirectUrl.searchParams.set("sent", "1");

  return protectAuthResponse(NextResponse.redirect(redirectUrl, 303));
}
