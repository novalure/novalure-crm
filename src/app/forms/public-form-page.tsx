import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { FormRuntimeClient } from "@/components/form-runtime-client";
import { getPublicWebsiteForm } from "@/lib/db/form-repositories";
import { getFormCommandCenterCopy } from "@/lib/i18n";
import { resolvePublicLanguage } from "@/lib/public-language";
import {
  getPublicFormLaunchBlockReason,
  toPublicFormDto,
  type PublicFormLaunchBlockReason,
} from "@/lib/public-form-dto";
import {
  buildPublicSubmissionScope,
  createPublicSubmissionProof,
  publicSubmissionActions,
} from "@/lib/security/public-submission-abuse";

export type PublicFormPageInput = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
  slug: string;
  workspacePublicKey: string;
};

export function getFormQueryValue(value: string | string[] | undefined, fallback = "") {
  if (Array.isArray(value)) return value[0] ?? fallback;
  return value ?? fallback;
}

export function titleFromFormSlug(slug: string) {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export async function generatePublicFormMetadata({
  searchParams,
  slug,
  workspacePublicKey,
}: PublicFormPageInput): Promise<Metadata> {
  const query = searchParams ? await searchParams : {};
  const requestHeaders = await headers();
  const language = resolvePublicLanguage({
    acceptLanguage: requestHeaders.get("accept-language"),
    requestedLanguage: query.lang,
  });
  const copy = getFormCommandCenterCopy(language);
  const persisted = await getPublicWebsiteForm({ slug, workspacePublicKey });
  if (!persisted?.publicPath) notFound();

  return {
    description: copy.publicPage.metadataDescription,
    title: `${persisted.form.name} | Novalure`,
  };
}

export async function renderPublicFormPage({
  searchParams,
  slug,
  workspacePublicKey,
}: PublicFormPageInput) {
  const query = searchParams ? await searchParams : {};
  const source = getFormQueryValue(query.utm_source, "website");
  const submitted = getFormQueryValue(query.submitted) === "1";
  const requestHeaders = await headers();
  const language = resolvePublicLanguage({
    acceptLanguage: requestHeaders.get("accept-language"),
    requestedLanguage: query.lang,
  });
  const copy = getFormCommandCenterCopy(language);
  const persisted = await getPublicWebsiteForm({ slug, workspacePublicKey });
  if (!persisted?.publicPath) notFound();
  const form = persisted.form;
  const launchBlockReason = getPublicFormLaunchBlockReason(form, persisted.ownerActive);
  if (launchBlockReason) {
    return renderLaunchBlockedPublicForm(copy.publicPage, launchBlockReason);
  }
  const publicForm = toPublicFormDto(form);
  const title = publicForm.name;
  const returnTo = persisted.publicPath;
  const submissionProof = createPublicSubmissionProof({
    action: publicSubmissionActions.form,
    scope: buildPublicSubmissionScope({
      resourceId: persisted.id,
      resourceType: "form",
      workspaceId: persisted.workspaceId,
    }),
  });

  return (
    <main className="novalure-public-runtime min-h-screen bg-slate-100 px-4 py-8 text-slate-950">
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
          </div>
        </div>

        <div className="p-5 sm:p-6 lg:p-8">
          {submitted ? (
            <div className="mb-5 rounded-xl border border-emerald-200 bg-emerald-50 p-5 text-emerald-950">
              <p className="text-xl font-semibold">{copy.publicPage.submittedTitle}</p>
              <p className="mt-2 text-sm">{publicForm.thankYouMessage}</p>
            </div>
          ) : null}
          <FormRuntimeClient
            copy={copy.runtime}
            form={publicForm}
            publicKey={`${workspacePublicKey}/${slug}`}
            returnTo={returnTo}
            source={source}
            submissionProof={submissionProof}
          />
        </div>
      </section>
    </main>
  );
}

function renderLaunchBlockedPublicForm(
  copy: ReturnType<typeof getFormCommandCenterCopy>["publicPage"],
  reason: PublicFormLaunchBlockReason,
) {
  const title = reason === "form_file_upload_unavailable"
    ? copy.fileUploadUnavailableTitle
    : reason === "form_custom_pattern_unavailable" || reason === "form_consent_configuration_unavailable"
      ? copy.configurationUnavailableTitle
      : copy.ownerUnavailableTitle;
  const description = reason === "form_file_upload_unavailable"
    ? copy.fileUploadUnavailableDescription
    : reason === "form_custom_pattern_unavailable" || reason === "form_consent_configuration_unavailable"
      ? copy.configurationUnavailableDescription
      : copy.ownerUnavailableDescription;

  return (
    <main className="novalure-public-runtime min-h-screen bg-slate-100 px-4 py-8 text-slate-950">
      <section className="mx-auto max-w-xl rounded-2xl border border-amber-200 bg-white p-6 shadow-xl sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-700">
          {copy.eyebrow}
        </p>
        <h1 className="mt-3 text-3xl font-semibold leading-tight">{title}</h1>
        <p className="mt-4 text-sm leading-6 text-slate-700">{description}</p>
        <p className="mt-3 text-sm font-semibold text-slate-950">{copy.unavailableHint}</p>
      </section>
    </main>
  );
}
