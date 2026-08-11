import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import subpageStyles from "@/components/public-subpage.module.css";
import { PublicSiteShell } from "@/components/public-site-shell";
import { resolvePublicPageLanguage } from "@/lib/page-metadata";
import { withPublicLanguage } from "@/lib/public-language";

export async function generateMetadata(): Promise<Metadata> {
  const language = resolvePublicPageLanguage(await headers(), {});
  return {
    description: language === "de"
      ? "Die angeforderte Novalure CRM Seite wurde nicht gefunden."
      : "The requested Novalure CRM page was not found.",
    robots: { follow: false, index: false },
    title: language === "de" ? "Seite nicht gefunden | Novalure CRM" : "Page not found | Novalure CRM",
  };
}

export default async function NotFound() {
  const requestHeaders = await headers();
  const language = resolvePublicPageLanguage(requestHeaders, {});
  const isGerman = language === "de";
  return (
    <PublicSiteShell
      currentPath="/"
      language={language}
      languageHrefs={{ de: withPublicLanguage("/", "de"), en: withPublicLanguage("/", "en") }}
    >
      <section className={subpageStyles.statusWrap}>
        <div className={subpageStyles.statusCard}>
        <p className={subpageStyles.eyebrow}>404</p>
        <h1>{isGerman ? "Seite nicht gefunden" : "Page not found"}</h1>
        <p>
          {isGerman ? "Die angeforderte Seite existiert nicht oder ist nicht mehr verfügbar." : "The requested page does not exist or is no longer available."}
        </p>
        <Link className={subpageStyles.secondaryButton} href={withPublicLanguage("/", language)}>
          {isGerman ? "Zur Startseite" : "Back to home"}
        </Link>
        </div>
      </section>
    </PublicSiteShell>
  );
}
