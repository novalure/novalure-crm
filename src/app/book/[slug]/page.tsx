import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { getLegacyPublicMeetingPageRoute } from "@/lib/db/meeting-repositories";
import { getPublicBookingPageCopy } from "@/lib/i18n";
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

export async function generateMetadata({ params }: LegacyBookingPageProps): Promise<Metadata> {
  const { slug } = await params;
  const copy = getPublicBookingPageCopy("de");

  return {
    description: copy.metadataDescription,
    robots: { follow: false, index: false },
    title: copy.bookTitle(titleFromSlug(slug) || "Meeting"),
  };
}

export default async function LegacyBookingPage({ params, searchParams }: LegacyBookingPageProps) {
  const { slug } = await params;
  const query = searchParams ? await searchParams : {};
  const legacy = await getLegacyPublicMeetingPageRoute(slug);

  if (legacy.status === "unique") {
    permanentRedirect(appendSearchParams(legacy.canonicalPath, query));
  }
  notFound();
}
