import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "404 | Novalure CRM",
};

export default async function NotFound() {
  const requestHeaders = await headers();
  const isGerman = requestHeaders.get("accept-language")?.toLowerCase().startsWith("de") ?? false;
  return (
    <main className="grid min-h-dvh place-items-center bg-[#f7fbff] px-6 text-[#071421]" lang={isGerman ? "de" : "en"}>
      <section className="max-w-xl rounded-xl border border-[#c8d8e8] bg-white p-8 text-center shadow-lg">
        <p className="text-sm font-bold uppercase tracking-[0.18em] text-[#2563eb]">404</p>
        <h1 className="mt-3 text-3xl font-semibold">{isGerman ? "Seite nicht gefunden" : "Page not found"}</h1>
        <p className="mt-4 text-[#476178]">
          {isGerman ? "Die angeforderte Seite existiert nicht oder ist nicht mehr verfügbar." : "The requested page does not exist or is no longer available."}
        </p>
        <Link className="mt-6 inline-flex rounded-md bg-[#071421] px-4 py-3 font-semibold text-white" href={isGerman ? "/?lang=de" : "/?lang=en"}>
          {isGerman ? "Zur Startseite" : "Back to home"}
        </Link>
      </section>
    </main>
  );
}
