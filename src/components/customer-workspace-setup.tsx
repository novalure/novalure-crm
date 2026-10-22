"use client";

import { useRef, useState, type FormEvent } from "react";
import type { LanguageCode } from "@/lib/i18n";
import type { WorkspaceCustomerType } from "@/lib/product-model";
import { csrfFetch } from "@/lib/security/csrf-client";

export type CreatedCustomerWorkspace = {
  persisted: true;
  workspace: { id: string; name: string };
  project: { id: string; name: string; workspaceId: string };
  bot: { id: string; name: string; workspaceId: string; projectId: string };
  knowledgeArea: { id: string; name: string; workspaceId: string; projectId: string };
};

type CustomerDraft = { name: string; projectName: string; botName: string; websiteUrl: string; customerType: WorkspaceCustomerType };
type PendingCustomerSetup = { id: string; fields: CustomerDraft };

function pendingSetup(key: string): PendingCustomerSetup | null {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(key) || "null") as PendingCustomerSetup | null;
    if (!value || !/^[0-9a-f-]{36}$/i.test(value.id) || !value.fields) return null;
    const fields = value.fields;
    if (![fields.name, fields.projectName, fields.botName, fields.websiteUrl].every(item => typeof item === "string")
      || !["general_company", "real_estate_broker", "property_developer", "hybrid_real_estate"].includes(fields.customerType)) return null;
    return value;
  } catch { return null; }
}

