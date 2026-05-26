import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { PasswordVisibilityInput } from "@/components/password-visibility-input";
import {
  getCrmLandingPageCopy,
  getLoginLegalFooterCopy,
  getLoginPageCopy,
  getPublicPageCopy,
  type LanguageCode,
} from "@/lib/i18n";
import { companyLegalDetails, publicLegalLinks } from "@/lib/legal";
import { withPublicLanguage } from "@/lib/public-language";

type LandingCopy = ReturnType<typeof getCrmLandingPageCopy>;
type LoginCopy = ReturnType<typeof getLoginPageCopy>;
type LegalCopy = ReturnType<typeof getLoginLegalFooterCopy>;
type PublicCopy = ReturnType<typeof getPublicPageCopy>;
type VisualCopy = LandingCopy["visuals"][keyof LandingCopy["visuals"]];

const landingAssetPaths = {
  auditToSystem: "/landing-assets/lead-ops-process-visual-2400x1200.mp4",
  companySystemSplit: "/landing-assets/company-system-split.png",
  heroOperatingLayer: "/landing-assets/hero-operating-layer.mp4",
  leadLeakage: "/landing-assets/lead-leakage.mp4",
  lockedCrmPreview: "/landing-assets/locked-crm-preview.mp4",
} as const;

export type PublicCrmLandingLoginForm = {
  configured: boolean;
  email: string;
  errorText: string;
  language: LanguageCode;
  returnTo: string;
  statusText: string;
};

type PublicCrmLandingProps = {
  auditHref: string;
  basePath: "/" | "/login";
  copy: LandingCopy;
  language: LanguageCode;
  legalCopy: LegalCopy;
  loginCopy?: LoginCopy;
  loginForm?: PublicCrmLandingLoginForm;
  pageCopy: PublicCopy;
  showLoginForm?: boolean;
};

function getNovalureHref(language: LanguageCode) {
  return language === "de" ? "https://www.novalure.eu/de" : "https://www.novalure.eu/en";
}

function getForgotPasswordHref(language: LanguageCode, email: string) {
  const params = new URLSearchParams({ lang: language });
  if (email) params.set("email", email);
  return `/login/forgot-password?${params.toString()}`;
}

function ActionLink({
  children,
  href,
  variant = "primary",
}: {
  children: ReactNode;
  href: string;
  variant?: "primary" | "secondary" | "subtle";
}) {
  const classes = {
    primary:
      "border-[#f3f1e8] bg-[#f3f1e8] text-[#050607] hover:border-white hover:bg-white focus:ring-[#f3f1e8]",
    secondary:
      "border-white/30 bg-white/[0.06] text-white hover:border-white/70 hover:bg-white/[0.12] focus:ring-white",
    subtle:
      "border-[#cdd4ce] bg-transparent text-[#111614] hover:border-[#111614] hover:bg-[#f8f7f1] focus:ring-[#111614]",
  } as const;

  return (
    <a
      className={`inline-flex min-h-11 items-center justify-center rounded-md border px-4 py-3 text-sm font-semibold transition focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-transparent ${classes[variant]}`}
      href={href}
    >
      {children}
    </a>
  );
}

function SectionIntro({
  description,
  eyebrow,
  inverted = false,
  title,
}: {
  description?: string;
  eyebrow: string;
  inverted?: boolean;
  title: string;
}) {
  return (
    <div className="max-w-3xl">
      <p className={`text-sm font-semibold uppercase ${inverted ? "text-[#9fd8be]" : "text-[#277258]"}`}>
        {eyebrow}
      </p>
      <h2 className={`mt-3 text-3xl font-semibold leading-tight md:text-4xl ${inverted ? "text-white" : "text-[#111614]"}`}>
        {title}
      </h2>
      {description ? (
        <p className={`mt-4 text-base leading-7 ${inverted ? "text-[#c9d4ce]" : "text-[#50645b]"}`}>
          {description}
        </p>
      ) : null}
    </div>
  );
}

