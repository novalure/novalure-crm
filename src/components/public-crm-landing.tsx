import type { CSSProperties, ReactNode } from "react";
import localFont from "next/font/local";
import Link from "next/link";
import { CookieConsentButton } from "@/components/cookie-consent-button";
import { PublicHashRouteLoginRedirect } from "@/components/public-hash-route-login-redirect";
import { PublicCrmMobileMenu } from "@/components/public-crm-mobile-menu";
import styles from "@/components/public-crm-landing.module.css";
import {
  getCrmLandingPageCopy,
  getLoginLegalFooterCopy,
  getPublicPageCopy,
  type LanguageCode,
} from "@/lib/i18n";
import { companyLegalDetails, publicLegalLinks } from "@/lib/legal";
import { getPublicCrmLandingV2Copy } from "@/lib/public-crm-landing-v2";
import { withPublicLanguage } from "@/lib/public-language";

type LegacyLandingCopy = ReturnType<typeof getCrmLandingPageCopy>;
type LegalCopy = ReturnType<typeof getLoginLegalFooterCopy>;
type PublicCopy = ReturnType<typeof getPublicPageCopy>;

const figtree = localFont({
  display: "swap",
  fallback: ["system-ui", "sans-serif"],
  src: "../app/fonts/figtree-latin.woff2",
  style: "normal",
  variable: "--font-figtree",
  weight: "400 800",
});

type PublicCrmLandingProps = {
  auditHref: string;
  basePath: "/" | "/login";
  copy: LegacyLandingCopy;
  language: LanguageCode;
  legalCopy: LegalCopy;
  pageCopy: PublicCopy;
};

