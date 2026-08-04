import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import subpageStyles from "@/components/public-subpage.module.css";
import { PublicSiteShell } from "@/components/public-site-shell";
import { getSessionFromHeaders } from "@/lib/auth/session";
import { getLoginPageCopy } from "@/lib/i18n";
import { resolvePublicLanguage, withPublicLanguage } from "@/lib/public-language";

type ResetPasswordPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export const metadata: Metadata = {
  title: "Create new password | Novalure CRM",
  description: "Create a new password for Novalure CRM.",
};

function getQueryValue(value: string | string[] | undefined, fallback = "") {
  if (Array.isArray(value)) return value[0] ?? fallback;
  return value ?? fallback;
}

function getRequestCountry(requestHeaders: Headers) {
  return (
    requestHeaders.get("x-vercel-ip-country") ??
    requestHeaders.get("cf-ipcountry") ??
    requestHeaders.get("x-country-code")
  );
}

function getResetErrorText(error: string, reset: ReturnType<typeof getLoginPageCopy>["passwordReset"]) {
  if (error === "invalid_token") return reset.errors.invalid_token;
  if (error === "password_mismatch") return reset.errors.password_mismatch;
  if (error === "password_required") return reset.errors.password_required;
  if (error === "password_too_short") return reset.errors.password_too_short;
  if (error === "reset_unavailable") return reset.errors.reset_unavailable;
  return "";
}

function getResetLanguageHref(language: "de" | "en", token: string, error: string) {
  const params = new URLSearchParams({ lang: language });
  if (token) params.set("token", token);
  if (error) params.set("error", error);
  return `/login/reset-password?${params.toString()}`;
}

export default async function ResetPasswordPage({ searchParams }: ResetPasswordPageProps) {
  const requestHeaders = await headers();
  const session = await getSessionFromHeaders(requestHeaders);
  const query = searchParams ? await searchParams : {};

  if (session) redirect("/");

  const language = resolvePublicLanguage({
    acceptLanguage: requestHeaders.get("accept-language"),
    country: getRequestCountry(requestHeaders),
    requestedLanguage: query.lang,
  });
  const login = getLoginPageCopy(language);
  const reset = login.passwordReset;
  const token = getQueryValue(query.token);
  const errorCode = getQueryValue(query.error, token ? "" : "invalid_token");
  const errorText = getResetErrorText(errorCode, reset);
  const canSubmit = Boolean(token);
  const intro = language === "de"
    ? {
        body: "Legen Sie ein neues, starkes Passwort für Ihren geschützten Novalure Workspace fest.",
        eyebrow: "Sicherer Kontozugang",
        title: "Neues Passwort festlegen.",
      }
    : {
        body: "Create a new, strong password for your protected Novalure workspace.",
        eyebrow: "Secure account access",
        title: "Create a new password.",
      };

  return (
    <PublicSiteShell
      currentPath="/login/reset-password"
      language={language}
      languageHrefs={{
        de: getResetLanguageHref("de", token, errorCode),
        en: getResetLanguageHref("en", token, errorCode),
      }}
    >
      <div className={subpageStyles.authLayout}>
        <section className={subpageStyles.authIntro}>
          <p className={subpageStyles.eyebrow}>{intro.eyebrow}</p>
          <h1>{intro.title}</h1>
          <p>{intro.body}</p>
        </section>

        <section aria-labelledby="reset-password-heading" className={subpageStyles.authCard}>
          <h2 id="reset-password-heading">{reset.resetTitle}</h2>
          <p>{reset.resetDescription}</p>

          {errorText ? (
            <p
              aria-live="polite"
              className={subpageStyles.noticeError}
              role="alert"
            >
              {errorText}
            </p>
          ) : null}

          {canSubmit ? (
            <form action="/api/auth/password-reset/confirm" className={subpageStyles.form} method="post">
              <input name="lang" type="hidden" value={language} />
              <input name="token" type="hidden" value={token} />
              <label className={subpageStyles.field}>
                {reset.newPasswordLabel}
                <input
                  autoComplete="new-password"
                  className={subpageStyles.input}
                  minLength={15}
                  name="password"
                  required
                  type="password"
                />
              </label>
              <label className={subpageStyles.field}>
                {reset.confirmPasswordLabel}
                <input
                  autoComplete="new-password"
                  className={subpageStyles.input}
                  minLength={15}
                  name="confirmPassword"
                  required
                  type="password"
                />
              </label>
              <p className={subpageStyles.fieldHelp}>{reset.passwordHelp}</p>
              <button
                className={subpageStyles.submitButton}
                type="submit"
              >
                {reset.resetSubmit}
              </button>
            </form>
          ) : null}

          <Link
            className={subpageStyles.textLink}
            href={withPublicLanguage("/login", language)}
          >
            {reset.backToLogin}
          </Link>
        </section>
      </div>
    </PublicSiteShell>
  );
}
