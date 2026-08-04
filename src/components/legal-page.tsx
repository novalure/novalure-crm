import Link from "next/link";
import type { ReactNode } from "react";
import subpageStyles from "@/components/public-subpage.module.css";
import { PublicSiteShell } from "@/components/public-site-shell";
import { getPublicPageCopy, type LanguageCode } from "@/lib/i18n";
import { publicLegalLinks } from "@/lib/legal";
import { withPublicLanguage } from "@/lib/public-language";

type LegalSection = {
  title: string;
  body?: string[];
  items?: string[];
};

export function LegalPage({
  language,
  path,
  title,
  subtitle,
  updated,
  children,
}: {
  language: LanguageCode;
  path: string;
  title: string;
  subtitle: string;
  updated: string;
  children: ReactNode;
}) {
  const copy = getPublicPageCopy(language);

  return (
    <PublicSiteShell currentPath={path} language={language}>
      <header className={subpageStyles.legalHero}>
        <p className={subpageStyles.eyebrow}>Legal</p>
        <h1>{title}</h1>
        <p>{subtitle}</p>
        <p className={subpageStyles.legalMeta}>{copy.lastUpdated}: {updated}</p>
        <nav aria-label={copy.legalNavigationLabel} className={subpageStyles.legalNav}>
            {publicLegalLinks.map((link) => (
              <Link
                href={withPublicLanguage(link.href, language)}
                key={link.key}
              >
                {copy.links[link.key]}
              </Link>
            ))}
        </nav>
      </header>
      <div className={subpageStyles.legalContent}>{children}</div>
    </PublicSiteShell>
  );
}

export function LanguageBlock({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className={subpageStyles.languageBlock}>
      <p className={subpageStyles.eyebrow}>{eyebrow}</p>
      <h2>{title}</h2>
      <div className={subpageStyles.sectionList}>{children}</div>
    </section>
  );
}

export function LegalSections({ sections }: { sections: LegalSection[] }) {
  return (
    <>
      {sections.map((section) => (
        <section className={subpageStyles.legalSection} key={section.title}>
          <h3>{section.title}</h3>
          {section.body?.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
          {section.items ? (
            <ul>
              {section.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ))}
    </>
  );
}

export function LegalReferences({ language = "en" }: { language?: LanguageCode }) {
  const referenceCopy = {
    en: {
      body:
        "This page is structured around transparency, data subject rights, lawful processing, company disclosures, cookies and Meta developer review information under Irish, EU and platform rules.",
      title: "Regulatory references",
    },
    de: {
      body:
        "Diese Seite orientiert sich an Transparenz, Betroffenenrechten, rechtmäßiger Verarbeitung, Unternehmensangaben, Cookies und Meta-Developer-Review-Informationen nach irischen, EU- und Plattformregeln.",
      title: "Rechtliche Quellen",
    },
  }[language];

  return (
    <section className={subpageStyles.referenceBlock}>
      <h2>{referenceCopy.title}</h2>
      <p>{referenceCopy.body}</p>
      <ul>
        <li>
          <a href="https://www.dataprotection.ie/en/organisations/know-your-obligations/transparency">
            Data Protection Commission Ireland: Transparency
          </a>
        </li>
        <li>
          <a href="https://commission.europa.eu/law/law-topic/data-protection/information-individuals_en">
            European Commission: Information for individuals
          </a>
        </li>
        <li>
          <a href="https://commission.europa.eu/law/law-topic/data-protection/rules-business-and-organisations/legal-grounds-processing-data/grounds-processing/when-can-personal-data-be-processed_en">
            European Commission: Legal grounds for processing
          </a>
        </li>
        <li>
          <a href="https://dataprotection.ie/en/dpc-guidance/guidance-cookies-and-other-tracking-technologies">
            Data Protection Commission Ireland: Cookies and tracking technologies
          </a>
        </li>
        <li>
          <a href="https://cro.ie/registration/company/incidental-obligations/letterheads/">
            Companies Registration Office Ireland: company website disclosures
          </a>
        </li>
        <li>
          <a href="https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback/">
            Meta for Developers: Data deletion callback and instructions
          </a>
        </li>
        <li>
          <a href="https://developers.facebook.com/docs/development/create-an-app/app-dashboard/basic-settings/">
            Meta for Developers: App Dashboard basic settings
          </a>
        </li>
      </ul>
    </section>
  );
}
