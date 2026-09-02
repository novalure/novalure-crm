import Link from "next/link";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { FunnelRenderer } from "@/components/funnel-renderer";
import { getSessionFromHeaders } from "@/lib/auth/session";
import {
  canUsePublicLiveFunnel,
  getStoredFunnelPublicationRevision,
  getStoredFunnelSubmissionScopeResourceId,
} from "@/lib/funnel-public-access";
import { toPublicFunnelDto } from "@/lib/funnel-public-dto";
import {
  getStoredFunnel,
  getStoredFunnelForSession,
  type StoredFunnel,
} from "@/lib/funnel-store";
import type { FunnelDevice } from "@/lib/funnel-schema";
import { getFunnelDeviceLabel, getFunnelPreviewCopy, resolveLanguage } from "@/lib/i18n";
import { evaluateLaunchScope } from "@/lib/launch-scope";
import { hasProductCapability } from "@/lib/product-model";
import {
  buildPublicSubmissionScope,
  createPublicSubmissionProof,
  publicSubmissionActions,
} from "@/lib/security/public-submission-abuse";

export const metadata: Metadata = {
  referrer: "no-referrer",
  robots: { follow: false, index: false },
};

type PreviewPageProps = {
  params: Promise<{ funnelId: string }>;
  searchParams: Promise<{ device?: string; lang?: string; mode?: string; token?: string }>;
};

function normalizeDevice(value: string | undefined): FunnelDevice {
  if (value === "desktop" || value === "tablet" || value === "mobile") return value;
  return "mobile";
}

export default async function FunnelPreviewPage({ params, searchParams }: PreviewPageProps) {
  const { funnelId } = await params;
  const query = await searchParams;
  const mode = query.mode === "live" ? "live" : "test";
  let stored: StoredFunnel | null = null;

  if (mode === "test") {
    const session = await getSessionFromHeaders(await headers());
    if (
      !session ||
      !session.permissions.includes("funnels:write") ||
      !hasProductCapability(session.productRole, "funnels:publish")
    ) {
      notFound();
    }
    stored = await getStoredFunnelForSession(funnelId, session);
  } else {
    // Fail closed before the public request can read funnel data or receive a
    // submission proof when publication is disabled during a launch incident.
    if (!evaluateLaunchScope("publicFunnelPublication").allowed) notFound();
    stored = await getStoredFunnel(funnelId);
    if (!stored || !canUsePublicLiveFunnel({ blueprint: stored.blueprint, stored, token: query.token })) {
      notFound();
    }
  }

  const blueprint = stored?.blueprint;

  if (!blueprint) notFound();
  const publicFunnel = toPublicFunnelDto(blueprint);

  const device = normalizeDevice(query.device);
  const language = resolveLanguage(query.lang);
  const copy = getFunnelPreviewCopy(language);
  const submissionProof = mode === "live" && stored?.funnelId && stored.workspaceId
    ? createPublicSubmissionProof({
        action: publicSubmissionActions.funnel,
        scope: buildPublicSubmissionScope({
          resourceId: getStoredFunnelSubmissionScopeResourceId({
            funnelId: stored.funnelId,
            storedTracking: stored.tracking,
          }),
          resourceType: "funnel",
          workspaceId: stored.workspaceId,
        }),
      })
    : undefined;

  return (
    <main className="novalure-funnel-preview-page min-h-screen bg-stone-100 px-4 py-6 text-slate-950">
      {mode === "test" ? (
        <section className="novalure-funnel-preview-toolbar mx-auto mb-4 flex max-w-5xl flex-col gap-3 rounded-lg border border-stone-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">{copy.label}</p>
            <h1 className="mt-1 break-words text-xl font-semibold">{publicFunnel.name}</h1>
            <p className="mt-1 break-words text-sm text-stone-600">
              {copy.mode}: {copy.testMode} / {copy.device}: {getFunnelDeviceLabel(device, language)}
            </p>
            {stored?.updatedAt ? (
              <p className="mt-1 break-words text-xs font-semibold text-stone-500">
                Designer-Version: {new Intl.DateTimeFormat(language === "de" ? "de-AT" : "en-GB", { dateStyle: "short", timeStyle: "short" }).format(new Date(stored.updatedAt))}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            {(["mobile", "tablet", "desktop"] as const).map((item) => (
              <Link
                className={`rounded-md border px-3 py-2 text-sm font-semibold ${
                  item === device ? "border-slate-950 bg-slate-950 text-white" : "border-stone-300 bg-white text-slate-950"
                }`}
                href={`/preview/${publicFunnel.id}?device=${item}&mode=test&lang=${language}`}
                key={item}
              >
                {getFunnelDeviceLabel(item, language)}
              </Link>
            ))}
          </div>
        </section>
      ) : null}
      <FunnelRenderer
        blueprint={publicFunnel}
        device={device}
        key={`${publicFunnel.id}:publication:${mode === "live" ? getStoredFunnelPublicationRevision(stored?.tracking) : "test"}`}
        language={language}
        mode={mode}
        publicationRevision={mode === "live" ? getStoredFunnelPublicationRevision(stored?.tracking) : undefined}
        submissionProof={submissionProof}
        visitTrackingEnabled={mode === "live" && evaluateLaunchScope("publicFunnelVisit").allowed}
      />
    </main>
  );
}
