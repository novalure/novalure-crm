import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionFromHeaders } from "@/lib/auth/session";
import { getLoginPageCopy, getPublicPageCopy } from "@/lib/i18n";
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

function getForgotLanguageHref(language: "de" | "en") {
  const params = new URLSearchParams({ lang: language });
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
  const page = getPublicPageCopy(language);
  const reset = login.passwordReset;
  const sent = getQueryValue(query.sent) === "1";

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
              className={`inline-flex min-h-11 items-center rounded-md border px-3 py-2 text-xs font-semibold ${
                language === "de"
                  ? "border-[#071421] bg-white text-[#071421]"
                  : "border-[#d4e1ee] bg-transparent text-[#476178]"
              }`}
              href={getForgotLanguageHref("de")}
            >
              {page.switchToGerman}
            </Link>
            <Link
              aria-current={language === "en" ? "page" : undefined}
              className={`inline-flex min-h-11 items-center rounded-md border px-3 py-2 text-xs font-semibold ${
                language === "en"
                  ? "border-[#071421] bg-white text-[#071421]"
                  : "border-[#d4e1ee] bg-transparent text-[#476178]"
              }`}
              href={getForgotLanguageHref("en")}
            >
              {page.switchToEnglish}
            </Link>
          </nav>
        </header>

        <section
          aria-labelledby="forgot-password-heading"
          className="rounded-lg border border-[#c8d8e8] bg-white/[0.94] p-5 shadow-lg md:p-6"
        >
          <h1 className="text-2xl font-semibold text-[#071421]" id="forgot-password-heading">
            {reset.requestTitle}
          </h1>
          <p className="mt-3 text-sm leading-6 text-[#476178]">{reset.requestDescription}</p>

          {sent ? (
            <p
              aria-live="polite"
              className="mt-5 rounded-md border border-[#9ed7bf] bg-[#edfff6] px-3 py-2 text-sm font-semibold leading-6 text-[#0f5132]"
              role="status"
            >
              {reset.requestSuccess}
            </p>
          ) : null}

          <form action="/api/auth/password-reset/request" className="mt-6 grid gap-4" method="post">
            <input name="lang" type="hidden" value={language} />
            <label className="grid gap-2 text-sm font-semibold text-[#24384d]">
              {reset.emailLabel}
              <input
                autoComplete="email"
                className="min-h-11 rounded-md border border-[#b8c7d8] bg-white px-3 py-2 text-sm font-normal text-[#071421] outline-none focus:border-[#071421] focus:ring-2 focus:ring-[#b8d8ff]"
                name="email"
                placeholder={login.placeholderEmail}
                required
                type="email"
              />
            </label>
            <button
              className="min-h-11 rounded-md border border-[#071421] bg-[#071421] px-4 py-3 text-sm font-semibold text-white transition hover:bg-[#173c64]"
              type="submit"
            >
              {reset.requestSubmit}
            </button>
          </form>

          <p className="mt-4 text-sm leading-6 text-[#476178]">{reset.requestHelp}</p>
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
