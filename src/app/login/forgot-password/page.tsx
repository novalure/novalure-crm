import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import subpageStyles from "@/components/public-subpage.module.css";
import { PublicSiteShell } from "@/components/public-site-shell";
import { SubmitOnceForm } from "@/components/submit-once-form";
import { getSessionFromHeaders } from "@/lib/auth/session";
import { getLoginPageCopy } from "@/lib/i18n";
import { withPublicLanguage } from "@/lib/public-language";
import { buildPublicPageMetadata, resolvePublicPageLanguage } from "@/lib/page-metadata";

type ForgotPasswordPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ searchParams }: ForgotPasswordPageProps): Promise<Metadata> {
  const requestHeaders = await headers();
  const query = searchParams ? await searchParams : {};
  const language = resolvePublicPageLanguage(requestHeaders, query);
  return buildPublicPageMetadata({
    description: language === "de"
      ? "Fordern Sie einen sicheren, einmalig nutzbaren Link für Ihren Novalure CRM Zugang an."
      : "Request a secure, single-use link for your Novalure CRM access.",
    language,
    path: "/login/forgot-password",
    title: language === "de" ? "Passwort zurücksetzen" : "Reset password",
  });
}

function getQueryValue(value: string | string[] | undefined, fallback = "") {
  if (Array.isArray(value)) return value[0] ?? fallback;
  return value ?? fallback;
}

function getForgotLanguageHref(language: "de" | "en", sent = false) {
  const params = new URLSearchParams({ lang: language });
  if (sent) params.set("sent", "1");
  return `/login/forgot-password?${params.toString()}`;
}

export default async function ForgotPasswordPage({ searchParams }: ForgotPasswordPageProps) {
  const requestHeaders = await headers();
  const session = await getSessionFromHeaders(requestHeaders);
  const query = searchParams ? await searchParams : {};

  if (session) redirect("/");

  const language = resolvePublicPageLanguage(requestHeaders, query);
  const login = getLoginPageCopy(language);
  const reset = login.passwordReset;
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
        de: getForgotLanguageHref("de", sent),
        en: getForgotLanguageHref("en", sent),
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

          <SubmitOnceForm action="/api/auth/password-reset/request" className={subpageStyles.form} method="post">
            <input name="lang" type="hidden" value={language} />
            <label className={subpageStyles.field}>
              {reset.emailLabel}
              <input
                autoComplete="username"
                className={subpageStyles.input}
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
          </SubmitOnceForm>

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
