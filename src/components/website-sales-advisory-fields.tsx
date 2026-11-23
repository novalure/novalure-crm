'use client';

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Notice } from '@/components/ui/status';

export type AdvisoryIssue = { path: readonly PropertyKey[]; message: string };
export type AdvisoryFormContext = {
  id: (name: string) => string;
  errors: Record<string, string>;
  input: (name: string) => { id: string; name: string; 'aria-invalid': true | undefined; 'aria-describedby': string | undefined };
};
export type AdvisoryChoice = { value: string; label: string; disabled?: boolean };
const control = 'min-h-11 w-full min-w-0';

export const advisoryText = (form: FormData, name: string) => String(form.get(name) ?? '').trim();
export const advisoryLiteral = (form: FormData, name: string) => String(form.get(name) ?? '');
export const advisoryIso = (form: FormData, name: string) => new Date(advisoryText(form, name)).toISOString();
export async function advisorySha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Presentation only. Server permissions and the shared domain schema decide eligibility and validity. */
export function AdvisoryForm({ action, title, submitLabel, language, allowed, locked, children, build, validate, submit, afterSaved }: {
  action: string; title: string; submitLabel: string; language: string; allowed: boolean; locked: boolean;
  children: (context: AdvisoryFormContext) => ReactNode;
  build: (form: FormData) => Record<string, unknown> | Promise<Record<string, unknown>>;
  validate: (value: unknown) => readonly AdvisoryIssue[];
  submit: (value: Record<string, unknown>) => Promise<boolean>;
  afterSaved?: () => void;
}) {
  const prefix = useId().replaceAll(':', ''), de = language === 'de';
  const summary = useRef<HTMLDivElement>(null), inFlight = useRef(false);
  const [submitting, setSubmitting] = useState(false), [errors, setErrors] = useState<Record<string, string>>({});
  const id = (name: string) => `${prefix}-${name.replaceAll('.', '-')}`;
  const context: AdvisoryFormContext = { id, errors, input: name => ({ id: id(name), name, 'aria-invalid': errors[name] ? true : undefined, 'aria-describedby': errors[name] ? `${id(name)}-error` : undefined }) };
  useEffect(() => { if (Object.keys(errors).length) summary.current?.focus(); }, [errors]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!allowed || locked || inFlight.current) return;
    const form = event.currentTarget, invalid: Record<string, string> = {};
    for (const field of Array.from(form.elements)) {
      if ((field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement) && !field.disabled && !field.validity.valid)
        invalid[field.name] = de ? 'Bitte prüfen Sie dieses Feld.' : 'Please check this field.';
    }
    setErrors(invalid);
    if (Object.keys(invalid).length) return;
    inFlight.current = true; setSubmitting(true);
    try {
      const value = await build(new FormData(form)), issues = validate(value);
      if (issues.length) {
        const details: Record<string, string> = {};
        for (const issue of issues) {
          const name = issue.path.map(String).join('.');
          details[form.elements.namedItem(name) ? name : '_form'] = de ? 'Die Angaben sind noch nicht vollständig oder passen nicht zusammen. Prüfen Sie die ausgewählten Fassungen, Belege und Beträge.' : 'These details are incomplete or do not match. Check the selected versions, evidence and amounts.';
        }
        setErrors(details); return;
      }
      if (await submit(value)) { form.reset(); delete form.dataset.advisoryDirty; afterSaved?.(); }
    } catch {
      setErrors({ _form: de ? 'Bitte prüfen Sie die Eingaben, Datumsangaben und ausgewählten Einträge.' : 'Please check the input, dates and selected records.' });
    } finally { inFlight.current = false; setSubmitting(false); }
  }
  return <form data-advisory-action={action} noValidate onSubmit={event => void save(event)} onInputCapture={event => { event.currentTarget.dataset.advisoryDirty = 'true'; }} className="space-y-4">
    <h4 id={id('title')} tabIndex={-1} className="font-semibold text-slate-950">{title}</h4>
    {Object.keys(errors).length > 0 && <div ref={summary} role="alert" tabIndex={-1} className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-950"><p className="font-semibold">{de ? 'Bitte prüfen Sie die Angaben' : 'Check these details'}</p><ul className="mt-2 list-disc space-y-1 pl-5">{Object.entries(errors).map(([name, message]) => <li key={name}><a className="underline underline-offset-4" href={`#${name === '_form' ? id('title') : id(name)}`}>{message}</a></li>)}</ul></div>}
    {!allowed && <Notice>{de ? 'Dieser Schritt ist für Ihren Zugang oder den aktuellen Stand noch nicht verfügbar. Die Übersicht zeigt die fehlenden Voraussetzungen.' : 'This step is not available for your access or the current record. The overview lists missing requirements.'}</Notice>}
    <fieldset disabled={locked || !allowed || submitting} className="min-w-0 space-y-4">{children(context)}<Button type="submit" className="min-h-11">{submitting ? de ? 'Wird gespeichert …' : 'Saving…' : submitLabel}</Button></fieldset>
  </form>;
}

