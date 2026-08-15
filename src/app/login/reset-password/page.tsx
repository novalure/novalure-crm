import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import subpageStyles from "@/components/public-subpage.module.css";
import { PublicSiteShell } from "@/components/public-site-shell";
import { SubmitOnceForm } from "@/components/submit-once-form";
import { getSessionFromHeaders } from "@/lib/auth/session";
import {
  createPasswordResetFormToken,
  hasValidPasswordResetExchange,
} from "@/lib/auth/password-reset";
import { getLoginPageCopy } from "@/lib/i18n";
import { withPublicLanguage } from "@/lib/public-language";
import { buildPublicPageMetadata, resolvePublicPageLanguage } from "@/lib/page-metadata";

type ResetPasswordPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ searchParams }: ResetPasswordPageProps): Promise<Metadata> {
  const requestHeaders = await headers();
  const query = searchParams ? await searchParams : {};
  const language = resolvePublicPageLanguage(requestHeaders, query);
  return buildPublicPageMetadata({
    description: language === "de"
      ? "Legen Sie ein neues, starkes Passwort für Ihren Novalure CRM Zugang fest."
      : "Create a new, strong password for your Novalure CRM access.",
    language,
    path: "/login/reset-password",
    title: language === "de" ? "Neues Passwort festlegen" : "Create new password",
  });
}

function getQueryValue(value: string | string[] | undefined, fallback = "") {
  if (Array.isArray(value)) return value[0] ?? fallback;
  return value ?? fallback;
}

function getResetErrorText(error: string, reset: ReturnType<typeof getLoginPageCopy>["passwordReset"]) {
  if (error === "invalid_token") return reset.errors.invalid_token;
  if (error === "password_mismatch") return reset.errors.password_mismatch;
  if (error === "password_required") return reset.errors.password_required;
  if (error === "password_too_short") return reset.errors.password_too_short;
  if (error === "reset_unavailable") return reset.errors.reset_unavailable;
  return "";
}

function getResetLanguageHref(language: "de" | "en", error: string) {
  const params = new URLSearchParams({ lang: language });
  if (error) params.set("error", error);
  return `/login/reset-password?${params.toString()}`;
}

export default async function ResetPasswordPage({ searchParams }: ResetPasswordPageProps) {
  const requestHeaders = await headers();
  const session = await getSessionFromHeaders(requestHeaders);
  const query = searchParams ? await searchParams : {};

  if (session) redirect("/");

  const language = resolvePublicPageLanguage(requestHeaders, query);
  const login = getLoginPageCopy(language);
  const reset = login.passwordReset;
  const hasExchange = await hasValidPasswordResetExchange(requestHeaders);
  const formToken = hasExchange ? createPasswordResetFormToken(requestHeaders) : null;
  const errorCode = getQueryValue(query.error, hasExchange ? "" : "invalid_token");
  const errorText = getResetErrorText(errorCode, reset);
  const canSubmit = hasExchange && Boolean(formToken);
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
        de: getResetLanguageHref("de", errorCode),
        en: getResetLanguageHref("en", errorCode),
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
            <SubmitOnceForm action="/api/auth/password-reset/confirm" className={subpageStyles.form} method="post">
              <input name="lang" type="hidden" value={language} />
              <input name="csrf" type="hidden" value={formToken ?? ""} />
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
            </SubmitOnceForm>
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
