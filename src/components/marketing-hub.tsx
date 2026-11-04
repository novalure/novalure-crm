"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { MarketingArea, MarketingOverview, MarketingSourceTarget } from "@/lib/marketing-hub";
import type { Project } from "@/lib/crm-types";

type Country = "AT" | "DE" | "ES" | "IE";
type Props = {
  workspaceId: string; projectId: string | null; projects: Project[]; language: "de" | "en";
  onProjectChange: (id: string) => void;
  onOpenSource: (target: MarketingSourceTarget) => void;
  onOpenTool: (tool: "properties" | "funnels" | "forms" | "communication") => void;
  renderArea: (area: Exclude<MarketingArea, "overview">, country: Country | null) => ReactNode;
};

export function MarketingHub(props: Props) {
  return <MarketingHubContent key={props.workspaceId} {...props} />;
}

function MarketingHubContent({ workspaceId, projectId, projects, language, onProjectChange, onOpenSource, onOpenTool, renderArea }: Props) {
  const de = language === "de";
  const t = (a: string, b: string) => de ? a : b;
  const [area, setArea] = useState<MarketingArea>("overview");
  const [country, setCountry] = useState<Country | null>(null);
  const [data, setData] = useState<MarketingOverview | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ workspaceId });
    if (projectId) query.set("projectId", projectId);
    void fetch(`/api/crm/marketing-overview?${query}`, { signal: controller.signal, cache: "no-store" }).then(async response => {
      const body = await response.json() as { data?: MarketingOverview; error?: string };
      if (!response.ok || !body.data || body.data.workspaceId !== workspaceId || body.data.projectId !== projectId) throw new Error(body.error || "Marketingübersicht ist nicht verfügbar.");
      if (!controller.signal.aborted) { setData(body.data); setError(""); }
    }).catch((reason: unknown) => { if (!controller.signal.aborted) { setData(null); setError(reason instanceof Error ? reason.message : "Marketingübersicht ist nicht verfügbar."); } });
    return () => controller.abort();
  }, [workspaceId, projectId, refresh]);
  const current = data?.workspaceId === workspaceId && data.projectId === projectId ? data : null;
  const c = current?.counts;
  const n = (value: number | null | undefined) => value == null ? "—" : value.toLocaleString(de ? "de-AT" : "en-IE");
  const tabs: Array<{ id: MarketingArea; label: string; allowed: boolean }> = [
    { id: "overview", label: t("Übersicht", "Overview"), allowed: true },
    { id: "campaigns", label: t("Kampagnen", "Campaigns"), allowed: Boolean(current) },
    { id: "flows", label: "Flows", allowed: Boolean(current?.modules.flows) },
    { id: "mailings", label: "Mailings", allowed: Boolean(current?.modules.newsletter) },
    { id: "audiences", label: t("Zielgruppen & Tags", "Audiences & tags"), allowed: Boolean(current?.modules.contacts) },
    { id: "templates", label: t("Inhalte & Vorlagen", "Content & templates"), allowed: Boolean(current?.modules.newsletter || current?.modules.properties) },
    { id: "reports", label: "Reports", allowed: Boolean(current?.modules.reports) },
  ];
  const visibleArea = tabs.some(tab => tab.id === area && tab.allowed) ? area : "overview";
  const cards: Array<{ id: MarketingArea | "properties" | "funnels"; title: string; description: string; tags: string[]; state: string; action: string; allowed: boolean }> = [
    { id: "campaigns", title: t("Kampagnen & Quellen", "Campaigns & sources"), description: t("Vorhaben planen und Mailings, Formulare und Immobilienlinks mit ihren Ergebnissen verbinden.", "Plan initiatives and connect mailings, forms and property links with their results."), tags: ["UTM", t("Originalvorgänge", "Original records"), "AT · DE · ES · IE"], state: c?.campaigns == null ? t("Nicht verfügbar", "Unavailable") : c.campaigns ? `${n(c.campaigns)} ${t("Vorhaben", "initiatives")}` : t("Noch kein Vorhaben", "No initiatives yet"), action: t("Kampagnen öffnen", "Open campaigns"), allowed: Boolean(current) },
    { id: "flows", title: t("Flows & Nachfassen", "Flows & follow-up"), description: t("Auslöser, Wartezeiten und nächste Schritte im gespeicherten Ablauf verbinden.", "Connect triggers, delays and next steps in a saved workflow."), tags: [t("Automatisch", "Automated"), t("Versioniert", "Versioned"), t("Prüfung vor Versand", "Review before sending")], state: c?.flows == null ? t("Nicht verfügbar", "Unavailable") : c.activeFlows ? `${n(c.activeFlows)} ${t("aktiv", "active")}` : c.flows ? t("Entwürfe / pausiert", "Drafts / paused") : t("Noch kein Flow", "No flows yet"), action: t("Flow bearbeiten", "Edit a flow"), allowed: Boolean(current?.modules.flows) },
    { id: "mailings", title: "Mailings", description: t("Passende Kontakte informieren, Empfänger prüfen und den Versand nachvollziehen.", "Inform relevant contacts, preview recipients and follow delivery progress."), tags: ["E-Mail", t("Einwilligung", "Consent"), t("Geplant", "Scheduled")], state: c?.mailings == null ? t("Nicht verfügbar", "Unavailable") : c.approvalNeeded ? `${n(c.approvalNeeded)} ${t("zu prüfen", "to review")}` : c?.planned ? `${n(c.planned)} ${t("geplant", "scheduled")}` : c?.mailings ? t("Mailings vorhanden", "Mailings available") : t("Noch kein Mailing", "No mailings yet"), action: t("Mailing öffnen", "Open mailings"), allowed: Boolean(current?.modules.newsletter) },
    { id: "properties", title: t("Exposé-Websites & PDF", "Property websites & PDF"), description: t("Bilder, Grundrisse, Unterlagen und Videos veröffentlichen. Persönliche Links, Anfragen und PDF gehören zusammen.", "Publish photos, floor plans, documents and videos. Personal links, enquiries and PDF stay connected."), tags: ["Website", "PDF", t("Medienfreigabe", "Media approval"), t("Messung mit Einwilligung", "Consent-based analytics")], state: c?.publications == null ? t("Nicht verfügbar", "Unavailable") : `${n(c.publications)} ${t("aktive Sprachversionen", "active language versions")}`, action: t("Immobilie auswählen", "Select a property"), allowed: Boolean(current?.modules.properties) },
    { id: "audiences", title: t("Zielgruppen & Tags", "Audiences & tags"), description: t("Interessen am Originalkontakt pflegen. Land und Sprache getrennt filtern; Sperren bleiben verbindlich.", "Manage interests on the original contact. Filter country and language separately; suppressions remain binding."), tags: [t("Kontaktland", "Contact country"), t("Sprache", "Language"), t("Gespeicherte Auswahl", "Saved selection")], state: c?.audiences == null ? t("Nicht verfügbar", "Unavailable") : c.audiences ? `${n(c.audiences)} ${t("Zielgruppen", "audiences")}` : t("Noch keine Zielgruppe", "No audiences yet"), action: t("Zielgruppe prüfen", "Review an audience"), allowed: Boolean(current?.modules.contacts) },
    { id: "templates", title: t("Inhalte & Vorlagen", "Content & templates"), description: t("Mehrsprachige Mailtexte und die Gestaltung von Exposéwebsite und PDF wiederverwenden.", "Reuse multilingual email text and the design of property websites and PDFs."), tags: ["DE · EN · ES", "Mail", "PDF", t("Revision", "Revision")], state: c?.mailTemplates ? `${n(c.mailTemplates)} ${t("Mailvorlagen", "email templates")}` : t("Vorlagen verwalten", "Manage templates"), action: t("Vorlagen verwalten", "Manage templates"), allowed: Boolean(current?.modules.newsletter || current?.modules.properties) },
  ];
  const reasons: Record<MarketingOverview["review"][number]["reason"], string> = {
    approval: t("Aktuelle Mailingrevision prüfen und freigeben", "Review and approve the current mailing revision"),
    delivery_unknown: t("Unklares Versandergebnis klären", "Resolve an uncertain delivery result"),
    schedule_blocked: t("Geplanter Versand ist blockiert", "Scheduled sending is blocked"),
    flow_review: t("Flow hat eine offene Prüfung oder einen blockierten Lauf", "Flow has a review or a blocked run"),
  };
  return <section className="space-y-6" data-marketing-hub>
    <div className="rounded-2xl bg-slate-950 p-5 text-white sm:p-7">
      <p className="text-xs font-semibold uppercase tracking-widest text-emerald-300">{t("Marketing gemeinsam steuern", "Manage marketing together")}</p>
      <h2 className="mt-3 text-2xl font-semibold sm:text-3xl">{t("Von der ersten Anfrage bis zum Ergebnis", "From first enquiry to outcome")}</h2>
      <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-200">{t("Kampagnen, Mailings, Immobilienwebsites und Flows arbeiten mit denselben Kontakten und Leads. Jeder Weg führt zum gespeicherten Originalvorgang.", "Campaigns, mailings, property websites and flows use the same contacts and leads. Every path opens the saved original record.")}</p>
      <div className="mt-5 flex flex-wrap gap-2">{["AT", "DE", "ES", "IE"].map(code => <span key={code} className="rounded-full border border-white/25 px-3 py-1 text-xs">{code}</span>)}</div>
    </div>
    <div className="flex flex-wrap items-end gap-4 rounded-xl border border-stone-200 bg-white p-4">
      <label className="grid min-w-48 flex-1 gap-1 text-sm font-semibold">{t("Gemeinsamer Projektbereich", "Shared project scope")}<select className="min-h-11 rounded-lg border border-stone-300 bg-white px-3" value={projectId ?? "all"} onChange={event => onProjectChange(event.target.value)}><option value="all">{t("Alle berechtigten Projekte", "All permitted projects")}</option>{projects.filter(project => project.workspaceId === workspaceId).map(project => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label>
      {visibleArea === "audiences" ? <label className="grid min-w-44 gap-1 text-sm font-semibold">{t("Kontaktland", "Contact country")}<select className="min-h-11 rounded-lg border border-stone-300 bg-white px-3" value={country ?? "all"} onChange={event => setCountry(event.target.value === "all" ? null : event.target.value as Country)}><option value="all">{t("Alle Länder", "All countries")}</option>{(["AT", "DE", "ES", "IE"] as const).map(code => <option key={code}>{code}</option>)}</select></label> : null}
      <button type="button" className="min-h-11 rounded-lg border border-stone-300 px-4 text-sm font-semibold" onClick={() => setRefresh(value => value + 1)}>{t("Status aktualisieren", "Refresh status")}</button>
    </div>
    <nav aria-label={t("Marketingbereiche", "Marketing areas")} className="flex gap-2 overflow-x-auto border-b border-stone-200 pb-3">{tabs.filter(tab => tab.allowed).map(tab => <button type="button" key={tab.id} aria-current={visibleArea === tab.id ? "page" : undefined} className={`min-h-11 shrink-0 rounded-lg px-4 text-sm font-semibold ${visibleArea === tab.id ? "bg-slate-950 text-white" : "bg-white text-stone-700 hover:bg-stone-100"}`} onClick={() => { setArea(tab.id); setRefresh(value => value + 1); }}>{tab.label}</button>)}</nav>
    {error ? <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm">{error}</p> : !current ? <p role="status">{t("Marketingstatus wird geladen …", "Loading marketing status …")}</p> : visibleArea === "overview" ? <>
      <div className="grid gap-3 sm:grid-cols-3">{[[t("Gespeicherte Mailings", "Saved mailings"), n(c?.mailings)], [t("Aktive Flows", "Active flows"), n(c?.activeFlows)], [t("Aktive Exposé-Sprachversionen", "Active property language versions"), n(c?.publications)]].map(([label, value]) => <div className="rounded-xl border border-stone-200 bg-white p-5" key={label}><p className="text-sm text-stone-600">{label}</p><p className="mt-2 text-3xl font-semibold">{value}</p></div>)}</div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{cards.filter(card => card.allowed).map(card => <article key={card.id} className="flex flex-col rounded-xl border border-stone-200 bg-white p-5"><span className="mb-4 self-start rounded-full bg-stone-100 px-3 py-1 text-xs font-semibold text-stone-700">{card.state}</span><h3 className="text-lg font-semibold">{card.title}</h3><p className="mt-2 flex-1 text-sm leading-6 text-stone-600">{card.description}</p><div className="mt-4 flex flex-wrap gap-2">{card.tags.map(tag => <span className="rounded-full border border-stone-200 px-2.5 py-1 text-xs text-stone-600" key={tag}>{tag}</span>)}</div><button type="button" className="mt-5 min-h-11 rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white" onClick={() => card.id === "properties" || card.id === "funnels" ? onOpenTool(card.id) : setArea(card.id)}>{card.action}</button></article>)}</div>
      <section className="rounded-xl border border-stone-200 bg-white p-5"><h3 className="text-lg font-semibold">{t("Jetzt prüfen", "Review now")}</h3>{current.review.length ? <ul className="mt-3 divide-y divide-stone-100">{current.review.map(item => <li key={item.key} className="flex flex-wrap items-center justify-between gap-3 py-3"><div><p className="font-semibold">{item.title}</p><p className="mt-1 text-sm text-stone-600">{reasons[item.reason]}</p></div><button type="button" className="min-h-11 rounded-lg border border-stone-300 px-4 text-sm font-semibold" onClick={() => onOpenSource(item.target)}>{t("Original öffnen", "Open original")}</button></li>)}</ul> : <p className="mt-3 text-sm text-stone-600">{t("In deinem aktuellen Projektbereich sind keine offenen Marketingprüfungen gespeichert.", "No open marketing reviews are recorded in your current project scope.")}</p>}{current.reviewLimited ? <p className="mt-3 text-xs text-stone-500">{t("Bis zu 20 offene Vorgänge werden gezeigt. Im Originalbereich stehen weitere Vorgänge bereit.", "Showing up to 20 open records. Further records are available in each original area.")}</p> : null}</section>
      <div className="grid gap-4 lg:grid-cols-2"><section className="rounded-xl border border-stone-200 bg-white p-5"><h3 className="font-semibold">{t("Leadquellen & persönliche E-Mails", "Lead sources & personal email")}</h3><p className="mt-2 text-sm leading-6 text-stone-600">{t("Landingpages und Formulare liefern Anfragen in die Lead-Zentrale. Google- und Outlook-Mails werden unter Kommunikation persönlich verbunden und geprüft.", "Landing pages and forms send enquiries to the lead inbox. Connect and review Google and Outlook email personally under Communication.")}</p><div className="mt-4 flex flex-wrap gap-2">{current.modules.funnels ? <><button className="min-h-11 rounded-lg border px-3 text-sm" type="button" onClick={() => onOpenTool("funnels")}>{t("Landingpages", "Landing pages")}</button><button className="min-h-11 rounded-lg border px-3 text-sm" type="button" onClick={() => onOpenTool("forms")}>{t("Formulare", "Forms")}</button></> : null}{current.modules.communication ? <button className="min-h-11 rounded-lg border px-3 text-sm" type="button" onClick={() => onOpenTool("communication")}>{t("Mein Postfach", "My mailbox")}</button> : null}</div></section><section className="rounded-xl border border-stone-200 bg-white p-5"><h3 className="font-semibold">{t("Versand & Anzeigenanschlüsse", "Sending & advertising connections")}</h3><p className="mt-2 text-sm leading-6 text-stone-600">{current.newsletterProviderConfigured ? t("Der Mailinganbieter ist eingerichtet. Empfänger, aktuelle Revision und Versandfreigabe werden pro Mailing geprüft.", "The mailing provider is configured. Recipients, current revision and send approval are checked for each mailing.") : t("Der Mailinganbieter ist noch nicht eingerichtet. Entwürfe und Zielgruppen können bereits vorbereitet werden.", "The mailing provider is not yet configured. Drafts and audiences can already be prepared.")}</p><p className="mt-3 text-sm leading-6 text-stone-600">{t("Direkter Meta-/Google-Anzeigenkauf benötigt einen eingerichteten Geschäftskontoanschluss, Budget und eine konkrete Freigabe. Kosten und Werbewirkung werden erst mit belegten Anbieterdaten ausgewiesen.", "Direct Meta/Google ad buying requires a configured business account connection, budget and explicit approval. Costs and advertising results appear only with verified provider data.")}</p></section></div>
      {current.modules.reports ? <button type="button" className="min-h-11 rounded-lg border border-stone-300 bg-white px-5 text-sm font-semibold" onClick={() => setArea("reports")}>{t("Quellen & Ergebnisse auswerten", "Review sources & results")}</button> : null}
      <p className="text-xs text-stone-500">{t("Gespeicherter Stand: ", "Recorded as of: ")}{new Date(current.asOf).toLocaleString(de ? "de-AT" : "en-IE")}. {t("Kennzahlen folgen deiner aktuellen Berechtigung. Persönliche Postfachinhalte gehören nicht zu dieser Teamübersicht.", "Metrics follow your current access. Personal mailbox content is outside this team overview.")}</p>
    </> : <div key={`${visibleArea}:${projectId ?? "all"}`}>{renderArea(visibleArea, country)}</div>}
  </section>;
}
