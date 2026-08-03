import type { MetadataRoute } from "next";
import { publicSiteOrigin } from "@/lib/legal";

export default function robots(): MetadataRoute.Robots {
  return {
    host: publicSiteOrigin,
    rules: {
      userAgent: "*",
      allow: ["/", "/imprint", "/privacy", "/cookies", "/terms", "/data-deletion", "/meta"],
      disallow: ["/api/", "/login", "/forms/", "/book/", "/m/", "/preview/", "/unsubscribe"],
    },
    sitemap: `${publicSiteOrigin}/sitemap.xml`,
  };
}
