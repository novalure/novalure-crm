import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getLegacyPublicWebsiteFormRoute } from "@/lib/db/form-repositories";
import { appendSearchParams } from "@/lib/public-routing";
import {
  renderUnavailableFormPage,
  titleFromFormSlug,
} from "@/app/forms/public-form-page";

export const dynamic = "force-dynamic";

type LegacyFormPageProps = {
  params: Promise<{ slug: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: LegacyFormPageProps): Promise<Metadata> {
  const { slug } = await params;

  return {
    description: "Novalure CRM Formular",
    title: `${titleFromFormSlug(slug) || "Formular"} | Novalure`,
  };
}

export default async function LegacyPublicFormPage({
  params,
  searchParams,
}: LegacyFormPageProps) {
  const { slug } = await params;
  const query = searchParams ? await searchParams : {};
  const legacy = await getLegacyPublicWebsiteFormRoute(slug).catch(() => ({ status: "not_found" as const, slug }));

  if (legacy.status === "unique") {
    redirect(appendSearchParams(legacy.canonicalPath, query));
  }

  return renderUnavailableFormPage({ query, slug });
}
