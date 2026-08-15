import type { LanguageCode } from "@/lib/i18n";

export function GovernanceCompliancePanel({ language }: { language: LanguageCode }) {
  const de = language === "de";
  const controls = de
    ? [
        ["Code-erzwungen", "Webhook-Signaturen, OAuth-State/PKCE, CSRF, Redirect-Validierung"],
        ["QA-verifiziert", "Tenant-Guards, Queue-Leasing, Replay- und Concurrency-Kontrollen"],
        ["Betrieblich offen", "Restore-Nachweis, Private-Blob-Bestandsmigration, MFA-/Netzwerkfreigabe"],
        ["Zeitnachweis offen", "7-Tage-Cron-/Queue-SLO und vollständige Browser-/A11y-Matrix"],
      ]
    : [
        ["Code enforced", "Webhook signatures, OAuth state/PKCE, CSRF, redirect validation"],
        ["QA verified", "Tenant guards, queue leasing, replay and concurrency controls"],
        ["Operationally open", "Restore evidence, private-blob legacy migration, MFA/network approval"],
        ["Time evidence open", "Seven-day cron/queue SLO and complete browser/accessibility matrix"],
      ];

  return (
    <section aria-labelledby="governance-title" className="grid gap-4">
      <header className="rounded-xl border border-stone-200 bg-white p-5">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">{de ? "Administration" : "Administration"}</p>
        <h2 className="mt-1 text-2xl font-semibold text-stone-950" id="governance-title">{de ? "Governance & Compliance" : "Governance & compliance"}</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-600">{de ? "Getrennte Sicht auf technisch erzwungene Kontrollen und Freigaben, die außerhalb des Codes nachgewiesen werden müssen." : "A separate view of technically enforced controls and approvals that require evidence outside the codebase."}</p>
      </header>
      <div className="grid gap-3 md:grid-cols-2">
        {controls.map(([title, description], index) => (
          <article className={`rounded-xl border p-4 ${index < 2 ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`} key={title}>
            <h3 className="font-semibold text-stone-950">{title}</h3>
            <p className="mt-2 text-sm leading-6 text-stone-700">{description}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
