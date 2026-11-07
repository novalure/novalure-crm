import { notFound } from "next/navigation";
import { lookupWebExpose } from "@/lib/db/web-expose-repository";
import { WebExposeWebsite } from "@/components/web-expose-website";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Immobilien-Exposé", robots: { index: false, follow: false }, referrer: "no-referrer" };
export default async function ExposePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const data = await lookupWebExpose(token);
  if (!data) notFound();
  return <WebExposeWebsite token={token} data={data} />;
}
