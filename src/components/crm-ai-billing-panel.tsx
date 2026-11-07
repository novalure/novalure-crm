"use client";

import { useEffect, useRef, useState } from "react";
import { AI_CATALOG_VERSION, AI_PLAN_CATALOG, AI_TOPUP_CATALOG } from "@/lib/ai-billing/catalog";
import type { AiCreditSnapshot } from "@/lib/ai-billing/repository";
import { csrfFetch } from "@/lib/security/csrf-client";

type BillingLanguage = "de" | "en" | "es";
type WebsiteService = "website_creation" | "hosting" | "maintenance" | "content_updates";
const websiteServices: WebsiteService[] = ["website_creation", "hosting", "maintenance", "content_updates"];
const copy = {
  de: {
    calendarNote: "Das Monatskontingent erneuert sich zum Kalendermonat (UTC). Den ersten Abrechnungszeitraum bestätigen wir mit Ihrem Angebot.",
    paidUntil: "KI-Zusatzpaket bestätigt bis", cancellationEnds: "Ihr KI-Zusatzpaket endet am", cancellationAfter: "Danach stehen Ihrem Unternehmen wieder 1.000 Basis-Credits je Kalendermonat zur Verfügung.",
    navigation: "Tarif & Zusatzleistungen", title: "Tarif, KI & Website", description: "Ihr gemeinsames KI-Kontingent, Zusatzpakete und Leistungen für Ihr Unternehmen.",
    loading: "Ihr Tarif und Verbrauch werden geladen …", unavailable: "Tarif und Verbrauch können gerade nicht geladen werden. Bitte versuchen Sie es erneut.", retry: "Erneut laden", refresh: "Aktualisieren",
    quota: "KI-Guthaben Ihres Unternehmens", available: "Verfügbare Credits", monthly: "Monatliches Kontingent", remaining: "Monatlich noch verfügbar", used: "Diesen Monat verbraucht", reserved: "Für laufende Aufträge reserviert", topup: "Zusatzguthaben verfügbar", resets: "Neues monatliches Kontingent ab", shared: "Alle Mitarbeiter teilen sich dieses Kontingent. Ein KI-Auftrag kann je nach Umfang mehrere Credits benötigen.", held: "Einige KI-Aufträge werden noch verarbeitet. Die dafür reservierten Credits sind bereits vom verfügbaren Guthaben abgezogen.",
    current: "Aktuelles Paket", included: "KI inklusive", plus: "KI Plus", pro: "KI Pro", includedPrice: "Im CRM-Tarif enthalten", extra: "netto zusätzlich pro Monat", creditsMonth: "Credits pro Monat insgesamt", base: "CRM-Grundtarif: 99 € netto pro Monat für bis zu 10 Nutzer, zuzüglich 1 € je aktivem Objekt. KI Plus und KI Pro sind optionale Zusatzpakete; die ausgewiesenen Kontingente enthalten die 1.000 Basis-Credits.",
    provisional: "Preisvorschlag", provisionalHint: "Die Zusatzpreise sind vorläufige Vorschläge. Ihre Anfrage wird geprüft und die Konditionen werden vor einer Freigabe bestätigt.", select: "Paket anfragen", includedHint: "Das kleine Basiskontingent steht dem gesamten Unternehmen gemeinsam zur Verfügung.", readOnly: "Ihr Team kann den Verbrauch einsehen. KI-Pakete und Zusatzguthaben kann die für Ihren Tarif verantwortliche Person anfragen.",
    packs: "Zusatzguthaben", packsHint: "Einmalige Guthabenpakete ohne Ablaufdatum. Sie ergänzen das monatliche Kontingent nach bestätigter Freigabe.", once: "netto einmalig", credits: "Credits", requestPack: "Guthaben anfragen", exhausted: "Das verfügbare KI-Guthaben ist aufgebraucht. Neue KI-Aufträge können nach der nächsten monatlichen Erneuerung oder einer bestätigten Guthabenfreigabe starten.",
    confirm: "Anfrage prüfen", confirmHint: "Sie senden eine Buchungsanfrage zu einem vorläufigen Preis. Es erfolgt keine automatische Abbuchung. Das Paket oder Guthaben wird erst nach Prüfung und bestätigter Freigabe aktiv.", confirmWebsite: "Sie senden eine unverbindliche Anfrage für ein individuelles Angebot. Den Umfang und den Sonderpreis stimmen wir mit Ihnen ab.", send: "Anfrage senden", sending: "Wird gesendet …", cancel: "Zurück", saved: "Ihre Anfrage wurde gespeichert und wird geprüft. Eine automatische Abbuchung erfolgt nicht.", failed: "Die Anfrage konnte nicht bestätigt werden. Versuchen Sie es erneut; dieselbe Anfrage wird dabei nicht doppelt angelegt.", changed: "Die Konditionen haben sich geändert. Bitte laden Sie die Seite neu und prüfen Sie die aktuellen Angaben.", forbidden: "Sie können diese Leistung nicht anfragen. Bitte wenden Sie sich an die für Ihren Tarif verantwortliche Person.",
    requests: "Ihre Anfragen", pending: "In Prüfung", fulfilled: "Bearbeitet", cancelled: "Zurückgezogen", date: "Angefragt am", quote: "Auf Anfrage", website: "Makler-Website & Hosting", websiteHint: "Sonderpreis für CRM-Kunden auf Anfrage. Wir erstellen Ihre Makler-Website und kümmern uns auf Wunsch um Hosting, Betreuung und Inhaltsänderungen.", websiteCreation: "Website erstellen & kaufen", hosting: "Hosting", maintenance: "Betreuung & Pflege", contentUpdates: "Inhalte aktualisieren", notes: "Ihre Wünsche (optional)", notesHint: "Zum Beispiel eine bestehende Website, gewünschte Funktionen oder der geplante Start.", websiteButton: "Sonderpreis anfragen", selectService: "Wählen Sie mindestens eine Leistung.", websiteUnavailable: "Website-Anfragen sind für diesen Zugang derzeit nicht verfügbar.",
  },
  en: {
    calendarNote: "The monthly allowance renews at the start of each calendar month (UTC). We will confirm your first billing period with your offer.",
    paidUntil: "AI add-on confirmed until", cancellationEnds: "Your AI add-on ends on", cancellationAfter: "Your company will then return to 1,000 base credits per calendar month.",
    navigation: "Plan & additional services", title: "Plan, AI & website", description: "Shared AI credits, additional packages and services for your company.",
    loading: "Loading your plan and usage …", unavailable: "Your plan and usage could not be loaded. Please try again.", retry: "Try again", refresh: "Refresh",
    quota: "Your company's AI credits", available: "Available credits", monthly: "Monthly allowance", remaining: "Monthly credits remaining", used: "Used this month", reserved: "Reserved for ongoing requests", topup: "Additional credits available", resets: "Monthly allowance renews on", shared: "All team members share these credits. An AI request can use several credits depending on its scope.", held: "Some AI requests are still processing. Their reserved credits have already been deducted from the available balance.",
    current: "Current package", included: "AI included", plus: "AI Plus", pro: "AI Pro", includedPrice: "Included in your CRM plan", extra: "net extra per month", creditsMonth: "total credits per month", base: "CRM base plan: €99 net per month for up to 10 users, plus €1 per active property. AI Plus and AI Pro are optional add-ons; the allowances shown include the 1,000 base credits.",
    provisional: "Proposed price", provisionalHint: "Add-on prices are provisional proposals. Your request will be reviewed and the terms confirmed before approval.", select: "Request package", includedHint: "The small base allowance is shared by your entire company.", readOnly: "Your team can view usage. The person responsible for your plan can request AI packages and additional credits.",
    packs: "Additional credits", packsHint: "One-off credit packs that do not expire. They supplement the monthly allowance after confirmed approval.", once: "net, one-off", credits: "credits", requestPack: "Request credits", exhausted: "Your available AI credits have been used up. New AI requests can start after the next monthly renewal or confirmed credit approval.",
    confirm: "Review request", confirmHint: "You are submitting a booking request at a provisional price. There is no automatic charge. The package or credits become active after review and confirmed approval.", confirmWebsite: "You are requesting an individual, non-binding quote. We will agree the scope and special price with you.", send: "Send request", sending: "Sending …", cancel: "Back", saved: "Your request has been saved for review. There is no automatic charge.", failed: "Your request could not be confirmed. Try again; the same request will not be created twice.", changed: "The terms have changed. Please refresh the page and review the current details.", forbidden: "You cannot request this service. Please contact the person responsible for your plan.",
    requests: "Your requests", pending: "Under review", fulfilled: "Processed", cancelled: "Withdrawn", date: "Requested on", quote: "On request", website: "Estate agency website & hosting", websiteHint: "Special price for CRM customers on request. We build your agency website and can take care of hosting, maintenance and content updates.", websiteCreation: "Website creation & purchase", hosting: "Hosting", maintenance: "Care & maintenance", contentUpdates: "Content updates", notes: "Your requirements (optional)", notesHint: "For example, an existing website, features you need or your planned launch date.", websiteButton: "Request special price", selectService: "Choose at least one service.", websiteUnavailable: "Website requests are currently unavailable for this account.",
  },
  es: {
    calendarNote: "La asignación mensual se renueva al inicio de cada mes natural (UTC). Confirmaremos su primer periodo de facturación en la oferta.",
    paidUntil: "Complemento de IA confirmado hasta", cancellationEnds: "Su complemento de IA finaliza el", cancellationAfter: "Su empresa volverá a disponer de 1.000 créditos básicos por mes natural.",
    navigation: "Plan y servicios adicionales", title: "Plan, IA y web", description: "Créditos de IA compartidos, paquetes adicionales y servicios para su empresa.",
    loading: "Cargando su plan y consumo …", unavailable: "No se han podido cargar su plan y consumo. Inténtelo de nuevo.", retry: "Reintentar", refresh: "Actualizar",
    quota: "Créditos de IA de su empresa", available: "Créditos disponibles", monthly: "Asignación mensual", remaining: "Créditos mensuales restantes", used: "Consumidos este mes", reserved: "Reservados para solicitudes en curso", topup: "Créditos adicionales disponibles", resets: "La asignación mensual se renueva el", shared: "Todo el equipo comparte estos créditos. Una solicitud de IA puede consumir varios créditos según su alcance.", held: "Algunas solicitudes de IA siguen en curso. Sus créditos reservados ya se han descontado del saldo disponible.",
    current: "Paquete actual", included: "IA incluida", plus: "IA Plus", pro: "IA Pro", includedPrice: "Incluida en su plan CRM", extra: "netos adicionales al mes", creditsMonth: "créditos totales al mes", base: "Plan básico CRM: 99 € netos al mes para hasta 10 usuarios, más 1 € por inmueble activo. IA Plus e IA Pro son complementos opcionales; las asignaciones indicadas incluyen los 1.000 créditos básicos.",
    provisional: "Precio propuesto", provisionalHint: "Los precios adicionales son propuestas provisionales. Revisaremos su solicitud y confirmaremos las condiciones antes de aprobarla.", select: "Solicitar paquete", includedHint: "Toda la empresa comparte la pequeña asignación básica.", readOnly: "Su equipo puede consultar el consumo. La persona responsable de su plan puede solicitar paquetes de IA y créditos adicionales.",
    packs: "Créditos adicionales", packsHint: "Paquetes de pago único sin fecha de caducidad. Complementan la asignación mensual tras la aprobación confirmada.", once: "netos, pago único", credits: "créditos", requestPack: "Solicitar créditos", exhausted: "Se han agotado sus créditos de IA disponibles. Podrá iniciar nuevas solicitudes tras la próxima renovación mensual o una aprobación confirmada de créditos.",
    confirm: "Revisar solicitud", confirmHint: "Está enviando una solicitud de contratación con un precio provisional. No se realizará ningún cargo automático. El paquete o los créditos se activarán tras la revisión y aprobación confirmada.", confirmWebsite: "Está solicitando un presupuesto personalizado y sin compromiso. Acordaremos con usted el alcance y el precio especial.", send: "Enviar solicitud", sending: "Enviando …", cancel: "Volver", saved: "Su solicitud se ha guardado para su revisión. No se realizará ningún cargo automático.", failed: "No se ha podido confirmar su solicitud. Inténtelo de nuevo; no se duplicará la misma solicitud.", changed: "Las condiciones han cambiado. Actualice la página y revise la información actual.", forbidden: "No puede solicitar este servicio. Contacte con la persona responsable de su plan.",
    requests: "Sus solicitudes", pending: "En revisión", fulfilled: "Tramitada", cancelled: "Retirada", date: "Fecha de solicitud", quote: "A consultar", website: "Web inmobiliaria y hosting", websiteHint: "Precio especial para clientes CRM a consultar. Creamos su web inmobiliaria y, si lo desea, nos encargamos del hosting, el mantenimiento y las actualizaciones de contenido.", websiteCreation: "Creación y compra de web", hosting: "Hosting", maintenance: "Cuidado y mantenimiento", contentUpdates: "Actualización de contenidos", notes: "Sus necesidades (opcional)", notesHint: "Por ejemplo, su web actual, las funciones que necesita o la fecha de lanzamiento prevista.", websiteButton: "Solicitar precio especial", selectService: "Seleccione al menos un servicio.", websiteUnavailable: "Las solicitudes de web no están disponibles actualmente para esta cuenta.",
  },
} as const;

