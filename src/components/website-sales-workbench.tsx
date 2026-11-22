"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { Surface } from "@/components/ui/surface";
import { Notice, StatusChip } from "@/components/ui/status";
import { getWebsiteSalesCopy } from "@/lib/website-sales-copy";
import { commandWebsiteSalesWorkbench, readWebsiteSalesWorkbench, subscribeWebsiteSalesPending, websiteSalesMarkCurrentRead, websiteSalesPending,
  WebsiteSalesBrowserError, type WebsiteSalesBrowserCommand } from "@/lib/website-sales-workbench-client";
import type { WebsiteProspectInput } from "@/lib/website-prospect";
import { studioPending, subscribeStudioPending } from "@/lib/website-sales-studio-client";
import { lifecyclePending, subscribeLifecyclePending, writeLifecycle } from "@/lib/website-sales-lifecycle-client";
import { salesOperationsPending, subscribeSalesOperationsPending } from "@/lib/website-sales-operations-client";
import { enablementPending, subscribeEnablementPending } from '@/lib/website-sales-enablement-client';
import { commercePending, subscribeCommercePending } from '@/lib/website-sales-commerce-client';
import { discoveryPending } from '@/lib/website-sales-discovery-client';

const WebsiteSalesStudio = dynamic(() => import("@/components/website-sales-studio").then(module => module.WebsiteSalesStudio));
const WebsiteSalesLifecyclePanel = dynamic(() => import("@/components/website-sales-lifecycle-panel").then(module => module.WebsiteSalesLifecyclePanel));
const WebsiteSalesOperationsPanel = dynamic(() => import("@/components/website-sales-operations-panel").then(module => module.WebsiteSalesOperationsPanel), { ssr: false });
const WebsiteSalesEnablementPanel=dynamic(()=>import('@/components/website-sales-enablement-panel').then(module=>module.WebsiteSalesEnablementPanel),{ssr:false});
const WebsiteSalesCommercePanel=dynamic(()=>import('@/components/website-sales-commerce-panel').then(module=>module.WebsiteSalesCommercePanel),{ssr:false});
const WebsiteSalesDailyPanel=dynamic(()=>import('@/components/website-sales-enablement-panel').then(module=>module.WebsiteSalesDailyPanel),{ssr:false});
const WebsiteSalesDiscoveryPanel=dynamic(()=>import('@/components/website-sales-discovery-panel').then(module=>module.WebsiteSalesDiscoveryPanel),{ssr:false});
import type { WebsiteSalesWorkbenchCompany, WebsiteSalesWorkbenchContact, WebsiteSalesWorkbenchDetailResponse,
  WebsiteSalesWorkbenchLocationItem, WebsiteSalesWorkbenchPage, WebsiteSalesWorkbenchProject } from "@/lib/website-sales-workbench-types";

type Copy = ReturnType<typeof getWebsiteSalesCopy>;
type Errors = Record<string, string>;
type Scope = { projectId: string; companyId: string; locationId: string };
const controlClass = "min-h-11 w-full min-w-0";
const pageEmpty: WebsiteSalesWorkbenchPage = { limit: 25, hasMore: false, nextCursor: null };

function useList<T>(workspaceId: string, view: string, query: Record<string, string>, enabled = true) {
  const scope = JSON.stringify([workspaceId, view, query]);
  const [request, setRequest] = useState({ scope, attempt: 0, cursor: "" });
  const [result, setResult] = useState<{ scope: string; attempt: number; items: T[]; page: WebsiteSalesWorkbenchPage; canWrite: boolean; failed: boolean } | null>(null);
  const attempt = request.scope === scope ? request.attempt : 0;
  const cursor = request.scope === scope ? request.cursor : "";
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const [, , parameters] = JSON.parse(scope) as [string, string, Record<string, string>];
    void readWebsiteSalesWorkbench(workspaceId, { ...parameters, view, ...(cursor ? { cursor } : {}) }, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      if (!Array.isArray(value.items)) throw new Error();
      setResult(previous => ({ scope, attempt, items: cursor && previous?.scope === scope && previous.attempt === attempt
        ? [...previous.items, ...value.items as T[]] : value.items as T[], page: value.page as WebsiteSalesWorkbenchPage,
        canWrite: value.canWrite === true, failed: false }));
    }).catch(() => { if (!controller.signal.aborted) setResult({ scope, attempt, items: [], page: pageEmpty, canWrite: false, failed: true }); });
    return () => controller.abort();
  }, [workspaceId, scope, view, enabled, attempt, cursor]);
  const current = enabled && result?.scope === scope && result.attempt === attempt ? result : null;
  return { items: current?.items ?? [], page: current?.page ?? pageEmpty, canWrite: current?.canWrite ?? false,
    loading: enabled && !current, failed: current?.failed ?? false,
    refresh: () => setRequest(previous => ({ scope, cursor: "", attempt: previous.scope === scope ? previous.attempt + 1 : 1 })),
    more: () => { if (current?.page.nextCursor) setRequest({ scope, attempt, cursor: current.page.nextCursor }); },
  };
}

function useDetail(workspaceId: string, scope: Scope) {
  const scopeKey = JSON.stringify([workspaceId, scope]);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; attempt: number; detail: WebsiteSalesWorkbenchDetailResponse | null; failed: boolean } | null>(null);
  const enabled = Boolean(scope.projectId && scope.companyId && scope.locationId);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const [, parameters] = JSON.parse(scopeKey) as [string, Scope];
    void readWebsiteSalesWorkbench(workspaceId, { view: "detail", ...parameters }, controller.signal).then(value => {
      if (!controller.signal.aborted) setResult({ key: scopeKey, attempt, detail: value as unknown as WebsiteSalesWorkbenchDetailResponse, failed: false });
    }).catch(() => { if (!controller.signal.aborted) setResult({ key: scopeKey, attempt, detail: null, failed: true }); });
    return () => controller.abort();
  }, [workspaceId, scopeKey, enabled, attempt]);
  const current = enabled && result?.key === scopeKey && result.attempt === attempt ? result : null;
  // Keep the same authorized scope mounted while refreshing; all writes above remain disabled until the read completes.
  return { detail: current?.detail ?? (enabled && result?.key === scopeKey ? result.detail : null), loading: enabled && !current, failed: current?.failed ?? false, refresh: () => setAttempt(value => value + 1) };
}

