'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Select } from '@/components/ui/field';
import { Surface } from '@/components/ui/surface';
import { Notice } from '@/components/ui/status';
import { advisoryPending, readAdvisory, writeAdvisory, subscribeAdvisoryPending, markAdvisoryCurrentRead, reconcileAdvisory, AdvisoryBrowserError } from '@/lib/website-sales-advisory-client';
import type { WebsiteSalesAdvisoryScope } from '@/lib/website-sales-advisory-api-types';
import { websiteSalesAdvisoryContract, type WebsiteSalesAdvisoryRead } from '@/lib/website-sales-advisory-types';
import { AdvisoryValueForms, AdvisoryDiscoveryForms } from './website-sales-advisory-value-discovery';
import { AdvisoryKnowledgeForms, AdvisoryTranscriptForms } from './website-sales-advisory-conversations';
import { AdvisoryAdviceForms, AdvisoryPacketForms, AdvisoryVideoForms } from './website-sales-advisory-customer-forms';
import { AdvisoryLearningForms } from './website-sales-advisory-learning-forms';
import { AdvisoryAssertionReviews, AdvisoryStoredRecords } from './website-sales-advisory-records';
import type { AdvisoryCall } from './website-sales-advisory-form-context';

type Props = WebsiteSalesAdvisoryScope & { workspaceId: string; actorId: string; workflowId: string; language: string; sourceRevision?: number; blocked?: boolean; onStateChanged?: () => void };
type Stage = 'discovery' | 'value' | 'packet' | 'advisor' | 'conversation' | 'practice' | 'learning' | 'video';
const stages: Record<Stage, [string, string]> = { discovery: ['Bedarf klären', 'Clarify needs'], value: ['Nutzen berechnen', 'Calculate value'], packet: ['Entscheidung vorbereiten', 'Prepare a decision'], advisor: ['Website und Demo erklären', 'Explain website and demo'], conversation: ['Gespräch prüfen', 'Review conversation'], practice: ['Wissen und Übung', 'Knowledge and practice'], learning: ['Verbesserungen prüfen', 'Review improvements'], video: ['Erklärvideo vorbereiten', 'Prepare explainer video'] };

