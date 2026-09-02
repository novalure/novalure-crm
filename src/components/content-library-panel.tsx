"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type FormEvent,
  type InputHTMLAttributes,
} from "react";
import { contentLinkTargetTypes } from "@/lib/content-library";
import { csrfFetch } from "@/lib/security/csrf-client";

export type ContentLibraryPanelProps = {
  workspaceId: string;
  projectId: string | null;
  language: "de" | "en";
  canWrite: boolean;
  canApprove: boolean;
  initialDocumentId?: string | null;
};

type LibraryItem = {
  id: string;
  title?: string;
  name?: string;
  category?: string;
  channel?: string;
  approvalStatus: string;
  currentVersionNumber: number;
  archivedAt: string | null;
  updatedAt: string;
};

type LibraryPage = {
  items: LibraryItem[];
  page: number;
  pageSize: number;
  total: number;
};

const copy = {
  de: {
    title: "Dokumente & Vorlagen",
    description: "Zentrale, versionierte Inhalte. Dateien bleiben sicher in der Medienbibliothek.",
    documents: "Dokumente",
    templates: "Vorlagen",
    search: "Inhalte durchsuchen",
    loading: "Inhalte werden geladen …",
    empty: "Keine Inhalte gefunden.",
    createDocument: "Dokument verknüpfen",
    createTemplate: "Vorlage erstellen",
    itemTitle: "Titel",
    assetId: "Medien-ID",
    fileName: "Dateiname",
    mimeType: "MIME-Typ",
    sizeBytes: "Dateigröße in Byte",
    linkType: "Verknüpfungstyp (optional)",
    linkId: "Datensatz-ID der Verknüpfung",
    noLink: "Keine Verknüpfung",
    incompleteLink: "Verknüpfungstyp und Datensatz-ID müssen gemeinsam angegeben werden.",
    body: "Vorlagentext",
    variables: "Erlaubte Variablen (Komma-getrennt)",
    save: "Speichern",
    approve: "Freigeben",
    requestReview: "Prüfung anfordern",
    archive: "Archivieren",
    restore: "Wiederherstellen",
    deletionReview: "Löschprüfung anfordern",
    previous: "Zurück",
    next: "Weiter",
    version: "Version",
    active: "Aktiv",
    archived: "Archiviert",
  },
  en: {
    title: "Documents & templates",
    description: "Central, versioned content. Files remain safely stored in the media library.",
    documents: "Documents",
    templates: "Templates",
    search: "Search content",
    loading: "Loading content…",
    empty: "No content found.",
    createDocument: "Link document",
    createTemplate: "Create template",
    itemTitle: "Title",
    assetId: "Media ID",
    fileName: "File name",
    mimeType: "MIME type",
    sizeBytes: "File size in bytes",
    linkType: "Link target type (optional)",
    linkId: "Linked record ID",
    noLink: "No linked record",
    incompleteLink: "Link target type and record ID must be provided together.",
    body: "Template body",
    variables: "Allowed variables (comma-separated)",
    save: "Save",
    approve: "Approve",
    requestReview: "Request review",
    archive: "Archive",
    restore: "Restore",
    deletionReview: "Request deletion review",
    previous: "Previous",
    next: "Next",
    version: "Version",
    active: "Active",
    archived: "Archived",
  },
} as const;