function FormErrors({ errors, copy }: { errors: Errors; copy: Copy }) {
  const summary = useRef<HTMLDivElement>(null);
  useEffect(() => { if (Object.keys(errors).length) summary.current?.focus(); }, [errors]);
  return Object.keys(errors).length ? <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-950" ref={summary} role="alert" tabIndex={-1}>
    <h4 className="font-semibold">{copy.errorTitle}</h4><ul className="mt-2 list-disc space-y-1 pl-5">{Object.entries(errors).map(([id, message]) => <li key={id}><a className="underline underline-offset-2" href={`#${id}`}>{message}</a></li>)}</ul>
  </div> : null;
}
function errorsFor(form: HTMLFormElement, copy: Copy): Errors {
  const errors: Errors = {};
  for (const field of Array.from(form.elements)) {
    if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement) || field.disabled || !field.id) continue;
    if (!field.validity.valid) errors[field.id] = `${form.querySelector(`label[for="${field.id}"]`)?.textContent?.replace("*", "").trim() ?? ""}: ${copy.required}`;
  }
  return errors;
}
function bindings(id: string, errors: Errors) { return { id, "aria-invalid": Boolean(errors[id]) || undefined, "aria-describedby": errors[id] ? `${id}-error` : undefined }; }
function FormField({ id, label, errors, children, required = true }: { id: string; label: string; errors: Errors; children: ReactNode; required?: boolean }) {
  return <Field htmlFor={id} label={label} required={required} error={errors[id]} errorId={`${id}-error`}>{children}</Field>;
}
function localDate(value?: string): string { const date = value ? new Date(value) : new Date(); return new Date(date.valueOf() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); }
function isoDate(value: string): string { return new Date(value).toISOString(); }
function isPublicHttps(value: string): boolean { try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; } }

type Execute = (command: WebsiteSalesBrowserCommand) => Promise<boolean>;
function LocationForm({ copy, scope, disabled, execute }: { copy: Copy; scope: Scope; disabled: boolean; execute: Execute }) {
  const id = useId().replace(/:/g, ""); const [errors, setErrors] = useState<Errors>({});
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget, data = new FormData(form), invalid = errorsFor(form, copy);
    if (!isPublicHttps(String(data.get("sourceUrl")))) invalid[`${id}-source`] = copy.urlError;
    setErrors(invalid); if (Object.keys(invalid).length) return;
    if (await execute({ operation: "register_location", projectId: scope.projectId, companyId: scope.companyId, payload: {
      countryCode: "IE", address: String(data.get("address")).trim(), sourceUrl: String(data.get("sourceUrl")).trim(), sourceReference: String(data.get("sourceReference")).trim(),
    } })) form.reset();
  }
  return <details className="rounded-lg border border-stone-200 bg-white p-4" data-website-sales-register>
    <summary className="min-h-11 cursor-pointer py-2 font-semibold text-slate-900">{copy.register}</summary><p className="mb-4 max-w-prose text-sm text-stone-600">{copy.registerHint}</p>
    <form noValidate onSubmit={event => void submit(event)} className="space-y-4"><FormErrors errors={errors} copy={copy} /><fieldset disabled={disabled} className="grid gap-4">
      <FormField id={`${id}-address`} label={copy.address} errors={errors}><Input {...bindings(`${id}-address`, errors)} name="address" required minLength={5} maxLength={1000} className={controlClass} autoComplete="street-address" /></FormField>
      <FormField id={`${id}-source`} label={copy.sourceUrl} errors={errors}><Input {...bindings(`${id}-source`, errors)} name="sourceUrl" type="url" required maxLength={2048} className={controlClass} placeholder="https://" /></FormField>
      <FormField id={`${id}-reference`} label={copy.sourceReference} errors={errors}><Textarea {...bindings(`${id}-reference`, errors)} name="sourceReference" required maxLength={2000} className={controlClass} rows={2} /></FormField>
      <Button type="submit" className="min-h-11 justify-self-start">{copy.register}</Button>
    </fieldset></form>
  </details>;
}

