import { notFound } from "next/navigation";
import { Demo } from "../../components/demo";
import type { VariantId } from "../../components/types";

export function generateStaticParams() { return ["a", "b", "c"].map(concept => ({ concept })); }
export const dynamicParams = false;
export default async function ConceptPage({ params }: { params: Promise<{ concept: string }> }) {
  const { concept } = await params;
  if (!["a", "b", "c"].includes(concept)) notFound();
  return <Demo variant={concept as VariantId} />;
}
