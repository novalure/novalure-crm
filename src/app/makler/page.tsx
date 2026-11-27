import { getPublicProductContentMetadata, PublicProductContent } from "@/components/public-product-content";
import type { PublicProductPageProps } from "@/lib/public-product-page";

export function generateMetadata({ searchParams }: PublicProductPageProps) {
  return getPublicProductContentMetadata("/makler", searchParams);
}

export default function AgentsPage({ searchParams }: PublicProductPageProps) {
  return <PublicProductContent path="/makler" searchParams={searchParams} />;
}