export function AdvisoryField({ context, name, label, required = true, children, hint }: { context: AdvisoryFormContext; name: string; label: string; required?: boolean; children: ReactNode; hint?: string }) {
  return <Field htmlFor={context.id(name)} label={label} required={required} hint={hint} hintId={hint ? `${context.id(name)}-hint` : undefined} error={context.errors[name]} errorId={`${context.id(name)}-error`}>{children}</Field>;
}
export function AdvisoryFields({ context, fields }: { context: AdvisoryFormContext; fields: {
  name: string; label: string; type?: 'text' | 'email' | 'url' | 'datetime-local' | 'number'; required?: boolean; maxLength?: number;
  multiline?: boolean; rows?: number; hash?: boolean; min?: number; max?: number; decimal?: boolean; hint?: string;
}[] }) {
  return <div className="grid gap-4 md:grid-cols-2">{fields.map(field => <div key={field.name} className={field.multiline ? 'md:col-span-2' : ''}>
    <AdvisoryField context={context} name={field.name} label={field.label} required={field.required !== false} hint={field.hint}>
      {field.multiline ? <Textarea {...context.input(field.name)} aria-describedby={[context.input(field.name)['aria-describedby'], field.hint ? `${context.id(field.name)}-hint` : null].filter(Boolean).join(' ') || undefined} autoComplete="off" required={field.required !== false} maxLength={field.maxLength ?? 4000} rows={field.rows ?? 4} className={control}/>
        : <Input {...context.input(field.name)} aria-describedby={[context.input(field.name)['aria-describedby'], field.hint ? `${context.id(field.name)}-hint` : null].filter(Boolean).join(' ') || undefined} autoComplete="off" spellCheck={field.hash ? false : undefined} type={field.type ?? 'text'} inputMode={field.decimal ? 'decimal' : undefined} required={field.required !== false} pattern={field.hash ? '[a-fA-F0-9]{64}' : undefined} maxLength={field.hash ? 64 : field.maxLength ?? 1000} min={field.min} max={field.max} step={field.type === 'number' ? 1 : undefined} className={control}/>}
    </AdvisoryField>
  </div>)}</div>;
}
export function AdvisoryChoices({ context, name, label, choices, language, required = true, value, onChange }: { context: AdvisoryFormContext; name: string; label: string; choices: AdvisoryChoice[]; language: string; required?: boolean; value?: string; onChange?: (value: string) => void }) {
  return <AdvisoryField context={context} name={name} label={label} required={required}><Select {...context.input(name)} required={required} value={value} onChange={event => onChange?.(event.target.value)} className={control}><option value="">{language === 'de' ? 'Bitte auswählen' : 'Choose an item'}</option>{choices.map(choice => <option key={choice.value} value={choice.value} disabled={choice.disabled}>{choice.label}</option>)}</Select></AdvisoryField>;
}
export function AdvisoryProse({ children }: { children: ReactNode }) {
  return <div className="max-w-prose whitespace-pre-wrap break-words text-sm leading-6 text-stone-700">{children}</div>;
}
export function AdvisoryFacts({ items }: { items: { label: string; value: ReactNode; note?: ReactNode }[] }) {
  return <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">{items.map(item => <div key={item.label} className="min-w-0"><dt className="text-sm font-medium text-slate-950">{item.label}</dt><dd className="mt-1 break-words text-sm text-stone-700">{item.value}{item.note && <p className="mt-1 text-stone-600">{item.note}</p>}</dd></div>)}</dl>;
}
