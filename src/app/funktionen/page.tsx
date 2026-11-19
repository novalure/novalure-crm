import { getPublicProductContentMetadata, PublicProductContent } from "@/components/public-product-content";
import type { PublicProductPageProps } from "@/lib/public-product-page";

export function generateMetadata({ searchParams }: PublicProductPageProps) {
  return getPublicProductContentMetadata("/funktionen", searchParams);
}

export default function FeaturesPage({ searchParams }: PublicProductPageProps) {
  return <PublicProductContent path="/funktionen" searchParams={searchParams} />;
}
