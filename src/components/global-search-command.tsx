"use client";

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { csrfFetch } from "@/lib/security/csrf-client";

export type GlobalSearchCommandProps = {
  workspaceId: string;
  projectId: string | null;
  language: "de" | "en";
  enabled?: boolean;
};

type SearchItem = {
  entityType: string;
  id: string;
  title: string;
  subtitle: string;
  projectId: string | null;
  updatedAt: string;
  url: string;
};

type SearchPage = { items: SearchItem[]; page: number; pageSize: number; total: number };

const copy = {
  de: {
    button: "Suchen",
    shortcut: "Strg K",
    title: "Globale Suche",
    placeholder: "Kontakte, Leads, Projekte, Immobilien, Deals, Aufgaben oder Dokumente …",
    allOwners: "Alle zuständigen Personen",
    myRecords: "Meine Datensätze",
    recent: "Zuletzt geöffnet",
    results: "Suchergebnisse",
    empty: "Keine passenden Datensätze.",
    hint: "Mit ↑ und ↓ auswählen, Enter öffnen, Esc schließen.",
    previous: "Zurück",
    next: "Weiter",
    close: "Suche schließen",
  },
  en: {
    button: "Search",
    shortcut: "Ctrl K",
    title: "Global search",
    placeholder: "Contacts, leads, projects, properties, deals, tasks or documents…",
    allOwners: "All owners",
    myRecords: "My records",
    recent: "Recently opened",
    results: "Search results",
    empty: "No matching records.",
    hint: "Use ↑ and ↓ to select, Enter to open, Esc to close.",
    previous: "Previous",
    next: "Next",
    close: "Close search",
  },
} as const;

