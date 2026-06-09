import type { Metadata } from "next";
import {
  generatePublicFormMetadata,
  renderPublicFormPage,
} from "@/app/forms/public-form-page";

type CanonicalFormPageProps = {
  params: Promise<{ formSlug: string; slug: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({
  params,
  searchParams,
}: CanonicalFormPageProps): Promise<Metadata> {
  const { formSlug, slug: workspacePublicKey } = await params;
  return generatePublicFormMetadata({
    searchParams,
    slug: formSlug,
    workspacePublicKey,
  });
}

export default async function CanonicalFormPage({
  params,
  searchParams,
}: CanonicalFormPageProps) {
  const { formSlug, slug: workspacePublicKey } = await params;
  return renderPublicFormPage({
    searchParams,
    slug: formSlug,
    workspacePublicKey,
  });
}
