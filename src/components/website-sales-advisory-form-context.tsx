'use client';

import { useState, type ReactNode } from 'react';
import type { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/status';
import { advisoryPayloadSchemas, websiteSalesAdvisoryOwnerOperations, type AdvisoryRecord, type AdvisoryReference, type AdvisorySource, type WebsiteSalesAdvisoryCommand, type WebsiteSalesAdvisoryRead } from '@/lib/website-sales-advisory-types';
import { AdvisoryChoices, AdvisoryFields, AdvisoryForm, advisoryIso, advisoryText, type AdvisoryFormContext } from './website-sales-advisory-fields';

export type AdvisoryOperation = WebsiteSalesAdvisoryCommand['operation'];
export type AdvisoryCall = (operation: AdvisoryOperation, payload: Record<string, unknown>) => Promise<boolean>;
export type AdvisoryFormProps = { data: WebsiteSalesAdvisoryRead; language: string; locked: boolean; now: number; call: AdvisoryCall };
export const advisoryRef = (row: Pick<AdvisoryRecord, 'id' | 'version' | 'digest'>): AdvisoryReference => ({ id: row.id, version: row.version, digest: row.digest });
export const advisoryRefKey = (row: AdvisoryReference) => `${row.id}:${row.version}:${row.digest}`;
export function advisorySelected<T>(rows: readonly T[], value: string, key: (row: T) => string): T {
  const row = rows.find(item => key(item) === value); if (!row) throw Error('ADVISORY_CURRENT_SELECTION_REQUIRED'); return row;
}
export const advisoryLines = (form: FormData, field: string) => advisoryText(form, field).split(/\r?\n/).map(value => value.trim()).filter(Boolean);
export function advisoryRecords<T>(data: WebsiteSalesAdvisoryRead, kind: AdvisoryRecord['kind'], schema: z.ZodType<T>, now: number): AdvisoryRecord<T>[] {
  return data.records.filter(row => row.kind === kind && !row.revokedAt && (!row.validUntil || Date.parse(row.validUntil) > now) && data.recordStates.some(state => state.current && advisoryRefKey(state.recordRef) === advisoryRefKey(advisoryRef(row)))).flatMap(row => {
    const parsed = schema.safeParse(row.payload); return parsed.success ? [{ ...row, payload: parsed.data }] : [];
  });
}
export function AdvisoryAction(props: AdvisoryFormProps & { operation: AdvisoryOperation; title: string; submitLabel: string;
  build: (form: FormData) => Record<string, unknown> | Promise<Record<string, unknown>>; children: (context: AdvisoryFormContext) => ReactNode; afterSaved?: () => void }) {
  const eligibility = props.data.actionEligibility.find(row => row.operation === props.operation), owner = (websiteSalesAdvisoryOwnerOperations as readonly string[]).includes(props.operation);
  return <AdvisoryForm action={props.operation} title={props.title} submitLabel={props.submitLabel} language={props.language} locked={props.locked}
    allowed={eligibility?.eligible === true && (owner ? props.data.canApproveFacts : props.data.canWrite)} build={props.build} afterSaved={props.afterSaved}
    validate={value => { const { resourceGrants: ignored, ...payload } = value as Record<string, unknown>; void ignored; const parsed = advisoryPayloadSchemas[props.operation].safeParse(payload); return parsed.success ? [] : parsed.error.issues; }} submit={value => props.call(props.operation, value)}>{props.children}</AdvisoryForm>;
}
export function AdvisoryRefChoice({ context, name, label, choices, language, required = true }: { context: AdvisoryFormContext; name: string; label: string; choices: readonly { ref: AdvisoryReference; label: string }[]; language: string; required?: boolean }) {
  return <AdvisoryChoices context={context} name={name} label={label} language={language} required={required} choices={choices.map(row => ({ value: advisoryRefKey(row.ref), label: row.label }))}/>;
}
export function AdvisoryChecks({ context, name, label, choices, language }: { context: AdvisoryFormContext; name: string; label: string; choices: readonly { value: string; label: string }[]; language: string }) {
  return <fieldset className="min-w-0 space-y-2"><legend className="mb-2 text-sm font-semibold text-slate-950">{label}</legend>{choices.length ? <div className="max-h-64 space-y-2 overflow-auto rounded-lg border border-stone-200 p-3" tabIndex={0} aria-label={label}>{choices.map(row => <label key={row.value} className="flex min-h-11 items-start gap-3 py-2 text-sm"><input type="checkbox" name={name} value={row.value} className="mt-1 h-5 w-5 shrink-0"/><span className="break-words">{row.label}</span></label>)}</div> : <p className="text-sm text-stone-600">{language === 'de' ? 'Noch keine passenden freigegebenen Einträge verfügbar.' : 'No suitable approved records are available yet.'}</p>}{context.errors[name] && <p id={`${context.id(name)}-error`} className="text-sm text-red-800">{context.errors[name]}</p>}</fieldset>;
}

export function readAdvisorySources(form: FormData, prefix: string, data: WebsiteSalesAdvisoryRead): AdvisorySource[] {
  const selected = form.getAll(`${prefix}.sourceIds`).map(String).map(id => advisorySelected(data.choices.sources, id, row => row.id));
  if (form.get(`${prefix}.manual`) === 'on') {
    const basis = advisoryText(form, `${prefix}.basis`);
    if (basis !== 'OPERATOR_RECORDED' && basis !== 'CUSTOMER_STATEMENT_RECORDED') throw Error('ADVISORY_RECORDED_SOURCE_ONLY');
    selected.push({ id: crypto.randomUUID(), reference: advisoryText(form, `${prefix}.reference`), digest: advisoryText(form, `${prefix}.digest`).toLowerCase(), basis,
      observedAt: advisoryIso(form, `${prefix}.observedAt`), validUntil: advisoryIso(form, `${prefix}.validUntil`) });
  }
  if (!selected.length || selected.length > 20 || new Set(selected.map(row => row.id)).size !== selected.length) throw Error('ADVISORY_SOURCE_SELECTION_REQUIRED');
  return selected;
}
export function readAdvisorySingleSource(form: FormData, prefix: string, data: WebsiteSalesAdvisoryRead): AdvisorySource {
  const sources = readAdvisorySources(form, prefix, data); if (sources.length !== 1) throw Error('ADVISORY_ONE_SOURCE_REQUIRED'); return sources[0];
}
export function AdvisorySources({ context, prefix, label, data, language }: { context: AdvisoryFormContext; prefix: string; label: string; data: WebsiteSalesAdvisoryRead; language: string }) {
  const [manual, setManual] = useState(false), de = language === 'de';
  return <fieldset className="min-w-0 space-y-4 rounded-lg border border-stone-200 p-4"><legend className="px-1 text-sm font-semibold">{label}</legend>
    {data.choices.sources.length > 0 && <AdvisoryChecks context={context} name={`${prefix}.sourceIds`} label={de ? 'Vorhandene Belege verwenden' : 'Use existing evidence'} language={language} choices={data.choices.sources.map(row => ({ value: row.id, label: row.reference }))}/>}
    <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" name={`${prefix}.manual`} checked={manual} onChange={event => setManual(event.target.checked)} className="h-5 w-5 shrink-0"/><span>{de ? 'Einen weiteren Beleg dokumentieren' : 'Record additional evidence'}</span></label>
    {!data.choices.sources.length && !manual && <Notice>{de ? 'Fügen Sie einen nachvollziehbaren Beleg hinzu. Leere oder unbekannte Angaben werden nicht als bestätigte Tatsachen behandelt.' : 'Add traceable evidence. Missing or unknown details are not treated as confirmed facts.'}</Notice>}
    {manual && <><AdvisoryChoices context={context} name={`${prefix}.basis`} label={de ? 'Art der dokumentierten Angabe' : 'Type of recorded information'} language={language} choices={[{ value: 'OPERATOR_RECORDED', label: de ? 'Intern dokumentierte Grundlage' : 'Internally recorded basis' }, { value: 'CUSTOMER_STATEMENT_RECORDED', label: de ? 'Dokumentierte Kundenaussage' : 'Recorded customer statement' }]}/>
      <AdvisoryFields context={context} fields={[{ name: `${prefix}.reference`, label: de ? 'Abrufbarer Beleg oder Quellenverweis' : 'Retrievable evidence or source reference', maxLength: 500 }, { name: `${prefix}.digest`, label: de ? 'Prüfsumme des genauen Belegs (SHA-256)' : 'Exact evidence checksum (SHA-256)', hash: true },
        { name: `${prefix}.observedAt`, label: de ? 'Beleg geprüft am' : 'Evidence checked at', type: 'datetime-local' }, { name: `${prefix}.validUntil`, label: de ? 'Erneut prüfen bis' : 'Review again by', type: 'datetime-local' }]}/>
      <p className="max-w-prose text-sm text-stone-600">{de ? 'Diese Angabe bleibt als dokumentiert erkennbar. Sie wird dadurch nicht zu einer unabhängig bestätigten Kundenhandlung.' : 'This information remains identified as recorded. It does not become an independently confirmed customer action.'}</p>
    </>}
  </fieldset>;
}
export function AdvisoryAddRow({ label, count, maximum, add }: { label: string; count: number; maximum: number; add: () => void }) {
  return <Button type="button" variant="secondary" disabled={count >= maximum} onClick={add}>{label}</Button>;
}
