import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { PasswordVisibilityInput } from "@/components/password-visibility-input";
import { getSessionFromHeaders, isLoginConfigured } from "@/lib/auth/session";
import {
  getCrmLandingPageCopy,
  getLoginLegalFooterCopy,
  getLoginPageCopy,
  getPublicPageCopy,
  type LanguageCode,
} from "@/lib/i18n";
import { companyLegalDetails, publicLegalLinks } from "@/lib/legal";
import { resolvePublicLanguage, withPublicLanguage } from "@/lib/public-language";

type LoginPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

type LoginFormState = {
  configured: boolean;
  email: string;
  errorText: string;
  language: LanguageCode;
  returnTo: string;
  statusText: string;
};

const dachCountries = new Set(["AT", "CH", "DE"]);
const germanAuditHref = "https://www.novalure.eu/de/kontakt#book-audit";
const internationalAuditHref = "https://www.novalure.eu/en/contact";

export const metadata: Metadata = {
  title: "Novalure CRM | Real Estate Lead Operations",
  description:
    "Novalure CRM landing page with workspace login and Pipeline Audit booking for real estate lead operations.",
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

function getRequestCountry(requestHeaders: Headers) {
  return (
    requestHeaders.get("x-vercel-ip-country") ??
    requestHeaders.get("cf-ipcountry") ??
    requestHeaders.get("x-country-code")
  );
}

function resolveAuditHref(country: string | null, language: LanguageCode) {
  const normalizedCountry = country?.trim().toUpperCase();
  if (normalizedCountry) {
    return dachCountries.has(normalizedCountry) ? germanAuditHref : internationalAuditHref;
  }

  return language === "de" ? germanAuditHref : internationalAuditHref;
}

function ActionLink({
  children,
  href,
  variant = "primary",
}: {
  children: ReactNode;
  href: string;
  variant?: "primary" | "secondary" | "light";
}) {
  const classes = {
    light:
      "border border-white/40 bg-white/10 text-white hover:border-white hover:bg-white/[0.18] focus:ring-white",
    primary:
      "border border-[#071421] bg-[#071421] text-white hover:border-[#173c64] hover:bg-[#173c64] focus:ring-[#071421]",
    secondary:
      "border border-[#b8c7d8] bg-white/[0.8] text-[#071421] hover:border-[#071421] hover:bg-white focus:ring-[#071421]",
  } as const;

  return (
    <a
      className={`inline-flex min-h-11 items-center justify-center rounded-md px-4 py-3 text-sm font-semibold transition focus:outline-none focus:ring-2 focus:ring-offset-2 ${classes[variant]}`}
      href={href}
    >
      {children}
    </a>
  );
}

function SectionIntro({
  description,
  eyebrow,
  title,
}: {
  description?: string;
  eyebrow: string;
  title: string;
}) {
  return (
    <div className="max-w-3xl">
      <p className="text-sm font-semibold uppercase text-[#1f6f5b]">{eyebrow}</p>
      <h2 className="mt-3 text-3xl font-semibold leading-tight text-[#071421] md:text-4xl">
        {title}
      </h2>
      {description ? (
        <p className="mt-4 text-base leading-7 text-[#476178]">{description}</p>
      ) : null}
    </div>
  );
}

function LoginAccessPanel({
  form,
  login,
  panel,
}: {
  form: LoginFormState;
  login: ReturnType<typeof getLoginPageCopy>;
  panel: ReturnType<typeof getCrmLandingPageCopy>["loginPanel"];
}) {
  return (
    <section
      aria-labelledby="login-heading"
      className="rounded-lg border border-[#c8d8e8] bg-white/[0.92] p-5 shadow-lg md:p-6"
      id="login"
    >
      <p className="text-sm font-semibold uppercase text-[#1f6f5b]">{panel.eyebrow}</p>
      <h2 className="mt-2 text-2xl font-semibold text-[#071421]" id="login-heading">
        {panel.title}
      </h2>
      <p className="mt-3 text-sm leading-6 text-[#476178]">{panel.description}</p>

      {!form.configured ? (
        <p className="mt-5 rounded-md border border-[#d7b56d] bg-[#fff7df] px-3 py-2 text-sm font-semibold leading-6 text-[#6d4d04]">
          {login.notConfigured}
        </p>
      ) : null}

      {form.errorText ? (
        <p className="mt-5 rounded-md border border-[#e2a7a7] bg-[#fff1f1] px-3 py-2 text-sm font-semibold leading-6 text-[#7d2020]">
          {form.errorText}
        </p>
      ) : null}

      {form.statusText ? (
        <p className="mt-5 rounded-md border border-[#9ed7bf] bg-[#edfff6] px-3 py-2 text-sm font-semibold leading-6 text-[#0f5132]">
          {form.statusText}
        </p>
      ) : null}

      <form action="/api/auth/login" className="mt-6 grid gap-4" method="post">
        <input name="returnTo" type="hidden" value={form.returnTo} />
        <label className="grid gap-2 text-sm font-semibold text-[#24384d]">
          {login.emailLabel}
          <input
            autoComplete="email"
            className="min-h-11 rounded-md border border-[#b8c7d8] bg-white px-3 py-2 text-sm font-normal text-[#071421] outline-none focus:border-[#071421] focus:ring-2 focus:ring-[#b8d8ff]"
            defaultValue={form.email}
            name="email"
            placeholder={login.placeholderEmail}
            required
            type="email"
          />
        </label>
        <div className="grid gap-2">
          <label className="text-sm font-semibold text-[#24384d]" htmlFor="login-password">
            {login.passcodeLabel}
          </label>
          <PasswordVisibilityInput
            autoComplete="current-password"
            className="min-h-11 w-full rounded-md border border-[#b8c7d8] bg-white px-3 py-2 text-sm font-normal text-[#071421] outline-none focus:border-[#071421] focus:ring-2 focus:ring-[#b8d8ff]"
            hideLabel={login.passcodeHideLabel}
            id="login-password"
            name="password"
            required
            showLabel={login.passcodeShowLabel}
          />
        </div>
        <div className="flex justify-end">
          <Link
            className="text-sm font-semibold text-[#071421] underline-offset-4 hover:underline"
            href={getForgotPasswordHref(form.language, form.email)}
          >
            {login.passwordReset.forgotLink}
          </Link>
        </div>
        <button
          className="min-h-11 rounded-md border border-[#071421] bg-[#071421] px-4 py-3 text-sm font-semibold text-white transition hover:bg-[#173c64] disabled:cursor-not-allowed disabled:border-[#9caabd] disabled:bg-[#9caabd]"
          disabled={!form.configured}
          type="submit"
        >
          {login.submit}
        </button>
      </form>
    </section>
  );
}

function LeadOperationsPreview({ copy }: { copy: ReturnType<typeof getCrmLandingPageCopy> }) {
  return (
    <section
      aria-labelledby="lead-operations-heading"
      className="mt-12 overflow-hidden rounded-lg border border-[#14314a] bg-[#071421] text-white shadow-lg"
      id="lead-operations"
    >
      <div className="grid gap-0 lg:grid-cols-[0.9fr_1.1fr]">
        <div className="border-b border-white/[0.12] p-5 md:p-7 lg:border-b-0 lg:border-r">
          <p className="text-sm font-semibold uppercase text-[#78d9b5]">{copy.operations.eyebrow}</p>
          <h2 className="mt-3 text-2xl font-semibold leading-tight md:text-3xl" id="lead-operations-heading">
            {copy.operations.title}
          </h2>
          <p className="mt-4 text-sm leading-6 text-[#c6d5e5]">{copy.operations.description}</p>
          <div className="mt-6 inline-flex rounded-md bg-[#c7f0d8] px-3 py-2 text-sm font-semibold text-[#08351f]">
            {copy.operations.leadLabel}
          </div>
        </div>

        <div className="bg-[#0c1c2e] p-5 md:p-7">
          <div className="grid gap-3 sm:grid-cols-2">
            {copy.operations.fields.map((field) => (
              <div className="rounded-md border border-white/[0.12] bg-white/[0.07] p-4" key={field.label}>
                <p className="text-xs font-semibold uppercase text-[#8fb3d5]">{field.label}</p>
                <p className="mt-2 text-sm font-semibold leading-6 text-white">{field.value}</p>
              </div>
            ))}
          </div>
          <div className="mt-4 rounded-md border border-[#78d9b5]/40 bg-[#0f2d2b] p-4">
            <p className="text-xs font-semibold uppercase text-[#78d9b5]">
              {copy.operations.nextActionLabel}
            </p>
            <p className="mt-2 text-sm font-semibold leading-6">{copy.operations.nextAction}</p>
          </div>
          <div className="mt-5 grid gap-3 sm:grid-cols-4">
            {copy.operations.pipeline.map((stage, index) => (
              <div className="min-h-24 rounded-md border border-white/[0.12] bg-white/[0.07] p-3" key={stage}>
                <div className="h-2 rounded-md bg-[#78d9b5]" style={{ opacity: 0.35 + index * 0.18 }} />
                <p className="mt-3 text-xs font-semibold leading-5 text-[#d8e5f2]">{stage}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
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
    requestedLanguage: query.lang,
  });
  const returnTo = getSafeReturnTo(getQueryValue(query.returnTo, "/"));

  if (session) {
    redirect(returnTo);
  }

  const login = getLoginPageCopy(language);
  const copy = getCrmLandingPageCopy(language);
  const page = getPublicPageCopy(language);
  const legal = getLoginLegalFooterCopy(language);
  const auditHref = resolveAuditHref(country, language);
  const error = getQueryValue(query.error);
  const form: LoginFormState = {
    configured: isLoginConfigured(),
    email: getQueryValue(query.email),
    errorText: getErrorText(error, login),
    language,
    returnTo,
    statusText: getStatusText(getQueryValue(query.reset), login),
  };

  return (
    <main className="min-h-dvh scroll-pt-28 bg-[#f7fbff] text-[#071421] md:scroll-pt-32" lang={language}>
      <header className="fixed inset-x-0 top-0 z-50 border-b border-[#d9e6f2] bg-[#f7fbff]/[0.96] shadow-sm backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-2 px-4 py-3">
          <Link
            className="min-w-0 shrink-0 text-sm font-semibold text-[#071421] sm:text-base"
            href={withPublicLanguage("/login", language)}
          >
            {login.brand}
          </Link>
          <nav
            aria-label={login.brand}
            className="order-3 hidden w-full items-center justify-center gap-5 pt-1 text-sm font-semibold text-[#476178] md:order-none md:flex md:w-auto md:pt-0"
          >
            <a className="hover:text-[#071421]" href="#system">
              {copy.nav.system}
            </a>
            <a className="hover:text-[#071421]" href="#lead-operations">
              {copy.nav.operations}
            </a>
            <a className="hover:text-[#071421]" href="#process">
              {copy.nav.process}
            </a>
            <a className="hover:text-[#071421]" href="#login">
              {copy.nav.login}
            </a>
          </nav>
          <div className="flex shrink-0 items-center gap-2">
            <nav aria-label={page.languageAriaLabel} className="flex items-center gap-1">
              <Link
                aria-current={language === "de" ? "page" : undefined}
                aria-label={page.switchToGerman}
                className={`inline-flex min-h-10 min-w-10 items-center justify-center rounded-md border px-2 text-xs font-semibold transition hover:border-[#071421] hover:text-[#071421] ${
                  language === "de"
                    ? "border-[#071421] bg-white text-[#071421]"
                    : "border-[#d4e1ee] bg-transparent text-[#476178]"
                }`}
                href={withPublicLanguage("/login", "de")}
                title={page.switchToGerman}
              >
                {page.switchToGermanShort}
              </Link>
              <Link
                aria-current={language === "en" ? "page" : undefined}
                aria-label={page.switchToEnglish}
                className={`inline-flex min-h-10 min-w-10 items-center justify-center rounded-md border px-2 text-xs font-semibold transition hover:border-[#071421] hover:text-[#071421] ${
                  language === "en"
                    ? "border-[#071421] bg-white text-[#071421]"
                    : "border-[#d4e1ee] bg-transparent text-[#476178]"
                }`}
                href={withPublicLanguage("/login", "en")}
                title={page.switchToEnglish}
              >
                {page.switchToEnglishShort}
              </Link>
            </nav>
            <a
              className="inline-flex min-h-10 items-center justify-center whitespace-nowrap rounded-md border border-[#071421] bg-[#071421] px-3 py-2 text-xs font-semibold text-white transition hover:bg-[#173c64] focus:outline-none focus:ring-2 focus:ring-[#071421] focus:ring-offset-2 sm:text-sm"
              href={auditHref}
            >
              {copy.nav.audit}
            </a>
          </div>
        </div>
      </header>

      <section className="px-4 pb-12 pt-28 md:pb-16 md:pt-32 lg:pb-20 lg:pt-36">
        <div className="mx-auto w-full max-w-7xl">
          <div className="grid items-start gap-8 lg:grid-cols-[1.1fr_0.9fr]">
            <div className="max-w-3xl">
              <p className="text-sm font-semibold uppercase text-[#1f6f5b]">{copy.hero.eyebrow}</p>
              <h1 className="mt-4 text-4xl font-semibold leading-tight text-[#071421] md:text-6xl">
                {copy.hero.title}
              </h1>
              <p className="mt-5 max-w-2xl text-lg leading-8 text-[#476178]">
                {copy.hero.description}
              </p>
              <div className="mt-7 flex flex-col gap-3 sm:flex-row">
                <ActionLink href={auditHref}>{copy.hero.primaryCta}</ActionLink>
                <ActionLink href="#login" variant="secondary">
                  {copy.hero.secondaryCta}
                </ActionLink>
              </div>
              <div className="mt-7 grid gap-3 sm:grid-cols-3">
                {copy.hero.proofPoints.map((point) => (
                  <div className="rounded-md border border-[#d4e1ee] bg-white/[0.72] px-4 py-3 text-sm font-semibold leading-6 text-[#24384d]" key={point}>
                    {point}
                  </div>
                ))}
              </div>
            </div>
            <LoginAccessPanel form={form} login={login} panel={copy.loginPanel} />
          </div>

          <LeadOperationsPreview copy={copy} />
        </div>
      </section>

      <section className="border-t border-[#d9e6f2] bg-white/[0.68] px-4 py-14" id="system">
        <div className="mx-auto w-full max-w-7xl">
          <SectionIntro
            description={copy.system.description}
            eyebrow={copy.system.eyebrow}
            title={copy.system.title}
          />
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {copy.system.pillars.map((pillar) => (
              <article className="rounded-lg border border-[#d4e1ee] bg-[#f7fbff] p-5" key={pillar.title}>
                <p className="text-sm font-semibold text-[#1f6f5b]">{pillar.label}</p>
                <h3 className="mt-3 text-xl font-semibold leading-7 text-[#071421]">{pillar.title}</h3>
                <p className="mt-3 text-sm leading-6 text-[#476178]">{pillar.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="px-4 py-14">
        <div className="mx-auto w-full max-w-7xl">
          <SectionIntro
            description={copy.modules.description}
            eyebrow={copy.modules.eyebrow}
            title={copy.modules.title}
          />
          <div className="mt-8 grid gap-4 md:grid-cols-4">
            {copy.modules.items.map((item) => (
              <article
                className="min-h-64 rounded-lg border border-[#d4e1ee] bg-white/[0.82] p-5"
                key={item.label}
              >
                <p className="text-sm font-semibold text-[#1f6f5b]">{item.label}</p>
                <h3 className="mt-8 text-xl font-semibold leading-7 text-[#071421]">{item.title}</h3>
                <p className="mt-3 text-sm leading-6 text-[#476178]">{item.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="px-4 py-14" id="process">
        <div className="mx-auto w-full max-w-7xl">
          <SectionIntro eyebrow={copy.process.eyebrow} title={copy.process.title} />
          <div className="mt-8 grid gap-4 md:grid-cols-4">
            {copy.process.steps.map((step) => (
              <article className="rounded-lg border border-[#d4e1ee] bg-white/[0.8] p-5" key={step.label}>
                <p className="text-sm font-semibold text-[#1f6f5b]">{step.label}</p>
                <h3 className="mt-4 text-lg font-semibold leading-7 text-[#071421]">{step.title}</h3>
                <p className="mt-3 text-sm leading-6 text-[#476178]">{step.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="border-y border-[#d9e6f2] bg-[#0b2238] px-4 py-14 text-white">
        <div className="mx-auto grid w-full max-w-7xl gap-8 md:grid-cols-[0.85fr_1.15fr] md:items-center">
          <div>
            <p className="text-sm font-semibold uppercase text-[#78d9b5]">{copy.trust.eyebrow}</p>
            <h2 className="mt-3 text-3xl font-semibold leading-tight md:text-4xl">
              {copy.trust.title}
            </h2>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {copy.trust.points.map((point) => (
              <div className="rounded-md border border-white/[0.14] bg-white/[0.08] p-4 text-sm font-semibold leading-6 text-[#d8e5f2]" key={point}>
                {point}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="px-4 py-14">
        <div className="mx-auto flex w-full max-w-7xl flex-col justify-between gap-6 rounded-lg border border-[#d4e1ee] bg-white/[0.82] p-6 md:flex-row md:items-center md:p-8">
          <div className="max-w-3xl">
            <p className="text-sm font-semibold uppercase text-[#1f6f5b]">{copy.finalCta.eyebrow}</p>
            <h2 className="mt-3 text-3xl font-semibold leading-tight text-[#071421]">
              {copy.finalCta.title}
            </h2>
            <p className="mt-3 text-base leading-7 text-[#476178]">{copy.finalCta.description}</p>
          </div>
          <div className="flex shrink-0 flex-col gap-3 sm:flex-row md:flex-col lg:flex-row">
            <ActionLink href={auditHref}>{copy.finalCta.primaryCta}</ActionLink>
            <ActionLink href="#login" variant="secondary">
              {copy.finalCta.secondaryCta}
            </ActionLink>
          </div>
        </div>
      </section>

      <footer
        aria-label={legal.ariaLabel}
        className="border-t border-[#d9e6f2] bg-[#f7fbff] px-4 py-8 text-sm leading-6 text-[#476178]"
      >
        <div className="mx-auto grid w-full max-w-7xl gap-6 md:grid-cols-[1fr_auto]">
          <div>
            <p className="font-semibold text-[#071421]">{copy.footerTagline}</p>
            <p className="mt-3">
              {companyLegalDetails.companyName} - {legal.companyNumber}{" "}
              {companyLegalDetails.companyNumber} - {companyLegalDetails.registeredPlace}
            </p>
            <p className="mt-1">
              {legal.contactPrefix}{" "}
              <a className="font-semibold text-[#071421] underline-offset-4 hover:underline" href={`mailto:${companyLegalDetails.email}`}>
                {companyLegalDetails.email}
              </a>
            </p>
          </div>
          <nav aria-label={legal.ariaLabel} className="flex flex-wrap gap-x-5 gap-y-2 md:justify-end">
            {publicLegalLinks.map((link) => (
              <Link
                className="font-semibold text-[#071421] underline-offset-4 hover:underline"
                href={withPublicLanguage(link.href, language)}
                key={link.key}
              >
                {legal.links[link.key]}
              </Link>
            ))}
          </nav>
        </div>
      </footer>
    </main>
  );
}
