"use client";

import { useEffect, useMemo, useState } from "react";
import type { KnowledgeItem, Project } from "@/lib/crm-types";
import { getKnowledgeCommandCenterCopy, type LanguageCode } from "@/lib/i18n";
import { csrfFetch } from "@/lib/security/csrf-client";

type KnowledgeImportType = "text" | "faq" | "file" | "url" | "call" | "social";

type PreparedKnowledgeSource = {
  id: string;
  type: KnowledgeImportType;
  title: string;
  location: string;
  approval: "Zu prüfen" | "Freigegeben" | "Nur intern";
  status: "Import bereit" | "Review offen" | "Vector bereit";
  chunks: number;
  embeddedChunks: number;
};

type PersistedKnowledgeSource = {
  id: string;
  sourceType: KnowledgeImportType;
  title: string;
  location: string | null;
  status: string;
  chunkCount: number;
  embeddedChunkCount: number;
};

type KnowledgeCommandCenterText = ReturnType<typeof getKnowledgeCommandCenterCopy>;

function buildImportTypes(text: KnowledgeCommandCenterText): Array<{
  id: KnowledgeImportType;
  label: string;
  description: string;
  badge: string;
}> {
  return (["text", "faq", "file", "url", "call", "social"] as const).map((id) => ({
    id,
    ...text.importTypes[id],
  }));
}

function normalizeSourceType(value: string): KnowledgeImportType {
  return value === "faq" ||
    value === "file" ||
    value === "url" ||
    value === "call" ||
    value === "social"
    ? value
    : "text";
}

function sourceFromPersisted(source: PersistedKnowledgeSource): PreparedKnowledgeSource {
  const chunks = Math.max(0, Number(source.chunkCount) || 0);
  const embeddedChunks = Math.min(chunks, Math.max(0, Number(source.embeddedChunkCount) || 0));
  const approved = embeddedChunks > 0 || source.status === "Vector bereit" || source.status === "vector_ready";

  return {
    id: source.id,
    type: normalizeSourceType(source.sourceType),
    title: source.title,
    location: source.location ?? "",
    approval: approved ? "Freigegeben" : "Zu prüfen",
    status: approved ? "Vector bereit" : "Review offen",
    chunks,
    embeddedChunks,
  };
}

