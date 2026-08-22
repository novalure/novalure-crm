import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getLegacyPublicMeetingPageRoute } from "@/lib/db/meeting-repositories";
import { getPublicBookingPageCopy } from "@/lib/i18n";
import { resolvePublicPageLanguage } from "@/lib/page-metadata";
import { appendSearchParams } from "@/lib/public-routing";

type LegacyBookingPageProps = {
  params: Promise<{ slug: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function titleFromSlug(slug: string) {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export async function generateMetadata({ params, searchParams }: LegacyBookingPageProps): Promise<Metadata> {
  const { slug } = await params;
  const query = searchParams ? await searchParams : {};
  const language = resolvePublicPageLanguage(await headers(), query);
  const copy = getPublicBookingPageCopy(language);

  return {
    description: copy.metadataDescription,
    robots: { follow: false, index: false },
    title: copy.bookTitle(titleFromSlug(slug) || copy.meeting),
  };
}

export default async function LegacyBookingPage({ params, searchParams }: LegacyBookingPageProps) {
  const { slug } = await params;
  const query = searchParams ? await searchParams : {};
  const legacy = await getLegacyPublicMeetingPageRoute(slug);

  if (legacy.status === "unique") {
    redirect(appendSearchParams(legacy.canonicalPath, query));
  }

  notFound();
}