type EvidenceDraft = { sourceUrl: string; finding: string; observedAt: string; validUntil: string; validityCondition: string; confidence: string };
function ResearchForm({ copy, scope, detail, disabled, execute }: { copy: Copy; scope: Scope; detail: WebsiteSalesWorkbenchDetailResponse; disabled: boolean; execute: Execute }) {
  const original = detail.observation?.prospect;
  const [path, setPath] = useState<WebsiteProspectInput["path"]>(original?.path ?? "NO_WEBSITE");
  const [need, setNeed] = useState<WebsiteProspectInput["need"]>(original?.need ?? "NOT_ESTABLISHED");
  const [errors, setErrors] = useState<Errors>({}); const id = useId().replace(/:/g, "");
  const [evidence, setEvidence] = useState<Partial<Record<WebsiteProspectInput["evidence"][number]["kind"], EvidenceDraft>>>(() => Object.fromEntries((original?.evidence ?? []).map(row => [row.kind, {
    sourceUrl: row.sourceUrl, finding: row.finding, observedAt: localDate(row.observedAt), validUntil: localDate(row.validUntil), validityCondition: row.validityCondition, confidence: String(row.confidence * 100),
  }])));
  const kinds: WebsiteProspectInput["evidence"][number]["kind"][] = ["IDENTITY", "OWN_WEBSITE_SEARCH", ...(need === "EVIDENCED" ? ["BUSINESS_NEED" as const] : []),
    ...(path === "WEBSITE_OBSTACLE" ? ["OBSTACLE" as const] : path === "PLATFORM_PRIMARY" ? ["PLATFORM_PRESENCE" as const, "BOOKING_ROUTE" as const] : [])];
  function update(kind: typeof kinds[number], key: keyof EvidenceDraft, value: string) { setEvidence(previous => ({ ...previous, [kind]: { sourceUrl: "", finding: "", observedAt: "", validUntil: "", validityCondition: "", confidence: "", ...previous[kind], [key]: value } })); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget, data = new FormData(form), invalid = errorsFor(form, copy);
    const identity = { workspaceId: detail.workspaceId, ...scope };
    if (!data.get("identityVerified")) invalid[`${id}-identity`] = copy.identityError;
    for (const kind of kinds) {
      const row = evidence[kind];
      if (!row || !isPublicHttps(row.sourceUrl)) invalid[`${id}-${kind}-sourceUrl`] = copy.urlError;
      if (!row || !Number.isFinite(Date.parse(row.observedAt)) || !Number.isFinite(Date.parse(row.validUntil)) || Date.parse(row.validUntil) <= Date.parse(row.observedAt)) invalid[`${id}-${kind}-validUntil`] = copy.dateError;
    }
    const platform = String(data.get("platformUrl") ?? "").trim();
    if (path === "PLATFORM_PRIMARY" && !isPublicHttps(platform)) invalid[`${id}-platform`] = copy.urlError;
    setErrors(invalid); if (Object.keys(invalid).length) return;
    const prospect: WebsiteProspectInput = { identity, country: "IRELAND", identityStatus: "VERIFIED", path,
      domain: String(data.get("domain") ?? "").trim().toLowerCase() || null, ownWebsiteSearch: String(data.get("ownWebsiteSearch")) as WebsiteProspectInput["ownWebsiteSearch"],
      obstacle: path === "WEBSITE_OBSTACLE" ? String(data.get("obstacle")) as WebsiteProspectInput["obstacle"] : null,
      platformUrl: path === "PLATFORM_PRIMARY" ? platform : null, bookingRoute: path === "PLATFORM_PRIMARY" ? String(data.get("bookingRoute")) as WebsiteProspectInput["bookingRoute"] : "UNKNOWN", need,
      evidence: kinds.map(kind => { const row = evidence[kind]!; return { evidenceId: `fact-${kind.toLowerCase()}`, identity, kind, sourceUrl: row.sourceUrl.trim(), finding: row.finding.trim(),
        observedAt: isoDate(row.observedAt), validUntil: isoDate(row.validUntil), validityCondition: row.validityCondition.trim(), confidence: Number(row.confidence) / 100 }; }),
    };
    await execute({ operation: "observe", projectId: scope.projectId, companyId: scope.companyId, locationId: scope.locationId,
      locationVersion: detail.location.version, ...(detail.workflow ? { expectedVersion: detail.workflow.version } : {}), payload: { prospect } });
  }
  return <form className="space-y-5" noValidate onSubmit={event => void submit(event)} data-website-sales-research><FormErrors copy={copy} errors={errors} />
    <fieldset disabled={disabled} className="space-y-5"><legend className="mb-2 text-lg font-semibold text-slate-950">{copy.research}</legend>
      <div className="grid gap-4 sm:grid-cols-2"><FormField id={`${id}-path`} label={copy.path} errors={errors}><Select id={`${id}-path`} value={path} onChange={event => setPath(event.target.value as typeof path)} className={controlClass}>{Object.entries(copy.paths).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select></FormField>
      <FormField id={`${id}-need`} label={copy.need} errors={errors}><Select id={`${id}-need`} value={need} onChange={event => setNeed(event.target.value as typeof need)} className={controlClass}>{Object.entries(copy.needs).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select></FormField>
      <FormField id={`${id}-search`} label={copy.ownSearch} errors={errors}><Select id={`${id}-search`} name="ownWebsiteSearch" defaultValue={original?.ownWebsiteSearch ?? "UNCLEAR"} className={controlClass}>{Object.entries(copy.searches).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select></FormField>
      <FormField id={`${id}-domain`} label={copy.domain} errors={errors} required={false}><Input id={`${id}-domain`} name="domain" maxLength={253} defaultValue={original?.domain ?? ""} placeholder="company.ie" className={controlClass} /></FormField>
      {path === "WEBSITE_OBSTACLE" ? <FormField id={`${id}-obstacle`} label={copy.obstacle} errors={errors}><Select id={`${id}-obstacle`} name="obstacle" defaultValue={original?.obstacle ?? "UNCONFIRMED"} className={controlClass}>{Object.entries(copy.obstacles).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select></FormField> : null}
      {path === "PLATFORM_PRIMARY" ? <><FormField id={`${id}-platform`} label={copy.platformUrl} errors={errors}><Input {...bindings(`${id}-platform`, errors)} name="platformUrl" defaultValue={original?.platformUrl ?? ""} required maxLength={2048} type="url" className={controlClass} /></FormField><FormField id={`${id}-booking`} label={copy.bookingRoute} errors={errors}><Select id={`${id}-booking`} name="bookingRoute" defaultValue={original?.bookingRoute ?? "UNKNOWN"} className={controlClass}>{Object.entries(copy.bookings).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select></FormField></> : null}</div>
      <label className="flex min-h-11 items-start gap-3 text-sm"><input {...bindings(`${id}-identity`, errors)} className="mt-1 size-5 shrink-0" type="checkbox" name="identityVerified" required defaultChecked={original?.identityStatus === "VERIFIED"} /><span>{copy.identityVerified}{errors[`${id}-identity`] ? <span className="mt-1 block text-red-800" id={`${id}-identity-error`}>{copy.identityError}</span> : null}</span></label>
      <div><h4 className="font-semibold text-slate-900">{copy.evidence}</h4><p className="mt-1 max-w-prose text-sm text-stone-600">{copy.evidenceHint}</p></div>
      <div className="space-y-4">{kinds.map(kind => <fieldset key={kind} className="rounded-lg border border-stone-200 p-4" data-website-sales-fact={kind}><legend className="px-2 text-sm font-semibold text-slate-900">{copy.kinds[kind]}</legend><div className="grid gap-4 sm:grid-cols-2">
        {([ ["sourceUrl", copy.sourceUrl, "url"], ["observedAt", copy.observedAt, "datetime-local"], ["validUntil", copy.validUntil, "datetime-local"], ["confidence", copy.confidence, "number"] ] as const).map(([key, label, type]) => <FormField key={key} id={`${id}-${kind}-${key}`} label={label} errors={errors}><Input {...bindings(`${id}-${kind}-${key}`, errors)} value={evidence[kind]?.[key] ?? ""} onChange={event => update(kind, key, event.target.value)} type={type} required maxLength={key === "sourceUrl" ? 2048 : undefined} min={type === "number" ? 1 : undefined} max={type === "number" ? 100 : undefined} step={type === "number" ? 1 : undefined} className={controlClass} /></FormField>)}
        {([ ["finding", copy.finding], ["validityCondition", copy.validityCondition] ] as const).map(([key, label]) => <FormField key={key} id={`${id}-${kind}-${key}`} label={label} errors={errors}><Textarea {...bindings(`${id}-${kind}-${key}`, errors)} value={evidence[kind]?.[key] ?? ""} onChange={event => update(kind, key, event.target.value)} required maxLength={1000} rows={3} className={controlClass} /></FormField>)}
      </div></fieldset>)}</div><Button type="submit" className="min-h-11">{copy.saveResearch}</Button>
    </fieldset>
  </form>;
}

function QualificationForm({ copy, scope, detail, contacts, disabled, execute }: { copy: Copy; scope: Scope; detail: WebsiteSalesWorkbenchDetailResponse; contacts: WebsiteSalesWorkbenchContact[]; disabled: boolean; execute: Execute }) {
  const id = useId().replace(/:/g, ""); const [errors, setErrors] = useState<Errors>({});
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget, invalid = errorsFor(form, copy); setErrors(invalid); if (Object.keys(invalid).length || !detail.workflow) return;
    const data = new FormData(form); await execute({ operation: "qualify", ...scope, expectedVersion: detail.workflow.version, payload: { contactId: data.get("contactId"),
      opportunitySummary: String(data.get("summary")).trim(), nextAction: String(data.get("nextAction")).trim(), expectedEvidenceDigest: detail.workflow.evidenceDigest } });
  }
  return <form noValidate onSubmit={event => void submit(event)} className="space-y-4" data-website-sales-qualification><FormErrors copy={copy} errors={errors} /><fieldset disabled={disabled} className="space-y-4"><legend className="mb-2 text-lg font-semibold">{copy.qualify}</legend><p className="max-w-prose text-sm text-stone-600">{copy.qualificationHint}</p>
    <FormField id={`${id}-contact`} label={copy.contact} errors={errors}><Select {...bindings(`${id}-contact`, errors)} name="contactId" required defaultValue="" className={controlClass}><option value="">{copy.choose}</option>{contacts.map(contact => <option key={contact.id} value={contact.id}>{contact.name}{contact.email ? ` (${contact.email})` : ""}</option>)}</Select></FormField>
    <FormField id={`${id}-summary`} label={copy.summary} errors={errors}><Textarea {...bindings(`${id}-summary`, errors)} name="summary" required maxLength={2000} rows={3} className={controlClass} /></FormField>
    <FormField id={`${id}-next`} label={copy.nextAction} errors={errors}><Input {...bindings(`${id}-next`, errors)} name="nextAction" required maxLength={1000} className={controlClass} /></FormField>
    <Button type="submit" className="min-h-11">{copy.qualifyAction}</Button></fieldset></form>;
}

function OfferForm({ copy, scope, detail, disabled, execute }: { copy: Copy; scope: Scope; detail: WebsiteSalesWorkbenchDetailResponse; disabled: boolean; execute: Execute }) {
  const id = useId().replace(/:/g, ""); const [errors, setErrors] = useState<Errors>({});
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget, invalid = errorsFor(form, copy), data = new FormData(form);
    const unitNetCents = Math.round(Number(data.get("price")) * 100), quantity = Number(data.get("quantity"));
    if (!Number.isSafeInteger(unitNetCents) || unitNetCents <= 0 || !Number.isSafeInteger(quantity) || quantity <= 0 || !Number.isSafeInteger(unitNetCents * quantity)) invalid[`${id}-price`] = copy.numberError;
    setErrors(invalid); if (Object.keys(invalid).length || !detail.workflow || !detail.contact?.email) return;
    const content = Object.fromEntries(["subject", "scope", "paymentPlan", "discounts", "specialTerms", "riskComplianceNotes", "terms"].map(key => [key, String(data.get(key)).trim()]));
    await execute({ operation: "prepare_offer", ...scope, expectedVersion: detail.workflow.version, payload: { expectedEvidenceDigest: detail.workflow.evidenceDigest,
      content: { ...content, recipientName: detail.contact.name, recipientEmail: detail.contact.email, validUntil: isoDate(String(data.get("validUntil"))), currency: "EUR", taxBasis: "NET", items: [{ description: String(data.get("item")).trim(), quantity, unitNetCents }] } } });
  }
  return <form noValidate onSubmit={event => void submit(event)} className="space-y-4" data-website-sales-offer><FormErrors copy={copy} errors={errors} /><fieldset disabled={disabled || !detail.contact?.email} className="space-y-4"><legend className="mb-2 text-lg font-semibold">{copy.draft}</legend><p className="max-w-prose text-sm text-stone-600">{copy.draftHint}</p>
    {detail.contact?.email ? <p className="rounded-lg bg-stone-50 p-3 text-sm"><span className="font-semibold">{copy.recipient}: </span>{detail.contact.name} · {detail.contact.email}</p> : <Notice tone="warning">{copy.recipientUnavailable}</Notice>}
    <div className="grid gap-4 sm:grid-cols-2">{([ ["subject", copy.subject], ["item", copy.item], ["price", copy.price], ["quantity", copy.quantity], ["validUntil", copy.validUntil] ] as const).map(([key, label]) => <FormField key={key} id={`${id}-${key}`} label={label} errors={errors}><Input {...bindings(`${id}-${key}`, errors)} name={key} type={key === "price" || key === "quantity" ? "number" : key === "validUntil" ? "datetime-local" : "text"} required defaultValue={key === "quantity" ? "1" : undefined} min={key === "price" ? "0.01" : key === "quantity" ? 1 : undefined} step={key === "price" ? "0.01" : key === "quantity" ? "1" : undefined} maxLength={1000} className={controlClass} /></FormField>)}</div>
    <div className="grid gap-4 sm:grid-cols-2">{([ ["scope", copy.scope], ["paymentPlan", copy.paymentPlan], ["discounts", copy.discounts], ["specialTerms", copy.specialTerms], ["riskComplianceNotes", copy.riskNotes], ["terms", copy.terms] ] as const).map(([key, label]) => <FormField key={key} id={`${id}-${key}`} label={label} errors={errors}><Textarea {...bindings(`${id}-${key}`, errors)} name={key} required maxLength={5000} rows={3} className={controlClass} /></FormField>)}</div>
    <Button type="submit" className="min-h-11">{copy.prepare}</Button></fieldset></form>;
}

function StopForm({ copy, scope, detail, disabled, execute }: { copy: Copy; scope: Scope; detail: WebsiteSalesWorkbenchDetailResponse; disabled: boolean; execute: Execute }) {
  const id = useId().replace(/:/g, ""); const [errors, setErrors] = useState<Errors>({});
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const invalid = errorsFor(event.currentTarget, copy); setErrors(invalid); if (Object.keys(invalid).length || !detail.workflow) return;
    const data = new FormData(event.currentTarget); await execute({ operation: "stop", ...scope, expectedVersion: detail.workflow.version, payload: { reason: data.get("reason"), sourceReference: String(data.get("reference")).trim() } });
  }
  return <details className="border-t border-stone-200 pt-4" data-website-sales-stop><summary className="min-h-11 cursor-pointer py-2 font-semibold text-slate-800">{copy.stopTitle}</summary><form noValidate onSubmit={event => void submit(event)} className="mt-3 space-y-4"><FormErrors copy={copy} errors={errors} /><fieldset disabled={disabled} className="grid gap-4 sm:grid-cols-2">
    <FormField id={`${id}-reason`} label={copy.stopReason} errors={errors}><Select id={`${id}-reason`} name="reason" className={controlClass}>{Object.entries(copy.stopReasons).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</Select></FormField>
    <FormField id={`${id}-reference`} label={copy.stopReference} errors={errors}><Input {...bindings(`${id}-reference`, errors)} required maxLength={2000} name="reference" className={controlClass} /></FormField>
    <label className="flex min-h-11 items-start gap-3 text-sm sm:col-span-2" htmlFor={`${id}-acknowledge`}><input {...bindings(`${id}-acknowledge`, errors)} type="checkbox" required className="mt-1 size-5 shrink-0" /><span>{copy.stopAcknowledge}{errors[`${id}-acknowledge`] ? <span className="mt-1 block text-red-800" id={`${id}-acknowledge-error`}>{copy.required}</span> : null}</span></label>
    <Button type="submit" variant="danger" className="min-h-11 justify-self-start">{copy.stop}</Button>
  </fieldset></form></details>;
}

type WorkbenchProps = { workspaceId: string; actorId: string; language: string; initialProjectId?: string | null };
export function WebsiteSalesWorkbench(props: WorkbenchProps) { return <Workbench key={`${props.actorId}:${props.workspaceId}:${props.initialProjectId ?? ""}`} {...props} />; }
function Workbench({ workspaceId, actorId, language, initialProjectId }: WorkbenchProps) {
  const copy = getWebsiteSalesCopy(language), id = useId().replace(/:/g, "");
  const [pending, setPending] = useState(() => websiteSalesPending(workspaceId, actorId));
  const [discoveryOriginal] = useState(() => { try { return discoveryPending(workspaceId, actorId); } catch { return null; } });
  const [discoveryRecovery, setDiscoveryRecovery] = useState(() => { try { return Boolean(discoveryPending(workspaceId, actorId)); } catch { return true; } });
  const foreignOriginal = studioPending(workspaceId, actorId)?.command ?? lifecyclePending(workspaceId, actorId)?.command ?? salesOperationsPending("autonomy", workspaceId, actorId)?.command ?? salesOperationsPending("conversation", workspaceId, actorId)?.command ?? enablementPending(workspaceId,actorId)?.command ?? commercePending(workspaceId,actorId)?.command;
  const [, refreshPending] = useState(0), [showResearch, setShowResearch] = useState(false);
  const [projectId, setProjectId] = useState(() => pending?.command.projectId ?? foreignOriginal?.projectId ?? discoveryOriginal?.projectId ?? initialProjectId ?? "");
  const [companyId, setCompanyId] = useState(() => pending?.command.companyId ?? foreignOriginal?.companyId ?? "");
  const [locationId, setLocationId] = useState(() => pending?.command.locationId ?? foreignOriginal?.locationId ?? "");
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState<"saved" | "denied" | null>(null);
  const [sourceRevision,setSourceRevision]=useState(0);
  const generation = useRef(0), mounted = useRef(true), dirty = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => subscribeWebsiteSalesPending(() => setPending(websiteSalesPending(workspaceId, actorId))), [workspaceId, actorId]);
  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) { if (dirty.current || websiteSalesPending(workspaceId, actorId)) { event.preventDefault(); event.returnValue = ""; } }
    window.addEventListener("beforeunload", beforeUnload); return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [workspaceId, actorId]);
  useEffect(() => { const update = () => refreshPending(n => n + 1); const a = subscribeStudioPending(update), b = subscribeLifecyclePending(update), c = subscribeSalesOperationsPending(update),d=subscribeEnablementPending(update),e=subscribeCommercePending(update); return () => { a(); b(); c();d();e(); }; }, []);
  const studioRecovery = studioPending(workspaceId, actorId), lifecycleRecovery = lifecyclePending(workspaceId, actorId);
  const operationsRecovery = salesOperationsPending("autonomy", workspaceId, actorId) || salesOperationsPending("conversation", workspaceId, actorId);
  const enablementRecovery=enablementPending(workspaceId,actorId),commerceRecovery=commercePending(workspaceId,actorId);
  const scope = { projectId, companyId, locationId };
  const projects = useList<WebsiteSalesWorkbenchProject>(workspaceId, "projects", {});
  const companies = useList<WebsiteSalesWorkbenchCompany>(workspaceId, "companies", { projectId }, Boolean(projectId));
  const contacts = useList<WebsiteSalesWorkbenchContact>(workspaceId, "contacts", { projectId, companyId }, Boolean(projectId && companyId));
  const locations = useList<WebsiteSalesWorkbenchLocationItem>(workspaceId, "locations", { projectId, companyId }, Boolean(projectId && companyId));
  const current = useDetail(workspaceId, scope), detail = current.detail, workflow = detail?.workflow;
  const project = projects.items.find(row => row.id === projectId);
  const canWrite = Boolean(detail?.canWrite ?? (project?.canWrite && companies.canWrite));
  const locked = busy || Boolean(pending) || Boolean(studioRecovery) || Boolean(lifecycleRecovery) || Boolean(operationsRecovery)||Boolean(enablementRecovery)||Boolean(commerceRecovery)||discoveryRecovery;
  const disableWrite = locked || !canWrite || current.loading || current.failed;
  const failed = projects.failed || companies.failed || contacts.failed || locations.failed || current.failed;
  function refresh() { projects.refresh(); companies.refresh(); contacts.refresh(); locations.refresh(); current.refresh();setSourceRevision(value=>value+1); }
  async function refreshEvidence(command: WebsiteSalesBrowserCommand): Promise<boolean> {
    if (locked || !workflow || !command.payload.prospect || !command.locationVersion) return false;
    setBusy(true); setNotice(null);
    try {
      await writeLifecycle(workspaceId, actorId, { contractVersion: "website-sales-lifecycle-v1", operation: "refresh_evidence", ...scope,
        expectedVersion: workflow.version, idempotencyKey: crypto.randomUUID(), correlationId: crypto.randomUUID(),
        payload: { prospect: command.payload.prospect, locationVersion: command.locationVersion } });
      dirty.current = false; setShowResearch(false); setNotice("saved"); refresh(); return true;
    } catch { setNotice("denied"); return false; }
    finally { setBusy(false); }
  }
  async function execute(command: WebsiteSalesBrowserCommand): Promise<boolean> {
    if (locked) return false;
    const token = ++generation.current; setBusy(true); setNotice(null);
    try {
      const result = await commandWebsiteSalesWorkbench(workspaceId, actorId, command);
      if (!mounted.current || token !== generation.current) return false;
      if (command.operation === "register_location") setLocationId(String((result.location as { id: string }).id));
      dirty.current = false; setNotice("saved"); refresh(); return true;
    } catch (error) {
      if (mounted.current && token === generation.current) { setPending(websiteSalesPending(workspaceId, actorId)); setNotice(error instanceof WebsiteSalesBrowserError && error.outcome === "UNKNOWN" ? null : "denied"); }
      return false;
    } finally { if (mounted.current && token === generation.current) setBusy(false); }
  }
  async function readOriginal() {
    const original = websiteSalesPending(workspaceId, actorId); if (!original || original.recoveryError) return;
    setBusy(true); const token = ++generation.current;
    try {
      const command = original.command;
      await readWebsiteSalesWorkbench(workspaceId, { view: command.locationId ? "detail" : "locations", projectId: command.projectId, companyId: command.companyId,
        ...(command.locationId ? { locationId: command.locationId } : {}) }, new AbortController().signal);
      if (mounted.current && token === generation.current) { websiteSalesMarkCurrentRead(workspaceId, actorId, command, original); setPending(websiteSalesPending(workspaceId, actorId)); refresh(); }
    } catch { if (mounted.current && token === generation.current) setNotice("denied"); }
    finally { if (mounted.current && token === generation.current) setBusy(false); }
  }
  async function reconcile() {
    const original = websiteSalesPending(workspaceId, actorId); if (!original?.currentRead || original.recoveryError) return;
    setBusy(true); const token = ++generation.current;
    try {
      const result = await commandWebsiteSalesWorkbench(workspaceId, actorId, original.command, true);
      if (mounted.current && token === generation.current) {
        dirty.current = false; setPending(null); setNotice("saved"); if (original.command.operation === "register_location") setLocationId(String((result.location as { id: string }).id)); refresh();
      }
    } catch { if (mounted.current && token === generation.current) { setPending(websiteSalesPending(workspaceId, actorId)); setNotice("denied"); } }
    finally { if (mounted.current && token === generation.current) setBusy(false); }
  }
  return <section className="space-y-5" aria-labelledby={`${id}-title`} data-website-sales-workbench onInputCapture={event => { if (!(event.target instanceof Element) || !event.target.closest("[data-website-sales-operations],[data-website-sales-commerce]")) dirty.current = true; }}>
    <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 id={`${id}-title`} className="text-2xl font-semibold tracking-tight text-slate-950">{copy.title}</h2><p className="mt-2 max-w-prose text-sm leading-6 text-stone-600">{copy.intro}</p></div><StatusChip tone="neutral">{copy.noContact}</StatusChip></div>
    {language !== "de" && language !== "en" ? <Notice>{copy.languageFallback}</Notice> : null}
    {pending?.state === "UNKNOWN" ? <Notice tone="warning" announce="polite"><p>{pending.recoveryError ? copy.recoveryInvalid : copy.unknown}</p>{!pending.recoveryError ? <><p className="mt-2 text-sm">{pending.currentRead ? copy.checkedUnknown : copy.unknownScope}</p><div className="mt-3 flex flex-wrap gap-2"><Button variant="secondary" disabled={busy} onClick={() => void readOriginal()}>{copy.checkOriginal}</Button><Button disabled={busy || !pending.currentRead} onClick={() => void reconcile()}>{copy.reconcile}</Button></div></> : null}</Notice> : null}
    {pending?.state === "IN_FLIGHT" ? <p role="status" className="text-sm text-stone-700">{copy.saving}</p> : null}
    {!pending && (studioRecovery || lifecycleRecovery || operationsRecovery||enablementRecovery||commerceRecovery) ? <Notice tone="warning" announce="polite">{copy.unknown}</Notice> : null}
    {notice ? <Notice tone={notice === "saved" ? "success" : "danger"} announce={notice === "saved" ? "polite" : "assertive"}>{notice === "saved" ? copy.saved : copy.denied}</Notice> : null}
    {failed ? <Notice tone="danger" announce="polite"><p>{copy.loadError}</p><Button className="mt-3" variant="secondary" disabled={busy} onClick={refresh}>{copy.refresh}</Button></Notice> : null}
    {projectId ? <WebsiteSalesDiscoveryPanel key={`discovery:${workspaceId}:${projectId}`} workspaceId={workspaceId} actorId={actorId} projectId={projectId} language={language}
      blocked={busy||Boolean(pending)||Boolean(studioRecovery)||Boolean(lifecycleRecovery)||Boolean(operationsRecovery)||Boolean(enablementRecovery)||Boolean(commerceRecovery)}
      canWrite={Boolean(project?.canWrite)} onPending={setDiscoveryRecovery} onOpen={data=>{generation.current++;setProjectId(data.identity.projectId);setCompanyId(data.identity.companyId);setLocationId(data.identity.locationId);setShowResearch(false);setNotice(null);refresh();}} /> : null}
    {projectId&&!companyId?<WebsiteSalesDailyPanel key={`${workspaceId}:${projectId}`} workspaceId={workspaceId} projectId={projectId} language={language} blocked={locked} onOpen={selected=>{if(locked)return;generation.current++;setCompanyId(selected.companyId);setLocationId(selected.locationId);setShowResearch(false);setNotice(null);}}/>:null}
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(250px,320px)_minmax(0,1fr)]">
      <aside className="min-w-0 space-y-4" aria-label={copy.project}>
        <Surface className="space-y-4"><Field htmlFor={`${id}-project`} label={copy.project}><Select id={`${id}-project`} value={projectId} disabled={locked || projects.loading || Boolean(initialProjectId) && !pending} className={controlClass} onChange={event => { generation.current++; setProjectId(event.target.value); setShowResearch(false); setCompanyId(""); setLocationId(""); setNotice(null); }}><option value="">{copy.choose}</option>{projects.items.map(row => <option value={row.id} key={row.id}>{row.name}</option>)}</Select></Field>
          {projects.loading ? <p role="status" className="text-sm text-stone-600">{copy.loading}</p> : !projects.failed && !projects.items.length ? <p className="text-sm text-stone-600">{copy.projectEmpty}</p> : null}
          {projects.page.hasMore ? <Button variant="ghost" disabled={locked} onClick={projects.more}>{copy.more}</Button> : null}
          {projectId ? <><Field htmlFor={`${id}-company`} label={copy.company}><Select id={`${id}-company`} value={companyId} disabled={locked || companies.loading} className={controlClass} onChange={event => { generation.current++; setCompanyId(event.target.value); setShowResearch(false); setLocationId(""); setNotice(null); }}><option value="">{copy.choose}</option>{companies.items.map(row => <option value={row.id} key={row.id}>{row.name}{row.city ? ` (${row.city})` : ""}</option>)}</Select></Field>{companies.page.hasMore ? <Button variant="ghost" disabled={locked} onClick={companies.more}>{copy.more}</Button> : null}{!companies.loading && !companies.failed && !companies.items.length ? <p className="text-sm text-stone-600">{copy.companyEmpty}</p> : null}</> : null}
          {companyId ? <><Field htmlFor={`${id}-location`} label={copy.location}><Select id={`${id}-location`} value={locationId} disabled={locked || locations.loading} className={controlClass} onChange={event => { generation.current++; setLocationId(event.target.value); setShowResearch(false); setNotice(null); }}><option value="">{copy.choose}</option>{locations.items.map(row => <option value={row.id} key={row.id}>{row.address}</option>)}</Select></Field>{locations.page.hasMore ? <Button variant="ghost" disabled={locked} onClick={locations.more}>{copy.more}</Button> : null}{!locations.loading && !locations.failed && !locations.items.length ? <p className="text-sm text-stone-600">{copy.locationEmpty}</p> : null}</> : null}
          <Button variant="secondary" className="min-h-11" disabled={busy} onClick={refresh}>{copy.refresh}</Button>
        </Surface>
        {projectId && companyId ? <LocationForm key={`${workspaceId}:${projectId}:${companyId}`} copy={copy} scope={scope} disabled={locked || !project?.canWrite || !companies.canWrite} execute={execute} /> : null}
      </aside>
      <Surface className="min-w-0 space-y-6" aria-busy={busy || current.loading}>
        {current.loading ? <p role="status" className="py-8 text-sm text-stone-600">{copy.loading}</p> : !detail ? <p className="py-8 text-sm text-stone-600">{copy.noSelection}</p> : <>
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-stone-200 pb-5"><div><p className="text-sm text-stone-500">{copy.location}</p><h3 className="mt-1 text-lg font-semibold text-slate-950">{detail.location.address}</h3><a href={detail.location.sourceUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex min-h-11 items-center break-all text-sm text-blue-800 underline underline-offset-4">{copy.sourceUrl}</a></div><div className="flex flex-wrap gap-2">{workflow ? <StatusChip tone={workflow.status === "STOPPED" ? "warning" : "info"}>{copy.statuses[workflow.status]}</StatusChip> : null}{workflow?.qualificationStatus ? <StatusChip tone={workflow.qualificationStatus === "READY" ? "success" : "warning"}>{copy.qualifications[workflow.qualificationStatus]}</StatusChip> : null}</div></div>
          {!canWrite ? <Notice>{copy.readOnly}</Notice> : null}
          {workflow?.blockedReason ? <Notice tone="warning"><strong>{copy.blocked}: </strong>{copy.blockedReasons[workflow.blockedReason as keyof typeof copy.blockedReasons] ?? copy.loadError}</Notice> : null}
          {workflow?.status === "STOPPED" ? <p className="text-sm text-stone-700">{copy.stopped}</p> : null}
          {!workflow || workflow.status === "OBSERVED" || showResearch && (workflow.status === "QUALIFIED" || workflow.status === "OFFER_DRAFT") ? <ResearchForm key={`${scope.locationId}:${workflow?.version ?? 0}`} copy={copy} scope={scope} detail={detail} disabled={disableWrite} execute={showResearch && workflow?.status !== "OBSERVED" ? refreshEvidence : execute} /> : null}
          {workflow?.status === "OBSERVED" ? <><hr className="border-stone-200" />{project?.pipelineConfigured === false ? <Notice tone="warning">{copy.pipelineMissing}</Notice> : null}<QualificationForm key={`qualify:${workflow.id}:${workflow.version}`} copy={copy} scope={scope} detail={detail} contacts={contacts.items} disabled={disableWrite || Boolean(workflow.blockedReason) || workflow.qualificationStatus !== "READY" || !project?.pipelineConfigured || contacts.loading || contacts.failed} execute={execute} />{contacts.page.hasMore ? <Button variant="ghost" disabled={locked} onClick={contacts.more}>{copy.more}</Button> : null}</> : null}
          {workflow?.status === "QUALIFIED" ? <OfferForm key={`offer:${workflow.id}:${workflow.version}`} copy={copy} scope={scope} detail={detail} disabled={disableWrite || Boolean(workflow.blockedReason)} execute={execute} /> : null}
          {workflow?.leadId ? <div className="border-t border-stone-200 pt-4"><h4 className="text-sm font-semibold">{copy.links}</h4><nav className="mt-2 flex flex-wrap gap-3 text-sm" aria-label={copy.links}>{[[copy.lead, "lead-inbox"], [copy.opportunity, "pipelines"], [copy.task, "tasks"], ...(workflow.offerDraftId ? [[copy.offer, "pipelines"]] : [])].map(([label, hash]) => <a key={label} href={`/?workspaceId=${encodeURIComponent(workspaceId)}&projectId=${encodeURIComponent(projectId)}#${hash}`} className="inline-flex min-h-11 items-center text-blue-800 underline underline-offset-4">{label}</a>)}</nav></div> : null}
          {workflow && workflow.status !== "STOPPED" ? <StopForm key={`stop:${workflow.id}:${workflow.version}`} copy={copy} scope={scope} detail={detail} disabled={disableWrite} execute={execute} /> : null}
        </>}
      </Surface>
    </div>
    {workflow && locationId ? <>
      <WebsiteSalesCommercePanel workflowId={workflow.id} sourceRevision={sourceRevision} workspaceId={workspaceId} actorId={actorId} language={language} {...scope} blocked={busy||current.loading||current.failed||Boolean(pending)||Boolean(studioRecovery)||Boolean(lifecycleRecovery)||Boolean(operationsRecovery)||Boolean(enablementRecovery)} onStateChanged={refresh}/>
      <WebsiteSalesEnablementPanel workspaceId={workspaceId} actorId={actorId} language={language} {...scope} blocked={busy||current.loading||current.failed||Boolean(pending)||Boolean(studioRecovery)||Boolean(lifecycleRecovery)||Boolean(operationsRecovery)||Boolean(commerceRecovery)} onStateChanged={refresh}/>
      <WebsiteSalesStudio sourceRevision={sourceRevision} key={`studio:${workflow.id}:${workflow.version}`} workspaceId={workspaceId} actorId={actorId} language={language} {...scope} blocked={busy || current.loading || current.failed || Boolean(pending) || Boolean(lifecycleRecovery) || Boolean(operationsRecovery)||Boolean(enablementRecovery)||Boolean(commerceRecovery)} />
      <WebsiteSalesLifecyclePanel key={`lifecycle:${workflow.id}:${workflow.version}`} workspaceId={workspaceId} actorId={actorId} language={language} {...scope} blocked={busy || current.loading || current.failed || Boolean(pending) || Boolean(studioRecovery) || Boolean(operationsRecovery)||Boolean(enablementRecovery)||Boolean(commerceRecovery)} onRefreshEvidence={workflow.status === "QUALIFIED" || workflow.status === "OFFER_DRAFT" ? () => { setShowResearch(true); } : undefined} />
      <WebsiteSalesOperationsPanel workspaceId={workspaceId} actorId={actorId} language={language} {...scope} blocked={busy || current.loading || current.failed || Boolean(pending) || Boolean(studioRecovery) || Boolean(lifecycleRecovery)||Boolean(enablementRecovery)||Boolean(commerceRecovery)} onStateChanged={refresh} />
    </> : null}
  </section>;
}
