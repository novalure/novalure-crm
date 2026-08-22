import type { LanguageCode } from "@/lib/i18n";

export function GovernanceCompliancePanel({ language }: { language: LanguageCode }) {
  const de = language === "de";
  const controls = de
    ? [
        ["Im Code implementiert", "Webhook-Signaturen, OAuth-State/PKCE, CSRF und Redirect-Validierung. Kein Laufzeitnachweis in dieser Ansicht."],
        ["QA-Nachweis ausstehend", "Tenant-Guards, Queue-Leasing, Replay- und Concurrency-Kontrollen benötigen einen verknüpften, reproduzierbaren Prüfbeleg."],
        ["Betrieblich offen", "Restore-Nachweis, Private-Blob-Bestandsmigration, MFA-/Netzwerkfreigabe"],
        ["Zeitnachweis offen", "7-Tage-Cron-/Queue-SLO und vollständige Browser-/A11y-Matrix"],
      ]
    : [
        ["Implemented in code", "Webhook signatures, OAuth state/PKCE, CSRF, and redirect validation. This view provides no runtime evidence."],
        ["QA evidence pending", "Tenant guards, queue leasing, replay, and concurrency controls require linked, reproducible verification evidence."],
        ["Operationally open", "Restore evidence, private-blob legacy migration, MFA/network approval"],
        ["Time evidence open", "Seven-day cron/queue SLO and complete browser/accessibility matrix"],
      ];

  return (
    <section aria-labelledby="governance-title" className="grid gap-4">
      <header className="rounded-xl border border-stone-200 bg-white p-5">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">{de ? "Administration" : "Administration"}</p>
        <h2 className="mt-1 text-2xl font-semibold text-stone-950" id="governance-title">{de ? "Governance & Compliance" : "Governance & compliance"}</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-600">{de ? "Diese Bestandsansicht verifiziert weder Deployment noch Laufzeit. Freigaben bleiben offen, bis ein datierter Prüfbeleg verknüpft ist." : "This inventory view verifies neither deployment nor runtime. Approvals remain open until dated evidence is linked."}</p>
      </header>
      <div className="grid gap-3 md:grid-cols-2" data-governance-runtime-evidence="unavailable">
        {controls.map(([title, description]) => (
          <article className="rounded-xl border border-amber-200 bg-amber-50 p-4" data-evidence-state="pending" key={title}>
            <h3 className="font-semibold text-stone-950">{title}</h3>
            <p className="mt-2 text-sm leading-6 text-stone-700">{description}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
