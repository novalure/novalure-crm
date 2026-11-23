'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Select } from '@/components/ui/field';
import { Surface } from '@/components/ui/surface';
import { Notice, StatusChip } from '@/components/ui/status';
import { advisoryBuyerCommandSchema, type WebsiteSalesAdvisoryBuyerRead } from '@/lib/website-sales-advisory-types';
import { BuyerBrowserError, buyerPending, readBuyer, reconcileBuyer, subscribeBuyerPending, writeBuyer, type BuyerCommand } from '@/lib/website-sales-buyer-client';
import { loadBuyerVideo } from '@/lib/website-sales-buyer-media-client';
import { formatSalesMinor } from '@/lib/website-sales-operations-format';
import { AdvisoryChoices, AdvisoryFields, AdvisoryForm, advisoryText } from './website-sales-advisory-fields';

function fragmentToken() {
  const values = new URLSearchParams(window.location.hash.slice(1));
  const token = values.get('grant');
  return values.size === 1 && values.getAll('grant').length === 1 && token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}
function BuyerVideo({ token, video, language }: { token: string; video: NonNullable<WebsiteSalesAdvisoryBuyerRead['video']>; language: string }) {
  const [requested, setRequested] = useState(false), [url, setUrl] = useState<string | null>(null), [failed, setFailed] = useState(false);
  const { mediaPath, sha256 } = video;
  const de = language === 'de';
  useEffect(() => {
    if (!requested) return;
    const abort = new AbortController(); let current = true, created: string | null = null;
    void loadBuyerVideo(token, { mediaPath, sha256 }, abort.signal).then(value => { created = value; if (current) setUrl(value); else URL.revokeObjectURL(value); }).catch(() => { if (current && !abort.signal.aborted) setFailed(true); });
    return () => { current = false; abort.abort(); if (created) URL.revokeObjectURL(created); };
  }, [requested, token, mediaPath, sha256]);
  return <Surface className="space-y-4"><h2 className="text-lg font-semibold">{video.title}</h2><p className="max-w-prose text-sm text-stone-600">{de ? 'Erklärvideo mit Text, ohne Ton. Es zeigt die freigegebene Demo und wird erst auf Ihren Wunsch geladen.' : 'Explainer video with text and no audio. It shows the approved demo and loads only when you request it.'}</p>
    {!requested && <Button type="button" onClick={() => setRequested(true)}>{de ? 'Erklärvideo laden' : 'Load explainer video'}</Button>}
    {requested && !url && !failed && <p role="status" className="text-sm">{de ? 'Das geschützte Video wird geprüft und geladen.' : 'Checking and loading the private video.'}</p>}
    {failed && <Notice tone="warning">{de ? 'Das Video konnte nicht bestätigt werden. Aktualisieren Sie den Stand, um den Zugang erneut zu prüfen.' : 'The video could not be confirmed. Refresh the page data to check access again.'}</Notice>}
    {url && <video controls playsInline preload="metadata" src={url} aria-label={video.title} className="aspect-video w-full rounded-lg bg-slate-950"/>}
    {video.captionText && <details><summary className="min-h-11 cursor-pointer py-2 text-sm">{de ? 'Videoinhalt als Text lesen' : 'Read the video text'}</summary><p className="max-w-prose whitespace-pre-wrap text-sm leading-6">{video.captionText}</p></details>}
  </Surface>;
}
export function WebsiteSalesBuyerRoom() {
  const prefix = useId(), root = useRef<HTMLElement>(null), generation = useRef(0), loadingRef = useRef<string | null>(null), busyRef = useRef(false);
  const [token, setToken] = useState<string | null>(null), [initialized, setInitialized] = useState(false), [language, setLanguage] = useState('de');
  const [data, setData] = useState<WebsiteSalesAdvisoryBuyerRead | null>(null), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [unavailable, setUnavailable] = useState(false);
  const [notice, setNotice] = useState<'saved' | 'denied' | 'notFound' | null>(null), [, render] = useState(0);
  const de = language === 'de', pending = data ? buyerPending(data.grantId) : undefined, locked = loading || busy || Boolean(pending);
  useEffect(() => {
    const update = () => { generation.current++; setData(null); setUnavailable(false); setNotice(null); setToken(fragmentToken()); setInitialized(true); };
    update(); window.addEventListener('hashchange', update); return () => window.removeEventListener('hashchange', update);
  }, []);
  useEffect(() => subscribeBuyerPending(() => render(value => value + 1)), []);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!token || loadingRef.current === token || busyRef.current) return;
    loadingRef.current = token; setLoading(true); const ticket = ++generation.current;
    try { const value = await readBuyer(token, signal); if (!signal?.aborted && ticket === generation.current) { setData(value); setUnavailable(false); } }
    catch { if (!signal?.aborted && ticket === generation.current) { setData(null); setUnavailable(true); } }
    finally { if (loadingRef.current === token) loadingRef.current = null; if (!signal?.aborted && ticket === generation.current) setLoading(false); }
  }, [token]);
  useEffect(() => {
    if (!token) return;
    const abort = new AbortController(); const initial = setTimeout(() => void refresh(abort.signal), 0);
    const onFocus = () => { if (document.visibilityState === 'visible') void refresh(abort.signal); };
    window.addEventListener('focus', onFocus); document.addEventListener('visibilitychange', onFocus);
    const poll = setInterval(onFocus, 15000);
    return () => { abort.abort(); clearTimeout(initial); clearInterval(poll); window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onFocus); };
  }, [token, refresh]);
  useEffect(() => {
    if (!data) return;
    const expiry = setTimeout(() => { generation.current++; setData(null); setUnavailable(true); }, Math.max(0, Math.min(2147483647, Date.parse(data.expiresAt) - Date.now())));
    return () => clearTimeout(expiry);
  }, [data]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (root.current?.querySelector('form[data-advisory-dirty="true"]') || data && buyerPending(data.grantId)) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard);
  }, [data]);
  async function execute(value: Record<string, unknown>) {
    if (!token || !data || locked || !data.canWrite) return false;
    busyRef.current = true; setBusy(true); setNotice(null); generation.current++;
    try { await writeBuyer(token, data, advisoryBuyerCommandSchema.parse(value)); setNotice('saved'); return true; }
    catch (error) { if (!(error instanceof BuyerBrowserError && error.outcome === 'UNKNOWN')) setNotice('denied'); return false; }
    finally { busyRef.current = false; setBusy(false); void refresh(); }
  }
  async function recover(retry: boolean) {
    if (!token || !data || !pending || busy || loading) return;
    busyRef.current = true; setBusy(true); setNotice(null);
    try { const result = retry ? (await writeBuyer(token, data, pending.command, true), 'COMMITTED') : await reconcileBuyer(token, data); setNotice(result === 'NOT_FOUND' ? 'notFound' : 'saved'); }
    catch { setNotice('denied'); }
    finally { busyRef.current = false; setBusy(false); void refresh(); }
  }
  function command(fields: Pick<BuyerCommand, 'stepId' | 'expectedStepVersion' | 'disposition' | 'comment'>) {
    if (!data) throw Error();
    return { contractVersion: 'website-sales-advisory-buyer-v1', grantId: data.grantId, expectedGrantVersion: data.grantVersion, packetRef: data.packetRef, ...fields, idempotencyKey: crypto.randomUUID(), correlationId: crypto.randomUUID() };
  }
  const validate = (value: unknown) => { const parsed = advisoryBuyerCommandSchema.safeParse(value); return parsed.success ? [] : parsed.error.issues; };
  return <main ref={root} className="mx-auto w-full max-w-5xl space-y-6 px-4 py-8 sm:px-6 lg:py-12" data-testid="sales-buyer-room">
    <header className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-sm font-semibold text-blue-800">Novalure</p><h1 className="mt-2 text-2xl font-semibold text-slate-950">{de ? 'Ihre Entscheidungsmappe' : 'Your decision packet'}</h1><p className="mt-2 max-w-prose text-sm leading-6 text-stone-600">{de ? 'Freigegebene Informationen, eine passende Vorschau und die nächsten gemeinsamen Schritte.' : 'Approved information, a relevant preview and your next shared steps.'}</p></div><Field htmlFor={`${prefix}-language`} label={de ? 'Sprache' : 'Language'}><Select id={`${prefix}-language`} className="min-h-11" value={language} onChange={event => setLanguage(event.target.value)}><option value="de">Deutsch</option><option value="en">English</option></Select></Field></header>
    {token && <Button type="button" variant="secondary" disabled={loading || busy} onClick={() => void refresh()}>{de ? 'Stand aktualisieren' : 'Refresh current data'}</Button>}
    {(!initialized || loading) && <p role="status" className="text-sm text-stone-600">{de ? 'Die aktuelle Freigabe wird geprüft.' : 'Checking current access.'}</p>}
    {initialized && !token && <Notice tone="warning">{de ? 'Öffnen Sie den vollständigen persönlichen Link, den Sie von Novalure erhalten haben.' : 'Open the complete personal link you received from Novalure.'}</Notice>}
    {unavailable && <Notice tone="warning">{de ? 'Diese Mappe ist aktuell nicht verfügbar. Der Zugang kann abgelaufen oder widerrufen worden sein. Fordern Sie bei Novalure einen aktuellen Link an.' : 'This packet is currently unavailable. Access may have expired or been revoked. Ask Novalure for a current link.'}</Notice>}
    {notice && <Notice tone={notice === 'saved' ? 'success' : notice === 'denied' ? 'warning' : 'info'} announce="polite">{notice === 'saved' ? de ? 'Ihre Rückmeldung wurde bestätigt gespeichert.' : 'Your response was confirmed as saved.' : notice === 'notFound' ? de ? 'Für den ursprünglichen Vorgang wurde noch keine Speicherung gefunden. Sie können genau diesen Vorgang erneut übermitteln.' : 'No stored result was found for the original request. You can resend that exact request.' : de ? 'Die Rückmeldung konnte nicht bestätigt werden. Aktualisieren Sie den Stand und prüfen Sie Ihre Anmeldung.' : 'The response could not be confirmed. Refresh the data and check your sign-in.'}</Notice>}
    {data && <>
      <Surface className="space-y-4"><h2 className="text-xl font-semibold">{data.title}</h2><p className="max-w-prose whitespace-pre-wrap text-sm leading-6 text-stone-700">{data.summary}</p><p className="text-sm text-stone-600">{de ? 'Freigegeben bis' : 'Access expires'} {new Date(data.expiresAt).toLocaleString(de ? 'de-AT' : 'en-IE')}</p>
        {data.canWrite ? <StatusChip tone="success">{de ? 'Freigegebenes angemeldetes Konto' : 'Approved signed-in account'}</StatusChip> : <Notice><p>{de ? 'Sie können diese Mappe lesen. Rückmeldungen sind nur durch das freigegebene angemeldete Konto möglich.' : 'You can read this packet. Responses require the approved signed-in account.'}</p><a className="mt-2 inline-flex min-h-11 items-center text-blue-800 underline underline-offset-4" href="/login?returnTo=%2F" target="_blank" rel="noreferrer noopener">{de ? 'In neuem Fenster anmelden' : 'Sign in in a new window'}</a><p className="mt-1 text-sm">{de ? 'Kehren Sie anschließend zu dieser Mappe zurück und aktualisieren Sie den Stand.' : 'Then return to this packet and refresh the current data.'}</p></Notice>}
      </Surface>
      {pending && <Notice tone="warning" announce="polite"><p>{pending.damaged ? de ? 'Ein vorheriger Vorgang kann aus dem lokalen Speicher nicht sicher rekonstruiert werden. Weitere Rückmeldungen bleiben gesperrt.' : 'A previous request cannot be safely reconstructed from local storage. Further responses remain blocked.' : de ? 'Das Ergebnis einer vorherigen Rückmeldung ist noch nicht eindeutig bestätigt. Übermitteln Sie keine neue Rückmeldung, bevor der ursprüngliche Vorgang geklärt ist.' : 'A previous response has an unconfirmed outcome. Resolve the original request before submitting another response.'}</p>{!pending.damaged && data.canWrite && pending.actorUserId === data.actorUserId && <div className="mt-3 flex flex-wrap gap-3"><Button type="button" variant="secondary" disabled={loading || busy || !pending.currentRead} onClick={() => void recover(false)}>{de ? 'Ursprüngliches Ergebnis prüfen' : 'Check the original result'}</Button>{pending.retryAllowed && <Button type="button" disabled={loading || busy || !pending.currentRead} onClick={() => void recover(true)}>{de ? 'Ursprünglichen Vorgang erneut übermitteln' : 'Resend the original request'}</Button>}</div>}</Notice>}
      {data.decisionCriteria.length > 0 && <Surface className="space-y-3"><h2 className="text-lg font-semibold">{de ? 'Worauf es bei Ihrer Entscheidung ankommt' : 'What matters for your decision'}</h2><ul className="list-disc space-y-2 pl-5 text-sm text-stone-700">{data.decisionCriteria.map(item => <li key={item}>{item}</li>)}</ul></Surface>}
      {data.options.length > 0 && <section className="space-y-4" aria-labelledby={`${prefix}-options`}><h2 id={`${prefix}-options`} className="text-lg font-semibold">{de ? 'Ihre Optionen' : 'Your options'}</h2><div className="grid gap-4 md:grid-cols-2">{data.options.map((option, index) => <Surface key={index} className="space-y-3"><h3 className="font-semibold">{option.label}</h3>{option.benefits.length > 0 && <><p className="text-sm font-medium">{de ? 'Vorteile' : 'Benefits'}</p><ul className="list-disc space-y-2 pl-5 text-sm">{option.benefits.map(item => <li key={item}>{item}</li>)}</ul></>}{option.limits.length > 0 && <><p className="text-sm font-medium">{de ? 'Grenzen und Voraussetzungen' : 'Limits and prerequisites'}</p><ul className="list-disc space-y-2 pl-5 text-sm">{option.limits.map(item => <li key={item}>{item}</li>)}</ul></>}</Surface>)}</div></section>}
      {data.valueCase && <Surface className="space-y-4"><h2 className="text-lg font-semibold">{de ? 'Freigegebene Nutzenszenarien' : 'Approved value scenarios'}</h2><Notice>{de ? `Szenarien über ${data.valueCase.horizonMonths} Monate auf Basis dokumentierter Annahmen und des freigegebenen Angebots. Die tatsächlichen Ergebnisse können abweichen; der ROI ist nicht garantiert. Alle Beträge netto.` : `Scenarios over ${data.valueCase.horizonMonths} months based on recorded assumptions and the approved offer. Actual outcomes may differ; ROI is not guaranteed. All amounts are net.`}</Notice><div className="grid gap-4 md:grid-cols-3">{data.valueCase.scenarios.map(row => <div key={row.name} className="space-y-3 rounded-lg border border-stone-200 p-4"><h3 className="font-semibold">{row.name === 'BASE' ? de ? 'Grundannahme' : 'Base scenario' : row.name === 'LOW' ? de ? 'Vorsichtige Annahme' : 'Lower scenario' : de ? 'Höhere Annahme' : 'Higher scenario'}</h3><dl className="space-y-3 text-sm">{[[de ? 'Kosten' : 'Cost', formatSalesMinor(row.totalCostMinor, language)], [de ? 'Angenommener Geldnutzen' : 'Assumed cash benefit', formatSalesMinor(row.totalCashBenefitMinor, language)], [de ? 'Geldnutzen nach Kosten' : 'Net cash benefit after cost', formatSalesMinor(row.netCashMinor, language)], ['ROI', row.roiBps === null ? de ? 'Nicht bestimmbar' : 'Not defined' : new Intl.NumberFormat(de ? 'de-AT' : 'en-IE', { style: 'percent', maximumFractionDigits: 2 }).format(row.roiBps / 10000)], [de ? 'Amortisation' : 'Payback', row.paybackMonth === null ? de ? 'Im Zeitraum nicht erreicht' : 'Not reached within horizon' : `${de ? 'Monat' : 'Month'} ${row.paybackMonth}`]].map(([label, value]) => <div key={label}><dt className="font-medium">{label}</dt><dd className="mt-1 break-words text-stone-700">{value}</dd></div>)}</dl></div>)}</div></Surface>}
      {data.demo && <Surface className="space-y-3"><h2 className="text-lg font-semibold">{data.demo.title}</h2><a className="inline-flex min-h-11 items-center text-blue-800 underline underline-offset-4" href={data.demo.accessPath} target="_blank" rel="noreferrer noopener">{de ? 'Geschützte Vorschau in neuem Fenster öffnen' : 'Open the private preview in a new window'}</a></Surface>}
      {data.video && token && <BuyerVideo key={`${data.grantId}:${data.video.id}:${data.video.sha256}`} token={token} video={data.video} language={language}/>}
      <section className="space-y-4" aria-labelledby={`${prefix}-steps`}><h2 id={`${prefix}-steps`} className="text-lg font-semibold">{de ? 'Gemeinsame nächste Schritte' : 'Shared next steps'}</h2><p className="max-w-prose text-sm leading-6 text-stone-600">{de ? 'Hier halten Sie Rückmeldungen zu gemeinsamen nächsten Schritten fest. Verbindliche Angebote und Verträge folgen dem gesonderten Abschlussprozess.' : 'Record responses about shared next steps here. Binding offers and contracts follow the separate closing process.'}</p>{!data.steps.length && <p className="text-sm text-stone-600">{de ? 'Es wurden noch keine gemeinsamen Schritte veröffentlicht.' : 'No shared steps have been published yet.'}</p>}
        {data.steps.map(step => <Surface key={`${step.id}:${step.version}`} className="space-y-4"><div className="flex flex-wrap items-start justify-between gap-3"><h3 className="font-semibold">{step.label}</h3><StatusChip tone={step.status === 'CONFIRMED' || step.status === 'DONE' ? 'success' : step.status === 'DECLINED' ? 'warning' : 'info'}>{de ? { PROPOSED: 'Vorgeschlagen', CONFIRMED: 'Durch freigegebenes Konto bestätigt', DECLINED: 'Abgelehnt', DONE: 'Erledigt' }[step.status] : { PROPOSED: 'Proposed', CONFIRMED: 'Confirmed by approved account', DECLINED: 'Declined', DONE: 'Done' }[step.status]}</StatusChip></div><p className="text-sm text-stone-600">{step.responsible === 'NOVALURE' ? 'Novalure' : de ? 'Ihr Unternehmen' : 'Your company'}{step.dueAt ? ` · ${new Date(step.dueAt).toLocaleDateString(de ? 'de-AT' : 'en-IE')}` : ''}</p>
          {data.canWrite && step.status !== 'DONE' && <AdvisoryForm action="buyer_step" language={language} title={de ? 'Ihre Rückmeldung zu diesem Schritt' : 'Your response to this step'} submitLabel={de ? 'Rückmeldung speichern' : 'Save response'} allowed={data.canWrite} locked={locked} validate={validate} submit={execute} build={form => command({ stepId: step.id, expectedStepVersion: step.version, disposition: advisoryText(form, 'disposition') as 'CONFIRMED' | 'DECLINED', comment: advisoryText(form, 'comment') || null })}>{context => <><AdvisoryChoices context={context} name="disposition" label={de ? 'Rückmeldung' : 'Response'} language={language} choices={[{ value: 'CONFIRMED', label: de ? 'Schritt bestätigen' : 'Confirm this step' }, { value: 'DECLINED', label: de ? 'Schritt ablehnen' : 'Decline this step' }]}/><AdvisoryFields context={context} fields={[{ name: 'comment', label: de ? 'Kommentar' : 'Comment', required: false, multiline: true, maxLength: 1000 }]}/></>}</AdvisoryForm>}
        </Surface>)}
      </section>
      <Surface className="space-y-5"><h2 className="text-lg font-semibold">{de ? 'Fragen und Antworten' : 'Questions and answers'}</h2>{!data.questions.length && <p className="text-sm text-stone-600">{de ? 'Hier sind noch keine Fragen dokumentiert.' : 'No questions have been recorded here yet.'}</p>}{data.questions.map(question => <div key={question.id} className="space-y-2 border-b border-stone-200 pb-4 text-sm"><p className="font-medium">{question.text}</p><p className="whitespace-pre-wrap text-stone-700">{question.answer ?? (de ? 'Antwort steht noch aus.' : 'Awaiting an answer.')}</p></div>)}
        {data.canWrite && <AdvisoryForm action="buyer_question" language={language} title={de ? 'Eine Frage an Novalure stellen' : 'Ask Novalure a question'} submitLabel={de ? 'Frage speichern' : 'Save question'} allowed={data.canWrite} locked={locked} validate={validate} submit={execute} build={form => command({ stepId: null, expectedStepVersion: null, disposition: 'QUESTION', comment: advisoryText(form, 'question') })}>{context => <AdvisoryFields context={context} fields={[{ name: 'question', label: de ? 'Ihre Frage' : 'Your question', multiline: true, maxLength: 1000 }]}/>}</AdvisoryForm>}
      </Surface>
    </>}
  </main>;
}
