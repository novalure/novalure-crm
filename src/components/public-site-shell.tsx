import type { ReactNode } from "react";
import localFont from "next/font/local";
import Link from "next/link";
import styles from "@/components/public-site-shell.module.css";
import {
  getLoginLegalFooterCopy,
  getPublicPageCopy,
  type LanguageCode,
} from "@/lib/i18n";
import { companyLegalDetails, publicLegalLinks } from "@/lib/legal";
import { withPublicLanguage } from "@/lib/public-language";

const figtree = localFont({
  display: "swap",
  fallback: ["system-ui", "sans-serif"],
  src: "../app/fonts/figtree-latin.woff2",
  style: "normal",
  variable: "--font-figtree",
  weight: "400 800",
});

const shellCopy = {
  de: {
    audit: "Audit",
    faq: "FAQ",
    home: "Startseite",
    login: "Team-Login",
    navigation: "Hauptnavigation",
    preview: "Einblick",
  },
  en: {
    audit: "Audit",
    faq: "FAQ",
    home: "Home",
    login: "Team login",
    navigation: "Main navigation",
    preview: "Preview",
  },
} as const;

type LanguageHrefs = Record<LanguageCode, string>;

export function PublicSiteShell({
  children,
  currentPath,
  language,
  languageHrefs,
  mainClassName,
}: {
  children: ReactNode;
  currentPath: string;
  language: LanguageCode;
  languageHrefs?: LanguageHrefs;
  mainClassName?: string;
}) {
  const copy = shellCopy[language];
  const pageCopy = getPublicPageCopy(language);
  const legalCopy = getLoginLegalFooterCopy(language);
  const isLoginRoute = currentPath.startsWith("/login");
  const resolvedLanguageHrefs = languageHrefs ?? {
    de: withPublicLanguage(currentPath, "de"),
    en: withPublicLanguage(currentPath, "en"),
  };
  const actionHref = withPublicLanguage("/login", language);
  const actionLabel = copy.login;

  return (
    <div className={`${styles.page} ${figtree.variable} novalure-public-legacy`} lang={language}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <Link aria-label="Novalure" className={styles.brand} href={actionHref}>
            <span className={styles.wordmark}>Novalure<span>.</span></span>
          </Link>

          <div className={styles.headerActions}>
            <nav aria-label={pageCopy.languageAriaLabel} className={styles.languageSwitch}>
              {language === "de" ? (
                <span aria-current="page">DE</span>
              ) : (
                <Link aria-label={pageCopy.switchToGerman} href={resolvedLanguageHrefs.de}>DE</Link>
              )}
              <i aria-hidden="true">/</i>
              {language === "en" ? (
                <span aria-current="page">EN</span>
              ) : (
                <Link aria-label={pageCopy.switchToEnglish} href={resolvedLanguageHrefs.en}>EN</Link>
              )}
            </nav>
            {!isLoginRoute ? <Link className={styles.headerButton} href={actionHref}>{actionLabel}</Link> : null}
          </div>
        </div>
      </header>

      <main className={`${styles.main} ${mainClassName ?? ""}`}>{children}</main>

      <footer aria-label={legalCopy.ariaLabel} className={styles.footer}>
        <div className={styles.footerInner}>
          <div>
            <p><strong>Novalure<span>.</span></strong> · {legalCopy.companyLine}</p>
            <a href={`mailto:${companyLegalDetails.email}`}>{companyLegalDetails.email}</a>
          </div>
          <nav aria-label={legalCopy.ariaLabel}>
            {publicLegalLinks.map((link) => (
              <Link href={withPublicLanguage(link.href, language)} key={link.key}>
                {legalCopy.links[link.key]}
              </Link>
            ))}
          </nav>
        </div>
      </footer>
    </div>
  );
}