export function CustomerWorkspaceSetup({
  language,
  onCreated,
  onBusyChange,
  userId,
}: {
  language: LanguageCode;
  onCreated: (result: CreatedCustomerWorkspace) => Promise<void>;
  onBusyChange: (busy: boolean) => void;
  userId: string;
}) {
  const de = language === "de";
  const storageKey = `novalure.customer-setup.v1:${userId}`;
  const [restored] = useState(() => pendingSetup(storageKey));
  const [name, setName] = useState(restored?.fields.name ?? "");
  const [projectName, setProjectName] = useState(restored?.fields.projectName ?? (de ? "Website & Wissen" : "Website & knowledge"));
  const [botName, setBotName] = useState(restored?.fields.botName ?? (de ? "Website-Assistent" : "Website assistant"));
  const [websiteUrl, setWebsiteUrl] = useState(restored?.fields.websiteUrl ?? "");
  const [customerType, setCustomerType] = useState<WorkspaceCustomerType>(restored?.fields.customerType ?? "general_company");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<CreatedCustomerWorkspace | null>(null);
  const [requestAttempted, setRequestAttempted] = useState(Boolean(restored));
  const request = useRef<PendingCustomerSetup | null>(restored);
  const fieldClass = "min-h-12 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm text-slate-950 disabled:bg-stone-100";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    onBusyChange(true);
    setError("");
    try {
      let result = created;
      if (!result) {
        if (!request.current) {
          request.current = { id: crypto.randomUUID(), fields: { name: name.trim(), projectName: projectName.trim(), botName: botName.trim(), websiteUrl: websiteUrl.trim(), customerType } };
        }
        // Retain the same operation and its exact input across a lost response,
        // closing this dialog, or reloading this tab. Never silently create a
        // second operation while the first result is still unknown.
        window.sessionStorage.setItem(storageKey, JSON.stringify(request.current));
        setRequestAttempted(true);
        const response = await csrfFetch("/api/workspaces", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...request.current.fields, requestId: request.current.id }),
        });
        const data = await response.json() as Partial<CreatedCustomerWorkspace> & { error?: string };
        if (!response.ok || data.persisted !== true || !data.workspace?.id || !data.project?.id || !data.bot?.id || !data.knowledgeArea?.id) {
          if (response.status === 400 || response.status === 413 || response.status === 422) {
            window.sessionStorage.removeItem(storageKey);
            request.current = null;
            setRequestAttempted(false);
          }
          throw new Error(data.error || (de ? "Der Kunde konnte nicht angelegt werden." : "The customer could not be created."));
        }
        result = data as CreatedCustomerWorkspace;
        setCreated(result);
      }
      await onCreated(result);
      window.sessionStorage.removeItem(storageKey);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : de ? "Bitte versuchen Sie es erneut." : "Please try again.");
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }

  return (
    <form className="grid gap-5" onSubmit={submit}>
      <p className="text-sm leading-6 text-stone-600">
        {de
          ? "Der Kunde erhält einen eigenen Arbeitsbereich, ein Projekt, einen Assistenten und einen leeren Wissensbereich. Danach übernehmen Sie seine Website-Inhalte und verbinden den Chat."
          : "The customer gets a separate workspace, a project, an assistant and an empty knowledge area. Next, import their website content and connect the chat."}
      </p>
      {requestAttempted && !created ? <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900" role="status">{de ? "Dieser Einrichtungsvorgang bleibt gespeichert. Erneutes Absenden setzt denselben Vorgang fort." : "This setup operation is retained. Submitting again continues the same operation."}</p> : null}
      <fieldset className="grid gap-4 sm:grid-cols-2" disabled={busy || Boolean(created) || requestAttempted}>
        <label className="grid gap-2 text-sm font-semibold sm:col-span-2">
          {de ? "Kundenname" : "Customer name"}
          <input className={fieldClass} maxLength={120} onChange={event => setName(event.target.value)} required value={name} />
        </label>
        <label className="grid gap-2 text-sm font-semibold sm:col-span-2">
          {de ? "Kundenwebsite" : "Customer website"}
          <input className={fieldClass} maxLength={2048} onChange={event => setWebsiteUrl(event.target.value)} placeholder="https://…" required type="url" value={websiteUrl} />
          <span className="text-xs font-normal leading-5 text-stone-500">{de ? "Eine Entwurfsadresse ist möglich. Die spätere Domain kann am selben Kunden ergänzt werden." : "A draft website is supported. The final domain can be added to the same customer later."}</span>
        </label>
        <label className="grid gap-2 text-sm font-semibold">
          {de ? "Projektname" : "Project name"}
          <input className={fieldClass} maxLength={120} onChange={event => setProjectName(event.target.value)} required value={projectName} />
        </label>
        <label className="grid gap-2 text-sm font-semibold">
          {de ? "Name des Assistenten" : "Assistant name"}
          <input className={fieldClass} maxLength={120} onChange={event => setBotName(event.target.value)} required value={botName} />
        </label>
        <label className="grid gap-2 text-sm font-semibold sm:col-span-2">
          {de ? "Kundentyp" : "Customer type"}
          <select className={fieldClass} onChange={event => setCustomerType(event.target.value as WorkspaceCustomerType)} value={customerType}>
            <option value="general_company">{de ? "Unternehmen" : "Company"}</option>
            <option value="real_estate_broker">{de ? "Immobilienmakler" : "Real estate broker"}</option>
            <option value="property_developer">{de ? "Bauträger / Apartmentprojekt" : "Property developer / apartment project"}</option>
            <option value="hybrid_real_estate">{de ? "Hybrid Immobilien" : "Hybrid real estate"}</option>
          </select>
        </label>
      </fieldset>
      <p className="rounded-md bg-stone-50 p-3 text-sm leading-6 text-stone-600">
        {de ? "Ein Assistent wird vorbereitet. Die Einrichtung lädt keine Kundendaten aus anderen Arbeitsbereichen und versendet keine Einladungen. Für die Website-Verbindung ist kein neues Hosting-Konto erforderlich." : "One assistant is prepared. Setup does not import data from other workspaces or send invitations. Connecting the website does not require a new hosting account."}
      </p>
      {created ? <p className="text-sm font-semibold text-emerald-800" role="status">{de ? `Kunde „${created.workspace.name}“ ist angelegt.` : `Customer “${created.workspace.name}” has been created.`}</p> : null}
      {error ? <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">{error}</p> : null}
      <button aria-busy={busy} className="min-h-12 rounded-md bg-slate-950 px-4 py-3 text-sm font-semibold text-white disabled:opacity-60" disabled={busy} type="submit">
        {busy ? de ? "Kundenbereich wird vorbereitet…" : "Preparing customer workspace…" : created ? de ? "Kundenbereich öffnen" : "Open customer workspace" : de ? "Kunden und Chatbot anlegen" : "Create customer and chatbot"}
      </button>
    </form>
  );
}