export function KnowledgeCommandCenter({
  language,
}: {
  items: KnowledgeItem[];
  language: LanguageCode;
  projectLabel: string;
  projects: Project[];
}) {
  const text = getKnowledgeCommandCenterCopy(language);
  const stateText = language === "de"
    ? {
        database: "Quelle: Knowledge API / Datenbank",
        empty: "Für diesen Workspace sind keine persistierten Wissensquellen vorhanden.",
        importError: "Die Wissensquelle konnte nicht persistiert werden. Es wurde kein lokaler Ersatz angelegt.",
        loading: "Wissensquellen werden aus der Datenbank geladen …",
        loadError: "Wissensquellen konnten nicht geladen werden. Es werden keine Demo- oder Schätzwerte angezeigt.",
        required: "Titel und Quelle beziehungsweise Inhalt sind erforderlich.",
        retry: "Erneut laden",
      }
    : {
        database: "Source: Knowledge API / database",
        empty: "This workspace has no persisted knowledge sources.",
        importError: "The knowledge source could not be persisted. No local replacement was created.",
        loading: "Loading knowledge sources from the database …",
        loadError: "Knowledge sources could not be loaded. No demo or estimated values are being shown.",
        required: "Title and source or content are required.",
        retry: "Retry",
      };
  const importTypes = useMemo(() => buildImportTypes(text), [text]);
  const [selectedType, setSelectedType] = useState<KnowledgeImportType>("text");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [approval, setApproval] = useState<PreparedKnowledgeSource["approval"]>("Zu prüfen");
  const [context, setContext] = useState("");
  const [isSyncing, setIsSyncing] = useState(false);
  const [persistedSources, setPersistedSources] = useState<PreparedKnowledgeSource[]>([]);
  const [loadStatus, setLoadStatus] = useState<"loading" | "ready" | "error">("loading");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [importError, setImportError] = useState("");

  useEffect(() => {
    let active = true;

    async function loadPersistedSources() {
      setLoadStatus("loading");
      setPersistedSources([]);
      try {
        const response = await csrfFetch("/api/bots/knowledge?limit=50", { cache: "no-store" });
        if (!response.ok) throw new Error("Knowledge API unavailable");

        const data = (await response.json()) as {
          source?: string;
          sources?: PersistedKnowledgeSource[];
        };
        if (!active) return;
        if (data.source !== "database" || !Array.isArray(data.sources)) {
          throw new Error("Knowledge API returned a non-database payload");
        }

        setPersistedSources(data.sources.map(sourceFromPersisted));
        setLoadStatus("ready");
      } catch {
        if (active) {
          setPersistedSources([]);
          setLoadStatus("error");
        }
      }
    }

    loadPersistedSources();

    return () => {
      active = false;
    };
  }, [loadAttempt]);

  const sources = persistedSources;
  const totals = useMemo(() => {
    const chunks = sources.reduce((sum, source) => sum + source.chunks, 0);
    const embedded = sources.reduce((sum, source) => sum + source.embeddedChunks, 0);
    const reviews = sources.filter((source) => source.status === "Review offen").length;

    return {
      chunks,
      embedded,
      reviews,
      coverage: chunks ? Math.round((embedded / chunks) * 100) : 0,
    };
  }, [sources]);

  async function prepareSource() {
    const sourceTitle = title.trim();
    const sourceContent = content.trim() || context.trim();
    if (!sourceTitle || !sourceContent) {
      setImportError(stateText.required);
      return;
    }

    setImportError("");
    setIsSyncing(true);
    let persisted = false;

    try {
      const response = await csrfFetch("/api/bots/knowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: sourceTitle,
          contentOrLocation: sourceContent,
          sourceType: selectedType,
          approval,
        }),
      });
      const result = (await response.json()) as {
        sourceId?: string;
        persisted?: boolean;
      };

      if (!response.ok || result.persisted !== true || !result.sourceId) {
        throw new Error("Knowledge source import failed");
      }
      persisted = true;
      setLoadAttempt((current) => current + 1);
    } catch {
      setImportError(stateText.importError);
    } finally {
      setIsSyncing(false);
      if (persisted) {
        setTitle("");
        setContent("");
        setContext("");
      }
    }
  }

  return (
    <section className="grid gap-4">
      <article className="rounded-lg border border-stone-200 bg-white p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
              {text.eyebrow}
            </p>
            <h3 className="mt-1 text-2xl font-semibold">{text.title}</h3>
            <p className="mt-2 max-w-4xl break-words text-sm leading-6 text-stone-600">
              {text.description}
            </p>
            <p
              className="mt-3 inline-flex rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-900"
              data-knowledge-provenance="database"
            >
              {stateText.database}
            </p>
          </div>
          <div className="grid min-w-[320px] gap-2 sm:grid-cols-4 xl:max-w-xl">
            {[
              [text.metrics.sources, loadStatus === "ready" ? sources.length : "—"],
              [text.metrics.chunks, loadStatus === "ready" ? totals.chunks : "—"],
              [text.metrics.vector, loadStatus === "ready" ? `${totals.coverage}%` : "—"],
              [text.metrics.review, loadStatus === "ready" ? totals.reviews : "—"],
            ].map(([label, value]) => (
              <div className="rounded-md border border-stone-200 bg-stone-50 p-3" key={label}>
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                  {label}
                </p>
                <p className="mt-1 text-xl font-semibold text-slate-950">{value}</p>
              </div>
            ))}
          </div>
        </div>
      </article>

      {loadStatus === "loading" ? (
        <div
          aria-live="polite"
          className="rounded-lg border border-stone-200 bg-white p-4 text-sm font-semibold text-stone-600"
          data-knowledge-loading-state="true"
          role="status"
        >
          {stateText.loading}
        </div>
      ) : null}

      {loadStatus === "error" ? (
        <div
          className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-950"
          data-knowledge-error-state="true"
          role="alert"
        >
          <p className="font-semibold">{stateText.loadError}</p>
          <button
            className="mt-3 rounded-md border border-red-300 bg-white px-4 py-2 font-semibold"
            onClick={() => setLoadAttempt((current) => current + 1)}
            type="button"
          >
            {stateText.retry}
          </button>
        </div>
      ) : null}

      <section className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
        <article className="rounded-lg border border-stone-200 bg-white p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-lg font-semibold">{text.importTitle}</h3>
              <p className="mt-1 text-sm text-stone-600">
                {text.importDescription}
              </p>
            </div>
            <span className="rounded-md bg-slate-950 px-3 py-2 text-xs font-semibold text-white">
              {importTypes.find((item) => item.id === selectedType)?.label}
            </span>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {importTypes.map((item) => (
              <button
                className={`rounded-lg border p-3 text-left transition ${
                  selectedType === item.id
                    ? "border-slate-950 bg-slate-950 text-white"
                    : "border-stone-200 bg-stone-50 text-slate-950 hover:border-emerald-300 hover:bg-emerald-50"
                }`}
                key={item.id}
                onClick={() => setSelectedType(item.id)}
                type="button"
              >
                <span
                  className={`grid h-11 w-11 place-items-center rounded-md text-xs font-black ${
                    selectedType === item.id ? "bg-white text-slate-950" : "bg-slate-950 text-white"
                  }`}
                >
                  {item.badge}
                </span>
                <span className="mt-3 block font-semibold">{item.label}</span>
                <span
                  className={`mt-1 block text-xs leading-5 ${
                    selectedType === item.id ? "text-slate-300" : "text-stone-600"
                  }`}
                >
                  {item.description}
                </span>
              </button>
            ))}
          </div>

          <div className="mt-5 grid gap-3">
            <label className="grid gap-1 text-sm font-semibold text-slate-900">
              {text.titleLabel}
              <input
                className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-900"
                maxLength={160}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={text.titlePlaceholder}
                value={title}
              />
            </label>
            <label className="grid gap-1 text-sm font-semibold text-slate-900">
              {text.sourceLabel}
              <textarea
                className="min-h-28 rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-900"
                maxLength={32_000}
                onChange={(event) => setContent(event.target.value)}
                placeholder={text.sourcePlaceholder}
                value={content}
              />
            </label>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="grid gap-1 text-sm font-semibold text-slate-900">
                {text.approvalLabel}
                <select
                  className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-900"
                  onChange={(event) =>
                    setApproval(event.target.value as PreparedKnowledgeSource["approval"])
                  }
                  value={approval}
                >
                  <option value="Zu prüfen">{text.approvals["Zu prüfen"]}</option>
                  <option value="Freigegeben">{text.approvals.Freigegeben}</option>
                  <option value="Nur intern">{text.approvals["Nur intern"]}</option>
                </select>
              </label>
              <label className="grid gap-1 text-sm font-semibold text-slate-900">
                {text.contextLabel}
                <input
                  className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-900"
                  maxLength={32_000}
                  onChange={(event) => setContext(event.target.value)}
                  placeholder={text.contextPlaceholder}
                  value={context}
                />
              </label>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <button
                aria-busy={isSyncing}
                className="rounded-md bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                disabled={isSyncing || loadStatus !== "ready"}
                onClick={prepareSource}
                type="button"
              >
                {text.prepare}
              </button>
            </div>
            {importError ? (
              <p
                className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-950"
                data-knowledge-import-error="true"
                role="alert"
              >
                {importError}
              </p>
            ) : null}
          </div>
        </article>

        <article className="rounded-lg border border-stone-200 bg-slate-950 p-5 text-white">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <h3 className="text-lg font-semibold">{text.pipelineTitle}</h3>
              <p className="mt-1 max-w-2xl text-sm text-slate-300">
                {text.pipelineDescription}
              </p>
            </div>
            <span className="rounded-md bg-white/10 px-3 py-2 text-xs font-semibold">
              {stateText.database}
            </span>
          </div>
          <div className="mt-5 grid gap-3 md:grid-cols-5">
            {text.pipelineSteps.map((step, index) => (
              <div className="rounded-lg border border-white/10 bg-white/5 p-3" key={step}>
                <span className="grid h-8 w-8 place-items-center rounded-md bg-emerald-300 text-sm font-black text-slate-950">
                  {index + 1}
                </span>
                <p className="mt-3 break-words text-sm font-semibold">{step}</p>
              </div>
            ))}
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-2">
            {text.pipelineNotes.map((item) => (
              <div className="rounded-lg border border-white/10 bg-white/5 p-3" key={item}>
                <p className="break-words text-sm text-slate-100">{item}</p>
              </div>
            ))}
          </div>
        </article>
      </section>

      <article className="rounded-lg border border-stone-200 bg-white p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <h3 className="text-lg font-semibold">{text.sourcesTitle}</h3>
            <p className="mt-1 text-sm text-stone-600">
              {text.sourcesDescription}
            </p>
          </div>
          <span className="rounded-md bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800">
            {loadStatus === "ready" ? totals.embedded : "—"} {text.embeddedChunks}
          </span>
        </div>
        <div className="mt-4 grid gap-3">
          {loadStatus === "ready" && sources.length === 0 ? (
            <div
              className="rounded-lg border border-dashed border-stone-300 bg-stone-50 p-5 text-sm font-semibold text-stone-600"
              data-knowledge-empty-state="true"
            >
              {stateText.empty}
            </div>
          ) : null}
          {loadStatus === "ready" ? sources.map((source) => (
            <div
              className="grid gap-3 rounded-lg border border-stone-200 bg-stone-50 p-3 lg:grid-cols-[1fr_120px_120px_120px]"
              key={source.id}
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-md bg-slate-950 px-2 py-1 text-xs font-semibold text-white">
                    {importTypes.find((item) => item.id === source.type)?.label}
                  </span>
                  <p className="break-words text-sm font-semibold text-slate-950">
                    {source.title}
                  </p>
                </div>
                <p className="mt-1 break-words text-xs text-stone-500">{source.location}</p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                  {text.status}
                </p>
                <p className="mt-1 text-sm font-semibold">{text.statuses[source.status]}</p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                  {text.metrics.chunks}
                </p>
                <p className="mt-1 text-sm font-semibold">
                  {source.embeddedChunks}/{source.chunks}
                </p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                  {text.review}
                </p>
                <p className="mt-1 text-sm font-semibold">{text.approvals[source.approval]}</p>
              </div>
            </div>
          )) : null}
        </div>
      </article>
    </section>
  );
}
