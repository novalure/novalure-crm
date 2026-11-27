import { Fragment, type ReactNode } from "react";
import localFont from "next/font/local";
import Image from "next/image";
import Link from "next/link";
import { CookieConsentButton, type CookieConsentButtonCopy } from "@/components/cookie-consent-button";
import { NovalureWordmark } from "@/components/novalure-wordmark";
import { PublicHashRouteLoginRedirect } from "@/components/public-hash-route-login-redirect";
import { PublicCrmMobileMenu } from "@/components/public-crm-mobile-menu";
import styles from "@/components/public-crm-landing.module.css";
import {
  getCrmLandingPageCopy,
  getPublicPageCopy,
} from "@/lib/i18n";
import { companyLegalDetails, publicLegalLinks } from "@/lib/legal";
import { getPublicCrmLandingV2Copy } from "@/lib/public-crm-landing-v2";
import { type PublicLanguageCode, withPublicLanguage } from "@/lib/public-language";

type LegacyLandingCopy = ReturnType<typeof getCrmLandingPageCopy>;
type LegalCopy = {
  readonly ariaLabel: string;
  readonly companyLine: string;
  readonly companyNumber: string;
  readonly contactPrefix: string;
  readonly description: string;
  readonly links: Readonly<Record<(typeof publicLegalLinks)[number]["key"], string>>;
  readonly registeredPlace: string;
};
type PublicCopy = ReturnType<typeof getPublicPageCopy>;

const spanishLegalCopy: LegalCopy = {
  ariaLabel: "Información legal",
  description: "La información legal está disponible sin iniciar sesión.",
  links: {
    imprint: "Aviso legal",
    privacy: "Política de privacidad",
    cookies: "Aviso de cookies",
    terms: "Condiciones de uso",
    dataDeletion: "Eliminación de datos",
    meta: "Avisos de Meta",
  },
  companyLine: "Novalure CLG · número de empresa irlandesa 796735 · Dublín, Irlanda",
  companyNumber: "Número de empresa irlandesa",
  contactPrefix: "Consultas legales y de privacidad:",
  registeredPlace: "Dublín, Irlanda",
};

const spanishCookieConsentCopy: CookieConsentButtonCopy = {
  title: "Configuración de cookies",
  description:
    "Novalure CRM usa cookies necesarias para seguridad, idioma, login y funciones solicitadas de la plataforma. Las cookies de analítica y marketing permanecen desactivadas salvo que aceptes todo.",
  analyticsLabel: "Cookies de analítica",
  marketingLabel: "Cookies de marketing",
  necessaryTitle: "Cookies necesarias",
  necessaryDescription:
    "Necesarias para entregar la página, mantener la seguridad, gestionar sesiones de login y recordar tu elección de cookies.",
  optionalTitle: "Analítica y marketing",
  optionalDescription:
    "Se usan solo tras tu consentimiento para entender la demanda, el rendimiento de campañas y los recorridos de leads listos para CRM.",
  rejectOptional: "Solo necesarias",
  customize: "Personalizar",
  saveSelection: "Guardar selección",
  acceptAll: "Aceptar todo",
  detailsLink: "Leer el Aviso de cookies",
  privacyLink: "Política de privacidad",
  preferencesTitle: "Seleccionar categorías de cookies",
  preferencesDescription:
    "Las cookies necesarias permanecen activas. Las categorías opcionales solo se guardan si las seleccionas explícitamente.",
  manageButton: "Cookies",
  savedNecessary: "Solo están activas las cookies necesarias.",
  savedCustom: "Tus categorías de cookies seleccionadas están activas.",
  savedAll: "Todas las categorías de cookies están aceptadas.",
};

const figtree = localFont({
  display: "swap",
  fallback: ["system-ui", "sans-serif"],
  src: "../app/fonts/figtree-latin.woff2",
  style: "normal",
  variable: "--font-figtree",
  weight: "400 800",
});

type PublicCrmLandingProps = {
  copy: LegacyLandingCopy;
  language: PublicLanguageCode;
  legalCopy: LegalCopy;
  pageCopy: PublicCopy;
};

type IconName = "calendar" | "chart" | "check" | "document" | "lock" | "shield" | "user";

