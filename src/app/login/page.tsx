import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { LoginEmailAutofocus } from "@/components/login-email-autofocus";
import { PasswordVisibilityInput } from "@/components/password-visibility-input";
import { getSessionFromHeaders, isLoginConfigured } from "@/lib/auth/session";
import {
  getLoginPageCopy,
  getPublicPageCopy,
  languageRequestHeaderName,
  type LanguageCode,
} from "@/lib/i18n";
import { getRequestCountry, resolveAuditHref } from "@/lib/public-audit";
import { resolvePublicLanguage, withPublicLanguage } from "@/lib/public-language";

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

function getForgotPasswordHref(language: LanguageCode, email: string) {
  const params = new URLSearchParams({ lang: language });
  if (email) params.set("email", email);
  return `/login/forgot-password?${params.toString()}`;
}

function getLoginLanguageHref(
  language: LanguageCode,
  query: Record<string, string | string[] | undefined>,
) {
  const params = new URLSearchParams({ lang: language });

  for (const key of ["email", "error", "reset", "returnTo"]) {
    const value = getQueryValue(query[key]);
    if (value) params.set(key, value);
  }

  return `/login?${params.toString()}`;
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
  const configured = isLoginConfigured();
  const email = getQueryValue(query.email);
  const errorText = getErrorText(getQueryValue(query.error), loginCopy);
  const statusText = getStatusText(getQueryValue(query.reset), loginCopy);
  const auditHref = resolveAuditHref(country, language);

  return (
    <main className="min-h-dvh bg-[#f8f7f1] text-[#111614]" lang={language}>
      <header className="border-b border-[#d8ddd7] bg-white px-4 py-3">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4">
          <Link className="min-w-0 text-sm font-semibold tracking-normal text-[#111614] sm:text-base" href={withPublicLanguage("/", language)}>
            {loginCopy.brand}
          </Link>
          <nav aria-label={pageCopy.languageAriaLabel} className="flex shrink-0 items-center gap-1">
            <Link
              aria-current={language === "de" ? "page" : undefined}
              aria-label={pageCopy.switchToGerman}
              className={`inline-flex min-h-10 min-w-10 items-center justify-center rounded-md border px-2 text-xs font-semibold transition hover:border-[#111614] ${
                language === "de"
                  ? "border-[#111614] bg-[#111614] text-white"
                  : "border-[#cdd4ce] bg-white text-[#50645b]"
              }`}
              href={getLoginLanguageHref("de", query)}
              title={pageCopy.switchToGerman}
            >
              {pageCopy.switchToGermanShort}
            </Link>
            <Link
              aria-current={language === "en" ? "page" : undefined}
              aria-label={pageCopy.switchToEnglish}
              className={`inline-flex min-h-10 min-w-10 items-center justify-center rounded-md border px-2 text-xs font-semibold transition hover:border-[#111614] ${
                language === "en"
                  ? "border-[#111614] bg-[#111614] text-white"
                  : "border-[#cdd4ce] bg-white text-[#50645b]"
              }`}
              href={getLoginLanguageHref("en", query)}
              title={pageCopy.switchToEnglish}
            >
              {pageCopy.switchToEnglishShort}
            </Link>
          </nav>
        </div>
      </header>

      <section className="flex min-h-[calc(100dvh-65px)] items-center justify-center px-4 py-8 sm:py-10">
        <div className="w-full max-w-md">
          <div className="text-center">
            <h1 className="text-3xl font-semibold leading-tight text-[#111614]">{loginCopy.title}</h1>
            <p className="mt-3 text-sm leading-6 text-[#50645b]">{loginCopy.description}</p>
          </div>

          <div className="mt-6 rounded-lg border border-[#d8ddd7] bg-white p-5 shadow-sm sm:p-6">
            {!configured ? (
              <p className="rounded-md border border-[#d7b56d] bg-[#fff7df] px-3 py-2 text-sm font-semibold leading-6 text-[#6d4d04]">
                {loginCopy.notConfigured}
              </p>
            ) : null}

            {errorText ? (
              <p
                aria-live="polite"
                className="rounded-md border border-[#e2a7a7] bg-[#fff1f1] px-3 py-2 text-sm font-semibold leading-6 text-[#7d2020]"
                role="alert"
              >
                {errorText}
              </p>
            ) : null}

            {statusText ? (
              <p
                aria-live="polite"
                className="rounded-md border border-[#9ed7bf] bg-[#edfff6] px-3 py-2 text-sm font-semibold leading-6 text-[#0f5132]"
              >
                {statusText}
              </p>
            ) : null}

            <form action="/api/auth/login" className="mt-5 grid gap-4" method="post">
              <LoginEmailAutofocus />
              <input name="returnTo" type="hidden" value={returnTo} />
              <input name="language" type="hidden" value={language} />
              <div className="grid gap-2">
                <label className="text-sm font-semibold text-[#26342f]" htmlFor="login-email">
                  {loginCopy.emailLabel}
                </label>
                <input
                  autoComplete="email"
                  autoFocus
                  className="min-h-11 rounded-md border border-[#cdd4ce] bg-white px-3 py-2 text-sm font-normal text-[#111614] outline-none transition focus:border-[#111614] focus:ring-2 focus:ring-[#b8d8c8]"
                  defaultValue={email}
                  id="login-email"
                  name="email"
                  placeholder={loginCopy.placeholderEmail}
                  required
                  type="email"
                />
              </div>
              <div className="grid gap-2">
                <label className="text-sm font-semibold text-[#26342f]" htmlFor="login-password">
                  {loginCopy.passcodeLabel}
                </label>
                <PasswordVisibilityInput
                  autoComplete="current-password"
                  className="min-h-11 w-full rounded-md border border-[#cdd4ce] bg-white px-3 py-2 text-sm font-normal text-[#111614] outline-none transition focus:border-[#111614] focus:ring-2 focus:ring-[#b8d8c8]"
                  hideLabel={loginCopy.passcodeHideLabel}
                  id="login-password"
                  name="password"
                  required
                  showLabel={loginCopy.passcodeShowLabel}
                />
                <p className="text-sm font-normal leading-6 text-[#50645b]">{loginCopy.passcodeHelp}</p>
              </div>
              <div className="flex justify-end">
                <Link
                  className="text-sm font-semibold text-[#111614] underline-offset-4 hover:underline"
                  href={getForgotPasswordHref(language, email)}
                >
                  {loginCopy.passwordReset.forgotLink}
                </Link>
              </div>
              <button
                className="min-h-11 rounded-md border border-[#111614] bg-[#111614] px-4 py-3 text-sm font-semibold text-white transition hover:bg-[#26342f] disabled:cursor-not-allowed disabled:border-[#9ca7a0] disabled:bg-[#9ca7a0]"
                disabled={!configured}
                type="submit"
              >
                {loginCopy.submit}
              </button>
            </form>
          </div>

          <div className="mt-5 flex flex-col items-center justify-center gap-3 text-sm font-semibold sm:flex-row">
            <Link className="text-[#111614] underline-offset-4 hover:underline" href={withPublicLanguage("/", language)}>
              {loginCopy.overviewLink}
            </Link>
            <a className="text-[#277258] underline-offset-4 hover:underline" href={auditHref}>
              {loginCopy.auditLink}
            </a>
          </div>
        </div>
      </section>
    </main>
  );
}
