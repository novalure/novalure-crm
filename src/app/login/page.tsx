import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { CookieConsentButton } from "@/components/cookie-consent-button";
import { LoginEmailAutofocus } from "@/components/login-email-autofocus";
import { LoginUrlHygiene } from "@/components/login-url-hygiene";
import { PasswordVisibilityInput } from "@/components/password-visibility-input";
import { getSessionFromHeaders, isLoginConfigured } from "@/lib/auth/session";
import {
  getCrmLandingPageCopy,
  getLoginLegalFooterCopy,
  getLoginPageCopy,
  getPublicPageCopy,
  languageRequestHeaderName,
  type LanguageCode,
} from "@/lib/i18n";
import { companyLegalDetails, publicLegalLinks, publicSiteOrigin } from "@/lib/legal";
import { getRequestCountry, resolveAuditHref } from "@/lib/public-audit";
import { resolvePublicLanguage } from "@/lib/public-language";

type LoginPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export const metadata: Metadata = {
  title: "Login | Novalure CRM",
  description: "Protected Novalure CRM workspace login for approved teams.",
};

function getQueryValue(value: string | string[] | undefined, fallback = "") {
  if (Array.isArray(value)) return value[0] ?? fallback;
  return value ?? fallback;
}

function getSafeReturnTo(value: string) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  if (value.startsWith("/api/") || value.startsWith("/login")) return "/";
  return value;
}

function getErrorText(error: string, text: ReturnType<typeof getLoginPageCopy>) {
  if (error === "login_not_configured") {
    return text.errors.login_not_configured;
  }

  if (error === "database_unavailable") {
    return text.errors.database_unavailable;
  }

  if (error) return text.errors.invalid;
  return "";
}

function getStatusText(status: string, text: ReturnType<typeof getLoginPageCopy>) {
  if (status === "password_reset") {
    return text.passwordReset.loginSuccess;
  }

  return "";
}

function getForgotPasswordHref(language: LanguageCode) {
  const params = new URLSearchParams({ lang: language });
  return `/login/forgot-password?${params.toString()}`;
}

function getLoginLanguageHref(
  language: LanguageCode,
  query: Record<string, string | string[] | undefined>,
) {
  const params = new URLSearchParams({ lang: language });

  for (const key of ["error", "reset", "returnTo"]) {
    const value = getQueryValue(query[key]);
    if (value) params.set(key, value);
  }

  return `/login?${params.toString()}`;
}

function getCanonicalPublicHref(path: string, language: LanguageCode) {
  const url = new URL(path, publicSiteOrigin);
  url.searchParams.set("lang", language);
  return url.toString();
}

