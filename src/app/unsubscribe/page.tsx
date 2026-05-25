import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { recordNewsletterUnsubscribe } from "@/lib/db/runtime-repositories";
import {
  getNewsletterUnsubscribePageCopy,
  type LanguageCode,
} from "@/lib/i18n";
import { resolvePublicLanguage } from "@/lib/public-language";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Newsletter unsubscribe | Novalure CRM",
  description: "One-click newsletter unsubscribe for Novalure CRM messages.",
};

type UnsubscribePageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function firstQueryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default async function UnsubscribePage({ searchParams }: UnsubscribePageProps) {
  const query = searchParams ? await searchParams : {};
  const headersList = await headers();
  const language: LanguageCode = resolvePublicLanguage({
    acceptLanguage: headersList.get("accept-language"),
    country: headersList.get("x-vercel-ip-country"),
    requestedLanguage: query.lang,
  });
  const copy = getNewsletterUnsubscribePageCopy(language);
  const email = firstQueryValue(query.email).trim();
  const workspaceId = (firstQueryValue(query.workspaceId) || firstQueryValue(query.wid)).trim();
  const campaignId = (firstQueryValue(query.campaignId) || firstQueryValue(query.campaign)).trim();
  const result =
    email && workspaceId
      ? await recordNewsletterUnsubscribe({
          campaignId,
          email,
          metadata: {
            userAgent: headersList.get("user-agent") ?? "",
          },
          source: "Newsletter-Abmeldelink",
          workspaceId,
        })
      : null;
  const isRecorded = Boolean(result?.persisted);

  return (
    <main className="min-h-screen bg-stone-50 px-5 py-10 text-slate-950">
      <section className="mx-auto flex min-h-[70vh] max-w-2xl items-center">
        <div className="w-full rounded-lg border border-blue-100 bg-white p-8 shadow-xl shadow-stone-200/70">
          <p className="text-xs font-bold uppercase text-blue-600">
            {copy.title}
          </p>
          <h1 className="mt-4 text-3xl font-bold text-slate-950">
            {isRecorded ? copy.recordedTitle : copy.missingTitle}
          </h1>
          <p className="mt-4 text-base leading-7 text-slate-600">
            {isRecorded ? copy.recordedDescription : copy.missingDescription}
          </p>
          <Link
            className="mt-8 inline-flex rounded-md bg-blue-600 px-4 py-3 text-sm font-semibold text-white shadow-sm hover:bg-blue-700"
            href="/"
          >
            {copy.backToSite}
          </Link>
        </div>
      </section>
    </main>
  );
}
