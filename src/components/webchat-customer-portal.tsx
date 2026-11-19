"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { KnowledgeCommandCenter } from "@/components/knowledge-command-center";
import { CompanyProfileSettings } from "@/components/company-profile-settings";
import type { LanguageCode } from "@/lib/i18n";
import { websiteChatEmbedCode } from "@/lib/integrations/website-integration-copy";
import { csrfFetch } from "@/lib/security/csrf-client";
import type { WebchatCustomerPortalSnapshot, WebchatPortalConversation, WebchatMessageCursor, WebchatPortalMessage } from "@/lib/webchat-customer-portal";
import { formatWebchatMoney } from "@/lib/webchat-product/presentation";
import { createDefaultCrmScope, serializeCrmScopeUrl } from "@/lib/crm-scope";
import type { WorkspaceProductContext } from "@/lib/product-model";

type View = "setup" | "conversations" | "leads" | "usage" | "team";
type SetupTab = "sources" | "assistants" | "websites";
type PendingOrder = { requestId: string; offerReference: string; expectedOfferRevision: number };
const button = "inline-flex min-h-11 items-center justify-center rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:opacity-50";
const card = "rounded-2xl border border-stone-200 bg-white p-5 shadow-sm";

function PortalConversation({ conversation, language, scoped }: { conversation: WebchatPortalConversation; language: LanguageCode; scoped: (path: string) => string }) {
  const de = language === "de";
  const [messages, setMessages] = useState(conversation.messages);
  const [hasOlder, setHasOlder] = useState(conversation.hasOlderMessages);
  const [cursor, setCursor] = useState(conversation.messageCursor);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function older() {
    if (busy || !cursor) return;
    setBusy(true); setError("");
    try {
      const query = new URLSearchParams({ conversationId: conversation.id, before: cursor.createdAt, beforeId: cursor.id });
      const response = await csrfFetch(`${scoped("/api/webchat/conversations")}&${query}`, { cache: "no-store" });
      const body = await response.json() as { conversationId: string; messages: WebchatPortalMessage[]; hasOlder: boolean; nextCursor: WebchatMessageCursor | null; error?: string };
      if (!response.ok || body.conversationId !== conversation.id || !Array.isArray(body.messages)) throw new Error(body.error || (de ? "Frühere Nachrichten sind derzeit nicht verfügbar." : "Earlier messages are currently unavailable."));
      setMessages(current => [...body.messages.filter(message => !current.some(item => item.id === message.id)), ...current]);
      setHasOlder(body.hasOlder); setCursor(body.nextCursor);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unavailable"); }
    finally { setBusy(false); }
  }
  return <article className={card}>
    <div className="flex flex-wrap justify-between gap-2"><h3 className="font-semibold">{new Date(conversation.updatedAt).toLocaleString(language)}</h3><span className="text-xs text-stone-600">{conversation.synthetic ? de ? "Synthetischer Test" : "Synthetic test" : conversation.status}</span></div>
    <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-stone-500">{conversation.summaryKind === "extractive" ? de ? "Gespeicherter Kurzüberblick" : "Saved overview" : de ? "Nachrichtenvorschau" : "Message preview"}</p>
    <p className="mt-2 whitespace-pre-wrap break-words text-sm">{conversation.summary || (de ? "Noch keine Nachricht." : "No messages yet.")}</p>
    <details className="mt-4"><summary className="min-h-11 cursor-pointer text-sm font-semibold">{de ? "Nachrichten öffnen" : "Open messages"}</summary>
      <p className="my-2 text-xs text-stone-600">{de ? `${messages.length} Nachrichten geladen${hasOlder ? " · frühere verfügbar" : " · Gespräch vollständig"}` : `${messages.length} messages loaded${hasOlder ? " · earlier messages available" : " · complete conversation"}`}</p>
      {hasOlder ? <button className={button} disabled={busy} onClick={() => void older()} type="button">{de ? "Frühere Nachrichten laden" : "Load earlier messages"}</button> : null}
      {error ? <p className="my-2 text-sm text-red-900" role="alert">{error}</p> : null}
      <ol className="mt-2 grid gap-3">{messages.map(message => <li className="rounded-lg bg-stone-50 p-3" key={message.id}><p className="text-xs font-semibold text-stone-500">{message.role === "visitor" ? de ? "Besucher" : "Visitor" : de ? "Assistent" : "Assistant"}</p><p className="mt-1 whitespace-pre-wrap break-words text-sm">{message.content}</p></li>)}</ol>
    </details>
  </article>;
}

function storedOrder(key: string): PendingOrder | null {
  if (typeof window === "undefined") return null;
  try {
    const value = JSON.parse(window.sessionStorage.getItem(key) ?? "null") as PendingOrder | null;
    return value && /^[0-9a-f-]{36}$/iu.test(value.requestId) && typeof value.offerReference === "string"
      && Number.isSafeInteger(value.expectedOfferRevision) && value.expectedOfferRevision > 0 ? value : null;
  } catch { return null; }
}

export function WebchatCustomerPortal(props: { language: LanguageCode; workspaceId: string; workspaceContext?: WorkspaceProductContext }) {
  return <PortalContent key={props.workspaceId} {...props} />;
}

function PortalContent({ language, workspaceId, workspaceContext }: { language: LanguageCode; workspaceId: string; workspaceContext?: WorkspaceProductContext }) {
  const de = language === "de";
  const [snapshot, setSnapshot] = useState<WebchatCustomerPortalSnapshot | null>(null);
  const [view, setView] = useState<View>("setup");
  const [setupTab, setSetupTab] = useState<SetupTab | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [offerReference, setOfferReference] = useState("");
  const orderKey = `novalure.webchat.topup.v1:${workspaceId}`;
  const [pending, setPending] = useState<PendingOrder | null>(() => storedOrder(orderKey));
  const scoped = useCallback((path: string) => `${path}?${new URLSearchParams({ workspaceId })}`, [workspaceId]);
  const crmHref = (hash = "") => serializeCrmScopeUrl(`/${hash}`, createDefaultCrmScope(workspaceId));
  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await csrfFetch(scoped("/api/webchat/portal"), { cache: "no-store", signal });
    const body = await response.json() as WebchatCustomerPortalSnapshot & { error?: string };
    if (!response.ok || body.workspace?.id !== workspaceId) throw new Error(body.error || (de ? "Der Kundenbereich ist derzeit nicht verfügbar." : "The customer portal is currently unavailable."));
    return body;
  }, [de, scoped, workspaceId]);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).then(body => { if (!controller.signal.aborted) setSnapshot(body); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Unavailable"); });
    return () => controller.abort();
  }, [load]);
  async function refresh() {
    setBusy(true); setError("");
    try { setSnapshot(await load()); } catch (cause) { setError(cause instanceof Error ? cause.message : "Unavailable"); }
    finally { setBusy(false); }
  }
  async function olderConversations() {
    const cursor = snapshot?.conversationPage.nextCursor;
    if (!cursor || busy) return;
    setBusy(true); setError("");
    try {
      const query = new URLSearchParams({ before: cursor.updatedAt, beforeId: cursor.id });
      const response = await csrfFetch(`${scoped("/api/webchat/portal")}&${query}`, { cache: "no-store" });
      const body = await response.json() as WebchatCustomerPortalSnapshot & { error?: string };
      if (!response.ok || body.workspace?.id !== workspaceId) throw new Error(body.error || (de ? "Frühere Gespräche sind derzeit nicht verfügbar." : "Earlier conversations are currently unavailable."));
      setSnapshot(current => current ? { ...current, conversations: [...current.conversations, ...body.conversations.filter(conversation => !current.conversations.some(item => item.id === conversation.id))], conversationPage: body.conversationPage } : body);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unavailable"); }
    finally { setBusy(false); }
  }
  async function requestTopup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || !snapshot?.permissions.canManage) return;
    const offer = snapshot.usage?.offers.find(item => `${item.reference}:${item.revision}` === offerReference);
    const operation = pending ?? (offer ? { requestId: crypto.randomUUID(), offerReference: offer.reference, expectedOfferRevision: offer.revision } : null);
    if (!operation) return;
    setBusy(true); setError(""); setNotice("");
    try {
      // Save the exact operation before sending. A lost response cannot silently
      // create a second order; the same request and catalog revision are retried.
      window.sessionStorage.setItem(orderKey, JSON.stringify(operation)); setPending(operation);
      const response = await csrfFetch(scoped("/api/webchat/orders"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(operation) });
      const body = await response.json() as { order?: { id: string }; error?: string; code?: string };
      if (!response.ok || !body.order?.id) {
        // These closed failures happen before order creation. Unknown outcomes,
        // transport failures and idempotency conflicts retain the operation.
        if (["OFFER_UNAVAILABLE", "VALIDATION_ERROR", "VERSION_REQUIRED"].includes(body.code ?? "")) {
          window.sessionStorage.removeItem(orderKey); setPending(null);
        }
        throw new Error(body.error || (de ? "Bestellung konnte nicht bestätigt werden. Derselbe Vorgang bleibt gespeichert." : "The order could not be confirmed. The same operation is retained."));
      }
      window.sessionStorage.removeItem(orderKey); setPending(null); setOfferReference("");
      setNotice(de ? "Testbestellung gespeichert. Das Kontingent wird erst nach bestätigtem Test-Zahlungsereignis freigegeben." : "Test order saved. Allowance is released only after a confirmed test payment event.");
      setSnapshot(await load());
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unavailable"); }
    finally { setBusy(false); }
  }
  const links: { id: View; label: string }[] = [
    { id: "setup", label: de ? "Einrichtung" : "Setup" }, { id: "conversations", label: de ? "Gespräche" : "Conversations" },
    { id: "leads", label: "Leads" }, { id: "usage", label: de ? "Nutzung & Kontingent" : "Usage & allowance" }, { id: "team", label: "Team" },
  ];
  const usage = snapshot?.usage;
  const money = (amountMinor: string, currency: string) => formatWebchatMoney(amountMinor, currency, language);
  return <main className="min-h-screen bg-stone-50 px-4 py-6 text-slate-950 sm:px-8">
    <div className="mx-auto grid max-w-6xl gap-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div><Link className="text-sm font-semibold text-emerald-800 underline" href={crmHref()}>← {de ? "Arbeitsbereich" : "Workspace"}</Link><h1 className="mt-3 text-3xl font-semibold">{de ? "Ihr Webchat" : "Your webchat"}</h1><p className="mt-2 text-stone-600">{snapshot?.workspace.name ?? (de ? "Kundenbereich wird geladen…" : "Loading customer portal…")}</p></div>
        <button className={button} disabled={busy} onClick={() => void refresh()} type="button">{de ? "Aktualisieren" : "Refresh"}</button>
      </header>
      <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">{de ? "Isolierter Testbetrieb. Zukäufe werden als Testbestellungen vorbereitet." : "Isolated test mode. Top-ups are prepared as test orders."}</p>
      <nav aria-label={de ? "Webchat-Kundenbereich" : "Webchat customer portal"} className="flex flex-wrap gap-2">{links.map(link => <button aria-current={view === link.id ? "page" : undefined} className={`${button} ${view === link.id ? "border-emerald-800 bg-emerald-50" : ""}`} key={link.id} onClick={() => setView(link.id)} type="button">{link.label}</button>)}</nav>
      {error ? <p className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-900" role="alert">{error}</p> : null}
      {notice ? <p className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-emerald-950" role="status">{notice}</p> : null}
      {snapshot && view === "setup" ? <section aria-labelledby="webchat-setup" className="grid gap-5">
        <div className={card}><h2 id="webchat-setup" className="text-xl font-semibold">{de ? "Schritt für Schritt zum Testchat" : "Set up your test chat"}</h2><p className="mt-2 text-sm leading-6 text-stone-600">{de ? "Übernehmen Sie die Website-Inhalte, prüfen und veröffentlichen Sie das Wissen, ordnen Sie es dem Assistenten zu und übernehmen Sie den Einbettungscode." : "Import your website content, review and publish knowledge, assign it to your assistant and copy the embed code."}</p>
          <ol className="mt-5 grid gap-3 sm:grid-cols-2">{([
            { label: de ? "Website verbinden" : "Connect website", done: snapshot.setup.website, tab: "websites" as const },
            { label: de ? "Wissen prüfen und veröffentlichen" : "Review and publish knowledge", done: snapshot.setup.knowledge, tab: "sources" as const },
            { label: de ? "Wissen dem Assistenten zuordnen" : "Assign knowledge to assistant", done: snapshot.setup.assistant, tab: "assistants" as const },
            { label: de ? "Einbettung vorbereiten" : "Prepare embedding", done: snapshot.setup.embedding, tab: "websites" as const },
          ]).map((step, index) => <li className="rounded-lg border border-stone-200 p-3" key={step.label}><span className="text-sm text-stone-600">{index + 1} · {step.done ? de ? "Vorbereitet" : "Prepared" : de ? "Offen" : "Pending"}</span><p className="mt-1 font-semibold">{step.label}</p>{snapshot.permissions.canManage ? <button className={`${button} mt-3`} onClick={() => setSetupTab(step.tab)} type="button">{de ? "Öffnen" : "Open"}</button> : null}</li>)}</ol>
          <p className="mt-4 text-xs leading-5 text-stone-600">{de ? "„Einbettung vorbereitet“ bedeutet, dass gültiges Wissen und eine Testverbindung vorliegen. Die Installation auf der Website wird dadurch noch nicht als geprüft markiert." : "Prepared embedding means approved knowledge and a test connection are available. Installation on the website still needs checking."}</p>
        </div>
        {setupTab && snapshot.permissions.canManage ? <div className={card}><KnowledgeCommandCenter key={setupTab} initialTab={setupTab} language={language} workspaceId={workspaceId} workspaceName={snapshot.workspace.name} /></div> : null}
        {snapshot.integrations.filter(item => item.readiness.ready && item.mode === "training" && item.status === "test").map(item => <div className={card} key={item.id}><h3 className="font-semibold">{de ? "Einbettung für Ihre Testwebsite" : "Embed in your test website"}</h3><p className="mt-2 break-words text-sm text-stone-600">{item.allowedOrigins.join(", ")}</p><textarea aria-label={de ? "Einbettungscode" : "Embed code"} className="mt-3 min-h-24 w-full rounded-lg border border-stone-300 bg-stone-50 p-3 font-mono text-xs" readOnly value={websiteChatEmbedCode(item.publicSiteKey)} /></div>)}
      </section> : null}
      {snapshot && view === "conversations" ? <section aria-labelledby="webchat-conversations" className="grid gap-3">
        <h2 id="webchat-conversations" className="text-xl font-semibold">{de ? "Ihre Gespräche" : "Your conversations"}</h2>
        <p className="text-sm text-stone-600">{de ? `${snapshot.conversations.length} Gespräche geladen. Frühere Gespräche und Nachrichten können Sie nachladen. Es werden keine Daten gelöscht.` : `${snapshot.conversations.length} conversations loaded. Load earlier conversations and messages as needed. No data is deleted.`}</p>
        {snapshot.conversations.length ? snapshot.conversations.map(conversation => <PortalConversation key={`${conversation.id}:${conversation.updatedAt}`} conversation={conversation} language={language} scoped={scoped} />) : <p className={card}>{de ? "Hier erscheinen Ihre Website-Gespräche nach dem ersten Test." : "Your website conversations appear here after the first test."}</p>}
        {snapshot.conversationPage.hasOlder ? <button className={button} disabled={busy} onClick={() => void olderConversations()} type="button">{de ? "Frühere Gespräche laden" : "Load earlier conversations"}</button> : null}
      </section> : null}
      {snapshot && view === "leads" ? <section aria-labelledby="webchat-leads" className="grid gap-3"><h2 id="webchat-leads" className="text-xl font-semibold">{de ? "Ihre Website-Leads" : "Your website leads"}</h2>{snapshot.leads.length ? snapshot.leads.map(lead => <article className={card} key={lead.id}><h3 className="font-semibold">{lead.name}</h3><p className="mt-2 text-sm text-stone-600">{lead.status} · {lead.source}</p></article>) : <p className={card}>{de ? "Noch keine Website-Leads vorhanden." : "No website leads yet."}</p>}<Link className={button} href={crmHref("#lead-inbox")}>{de ? "Lead-Verwaltung öffnen" : "Open lead management"}</Link></section> : null}
      {snapshot && view === "usage" ? <section aria-labelledby="webchat-usage" className="grid gap-4"><h2 id="webchat-usage" className="text-xl font-semibold">{de ? "Ein gemeinsames Kontingent für Ihr Kundenkonto" : "One shared allowance for your account"}</h2>{usage ? <>
        <div className={card}><p className="text-3xl font-semibold">{usage.usedUnits} / {usage.quotaUnits}</p><p className="mt-2 text-sm text-stone-600">{de ? `${usage.remainingUnits} verfügbar · ${usage.reservedUnits} laufend reserviert` : `${usage.remainingUnits} available · ${usage.reservedUnits} currently reserved`}</p><p className={`mt-4 font-semibold ${usage.paused ? "text-amber-900" : "text-emerald-800"}`}>{usage.paused ? de ? "Antworten pausiert: Kontingent ausgeschöpft oder Leistungsrecht nicht aktiv." : "Replies paused: allowance exhausted or entitlement inactive." : de ? "Testchat kann Antworten verarbeiten." : "Test chat can process replies."}</p></div>
        <div className={card}><h3 className="font-semibold">{de ? "Nutzung je Chatbot" : "Usage by chatbot"}</h3><ul className="mt-3 grid gap-2">{snapshot.bots.map(bot => { const item = usage.bots.find(row => row.botId === bot.id); return <li className="flex flex-wrap justify-between gap-2 border-b border-stone-100 py-2 text-sm" key={bot.id}><span>{bot.name}</span><span>{item?.usedUnits ?? 0} {de ? "genutzt" : "used"} · {item?.reservedUnits ?? 0} {de ? "reserviert" : "reserved"}</span></li>; })}</ul></div>
        {snapshot.permissions.canManage ? <form className={card} onSubmit={event => void requestTopup(event)}><h3 className="font-semibold">{de ? "Bewusstes Test-Zusatzkontingent" : "Deliberate test top-up"}</h3><p className="mt-2 text-sm leading-6 text-stone-600">{de ? "Wählen Sie eine hinterlegte Leistung. Diese Aktion speichert eine Bestellung; sie belastet kein Zahlungsmittel. Es gibt keinen automatischen Zukauf." : "Choose a configured offer. This action saves an order without charging a payment method. Top-ups are never automatic."}</p>{usage.offers.length || pending ? <><label className="mt-4 grid gap-2 text-sm font-semibold">{de ? "Hinterlegte Leistung" : "Configured offer"}<select className="min-h-11 rounded-lg border border-stone-300 bg-white px-3" disabled={busy || Boolean(pending)} onChange={event => setOfferReference(event.target.value)} required={!pending} value={pending ? `${pending.offerReference}:${pending.expectedOfferRevision}` : offerReference}><option value="">{de ? "Bitte bewusst auswählen" : "Choose an offer"}</option>{pending && !usage.offers.some(offer => offer.reference === pending.offerReference && offer.revision === pending.expectedOfferRevision) ? <option value={`${pending.offerReference}:${pending.expectedOfferRevision}`}>{pending.offerReference}</option> : null}{usage.offers.map(offer => <option key={`${offer.reference}:${offer.revision}`} value={`${offer.reference}:${offer.revision}`}>{offer.units} · {money(offer.amountMinor, offer.currency)} · {offer.contractReference}</option>)}</select></label><button className={`${button} mt-4`} disabled={busy || (!pending && !offerReference)} type="submit">{pending ? de ? "Dieselbe Testbestellung fortsetzen" : "Continue the same test order" : de ? "Test-Zusatzkontingent bestellen" : "Order test top-up"}</button></> : <p className="mt-3 text-sm text-amber-900">{de ? "Es ist noch keine Zusatzleistung mit freigegebenen Parametern hinterlegt." : "No top-up offer with approved parameters has been configured."}</p>}</form> : null}
        <div className={card}><h3 className="font-semibold">{de ? "Bestellungen" : "Orders"}</h3>{usage.orders.map(order => <p className="mt-3 text-sm" key={order.id}>{order.offerReference} · {order.units} · {order.status === "paid" ? de ? "Testzahlung bestätigt" : "Test payment confirmed" : order.status === "pending" ? de ? "Wartet auf Testzahlung" : "Awaiting test payment" : de ? "Storniert" : "Cancelled"}</p>)}{!usage.orders.length ? <p className="mt-3 text-sm text-stone-600">{de ? "Noch keine Bestellungen." : "No orders yet."}</p> : null}</div>
      </> : <p className={card}>{de ? "Für dieses Kundenkonto ist noch kein Webchat-Kontingent hinterlegt. Die Freischaltung braucht einen bestätigten Leistungs- und Zahlungsbezug." : "No webchat allowance has been configured for this account. Activation requires a confirmed entitlement and payment reference."}</p>}</section> : null}
      {snapshot && view === "team" ? <section aria-labelledby="webchat-team" className={card}><h2 id="webchat-team" className="text-xl font-semibold">{de ? "Kundenadministration & Mitarbeiter" : "Customer administration & staff"}</h2><p className="mt-2 text-sm leading-6 text-stone-600">{de ? "Zugänge verwenden die vorhandenen Rollen sowie den bestehenden Passwort- und MFA-Ablauf." : "Access uses existing roles and the current password and MFA flow."}</p>{snapshot.permissions.canManage ? <><ul className="mt-4 grid gap-3">{snapshot.team.map(person => <li className="rounded-lg bg-stone-50 p-3 text-sm" key={person.id}><p className="font-semibold">{person.name}</p><p className="mt-1 break-words text-stone-600">{person.email} · {person.productRole} · {person.status}</p></li>)}</ul>{workspaceContext?.workspaceId === workspaceId ? <CompanyProfileSettings context={workspaceContext} language={language} accessOnly /> : <p className="mt-4 text-sm">{de ? "Die Teamverwaltung ist für diesen Kundenbereich derzeit nicht verfügbar." : "Team management is currently unavailable for this customer portal."}</p>}</> : <p className="mt-4 text-sm">{de ? "Ihre Kundenadministration verwaltet Teamzugänge und Rollen." : "Your customer administrator manages team access and roles."}</p>}</section> : null}
    </div>
  </main>;
}