function MailIcon() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
      <path
        d="M4.8 6.8h14.4v10.4H4.8V6.8Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="m5.2 7.2 6.8 5.4 6.8-5.4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
      <path
        d="M7.2 10.4h9.6v8H7.2v-8Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="M9 10.4V8.2a3 3 0 0 1 6 0v2.2"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function ArrowRightIcon() {
  return (
    <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
      <path
        d="M5 12h13.5m-5-5 5 5-5 5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const requestHeaders = await headers();
  const session = await getSessionFromHeaders(requestHeaders);
  const query = searchParams ? await searchParams : {};
  const country = getRequestCountry(requestHeaders);
  const language = resolvePublicLanguage({
    acceptLanguage: requestHeaders.get("accept-language"),
    country,
    persistedLanguage: requestHeaders.get(languageRequestHeaderName),
    requestedLanguage: query.lang,
  });
  const returnTo = getSafeReturnTo(getQueryValue(query.returnTo, "/"));

  if (session) {
    redirect(returnTo);
  }

  const loginCopy = getLoginPageCopy(language);
  const pageCopy = getPublicPageCopy(language);
  const landingCopy = getCrmLandingPageCopy(language);
  const legalCopy = getLoginLegalFooterCopy(language);
  const configured = isLoginConfigured();
  const errorText = getErrorText(getQueryValue(query.error), loginCopy);
  const statusText = getStatusText(getQueryValue(query.reset), loginCopy);
  const hasLoginNotice = !configured || Boolean(errorText) || Boolean(statusText);
  const auditHref = resolveAuditHref(country, language);
  const publicHomeHref = getCanonicalPublicHref("/", language);
  const cookieHref = getCanonicalPublicHref("/cookies", language);
  const privacyHref = getCanonicalPublicHref("/privacy", language);
  const loginHeroAlt =
    language === "de"
      ? "Immobilien-Workspace mit Lead- und Aufgabenübersicht"
      : "Real estate workspace with lead and task overview";

  return (
    <main className="min-h-dvh bg-[#f7fbff] text-[#0B0B0F]" lang={language}>
      <div className="flex min-h-dvh flex-col md:flex-row">
        <section className="sticky top-0 hidden h-dvh w-1/2 overflow-hidden md:block" aria-label={loginCopy.brand}>
          <Image
            alt={loginHeroAlt}
            className="object-cover"
            fill
            priority
            sizes="50vw"
            src="/images/login-hero.jpg"
            style={{
              objectPosition: "left center",
              transform: "scale(1.14)",
              transformOrigin: "left center",
            }}
          />
          <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/70 via-black/30 to-transparent" />
          <a
            className="absolute bottom-20 left-10 text-2xl font-semibold tracking-normal text-white outline-none transition focus-visible:ring-2 focus-visible:ring-white/80"
            href={publicHomeHref}
          >
            {loginCopy.brand}
          </a>
        </section>

        <section className="relative flex min-h-dvh w-full flex-col px-5 py-5 sm:px-8 md:w-1/2 md:bg-[#ffffff] md:px-8 md:py-6 lg:px-10 lg:py-8">
          <nav aria-label={pageCopy.languageAriaLabel} className="flex shrink-0 items-center justify-end gap-2 text-xs font-semibold uppercase tracking-normal text-[#667085]">
            <Link
              aria-current={language === "de" ? "page" : undefined}
              aria-label={pageCopy.switchToGerman}
              className={`inline-flex min-h-11 min-w-11 items-center justify-center rounded-[9999px] px-3 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93c5fd] ${
                language === "de"
                  ? "bg-[#0B0B0F] text-white"
                  : "text-[#667085] hover:bg-[#edf5ff] hover:text-[#0B0B0F]"
              }`}
              href={getLoginLanguageHref("de", query)}
              title={pageCopy.switchToGerman}
            >
              {pageCopy.switchToGermanShort}
            </Link>
            <span aria-hidden="true" className="text-[#c2c8d0]">
              |
            </span>
            <Link
              aria-current={language === "en" ? "page" : undefined}
              aria-label={pageCopy.switchToEnglish}
              className={`inline-flex min-h-11 min-w-11 items-center justify-center rounded-[9999px] px-3 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93c5fd] ${
                language === "en"
                  ? "bg-[#0B0B0F] text-white"
                  : "text-[#667085] hover:bg-[#edf5ff] hover:text-[#0B0B0F]"
              }`}
              href={getLoginLanguageHref("en", query)}
              title={pageCopy.switchToEnglish}
            >
              {pageCopy.switchToEnglishShort}
            </Link>
          </nav>

          <div className="flex flex-1 items-center justify-center py-6 md:py-4 lg:py-6">
            <div className="w-full max-w-[440px] rounded-[8px] border border-[#e5e7eb] bg-[#ffffff] p-5 shadow-[0_24px_80px_rgba(11,11,15,0.08)] sm:p-6 lg:p-8">
              <div>
                <h1 className="text-4xl font-bold leading-tight tracking-normal text-[#0B0B0F] sm:text-[40px]">
                  {loginCopy.title}
                </h1>
                <p className="mt-3 text-sm leading-6 text-[#667085]">{loginCopy.description}</p>
              </div>

              {hasLoginNotice ? (
                <div className="mt-5 grid gap-3">
                  {!configured ? (
                    <p className="rounded-[8px] border border-[#d7b56d] bg-[#fff7df] px-3 py-2 text-sm font-semibold leading-6 text-[#6d4d04]">
                      {loginCopy.notConfigured}
                    </p>
                  ) : null}

                  {errorText ? (
                    <p
                      aria-live="polite"
                      className="rounded-[8px] border border-[#e2a7a7] bg-[#fff1f1] px-3 py-2 text-sm font-semibold leading-6 text-[#7d2020]"
                      role="alert"
                    >
                      {errorText}
                    </p>
                  ) : null}

                  {statusText ? (
                    <p
                      aria-live="polite"
                      className="rounded-[8px] border border-[#9ed7bf] bg-[#edfff6] px-3 py-2 text-sm font-semibold leading-6 text-[#0f5132]"
                    >
                      {statusText}
                    </p>
                  ) : null}
                </div>
              ) : null}

              <form action="/api/auth/login" className="mt-5 grid gap-5" method="post">
                <LoginEmailAutofocus />
                <LoginUrlHygiene clearError={Boolean(errorText)} />
                <input name="returnTo" type="hidden" value={returnTo} />
                <input name="language" type="hidden" value={language} />
                <div className="grid gap-2">
                  <label className="text-sm font-semibold text-[#344054]" htmlFor="login-email">
                    {loginCopy.emailLabel}
                  </label>
                  <div className="relative">
                    <span className="pointer-events-none absolute inset-y-0 left-4 flex items-center text-[#8a95a3]">
                      <MailIcon />
                    </span>
                    <input
                      autoComplete="email"
                      autoFocus
                      className="login-auth-input min-h-12 w-full rounded-[12px] border border-[#d0d5dd] bg-[#ffffff] py-3 pl-12 pr-4 text-sm font-normal text-[#0B0B0F] outline-none transition placeholder:text-[#98a2b3] focus:border-[#93c5fd] focus:ring-4 focus:ring-[#d9ecff]"
                      id="login-email"
                      name="email"
                      placeholder={loginCopy.placeholderEmail}
                      required
                      type="email"
                    />
                  </div>
                </div>
                <div className="grid gap-2">
                  <label className="text-sm font-semibold text-[#344054]" htmlFor="login-password">
                    {loginCopy.passcodeLabel}
                  </label>
                  <div className="relative">
                    <span className="pointer-events-none absolute inset-y-0 left-4 z-10 flex items-center text-[#8a95a3]">
                      <LockIcon />
                    </span>
                    <PasswordVisibilityInput
                      autoComplete="off"
                      className="login-auth-input min-h-12 w-full rounded-[12px] border border-[#d0d5dd] bg-[#ffffff] py-3 pl-12 pr-12 text-sm font-normal text-[#0B0B0F] outline-none transition placeholder:text-[#98a2b3] focus:border-[#93c5fd] focus:ring-4 focus:ring-[#d9ecff]"
                      hideLabel={loginCopy.passcodeHideLabel}
                      id="login-password"
                      name="password"
                      required
                      showLabel={loginCopy.passcodeShowLabel}
                    />
                  </div>
                  <p className="text-sm font-normal leading-6 text-[#667085]">{loginCopy.passcodeHelp}</p>
                </div>
                <div className="flex justify-end">
                  <Link
                    className="text-sm font-semibold text-[#0B0B0F] underline-offset-4 transition hover:text-[#344054] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93c5fd]"
                    href={getForgotPasswordHref(language)}
                  >
                    {loginCopy.passwordReset.forgotLink}
                  </Link>
                </div>
                <button
                  className="login-auth-submit inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-[9999px] border border-[#0B0B0F] bg-[#0B0B0F] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#1f2937] disabled:cursor-not-allowed disabled:border-[#9ca7a0] disabled:bg-[#9ca7a0] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#d9ecff]"
                  disabled={!configured}
                  type="submit"
                >
                  <span>{loginCopy.submit}</span>
                  <ArrowRightIcon />
                </button>
              </form>

            <div className="mt-6 flex flex-col items-center justify-center gap-3 text-sm font-semibold text-[#667085] sm:flex-row sm:gap-5">
              <Link
                className="underline-offset-4 transition hover:text-[#0B0B0F] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93c5fd]"
                href={publicHomeHref}
              >
                {loginCopy.overviewLink}
              </Link>
              <a
                className="underline-offset-4 transition hover:text-[#0B0B0F] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93c5fd]"
                href={auditHref}
              >
                {loginCopy.auditLink}
              </a>
            </div>
            <p className="mt-5 text-center text-sm leading-6 text-[#667085]">
              {loginCopy.accessHelp.prefix}{" "}
              <a className="font-semibold text-[#0B0B0F] underline-offset-4 hover:underline" href={auditHref}>
                {loginCopy.accessHelp.auditLabel}
              </a>{" "}
              {loginCopy.accessHelp.connector}{" "}
              <a className="font-semibold text-[#0B0B0F] underline-offset-4 hover:underline" href={`mailto:${companyLegalDetails.email}`}>
                {companyLegalDetails.email}
              </a>
              .
            </p>
          </div>
          </div>
        </section>
      </div>

      <footer
        aria-label={legalCopy.ariaLabel}
        className="border-t border-[#d8ddd7] bg-[#eef7ff] px-5 py-8 text-sm leading-6 text-[#50645b] sm:px-8"
      >
        <div className="mx-auto grid w-full max-w-7xl gap-6 md:grid-cols-[1fr_auto]">
          <div>
            <a
              className="font-semibold text-[#0B0B0F] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93c5fd]"
              href={publicHomeHref}
            >
              {landingCopy.footerTagline}
            </a>
            <p className="mt-3">{legalCopy.companyLine}</p>
            <p className="mt-1">
              {legalCopy.contactPrefix}{" "}
              <a className="font-semibold text-[#0B0B0F] underline-offset-4 hover:underline" href={`mailto:${companyLegalDetails.email}`}>
                {companyLegalDetails.email}
              </a>
            </p>
          </div>
          <nav aria-label={legalCopy.ariaLabel} className="flex flex-wrap gap-x-5 gap-y-2 md:justify-end">
            {publicLegalLinks.map((link) => (
              <a
                className="font-semibold text-[#0B0B0F] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93c5fd]"
                href={getCanonicalPublicHref(link.href, language)}
                key={link.key}
              >
                {legalCopy.links[link.key]}
              </a>
            ))}
          </nav>
        </div>
      </footer>
      <CookieConsentButton cookieHref={cookieHref} copy={landingCopy.cookieConsent} placement="login" privacyHref={privacyHref} />
    </main>
  );
}