function mutationKey() {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function GlobalSearchCommand({
  workspaceId,
  projectId,
  language,
  enabled = true,
}: GlobalSearchCommandProps) {
  const t = copy[language];
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [owner, setOwner] = useState<"all" | "me">("all");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<SearchPage>({ items: [], page: 1, pageSize: 12, total: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!enabled) return;
    function onShortcut(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openerRef.current = document.activeElement as HTMLElement | null;
        setOpen(true);
      }
    }
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [enabled]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      document.body.style.overflow = previousOverflow;
      openerRef.current?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError("");
      const params = new URLSearchParams({
        workspaceId,
        page: String(page),
        pageSize: "12",
      });
      if (projectId) params.set("projectId", projectId);
      if (owner === "me") params.set("ownerUserId", "me");
      if (query.trim().length >= 2) params.set("q", query.trim());
      else params.set("mode", "recents");
      try {
        const response = await fetch(`/api/crm/search?${params.toString()}`, {
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal,
        });
        const payload = await response.json() as SearchPage & { error?: string };
        if (!response.ok) throw new Error(payload.error || `Search failed (${response.status})`);
        setData({ items: payload.items ?? [], page: payload.page ?? 1,
          pageSize: payload.pageSize ?? 12, total: payload.total ?? payload.items?.length ?? 0 });
        setActiveIndex(0);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : "Search failed");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, query.trim().length >= 2 ? 220 : 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, owner, page, projectId, query, workspaceId]);

  function close() {
    setOpen(false);
    setQuery("");
    setPage(1);
  }

  async function openItem(item: SearchItem) {
    try {
      await csrfFetch(`/api/crm/search?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": mutationKey() },
        body: JSON.stringify({ action: "record_recent", entityType: item.entityType,
          entityId: item.id, projectId: item.projectId }),
      });
    } finally {
      window.location.assign(item.url);
    }
  }

  function onDialogKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "ArrowDown" && data.items.length) {
      event.preventDefault();
      setActiveIndex((value) => (value + 1) % data.items.length);
    } else if (event.key === "ArrowUp" && data.items.length) {
      event.preventDefault();
      setActiveIndex((value) => (value - 1 + data.items.length) % data.items.length);
    } else if (event.key === "Enter" && data.items[activeIndex]) {
      event.preventDefault();
      void openItem(data.items[activeIndex]);
    } else if (event.key === "Tab") {
      const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href]",
      ));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  if (!enabled) return null;
  const pageCount = Math.max(1, Math.ceil(data.total / data.pageSize));

  return <>
    <button type="button" onClick={(event) => { openerRef.current = event.currentTarget; setOpen(true); }}
      className="inline-flex min-h-11 items-center gap-3 rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 shadow-sm hover:bg-slate-50"
      aria-haspopup="dialog">
      <span aria-hidden="true">⌕</span><span>{t.button}</span>
      <kbd className="rounded border border-slate-200 bg-slate-100 px-2 py-0.5 text-xs font-normal text-slate-500">{t.shortcut}</kbd>
    </button>

    {open && <div className="fixed inset-0 z-[100] flex items-start justify-center bg-slate-950/50 p-4 pt-[10vh]"
      role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="global-search-title"
        onKeyDown={onDialogKeyDown}
        className="flex max-h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center gap-3 border-b border-slate-200 p-4">
          <div className="min-w-0 flex-1">
            <h2 id="global-search-title" className="sr-only">{t.title}</h2>
            <label className="sr-only" htmlFor="novalure-global-search">{t.placeholder}</label>
            <input ref={inputRef} id="novalure-global-search" type="search" value={query}
              onChange={(event) => { setQuery(event.target.value); setPage(1); }}
              placeholder={t.placeholder} autoComplete="off"
              aria-controls="novalure-global-search-results" aria-activedescendant={data.items[activeIndex] ? `global-search-${data.items[activeIndex].id}` : undefined}
              className="min-h-11 w-full rounded-xl border border-slate-300 px-4 text-base outline-none focus:border-slate-600 focus:ring-2 focus:ring-slate-200" />
          </div>
          <button type="button" onClick={close} aria-label={t.close}
            className="min-h-11 min-w-11 rounded-xl border border-slate-300 text-xl text-slate-700 hover:bg-slate-50">×</button>
        </div>
        <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
          <label className="text-sm text-slate-700">
            <span className="sr-only">Owner</span>
            <select value={owner} onChange={(event) => { setOwner(event.target.value as "all" | "me"); setPage(1); }}
              className="min-h-11 rounded-xl border border-slate-300 bg-white px-3">
              <option value="all">{t.allOwners}</option><option value="me">{t.myRecords}</option>
            </select>
          </label>
          <span className="text-xs text-slate-500">{t.hint}</span>
        </div>
        <div className="overflow-y-auto p-3" aria-busy={loading}>
          <p className="px-2 pb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            {query.trim().length >= 2 ? t.results : t.recent}
          </p>
          <p role="status" aria-live="polite" className="sr-only">
            {loading ? (language === "de" ? "Suche läuft" : "Searching") : `${data.total} ${t.results}`}
          </p>
          {error ? <p className="rounded-xl bg-red-50 p-4 text-sm text-red-800">{error}</p>
            : !loading && !data.items.length ? <p className="p-5 text-sm text-slate-600">{t.empty}</p>
            : <ul id="novalure-global-search-results" role="listbox" className="space-y-1">
              {data.items.map((item, index) => <li key={`${item.entityType}-${item.id}`} role="option"
                aria-selected={activeIndex === index} id={`global-search-${item.id}`}>
                <a href={item.url} onMouseEnter={() => setActiveIndex(index)}
                  onClick={(event) => { event.preventDefault(); void openItem(item); }}
                  className={`block rounded-xl px-4 py-3 outline-none ${activeIndex === index ? "bg-slate-950 text-white" : "hover:bg-slate-100"}`}>
                  <span className="block font-semibold">{item.title}</span>
                  <span className={`mt-0.5 block text-sm ${activeIndex === index ? "text-slate-300" : "text-slate-600"}`}>
                    {item.entityType}{item.subtitle ? ` · ${item.subtitle}` : ""}
                  </span>
                </a>
              </li>)}
            </ul>}
        </div>
        {query.trim().length >= 2 && <nav className="flex items-center justify-between border-t border-slate-200 p-3" aria-label="Search pagination">
          <button type="button" disabled={page <= 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))}
            className="min-h-11 rounded-xl border border-slate-300 px-4 text-sm font-semibold disabled:opacity-40">{t.previous}</button>
          <span className="text-sm text-slate-600">{page} / {pageCount}</span>
          <button type="button" disabled={page >= pageCount || loading} onClick={() => setPage((value) => value + 1)}
            className="min-h-11 rounded-xl border border-slate-300 px-4 text-sm font-semibold disabled:opacity-40">{t.next}</button>
        </nav>}
      </div>
    </div>}
  </>;
}
