"use client";

import { useEffect, useState } from "react";
import type { LanguageCode } from "@/lib/i18n";

type DatabaseStatus = {
  currentMigration?: string | null;
  migrationLedgerError?: string | null;
  migrationStatus?: { checksumRows?: number; rows?: number };
  ok?: boolean;
};

export function SystemReleasesPanel({ language }: { language: LanguageCode }) {
  const de = language === "de";
  const [status, setStatus] = useState<DatabaseStatus | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/system/database", { cache: "no-store", credentials: "same-origin", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("status_unavailable");
        return response.json() as Promise<DatabaseStatus>;
      })
      .then(setStatus)
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setFailed(true);
      });
    return () => controller.abort();
  }, []);

  const cards = [
    [de ? "Laufzeitstatus" : "Runtime status", status ? (status.ok ? (de ? "Bereit" : "Ready") : (de ? "Prüfung nötig" : "Review required")) : "…"],
    [de ? "Aktuelle Migration" : "Current migration", status?.currentMigration ?? "–"],
    [de ? "Ledger-Einträge" : "Ledger rows", String(status?.migrationStatus?.rows ?? "–")],
    [de ? "Verifizierte Checksums" : "Verified checksums", String(status?.migrationStatus?.checksumRows ?? "–")],
  ];

  return (
    <section aria-labelledby="system-releases-title" className="grid gap-4">
      <header className="rounded-xl border border-stone-200 bg-white p-5">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">{de ? "Administration" : "Administration"}</p>
        <h2 className="mt-1 text-2xl font-semibold text-stone-950" id="system-releases-title">{de ? "System & Releases" : "System & releases"}</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-600">{de ? "Schreibgeschützte Laufzeit-, Ledger- und Release-Evidenz für den aktiven Workspace." : "Read-only runtime, ledger and release evidence for the active workspace."}</p>
      </header>
      {failed ? <p className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800" role="alert">{de ? "Systemstatus konnte nicht geladen werden." : "System status could not be loaded."}</p> : null}
      <div aria-live="polite" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map(([label, value]) => (
          <article className="rounded-xl border border-stone-200 bg-white p-4" key={label}>
            <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">{label}</p>
            <p className="mt-2 break-words text-lg font-semibold text-stone-950">{value}</p>
          </article>
        ))}
      </div>
      <article className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
        <h3 className="font-semibold">{de ? "Release-Gate" : "Release gate"}</h3>
        <p className="mt-1 leading-6">{de ? "Ein grüner Build allein ist kein Produktions-GO. Restore, Tenant-Isolation, Providerkonfiguration und Langzeit-SLO bleiben separate Freigaben." : "A green build alone is not a production GO. Restore, tenant isolation, provider configuration and the long-running SLO remain separate approvals."}</p>
      </article>
    </section>
  );
}
