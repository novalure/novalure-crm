import { getPublicProductContentMetadata, PublicProductContent } from "@/components/public-product-content";
import type { PublicProductPageProps } from "@/lib/public-product-page";

export function generateMetadata({ searchParams }: PublicProductPageProps) {
  return getPublicProductContentMetadata("/bautraeger", searchParams);
}

export default function DevelopersPage({ searchParams }: PublicProductPageProps) {
  return <PublicProductContent path="/bautraeger" searchParams={searchParams} />;
}
