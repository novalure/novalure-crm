import Link from "next/link";
import { notFound } from "next/navigation";
import { FunnelRenderer } from "@/components/funnel-renderer";
import { findFunnelBlueprint } from "@/lib/funnel-builder-adapter";
import { funnelSteps, funnels, projects, users } from "@/lib/crm-source";
import { getStoredFunnel } from "@/lib/funnel-store";
import type { FunnelDevice } from "@/lib/funnel-schema";
import { getFunnelDeviceLabel, getFunnelPreviewCopy, resolveLanguage } from "@/lib/i18n";

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
  const stored = await getStoredFunnel(funnelId);
  const fallback = findFunnelBlueprint(funnelId, { funnels, projects, steps: funnelSteps, users });
  const blueprint = stored?.blueprint ?? fallback;

  if (!blueprint) notFound();

  const device = normalizeDevice(query.device);
  const mode = query.mode === "live" ? "live" : "test";
  const language = resolveLanguage(query.lang);
  const copy = getFunnelPreviewCopy(language);

  return (
    <main className="min-h-screen bg-stone-100 px-4 py-6 text-slate-950">
      <section className="mx-auto mb-4 flex max-w-5xl flex-col gap-3 rounded-lg border border-stone-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">{copy.label}</p>
          <h1 className="mt-1 break-words text-xl font-semibold">{blueprint.name}</h1>
          <p className="mt-1 break-words text-sm text-stone-600">
            {copy.mode}: {mode === "test" ? copy.testMode : copy.liveMode} / {copy.device}: {getFunnelDeviceLabel(device, language)}
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
              href={`/preview/${blueprint.id}?device=${item}&mode=${mode}&lang=${language}&token=${query.token ?? "local"}`}
              key={item}
            >
              {getFunnelDeviceLabel(item, language)}
            </Link>
          ))}
        </div>
      </section>
      <FunnelRenderer blueprint={blueprint} device={device} language={language} mode={mode} />
    </main>
  );
}