function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const common = {
    "aria-hidden": true,
    fill: "none",
    height: size,
    viewBox: "0 0 24 24",
    width: size,
  } as const;

  if (name === "check") {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" fill="currentColor" opacity="0.12" />
        <path d="m8 12.2 2.5 2.5L16.5 9" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      </svg>
    );
  }

  if (name === "calendar") {
    return (
      <svg {...common}>
        <path d="M4 8h16v11H4z" fill="currentColor" opacity="0.12" />
        <path d="M7 3v3m10-3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13H4V6a1 1 0 0 1 1-1Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" />
      </svg>
    );
  }

  if (name === "chart") {
    return (
      <svg {...common}>
        <path d="M5 19V11h3v8m4 0V5h3v14m4 0v-6h3v6" fill="currentColor" opacity="0.16" />
        <path d="M3 20h18M6 18v-7h4v7m2 0V4h4v14m2 0v-6h3v6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
      </svg>
    );
  }

  if (name === "user") {
    return (
      <svg {...common}>
        <circle cx="12" cy="8" r="4" fill="currentColor" opacity="0.15" />
        <path d="M5 20c.7-4.1 3.3-6.2 7-6.2s6.3 2.1 7 6.2M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" />
      </svg>
    );
  }

  if (name === "shield") {
    return (
      <svg {...common}>
        <path d="M12 3 5 5.5v6.1c0 4.4 2.7 7.3 7 9.4 4.3-2.1 7-5 7-9.4V5.5L12 3Z" fill="currentColor" opacity="0.14" />
        <path d="M12 3 5 5.5v6.1c0 4.4 2.7 7.3 7 9.4 4.3-2.1 7-5 7-9.4V5.5L12 3Zm-3 9 2 2 4-4" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" />
      </svg>
    );
  }

  if (name === "document") {
    return (
      <svg {...common}>
        <path d="M6 3h8l4 4v14H6z" fill="currentColor" opacity="0.12" />
        <path d="M14 3v5h5M8.5 13h7m-7 4h7M6 3h8l5 5v13H6V3Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
      </svg>
    );
  }

  return (
    <svg {...common}>
      <rect height="11" rx="2" width="14" x="5" y="10" fill="currentColor" opacity="0.13" />
      <path d="M8 10V8a4 4 0 0 1 8 0v2m-10 0h12a1 1 0 0 1 1 1v10H5V11a1 1 0 0 1 1-1Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" />
    </svg>
  );
}

function Brand({ language }: { language: PublicLanguageCode }) {
  return (
    <Link aria-label="Novalure CRM" className={styles.brand} href={withPublicLanguage("/", language)}>
      <NovalureWordmark className={styles.wordmark} />
      <span className={styles.crmBadge}>CRM</span>
    </Link>
  );
}

const publicLanguageOptions = [
  { code: "de", shortLabel: "DE" },
  { code: "en", shortLabel: "EN" },
  { code: "es", shortLabel: "ES" },
] as const satisfies readonly { code: PublicLanguageCode; shortLabel: string }[];

function getLanguageSwitchLabels(language: PublicLanguageCode, pageCopy: PublicCopy) {
  if (language === "es") {
    return {
      ariaLabel: "Idioma de la página",
      labels: {
        de: "Alemán",
        en: "Inglés",
        es: "Español",
      },
    };
  }

  return {
    ariaLabel: pageCopy.languageAriaLabel,
    labels: {
      de: pageCopy.switchToGerman,
      en: pageCopy.switchToEnglish,
      es: "Español",
    },
  };
}

function LanguageSwitch({ language, pageCopy }: {
  language: PublicLanguageCode;
  pageCopy: PublicCopy;
}) {
  const labels = getLanguageSwitchLabels(language, pageCopy);

  return (
    <nav aria-label={labels.ariaLabel} className={styles.languageSwitch}>
      {publicLanguageOptions.map((option, index) => (
        <Fragment key={option.code}>
          {index > 0 ? <i aria-hidden="true">/</i> : null}
          {language === option.code ? (
            <span aria-current="page">{option.shortLabel}</span>
          ) : (
            <Link aria-label={labels.labels[option.code]} href={withPublicLanguage("/", option.code)}>
              {option.shortLabel}
            </Link>
          )}
        </Fragment>
      ))}
    </nav>
  );
}

function SectionHeading({ children, eyebrow }: { children: ReactNode; eyebrow: string }) {
  return (
    <div className={styles.sectionHeading}>
      <p>{eyebrow}</p>
      <h2>{children}</h2>
    </div>
  );
}

type ProjectCopy = ReturnType<typeof getPublicCrmLandingV2Copy>["project"];

