import type { MetadataRoute } from "next";
import { publicSiteOrigin } from "@/lib/legal";

const publicPaths = ["/", "/imprint", "/privacy", "/cookies", "/terms", "/data-deletion", "/meta"];

export default function sitemap(): MetadataRoute.Sitemap {
  return publicPaths.flatMap((path, pathIndex) => (["de", "en"] as const).map((language) => ({
    alternates: {
      languages: {
        de: `${publicSiteOrigin}${path}?lang=de`,
        en: `${publicSiteOrigin}${path}?lang=en`,
      },
    },
    changeFrequency: path === "/" ? "weekly" as const : "yearly" as const,
    priority: path === "/" ? 1 : Math.max(0.4, 0.8 - pathIndex * 0.05),
    url: `${publicSiteOrigin}${path}?lang=${language}`,
  })));
}
