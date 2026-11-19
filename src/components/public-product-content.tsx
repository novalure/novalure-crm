import Link from "next/link";
import { PublicProductShell } from "@/components/public-product-shell";
import shellStyles from "@/components/public-crm-landing.module.css";
import styles from "@/components/public-product-content.module.css";
import { productPageLabels, publicProductCopy, type ProductContentPath } from "@/lib/public-product-copy";
import { getPublicCrmLandingV2Copy } from "@/lib/public-crm-landing-v2";
import { type PublicLanguageCode, withPublicLanguage } from "@/lib/public-language";
import { getPublicProductLanguage, publicProductMetadata, type PublicProductPageProps } from "@/lib/public-product-page";

export async function getPublicProductContentMetadata(path: ProductContentPath, searchParams: PublicProductPageProps["searchParams"]) {
  const language = await getPublicProductLanguage((await searchParams).lang);
  const copy = publicProductCopy[path][language];
  return publicProductMetadata({ path, language, title: copy.metaTitle, description: copy.introduction });
}

export async function PublicProductContent({ path, searchParams }: PublicProductPageProps & { path: ProductContentPath }) {
  const language = await getPublicProductLanguage((await searchParams).lang);
  const copy = publicProductCopy[path][language];
  const { hero, nav } = getPublicCrmLandingV2Copy(language);
  const demoHref = withPublicLanguage("/demo", language);

  return (
    <PublicProductShell path={path} language={language}>
      <main className={shellStyles.content}>
        <section className={styles.hero} aria-labelledby="product-title">
          <div>
            <p className={styles.eyebrow}>{copy.label}</p>
            <h1 id="product-title">{copy.title}</h1>
            <p className={styles.introduction}>{copy.introduction}</p>
            <div className={styles.actions}>
              <Link href={demoHref} className={shellStyles.primaryButton}>{nav.demo}</Link>
              {path === "/bautraeger" ? (
                <Link href={`${withPublicLanguage("/", language)}#example-project`} className={shellStyles.secondaryButton}>
                  {hero.exampleCta}
                </Link>
              ) : (
                <a href="#ablauf" className={shellStyles.secondaryButton}>{copy.sectionsLabel}</a>
              )}
            </div>
          </div>
          <aside className={styles.highlights} aria-labelledby="product-highlights-title">
            <h2 id="product-highlights-title">{copy.highlightsTitle}</h2>
            <ul>
              {copy.highlights.map((highlight) => (
                <li key={highlight}>
                  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" width="22" height="22">
                    <circle cx="12" cy="12" r="9" fill="currentColor" opacity="0.13" />
                    <path d="m8.2 12.2 2.4 2.4 5.2-5.2" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
                  </svg>
                  {highlight}
                </li>
              ))}
            </ul>
          </aside>
        </section>
        <section className={styles.section} id="ablauf" aria-labelledby="product-sections-title">
          <p className={styles.eyebrow}>{copy.sectionsLabel}</p>
          <h2 id="product-sections-title">{copy.sectionsTitle}</h2>
          <ol className={styles.cards}>
            {copy.sections.map((section, index) => (
              <li key={section.label} className={styles.card}>
                <div className={styles.cardHeading}>
                  <span className={styles.cardIndex} aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                  <p>{section.label}</p>
                </div>
                <h3>{section.title}</h3>
                <p className={styles.cardDescription}>{section.text}</p>
              </li>
            ))}
          </ol>
        </section>
        <section className={styles.invitation} aria-labelledby="product-invitation-title">
          <h2 id="product-invitation-title">{copy.invitationTitle}</h2>
          <p>{copy.invitation}</p>
          <div className={styles.actions}>
            <Link href={demoHref} className={shellStyles.primaryButton}>{nav.demo}</Link>
            <RelatedProductPages language={language} path={path} />
          </div>
        </section>
      </main>
    </PublicProductShell>
  );
}

function RelatedProductPages({ language, path }: { language: PublicLanguageCode; path: ProductContentPath }) {
  const labels = productPageLabels[language];
  if (path !== "/funktionen") {
    return (
      <Link href={withPublicLanguage("/funktionen", language)} className={shellStyles.secondaryButton}>
        {labels.related}
      </Link>
    );
  }
  return (
    <>
      <Link href={withPublicLanguage("/bautraeger", language)} className={shellStyles.secondaryButton}>{labels.developers}</Link>
      <Link href={withPublicLanguage("/makler", language)} className={shellStyles.secondaryButton}>{labels.agents}</Link>
    </>
  );
}
