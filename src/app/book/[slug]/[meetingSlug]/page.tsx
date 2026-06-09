import type { Metadata } from "next";
import {
  generatePublicBookingMetadata,
  renderPublicBookingPage,
} from "@/app/book/public-booking-page";

type CanonicalBookingPageProps = {
  params: Promise<{ meetingSlug: string; slug: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({
  params,
  searchParams,
}: CanonicalBookingPageProps): Promise<Metadata> {
  const { meetingSlug, slug: workspacePublicKey } = await params;
  return generatePublicBookingMetadata({
    searchParams,
    slug: meetingSlug,
    workspacePublicKey,
  });
}

export default async function CanonicalBookingPage({
  params,
  searchParams,
}: CanonicalBookingPageProps) {
  const { meetingSlug, slug: workspacePublicKey } = await params;
  return renderPublicBookingPage({
    searchParams,
    slug: meetingSlug,
    workspacePublicKey,
  });
}