function mutationKey() {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function responsePayload(response: Response) {
  const payload = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

export function ContentLibraryPanel({
  workspaceId,
  projectId,
  language,
  canWrite,
  canApprove,
  initialDocumentId = null,
}: ContentLibraryPanelProps) {
  const t = copy[language];
  const [tab, setTab] = useState<"documents" | "templates">("documents");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<LibraryPage>({ items: [], page: 1, pageSize: 12, total: 0 });
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const highlightedRef = useRef<HTMLElement>(null);
  const focusedDocumentId = useRef<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setMessage("");
    const params = new URLSearchParams({ workspaceId, page: String(page), pageSize: "12" });
    if (projectId) params.set("projectId", projectId);
    if (query.trim()) params.set("q", query.trim());
    try {
      const response = await fetch(`/api/crm/${tab}?${params.toString()}`, {
        cache: "no-store",
        credentials: "same-origin",
      });
      const payload = await responsePayload(response) as LibraryPage;
      if (tab === "documents" && initialDocumentId
        && !payload.items.some((item) => item.id === initialDocumentId)) {
        const detail = await fetch(
          `/api/crm/documents/${encodeURIComponent(initialDocumentId)}?workspaceId=${encodeURIComponent(workspaceId)}`,
          { cache: "no-store", credentials: "same-origin" },
        );
        if (detail.ok) {
          const detailPayload = await detail.json() as { document?: LibraryItem };
          if (detailPayload.document) payload.items = [detailPayload.document, ...payload.items];
        }
      }
      setData(payload);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }, [initialDocumentId, page, projectId, query, tab, workspaceId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    if (!initialDocumentId || tab !== "documents" || loading
      || focusedDocumentId.current === initialDocumentId
      || !data.items.some((item) => item.id === initialDocumentId)) return;
    focusedDocumentId.current = initialDocumentId;
    highlightedRef.current?.focus();
    highlightedRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [data.items, initialDocumentId, loading, tab]);

  async function createDocument(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const rawLinkType = String(form.get("linkTargetType") ?? "").trim();
    const linkTargetType = contentLinkTargetTypes.find((value) => value === rawLinkType);
    const linkTargetId = String(form.get("linkTargetId") ?? "").trim();
    setBusyId("create");
    try {
      if ((rawLinkType && !linkTargetType) || Boolean(linkTargetType) !== Boolean(linkTargetId)) {
        throw new Error(t.incompleteLink);
      }
      const response = await csrfFetch(`/api/crm/documents?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": mutationKey() },
        body: JSON.stringify({
          title: form.get("title"),
          mediaAssetId: form.get("mediaAssetId"),
          fileName: form.get("fileName"),
          mimeType: form.get("mimeType"),
          sizeBytes: Number(form.get("sizeBytes")),
          projectId,
          links: linkTargetType && linkTargetId
            ? [{ projectId, targetId: linkTargetId, targetType: linkTargetType }]
            : [],
        }),
      });
      await responsePayload(response);
      event.currentTarget.reset();
      setMessage(language === "de" ? "Dokument wurde verknüpft." : "Document linked.");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Request failed");
    } finally {
      setBusyId(null);
    }
  }

  async function createTemplate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const allowedVariables = String(form.get("allowedVariables") ?? "")
      .split(",").map((item) => item.trim()).filter(Boolean);
    setBusyId("create");
    try {
      const response = await csrfFetch(`/api/crm/templates?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": mutationKey() },
        body: JSON.stringify({
          name: form.get("title"),
          channel: "email",
          defaultLanguage: language,
          language,
          subject: form.get("subject"),
          body: form.get("body"),
          allowedVariables,
          variableFallbacks: Object.fromEntries(allowedVariables.map((name) => [name, ""])),
          projectId,
        }),
      });
      await responsePayload(response);
      event.currentTarget.reset();
      setMessage(language === "de" ? "Vorlage wurde erstellt." : "Template created.");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Request failed");
    } finally {
      setBusyId(null);
    }
  }

  async function mutate(item: LibraryItem, action: "archive" | "restore" | "approve" | "review" | "delete-review") {
    setBusyId(item.id);
    setMessage("");
    const endpoint = `/api/crm/${tab}/${item.id}?workspaceId=${encodeURIComponent(workspaceId)}`;
    const isDeleteReview = action === "delete-review" && tab === "documents";
    const body = action === "approve" || action === "review"
      ? { action: "update", expectedUpdatedAt: item.updatedAt,
          approvalStatus: action === "approve" ? "approved" : "needs_review" }
      : { action, expectedUpdatedAt: item.updatedAt,
          reason: language === "de" ? "Manuelle Content-Library-Aktion" : "Manual Content Library action" };
    try {
      const response = await csrfFetch(endpoint, {
        method: isDeleteReview ? "DELETE" : "PATCH",
        headers: { "Content-Type": "application/json", "Idempotency-Key": mutationKey() },
        body: JSON.stringify(body),
      });
      await responsePayload(response);
      setMessage(isDeleteReview
        ? (language === "de" ? "Löschprüfung wurde angelegt; es wurde nichts gelöscht." : "Deletion review created; nothing was deleted.")
        : (language === "de" ? "Änderung gespeichert." : "Change saved."));
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Request failed");
    } finally {
      setBusyId(null);
    }
  }

  const pageCount = Math.max(1, Math.ceil(data.total / data.pageSize));

  return (
    <section className="space-y-5" aria-labelledby="content-library-title">
      <div>
        <h2 id="content-library-title" className="text-xl font-semibold text-slate-950">{t.title}</h2>
        <p className="mt-1 text-sm text-slate-600">{t.description}</p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="inline-flex rounded-xl border border-slate-200 bg-white p-1" role="tablist">
          {(["documents", "templates"] as const).map((value) => (
            <button key={value} type="button" role="tab" aria-selected={tab === value}
              onClick={() => { setTab(value); setPage(1); }}
              className={`min-h-11 rounded-lg px-4 text-sm font-medium ${tab === value ? "bg-slate-950 text-white" : "text-slate-700 hover:bg-slate-100"}`}>
              {value === "documents" ? t.documents : t.templates}
            </button>
          ))}
        </div>
        <label className="min-w-64 flex-1 text-sm font-medium text-slate-700">
          {t.search}
          <input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }}
            className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 px-3 outline-none focus:border-slate-600 focus:ring-2 focus:ring-slate-200" />
        </label>
      </div>

      {canWrite && (
        tab === "documents" ? (
          <form onSubmit={createDocument} className="grid gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 md:grid-cols-2">
            <h3 className="md:col-span-2 font-semibold text-slate-900">{t.createDocument}</h3>
            <Field name="title" label={t.itemTitle} required />
            <Field name="mediaAssetId" label={t.assetId} required />
            <Field name="fileName" label={t.fileName} required />
            <Field name="mimeType" label={t.mimeType} required defaultValue="application/pdf" />
            <Field name="sizeBytes" label={t.sizeBytes} required type="number" min="0" />
            <label className="text-sm font-medium text-slate-700">
              {t.linkType}
              <select name="linkTargetType" defaultValue=""
                className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 outline-none focus:ring-2 focus:ring-slate-200">
                <option value="">{t.noLink}</option>
                {contentLinkTargetTypes.map((targetType) => (
                  <option key={targetType} value={targetType}>{targetType}</option>
                ))}
              </select>
            </label>
            <Field name="linkTargetId" label={t.linkId} />
            <button disabled={busyId === "create"} className="min-h-11 self-end rounded-xl bg-slate-950 px-4 font-semibold text-white disabled:opacity-50">{t.save}</button>
          </form>
        ) : (
          <form onSubmit={createTemplate} className="grid gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 md:grid-cols-2">
            <h3 className="md:col-span-2 font-semibold text-slate-900">{t.createTemplate}</h3>
            <Field name="title" label={t.itemTitle} required />
            <Field name="subject" label={language === "de" ? "Betreff" : "Subject"} />
            <label className="text-sm font-medium text-slate-700 md:col-span-2">{t.body}
              <textarea name="body" required rows={5} className="mt-1 w-full rounded-xl border border-slate-300 p-3 outline-none focus:ring-2 focus:ring-slate-200" />
            </label>
            <Field name="allowedVariables" label={t.variables} placeholder="contact_name, property_title" />
            <button disabled={busyId === "create"} className="min-h-11 self-end rounded-xl bg-slate-950 px-4 font-semibold text-white disabled:opacity-50">{t.save}</button>
          </form>
        )
      )}

      <p className="min-h-6 text-sm text-slate-700" role="status" aria-live="polite">{message}</p>
      <div aria-busy={loading} className="space-y-3">
        {loading ? <p className="text-sm text-slate-600">{t.loading}</p> : data.items.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-300 p-6 text-sm text-slate-600">{t.empty}</p>
        ) : data.items.map((item) => (
          <article key={item.id}
            ref={tab === "documents" && item.id === initialDocumentId ? highlightedRef : undefined}
            tabIndex={tab === "documents" && item.id === initialDocumentId ? -1 : undefined}
            aria-current={tab === "documents" && item.id === initialDocumentId ? "true" : undefined}
            className={`rounded-2xl border bg-white p-4 shadow-sm outline-none ${tab === "documents" && item.id === initialDocumentId ? "border-indigo-500 ring-2 ring-indigo-200" : "border-slate-200"}`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="font-semibold text-slate-950">{item.title ?? item.name}</h3>
                <p className="mt-1 text-sm text-slate-600">
                  {item.category ?? item.channel} · {t.version} {item.currentVersionNumber} · {item.archivedAt ? t.archived : t.active}
                </p>
              </div>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">{item.approvalStatus}</span>
            </div>
            {canWrite && <div className="mt-4 flex flex-wrap gap-2">
              {!item.archivedAt && item.approvalStatus === "draft" && (
                <ActionButton disabled={busyId === item.id} onClick={() => void mutate(item, "review")}>{t.requestReview}</ActionButton>
              )}
              {canApprove && item.approvalStatus !== "approved" && !item.archivedAt && (
                <ActionButton disabled={busyId === item.id} onClick={() => void mutate(item, "approve")}>{t.approve}</ActionButton>
              )}
              <ActionButton disabled={busyId === item.id}
                onClick={() => void mutate(item, item.archivedAt ? "restore" : "archive")}>
                {item.archivedAt ? t.restore : t.archive}
              </ActionButton>
              {canApprove && tab === "documents" && (
                <ActionButton disabled={busyId === item.id} onClick={() => void mutate(item, "delete-review")}>{t.deletionReview}</ActionButton>
              )}
            </div>}
          </article>
        ))}
      </div>

      <nav className="flex items-center justify-between" aria-label={language === "de" ? "Seitennavigation" : "Pagination"}>
        <button type="button" disabled={page <= 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))}
          className="min-h-11 rounded-xl border border-slate-300 px-4 text-sm font-semibold disabled:opacity-40">{t.previous}</button>
        <span className="text-sm text-slate-600">{page} / {pageCount}</span>
        <button type="button" disabled={page >= pageCount || loading} onClick={() => setPage((value) => value + 1)}
          className="min-h-11 rounded-xl border border-slate-300 px-4 text-sm font-semibold disabled:opacity-40">{t.next}</button>
      </nav>
    </section>
  );
}

function Field(props: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const { label, ...inputProps } = props;
  return <label className="text-sm font-medium text-slate-700">{label}
    <input {...inputProps} className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 px-3 outline-none focus:ring-2 focus:ring-slate-200" />
  </label>;
}

function ActionButton({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...props}
    className="min-h-11 rounded-xl border border-slate-300 px-3 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-40">
    {children}
  </button>;
}
