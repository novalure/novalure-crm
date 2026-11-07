"use client";
import { useEffect, useRef, useState } from "react";
import { NewsletterCommandCenter, type DraftState } from "@/components/newsletter-command-center";
import { csrfFetch } from "@/lib/security/csrf-client";
import { useCrmTeam } from "@/lib/use-crm-team";
import {LegacyNewsletterMigration,NewsletterSchedulePanel} from '@/components/newsletter-schedule-panel';
import { equalNewsletterDrafts, normalizeNewsletterDraft } from "@/lib/newsletter-workspace";
import type { readNewsletterWorkspace, previewNewsletterRecipients } from "@/lib/db/newsletter-workspace-repository";
import {NewsletterMarketingTools} from '@/components/newsletter-marketing-tools';

type Data = Awaited<ReturnType<typeof readNewsletterWorkspace>>;
type Review = Awaited<ReturnType<typeof previewNewsletterRecipients>>;
type Props = { workspaceId: string; projectId?: string | null; language: "de" | "en"; focusCampaignId?:string;onChanged?: () => void | Promise<void> };
const reasons: Record<string, [string, string]> = { allowed_opt_in: ["Berechtigt", "Eligible"], missing_address: ["E-Mail fehlt oder ungültig", "Email missing or invalid"], newsletter_suppression: ["Sperrliste", "Suppression list"], opt_out: ["Abgemeldet", "Unsubscribed"], duplicate_email: ["Mehrdeutige E-Mail-Dublette", "Ambiguous duplicate email"], missing_opt_in: ["Keine bestätigte Newsletter-Einwilligung", "No confirmed newsletter consent"] };
const statusLabels: Record<string, [string, string]> = { pending: ["Ausstehend", "Pending"], claimed: ["In Bearbeitung oder Ergebnis ungeklärt", "Processing or result unknown"], accepted: ["Vom Versanddienst angenommen", "Accepted by provider"], failed: ["Abgelehnt", "Rejected"], uncertain: ["Ergebnis ungeklärt, Abgleich erforderlich", "Unknown result, reconciliation required"], suppressed: ["Vor Versand ausgeschlossen", "Excluded before sending"], cancelled: ["Durch neue Entwurfsfassung ersetzt", "Replaced by a new draft revision"] };
const providerLabels:Record<string,[string,string]>={sent:['Anbieter meldet Versand','Provider reports sent'],delivered:['Empfänger-Mailserver hat angenommen; kein Lesebeleg','Recipient mail server accepted; no reading evidence'],delayed:['Zustellung verzögert','Delivery delayed'],bounced:['Zustellung zurückgewiesen','Delivery rejected'],complained:['Spam-Beschwerde erhalten','Spam complaint received'],failed:['Anbieter meldet Versandfehler','Provider reports send failure'],suppressed:['Anbieter hat Versand gesperrt','Provider suppressed sending']};
export function ConnectedNewsletterCommandCenter(props: Props) { return <ConnectedMailings key={JSON.stringify([props.workspaceId, props.projectId,props.focusCampaignId])} {...props} />; }
function ConnectedMailings({ workspaceId, projectId, language, focusCampaignId,onChanged }: Props) {
  const de = language === "de", t = (german: string, english: string) => de ? german : english;
  const [data, setData] = useState<Data | null>(null), dataRef = useRef<Data | null>(null);
  const [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0), [editorKey, setEditorKey] = useState(0);
  const [name, setName] = useState(""), [audience, setAudience] = useState("Alle"), [targetProject, setTargetProject] = useState(projectId ?? "");
  const [contentLanguage, setContentLanguage] = useState<"de" | "en" | "es">(language);
  const [review, setReview] = useState<Review | null>(null), [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false);
  const [scheduleActive,setScheduleActive]=useState(false);
  const [editorFocus,setEditorFocus]=useState(focusCampaignId??'');
  const pending = useRef<{ body: string; key: string; correlation: string } | null>(null);
  const team = useCrmTeam(workspaceId, projectId);
  const query = new URLSearchParams({ workspaceId }); if (projectId) query.set("projectId", projectId);
  const endpoint = `/api/crm/newsletter?${query}`;
  async function reload() {
    const response = await fetch(endpoint, { cache: "no-store", credentials: "same-origin" });
    const result = await response.json() as Data;
    if (!response.ok || result.source !== "database" || result.workspaceId !== workspaceId || !Array.isArray(result.drafts)) throw new Error(t("Mailings sind derzeit nicht verfügbar.", "Mailings are currently unavailable."));
    dataRef.current = result; setData(result); setFailed(false); return result;
  }
  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => fetch(endpoint, { cache: "no-store", credentials: "same-origin", signal: controller.signal }))
      .then(async response => { const result = await response.json() as Data; if (!response.ok || result.source !== "database" || result.workspaceId !== workspaceId || !Array.isArray(result.drafts)) throw new Error(); if (!controller.signal.aborted) { dataRef.current = result; setData(result); setFailed(false); } })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [endpoint, workspaceId, attempt]);
  async function perform(body: Record<string, unknown>) {
    const encoded = JSON.stringify(body);
    if (pending.current && pending.current.body !== encoded) throw new Error(t("Bitte zuerst den ungeklärten Vorgang prüfen.", "Please reconcile the unknown operation first."));
    const operation = pending.current ?? { body: encoded, key: crypto.randomUUID(), correlation: crypto.randomUUID() };
    pending.current = operation;
    let response: Response;
    try { response = await csrfFetch(`/api/crm/newsletter?workspaceId=${encodeURIComponent(workspaceId)}`, { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": operation.key, "X-Correlation-Id": operation.correlation }, body: operation.body }); if (response.status >= 500) throw new Error(); }
    catch { setUncertain(true); throw new Error(t("Das Ergebnis ist noch ungeklärt. Bitte denselben Vorgang erneut prüfen.", "The result is still unknown. Please check the same operation again.")); }
    let result: { persisted?: boolean; error?: string; status?: string; email?: string };
    try { result = await response.json(); }
    catch { setUncertain(true); throw new Error(t("Die Antwort ist noch ungeklärt. Bitte den Vorgang erneut prüfen.", "The response is still unknown. Please check the operation again.")); }
    if (!response.ok) { pending.current = null; setUncertain(false); throw new Error(result.error || t("Mailingaktion abgelehnt.", "Mailing action rejected.")); }
    if (result.persisted !== true) { setUncertain(true); throw new Error(t("Die Speicherung wurde nicht bestätigt.", "Saving was not confirmed.")); }
    pending.current = null; setUncertain(false); return result;
  }
  async function save(campaignId: string, draft: DraftState) {
    const current = dataRef.current?.drafts.find(row => row.campaignId === campaignId);
    if (!current) throw new Error(t("Mailingentwurf ist nicht geladen.", "Mailing draft is not loaded."));
    await perform({ action: "save", campaignId, expectedRevision: current.revision, draft: normalizeNewsletterDraft(draft) });
    await reload();
  }
  async function loadReview(campaignId: string) {
    const url = new URLSearchParams({ workspaceId, campaignId });
    const response = await fetch(`/api/crm/newsletter?${url}`, { cache: "no-store", credentials: "same-origin" });
    const result = await response.json() as Review & { error?: string };
    if (!response.ok || result.campaignId !== campaignId || !Array.isArray(result.recipients)) throw new Error(result.error || t("Empfängervorschau ist nicht verfügbar.", "Recipient preview is unavailable."));
    setReview(result); return result;
  }
  async function openReview(campaignId: string, draft: DraftState) {
    const current = dataRef.current?.drafts.find(row => row.campaignId === campaignId);
    if (!current) throw new Error(t("Mailing ist nicht verfügbar.", "Mailing is unavailable."));
    if (!equalNewsletterDrafts(current.input, draft) || current.revision === 0) await save(campaignId, draft);
    await loadReview(campaignId);
    return t("Gespeicherte Version und Empfänger sind zur Prüfung geöffnet.", "The saved version and recipients are open for review.");
  }
  async function create() {
    if (busy || uncertain || !name.trim() || !targetProject) return;
    setBusy(true); setNotice("");
    try { await perform({ action: "create", projectId: targetProject, name: name.trim(), audience, language: contentLanguage }); await reload(); setEditorKey(value => value + 1); setName(""); setNotice(t("Mailingentwurf angelegt.", "Mailing draft created.")); }
    catch (error) { setNotice(error instanceof Error ? error.message : t("Anlage fehlgeschlagen.", "Creation failed.")); }
    finally { setBusy(false); }
  }
  async function reviewAction(action: "approve" | "send" | "test") {
    if (!review || busy || uncertain) return;
    setBusy(true); setNotice("");
    try { const result = await perform({ action, campaignId: review.campaignId, expectedRevision: review.revision }); await loadReview(review.campaignId); await reload(); setNotice(action === "test" ? `${t("Test an", "Test to")} ${result.email ?? ""}: ${statusLabels[result.status ?? "uncertain"]?.[de ? 0 : 1] ?? result.status}.` : action === "approve" ? t("Diese Version und ihre Empfänger sind freigegeben.", "This version and its recipients are approved.") : t("Versandergebnisse wurden gespeichert. Annahme und Zustellung sind unterschiedliche Zustände.", "Send results were saved. Provider acceptance and delivery are separate states.")); try { await onChanged?.(); } catch { /* The persisted result is already displayed. */ } }
    catch (error) { setNotice(error instanceof Error ? error.message : t("Vorgang fehlgeschlagen.", "Operation failed.")); }
    finally { setBusy(false); }
  }
  async function retryPending() {
    if (!pending.current || busy) return;
    setBusy(true);
    try { const body = JSON.parse(pending.current.body) as Record<string, unknown>; await perform(body); await reload(); if (typeof body.campaignId === "string" && review) await loadReview(body.campaignId); setNotice(t("Vorgang abgeglichen.", "Operation reconciled.")); }
    catch (error) { setNotice(error instanceof Error ? error.message : t("Ergebnis ungeklärt.", "Unknown result.")); }
    finally { setBusy(false); }
  }
  async function configure(body:Record<string,unknown>){if(busy||uncertain)return;setBusy(true);setNotice('');try{await perform(body);await reload();setEditorKey(n=>n+1);setNotice(t('Gespeicherte Marketingauswahl übernommen. Diese neue Fassung benötigt eine Freigabe.','Saved marketing selection applied. This new version requires approval.'));}catch(error){setNotice(error instanceof Error?error.message:'Auswahl konnte nicht gespeichert werden.');}finally{setBusy(false);}}
  if (!data) return <div className="rounded-lg border border-stone-200 bg-white p-5" role="status">{failed ? <>{t("Mailings konnten nicht geladen werden.", "Mailings could not be loaded.")} <button type="button" className="underline" onClick={() => setAttempt(value => value + 1)}>{t("Erneut versuchen", "Try again")}</button></> : t("Mailings werden geladen…", "Loading mailings…")}</div>;
  return <div className="space-y-4">
    {data.canApprove&&<LegacyNewsletterMigration workspaceId={workspaceId} onChanged={async()=>{await reload();await onChanged?.();}}/>}
    <div className="rounded-lg border border-stone-200 bg-white p-4"><h3 className="font-semibold">{t("Gespeicherte Mailings", "Saved mailings")}</h3><p className="mt-1 text-sm text-stone-600">{data.provider.configured ? t(`Versandabsender: ${data.provider.fromEmail}`, `Sending address: ${data.provider.fromEmail}`) : t("Entwürfe können gespeichert werden. Für den Versand einen Absender einrichten.", "Drafts can be saved. Configure a sending address before sending.")}</p>
      {data.canEdit && <div className="mt-3 grid gap-2 md:grid-cols-5"><input aria-label={t("Name des Mailings", "Mailing name")} className="rounded-md border border-stone-300 p-2" value={name} disabled={busy || uncertain} placeholder={t("Neues Mailing", "New mailing")} onChange={event => setName(event.target.value)} /><select aria-label={t("Projekt", "Project")} className="rounded-md border border-stone-300 p-2" value={targetProject} disabled={busy || uncertain} onChange={event => setTargetProject(event.target.value)}><option value="">{t("Projekt auswählen", "Select project")}</option>{data.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select><select aria-label={t("Zielgruppe", "Audience")} className="rounded-md border border-stone-300 p-2" value={audience} disabled={busy || uncertain} onChange={event => setAudience(event.target.value)}>{["Alle", "Käufer", "Verkäufer", "Investor", "Bauträger", "Makler"].map(value => <option key={value}>{value}</option>)}</select><select aria-label={t("Inhaltssprache", "Content language")} className="rounded-md border border-stone-300 p-2" value={contentLanguage} disabled={busy || uncertain} onChange={event => setContentLanguage(event.target.value as typeof contentLanguage)}><option value="de">Deutsch</option><option value="en">English</option><option value="es">Español</option></select><button type="button" className="min-h-11 rounded-md bg-slate-950 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={busy || uncertain || !name.trim() || !targetProject} onClick={() => void create()}>{t("Mailing anlegen", "Create mailing")}</button></div>}
      {notice && <p className="mt-3 text-sm" role="status">{notice}</p>}{uncertain && <button type="button" className="mt-2 min-h-11 rounded-md border border-amber-300 px-3 py-2 text-sm" disabled={busy} onClick={() => void retryPending()}>{t("Ergebnis erneut prüfen", "Check result again")}</button>}
    </div>
    <NewsletterMarketingTools data={data} campaignId={editorFocus||data.drafts[0]?.campaignId||''} workspaceId={workspaceId} disabled={busy||uncertain||!data.canEdit} onSelect={id=>{setEditorFocus(id);setEditorKey(n=>n+1);}} onConfigure={configure} onChanged={reload}/>
    <fieldset className="min-w-0" disabled={busy || uncertain || !data.canEdit}><NewsletterCommandCenter key={editorKey} focusCampaignId={editorFocus} automations={[]} campaigns={data.campaigns} consents={data.consents} contacts={data.contacts} deliverability={[]} language={language} leads={[]} projectLabel={data.projects.length === 1 ? data.projects[0].name : t("Alle freigegebenen Projekte", "All accessible projects")} projects={data.projects} relatedDataAvailable={data.canApprove} segments={data.segments} suppressions={data.suppressions} templates={data.templates.flatMap(template=>Object.entries(template.variants).map(([locale,variant])=>({id:template.id,workspaceId,name:`${template.name} · V${template.revision}`,category:'Projektupdate' as const,language:locale as 'de'|'en'|'es',status:'bereit' as const,subjectPattern:variant!.subject,previewPattern:variant!.previewText,blocks:variant!.contentBlocks.map(block=>block.type),personalizationFields:['contact.name','project.name','agent.name']})))} users={team.users} persistedDrafts={Object.fromEntries(data.drafts.map(draft => [draft.campaignId, draft.input]))} onSaveDraft={save} onReviewCampaign={openReview} /></fieldset>
    {review && <div className="fixed inset-0 z-[90] overflow-y-auto bg-slate-950/50 p-4"><section role="dialog" aria-modal="true" aria-label={t("Mailingfreigabe", "Mailing approval")} className="mx-auto my-8 max-w-5xl rounded-xl bg-white p-5"><div className="flex items-start justify-between gap-3"><div><h3 className="text-xl font-semibold">{t("Gespeicherte Mailingversion prüfen", "Review saved mailing version")} · {review.revision}</h3><p className="mt-1 text-sm">{review.eligible} {t("aktuell berechtigt", "currently eligible")} · {review.excluded} {t("ausgeschlossen", "excluded")}</p></div><button type="button" className="min-h-11 rounded-md border border-stone-300 px-3 py-2" disabled={busy || uncertain} onClick={() => setReview(null)}>{t("Schließen", "Close")}</button></div>
      {review.issues.length > 0 && <ul className="mt-4 list-inside list-disc rounded-md bg-amber-50 p-3 text-sm text-amber-900">{review.issues.map(issue => <li key={issue}>{issue}</li>)}</ul>}
      <p className="mt-3 text-sm text-stone-600">{review.sendableNow} {t("nach Versandregeln jetzt möglich", "currently allowed by contact rules")} · {review.deferred} {t("durch Versandzeit, Mindestabstand oder offenen Versand zurückgestellt. Dies ändert keine Einwilligung; jeder echte Versand wird erneut geprüft.", "deferred by contact hours, minimum interval or an open send. This changes no consent; each real dispatch is checked again.")}</p>
      <div className="mt-4 max-h-80 overflow-auto rounded-lg border border-stone-200"><table className="w-full text-left text-sm"><thead className="sticky top-0 bg-stone-50"><tr><th className="p-2">Name</th><th className="p-2">E-Mail</th><th className="p-2">{t("Ergebnis", "Result")}</th></tr></thead><tbody>{review.recipients.map(recipient => <tr className="border-t border-stone-100" key={recipient.contactId}><td className="p-2">{recipient.name}</td><td className="p-2">{recipient.email}</td><td className="p-2">{reasons[recipient.reason]?.[de ? 0 : 1] ?? recipient.reason}{recipient.deliveryPolicy?.allowed===false?<p className="mt-1 text-xs text-amber-900">{recipient.deliveryPolicy.issues.join(" ")}</p>:null}</td></tr>)}</tbody></table></div>
      <div className="mt-4 flex flex-wrap gap-2"><button type="button" className="min-h-11 rounded-md border border-stone-300 px-3 py-2 text-sm disabled:opacity-50" disabled={busy || uncertain} onClick={() => void loadReview(review.campaignId).catch(error => setNotice(String(error)))}>{t("Empfänger neu prüfen", "Recheck recipients")}</button><button type="button" className="min-h-11 rounded-md border border-stone-300 px-3 py-2 text-sm disabled:opacity-50" disabled={busy || uncertain || !data.canApprove || review.issues.length > 0} onClick={() => void reviewAction("test")}>{t("Test dieser Version an mich senden", "Send this version as a test to me")}</button><button type="button" className="min-h-11 rounded-md border border-emerald-400 px-3 py-2 text-sm disabled:opacity-50" disabled={busy || uncertain || review.approved || !data.canApprove || review.issues.length > 0 || review.eligible === 0} onClick={() => void reviewAction("approve")}>{review.approved ? t("Version freigegeben", "Version approved") : t("Diese Version freigeben", "Approve this version")}</button><button type="button" className="min-h-11 rounded-md bg-slate-950 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={busy || uncertain || scheduleActive || !review.approved || !data.canApprove || review.issues.length > 0 || review.statuses.some(item => ["claimed","uncertain"].includes(item.status)&&item.count>0) || !review.statuses.some(item => item.status === "pending" && item.count > 0)} onClick={() => void reviewAction("send")}>{t("Jetzt bis zu 50 freigegebene Empfänger senden", "Send up to 50 approved recipients now")}</button></div>
      {data.canApprove&&<NewsletterSchedulePanel key={`${workspaceId}:${review.campaignId}:${review.revision}`} workspaceId={workspaceId} campaignId={review.campaignId} revision={review.revision} approved={review.approved&&review.issues.length===0&&!review.statuses.some(item=>['claimed','uncertain'].includes(item.status)&&item.count>0)} onActiveChanged={setScheduleActive}/>}
      {review.statuses.length > 0 && <div className="mt-4 space-y-1 text-sm">{review.statuses.map(item => <p key={item.status}>{statusLabels[item.status]?.[de ? 0 : 1] ?? item.status}: {item.count}</p>)}</div>}
      <button type="button" className="mt-3 min-h-11 rounded-md border border-stone-300 px-3 py-2 text-sm disabled:opacity-50" disabled={busy||uncertain} onClick={()=>{void reload().then(()=>loadReview(review.campaignId)).catch(error=>setNotice(error instanceof Error?error.message:t('Status konnte nicht geladen werden.','Status could not be loaded.')));}}>{t('Versandnachweise aktualisieren','Refresh sending evidence')}</button>
      {data.testSends.filter(item => item.campaignId === review.campaignId && item.revision === review.revision).map(item => <p key={item.id} className="mt-2 text-sm">{t("Test an", "Test to")} {item.email}: {item.providerStatus?providerLabels[item.providerStatus]?.[de?0:1]:statusLabels[item.status]?.[de ? 0 : 1] ?? item.status}</p>)}
      <div className="mt-4 space-y-2"><h4 className="text-sm font-semibold">{t('Zuletzt gespeicherte Versandbelege','Recent saved send records')}</h4>{data.deliveries.filter(item=>item.campaignId===review.campaignId&&item.revision===review.revision).map(item=><p key={item.id} className="rounded-md bg-stone-50 p-3 text-sm"><span className="break-all">{item.email}</span>: {item.providerStatus?providerLabels[item.providerStatus]?.[de?0:1]:statusLabels[item.status]?.[de?0:1]??item.status}</p>)}</div>
      {notice && <p className="mt-3 text-sm" role="status">{notice}</p>}{uncertain && <button type="button" className="mt-2 min-h-11 rounded-md border border-amber-300 px-3 py-2 text-sm" disabled={busy} onClick={() => void retryPending()}>{t("Ergebnis erneut prüfen", "Check result again")}</button>}
    </section></div>}
  </div>;
}