type IconName = "calendar" | "chart" | "check" | "clock" | "document" | "key" | "lock" | "shield" | "user";

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

  if (name === "clock") {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" fill="currentColor" opacity="0.12" />
        <path d="M12 7v5h4" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
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

  if (name === "key") {
    return (
      <svg {...common}>
        <circle cx="8" cy="10" r="5" fill="currentColor" opacity="0.14" />
        <path d="M12 13.5 20 21m-3-3 2-2m-5-1 2-2M8 15a5 5 0 1 1 0-10 5 5 0 0 1 0 10Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" />
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

function Brand({ language }: { language: LanguageCode }) {
  return (
    <Link aria-label="Novalure CRM" className={styles.brand} href={withPublicLanguage("/", language)}>
      <span className={styles.wordmark}>Novalure<span>.</span></span>
      <span className={styles.crmBadge}>CRM</span>
    </Link>
  );
}

function LanguageSwitch({
  basePath,
  language,
  pageCopy,
}: {
  basePath: "/" | "/login";
  language: LanguageCode;
  pageCopy: PublicCopy;
}) {
  return (
    <nav aria-label={pageCopy.languageAriaLabel} className={styles.languageSwitch}>
      {language === "de" ? (
        <span aria-current="page">DE</span>
      ) : (
        <Link aria-label={pageCopy.switchToGerman} href={withPublicLanguage(basePath, "de")}>DE</Link>
      )}
      <i aria-hidden="true">/</i>
      {language === "en" ? (
        <span aria-current="page">EN</span>
      ) : (
        <Link aria-label={pageCopy.switchToEnglish} href={withPublicLanguage(basePath, "en")}>EN</Link>
      )}
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

function LeadCard({ content }: { content: ReturnType<typeof getPublicCrmLandingV2Copy>["leadCard"] }) {
  return (
    <figure aria-label={content.note} className={styles.leadCardFigure}>
      <div className={styles.reminderBadge}><Icon name="clock" size={16} />{content.reminder}</div>
      <div className={styles.leadCard}>
        <div className={styles.leadCardTop}>
          <span>{content.type}</span>
          <strong>{content.status}</strong>
        </div>
        <h2>{content.title}</h2>
        <p className={styles.leadReceived}>{content.received}</p>
        <dl className={styles.leadRows}>
          {content.rows.map(([label, value], index) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd className={index === 3 ? styles.nextAction : undefined}>
                {index === 3 ? <Icon name="clock" size={14} /> : null}{value}
              </dd>
            </div>
          ))}
        </dl>
        <div aria-hidden="true" className={styles.progressSegments}>
          {[0, 1, 2, 3, 4].map((segment) => <span className={segment < 3 ? styles.progressActive : undefined} key={segment} />)}
        </div>
        <div className={styles.progressLabels}><span>{content.firstStage}</span><span>{content.progress}</span><span>{content.lastStage}</span></div>
        <figcaption>{content.note}</figcaption>
      </div>
    </figure>
  );
}

function ProblemCard({ body, icon, title }: { body: string; icon: IconName; title: string }) {
  return (
    <article className={styles.problemCard}>
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
  auditHref,
  basePath,
  copy: legacyCopy,
  language,
  legalCopy,
  pageCopy,
}: PublicCrmLandingProps) {
  const copy = getPublicCrmLandingV2Copy(language);
  const loginHref = withPublicLanguage("/login", language);
  const cookieHref = withPublicLanguage("/cookies", language);
  const privacyHref = withPublicLanguage("/privacy", language);
  const navItems = [
    { href: "#preview", label: copy.nav.preview },
    { href: "#audit", label: copy.nav.audit },
    { href: "#faq", label: copy.nav.faq },
  ] as const;
  const problemIcons: readonly IconName[] = ["clock", "user", "chart", "calendar"];
  const privacyIcons: readonly IconName[] = ["key", "shield", "document"];

  return (
    <div className={`${styles.page} ${figtree.variable} novalure-public-legacy`} lang={language}>
      <PublicHashRouteLoginRedirect language={language} />
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <Brand language={language} />
          <nav aria-label="Novalure CRM" className={styles.desktopNav}>
            {navItems.map((item) => <a href={item.href} key={item.href}>{item.label}</a>)}
          </nav>
          <div className={styles.desktopActions}>
            <LanguageSwitch basePath={basePath} language={language} pageCopy={pageCopy} />
            <a className={styles.loginLink} href={loginHref}><Icon name="lock" size={16} />{copy.nav.login}</a>
            <a className={styles.navCta} href={auditHref}>{copy.nav.auditCta}</a>
          </div>
          <div className={styles.mobileActions}>
            <LanguageSwitch basePath={basePath} language={language} pageCopy={pageCopy} />
            <PublicCrmMobileMenu
              auditHref={auditHref}
              auditLabel={copy.nav.auditCta}
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
            <h1>{copy.hero.title} <span>{copy.hero.titleAccent}</span></h1>
            <p className={styles.heroDescription}>{copy.hero.description}</p>
            <div className={styles.heroButtons}>
              <a className={styles.primaryButton} href={auditHref}>{copy.hero.primaryCta}</a>
              <a className={styles.secondaryButton} href="#preview">{copy.hero.secondaryCta}</a>
            </div>
            <p className={styles.accessLine}><Icon name="lock" size={17} />{copy.hero.accessLine}</p>
            <div className={styles.regionPills}>
              {copy.hero.regions.map((region) => <span key={region}>{region}</span>)}
            </div>
          </div>
          <LeadCard content={copy.leadCard} />
        </section>

        <section className={styles.section} id="problem">
          <SectionHeading eyebrow={copy.problem.eyebrow}>{copy.problem.title}</SectionHeading>
          <div className={styles.problemGrid}>
            {copy.problem.cards.map((card, index) => (
              <ProblemCard body={card.body} icon={problemIcons[index] ?? "clock"} key={card.title} title={card.title} />
            ))}
          </div>
          <figure className={styles.funnelFigure}>
            <figcaption>{copy.problem.funnelCaption}</figcaption>
            <div className={styles.funnelRows}>
              {copy.problem.funnel.map((row, index) => (
                <div className={styles.funnelRow} key={row.label}>
                  <span>{row.label}</span>
                  <div aria-hidden="true"><i style={{ "--bar-width": `${row.value}%`, "--bar-opacity": String(1 - index * 0.2) } as CSSProperties} /></div>
                  <strong>{row.value}&nbsp;%</strong>
                </div>
              ))}
            </div>
            <p>{copy.problem.funnelNote}</p>
          </figure>
        </section>

        <section className={styles.section} id="preview">
          <SectionHeading eyebrow={copy.preview.eyebrow}>{copy.preview.title}</SectionHeading>
          <p className={styles.sectionDescription}>{copy.preview.description}</p>
          <div className={styles.previewShell}>
            <div className={styles.previewLayout}>
              <figure className={styles.pipelineFigure}>
                <figcaption>{copy.preview.pipelineCaption}</figcaption>
                <div className={styles.pipelineGrid}>
                  {copy.preview.columns.map((column) => (
                    <div className={styles.pipelineColumn} key={column.title}>
                      <div className={styles.pipelineColumnHeader}><span>{column.title}</span><strong>{column.cards.length}</strong></div>
                      <div className={styles.pipelineCards}>
                        {column.cards.map((card) => (
                          <div className={styles.pipelineCard} key={`${card.source}-${card.title}`}>
                            <span>{card.source}</span><strong>{card.title}</strong><small>{card.action}</small>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </figure>
              <figure className={styles.inboxFigure}>
                <figcaption>{copy.preview.inboxCaption}</figcaption>
                <div className={styles.inboxList}>
                  {copy.preview.inbox.map((item) => (
                    <div className={styles.inboxRow} key={`${item.time}-${item.title}`}>
                      <time>{item.time}</time>
                      <div><strong>{item.title}</strong><span>{item.status}</span></div>
                      <b>{item.owner}</b>
                    </div>
                  ))}
                </div>
              </figure>
            </div>
            <div className={styles.privacyLists}>
              <div>
                <h3><Icon name="check" size={21} />{copy.preview.visibleTitle}</h3>
                <CheckList items={copy.preview.visible} />
              </div>
              <div className={styles.protectedList}>
                <h3><Icon name="shield" size={21} />{copy.preview.protectedTitle}</h3>
                <CheckList items={copy.preview.protected} />
              </div>
            </div>
          </div>
        </section>

        <section className={styles.section} id="audiences">
          <SectionHeading eyebrow={copy.audiences.eyebrow}>{copy.audiences.title}</SectionHeading>
          <div className={styles.audienceGrid}>
            {copy.audiences.items.map((item) => (
              <article className={styles.audienceCard} key={item.title}>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
                <div><span>{copy.audiences.resultLabel}</span><strong>{item.result}</strong></div>
              </article>
            ))}
          </div>
        </section>

        <section className={styles.section} id="audit">
          <SectionHeading eyebrow={copy.audit.eyebrow}>{copy.audit.title}</SectionHeading>
          <div className={styles.auditSteps}>
            {copy.audit.steps.map((step, index) => (
              <article key={step.title}>
                <span>{index + 1}</span><h3>{step.title}</h3><p>{step.body}</p>
              </article>
            ))}
          </div>
          <div className={styles.auditOutcome}>
            <h3>{copy.audit.outcomesTitle}</h3>
            <CheckList items={copy.audit.outcomes} />
            <a className={styles.primaryButton} href={auditHref}>{copy.audit.cta}</a>
          </div>
        </section>

        <section className={styles.section} id="privacy">
          <SectionHeading eyebrow={copy.privacy.eyebrow}>{copy.privacy.title}</SectionHeading>
          <div className={styles.privacyGrid}>
            {copy.privacy.items.map((item, index) => (
              <article key={item.title}>
                <span><Icon name={privacyIcons[index] ?? "shield"} size={23} /></span>
                <h3>{item.title}</h3><p>{item.body}</p>
              </article>
            ))}
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
          <h2>{copy.finalCta.title}</h2>
          <p>{copy.finalCta.description}</p>
          <a className={styles.primaryButton} href={auditHref}>{copy.finalCta.cta}</a>
        </section>
      </main>

      <footer aria-label={legalCopy.ariaLabel} className={styles.footer}>
        <div className={styles.footerInner}>
          <div>
            <p><strong>Novalure<span>.</span></strong> · {legalCopy.companyLine}</p>
            <a href={`mailto:${companyLegalDetails.email}`}>{companyLegalDetails.email}</a>
          </div>
          <nav aria-label={legalCopy.ariaLabel}>
            {publicLegalLinks.map((link) => (
              <Link href={withPublicLanguage(link.href, language)} key={link.key}>{legalCopy.links[link.key]}</Link>
            ))}
          </nav>
        </div>
      </footer>
      <CookieConsentButton cookieHref={cookieHref} copy={legacyCopy.cookieConsent} privacyHref={privacyHref} />
    </div>
  );
}
