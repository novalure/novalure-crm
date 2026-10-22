import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { PublicBookingForm } from "@/components/public-booking-form";
import { getPublicBookingPublication } from "@/lib/booking/publication";
import type { BookingChannel } from "@/lib/booking/publication-types";
import { getTrustedCrmCountry, resolveAutomaticCrmLanguage } from "@/lib/crm-language";

export const dynamic = "force-dynamic";
export const metadata = { title: "Appointment booking | Novalure", robots: { index: false, follow: false } };

export default async function PublicAppointmentPage({ params, searchParams }: { params: Promise<{ publicId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { publicId } = await params, query = await searchParams;
  const requestedChannel = typeof query.channel === "string" ? query.channel : "link";
  if (!["link", "inline", "popup", "form"].includes(requestedChannel)) notFound();
  const channel = requestedChannel as Extract<BookingChannel, "link" | "inline" | "popup" | "form">;
  const publication = await getPublicBookingPublication(publicId, channel).catch(() => null);
  if (!publication) notFound();
  const requestHeaders = await headers();
  const requestedLanguage = typeof query.lang === "string" && (query.lang === "de" || query.lang === "en") ? query.lang : null;
  const language = publication.language === "auto" ? requestedLanguage ?? resolveAutomaticCrmLanguage(getTrustedCrmCountry(requestHeaders, process.env.VERCEL === "1")) : publication.language;
  const dark = publication.appearance === "dark";
  return <main lang={language} data-public-language={language} className={`novalure-public-runtime min-h-screen px-3 py-5 sm:px-6 sm:py-10 ${dark ? "bg-slate-950" : "bg-slate-50"}`}>
    <section className="mx-auto grid w-full max-w-2xl min-w-0 gap-5 rounded-xl border border-slate-200 bg-white p-4 text-slate-950 shadow-sm sm:p-6">
      <header><h1 className="break-words text-2xl font-semibold">{publication.title}</h1>{publication.description ? <p className="mt-2 whitespace-pre-line break-words text-sm leading-6 text-slate-600">{publication.description}</p> : null}</header>
      <PublicBookingForm key={publicId} publicId={publicId} channel={channel} initialLanguage={language} initialPublication={publication} />
    </section>
  </main>;
}