export function WebsiteSalesAdvisoryPanel(props: Props) {
  return <AdvisoryPanel key={`${props.actorId}:${props.workspaceId}:${props.workflowId}:${props.projectId}:${props.companyId}:${props.locationId}`} {...props}/>;
}
function AdvisoryPanel({ workspaceId, actorId, workflowId, language, sourceRevision = 0, blocked = false, onStateChanged, ...scope }: Props) {
  const de = language === 'de', prefix = useId(), mounted = useRef(false), root = useRef<HTMLDivElement>(null), readGeneration = useRef(0), saving = useRef(false);
  const [stage, setStage] = useState<Stage>('discovery'), [attempt, setAttempt] = useState(0), [result, setResult] = useState<{ attempt: number; sourceRevision: number; data: WebsiteSalesAdvisoryRead } | null>(null);
  const [failed, setFailed] = useState(false), [now, setNow] = useState(() => Date.now()), [busy, setBusy] = useState(false), [message, setMessage] = useState<'saved' | 'denied' | 'notFound' | null>(null), [, render] = useState(0);
  const scopeKey = JSON.stringify(scope), data = result?.data ?? null, fresh = Boolean(result && result.attempt === attempt && result.sourceRevision === sourceRevision && !failed);
  const pending = advisoryPending(workspaceId, actorId), locked = blocked || busy || Boolean(pending) || !fresh;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => { if (root.current?.querySelector('form[data-advisory-dirty="true"]') || advisoryPending(workspaceId, actorId)) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler);
  }, [workspaceId, actorId]);
  useEffect(() => subscribeAdvisoryPending(() => render(value => value + 1)), []);
  useEffect(() => {
    const controller = new AbortController(), ticket = ++readGeneration.current, selected = JSON.parse(scopeKey) as WebsiteSalesAdvisoryScope;
    const original = advisoryPending(workspaceId, actorId);
    void readAdvisory(workspaceId, selected, workflowId, controller.signal).then(value => {
      if (controller.signal.aborted || ticket !== readGeneration.current) return;
      setResult({ data: value, attempt, sourceRevision }); setFailed(false);
      if (original && !original.damaged) markAdvisoryCurrentRead(workspaceId, actorId, original.command, selected);
    }).catch(() => { if (!controller.signal.aborted && ticket === readGeneration.current) setFailed(true); });
    return () => { controller.abort(); readGeneration.current = ticket + 1; };
  }, [workspaceId, actorId, workflowId, scopeKey, attempt, sourceRevision]);
  function refresh() { readGeneration.current++; setAttempt(value => value + 1); }
  const call: AdvisoryCall = async (operation, payload) => {
    if (locked || saving.current || !data || !data.actionEligibility.some(row => row.operation === operation && row.eligible)) return false;
    saving.current = true; setBusy(true); setMessage(null); readGeneration.current++;
    try {
      await writeAdvisory(workspaceId, actorId, { contractVersion: websiteSalesAdvisoryContract, operation, ...scope, workflowId,
        expectedVersion: data.version, expectedWorkflowVersion: data.workflowVersion, idempotencyKey: crypto.randomUUID(), correlationId: crypto.randomUUID(), payload });
      if (!mounted.current) return false;
      setMessage('saved'); refresh(); onStateChanged?.(); return true;
    } catch (error) {
      if (mounted.current && !(error instanceof AdvisoryBrowserError && error.outcome === 'UNKNOWN')) setMessage('denied');
      if (mounted.current) refresh(); return false;
    } finally { saving.current = false; if (mounted.current) setBusy(false); }
  };
  async function checkOriginal() {
    const original = advisoryPending(workspaceId, actorId); if (!original || original.damaged || saving.current) return;
    saving.current = true; setBusy(true);
    try { const selected = { projectId: original.command.projectId, companyId: original.command.companyId, locationId: original.command.locationId };
      await readAdvisory(workspaceId, selected, original.command.workflowId); if (mounted.current) markAdvisoryCurrentRead(workspaceId, actorId, original.command, selected);
    } catch { if (mounted.current) setMessage('denied'); } finally { saving.current = false; if (mounted.current) setBusy(false); }
  }
  async function recover(retry: boolean) {
    const original = advisoryPending(workspaceId, actorId); if (!original || original.damaged || saving.current) return;
    saving.current = true; setBusy(true); setMessage(null); readGeneration.current++;
    try { const outcome = retry ? (await writeAdvisory(workspaceId, actorId, original.command, true), 'COMMITTED') : await reconcileAdvisory(workspaceId, actorId);
      if (mounted.current) { setMessage(outcome === 'NOT_FOUND' ? 'notFound' : 'saved'); refresh(); if (outcome === 'COMMITTED') onStateChanged?.(); }
    } catch { if (mounted.current) setMessage('denied'); } finally { saving.current = false; if (mounted.current) setBusy(false); }
  }
  const formProps = data ? { data, language, locked, now } : null;
  return <Surface ref={root} className="min-w-0 space-y-5" data-website-sales-advisory data-testid="website-sales-advisory" aria-labelledby={`${prefix}-title`}>
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="max-w-prose"><h3 id={`${prefix}-title`} className="text-xl font-semibold text-slate-950">{de ? 'Kundenberatung und Entscheidung' : 'Customer advice and decisions'}</h3><p className="mt-2 text-sm leading-6 text-stone-600">{de ? 'Bedarf klären, Nutzen nachvollziehbar berechnen und passende Informationen gemeinsam prüfen. Freigaben, Belege und offene Fragen bleiben sichtbar.' : 'Clarify needs, calculate traceable value and review relevant information together. Approvals, evidence and open questions stay visible.'}</p></div><Button variant="secondary" disabled={busy} onClick={refresh}>{de ? 'Stand aktualisieren' : 'Refresh current data'}</Button></div>
    {pending && <Notice tone="warning" announce="polite"><p>{pending.damaged ? de ? 'Ein vorheriger Vorgang lässt sich aus dem lokalen Speicher nicht sicher rekonstruieren. Neue Änderungen bleiben gesperrt.' : 'A previous request cannot be safely reconstructed from local storage. New changes remain blocked.' : de ? 'Das Ergebnis eines vorherigen Vorgangs ist noch nicht eindeutig bestätigt. Klären Sie diesen ursprünglichen Vorgang, bevor Sie weitere Änderungen senden.' : 'A previous request has an unconfirmed outcome. Resolve that original request before submitting further changes.'}</p>{!pending.damaged && <div className="mt-3 flex flex-wrap gap-3"><Button variant="secondary" disabled={busy} onClick={() => void checkOriginal()}>{de ? 'Ursprünglichen Stand prüfen' : 'Check original data'}</Button><Button variant="secondary" disabled={busy || !pending.currentRead} onClick={() => void recover(false)}>{de ? 'Gespeichertes Ergebnis abgleichen' : 'Reconcile saved result'}</Button>{pending.retryAllowed && <Button disabled={busy || !pending.currentRead} onClick={() => void recover(true)}>{de ? 'Ursprünglichen Vorgang erneut senden' : 'Resend original request'}</Button>}</div>}</Notice>}
    {busy && <p role="status" className="text-sm">{de ? 'Wird bestätigt gespeichert …' : 'Confirming saved changes…'}</p>}
    {message && <Notice tone={message === 'saved' ? 'success' : 'warning'} announce="polite">{message === 'saved' ? de ? 'Die Änderung wurde bestätigt gespeichert.' : 'The change was confirmed as saved.' : message === 'notFound' ? de ? 'Für den ursprünglichen Vorgang wurde noch keine Speicherung gefunden. Nur dieser Vorgang darf erneut gesendet werden.' : 'No saved result was found for the original request. Only that request may be resent.' : de ? 'Die Änderung konnte nicht bestätigt werden. Prüfen Sie den aktuellen Stand und die Voraussetzungen.' : 'The change could not be confirmed. Check current data and prerequisites.'}</Notice>}
    {failed && <Notice tone="warning">{de ? 'Der aktuelle Stand ist nicht abrufbar. Ihre Eingaben bleiben erhalten; Änderungen sind bis zur erneuten Prüfung gesperrt.' : 'Current data is unavailable. Your input is preserved; changes remain blocked until access is checked again.'}</Notice>}
    {(!data || !fresh) && !failed && <p role="status" className="text-sm">{de ? 'Der aktuelle Stand wird geprüft.' : 'Checking current data.'}</p>}
    {data && <>
      <details className="rounded-lg border border-stone-200 p-4"><summary className="min-h-11 cursor-pointer py-2 font-medium">{de ? 'Voraussetzungen und Hintergrundaufträge' : 'Prerequisites and background jobs'}</summary><div className="mt-3 space-y-4 text-sm">{data.blockers.length > 0 ? <ul className="list-disc space-y-2 pl-5">{data.blockers.map(code => <li key={code}>{de ? 'Eine Voraussetzung muss vor dem nächsten Schritt geprüft werden.' : 'A prerequisite must be checked before the next step.'}<details><summary className="min-h-11 cursor-pointer py-2 text-xs">{de ? 'Bezug anzeigen' : 'Show reference'}</summary><code className="break-words">{code}</code></details></li>)}</ul> : <p>{de ? 'Keine zusätzlichen Sperren gemeldet. Jeder Schritt wird vor dem Speichern erneut geprüft.' : 'No additional blockers were reported. Each step is checked again before saving.'}</p>}{data.jobs.map(job => <p key={job.id}>{job.kind === 'VIDEO' ? de ? 'Erklärvideo' : 'Explainer video' : job.kind === 'TRANSCRIPT_ANALYSIS' ? de ? 'Gesprächsauswertung' : 'Conversation analysis' : de ? 'Beratungsentwurf' : 'Advice draft'}: {({ READY: de ? 'Vorbereitet' : 'Ready', CLAIMED: de ? 'In Bearbeitung' : 'Processing', SUCCEEDED: de ? 'Ergebnis erstellt' : 'Result created', UNKNOWN: de ? 'Ergebnis wird abgeglichen' : 'Reconciling outcome', FAILED: de ? 'Fehlgeschlagen' : 'Failed', CANCELLED: de ? 'Beendet' : 'Cancelled' })[job.status]}</p>)}</div></details>
      <Field htmlFor={`${prefix}-stage`} label={de ? 'Nächster Beratungsschritt' : 'Next advisory step'}><Select id={`${prefix}-stage`} className="min-h-11 w-full sm:max-w-md" value={stage} onChange={event => setStage(event.target.value as Stage)}>{Object.entries(stages).map(([key, labels]) => <option key={key} value={key}>{labels[de ? 0 : 1]}</option>)}</Select></Field>
      {formProps && <div className="space-y-5 border-t border-stone-200 pt-5" data-advisory-section={stage}>
        <section hidden={stage !== 'discovery'} className="space-y-5"><AdvisoryDiscoveryForms {...formProps} call={call}/><AdvisoryStoredRecords data={data} language={language} kinds={['DISCOVERY_ANSWER', 'DISCOVERY_PLAN']}/></section>
        <section hidden={stage !== 'value'} className="space-y-5"><AdvisoryValueForms {...formProps} call={call}/><AdvisoryStoredRecords data={data} language={language} kinds={['VALUE_BASIS', 'VALUE_CASE']}/></section>
        <section hidden={stage !== 'packet'} className="space-y-5"><AdvisoryPacketForms {...formProps} call={call}/><AdvisoryStoredRecords data={data} language={language} kinds={['BUYER_PACKET', 'BUYER_PACKET_APPROVAL']}/></section>
        <section hidden={stage !== 'advisor'} className="space-y-5"><AdvisoryAdviceForms {...formProps} call={call}/><AdvisoryStoredRecords data={data} language={language} kinds={['ADVICE_REQUEST', 'ADVICE', 'ADVICE_REVIEW']}/></section>
        <section hidden={stage !== 'conversation'} className="space-y-5"><AdvisoryTranscriptForms {...formProps} call={call}/><AdvisoryAssertionReviews {...formProps} call={call}/><AdvisoryStoredRecords data={data} language={language} kinds={['TRANSCRIPT', 'TRANSCRIPT_ASSERTIONS', 'TRANSCRIPT_REVIEW']}/></section>
        <section hidden={stage !== 'practice'} className="space-y-5"><AdvisoryKnowledgeForms {...formProps} call={call}/><AdvisoryStoredRecords data={data} language={language} kinds={['KNOWLEDGE', 'KNOWLEDGE_APPROVAL', 'COACHING', 'ROLEPLAY']}/></section>
        <section hidden={stage !== 'learning'} className="space-y-5"><AdvisoryLearningForms {...formProps} call={call}/><AdvisoryStoredRecords data={data} language={language} kinds={['EXPERIMENT_PLAN', 'EXPERIMENT_ASSIGNMENT', 'EXPERIMENT_STOP', 'FORECAST_POLICY', 'FORECAST']}/></section>
        <section hidden={stage !== 'video'} className="space-y-5"><AdvisoryVideoForms {...formProps} call={call}/><AdvisoryStoredRecords data={data} language={language} kinds={['VIDEO_STORYBOARD', 'VIDEO_APPROVAL']}/></section>
      </div>}
    </>}
  </Surface>;
}
