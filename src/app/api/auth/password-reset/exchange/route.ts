import { NextResponse } from "next/server";
import { getTrustedAppOrigin } from "@/lib/auth/app-origin";
import { createOpaqueToken } from "@/lib/auth/auth-security";
import {
  createPasswordResetExchangeFormToken,
  exchangePasswordResetToken,
  getPasswordResetExchangeCookieOptions,
  isPasswordResetEmailToken,
  passwordResetExchangeCookieName,
  validatePasswordResetExchangeFormToken,
} from "@/lib/auth/password-reset";
import { protectAuthResponse } from "@/lib/auth/response-security";
import { resolveLanguage, type LanguageCode } from "@/lib/i18n";
import { validateCsrfRequestContext } from "@/lib/security/csrf-core";

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function exchangeLandingResponse(input: {
  formToken?: string;
  language: LanguageCode;
  status?: number;
}) {
  const copy = input.language === "de"
    ? {
        button: "Sicher fortfahren",
        description: "Bestätigen Sie den Wechsel zur geschützten Passwortseite.",
        invalid: "Dieser Link ist ungültig. Fordern Sie einen neuen Passwort-Link an.",
        title: "Passwort sicher zurücksetzen",
      }
    : {
        button: "Continue securely",
        description: "Confirm the transition to the protected password page.",
        invalid: "This link is invalid. Request a new password link.",
        title: "Secure password reset",
      };
  const hasForm = Boolean(input.formToken);
  const scriptNonce = createOpaqueToken(18);
  const body = `<!doctype html>
<html lang="${input.language}">
  <head>
    <meta charset="utf-8">
    <meta content="no-referrer" name="referrer">
    <meta content="width=device-width, initial-scale=1" name="viewport">
    <title>${escapeHtml(copy.title)} | Novalure CRM</title>
    ${hasForm
      ? `<script nonce="${scriptNonce}">
      (() => {
        const fragment = window.location.hash.startsWith("#")
          ? window.location.hash.slice(1)
          : "";
        const token = new URLSearchParams(fragment).get("token") || "";
        window.history.replaceState(
          window.history.state,
          "",
          window.location.pathname + window.location.search,
        );
        document.addEventListener("DOMContentLoaded", () => {
          const form = document.getElementById("reset-exchange-form");
          const tokenInput = document.getElementById("reset-exchange-token");
          const description = document.getElementById("reset-exchange-description");
          const invalid = document.getElementById("reset-exchange-invalid");
          if (/^[A-Za-z0-9_-]{43}$/.test(token) && form && tokenInput && description) {
            tokenInput.value = token;
            description.hidden = false;
            form.hidden = false;
          } else if (invalid) {
            invalid.hidden = false;
          }
        }, { once: true });
      })();
    </script>`
      : ""}
  </head>
  <body>
    <main>
      <h1>${escapeHtml(copy.title)}</h1>
      <p ${hasForm ? "hidden" : ""} id="reset-exchange-invalid">${escapeHtml(copy.invalid)}</p>
      ${hasForm
        ? `<p hidden id="reset-exchange-description">${escapeHtml(copy.description)}</p>
      <form action="/api/auth/password-reset/exchange" hidden id="reset-exchange-form" method="post">
        <input name="lang" type="hidden" value="${input.language}">
        <input id="reset-exchange-token" name="token" type="hidden" value="">
        <input name="csrf" type="hidden" value="${escapeHtml(input.formToken ?? "")}">
        <button type="submit">${escapeHtml(copy.button)}</button>
      </form>
      <noscript>${escapeHtml(copy.invalid)}</noscript>`
        : ""}
    </main>
  </body>
</html>`;
  const response = new Response(body, {
    headers: {
      "Content-Security-Policy": `default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; script-src 'nonce-${scriptNonce}'`,
      "Content-Type": "text/html; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
    status: input.status ?? 200,
  });
  return protectAuthResponse(response, { noReferrer: true });
}

function protectedFailure(error: string, status: number) {
  return protectAuthResponse(NextResponse.json({ error }, { status }), { noReferrer: true });
}

function getFormValue(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const language = resolveLanguage(requestUrl.searchParams.get("lang"));

  try {
    const formToken = createPasswordResetExchangeFormToken();
    return exchangeLandingResponse({ formToken, language });
  } catch {
    return exchangeLandingResponse({ language, status: 503 });
  }
}

export async function POST(request: Request) {
  const requestContext = validateCsrfRequestContext(request.headers, getTrustedAppOrigin());
  if (!requestContext.ok) return protectedFailure("Reset exchange request context is invalid", 403);

  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/x-www-form-urlencoded") {
    return protectedFailure("Reset exchange content type is invalid", 415);
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return protectedFailure("Reset exchange form is invalid", 400);
  }

  const language = resolveLanguage(getFormValue(formData, "lang"));
  const token = getFormValue(formData, "token");
  const formToken = getFormValue(formData, "csrf");
  try {
    if (!isPasswordResetEmailToken(token) || !validatePasswordResetExchangeFormToken({ formToken })) {
      return protectedFailure("Reset exchange validation failed", 403);
    }
  } catch {
    return protectedFailure("Reset exchange validation failed", 503);
  }

  const finalUrl = new URL("/login/reset-password", getTrustedAppOrigin());
  finalUrl.searchParams.set("lang", language);
  let exchange = null;
  try {
    exchange = await exchangePasswordResetToken(token, request);
  } catch {
    exchange = null;
  }

  if (!exchange) finalUrl.searchParams.set("error", "invalid_token");
  const response = NextResponse.redirect(finalUrl, 303);
  if (exchange) {
    response.cookies.set(
      passwordResetExchangeCookieName,
      exchange.cookieValue,
      getPasswordResetExchangeCookieOptions(),
    );
  } else {
    response.cookies.set(
      passwordResetExchangeCookieName,
      "",
      getPasswordResetExchangeCookieOptions(0),
    );
  }
  return protectAuthResponse(response, { noReferrer: true });
}
