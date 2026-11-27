import type { MetadataRoute } from "next";
import type { PublicLanguageCode } from "@/lib/public-language";
import { publicProductAlternates } from "@/lib/public-product-page";

const paths = ["/", "/bautraeger", "/makler", "/funktionen", "/demo"] as const;
const locales: readonly PublicLanguageCode[] = ["de", "en", "es"];

export default function sitemap(): MetadataRoute.Sitemap {
  return paths.flatMap((path) => {
    const languages = publicProductAlternates(path);
    return locales.map((locale) => ({
      url: languages[locale],
      alternates: { languages },
    }));
  });
}
