import type { Metadata } from "next";
import { headers } from "next/headers";
import { FormRuntimeClient } from "@/components/form-runtime-client";
import { getPublicWebsiteForm } from "@/lib/db/form-repositories";
import { getFormCommandCenterCopy } from "@/lib/i18n";
import { resolvePublicLanguage } from "@/lib/public-language";

export const dynamic = "force-dynamic";

type FormPageProps = {
  params: Promise<{ slug: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function getQueryValue(value: string | string[] | undefined, fallback = "") {
  if (Array.isArray(value)) return value[0] ?? fallback;
  return value ?? fallback;
}

function titleFromSlug(slug: string) {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export async function generateMetadata({ params, searchParams }: FormPageProps): Promise<Metadata> {
  const { slug } = await params;
  const query = searchParams ? await searchParams : {};
  const requestHeaders = await headers();
  const language = resolvePublicLanguage({
    acceptLanguage: requestHeaders.get("accept-language"),
    requestedLanguage: query.lang,
  });
  const copy = getFormCommandCenterCopy(language);
  const persisted = await getPublicWebsiteForm(slug).catch(() => null);
  const title = persisted?.form.name || copy.publicPage.unavailableTitle;

  return {
    description: copy.publicPage.metadataDescription,
    title: `${title} | Novalure`,
  };
}

export default async function PublicFormPage({ params, searchParams }: FormPageProps) {
  const { slug } = await params;
  const query = searchParams ? await searchParams : {};
  const source = getQueryValue(query.utm_source, "website");
  const submitted = getQueryValue(query.submitted) === "1";
  const crmStatus = getQueryValue(query.crm_status);
  const crmReason = getQueryValue(query.crm_reason);
  const requestHeaders = await headers();
  const language = resolvePublicLanguage({
    acceptLanguage: requestHeaders.get("accept-language"),
    requestedLanguage: query.lang,
  });
  const copy = getFormCommandCenterCopy(language);
  const persisted = await getPublicWebsiteForm(slug).catch(() => null);
  const form = persisted?.form ?? null;
  const title = form?.name || titleFromSlug(slug) || copy.publicPage.unavailableTitle;

  return (
    <main className="min-h-screen bg-slate-100 px-4 py-8 text-slate-950">
      <section className="mx-auto grid max-w-5xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl lg:grid-cols-[0.9fr_1.1fr]">
        <div className="bg-slate-950 p-6 text-white lg:p-8">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-300">
            {copy.publicPage.eyebrow}
          </p>
          <h1 className="mt-3 max-w-xl text-3xl font-semibold leading-tight sm:text-4xl">
            {title}
          </h1>
          <p className="mt-4 max-w-xl text-sm leading-6 text-slate-300">
            {copy.publicPage.description}
          </p>
          <div className="mt-8 grid gap-3 text-sm">
            <div className="rounded-lg border border-white/10 bg-white/5 p-4">
              <p className="text-xs uppercase tracking-[0.14em] text-slate-400">{copy.publicPage.source}</p>
              <p className="mt-1 font-semibold">{source}</p>
            </div>
            <div className="rounded-lg border border-white/10 bg-white/5 p-4">
              <p className="text-xs uppercase tracking-[0.14em] text-slate-400">{copy.publicPage.crmTarget}</p>
              <p className="mt-1 font-semibold">
                {form ? `${form.crmTarget} / ${form.pipelineStage}` : copy.publicPage.unavailableTitle}
              </p>
            </div>
          </div>
        </div>

        <div className="p-5 sm:p-6 lg:p-8">
          {form && submitted ? (
            <div className="mb-5 rounded-xl border border-emerald-200 bg-emerald-50 p-5 text-emerald-950">
              <p className="text-xl font-semibold">{copy.publicPage.submittedTitle}</p>
              <p className="mt-2 text-sm">{form.actions.thankYouMessage}</p>
              {crmStatus ? (
                <p className="mt-2 text-xs font-semibold uppercase tracking-[0.12em]">
                  CRM: {crmStatus}{crmReason ? ` (${crmReason})` : ""}
                </p>
              ) : null}
            </div>
          ) : null}
          {form ? (
            <FormRuntimeClient
              copy={copy.runtime}
              form={form}
              publicKey={form.id || slug}
              returnTo={`/forms/${slug}`}
              source={source}
            />
          ) : (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-amber-950">
              <p className="text-xl font-semibold">{copy.publicPage.unavailableTitle}</p>
              <p className="mt-2 text-sm leading-6">{copy.publicPage.unavailableDescription}</p>
              <p className="mt-3 text-sm font-semibold">{copy.publicPage.unavailableHint}</p>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
