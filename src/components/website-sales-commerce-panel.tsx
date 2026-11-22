'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Select } from '@/components/ui/field';
import { Surface } from '@/components/ui/surface';
import { Notice, StatusChip } from '@/components/ui/status';
import { commercePending, readCommerce, writeCommerce, subscribeCommercePending, markCommerceCurrentRead, reconcileCommerce, CommerceBrowserError } from '@/lib/website-sales-commerce-client';
import { websiteSalesCommerceCopy } from '@/lib/website-sales-commerce-copy';
import type { WebsiteSalesCommerceScope } from '@/lib/website-sales-commerce-api-types';
import { websiteSalesCommerceContract, type WebsiteSalesCommerceOperation, type WebsiteSalesCommerceRead, type WebsiteSalesCommerceSourceEvent } from '@/lib/website-sales-commerce-types';
import { commerceContractStatus, commerceNewestInvoice, commerceSubscriptionSource, commercePaymentSummary } from '@/lib/website-sales-commerce-view';
import { formatSalesMinor } from '@/lib/website-sales-operations-format';
import { ContractActions, DeliveryActions, InvoiceActions, OfferActions, PolicyForm, SubscriptionActions, TemplateForm, type CommerceCall } from './website-sales-commerce-forms';

type Props = WebsiteSalesCommerceScope & { workspaceId: string; actorId: string; workflowId: string; language: string; sourceRevision?: number; blocked?: boolean; onStateChanged?: () => void };
type Stage = 'offer' | 'contract' | 'delivery' | 'invoice' | 'subscription' | 'configuration';

function money(value: number, currency: string, language: string) {
  if (currency === 'EUR') return formatSalesMinor(value, language);
  const amount = BigInt(value), integer = new Intl.NumberFormat(language === 'de' ? 'de-AT' : 'en-IE', { maximumFractionDigits: 0 }).format(amount / BigInt(100));
  return `${integer}${language === 'de' ? ',' : '.'}${String(amount % BigInt(100)).padStart(2, '0')} ${currency}`;
}