function VisualShell({
  children,
  className = "",
  visual,
}: {
  children: ReactNode;
  className?: string;
  visual: VisualCopy;
}) {
  return (
    <div
      aria-label={visual.alt}
      className={`relative w-full min-w-0 max-w-full overflow-hidden rounded-lg border border-white/[0.12] bg-[#090d0c] text-white shadow-lg ${className}`}
      data-asset-description={visual.assetDescription}
      data-asset-id={visual.id}
      data-gemini-prompt={visual.geminiPrompt}
      role="img"
    >
      <p className="sr-only">{visual.assetDescription}</p>
      {children}
    </div>
  );
}

function VideoAsset({
  mobileSrc,
  priority = false,
  src,
}: {
  mobileSrc?: string;
  priority?: boolean;
  src: string;
}) {
  const type = src.endsWith(".webm") ? "video/webm" : "video/mp4";
  const mobileType = mobileSrc?.endsWith(".webm") ? "video/webm" : "video/mp4";

  return (
    <video
      aria-hidden="true"
      autoPlay
      className="crm-asset-media absolute inset-0 h-full w-full object-cover"
      loop
      muted
      playsInline
      preload={priority ? "metadata" : "none"}
    >
      {mobileSrc ? <source media="(max-width: 639px)" src={mobileSrc} type={mobileType} /> : null}
      <source src={src} type={type} />
    </video>
  );
}

