"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { formatDateTime, type LanguageCode } from "@/lib/i18n";

type AuditEntry = {
  action: string;
  actorName: string | null;
  createdAt: string;
  entityId: string | null;
  entityType: string;
  id: string;
  projectId: string | null;
};

type AuditPayload = {
  canExport: boolean;
  entries: AuditEntry[];
  page: number;
  pageSize: number;
  total: number;
};

export function AuditLogPanel({ language }: { language: LanguageCode }) {
  const de = language === "de";
  const [draftQuery, setDraftQuery] = useState("");
  const [query, setQuery] = useState("");
  const [action, setAction] = useState("");
  const [entityType, setEntityType] = useState("");
  const [page, setPage] = useState(1);
  const [payload, setPayload] = useState<AuditPayload | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  const requestParams = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: "20" });
    if (query) params.set("q", query);
    if (action) params.set("action", action);
    if (entityType) params.set("entityType", entityType);
    return params;
  }, [action, entityType, page, query]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/admin/audit-logs?${requestParams.toString()}`, {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("audit_unavailable");
        return response.json() as Promise<AuditPayload>;
      })
      .then((nextPayload) => {
        setPayload(nextPayload);
        setState("ready");
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState("error");
      });
    return () => controller.abort();
  }, [requestParams]);

  const pageCount = Math.max(1, Math.ceil((payload?.total ?? 0) / 20));
  const exportHref = `/api/admin/audit-logs?${new URLSearchParams({
    ...(action ? { action } : {}),
    ...(entityType ? { entityType } : {}),
    ...(query ? { q: query } : {}),
    format: "csv",
  }).toString()}`;

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(1);
    setQuery(draftQuery.trim());
  }

  function resetFilters() {
    setAction("");
    setDraftQuery("");
    setEntityType("");
    setPage(1);
    setQuery("");
  }

  return (
    <section aria-labelledby="audit-log-title" className="grid gap-4">
      <header className="rounded-xl border border-stone-200 bg-white p-5">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">{de ? "Administration" : "Administration"}</p>
        <h2 className="mt-1 text-2xl font-semibold text-stone-950" id="audit-log-title">{de ? "Audit-Log" : "Audit log"}</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-600">
          {de ? "Schreibgeschützte, workspacegebundene Ereignisse mit serverseitiger Rollenprüfung." : "Read-only, workspace-bound events with server-side role checks."}
        </p>
      </header>

      <form className="grid gap-3 rounded-xl border border-stone-200 bg-white p-4 lg:grid-cols-[minmax(0,1fr)_14rem_14rem_auto]" onSubmit={submitSearch}>
        <label className="grid gap-1 text-sm font-medium text-stone-800">
          {de ? "Suche" : "Search"}
          <input className="min-h-11 rounded-lg border border-stone-300 px-3" maxLength={80} onChange={(event) => setDraftQuery(event.target.value)} value={draftQuery} />
        </label>
        <label className="grid gap-1 text-sm font-medium text-stone-800">
          {de ? "Aktion" : "Action"}
          <input className="min-h-11 rounded-lg border border-stone-300 px-3" maxLength={80} onChange={(event) => { setAction(event.target.value); setPage(1); }} value={action} />
        </label>
        <label className="grid gap-1 text-sm font-medium text-stone-800">
          {de ? "Entität" : "Entity"}
          <input className="min-h-11 rounded-lg border border-stone-300 px-3" maxLength={80} onChange={(event) => { setEntityType(event.target.value); setPage(1); }} value={entityType} />
        </label>
        <div className="flex flex-wrap items-end gap-2">
          <button className="min-h-11 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-700" type="submit">{de ? "Filtern" : "Filter"}</button>
          <button className="min-h-11 rounded-lg border border-stone-300 px-4 text-sm font-semibold text-stone-800" onClick={resetFilters} type="button">{de ? "Zurücksetzen" : "Reset"}</button>
        </div>
      </form>

      <div aria-live="polite" className="rounded-xl border border-stone-200 bg-white">
        {state === "loading" ? <p className="p-5 text-sm text-stone-600">{de ? "Audit-Ereignisse werden geladen …" : "Loading audit events…"}</p> : null}
        {state === "error" ? <p className="p-5 text-sm text-red-700" role="alert">{de ? "Audit-Log ist derzeit nicht verfügbar." : "The audit log is currently unavailable."}</p> : null}
        {state === "ready" && payload?.entries.length === 0 ? (
          <div className="p-5">
            <p className="font-semibold text-stone-900">{de ? "Keine passenden Ereignisse" : "No matching events"}</p>
            <button className="mt-3 min-h-11 rounded-lg border border-stone-300 px-4 text-sm font-semibold" onClick={resetFilters} type="button">{de ? "Filter zurücksetzen" : "Reset filters"}</button>
          </div>
        ) : null}
        {state === "ready" && payload?.entries.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-left text-sm">
              <thead className="bg-stone-50 text-xs uppercase tracking-wide text-stone-600">
                <tr>
                  <th className="px-4 py-3" scope="col">{de ? "Zeit" : "Time"}</th>
                  <th className="px-4 py-3" scope="col">{de ? "Akteur" : "Actor"}</th>
                  <th className="px-4 py-3" scope="col">{de ? "Aktion" : "Action"}</th>
                  <th className="px-4 py-3" scope="col">{de ? "Entität" : "Entity"}</th>
                  <th className="px-4 py-3" scope="col">ID</th>
                </tr>
              </thead>
              <tbody>
                {payload.entries.map((entry) => (
                  <tr className="border-t border-stone-200 align-top" key={entry.id}>
                    <td className="px-4 py-3 whitespace-nowrap">{formatDateTime(entry.createdAt, language)}</td>
                    <td className="px-4 py-3">{entry.actorName ?? (de ? "System" : "System")}</td>
                    <td className="px-4 py-3 font-medium text-stone-900">{entry.action}</td>
                    <td className="px-4 py-3">{entry.entityType}</td>
                    <td className="max-w-64 break-all px-4 py-3 font-mono text-xs text-stone-600">{entry.entityId ?? "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      {state === "ready" && payload ? (
        <footer className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-stone-200 bg-white p-4">
          <p className="text-sm text-stone-600">{de ? `Seite ${page} von ${pageCount} · ${payload.total} Ereignisse` : `Page ${page} of ${pageCount} · ${payload.total} events`}</p>
          <div className="flex flex-wrap gap-2">
            {payload.canExport ? <a className="inline-flex min-h-11 items-center rounded-lg border border-stone-300 px-4 text-sm font-semibold text-stone-800" href={exportHref}>{de ? "CSV exportieren" : "Export CSV"}</a> : null}
            <button className="min-h-11 rounded-lg border border-stone-300 px-4 text-sm font-semibold disabled:opacity-50" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))} type="button">{de ? "Zurück" : "Previous"}</button>
            <button className="min-h-11 rounded-lg border border-stone-300 px-4 text-sm font-semibold disabled:opacity-50" disabled={page >= pageCount} onClick={() => setPage((current) => current + 1)} type="button">{de ? "Weiter" : "Next"}</button>
          </div>
        </footer>
      ) : null}
    </section>
  );
}
