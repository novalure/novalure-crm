import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import subpageStyles from "@/components/public-subpage.module.css";
import { PublicSiteShell } from "@/components/public-site-shell";
import { languageRequestHeaderName } from "@/lib/i18n";
import { resolvePublicLanguage, withPublicLanguage } from "@/lib/public-language";

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "404 | Novalure CRM",
};

export default async function NotFound() {
  const requestHeaders = await headers();
  const language = resolvePublicLanguage({
    acceptLanguage: requestHeaders.get("accept-language"),
    country: requestHeaders.get("x-vercel-ip-country"),
    persistedLanguage: requestHeaders.get(languageRequestHeaderName),
  });
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
