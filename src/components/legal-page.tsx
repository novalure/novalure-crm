import Link from "next/link";
import type { ReactNode } from "react";
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
    <main className="min-h-screen bg-slate-50 px-5 py-10 text-slate-950 md:px-10" lang={language}>
      <div className="mx-auto max-w-5xl">
        <Link className="text-sm font-semibold text-blue-700" href={withPublicLanguage("/", language)}>
          Novalure CRM
        </Link>
        <header className="mt-8 border-b border-slate-200 pb-8">
          <p className="text-sm font-semibold uppercase tracking-wide text-blue-700">
            Legal
          </p>
          <h1 className="mt-3 text-4xl font-bold tracking-tight md:text-5xl">
            {title}
          </h1>
          <p className="mt-4 max-w-3xl text-base leading-7 text-slate-700">
            {subtitle}
          </p>
          <p className="mt-5 text-sm text-slate-600">
            {copy.lastUpdated}: {updated}
          </p>
          <nav
            aria-label={copy.languageAriaLabel}
            className="mt-5 flex flex-wrap items-center gap-2 text-sm font-semibold"
          >
            <span className="mr-1 text-slate-600">{copy.languageIntro}</span>
            <Link
              aria-current={language === "de" ? "page" : undefined}
              className={`rounded-md border px-3 py-2 ${
                language === "de"
                  ? "border-blue-700 bg-white text-blue-700"
                  : "border-slate-200 bg-white text-slate-700"
              }`}
              href={withPublicLanguage(path, "de")}
            >
              {copy.switchToGerman}
            </Link>
            <Link
              aria-current={language === "en" ? "page" : undefined}
              className={`rounded-md border px-3 py-2 ${
                language === "en"
                  ? "border-blue-700 bg-white text-blue-700"
                  : "border-slate-200 bg-white text-slate-700"
              }`}
              href={withPublicLanguage(path, "en")}
            >
              {copy.switchToEnglish}
            </Link>
          </nav>
          <nav
            aria-label={copy.legalNavigationLabel}
            className="mt-6 flex flex-wrap gap-3 text-sm font-semibold"
          >
            {publicLegalLinks.map((link) => (
              <Link
                className="rounded-md border border-slate-200 bg-white px-3 py-2 text-blue-700"
                href={withPublicLanguage(link.href, language)}
                key={link.key}
              >
                {copy.links[link.key]}
              </Link>
            ))}
          </nav>
        </header>
        <div className="mt-10 space-y-12">{children}</div>
      </div>
    </main>
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
    <section className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm md:p-8">
      <p className="text-sm font-semibold uppercase tracking-wide text-blue-700">
        {eyebrow}
      </p>
      <h2 className="mt-2 text-2xl font-bold text-slate-950">{title}</h2>
      <div className="mt-8 space-y-8">{children}</div>
    </section>
  );
}

export function LegalSections({ sections }: { sections: LegalSection[] }) {
  return (
    <>
      {sections.map((section) => (
        <section className="space-y-3" key={section.title}>
          <h3 className="text-xl font-semibold text-slate-950">{section.title}</h3>
          {section.body?.map((paragraph) => (
            <p className="text-base leading-7 text-slate-700" key={paragraph}>
              {paragraph}
            </p>
          ))}
          {section.items ? (
            <ul className="list-disc space-y-2 pl-6 text-base leading-7 text-slate-700">
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
    <section className="rounded-lg border border-slate-200 bg-white p-6 text-sm leading-6 text-slate-700 shadow-sm">
      <h2 className="text-lg font-semibold text-slate-950">{referenceCopy.title}</h2>
      <p className="mt-3">{referenceCopy.body}</p>
      <ul className="mt-4 list-disc space-y-2 pl-6">
        <li>
          <a className="font-semibold text-blue-700" href="https://www.dataprotection.ie/en/organisations/know-your-obligations/transparency">
            Data Protection Commission Ireland: Transparency
          </a>
        </li>
        <li>
          <a className="font-semibold text-blue-700" href="https://commission.europa.eu/law/law-topic/data-protection/information-individuals_en">
            European Commission: Information for individuals
          </a>
        </li>
        <li>
          <a className="font-semibold text-blue-700" href="https://commission.europa.eu/law/law-topic/data-protection/rules-business-and-organisations/legal-grounds-processing-data/grounds-processing/when-can-personal-data-be-processed_en">
            European Commission: Legal grounds for processing
          </a>
        </li>
        <li>
          <a className="font-semibold text-blue-700" href="https://dataprotection.ie/en/dpc-guidance/guidance-cookies-and-other-tracking-technologies">
            Data Protection Commission Ireland: Cookies and tracking technologies
          </a>
        </li>
        <li>
          <a className="font-semibold text-blue-700" href="https://cro.ie/registration/company/incidental-obligations/letterheads/">
            Companies Registration Office Ireland: company website disclosures
          </a>
        </li>
        <li>
          <a className="font-semibold text-blue-700" href="https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback/">
            Meta for Developers: Data deletion callback and instructions
          </a>
        </li>
        <li>
          <a className="font-semibold text-blue-700" href="https://developers.facebook.com/docs/development/create-an-app/app-dashboard/basic-settings/">
            Meta for Developers: App Dashboard basic settings
          </a>
        </li>
      </ul>
    </section>
  );
}
