import { NextResponse } from "next/server";
import {
  authenticateLogin,
  cancelLoginChallenge,
  continueLogin,
  createSessionCookie,
  getLoginChallengeCookieOptions,
  getSessionCookieOptions,
  loginChallengeCookieName,
} from "@/lib/auth/session";
import { getTrustedAppOrigin } from "@/lib/auth/app-origin";
import { protectAuthResponse } from "@/lib/auth/response-security";
import { isLanguageCode, type LanguageCode } from "@/lib/language-runtime";
import { resolveSafeLocalRedirect } from "@/lib/security/redirects";
import { validateCsrfRequestContext } from "@/lib/security/csrf-core";

function getFormValue(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

function getLanguageValue(value: string): LanguageCode | "" {
  const normalized = value.trim().toLowerCase();
  return isLanguageCode(normalized) ? normalized : "";
}

function getLoginRedirect(
  trustedOrigin: string,
  input: { error?: string; language?: LanguageCode | ""; returnTo?: string },
) {
  const url = new URL("/login", trustedOrigin);
  if (input.language) url.searchParams.set("lang", input.language);
  if (input.error) url.searchParams.set("error", input.error);
  if (input.returnTo) url.searchParams.set("returnTo", input.returnTo);
  return url;
}

export async function POST(request: Request) {
  const trustedOrigin = getTrustedAppOrigin();
  const requestContext = validateCsrfRequestContext(request.headers, trustedOrigin);
  if (!requestContext.ok) {
    return protectAuthResponse(
      NextResponse.json({ error: "Login request validation failed" }, { status: 403 }),
    );
  }
  const formData = await request.formData();
  const email = getFormValue(formData, "email");
  const password = getFormValue(formData, "password") || getFormValue(formData, "passcode");
  const language = getLanguageValue(getFormValue(formData, "language") || getFormValue(formData, "lang"));
  const returnTo = resolveSafeLocalRedirect(getFormValue(formData, "returnTo"), {
    blockedPathPrefixes: ["/api", "/login"],
    fallback: "/",
    trustedOrigin,
  });
  const flow = getFormValue(formData, "flow");
  if (flow === "cancel") {
    try {
      await cancelLoginChallenge(request);
    } catch {
      // Clearing the browser challenge remains safe; expired enrollment
      // payloads are scrubbed by the next challenge cleanup.
    }
    const response = NextResponse.redirect(
      getLoginRedirect(trustedOrigin, { language, returnTo }),
      303,
    );
    response.cookies.set(loginChallengeCookieName, "", getLoginChallengeCookieOptions(0));
    return protectAuthResponse(response);
  }
  const result = flow === "challenge"
    ? await continueLogin({
        code: getFormValue(formData, "code"),
        recoveryCodesSaved: getFormValue(formData, "recoveryCodesSaved") === "1",
        request,
        workspaceUserId: getFormValue(formData, "workspaceUserId"),
      })
    : await authenticateLogin({ email, password, request });

  if (result.challenge) {
    const challengeUrl = getLoginRedirect(trustedOrigin, { language, returnTo });
    challengeUrl.searchParams.set("step", result.challenge.challengeKind);
    const response = NextResponse.redirect(challengeUrl, 303);
    response.cookies.set(
      loginChallengeCookieName,
      result.challenge.challengeCookie,
      getLoginChallengeCookieOptions(),
    );
    return protectAuthResponse(response);
  }

  if (!result.session) {
    const response = NextResponse.redirect(
      getLoginRedirect(trustedOrigin, {
        error: result.error ?? "invalid_credentials",
        language,
        returnTo,
      }),
      303,
    );
    if (flow !== "challenge") {
      response.cookies.set(loginChallengeCookieName, "", getLoginChallengeCookieOptions(0));
    }
    return protectAuthResponse(response);
  }

  try {
    const cookie = await createSessionCookie(result.session, request);
    const response = NextResponse.redirect(new URL(returnTo, trustedOrigin), 303);
    response.cookies.set(cookie.name, cookie.value, getSessionCookieOptions(cookie.maxAge));
    response.cookies.set(loginChallengeCookieName, "", getLoginChallengeCookieOptions(0));
    return protectAuthResponse(response);
  } catch {
    const response = NextResponse.redirect(
      getLoginRedirect(trustedOrigin, {
        error: "database_unavailable",
        language,
        returnTo,
      }),
      303,
    );
    response.cookies.set(loginChallengeCookieName, "", getLoginChallengeCookieOptions(0));
    return protectAuthResponse(response);
  }
}