function statusText(status: string, de: boolean) {
  const labels: Record<string, [string, string]> = {
    DRAFT: ['Entwurf', 'Draft'], APPROVAL_PENDING: ['Wartet auf Vertragsfreigabe', 'Awaiting contract approval'], PENDING: ['Wartet auf Bestätigung', 'Awaiting confirmation'],
    APPROVED: ['Freigegeben', 'Approved'], QUEUED: ['Versand vorbereitet', 'Delivery prepared'], SENT: ['Versand dokumentiert', 'Sending recorded'],
    DELIVERED: ['Zustellung bestätigt', 'Delivery confirmed'], SIGNATURE_PENDING: ['Wartet auf Unterschrift', 'Awaiting signature'], SIGNED: ['Unterschrift bestätigt', 'Signature confirmed'],
    DECLINED: ['Abgelehnt', 'Declined'], ACCEPTED: ['Vom Dienst angenommen', 'Accepted by the provider'], REJECTED: ['Abgelehnt', 'Rejected'],
    READY: ['Vorbereitet', 'Ready'], CLAIMED: ['Wird verarbeitet', 'Processing'], UNKNOWN: ['Ergebnis wird abgeglichen', 'Result under reconciliation'],
    CANCELLED: ['Beendet', 'Cancelled'], CANCEL_PENDING: ['Kündigung angefordert', 'Cancellation requested'], EXPIRED: ['Abgelaufen', 'Expired'], VOIDED: ['Aufgehoben', 'Voided'], REVOKED: ['Widerrufen', 'Revoked'], DENIED: ['Nicht freigegeben', 'Denied'],
    DRAFT_REQUEST: ['Rechnungsanforderung vorbereitet', 'Invoice request prepared'], REQUESTED: ['Bei der Buchhaltung angefordert', 'Requested from accounting'], ISSUED: ['Ausstellung bestätigt', 'Issue confirmed'],
    SETTLED: ['Buchung bestätigt', 'Settlement confirmed'], FAILED: ['Fehlgeschlagen', 'Failed'], BOUNCED: ['Nicht zugestellt', 'Bounced'], COMPLAINED: ['Beschwerde eingegangen', 'Complaint received'],
    PROPOSED: ['Vorgeschlagen', 'Proposed'], PENDING_SOURCE: ['Wartet auf die zuständige Quelle', 'Awaiting the authoritative source'], ACTIVE: ['Aktiv', 'Active'], PAUSED: ['Pausiert', 'Paused'],
    SOURCE_UNAVAILABLE: ['Quelle derzeit nicht abrufbar', 'Source currently unavailable'], DISABLED: ['Nicht aktiviert', 'Disabled'], MISCONFIGURED: ['Konfiguration prüfen', 'Check configuration'],
  };
  return labels[status]?.[de ? 0 : 1] ?? (de ? 'Stand prüfen' : 'Review status');
}
function reasonText(code: string, de: boolean) {
  if (/PERMISSION|OWNER|MFA|AUTHORITY/.test(code)) return de ? 'Für diesen Schritt ist die passende bestätigte Berechtigung erforderlich.' : 'This step requires the appropriate verified permission.';
  if (/TEMPLATE|LEGAL/.test(code)) return de ? 'Eine aktuelle geprüfte Vertragsvorlage mit Nachweis fehlt.' : 'A current reviewed contract template and evidence are required.';
  if (/APPROVAL|CHALLENGE/.test(code)) return de ? 'Die genaue Fassung braucht eine gültige Freigabe.' : 'The exact version requires a valid approval.';
  if (/SIGNATURE|SIGNED/.test(code)) return de ? 'Die erforderliche Vertragsunterschrift ist noch nicht bestätigt.' : 'The required contract signature has not been confirmed.';
  if (/POLICY|TAX|ACCOUNTING_PROFILE/.test(code)) return de ? 'Die Abschluss- und Rechnungsgrundlage muss vollständig geprüft sein.' : 'The closing and accounting policy must be fully reviewed.';
  if (/CONNECTION|PROVIDER|ACCOUNTING/.test(code)) return de ? 'Die passende angebundene Quelle ist noch nicht einsatzbereit.' : 'The appropriate connected source is not ready.';
  if (/UNKNOWN|RECONCILIATION|OUTBOX/.test(code)) return de ? 'Ein früherer Vorgang muss zuerst eindeutig abgeglichen werden.' : 'An earlier operation must be reconciled first.';
  if (/ACCEPTANCE|DELIVERY_TASK|DELIVERY/.test(code)) return de ? 'Eine abgeschlossene Lieferung mit passendem Abnahmebeleg ist erforderlich.' : 'Completed delivery and matching acceptance evidence are required.';
  if (/OFFER/.test(code)) return de ? 'Eine passende aktuelle Angebotsfassung wird benötigt.' : 'A matching current offer version is required.';
  if (/SUBSCRIPTION|RENEWAL/.test(code)) return de ? 'Die Laufzeit und der aktuelle Betreuungsstatus müssen von der zuständigen Quelle bestätigt sein.' : 'The authoritative source must confirm the service period and current status.';
  if (/EXPIRED|STALE|CURRENT|VERSION|SOURCE/.test(code)) return de ? 'Eine Grundlage wurde geändert oder ist abgelaufen und muss erneut geprüft werden.' : 'A source changed or expired and requires another review.';
  return de ? 'Für den nächsten Schritt fehlt noch eine bestätigte Voraussetzung.' : 'A confirmed requirement is still missing for the next step.';
}
function Status({ value, de }: { value: string; de: boolean }) {
  return <StatusChip tone={['UNKNOWN', 'EXPIRED', 'PENDING_SOURCE', 'APPROVAL_PENDING', 'SOURCE_UNAVAILABLE'].includes(value) ? 'warning' : ['FAILED', 'BOUNCED', 'COMPLAINED', 'REJECTED', 'VOIDED', 'REVOKED'].includes(value) ? 'danger' : ['SIGNED', 'DELIVERED', 'SETTLED', 'ISSUED', 'ACTIVE', 'APPROVED'].includes(value) ? 'success' : 'neutral'}>{statusText(value, de)}</StatusChip>;
}
function Table({ label, headers, children, de }: { label: string; headers: string[]; children: ReactNode; de: boolean }) {
  return <div className="space-y-2"><p className="text-xs text-stone-600">{de ? 'Die vollständige Tabelle lässt sich seitlich verschieben.' : 'Scroll sideways to read the complete table.'}</p><div className="overflow-x-auto rounded-lg border border-stone-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700" tabIndex={0} role="region" aria-label={label} data-commerce-table>
    <table className="w-full min-w-[42rem] text-left text-sm"><caption className="sr-only">{label}</caption><thead className="bg-stone-50"><tr>{headers.map(header => <th className="whitespace-nowrap px-4 py-3 font-semibold" scope="col" key={header}>{header}</th>)}</tr></thead><tbody className="divide-y divide-stone-200">{children}</tbody></table>
  </div></div>;
}
function SourceEvents({ events, language, assessment }: { events: WebsiteSalesCommerceSourceEvent[]; language: string; assessment: WebsiteSalesCommerceRead['sourceAssessment'] }) {
  const de = language === 'de', copy = websiteSalesCommerceCopy(language), invalidated = new Set(assessment.invalidatedEventIds), active = new Set(assessment.activeEventIds);
  if (!events.length) return <p className="text-sm text-stone-600">{copy.noRecords}</p>;
  const names: Record<string, string> = de ? { PROVIDER_DELIVERY: 'Versandnachweis', SIGNATURE: 'Unterschrift', DELIVERY_ACCEPTANCE: 'Kundenabnahme', INVOICE: 'Rechnung', PAYMENT: 'Zahlung', REFUND: 'Rückerstattung', CREDIT_NOTE: 'Gutschrift', REVERSAL: 'Korrektur', SUBSCRIPTION: 'Betreuung' } : { PROVIDER_DELIVERY: 'Delivery evidence', SIGNATURE: 'Signature', DELIVERY_ACCEPTANCE: 'Customer acceptance', INVOICE: 'Invoice', PAYMENT: 'Payment', REFUND: 'Refund', CREDIT_NOTE: 'Credit note', REVERSAL: 'Reversal', SUBSCRIPTION: 'Service subscription' };
  return <ul className="space-y-3">{events.map(event => <li key={event.eventId} className="space-y-2 rounded-lg border border-stone-200 bg-white p-4 text-sm"><div className="flex flex-wrap items-center justify-between gap-3"><h5 className="font-semibold">{names[event.kind]}</h5><StatusChip tone={event.confidence === 'PROVIDER_VERIFIED' ? 'info' : 'neutral'}>{event.confidence === 'PROVIDER_VERIFIED' ? copy.providerProof : copy.manualProof}</StatusChip></div>{assessment.status !== 'READY' ? <StatusChip tone="warning">{de ? 'Aktualität wird abgeglichen' : 'Currentness under reconciliation'}</StatusChip> : invalidated.has(event.eventId) ? <StatusChip tone="warning">{de ? 'Später korrigiert' : 'Later reversed'}</StatusChip> : !active.has(event.eventId) ? <StatusChip>{de ? 'Historischer Beleg' : 'Historical evidence'}</StatusChip> : null}
    <p>{event.source.provider} · {event.source.resourceType === 'EMAIL_OBSERVATION' ? de ? 'Status beim Anbieter beobachtet am' : 'Provider status observed at' : de ? 'Belegzeitpunkt' : 'Evidence time'}: {new Date(event.occurredAt).toLocaleString(de ? 'de-AT' : 'en-IE')}</p>
    {'amountMinor' in event.payload && <p className="font-medium">{money(event.payload.amountMinor, event.payload.currency, language)}</p>}
    {'status' in event.payload && <Status value={event.payload.status} de={de}/>}
    {'invoiceNumber' in event.payload && <p>{de ? 'Rechnungsnummer' : 'Invoice number'}: {event.payload.invoiceNumber}</p>}
    <details><summary className="min-h-11 cursor-pointer py-2">{copy.reference}</summary><p className="break-words">{event.verificationReceiptReference}</p><p className="mt-1 break-words text-stone-600">{event.source.resourceId} · {de ? 'Quellfassung' : 'Source version'} {event.source.version}</p></details>
  </li>)}</ul>;
}