function ProjectUnitCard({ content }: { content: ProjectCopy }) {
  const { card, note, title } = content;

  return (
    <figure className={`${styles.unitCardFigure} ${styles.unitCard}`}>
      <div className={styles.unitCardTop}>
        <span>{card.label}</span>
        <strong>{card.status}</strong>
      </div>
      <p className={styles.unitCardTitle}>{title}</p>
      <p className={styles.unitName}>{card.unit}</p>
      <dl className={styles.unitRows}>
        {card.rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <figcaption>{note}</figcaption>
    </figure>
  );
}

function FeatureCard({ body, icon, title }: { body: string; icon: IconName; title: string }) {
  return (
    <article className={styles.featureCard}>
      <span className={styles.iconSquare}><Icon name={icon} /></span>
      <h3>{title}</h3>
      <p>{body}</p>
    </article>
  );
}

function CheckList({ items }: { items: readonly string[] }) {
  return (
    <ul className={styles.checkList}>
      {items.map((item) => <li key={item}><Icon name="check" size={20} /><span>{item}</span></li>)}
    </ul>
  );
}

export function PublicCrmLanding({
  copy: legacyCopy,
  language,
  legalCopy,
  pageCopy,
}: PublicCrmLandingProps) {
  const copy = getPublicCrmLandingV2Copy(language);
  const localizedLegalCopy = language === "es" ? spanishLegalCopy : legalCopy;
  const cookieConsentCopy = language === "es" ? spanishCookieConsentCopy : legacyCopy.cookieConsent;
  const loginHref = withPublicLanguage("/login", language);
  const cookieHref = withPublicLanguage("/cookies", language);
  const privacyHref = withPublicLanguage("/privacy", language);
  const developerHref = withPublicLanguage("/bautraeger", language);
  const brokerHref = withPublicLanguage("/makler", language);
  const featuresHref = withPublicLanguage("/funktionen", language);
  const demoHref = withPublicLanguage("/demo", language);
  const navItems = [
    { href: developerHref, label: copy.nav.developers },
    { href: brokerHref, label: copy.nav.brokers },
    { href: featuresHref, label: copy.nav.features },
  ] as const;
  const featureIcons = ["document", "user", "calendar", "chart"] as const;
  const inventoryCounts = [24, 14, 6, 4] as const;

  return (
    <div
      className={`${styles.page} ${figtree.variable} novalure-public-legacy`}
      data-public-language={language}
      lang={language}
    >
      <PublicHashRouteLoginRedirect language={language} />
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <Brand language={language} />
          <nav aria-label="Novalure CRM" className={styles.desktopNav}>
            {navItems.map((item) => <Link href={item.href} key={item.href}>{item.label}</Link>)}
          </nav>
          <div className={styles.desktopActions}>
            <LanguageSwitch language={language} pageCopy={pageCopy} />
            <a className={styles.loginLink} href={loginHref}><Icon name="lock" size={16} />{copy.nav.login}</a>
            <Link className={styles.navCta} href={demoHref}>{copy.nav.demo}</Link>
          </div>
          <div className={styles.mobileActions}>
            <LanguageSwitch language={language} pageCopy={pageCopy} />
            <PublicCrmMobileMenu
              auditHref={demoHref}
              auditLabel={copy.nav.demo}
              closeLabel={copy.nav.menuClose}
              items={navItems}
              loginHref={loginHref}
              loginLabel={copy.nav.login}
              openLabel={copy.nav.menuOpen}
            />
          </div>
        </div>
      </header>

      <main className={styles.content}>
        <section className={styles.hero}>
          <div className={styles.heroCopy}>
            <p className={styles.heroEyebrow}>{copy.hero.eyebrow}</p>
            <h1>{copy.hero.title} <span>{copy.hero.titleAccent}</span></h1>
            <p className={styles.heroDescription}>{copy.hero.description}</p>
            <div className={styles.heroButtons}>
              <Link className={styles.primaryButton} href={demoHref}>{copy.nav.demo}</Link>
              <a className={styles.secondaryButton} href="#example-project">{copy.hero.exampleCta}</a>
            </div>
            <p className={styles.accessLine}><Icon name="lock" size={17} />{copy.hero.accessLine}</p>
          </div>
          <ProjectUnitCard content={copy.project} />
        </section>

        <section className={styles.section} id="example-project">
          <span className={styles.legacyAnchor} id="preview" />
          <SectionHeading eyebrow={copy.project.eyebrow}>{copy.project.title}</SectionHeading>
          <p className={styles.sectionDescription}>{copy.project.description}</p>
          <div className={styles.previewShell}>
            <h3 className={styles.inventoryTitle}>{copy.project.inventoryTitle}</h3>
            <dl className={styles.inventoryStats}>
              {copy.project.inventoryLabels.map((label, index) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{inventoryCounts[index]}</dd>
                </div>
              ))}
            </dl>
            <ol className={styles.projectSteps} role="list">
              {copy.project.steps.map((step, index) => (
                <li key={step.title}>
                  <span aria-hidden="true">{index + 1}</span>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className={styles.section} id="features">
          <SectionHeading eyebrow={copy.features.eyebrow}>{copy.features.title}</SectionHeading>
          <div className={styles.featureGrid}>
            {copy.features.items.map((item, index) => (
              <FeatureCard body={item.body} icon={featureIcons[index] ?? "document"} key={item.title} title={item.title} />
            ))}
          </div>
          <div className={styles.sectionAction}>
            <Link className={styles.secondaryButton} href={featuresHref}>{copy.features.cta}</Link>
          </div>
        </section>

        <section className={styles.section} id="web-expose">
          <SectionHeading eyebrow={copy.analytics.eyebrow}>{copy.analytics.title}</SectionHeading>
          <p className={styles.sectionDescription}>{copy.analytics.description}</p>
          <figure className={styles.analyticsFigure}>
            <Image
              alt={copy.analytics.imageAlt}
              height={388}
              src="/landing-assets/web-expose-analytics.webp"
              unoptimized
              width={1496}
            />
            <figcaption>{copy.analytics.imageCaption}</figcaption>
          </figure>
          <div className={styles.analyticsLists}>
            <div>
              <h3><Icon name="chart" size={21} />{copy.analytics.measuresTitle}</h3>
              <CheckList items={copy.analytics.measures} />
            </div>
            <div className={styles.analyticsContext}>
              <h3><Icon name="shield" size={21} />{copy.analytics.contextTitle}</h3>
              <CheckList items={copy.analytics.context} />
            </div>
          </div>
        </section>

        <section className={styles.section} id="audiences">
          <SectionHeading eyebrow={copy.audiences.eyebrow}>{copy.audiences.title}</SectionHeading>
          <div className={styles.audienceGrid}>
            <article className={`${styles.audienceCard} ${styles.developerCard}`}>
              <h3>{copy.audiences.developers.title}</h3>
              <p>{copy.audiences.developers.body}</p>
              <Link href={developerHref}>{copy.audiences.developers.cta} <span aria-hidden="true">→</span></Link>
            </article>
            <article className={styles.audienceCard}>
              <h3>{copy.audiences.brokers.title}</h3>
              <p>{copy.audiences.brokers.body}</p>
              <Link href={brokerHref}>{copy.audiences.brokers.cta} <span aria-hidden="true">→</span></Link>
            </article>
          </div>
        </section>

        <section className={styles.section} id="faq">
          <SectionHeading eyebrow={copy.faq.eyebrow}>{copy.faq.title}</SectionHeading>
          <div className={styles.faqList}>
            {copy.faq.items.map((item) => (
              <details className={styles.faqItem} key={item.question}>
                <summary><span>{item.question}</span><i className={styles.faqIndicator} aria-hidden="true">+</i></summary>
                <p>{item.answer}</p>
              </details>
            ))}
          </div>
        </section>

        <section className={styles.finalCta} id="contact">
          <span className={styles.legacyAnchor} id="audit" />
          <h2>{copy.finalCta.title}</h2>
          <p>{copy.finalCta.description}</p>
          <Link className={styles.primaryButton} href={demoHref}>{copy.nav.demo}</Link>
        </section>
      </main>

      <footer aria-label={localizedLegalCopy.ariaLabel} className={styles.footer}>
        <div className={styles.footerInner}>
          <div>
            <p><NovalureWordmark className={styles.footerWordmark} /> · {localizedLegalCopy.companyLine}</p>
            <a href={`mailto:${companyLegalDetails.email}`}>{companyLegalDetails.email}</a>
          </div>
          <nav aria-label={localizedLegalCopy.ariaLabel}>
            {publicLegalLinks.map((link) => (
              <Link href={withPublicLanguage(link.href, language)} key={link.key}>{localizedLegalCopy.links[link.key]}</Link>
            ))}
          </nav>
        </div>
      </footer>
      <CookieConsentButton cookieHref={cookieHref} copy={cookieConsentCopy} privacyHref={privacyHref} />
    </div>
  );
}
