import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionFromHeaders } from "@/lib/auth/session";
import { getLoginPageCopy, getPublicPageCopy } from "@/lib/i18n";
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

function getResetLanguageHref(language: "de" | "en", token: string) {
  const params = new URLSearchParams({ lang: language });
  if (token) params.set("token", token);
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
  const page = getPublicPageCopy(language);
  const reset = login.passwordReset;
  const token = getQueryValue(query.token);
  const errorText = getResetErrorText(getQueryValue(query.error, token ? "" : "invalid_token"), reset);
  const canSubmit = Boolean(token);

  return (
    <main className="min-h-dvh bg-[#f7fbff] px-4 py-10 text-[#071421]" lang={language}>
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
        <header className="flex items-center justify-between gap-4">
          <Link className="text-base font-semibold text-[#071421]" href={withPublicLanguage("/login", language)}>
            {login.brand}
          </Link>
          <nav aria-label={page.languageAriaLabel} className="flex items-center gap-1">
            <Link
              aria-current={language === "de" ? "page" : undefined}
              className={`rounded-md border px-3 py-2 text-xs font-semibold ${
                language === "de"
                  ? "border-[#071421] bg-white text-[#071421]"
                  : "border-[#d4e1ee] bg-transparent text-[#476178]"
              }`}
              href={getResetLanguageHref("de", token)}
            >
              {page.switchToGerman}
            </Link>
            <Link
              aria-current={language === "en" ? "page" : undefined}
              className={`rounded-md border px-3 py-2 text-xs font-semibold ${
                language === "en"
                  ? "border-[#071421] bg-white text-[#071421]"
                  : "border-[#d4e1ee] bg-transparent text-[#476178]"
              }`}
              href={getResetLanguageHref("en", token)}
            >
              {page.switchToEnglish}
            </Link>
          </nav>
        </header>

        <section
          aria-labelledby="reset-password-heading"
          className="rounded-lg border border-[#c8d8e8] bg-white/[0.94] p-5 shadow-lg md:p-6"
        >
          <h1 className="text-2xl font-semibold text-[#071421]" id="reset-password-heading">
            {reset.resetTitle}
          </h1>
          <p className="mt-3 text-sm leading-6 text-[#476178]">{reset.resetDescription}</p>

          {errorText ? (
            <p className="mt-5 rounded-md border border-[#e2a7a7] bg-[#fff1f1] px-3 py-2 text-sm font-semibold leading-6 text-[#7d2020]">
              {errorText}
            </p>
          ) : null}

          {canSubmit ? (
            <form action="/api/auth/password-reset/confirm" className="mt-6 grid gap-4" method="post">
              <input name="lang" type="hidden" value={language} />
              <input name="token" type="hidden" value={token} />
              <label className="grid gap-2 text-sm font-semibold text-[#24384d]">
                {reset.newPasswordLabel}
                <input
                  autoComplete="new-password"
                  className="min-h-11 rounded-md border border-[#b8c7d8] bg-white px-3 py-2 text-sm font-normal text-[#071421] outline-none focus:border-[#071421] focus:ring-2 focus:ring-[#b8d8ff]"
                  minLength={12}
                  name="password"
                  required
                  type="password"
                />
              </label>
              <label className="grid gap-2 text-sm font-semibold text-[#24384d]">
                {reset.confirmPasswordLabel}
                <input
                  autoComplete="new-password"
                  className="min-h-11 rounded-md border border-[#b8c7d8] bg-white px-3 py-2 text-sm font-normal text-[#071421] outline-none focus:border-[#071421] focus:ring-2 focus:ring-[#b8d8ff]"
                  minLength={12}
                  name="confirmPassword"
                  required
                  type="password"
                />
              </label>
              <p className="text-sm leading-6 text-[#476178]">{reset.passwordHelp}</p>
              <button
                className="min-h-11 rounded-md border border-[#071421] bg-[#071421] px-4 py-3 text-sm font-semibold text-white transition hover:bg-[#173c64]"
                type="submit"
              >
                {reset.resetSubmit}
              </button>
            </form>
          ) : null}

          <Link
            className="mt-5 inline-flex text-sm font-semibold text-[#071421] underline-offset-4 hover:underline"
            href={withPublicLanguage("/login", language)}
          >
            {reset.backToLogin}
          </Link>
        </section>
      </div>
    </main>
  );
}