function FinancialPosition({ data, language }: { data: WebsiteSalesCommerceRead; language: string }) {
  const de = language === 'de', assessment = data.financialAssessment, value = assessment?.value;
  if (!assessment && data.invoices.length === 0 && data.payments.length === 0) return <p className="text-sm text-stone-600">{de ? 'Der bestätigte Rechnungs- und Zahlungsstand ist noch unbekannt.' : 'The confirmed invoice and payment position is not known yet.'}</p>;
  if (!assessment || assessment.status !== 'READY' || !value?.complete) return <Notice tone="warning"><p>{de ? 'Der Zahlungsabgleich ist noch nicht vollständig bestätigt. Die vorhandenen Belege finden Sie darunter.' : 'Payment reconciliation is not fully confirmed yet. The available evidence is listed below.'}</p></Notice>;
  return <div className="space-y-4" data-testid="commerce-financial-position"><h4 className="font-semibold">{de ? 'Bestätigter Zahlungsstand' : 'Confirmed payment position'}</h4>
    {value.currencies.length === 0 && value.invoices.length === 0 && <p className="max-w-prose text-sm text-stone-600">{de ? 'Es liegen noch keine bestätigten Rechnungs- oder Zahlungsbelege vor. Daraus lässt sich kein offener Gesamtbetrag ableiten.' : 'No confirmed invoice or payment evidence is available yet. This does not establish the total amount outstanding.'}</p>}
    {value.currencies.length > 0 && <Table de={de} label={de ? 'Zahlungsstand nach Währung' : 'Payment position by currency'} headers={[de ? 'Währung' : 'Currency', de ? 'Gestellte Rechnungen' : 'Invoiced', de ? 'Bestätigte Zahlungseingänge' : 'Confirmed receipts', de ? 'Rückerstattungen' : 'Refunds', de ? 'Offene Rechnungsbeträge' : 'Outstanding invoices', de ? 'Noch nicht zugeordnet' : 'Unallocated']}>
      {value.currencies.map(row => <tr key={row.currency}><th scope="row" className="px-4 py-3 font-medium">{row.currency}</th>{[row.invoicedMinor, row.settledPaymentMinor, row.settledRefundMinor, row.outstandingMinor, row.unallocatedAdvanceMinor].map((amount, index) => <td key={index} className="whitespace-nowrap px-4 py-3">{money(amount, row.currency, language)}</td>)}</tr>)}
    </Table>}
    {value.invoices.length > 0 && <Table de={de} label={de ? 'Offene Beträge je gestellter Rechnung' : 'Outstanding amounts by issued invoice'} headers={[de ? 'Rechnung' : 'Invoice', de ? 'Bruttobetrag' : 'Gross amount', de ? 'Zahlungen' : 'Payments', de ? 'Rückerstattungen' : 'Refunds', de ? 'Gutschriften' : 'Credits', de ? 'Offener Betrag' : 'Outstanding', de ? 'Stand' : 'Status']}>
      {value.invoices.map(row => { const source = data.invoices.find(event => event.eventId === row.invoiceSourceEventId), number = source?.kind === 'INVOICE' ? source.payload.invoiceNumber : null;
        return <tr key={row.invoiceSourceEventId}><th scope="row" className="px-4 py-3 font-medium">{number ?? (de ? 'Beleg prüfen' : 'Review evidence')}</th>{[row.grossMinor, row.paidMinor, row.refundedMinor, row.creditMinor, row.outstandingMinor].map((amount, index) => <td className="whitespace-nowrap px-4 py-3" key={index}>{money(amount, row.currency, language)}</td>)}<td className="px-4 py-3"><StatusChip tone={row.outstandingMinor === 0 ? 'success' : 'warning'}>{row.outstandingMinor === 0 ? de ? 'Rechnung ausgeglichen' : 'Invoice balanced' : row.paidMinor > row.refundedMinor ? de ? 'Teilzahlung bestätigt' : 'Partial payment confirmed' : de ? 'Betrag offen' : 'Amount outstanding'}</StatusChip></td></tr>;
      })}
    </Table>}
    <p className="max-w-prose text-sm text-stone-600">{de ? 'Die Übersicht bezieht sich auf bereits gestellte Rechnungen. Noch nicht zugeordnete Zahlungen bleiben separat ausgewiesen; weitere vereinbarte Leistungs- und Zahlungsabschnitte stehen im Vertrag.' : 'This overview covers invoices already issued. Unallocated payments remain separate; the contract contains any further agreed delivery and payment stages.'}</p>
  </div>;
}