function ReducedMotionFallback({ visual }: { visual: VisualCopy }) {
  return (
    <div className="crm-reduced-media-fallback absolute inset-0 flex-col justify-end gap-4 bg-[#050607] p-5 md:p-7">
      <div className="absolute inset-0 crm-asset-grid opacity-50" />
      <div className="relative z-10 grid gap-3 sm:grid-cols-2">
        {visual.labels.slice(0, 4).map((label, index) => (
          <div className="rounded-md border border-white/[0.12] bg-white/[0.07] p-4" key={label}>
            <span className="text-xs font-semibold text-[#9fd8be]">0{index + 1}</span>
            <p className="mt-6 text-sm font-semibold leading-6 text-white">{label}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function HeroOperatingLayer({ visual }: { visual: VisualCopy }) {
  return (
    <VisualShell className="aspect-[4/5] min-h-0 sm:aspect-[16/10] sm:min-h-[320px] md:min-h-[440px]" visual={visual}>
      <VideoAsset priority src={landingAssetPaths.heroOperatingLayer} />
      <div className="absolute inset-0 bg-[#050607]/15" />
      <ReducedMotionFallback visual={visual} />
    </VisualShell>
  );
}

function CompanySystemVisual({ visual }: { visual: VisualCopy }) {
  return (
    <VisualShell className="aspect-[1638/960] min-h-0 sm:min-h-[280px]" visual={visual}>
      <Image
        alt=""
        className="h-full w-full object-cover"
        height={960}
        loading="lazy"
        sizes="(min-width: 1024px) 50vw, 100vw"
        src={landingAssetPaths.companySystemSplit}
        width={1638}
      />
    </VisualShell>
  );
}

function LeadLeakageVisual({ visual }: { visual: VisualCopy }) {
  return (
    <VisualShell className="aspect-video min-h-0 sm:min-h-[280px] crm-noncritical-motion" visual={visual}>
      <VideoAsset src={landingAssetPaths.leadLeakage} />
      <ReducedMotionFallback visual={visual} />
    </VisualShell>
  );
}

function LockedCrmPreviewVisual({ visual }: { visual: VisualCopy }) {
  return (
    <VisualShell className="aspect-video min-h-0 sm:min-h-[300px] crm-noncritical-motion" visual={visual}>
      <VideoAsset src={landingAssetPaths.lockedCrmPreview} />
      <ReducedMotionFallback visual={visual} />
    </VisualShell>
  );
}

function AuditToSystemVisual({ visual }: { visual: VisualCopy }) {
  return (
    <VisualShell className="aspect-[2/1] min-h-0 sm:min-h-[220px] crm-noncritical-motion" visual={visual}>
      <VideoAsset src={landingAssetPaths.auditToSystem} />
      <ReducedMotionFallback visual={visual} />
    </VisualShell>
  );
}

function LoginAccessPanel({
  form,
  login,
  panel,
}: {
  form: PublicCrmLandingLoginForm;
  login: LoginCopy;
  panel: LandingCopy["loginPanel"];
}) {
  return (
    <section
      aria-labelledby="workspace-login-heading"
      className="border-t border-[#d8ddd7] bg-[#f8f7f1] px-4 py-14"
      id="workspace-login"
    >
      <div className="mx-auto grid w-full max-w-6xl gap-8 md:grid-cols-[0.9fr_1.1fr] md:items-start">
        <div>
          <p className="text-sm font-semibold uppercase text-[#277258]">{panel.eyebrow}</p>
          <h2 className="mt-3 text-3xl font-semibold leading-tight text-[#111614] md:text-4xl" id="workspace-login-heading">
            {panel.title}
          </h2>
          <p className="mt-4 text-base leading-7 text-[#50645b]">{panel.description}</p>
        </div>

        <div className="rounded-lg border border-[#d8ddd7] bg-white p-5 shadow-sm md:p-6">
          {!form.configured ? (
            <p className="rounded-md border border-[#d7b56d] bg-[#fff7df] px-3 py-2 text-sm font-semibold leading-6 text-[#6d4d04]">
              {login.notConfigured}
            </p>
          ) : null}

          {form.errorText ? (
            <p className="rounded-md border border-[#e2a7a7] bg-[#fff1f1] px-3 py-2 text-sm font-semibold leading-6 text-[#7d2020]">
              {form.errorText}
            </p>
          ) : null}

          {form.statusText ? (
            <p className="rounded-md border border-[#9ed7bf] bg-[#edfff6] px-3 py-2 text-sm font-semibold leading-6 text-[#0f5132]">
              {form.statusText}
            </p>
          ) : null}

          <form action="/api/auth/login" className="mt-5 grid gap-4" method="post">
            <input name="returnTo" type="hidden" value={form.returnTo} />
            <label className="grid gap-2 text-sm font-semibold text-[#26342f]">
              {login.emailLabel}
              <input
                autoComplete="email"
                className="min-h-11 rounded-md border border-[#cdd4ce] bg-white px-3 py-2 text-sm font-normal text-[#111614] outline-none focus:border-[#111614] focus:ring-2 focus:ring-[#b8d8c8]"
                defaultValue={form.email}
                name="email"
                placeholder={login.placeholderEmail}
                required
                type="email"
              />
            </label>
            <div className="grid gap-2">
              <label className="text-sm font-semibold text-[#26342f]" htmlFor="login-password">
                {login.passcodeLabel}
              </label>
              <PasswordVisibilityInput
                autoComplete="current-password"
                className="min-h-11 w-full rounded-md border border-[#cdd4ce] bg-white px-3 py-2 text-sm font-normal text-[#111614] outline-none focus:border-[#111614] focus:ring-2 focus:ring-[#b8d8c8]"
                hideLabel={login.passcodeHideLabel}
                id="login-password"
                name="password"
                required
                showLabel={login.passcodeShowLabel}
              />
            </div>
            <div className="flex justify-end">
              <Link
                className="text-sm font-semibold text-[#111614] underline-offset-4 hover:underline"
                href={getForgotPasswordHref(form.language, form.email)}
              >
                {login.passwordReset.forgotLink}
              </Link>
            </div>
            <button
              className="min-h-11 rounded-md border border-[#111614] bg-[#111614] px-4 py-3 text-sm font-semibold text-white transition hover:bg-[#26342f] disabled:cursor-not-allowed disabled:border-[#9ca7a0] disabled:bg-[#9ca7a0]"
              disabled={!form.configured}
              type="submit"
            >
              {login.submit}
            </button>
          </form>
        </div>
      </div>
    </section>
  );
}

export function PublicCrmLanding({
  auditHref,
  basePath,
  copy,
  language,
  legalCopy,
  loginCopy,
  loginForm,
  pageCopy,
  showLoginForm = false,
}: PublicCrmLandingProps) {
  const novalureHref = getNovalureHref(language);
  const loginHref = showLoginForm ? "#workspace-login" : withPublicLanguage("/login", language);
  const secondaryHeroHref = loginHref;

  return (
    <main className="min-h-dvh bg-[#f8f7f1] text-[#111614]" lang={language}>
      <header className="fixed inset-x-0 top-0 z-50 border-b border-white/[0.12] bg-[#050607]/[0.9] text-white backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <Link className="min-w-0 shrink-0 text-sm font-semibold sm:text-base" href={withPublicLanguage("/", language)}>
            Novalure CRM
          </Link>
          <nav
            aria-label="Novalure CRM"
            className="order-3 hidden w-full items-center justify-center gap-5 pt-1 text-sm font-semibold text-[#c9d4ce] md:order-none md:flex md:w-auto md:pt-0"
          >
            <a className="hover:text-white" href="#company-system">
              {copy.nav.companySystem}
            </a>
            <a className="hover:text-white" href="#problem">
              {copy.nav.problem}
            </a>
            <a className="hover:text-white" href="#preview">
              {copy.nav.preview}
            </a>
            <a className="hover:text-white" href="#audit">
              {copy.nav.audit}
            </a>
          </nav>
          <div className="flex shrink-0 items-center gap-2">
            <nav aria-label={pageCopy.languageAriaLabel} className="flex items-center gap-1">
              <Link
                aria-current={language === "de" ? "page" : undefined}
                aria-label={pageCopy.switchToGerman}
                className={`inline-flex min-h-10 min-w-10 items-center justify-center rounded-md border px-2 text-xs font-semibold transition hover:border-white hover:text-white ${
                  language === "de"
                    ? "border-white bg-white text-[#050607]"
                    : "border-white/[0.2] bg-transparent text-[#c9d4ce]"
                }`}
                href={withPublicLanguage(basePath, "de")}
                title={pageCopy.switchToGerman}
              >
                {pageCopy.switchToGermanShort}
              </Link>
              <Link
                aria-current={language === "en" ? "page" : undefined}
                aria-label={pageCopy.switchToEnglish}
                className={`inline-flex min-h-10 min-w-10 items-center justify-center rounded-md border px-2 text-xs font-semibold transition hover:border-white hover:text-white ${
                  language === "en"
                    ? "border-white bg-white text-[#050607]"
                    : "border-white/[0.2] bg-transparent text-[#c9d4ce]"
                }`}
                href={withPublicLanguage(basePath, "en")}
                title={pageCopy.switchToEnglish}
              >
                {pageCopy.switchToEnglishShort}
              </Link>
            </nav>
            <a className="hidden text-sm font-semibold text-[#c9d4ce] hover:text-white sm:inline-flex" href={loginHref}>
              {copy.nav.login}
            </a>
            <a
              className="inline-flex min-h-10 items-center justify-center whitespace-nowrap rounded-md border border-[#f3f1e8] bg-[#f3f1e8] px-3 py-2 text-xs font-semibold text-[#050607] transition hover:bg-white focus:outline-none focus:ring-2 focus:ring-[#f3f1e8] focus:ring-offset-2 focus:ring-offset-[#050607] sm:text-sm"
              href={auditHref}
            >
              {copy.nav.auditCta}
            </a>
          </div>
        </div>
      </header>

      <section className="relative overflow-hidden bg-[#050607] px-4 pb-14 pt-28 text-white md:pb-20 md:pt-32">
        <div className="absolute inset-x-0 bottom-0 h-px bg-white/[0.12]" />
        <div className="mx-auto grid w-full max-w-7xl gap-10 lg:grid-cols-[0.92fr_1.08fr] lg:items-center">
          <div className="relative z-10 max-w-3xl">
            <p className="text-sm font-semibold uppercase text-[#9fd8be]">{copy.hero.eyebrow}</p>
            <h1 className="mt-4 text-4xl font-semibold leading-tight md:text-6xl">{copy.hero.title}</h1>
            <p className="mt-5 max-w-2xl text-lg leading-8 text-[#c9d4ce]">{copy.hero.description}</p>
            <div className="mt-7 flex flex-col gap-3 sm:flex-row">
              <ActionLink href={auditHref}>{copy.hero.primaryCta}</ActionLink>
              <ActionLink href={secondaryHeroHref} variant="secondary">
                {copy.hero.secondaryCta}
              </ActionLink>
            </div>
            <div className="mt-8 grid gap-3 sm:grid-cols-3">
              {copy.hero.proofPoints.map((point) => (
                <div className="rounded-md border border-white/[0.14] bg-white/[0.06] px-4 py-3 text-sm font-semibold leading-6 text-[#e5ebe7]" key={point}>
                  {point}
                </div>
              ))}
            </div>
          </div>
          <HeroOperatingLayer visual={copy.visuals.heroOperatingLayer} />
        </div>
      </section>

      <section className="border-b border-[#d8ddd7] bg-[#f8f7f1] px-4 py-14" id="company-system">
        <div className="mx-auto grid w-full max-w-7xl gap-8 lg:grid-cols-[0.95fr_1.05fr] lg:items-center">
          <div>
            <SectionIntro
              description={copy.companySystem.description}
              eyebrow={copy.companySystem.eyebrow}
              title={copy.companySystem.title}
            />
            <div className="mt-8 grid gap-4 sm:grid-cols-2">
              {[copy.companySystem.publicLayer, copy.companySystem.protectedLayer].map((layer) => (
                <article className="rounded-lg border border-[#d8ddd7] bg-white p-5" key={layer.label}>
                  <p className="text-sm font-semibold text-[#277258]">{layer.label}</p>
                  <h3 className="mt-3 text-xl font-semibold leading-7 text-[#111614]">{layer.title}</h3>
                  <p className="mt-3 text-sm leading-6 text-[#50645b]">{layer.body}</p>
                </article>
              ))}
            </div>
            <div className="mt-5 flex flex-wrap gap-2">
              {copy.companySystem.bridge.map((step) => (
                <span className="rounded-md border border-[#cdd4ce] bg-white px-3 py-2 text-sm font-semibold text-[#26342f]" key={step}>
                  {step}
                </span>
              ))}
            </div>
          </div>
          <CompanySystemVisual visual={copy.visuals.companySystemSplit} />
        </div>
      </section>

      <section className="bg-white px-4 py-14" id="problem">
        <div className="mx-auto grid w-full max-w-7xl gap-8 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
          <div className="order-2 lg:order-1">
            <LeadLeakageVisual visual={copy.visuals.leadLeakage} />
          </div>
          <div className="order-1 lg:order-2">
            <SectionIntro
              description={copy.problem.description}
              eyebrow={copy.problem.eyebrow}
              title={copy.problem.title}
            />
            <div className="mt-8 grid gap-3">
              {copy.problem.points.map((point) => (
                <div className="rounded-md border border-[#d8ddd7] bg-[#f8f7f1] p-4 text-sm font-semibold leading-6 text-[#26342f]" key={point}>
                  {point}
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="border-y border-white/[0.12] bg-[#050607] px-4 py-14 text-white" id="preview">
        <div className="mx-auto w-full max-w-7xl">
          <SectionIntro
            description={copy.preview.description}
            eyebrow={copy.preview.eyebrow}
            inverted
            title={copy.preview.title}
          />
          <div className="mt-8">
            <LockedCrmPreviewVisual visual={copy.visuals.lockedCrmPreview} />
          </div>
          <div className="mt-6 flex flex-wrap gap-2">
            {copy.preview.terms.map((term) => (
              <span className="rounded-md border border-white/[0.16] bg-white/[0.06] px-3 py-2 text-sm font-semibold text-[#e5ebe7]" key={term}>
                {term}
              </span>
            ))}
          </div>
          <p className="mt-5 max-w-3xl text-sm font-semibold leading-6 text-[#9fd8be]">{copy.preview.notice}</p>
        </div>
      </section>

      <section className="bg-[#f8f7f1] px-4 py-14">
        <div className="mx-auto w-full max-w-7xl">
          <SectionIntro eyebrow={copy.audiences.eyebrow} title={copy.audiences.title} />
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {copy.audiences.items.map((item) => (
              <article className="rounded-lg border border-[#d8ddd7] bg-white p-5" key={item.title}>
                <h3 className="text-xl font-semibold leading-7 text-[#111614]">{item.title}</h3>
                <p className="mt-4 text-sm leading-6 text-[#50645b]">{item.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-white px-4 py-14" id="audit">
        <div className="mx-auto grid w-full max-w-7xl gap-8 lg:grid-cols-[1fr_0.95fr] lg:items-center">
          <div>
            <SectionIntro
              description={copy.audit.description}
              eyebrow={copy.audit.eyebrow}
              title={copy.audit.title}
            />
            <div className="mt-8 grid gap-3 sm:grid-cols-2">
              {copy.audit.checks.map((check) => (
                <div className="rounded-md border border-[#d8ddd7] bg-[#f8f7f1] px-4 py-3 text-sm font-semibold text-[#26342f]" key={check}>
                  {check}
                </div>
              ))}
            </div>
          </div>
          <AuditToSystemVisual visual={copy.visuals.auditToSystem} />
        </div>
      </section>

      <section className="border-y border-[#d8ddd7] bg-[#111614] px-4 py-14 text-white">
        <div className="mx-auto grid w-full max-w-7xl gap-8 md:grid-cols-[0.82fr_1.18fr] md:items-start">
          <SectionIntro eyebrow={copy.trust.eyebrow} inverted title={copy.trust.title} />
          <div className="grid gap-3 sm:grid-cols-2">
            {copy.trust.points.map((point) => (
              <div className="rounded-md border border-white/[0.14] bg-white/[0.06] p-4 text-sm font-semibold leading-6 text-[#e5ebe7]" key={point}>
                {point}
              </div>
            ))}
          </div>
        </div>
      </section>

      {showLoginForm && loginCopy && loginForm ? (
        <LoginAccessPanel form={loginForm} login={loginCopy} panel={copy.loginPanel} />
      ) : null}

      <section className="bg-[#f8f7f1] px-4 py-14">
        <div className="mx-auto grid w-full max-w-7xl gap-8 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
          <div>
            <SectionIntro
              description={copy.finalCta.description}
              eyebrow={copy.finalCta.eyebrow}
              title={copy.finalCta.title}
            />
            <div className="mt-7 flex flex-col gap-3 sm:flex-row">
              <ActionLink href={auditHref} variant="subtle">
                {copy.finalCta.primaryCta}
              </ActionLink>
              <ActionLink href={novalureHref} variant="subtle">
                {copy.finalCta.secondaryCta}
              </ActionLink>
            </div>
          </div>
          <AuditToSystemVisual visual={copy.visuals.auditToSystem} />
        </div>
      </section>

      <footer
        aria-label={legalCopy.ariaLabel}
        className="border-t border-[#d8ddd7] bg-white px-4 py-8 text-sm leading-6 text-[#50645b]"
      >
        <div className="mx-auto grid w-full max-w-7xl gap-6 md:grid-cols-[1fr_auto]">
          <div>
            <p className="font-semibold text-[#111614]">{copy.footerTagline}</p>
            <p className="mt-3">
              {companyLegalDetails.companyName} - {legalCopy.companyNumber}{" "}
              {companyLegalDetails.companyNumber} - {companyLegalDetails.registeredPlace}
            </p>
            <p className="mt-1">
              {legalCopy.contactPrefix}{" "}
              <a className="font-semibold text-[#111614] underline-offset-4 hover:underline" href={`mailto:${companyLegalDetails.email}`}>
                {companyLegalDetails.email}
              </a>
            </p>
          </div>
          <nav aria-label={legalCopy.ariaLabel} className="flex flex-wrap gap-x-5 gap-y-2 md:justify-end">
            {publicLegalLinks.map((link) => (
              <Link
                className="font-semibold text-[#111614] underline-offset-4 hover:underline"
                href={withPublicLanguage(link.href, language)}
                key={link.key}
              >
                {legalCopy.links[link.key]}
              </Link>
            ))}
          </nav>
        </div>
      </footer>
    </main>
  );
}