function getLanguage(value: string): BillingLanguage { return value === "de" || value === "es" ? value : "en"; }
export function getAiBillingNavigationLabel(language: string) { return copy[getLanguage(language)].navigation; }
type BookingChoice = { kind: "plan" | "topup" | "website"; itemId: string; requestId: string; requestedServices?: WebsiteService[]; notes?: string };
const cardClass = "min-w-0 rounded-xl border border-stone-200 bg-white p-5";
const buttonClass = "min-h-11 rounded-md border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50";

export function CrmAiBillingPanel({ workspaceId, language }: { workspaceId: string; language: string }) {
  const lang = getLanguage(language);
  const text = copy[lang];
  const locale = lang === "de" ? "de-AT" : lang === "es" ? "es-ES" : "en-IE";
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const money = (value: number) => new Intl.NumberFormat(locale, { style: "currency", currency: "EUR", maximumFractionDigits: value % 100 ? 2 : 0 }).format(value / 100);
  const date = (value: string) => Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(value)) : "—";
  const planLabel = (id: string) => id === "ai_plus" ? text.plus : id === "ai_pro" ? text.pro : text.included;
  const serviceLabel = (id: string) => id === "website_creation" ? text.websiteCreation : id === "hosting" ? text.hosting : id === "maintenance" ? text.maintenance : text.contentUpdates;
  const [data, setData] = useState<AiCreditSnapshot | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [revision, setRevision] = useState(0);
  const [choice, setChoice] = useState<BookingChoice | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<"saved" | "failed" | "changed" | "forbidden" | null>(null);
  const [services, setServices] = useState<WebsiteService[]>(["website_creation"]);
  const [notes, setNotes] = useState("");
  const confirmationHeading = useRef<HTMLHeadingElement>(null);
  const requestInFlight = useRef(false);
  const endpoint = `/api/crm/ai-billing?${new URLSearchParams({ workspaceId })}`;

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    async function load() {
      try {
        const response = await csrfFetch(endpoint, { cache: "no-store", signal: controller.signal });
        const payload = await response.json() as { data?: AiCreditSnapshot; persisted?: boolean };
        if (!response.ok || payload.persisted !== true || payload.data?.source !== "database" || payload.data.workspaceId !== workspaceId) throw new Error("unavailable");
        if (active) { setData(payload.data); setLoadState("ready"); }
      } catch { if (active) { setData(null); setLoadState("error"); } }
    }
    void load();
    return () => { active = false; controller.abort(); };
  }, [endpoint, revision, workspaceId]);

  useEffect(() => { if (choice) confirmationHeading.current?.focus(); }, [choice]);

  function choose(kind: BookingChoice["kind"], itemId: string) {
    setMessage(null);
    setChoice({ kind, itemId, requestId: crypto.randomUUID(), ...(kind === "website" ? { requestedServices: [...services], notes: notes.trim() } : {}) });
  }
  function reload() { setLoadState("loading"); setData(null); setChoice(null); setRevision(value => value + 1); }
  async function submitRequest() {
    if (!choice || requestInFlight.current || !data || (choice.kind === "website" ? !data.canRequestWebsite : !data.canBook)) return;
    requestInFlight.current = true;
    setBusy(true); setMessage(null);
    try {
      const response = await csrfFetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": choice.requestId }, body: JSON.stringify({ kind: choice.kind, itemId: choice.itemId, catalogVersion: AI_CATALOG_VERSION, ...(choice.kind === "website" ? { requestedServices: choice.requestedServices, notes: choice.notes } : {}) }) });
      const payload = await response.json() as { persisted?: boolean; code?: string };
      if (!response.ok || payload.persisted !== true) {
        setMessage(payload.code === "AI_CATALOG_CHANGED" ? "changed" : response.status === 403 ? "forbidden" : "failed");
        return;
      }
      setChoice(null); setMessage("saved"); setRevision(value => value + 1);
    } catch { setMessage("failed"); }
    finally { requestInFlight.current = false; setBusy(false); }
  }

  const selectedPlan = choice?.kind === "plan" ? AI_PLAN_CATALOG.find(item => item.id === choice.itemId) : undefined;
  const selectedTopup = choice?.kind === "topup" ? AI_TOPUP_CATALOG.find(item => item.id === choice.itemId) : undefined;

  return <section className="grid min-w-0 gap-4" aria-label={text.title} data-ai-billing-panel>
    <header className={cardClass}>
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-2xl font-semibold text-slate-950">{text.title}</h2><p className="mt-2 max-w-3xl text-sm leading-6 text-stone-600">{text.description}</p></div><button type="button" className={buttonClass} onClick={reload} disabled={busy || loadState === "loading"}>{text.refresh}</button></div>
    </header>
    {loadState === "loading" ? <p className={cardClass} role="status">{text.loading}</p> : loadState === "error" || !data ? <div className={cardClass} role="status"><p className="text-sm text-stone-700">{text.unavailable}</p><button type="button" className={`${buttonClass} mt-3`} onClick={reload}>{text.retry}</button></div> : <>
      <article className={cardClass}>
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-lg font-semibold text-slate-950">{text.quota}</h3><p className="mt-1 text-sm text-stone-600">{text.current}: {planLabel(data.planId)}</p></div><div className="rounded-lg bg-emerald-50 px-4 py-3 text-right"><p className="text-xs font-semibold text-emerald-800">{text.available}</p><p className="mt-1 text-3xl font-semibold text-emerald-950">{number(data.availableCredits)}</p></div></div>
        <dl className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{[[text.monthly, data.monthlyCredits], [text.remaining, data.monthlyRemaining], [text.used, data.usedCredits], [text.reserved, data.reservedCredits], [text.topup, data.topupRemaining]].map(([label, value]) => <div className="rounded-lg bg-stone-50 p-3" key={label}><dt className="text-xs text-stone-600">{label}</dt><dd className="mt-1 text-xl font-semibold text-slate-950">{number(Number(value))}</dd></div>)}</dl>
        <p className="mt-4 text-sm text-stone-700">{text.resets}: <strong>{date(data.periodEnd)}</strong></p><p className="mt-2 text-sm leading-6 text-stone-600">{text.shared}</p>
        <p className="mt-2 text-sm leading-6 text-stone-600">{text.calendarNote}</p>
        {data.planId !== "included" && data.paidThrough ? <p className={`mt-3 rounded-lg p-3 text-sm leading-6 ${data.cancelAtPeriodEnd ? "bg-amber-50 text-amber-950" : "bg-stone-50 text-stone-700"}`} role={data.cancelAtPeriodEnd ? "status" : undefined}>{data.cancelAtPeriodEnd ? `${text.cancellationEnds} ` : `${text.paidUntil}: `}<strong>{date(data.paidThrough)}</strong>.{data.cancelAtPeriodEnd ? ` ${text.cancellationAfter}` : ""}</p> : null}
        {data.reservedCredits > 0 ? <p className="mt-2 text-sm leading-6 text-stone-600">{text.held}</p> : null}
        {data.availableCredits === 0 ? <p className="mt-3 rounded-md bg-amber-50 p-3 text-sm leading-6 text-amber-950" role="status">{text.exhausted}</p> : null}
      </article>
      <div className="grid gap-4 lg:grid-cols-3">{AI_PLAN_CATALOG.map(plan => <article key={plan.id} className={`${cardClass} flex flex-col ${data.planId === plan.id ? "border-emerald-500" : ""}`}>
        <div className="flex flex-wrap items-start justify-between gap-2"><h3 className="text-lg font-semibold text-slate-950">{planLabel(plan.id)}</h3>{data.planId === plan.id ? <span className="rounded-full bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-800">{text.current}</span> : null}</div>
        <p className="mt-5 text-3xl font-semibold text-slate-950">{plan.id === "included" ? text.includedPrice : money(plan.priceCents)}</p>{plan.id !== "included" ? <><p className="mt-1 text-sm text-stone-600">{text.extra}</p><span className="mt-3 w-fit rounded-full bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-900">{text.provisional}</span></> : null}
        <p className="mt-5 text-lg font-semibold text-slate-900">{number(plan.monthlyCredits)} <span className="text-sm font-normal text-stone-600">{text.creditsMonth}</span></p>
        {plan.id === "included" ? <p className="mt-3 text-sm leading-6 text-stone-600">{text.includedHint}</p> : null}
        {data.canBook && plan.id !== data.planId ? <button type="button" className={`${buttonClass} mt-5 w-full`} disabled={busy} onClick={() => choose("plan", plan.id)}>{text.select}</button> : null}
      </article>)}</div>
      <p className="text-sm leading-6 text-stone-600">{text.base}</p><p className="text-sm leading-6 text-stone-600">{text.provisionalHint}</p>
      {!data.canBook ? <p className="rounded-lg bg-stone-100 p-4 text-sm leading-6 text-stone-700">{text.readOnly}</p> : null}
      <article className={cardClass}><h3 className="text-lg font-semibold text-slate-950">{text.packs}</h3><p className="mt-2 text-sm leading-6 text-stone-600">{text.packsHint}</p><div className="mt-4 grid gap-3 sm:grid-cols-2">{AI_TOPUP_CATALOG.map(pack => <div key={pack.id} className="rounded-lg border border-stone-200 p-4"><p className="text-xl font-semibold text-slate-950">{number(pack.credits)} {text.credits}</p><p className="mt-2 font-semibold text-slate-900">{money(pack.priceCents)} <span className="text-sm font-normal text-stone-600">{text.once}</span></p><p className="mt-2 text-xs font-semibold text-amber-900">{text.provisional}</p>{data.canBook ? <button type="button" className={`${buttonClass} mt-4`} disabled={busy} onClick={() => choose("topup", pack.id)}>{text.requestPack}</button> : null}</div>)}</div></article>
      <article className={cardClass}><div className="flex flex-wrap items-start justify-between gap-3"><h3 className="text-lg font-semibold text-slate-950">{text.website}</h3><span className="rounded-full bg-emerald-50 px-3 py-1 text-sm font-semibold text-emerald-900">{text.quote}</span></div><p className="mt-3 max-w-3xl text-sm leading-6 text-stone-600">{text.websiteHint}</p>
        {data.canRequestWebsite ? <><fieldset className="mt-4 grid gap-2 sm:grid-cols-2"><legend className="sr-only">{text.website}</legend>{websiteServices.map(service => <label key={service} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-stone-200 px-3 py-2 text-sm text-slate-900"><input className="h-4 w-4 accent-emerald-700" type="checkbox" checked={services.includes(service)} disabled={busy} onChange={event => setServices(current => event.target.checked ? [...current, service] : current.filter(value => value !== service))}/>{serviceLabel(service)}</label>)}</fieldset><label className="mt-4 grid gap-2 text-sm font-semibold text-slate-900">{text.notes}<textarea rows={3} maxLength={2000} value={notes} onChange={event => setNotes(event.target.value)} disabled={busy} placeholder={text.notesHint} className="rounded-lg border border-stone-300 p-3 font-normal outline-none focus:border-emerald-700"/></label><div className="mt-3 flex flex-wrap items-center justify-between gap-3"><button type="button" className={buttonClass} disabled={busy || !services.length} onClick={() => choose("website", "real_estate_website")}>{text.websiteButton}</button><span className="text-xs text-stone-500">{number(notes.length)} / 2.000</span></div>{!services.length ? <p className="mt-2 text-sm text-stone-600">{text.selectService}</p> : null}</> : <p className="mt-3 text-sm text-stone-600">{text.websiteUnavailable}</p>}
      </article>
      {choice ? <section className="rounded-xl border-2 border-emerald-700 bg-emerald-50 p-5" aria-labelledby="ai-billing-confirm-title"><h3 id="ai-billing-confirm-title" ref={confirmationHeading} tabIndex={-1} className="text-lg font-semibold text-slate-950 outline-none">{text.confirm}</h3><p className="mt-3 text-xl font-semibold text-slate-950">{choice.kind === "website" ? text.website : selectedPlan ? planLabel(selectedPlan.id) : selectedTopup ? `${number(selectedTopup.credits)} ${text.credits}` : ""}</p>
        {choice.kind === "website" ? <><p className="mt-2 font-semibold text-slate-900">{text.quote}</p><p className="mt-2 text-sm text-stone-700">{choice.requestedServices?.map(serviceLabel).join(" · ")}</p>{choice.notes ? <p className="mt-3 whitespace-pre-wrap break-words text-sm text-stone-700">{choice.notes}</p> : null}</> : <><p className="mt-2 text-lg font-semibold text-slate-900">{money(selectedPlan?.priceCents ?? selectedTopup?.priceCents ?? 0)} <span className="text-sm font-normal">{selectedPlan ? text.extra : text.once}</span></p>{selectedPlan ? <p className="mt-2 text-sm text-stone-700">{number(selectedPlan.monthlyCredits)} {text.creditsMonth}</p> : null}<p className="mt-2 text-sm font-semibold text-amber-900">{text.provisional}</p></>}
        <p className="mt-4 max-w-3xl text-sm leading-6 text-stone-700">{choice.kind === "website" ? text.confirmWebsite : text.confirmHint}</p><div className="mt-4 flex flex-wrap gap-3"><button type="button" className="min-h-11 rounded-md bg-emerald-800 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-900 disabled:opacity-50" disabled={busy} onClick={() => void submitRequest()}>{busy ? text.sending : text.send}</button><button type="button" className={buttonClass} disabled={busy} onClick={() => { setChoice(null); setMessage(null); }}>{text.cancel}</button></div>
      </section> : null}
      {message ? <p role={message === "saved" ? "status" : "alert"} className={`rounded-lg p-4 text-sm leading-6 ${message === "saved" ? "bg-emerald-50 text-emerald-950" : "bg-amber-50 text-amber-950"}`}>{text[message]}</p> : null}
      {data.bookings.length ? <article className={cardClass}><h3 className="text-lg font-semibold text-slate-950">{text.requests}</h3><ul className="mt-4 grid gap-3">{data.bookings.map(booking => <li key={booking.id} className="flex flex-wrap items-start justify-between gap-3 rounded-lg bg-stone-50 p-3"><div><p className="text-sm font-semibold text-slate-950">{booking.kind === "website" ? text.website : booking.kind === "plan" ? planLabel(booking.itemId) : `${number(AI_TOPUP_CATALOG.find(pack => pack.id === booking.itemId)?.credits ?? 0)} ${text.credits}`}</p><p className="mt-1 text-xs text-stone-600">{text.date}: {date(booking.createdAt)}</p><p className="mt-1 text-sm text-stone-700">{booking.amountCents === null ? text.quote : money(booking.amountCents)}</p></div><span className="rounded-full border border-stone-200 bg-white px-2 py-1 text-xs font-semibold text-stone-700">{booking.status === "fulfilled" ? text.fulfilled : booking.status === "cancelled" ? text.cancelled : text.pending}</span></li>)}</ul></article> : null}
    </>}
  </section>;
}
