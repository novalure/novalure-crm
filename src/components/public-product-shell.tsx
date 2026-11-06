import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { NovalureWordmark } from "@/components/novalure-wordmark";
import { PublicCrmMobileMenu } from "@/components/public-crm-mobile-menu";
import styles from "@/components/public-crm-landing.module.css";
import { getLoginLegalFooterCopy } from "@/lib/i18n";
import { companyLegalDetails, publicLegalLinks } from "@/lib/legal";
import { getPublicCrmLandingV2Copy } from "@/lib/public-crm-landing-v2";
import { type PublicLanguageCode, withPublicLanguage } from "@/lib/public-language";
import type { PublicProductPath } from "@/lib/public-product-page";

const languageOptions = [
  { code: "de", label: "Deutsch" },
  { code: "en", label: "English" },
  { code: "es", label: "Español" },
] as const;

const shellCopy = {
  de: {
    language: "Seitensprache", navigation: "Hauptnavigation", registration: "Irische Registernummer",
    location: "Dublin, Irland",
  },
  en: {
    language: "Page language", navigation: "Main navigation", registration: "Irish company number",
    location: "Dublin, Ireland",
  },
  es: {
    language: "Idioma de la página", navigation: "Navegación principal", registration: "Número de empresa irlandesa",
    location: "Dublín, Irlanda",
  },
} as const;

const spanishLegalCopy = {
  ariaLabel: "Información legal",
  links: {
    imprint: "Aviso legal", privacy: "Política de privacidad", cookies: "Aviso de cookies",
    terms: "Condiciones de uso", dataDeletion: "Eliminación de datos", meta: "Avisos de Meta",
  },
};

export function PublicProductShell({ language, path, children }: {
  language: PublicLanguageCode;
  path: PublicProductPath;
  children: ReactNode;
}) {
  const copy = shellCopy[language];
  const { nav } = getPublicCrmLandingV2Copy(language);
  const legalCopy = language === "es" ? spanishLegalCopy : getLoginLegalFooterCopy(language);
  const demoHref = withPublicLanguage("/demo", language);
  const loginHref = withPublicLanguage("/login", language);
  const navItems = [
    { destination: "/bautraeger", label: nav.developers },
    { destination: "/makler", label: nav.brokers },
    { destination: "/funktionen", label: nav.features },
  ].map(({ destination, label }) => ({
    destination,
    href: withPublicLanguage(destination, language),
    label,
  }));
  const languageSwitch = (
    <nav aria-label={copy.language} className={styles.languageSwitch}>
      {languageOptions.map(({ code, label }, index) => (
        <Fragment key={code}>
          {index > 0 && <i aria-hidden="true">/</i>}
          {language === code ? (
            <span aria-current="page" aria-label={label}>{code.toUpperCase()}</span>
          ) : (
            <Link href={withPublicLanguage(path, code)} hrefLang={code} aria-label={label}>{code.toUpperCase()}</Link>
          )}
        </Fragment>
      ))}
    </nav>
  );

  return (
    <div className={styles.page} data-public-language={language} lang={language}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <Link aria-label="Novalure CRM" className={styles.brand} href={withPublicLanguage("/", language)}>
            <NovalureWordmark className={styles.wordmark} />
            <span className={styles.crmBadge}>CRM</span>
          </Link>
          <nav aria-label={copy.navigation} className={styles.desktopNav}>
            {navItems.map(({ destination, href, label }) => (
              <Link key={destination} href={href} aria-current={path === destination ? "page" : undefined}>{label}</Link>
            ))}
          </nav>
          <div className={styles.desktopActions}>
            {languageSwitch}
            <Link className={styles.loginLink} href={loginHref}>{nav.login}</Link>
            <Link className={styles.navCta} href={demoHref} aria-current={path === "/demo" ? "page" : undefined}>{nav.demo}</Link>
          </div>
          <div className={styles.mobileActions}>
            {languageSwitch}
            <PublicCrmMobileMenu
              auditHref={demoHref}
              auditLabel={nav.demo}
              closeLabel={nav.menuClose}
              items={navItems}
              loginHref={loginHref}
              loginLabel={nav.login}
              openLabel={nav.menuOpen}
            />
          </div>
        </div>
      </header>
      {children}
      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <div>
            <p><NovalureWordmark className={styles.footerWordmark} /> · {companyLegalDetails.companyName} · {copy.registration} {companyLegalDetails.companyNumber} · {copy.location}</p>
            <a href={`mailto:${companyLegalDetails.email}`}>{companyLegalDetails.email}</a>
          </div>
          <nav aria-label={legalCopy.ariaLabel}>
            {publicLegalLinks.map(({ href, key }) => (
              <Link href={withPublicLanguage(href, language)} key={key}>{legalCopy.links[key]}</Link>
            ))}
          </nav>
        </div>
      </footer>
    </div>
  );
}
