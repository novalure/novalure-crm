import type { Metadata } from "next";
import { redirect } from "next/navigation";
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
    title: copy.bookTitle(titleFromSlug(slug) || "Meeting"),
  };
}

export default async function LegacyBookingPage({ params, searchParams }: LegacyBookingPageProps) {
  const { slug } = await params;
  const query = searchParams ? await searchParams : {};
  const legacy = await getLegacyPublicMeetingPageRoute(slug).catch(() => ({
    slug,
    status: "not_found" as const,
  }));

  if (legacy.status === "unique") {
    redirect(appendSearchParams(legacy.canonicalPath, query));
  }

  const copy = getPublicBookingPageCopy("de");

  return (
    <main className="grid min-h-screen place-items-center bg-slate-50 px-4 py-12 text-slate-950">
      <section className="w-full max-w-xl rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
          {copy.eyebrow}
        </p>
        <h1 className="mt-3 text-2xl font-semibold">
          {legacy.status === "ambiguous" ? "Meeting-Link nicht eindeutig" : "Meeting nicht gefunden"}
        </h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          Bitte verwenden Sie den vollstaendigen Buchungslink.
        </p>
      </section>
    </main>
  );
}
