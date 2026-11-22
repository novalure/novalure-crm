'use client';

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Notice } from '@/components/ui/status';
import { commerceContractStatus } from '@/lib/website-sales-commerce-view';
import { formatSalesMinor, parseSalesHundredths } from '@/lib/website-sales-operations-format';
import { websiteSalesCommercePayloadSchemas, type CommerceReference, type WebsiteSalesCommerceOperation, type WebsiteSalesCommerceRead } from '@/lib/website-sales-commerce-types';

export type CommerceCall = (operation: WebsiteSalesCommerceOperation, payload: Record<string, unknown>) => Promise<boolean>;
export type CommerceFormProps = { data: WebsiteSalesCommerceRead; language: string; locked: boolean; now: number; call: CommerceCall };
const control = 'min-h-11 w-full min-w-0';
type FormContext = { prefix: string; errors: Record<string, string>; id: (name: string) => string; input: (name: string) => { id: string; name: string; 'aria-invalid': true | undefined; 'aria-describedby': string | undefined } };
type Choice = { key: string; label: string; disabled?: boolean };
const text = (data: FormData, key: string) => String(data.get(key) ?? '').trim();
const iso = (data: FormData, key: string) => new Date(text(data, key)).toISOString();
const nullableIso = (data: FormData, key: string) => text(data, key) ? iso(data, key) : null;
export const commerceRef = (row: { id: string; version: number; digest: string }): CommerceReference => ({ id: row.id, version: row.version, digest: row.digest });
export const commerceRefKey = (row: CommerceReference) => `${row.id}:${row.version}:${row.digest}`;
const recordCurrent = (row: { validUntil: string | null; revokedAt: string | null }, now: number) => !row.revokedAt && (!row.validUntil || Date.parse(row.validUntil) > now);
const choose = <T,>(rows: T[], key: string, keyFor: (row: T) => string): T => {
  const row = rows.find(value => keyFor(value) === key);
  if (!row) throw Error('COMMERCE_CURRENT_RECORD_REQUIRED');
  return row;
};
function source(data: FormData, prefix: string) {
  return { reference: text(data, `${prefix}.reference`), digest: text(data, `${prefix}.digest`).toLowerCase(), observedAt: iso(data, `${prefix}.observedAt`), validUntil: iso(data, `${prefix}.validUntil`) };
}
async function sha256(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function CommerceField({ ctx, name, label, children, required = true }: { ctx: FormContext; name: string; label: string; children: ReactNode; required?: boolean }) {
  return <Field htmlFor={ctx.id(name)} label={label} required={required} error={ctx.errors[name]} errorId={`${ctx.id(name)}-error`}>{children}</Field>;
}
function StringFields({ ctx, fields }: { ctx: FormContext; fields: { name: string; label: string; type?: 'datetime-local' | 'number'; required?: boolean; maxLength?: number; multiline?: boolean; hash?: boolean; min?: number; max?: number }[] }) {
  return <div className="grid gap-4 md:grid-cols-2">{fields.map(field => <div className={field.multiline ? 'md:col-span-2' : ''} key={field.name}><CommerceField ctx={ctx} name={field.name} label={field.label} required={field.required !== false}>
    {field.multiline ? <Textarea {...ctx.input(field.name)} required={field.required !== false} maxLength={field.maxLength ?? 2000} rows={5} className={control} />
      : <Input {...ctx.input(field.name)} type={field.type ?? 'text'} required={field.required !== false} maxLength={field.hash ? 64 : field.maxLength ?? 2000} pattern={field.hash ? '[a-fA-F0-9]{64}' : undefined} min={field.min} max={field.max} step={field.type === 'number' ? 1 : undefined} className={control} />}
  </CommerceField></div>)}</div>;
}
function Choices({ ctx, name, label, items, language }: { ctx: FormContext; name: string; label: string; items: Choice[]; language: string }) {
  return <CommerceField ctx={ctx} name={name} label={label}><Select {...ctx.input(name)} required className={control}><option value="">{language === 'de' ? 'Bitte auswählen' : 'Choose an item'}</option>{items.map(item => <option value={item.key} disabled={item.disabled} key={item.key}>{item.label}</option>)}</Select></CommerceField>;
}
function SourceFields({ ctx, prefix, label, language }: { ctx: FormContext; prefix: string; label: string; language: string }) {
  const de = language === 'de';
  return <fieldset className="space-y-3 rounded-lg border border-stone-200 p-4"><legend className="px-1 text-sm font-semibold">{label}</legend>
    <StringFields ctx={ctx} fields={[
      { name: `${prefix}.reference`, label: de ? 'Abrufbarer Beleg oder Quellenverweis' : 'Retrievable evidence or source reference', maxLength: 500 },
      { name: `${prefix}.digest`, label: de ? 'Prüfsumme des genauen Belegs (SHA-256)' : 'Exact evidence checksum (SHA-256)', hash: true },
      { name: `${prefix}.observedAt`, label: de ? 'Beleg geprüft am' : 'Evidence checked at', type: 'datetime-local' },
      { name: `${prefix}.validUntil`, label: de ? 'Erneut prüfen bis' : 'Review again by', type: 'datetime-local' },
    ]} />
  </fieldset>;
}

function ActionForm({ data, language, locked, call, operation, title, label, build, children }: CommerceFormProps & {
  operation: WebsiteSalesCommerceOperation; title: string; label: string; build: (data: FormData) => Record<string, unknown> | Promise<Record<string, unknown>>;
  children: (ctx: FormContext) => ReactNode;
}) {
  const prefix = useId().replaceAll(':', ''), summary = useRef<HTMLDivElement>(null), [errors, setErrors] = useState<Record<string, string>>({});
  const de = language === 'de', eligibility = data.actionEligibility.find(row => row.operation === operation);
  const owner = ['register_template', 'configure_policy', 'record_delivery_acceptance', 'record_subscription_terms', 'request_cancellation', 'request_contract_approval', 'revoke_contract_approval'].includes(operation);
  const allowed = (operation === 'approve_contract_step' ? data.canApproveContract : owner ? data.canApproveFacts : data.canWrite) && eligibility?.eligible === true;
  const id = (name: string) => `${prefix}-${name.replaceAll('.', '-')}`;
  const ctx: FormContext = { prefix, errors, id, input: name => ({ id: id(name), name, 'aria-invalid': errors[name] ? true : undefined, 'aria-describedby': errors[name] ? `${id(name)}-error` : undefined }) };
  useEffect(() => { if (Object.keys(errors).length) summary.current?.focus(); }, [errors]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (locked || !allowed) return;
    const form = event.currentTarget, invalid: Record<string, string> = {};
    for (const field of Array.from(form.elements)) {
      if ((field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement) && !field.disabled && !field.validity.valid)
        invalid[field.name] = de ? 'Bitte prüfen Sie dieses Feld.' : 'Please check this field.';
    }
    setErrors(invalid); if (Object.keys(invalid).length) return;
    try {
      const payload = await build(new FormData(form));
      const parsed = websiteSalesCommercePayloadSchemas[operation].safeParse(payload);
      if (!parsed.success) {
        const details: Record<string, string> = {};
        for (const issue of parsed.error.issues) {
          const name = issue.path.join('.');
          details[form.elements.namedItem(name) ? name : '_form'] = issue.message === 'COMMERCE_PAYMENT_TERMS_INVALID' ? de ? 'Die Teilbeträge müssen zusammen genau 100 % ergeben. Prüfen Sie auch die Art und Fälligkeit jedes Teilbetrags.' : 'Installments must total exactly 100%. Also check each installment’s type and due date.' : de ? 'Die Angaben passen noch nicht zu den Voraussetzungen dieses Schritts. Prüfen Sie Belege, Daten und Beträge.' : 'These details do not yet meet this step’s requirements. Check the evidence, dates and amounts.';
        }
        setErrors(details); return;
      }
      if (await call(operation, payload)) form.reset();
    } catch { setErrors({ _form: de ? 'Prüfen Sie die ausgewählten Fassungen, Quellen, Datumsangaben und Beträge.' : 'Check the selected versions, sources, dates and amounts.' }); }
  }
  return <form onSubmit={event => void submit(event)} noValidate className="space-y-4" data-commerce-action={operation}>
    <h4 id={id('title')} tabIndex={-1} className="font-semibold text-slate-950">{title}</h4>
    {Object.keys(errors).length > 0 && <div ref={summary} role="alert" tabIndex={-1} className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-950"><p className="font-semibold">{de ? 'Bitte prüfen Sie die Angaben' : 'Check these details'}</p><ul className="mt-2 list-disc space-y-1 pl-5">{Object.entries(errors).map(([name, message]) => <li key={name}><a className="underline underline-offset-4" href={`#${name === '_form' ? id('title') : id(name)}`}>{message}</a></li>)}</ul></div>}
    {!allowed && <Notice>{de ? 'Dieser Schritt ist für Ihren Zugang oder den aktuellen Stand noch nicht freigegeben. Die Übersicht nennt die fehlenden Voraussetzungen.' : 'This step is not available for your access or the current record. The overview lists the missing requirements.'}</Notice>}
    <fieldset disabled={locked || !allowed} className="min-w-0 space-y-4">{children(ctx)}<Button type="submit" className="min-h-11">{label}</Button></fieldset>
  </form>;
}

export function OfferActions(props: CommerceFormProps) {
  const { data, language } = props, de = language === 'de';
  const rows = data.offers.filter(row => recordCurrent(row, props.now) && row.payload.approvalReference && ['APPROVED', 'QUEUED'].includes(row.payload.status));
  return <ActionForm {...props} operation="queue_offer_delivery" title={de ? 'Freigegebenes Angebot versenden' : 'Send the approved offer'} label={de ? 'Freigegebenen Versand vorbereiten' : 'Prepare the approved delivery'}
    build={form => { const row = choose(rows, text(form, 'offer'), row => commerceRefKey(row.payload.offerRef)); return { offerRef: row.payload.offerRef, approvalReference: row.payload.approvalReference }; }}>
    {ctx => <><p className="text-sm text-stone-600">{de ? 'Der Versand bleibt an die genaue Angebotsfreigabe und den dort genannten Empfänger gebunden. Eine Versandannahme ist noch kein Zustellnachweis.' : 'Delivery remains bound to the exact approved offer and recipient. Provider acceptance is not a delivery receipt.'}</p><Choices ctx={ctx} name="offer" label={de ? 'Freigegebene Angebotsfassung' : 'Approved offer version'} language={language} items={rows.map(row => ({ key: commerceRefKey(row.payload.offerRef), label: `${row.payload.recipientEmail} · ${de ? 'Fassung' : 'Version'} ${row.payload.offerRef.version} · ${formatSalesMinor(row.payload.financial.grossMinor, language)}` }))} /></>}
  </ActionForm>;
}

export function ContractActions(props: CommerceFormProps) {
  const { data, language } = props, de = language === 'de', currentContracts = data.contracts.filter(row => recordCurrent(row, props.now)), templates = data.templates.filter(row => recordCurrent(row, props.now));
  const offers = data.offers.filter(row => recordCurrent(row, props.now) && !['DRAFT', 'REJECTED'].includes(row.payload.status));
  const policies = (data.policies ?? (data.policy ? [data.policy] : [])).filter(row => recordCurrent(row, props.now));
  const pending = data.approvals.filter(row => row.status === 'PENDING' && row.currentChallenge && Date.parse(row.currentChallenge.expiresAt) > props.now);
  const approved = data.approvals.filter(row => row.status === 'APPROVED' && Date.parse(row.expiresAt) > props.now);
  const [selectedApproval, setSelectedApproval] = useState(''), approvalSelectionId=useId();
  const approval = pending.find(row => row.approvalId === selectedApproval), document = currentContracts.find(row => approval && commerceRefKey(commerceRef(row)) === commerceRefKey(approval.documentRef));
  return <div className="space-y-7">
    <ActionForm {...props} operation="prepare_contract" title={de ? 'Vertragsentwurf vorbereiten' : 'Prepare a contract draft'} label={de ? 'Vertragsentwurf vorbereiten' : 'Prepare contract draft'}
      build={form => ({ offerRef: choose(offers, text(form, 'offer'), row => commerceRefKey(row.payload.offerRef)).payload.offerRef, templateRef: commerceRef(choose(templates, text(form, 'template'), row => commerceRefKey(commerceRef(row)))), policyRef: commerceRef(choose(policies, text(form, 'policy'), row => commerceRefKey(commerceRef(row)))) })}>
      {ctx => <><Choices ctx={ctx} name="offer" label={de ? 'Angebotsfassung' : 'Offer version'} language={language} items={offers.map(row => ({ key: commerceRefKey(row.payload.offerRef), label: `${row.payload.recipientEmail} · ${row.payload.offerRef.version}` }))} /><Choices ctx={ctx} name="template" label={de ? 'Geprüfte Vertragsvorlage' : 'Reviewed contract template'} language={language} items={templates.map(row => ({ key: commerceRefKey(commerceRef(row)), label: `${row.payload.title} · ${row.version}` }))} /><Choices ctx={ctx} name="policy" label={de ? 'Freigegebene Abschlussgrundlage' : 'Approved closing policy'} language={language} items={policies.map(row => ({ key: commerceRefKey(commerceRef(row)), label: `${row.payload.title} · ${row.version}` }))} /></>}
    </ActionForm>
    <ActionForm {...props} operation="request_contract_approval" title={de ? 'Vertragsfreigabe anfordern' : 'Request contract approval'} label={de ? 'Freigabe für diese Fassung anfordern' : 'Request approval for this version'} build={form => ({ documentRef: commerceRef(choose(currentContracts, text(form, 'contract'), row => commerceRefKey(commerceRef(row)))) })}>
      {ctx => <Choices ctx={ctx} name="contract" label={de ? 'Genauer Vertragsentwurf' : 'Exact contract draft'} language={language} items={currentContracts.map(row => ({ key: commerceRefKey(commerceRef(row)), label: `${row.payload.title} · ${row.version} · ${row.payload.recipientEmail}` }))} />}
    </ActionForm>
    {data.canApproveContract && <div className="space-y-4 border-t border-stone-200 pt-5"><Field htmlFor={approvalSelectionId} label={de ? 'Offene Vertragsfreigabe' : 'Pending contract approval'}><Select id={approvalSelectionId} value={selectedApproval} onChange={event => setSelectedApproval(event.target.value)} className={control} disabled={props.locked}><option value="">{de ? 'Bitte auswählen' : 'Choose an item'}</option>{pending.map(row => <option key={row.approvalId} value={row.approvalId}>{de ? 'Schritt' : 'Step'} {row.completedSteps + 1}/{row.requiredSteps} · {currentContracts.find(item => item.id === row.documentRef.id)?.payload.title ?? row.documentRef.version}</option>)}</Select></Field>
      {approval && document && approval.currentChallenge && <ActionForm {...props} key={approval.currentChallenge.challengeId} operation="approve_contract_step" title={`${de ? 'Vertragsfreigabe' : 'Contract approval'} ${approval.currentChallenge.stepNumber}/${approval.requiredSteps}`} label={de ? 'Diesen Freigabeschritt bestätigen' : 'Confirm this approval step'} build={() => ({ approvalId: approval.approvalId, challengeId: approval.currentChallenge!.challengeId, stepNumber: approval.currentChallenge!.stepNumber, documentRef: approval.documentRef })}>
        {ctx => <><div className="rounded-lg border border-stone-200 bg-white p-4 text-sm"><p className="font-semibold">{document.payload.title}</p><p>{document.payload.recipientEmail}</p><p>{formatSalesMinor(document.payload.financial.grossMinor, language)} {de ? 'brutto' : 'gross'}</p><p>{de ? 'Fassung' : 'Version'} {document.version}</p><details className="mt-3"><summary className="min-h-11 cursor-pointer py-2">{de ? 'Exakte Vertragsfassung lesen' : 'Read the exact contract'}</summary><article className="max-h-96 overflow-auto whitespace-pre-wrap break-words py-3" tabIndex={0} aria-label={de ? 'Vertragstext' : 'Contract text'}>{document.payload.body}</article></details></div><label className="flex items-start gap-3 text-sm"><input {...ctx.input('confirmation')} type="checkbox" required className="mt-1 h-5 w-5 shrink-0"/><span>{de ? 'Ich bestätige diese genaue Fassung einschließlich Empfänger, Leistungsumfang, Preis und Zahlungsplan für den angezeigten Freigabeschritt.' : 'I confirm this exact version, including the recipient, scope, price and payment schedule, for the displayed approval step.'}</span></label></>}
      </ActionForm>}
    </div>}
    {(['queue_contract_delivery', 'request_signature'] as const).map(operation => <ActionForm {...props} key={operation} operation={operation} title={operation === 'request_signature' ? de ? 'Unterschrift anfordern' : 'Request a signature' : de ? 'Freigegebenen Vertrag versenden' : 'Send the approved contract'} label={operation === 'request_signature' ? de ? 'Freigegebene Unterschrift anfordern' : 'Request the approved signature' : de ? 'Freigegebenen Versand vorbereiten' : 'Prepare the approved delivery'} build={form => { const value = choose(approved, text(form, 'approval'), row => row.approvalId); return { documentRef: value.documentRef, approvalReference: value.approvalId }; }}>
      {ctx => <Choices ctx={ctx} name="approval" label={de ? 'Gültig freigegebene Vertragsfassung' : 'Currently approved contract version'} language={language} items={approved.map(row => ({ key: row.approvalId, label: `${currentContracts.find(item => item.id === row.documentRef.id)?.payload.title ?? (de ? 'Vertrag' : 'Contract')} · ${row.documentRef.version}` }))} />}
    </ActionForm>)}
    <details className="rounded-lg border border-stone-200 p-4"><summary className="min-h-11 cursor-pointer py-2 font-medium">{de ? 'Vertragsfreigabe widerrufen' : 'Revoke contract approval'}</summary><ActionForm {...props} operation="revoke_contract_approval" title={de ? 'Widerruf dokumentieren' : 'Record a revocation'} label={de ? 'Freigabe widerrufen' : 'Revoke approval'} build={form => { const value = choose(data.approvals, text(form, 'approval'), row => row.approvalId); return { approvalId: value.approvalId, documentRef: value.documentRef, reason: text(form, 'reason') }; }}>
      {ctx => <><Choices ctx={ctx} name="approval" label={de ? 'Betroffene Freigabe' : 'Affected approval'} language={language} items={data.approvals.map(row => ({ key: row.approvalId, label: `${de ? 'Vertragsfassung' : 'Contract version'} ${row.documentRef.version} · ${row.status}` }))} /><StringFields ctx={ctx} fields={[{ name: 'reason', label: de ? 'Grund für den Widerruf' : 'Reason for revocation', multiline: true }]} /></>}
    </ActionForm></details>
  </div>;
}

export function DeliveryActions(props: CommerceFormProps) {
  const { data, language } = props, de = language === 'de', signed = data.contracts.filter(row => recordCurrent(row, props.now) && commerceContractStatus(data, row) === 'SIGNED');
  return <ActionForm {...props} operation="record_delivery_acceptance" title={de ? 'Kundenabnahme der gelieferten Leistung dokumentieren' : 'Record customer acceptance of the delivered work'} label={de ? 'Abnahme mit Beleg dokumentieren' : 'Record acceptance with evidence'} build={form => {
    const contract = choose(signed, text(form, 'contract'), row => commerceRefKey(commerceRef(row))), task = choose(data.eligibleDeliveryTasks, text(form, 'task'), row => commerceRefKey(row.taskRef));
    const offer = data.offers.find(row => commerceRefKey(row.payload.offerRef) === commerceRefKey(contract.payload.offerRef)); if (!offer) throw Error();
    return { contractRef: commerceRef(contract), canonicalDeliveryTaskId: task.taskRef.id, expectedDeliveryTaskVersion: task.taskRef.version, scopeDigest: offer.payload.scopeDigest, sourceReference: source(form, 'source'), acceptedAt: iso(form, 'acceptedAt') };
  }}>
    {ctx => <><p className="text-sm text-stone-600">{de ? 'Die Lieferaufgabe muss im CRM abgeschlossen sein. Ihre dokumentierte Kundenabnahme bleibt als solche erkennbar und ersetzt keine unabhängig bestätigte Quelle.' : 'The delivery task must be complete in the CRM. Your recorded customer acceptance remains identifiable as an operator record and does not replace independent source confirmation.'}</p><Choices ctx={ctx} name="contract" label={de ? 'Unterzeichneter Vertrag' : 'Signed contract'} language={language} items={signed.map(row => ({ key: commerceRefKey(commerceRef(row)), label: `${row.payload.title} · ${row.version}` }))}/><Choices ctx={ctx} name="task" label={de ? 'Abgeschlossene Lieferaufgabe' : 'Completed delivery task'} language={language} items={data.eligibleDeliveryTasks.map(row => ({ key: commerceRefKey(row.taskRef), label: row.title }))}/><StringFields ctx={ctx} fields={[{ name: 'acceptedAt', label: de ? 'Kundenabnahme am' : 'Customer accepted at', type: 'datetime-local' }]}/><SourceFields ctx={ctx} prefix="source" label={de ? 'Beleg der Kundenabnahme' : 'Customer acceptance evidence'} language={language}/></>}
  </ActionForm>;
}

export function InvoiceActions(props: CommerceFormProps) {
  const { data, language } = props, de = language === 'de', contracts = data.contracts.filter(row => recordCurrent(row, props.now) && commerceContractStatus(data, row) === 'SIGNED');
  const [selected, setSelected] = useState(''), [stage, setStage] = useState('DEPOSIT'), invoiceSelectionId=useId();
  const contract = contracts.find(row => commerceRefKey(commerceRef(row)) === selected), policies = data.policies ?? (data.policy ? [data.policy] : []);
  return <div className="space-y-4"><Field htmlFor={invoiceSelectionId} label={de ? 'Unterzeichneter Vertrag für die Rechnung' : 'Signed contract for the invoice'}><Select id={invoiceSelectionId} value={selected} onChange={event => setSelected(event.target.value)} disabled={props.locked} className={control}><option value="">{de ? 'Bitte auswählen' : 'Choose an item'}</option>{contracts.map(row => <option key={commerceRefKey(commerceRef(row))} value={commerceRefKey(commerceRef(row))}>{row.payload.title} · {row.version}</option>)}</Select></Field>
    {contract && <ActionForm {...props} key={selected} operation="prepare_invoice_request" title={de ? 'Rechnung bei der Buchhaltung anfordern' : 'Request an invoice from accounting'} label={de ? 'Rechnungsanforderung vorbereiten' : 'Prepare invoice request'} build={form => {
      const policy = policies.find(row => commerceRefKey(commerceRef(row)) === commerceRefKey(contract.payload.policyRef)); if (!policy) throw Error();
      const acceptance = stage === 'DEPOSIT' ? null : choose(data.deliveryAcceptances.filter(row => commerceRefKey(row.payload.contractRef) === selected), text(form, 'acceptance'), row => commerceRefKey(commerceRef(row)));
      const ids = form.getAll('installments').map(String), allowed = contract.payload.paymentTerms.installments.filter(row => row.kind === stage);
      if (ids.length === 0 || ids.some(id => !allowed.some(row => row.installmentId === id))) throw Error();
      return { contractRef: commerceRef(contract), deliveryAcceptanceRef: acceptance ? commerceRef(acceptance) : null, policyRef: commerceRef(policy), stage, installmentIds: ids };
    }}>
      {ctx => <><p className="text-sm text-stone-600">{de ? 'Hier entsteht eine Anforderung an die Buchhaltung. Eine Rechnungsnummer und ein Zahlungseingang erscheinen erst nach Bestätigung der angebundenen Quelle.' : 'This creates an accounting request. An invoice number and received payment appear only after confirmation from the connected source.'}</p><CommerceField ctx={ctx} name="stage" label={de ? 'Vereinbarter Rechnungsabschnitt' : 'Agreed billing stage'}><Select {...ctx.input('stage')} className={control} value={stage} onChange={event => setStage(event.target.value)}>{(['DEPOSIT', 'MILESTONE', 'BALANCE', 'RECURRING'] as const).map(value => <option key={value} value={value}>{de ? ({ DEPOSIT: 'Anzahlung', MILESTONE: 'Meilenstein', BALANCE: 'Restbetrag', RECURRING: 'Wiederkehrend' })[value] : ({ DEPOSIT: 'Deposit', MILESTONE: 'Milestone', BALANCE: 'Balance', RECURRING: 'Recurring' })[value]}</option>)}</Select></CommerceField>
        <fieldset className="space-y-3"><legend className="text-sm font-semibold">{de ? 'Vertraglich vereinbarte Teilbeträge' : 'Contractually agreed installments'}</legend>{contract.payload.paymentTerms.installments.filter(row => row.kind === stage).map(row => <label key={row.installmentId} className="flex gap-3 text-sm"><input type="checkbox" name="installments" value={row.installmentId} className="mt-1 h-5 w-5 shrink-0"/><span>{row.label} · {(row.percentageBps / 100).toLocaleString(de ? 'de-AT' : 'en-IE')} % · {row.dueOffsetDays} {de ? 'Tage nach dem vereinbarten Ereignis' : 'days after the agreed event'}</span></label>)}</fieldset>
        {stage !== 'DEPOSIT' && <Choices ctx={ctx} name="acceptance" label={de ? 'Belegte Kundenabnahme' : 'Documented customer acceptance'} language={language} items={data.deliveryAcceptances.filter(row => commerceRefKey(row.payload.contractRef) === selected).map(row => ({ key: commerceRefKey(commerceRef(row)), label: new Date(row.payload.acceptedAt).toLocaleString(de ? 'de-AT' : 'en-IE') }))}/>}</>}
    </ActionForm>}
  </div>;
}

export function SubscriptionActions(props: CommerceFormProps) {
  const { data, language } = props, de = language === 'de', signed = data.contracts.filter(row => recordCurrent(row, props.now) && commerceContractStatus(data, row) === 'SIGNED');
  const subscriptions = data.subscriptions.filter(row => recordCurrent(row, props.now));
  return <div className="space-y-7"><ActionForm {...props} operation="record_subscription_terms" title={de ? 'Vereinbarte Betreuung dokumentieren' : 'Record the agreed service terms'} label={de ? 'Betreuungsgrundlage dokumentieren' : 'Record the service basis'} build={form => {
    const contract = choose(signed, text(form, 'contract'), row => commerceRefKey(commerceRef(row)));
    return { contractRef: commerceRef(contract), planKey: text(form, 'plan'), originalServiceStartAt: iso(form, 'originalServiceStartAt'), periodStartAt: iso(form, 'periodStartAt'), periodEndAt: iso(form, 'periodEndAt'), renewalAt: nullableIso(form, 'renewalAt'), cancellationEffectiveAt: nullableIso(form, 'cancellationEffectiveAt'), currency: contract.payload.financial.currency, termsDigest: contract.payload.financial.termsDigest, sourceReference: source(form, 'source') };
  }}>
    {ctx => <><p className="text-sm text-stone-600">{de ? 'Die Laufzeit wird zunächst als dokumentierte Grundlage gespeichert. Eine aktive Betreuung oder Verlängerung braucht die bestätigte Quelle. Der ursprüngliche Leistungsbeginn bleibt auch bei einer Verlängerung erhalten.' : 'Dates are initially recorded as a documented basis. Active service or renewal requires source confirmation. The original service start is retained through renewals.'}</p><Choices ctx={ctx} name="contract" label={de ? 'Unterzeichneter Betreuungsvertrag' : 'Signed service contract'} language={language} items={signed.map(row => ({ key: commerceRefKey(commerceRef(row)), label: `${row.payload.title} · ${row.version}` }))}/><Choices ctx={ctx} name="plan" label={de ? 'Betreuungspaket' : 'Service plan'} language={language} items={[{ key: 'MANAGED', label: de ? 'Betrieb und Wartung' : 'Managed care' }, { key: 'PERFORMANCE', label: de ? 'Leistung und Optimierung' : 'Performance' }, { key: 'CONVERSION', label: de ? 'Conversion-Begleitung' : 'Conversion care' }]}/><StringFields ctx={ctx} fields={[
      { name: 'originalServiceStartAt', label: de ? 'Ursprünglicher Leistungsbeginn' : 'Original service start', type: 'datetime-local' }, { name: 'periodStartAt', label: de ? 'Beginn dieser Laufzeit' : 'Current period start', type: 'datetime-local' }, { name: 'periodEndAt', label: de ? 'Ende dieser Laufzeit' : 'Current period end', type: 'datetime-local' }, { name: 'renewalAt', label: de ? 'Vereinbarter Verlängerungstermin' : 'Agreed renewal date', type: 'datetime-local', required: false }, { name: 'cancellationEffectiveAt', label: de ? 'Dokumentiertes Vertragsende bei Kündigung' : 'Recorded cancellation effective date', type: 'datetime-local', required: false },
    ]}/><SourceFields ctx={ctx} prefix="source" label={de ? 'Beleg der Laufzeit' : 'Service period evidence'} language={language}/></>}
  </ActionForm>
    <ActionForm {...props} operation="propose_renewal" title={de ? 'Verlängerung prüfen' : 'Review a renewal'} label={de ? 'Verlängerungsvorschlag vorbereiten' : 'Prepare renewal proposal'} build={form => ({ subscriptionRef: commerceRef(choose(subscriptions, text(form, 'subscription'), row => commerceRefKey(commerceRef(row)))) })}>{ctx => <Choices ctx={ctx} name="subscription" label={de ? 'Betreuungsfassung' : 'Service version'} language={language} items={subscriptions.map(row => ({ key: commerceRefKey(commerceRef(row)), label: `${row.payload.planKey} · ${row.version}` }))}/>}</ActionForm>
    <details className="rounded-lg border border-stone-200 p-4"><summary className="min-h-11 cursor-pointer py-2 font-medium">{de ? 'Kündigung anfordern' : 'Request cancellation'}</summary><ActionForm {...props} operation="request_cancellation" title={de ? 'Belegte Kündigung weitergeben' : 'Submit an evidenced cancellation'} label={de ? 'Kündigungsanforderung vorbereiten' : 'Prepare cancellation request'} build={form => ({ subscriptionRef: commerceRef(choose(subscriptions, text(form, 'subscription'), row => commerceRefKey(commerceRef(row)))), effectiveAt: iso(form, 'effectiveAt'), sourceReference: source(form, 'source') })}>{ctx => <><Choices ctx={ctx} name="subscription" label={de ? 'Betroffene Betreuung' : 'Affected service'} language={language} items={subscriptions.map(row => ({ key: commerceRefKey(commerceRef(row)), label: `${row.payload.planKey} · ${row.version}` }))}/><StringFields ctx={ctx} fields={[{ name: 'effectiveAt', label: de ? 'Gewünschtes Vertragsende laut Beleg' : 'Requested end date from the evidence', type: 'datetime-local' }]}/><SourceFields ctx={ctx} prefix="source" label={de ? 'Kündigungsbeleg' : 'Cancellation evidence'} language={language}/></>}</ActionForm></details>
  </div>;
}

export function TemplateForm(props: CommerceFormProps) {
  const de = props.language === 'de';
  return <ActionForm {...props} operation="register_template" title={de ? 'Geprüfte Vertragsvorlage hinterlegen' : 'Register a reviewed contract template'} label={de ? 'Vorlagenfassung hinterlegen' : 'Register template version'} build={async form => {
    const content = text(form, 'content');
    return { title: text(form, 'title'), jurisdiction: text(form, 'jurisdiction'), language: text(form, 'language'), content, contentSha256: await sha256(content), allowedVariableKeys: text(form, 'variables').split(/[\s,;]+/).filter(Boolean), legalReviewReference: source(form, 'legal'), validUntil: iso(form, 'validUntil') };
  }}>{ctx => <><p className="text-sm text-stone-600">{de ? 'Verwenden Sie eine tatsächlich geprüfte Vorlage und den passenden Prüfbeleg. Es werden keine Rechtsklauseln oder Zuständigkeiten vorausgefüllt.' : 'Use an actually reviewed template and its supporting review. Legal clauses and jurisdiction are not prefilled.'}</p><StringFields ctx={ctx} fields={[{ name: 'title', label: de ? 'Name der Vorlage' : 'Template title', maxLength: 200 }, { name: 'jurisdiction', label: de ? 'Geprüfter Rechtsraum' : 'Reviewed jurisdiction', maxLength: 100 }, { name: 'content', label: de ? 'Exakter geprüfter Vorlagentext' : 'Exact reviewed template text', multiline: true, maxLength: 100000 }, { name: 'variables', label: de ? 'Freigegebene Platzhalternamen, falls vorhanden' : 'Approved placeholder names, if any', required: false, maxLength: 2500 }, { name: 'validUntil', label: de ? 'Vorlagenfassung gültig bis' : 'Template valid until', type: 'datetime-local' }]}/><Choices ctx={ctx} name="language" label={de ? 'Sprache der Vorlage' : 'Template language'} language={props.language} items={[{ key: 'de', label: 'Deutsch' }, { key: 'en', label: 'English' }]}/><SourceFields ctx={ctx} prefix="legal" label={de ? 'Nachweis der rechtlichen Prüfung' : 'Legal review evidence'} language={props.language}/></>}</ActionForm>;
}

export function PolicyForm(props: CommerceFormProps) {
  const { data, language } = props, de = language === 'de', [installments, setInstallments] = useState(() => [crypto.randomUUID()]);
  const offers = data.offerChoices.filter(row => !['REJECTED', 'CANCELLED'].includes(row.status));
  return <ActionForm {...props} operation="configure_policy" title={de ? 'Abschluss- und Rechnungsgrundlage hinterlegen' : 'Register the closing and accounting policy'} label={de ? 'Geprüfte Grundlage hinterlegen' : 'Register the reviewed policy'} build={form => {
    const offer = choose(offers, text(form, 'offer'), row => commerceRefKey(row.offerRef));
    const netMinor = offer.totalNetMinor, taxMinor = parseSalesHundredths(text(form, 'taxAmount')), grossMinor = netMinor + taxMinor, taxSource = source(form, 'tax');
    if (!Number.isSafeInteger(grossMinor)) throw Error();
    const taxRateBps = parseSalesHundredths(text(form, 'taxRate'));
    return { title: text(form, 'title'), standardTermsReference: source(form, 'terms'), standardTermsDigest: text(form, 'termsDigest').toLowerCase(), signatureAssurance: text(form, 'assurance'), maxInstallments: installments.length,
      accountingEntityReference: text(form, 'entity'), accountingSourceReference: source(form, 'accounting'), offerRef: offer.offerRef,
      financialSnapshot: { currency: offer.currency, netMinor, taxMinor, grossMinor, taxReference: taxSource, termsDigest: text(form, 'termsDigest').toLowerCase() },
      accountingProfile: { issuerLegalName: text(form, 'issuerName'), issuerAddress: text(form, 'issuerAddress'), taxIdentifier: text(form, 'taxIdentifier') || null, currency: 'EUR', taxRateBps, rounding: 'HALF_UP', sourceReference: taxSource },
      paymentTerms: { installments: installments.map(id => { const kind = text(form, `${id}.kind`); return { installmentId: id, label: text(form, `${id}.label`), percentageBps: parseSalesHundredths(text(form, `${id}.percentage`)), dueOffsetDays: Number(text(form, `${id}.days`)), anchor: kind === 'DEPOSIT' ? 'CONTRACT_SIGNED' : 'DELIVERY_ACCEPTED', kind }; }) }, validUntil: iso(form, 'validUntil') };
  }}>{ctx => <><p className="text-sm text-stone-600">{de ? 'Steuern, Rechnungssteller und Zahlungsplan müssen aus den genannten Quellen stammen. Die Teilbeträge müssen zusammen genau 100 % ergeben.' : 'Tax, issuer and payment terms must come from the named evidence. Installments must total exactly 100%.'}</p><Choices ctx={ctx} name="offer" label={de ? 'Zugehörige Angebotsfassung' : 'Related offer version'} language={language} items={offers.map(row => ({ key: commerceRefKey(row.offerRef), label: `${row.recipientEmail} · ${formatSalesMinor(row.totalNetMinor, language)} ${de ? 'netto' : 'net'}` }))}/><StringFields ctx={ctx} fields={[{ name: 'title', label: de ? 'Name dieser Grundlage' : 'Policy title', maxLength: 200 }, { name: 'entity', label: de ? 'Zuständiger Buchhaltungsmandant' : 'Accounting entity reference', maxLength: 200 }, { name: 'issuerName', label: de ? 'Rechtlicher Name des Rechnungsstellers' : 'Legal invoice issuer', maxLength: 200 }, { name: 'issuerAddress', label: de ? 'Anschrift des Rechnungsstellers' : 'Invoice issuer address', maxLength: 1000 }, { name: 'taxIdentifier', label: de ? 'Steuerkennung, soweit zutreffend' : 'Tax identifier, where applicable', maxLength: 100, required: false }, { name: 'taxRate', label: de ? 'Belegter Steuersatz (%)' : 'Evidenced tax rate (%)', maxLength: 8 }, { name: 'taxAmount', label: de ? 'Belegter Steuerbetrag für dieses Angebot (€)' : 'Evidenced tax amount for this offer (€)', maxLength: 18 }, { name: 'termsDigest', label: de ? 'Prüfsumme der genauen Standardkonditionen (SHA-256)' : 'Exact standard terms checksum (SHA-256)', hash: true }, { name: 'validUntil', label: de ? 'Grundlage gültig bis' : 'Policy valid until', type: 'datetime-local' }]}/><Choices ctx={ctx} name="assurance" label={de ? 'Nachgewiesenes Unterschriftsniveau' : 'Required signature assurance'} language={language} items={[{ key: 'PROVIDER_ATTESTED', label: de ? 'Vom Signaturdienst bestätigt' : 'Attested by the signature provider' }, { key: 'ADVANCED', label: de ? 'Fortgeschritten' : 'Advanced' }, { key: 'QUALIFIED', label: de ? 'Qualifiziert' : 'Qualified' }]}/>
    <fieldset className="space-y-4"><legend className="text-sm font-semibold">{de ? 'Freigegebener Zahlungsplan' : 'Approved payment schedule'}</legend>{installments.map((id, index) => <div key={id} className="space-y-3 rounded-lg border border-stone-200 p-4"><p className="text-sm font-medium">{de ? 'Teilbetrag' : 'Installment'} {index + 1}</p><StringFields ctx={ctx} fields={[{ name: `${id}.label`, label: de ? 'Bezeichnung' : 'Label', maxLength: 120 }, { name: `${id}.percentage`, label: de ? 'Anteil am Gesamtbetrag (%)' : 'Share of total (%)', maxLength: 8 }, { name: `${id}.days`, label: de ? 'Tage bis zur Fälligkeit' : 'Days until due', type: 'number', min: 0, max: 3650 }]}/><Choices ctx={ctx} name={`${id}.kind`} label={de ? 'Art des Teilbetrags' : 'Installment type'} language={language} items={[{ key: 'DEPOSIT', label: de ? 'Anzahlung nach Vertragsunterschrift' : 'Deposit after signature' }, { key: 'MILESTONE', label: de ? 'Meilenstein nach Abnahme' : 'Milestone after acceptance' }, { key: 'BALANCE', label: de ? 'Restbetrag nach Abnahme' : 'Balance after acceptance' }, { key: 'RECURRING', label: de ? 'Wiederkehrend nach Abnahme' : 'Recurring after acceptance' }]}/>{installments.length > 1 && <Button type="button" variant="ghost" onClick={() => setInstallments(rows => rows.filter(row => row !== id))}>{de ? 'Teilbetrag entfernen' : 'Remove installment'}</Button>}</div>)}<Button type="button" variant="secondary" disabled={installments.length >= 36} onClick={() => setInstallments(rows => [...rows, crypto.randomUUID()])}>{de ? 'Teilbetrag ergänzen' : 'Add installment'}</Button></fieldset>
    <SourceFields ctx={ctx} prefix="terms" label={de ? 'Freigegebene Standardkonditionen' : 'Approved standard terms'} language={language}/><SourceFields ctx={ctx} prefix="accounting" label={de ? 'Buchhaltungszuordnung' : 'Accounting entity evidence'} language={language}/><SourceFields ctx={ctx} prefix="tax" label={de ? 'Steuer- und Rechnungsstellerprüfung' : 'Tax and issuer evidence'} language={language}/></>}</ActionForm>;
}