export function WebsiteSalesCommercePanel(props: Props) {
  return <CommercePanel key={`${props.actorId}:${props.workspaceId}:${props.workflowId}:${props.projectId}:${props.companyId}:${props.locationId}`} {...props}/>;
}
function CommercePanel({ workspaceId, actorId, workflowId, language, sourceRevision = 0, blocked = false, onStateChanged, ...scope }: Props) {
  const copy = websiteSalesCommerceCopy(language), de = language === 'de', prefix = useId(), mounted = useRef(false), dirty = useRef(false), readGeneration = useRef(0);
  const [stage, setStage] = useState<Stage>('offer'), [attempt, setAttempt] = useState(0), [result, setResult] = useState<{ attempt: number; sourceRevision: number; data: WebsiteSalesCommerceRead } | null>(null);
  const [failed, setFailed] = useState(false), [now, setNow] = useState(() => Date.now()), [busy, setBusy] = useState(false), [message, setMessage] = useState<'saved' | 'denied' | 'notFound' | null>(null), [, render] = useState(0);
  const scopeKey = JSON.stringify(scope), data = result?.data ?? null, fresh = Boolean(result && result.attempt === attempt && result.sourceRevision === sourceRevision && !failed);
  const pending = commercePending(workspaceId, actorId), locked = blocked || busy || Boolean(pending) || !fresh;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15000); return () => clearInterval(timer); }, []);
  useEffect(() => { const handler = (event: BeforeUnloadEvent) => { if (dirty.current || commercePending(workspaceId, actorId)) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler); }, [workspaceId, actorId]);
  useEffect(() => subscribeCommercePending(() => render(value => value + 1)), []);
  useEffect(() => {
    const controller = new AbortController(), ticket = ++readGeneration.current, selected = JSON.parse(scopeKey) as WebsiteSalesCommerceScope;
    const original = commercePending(workspaceId, actorId);
    void readCommerce(workspaceId, selected, workflowId, controller.signal).then(value => {
      if (controller.signal.aborted || ticket !== readGeneration.current) return;
      setResult({ data: value, attempt, sourceRevision }); setFailed(false);
      if (original && !original.damaged) markCommerceCurrentRead(workspaceId, actorId, original.command, selected);
    }).catch(() => { if (!controller.signal.aborted && ticket === readGeneration.current) setFailed(true); });
    return () => { controller.abort(); readGeneration.current = ticket + 1; };
  }, [workspaceId, actorId, workflowId, scopeKey, attempt, sourceRevision]);
  function refresh() { readGeneration.current++; setAttempt(value => value + 1); }
  const call: CommerceCall = async (operation: WebsiteSalesCommerceOperation, payload: Record<string, unknown>) => {
    if (locked || !data) return false;
    const eligibility = data.actionEligibility.find(row => row.operation === operation);
    if (!eligibility?.eligible) return false;
    setBusy(true); setMessage(null); readGeneration.current++;
    try {
      await writeCommerce(workspaceId, actorId, { contractVersion: websiteSalesCommerceContract, operation, ...scope, workflowId,
        expectedVersion: data.version, expectedWorkflowVersion: data.workflowVersion, idempotencyKey: crypto.randomUUID(), correlationId: crypto.randomUUID(), payload });
      if (!mounted.current) return false;
      dirty.current = false; setMessage('saved'); refresh(); onStateChanged?.(); return true;
    } catch (error) {
      if (mounted.current && !(error instanceof CommerceBrowserError && error.outcome === 'UNKNOWN')) setMessage('denied');
      if (mounted.current) refresh(); return false;
    } finally { if (mounted.current) setBusy(false); }
  };
  async function checkOriginal() {
    const original = commercePending(workspaceId, actorId); if (!original || original.damaged || busy) return;
    setBusy(true); readGeneration.current++;
    try {
      const selected = { projectId: original.command.projectId, companyId: original.command.companyId, locationId: original.command.locationId };
      await readCommerce(workspaceId, selected, original.command.workflowId);
      if (mounted.current) markCommerceCurrentRead(workspaceId, actorId, original.command, selected);
    } catch { if (mounted.current) setMessage('denied'); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function recover(retry: boolean) {
    const original = commercePending(workspaceId, actorId); if (!original || original.damaged || busy) return;
    setBusy(true); setMessage(null); readGeneration.current++;
    try {
      const outcome = retry ? (await writeCommerce(workspaceId, actorId, original.command, true), 'COMMITTED') : await reconcileCommerce(workspaceId, actorId);
      if (mounted.current) { setMessage(outcome === 'NOT_FOUND' ? 'notFound' : 'saved'); refresh(); if (outcome === 'COMMITTED') onStateChanged?.(); }
    } catch { if (mounted.current) setMessage('denied'); }
    finally { if (mounted.current) setBusy(false); }
  }
  const newestContract = data?.contracts.toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  const newestOffer = data?.offerChoices[0];
  // Inspect the newest invoice event first; a later void must not fall back to an older issued event.
  const newestInvoice = data ? commerceNewestInvoice(data) : null;
  const invoiceUncertain = data && (data.sourceAssessment.status !== 'READY' || data.invoices.some(event => data.sourceAssessment.invalidatedEventIds.includes(event.eventId)));
  const settledInvoices = data && commercePaymentSummary(data) === 'BALANCED';
  const lastSubscription = data?.subscriptions.toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  const verifiedSubscription = data && lastSubscription ? commerceSubscriptionSource(data, lastSubscription) : null;
  const formProps = data ? { data, language, locked, now } : null;
  return <Surface className="min-w-0 space-y-5" data-website-sales-commerce data-testid="website-sales-commerce" aria-labelledby={`${prefix}-title`} onInputCapture={event => { if (event.target instanceof Element && event.target.closest('form')) dirty.current = true; }}>
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="max-w-prose"><h3 id={`${prefix}-title`} className="text-xl font-semibold text-slate-950">{copy.title}</h3><p className="mt-2 text-sm leading-6 text-stone-600">{copy.intro}</p></div><Button variant="secondary" disabled={busy} onClick={refresh}>{copy.refresh}</Button></div>
    {pending && <Notice tone="warning" announce="polite"><p>{pending.damaged ? copy.damaged : copy.unknown}</p>{!pending.damaged && <div className="mt-3 flex flex-wrap gap-3"><Button variant="secondary" disabled={busy} onClick={() => void checkOriginal()}>{copy.checkOriginal}</Button><Button variant="secondary" disabled={busy || !pending.currentRead} onClick={() => void recover(false)}>{copy.reconcile}</Button>{pending.retryAllowed && <Button disabled={busy || !pending.currentRead} onClick={() => void recover(true)}>{copy.retryOriginal}</Button>}</div>}</Notice>}
    {busy && <p role="status" className="text-sm text-stone-600">{copy.saving}</p>}
    {message && <Notice tone={message === 'saved' ? 'success' : message === 'denied' ? 'danger' : 'warning'} announce="polite">{copy[message]}</Notice>}
    {failed && <Notice tone="danger" announce="polite">{copy.loadError}</Notice>}
    {!data && !failed && <p role="status" className="text-sm text-stone-600">{copy.loading}</p>}
    {data && <>
      {!fresh && !failed && <p role="status" className="text-sm text-stone-600">{copy.loading}</p>}
      <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5" data-testid="commerce-stages">{([
        ['offer', newestOffer ? newestOffer.status === 'ACCEPTED' ? de ? 'Vom Kunden angenommen' : 'Accepted by the customer' : statusText(newestOffer.status, de) : copy.unknownValue],
        ['contract', newestContract ? statusText(commerceContractStatus(data, newestContract, now), de) : copy.unknownValue],
        ['delivery', data.deliveryAcceptances.length ? copy.manualProof : copy.pendingProof],
        ['invoice', invoiceUncertain ? statusText('UNKNOWN', de) : settledInvoices ? de ? 'Gestellte Rechnungen ausgeglichen' : 'Issued invoices balanced' : newestInvoice?.kind === 'INVOICE' ? newestInvoice.confidence === 'PROVIDER_VERIFIED' ? statusText(newestInvoice.payload.status, de) : copy.manualProof : data.invoiceRequests.length ? statusText(data.invoiceRequests[0].payload.status, de) : copy.pendingProof],
        ['subscription', lastSubscription ? verifiedSubscription ? statusText(verifiedSubscription.payload.status, de) : copy.manualProof : copy.pendingProof],
      ] as const).map(([key, value]) => <div className="min-w-0 rounded-lg border border-stone-200 bg-stone-50 p-3" key={key}><dt className="text-sm font-medium text-slate-950">{copy.stageLabels[key]}</dt><dd className="mt-2 break-words text-sm text-stone-600">{value}</dd></div>)}</dl>
      <details className="rounded-lg border border-stone-200 p-4"><summary className="min-h-11 cursor-pointer py-2 font-medium">{de ? 'Verbindungen und Voraussetzungen' : 'Connections and requirements'}</summary><div className="mt-3 space-y-4"><ul className="space-y-2 text-sm">{data.sourceConnections.map(connection => <li key={`${connection.reference}:${connection.type}`} className="flex flex-wrap items-center justify-between gap-2"><span>{connection.provider} · {connection.type === 'ACCOUNTING' ? de ? 'Buchhaltung' : 'Accounting' : connection.type === 'SIGNATURE' ? de ? 'Unterschrift' : 'Signature' : connection.type === 'DELIVERY' ? de ? 'Versand' : 'Delivery' : connection.type === 'PAYMENT' ? de ? 'Zahlung' : 'Payment' : de ? 'Betreuung' : 'Service'}</span><Status value={connection.status} de={de}/></li>)}</ul>{!data.sourceConnections.length && <p className="text-sm text-stone-600">{copy.unavailable}</p>}{data.blockers.length > 0 && <ul className="list-disc space-y-2 pl-5 text-sm">{data.blockers.map((blocker, index) => <li key={`${blocker.code}:${index}`}>{reasonText(blocker.code, de)}<details><summary className="min-h-11 cursor-pointer py-2 text-xs">{de ? 'Bezug anzeigen' : 'Show reference'}</summary><p className="break-words">{blocker.reference ?? blocker.code}</p></details></li>)}</ul>}</div></details>
      <Field htmlFor={`${prefix}-stage`} label={de ? 'Schritt in der Abschlussakte' : 'Closing record section'}><Select id={`${prefix}-stage`} className="min-h-11 w-full sm:max-w-sm" value={stage} onChange={event => setStage(event.target.value as Stage)}>{Object.entries(copy.stageLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select></Field>
      {formProps && <div className="space-y-5 border-t border-stone-200 pt-5" data-commerce-section={stage}>
        {stage === 'offer' && <OfferActions {...formProps} call={call}/>}
        {stage === 'contract' && <><ContractActions {...formProps} call={call}/><div className="space-y-3 border-t border-stone-200 pt-5"><h4 className="font-semibold">{de ? 'Gespeicherte Vertragsfassungen' : 'Stored contract versions'}</h4>{!data.contracts.length && <p className="text-sm text-stone-600">{copy.noRecords}</p>}{data.contracts.map(contract => <details key={`${contract.id}:${contract.version}`} className="rounded-lg border border-stone-200 p-4"><summary className="min-h-11 cursor-pointer py-2">{contract.payload.title} · {de ? 'Fassung' : 'Version'} {contract.version}</summary><div className="space-y-3 text-sm"><Status value={commerceContractStatus(data, contract, now)} de={de}/><p>{contract.payload.recipientEmail} · {formatSalesMinor(contract.payload.financial.grossMinor, language)} {de ? 'brutto' : 'gross'}</p><article className="max-h-96 overflow-auto whitespace-pre-wrap break-words p-1" tabIndex={0} aria-label={de ? 'Gespeicherter Vertragstext' : 'Stored contract text'}>{contract.payload.body}</article></div></details>)}</div></>}
        {stage === 'delivery' && <><DeliveryActions {...formProps} call={call}/><SourceEvents language={language} assessment={data.sourceAssessment} events={data.sourceEvents.filter(event => event.kind === 'DELIVERY_ACCEPTANCE' || event.kind === 'SIGNATURE')}/></>}
        {stage === 'invoice' && <><FinancialPosition data={data} language={language}/><InvoiceActions {...formProps} call={call}/><div className="space-y-3 border-t border-stone-200 pt-5"><h4 className="font-semibold">{de ? 'Rechnungsanforderungen' : 'Invoice requests'}</h4>{data.invoiceRequests.length ? <Table de={de} label={de ? 'Rechnungsanforderungen' : 'Invoice requests'} headers={[de ? 'Fassung' : 'Version', de ? 'Betrag brutto' : 'Gross amount', de ? 'Status' : 'Status', de ? 'Teilbeträge' : 'Installments']}>{data.invoiceRequests.map(row => <tr key={`${row.id}:${row.version}`}><td className="px-4 py-3">{row.version}</td><td className="whitespace-nowrap px-4 py-3">{formatSalesMinor(row.payload.financial.grossMinor, language)}</td><td className="px-4 py-3"><Status value={row.payload.status} de={de}/></td><td className="px-4 py-3">{row.payload.installments.map(item => item.label).join(', ')}</td></tr>)}</Table> : <p className="text-sm text-stone-600">{copy.noRecords}</p>}</div><h4 className="font-semibold">{de ? 'Rechnungen, Zahlungen und Korrekturen aus Quellen' : 'Source-confirmed invoices, payments and corrections'}</h4><SourceEvents language={language} assessment={data.sourceAssessment} events={[...data.invoices, ...data.payments]}/></>}
        {stage === 'subscription' && <><SubscriptionActions {...formProps} call={call}/><SourceEvents language={language} assessment={data.sourceAssessment} events={data.sourceEvents.filter(event => event.kind === 'SUBSCRIPTION')}/>{data.subscriptions.length > 0 && <Table de={de} label={de ? 'Betreuungslaufzeiten' : 'Service periods'} headers={[de ? 'Paket' : 'Plan', de ? 'Ursprünglicher Beginn' : 'Original start', de ? 'Laufzeitende' : 'Period end', de ? 'Status' : 'Status']}>{data.subscriptions.map(row => <tr key={`${row.id}:${row.version}`}><td className="px-4 py-3">{row.payload.planKey}</td><td className="px-4 py-3">{new Date(commerceSubscriptionSource(data, row)?.payload.originalServiceStartAt ?? row.payload.originalServiceStartAt).toLocaleDateString(de ? 'de-AT' : 'en-IE')}</td><td className="px-4 py-3">{new Date(commerceSubscriptionSource(data, row)?.payload.periodEndAt ?? row.payload.periodEndAt).toLocaleDateString(de ? 'de-AT' : 'en-IE')}</td><td className="px-4 py-3"><Status value={commerceSubscriptionSource(data, row)?.payload.status ?? row.payload.status} de={de}/><p className="mt-2">{commerceSubscriptionSource(data, row) ? copy.providerProof : copy.manualProof}</p></td></tr>)}</Table>}</>}
        {stage === 'configuration' && <><p className="max-w-prose text-sm text-stone-600">{de ? 'Dieser Bereich hält geprüfte Vorlagen und Abschlussgrundlagen fest. Zugangsdaten und Zahlungszugriffe werden ausschließlich auf dem Server verwaltet.' : 'This section records reviewed templates and closing policies. Credentials and payment access remain server-managed.'}</p><details className="rounded-lg border border-stone-200 p-4"><summary className="min-h-11 cursor-pointer py-2 font-medium">{de ? 'Vertragsvorlage hinterlegen' : 'Register a contract template'}</summary><TemplateForm {...formProps} call={call}/></details><details className="rounded-lg border border-stone-200 p-4"><summary className="min-h-11 cursor-pointer py-2 font-medium">{de ? 'Abschluss- und Rechnungsgrundlage hinterlegen' : 'Register a closing and accounting policy'}</summary><PolicyForm {...formProps} call={call}/></details></>}
      </div>}
      <details className="rounded-lg border border-stone-200 p-4"><summary className="min-h-11 cursor-pointer py-2 font-medium">{de ? 'Verarbeitung und Versandnachweise' : 'Processing and delivery evidence'}</summary><div className="mt-3 space-y-4">{data.outbox.length > 0 ? <Table de={de} label={de ? 'Verarbeitungsvorgänge' : 'Processing operations'} headers={[de ? 'Vorgang' : 'Operation', de ? 'Verarbeitung' : 'Processing', de ? 'Aktualisiert' : 'Updated']}>{data.outbox.map(job => <tr key={job.id}><td className="px-4 py-3">{job.kind === 'OFFER_SEND' ? copy.stageLabels.offer : job.kind === 'CONTRACT_SEND' ? copy.stageLabels.contract : job.kind === 'SIGNATURE_REQUEST' ? de ? 'Unterschrift' : 'Signature' : job.kind === 'ACCOUNTING_INVOICE_REQUEST' ? copy.stageLabels.invoice : copy.stageLabels.subscription}</td><td className="px-4 py-3"><Status value={job.status} de={de}/></td><td className="px-4 py-3">{new Date(job.updatedAt).toLocaleString(de ? 'de-AT' : 'en-IE')}</td></tr>)}</Table> : <p className="text-sm text-stone-600">{copy.noRecords}</p>}<SourceEvents language={language} assessment={data.sourceAssessment} events={data.sourceEvents.filter(event => event.kind === 'PROVIDER_DELIVERY')}/></div></details>
    </>}
  </Surface>;
}
