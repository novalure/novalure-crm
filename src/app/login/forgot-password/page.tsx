import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import subpageStyles from "@/components/public-subpage.module.css";
import { PublicSiteShell } from "@/components/public-site-shell";
import { getSessionFromHeaders } from "@/lib/auth/session";
import { getLoginPageCopy } from "@/lib/i18n";
import { resolvePublicLanguage, withPublicLanguage } from "@/lib/public-language";

type ForgotPasswordPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export const metadata: Metadata = {
  title: "Reset password | Novalure CRM",
  description: "Request a secure password reset link for Novalure CRM.",
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
  if (error === "rate_limited") return reset.errors.rate_limited;
  if (error === "reset_unavailable") return reset.errors.reset_unavailable;
  return "";
}

function getForgotLanguageHref(language: "de" | "en", email: string, sent = false) {
  const params = new URLSearchParams({ lang: language });
  if (email) params.set("email", email);
  if (sent) params.set("sent", "1");
  return `/login/forgot-password?${params.toString()}`;
}

export default async function ForgotPasswordPage({ searchParams }: ForgotPasswordPageProps) {
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
  const email = getQueryValue(query.email);
  const errorText = getResetErrorText(getQueryValue(query.error), reset);
  const sent = getQueryValue(query.sent) === "1";
  const intro = language === "de"
    ? {
        body: "Fordern Sie einen einmaligen Link an. Aus Sicherheitsgründen wird unabhängig vom Kontostatus dieselbe Bestätigung angezeigt.",
        eyebrow: "Sicherer Kontozugang",
        title: "Zugang wiederherstellen.",
      }
    : {
        body: "Request a single-use link. For security, the same confirmation is shown regardless of the account status.",
        eyebrow: "Secure account access",
        title: "Restore your access.",
      };

  return (
    <PublicSiteShell
      currentPath="/login/forgot-password"
      language={language}
      languageHrefs={{
        de: getForgotLanguageHref("de", email, sent),
        en: getForgotLanguageHref("en", email, sent),
      }}
    >
      <div className={subpageStyles.authLayout}>
        <section className={subpageStyles.authIntro}>
          <p className={subpageStyles.eyebrow}>{intro.eyebrow}</p>
          <h1>{intro.title}</h1>
          <p>{intro.body}</p>
        </section>

        <section aria-labelledby="forgot-password-heading" className={subpageStyles.authCard}>
          <h2 id="forgot-password-heading">{reset.requestTitle}</h2>
          <p>{reset.requestDescription}</p>

          {sent ? (
            <p
              aria-live="polite"
              className={subpageStyles.noticeSuccess}
              role="status"
            >
              {reset.requestSuccess}
            </p>
          ) : null}

          {errorText ? (
            <p
              aria-live="polite"
              className={subpageStyles.noticeError}
              role="alert"
            >
              {errorText}
            </p>
          ) : null}

          <form action="/api/auth/password-reset/request" className={subpageStyles.form} method="post">
            <input name="lang" type="hidden" value={language} />
            <label className={subpageStyles.field}>
              {reset.emailLabel}
              <input
                autoComplete="email"
                className={subpageStyles.input}
                defaultValue={email}
                name="email"
                placeholder={login.placeholderEmail}
                required
                type="email"
              />
            </label>
            <button
              className={subpageStyles.submitButton}
              type="submit"
            >
              {reset.requestSubmit}
            </button>
          </form>

          <p className={subpageStyles.authHelp}>{reset.requestHelp}</p>
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
