"use client";

import { useMemo, useState } from "react";
import type { KnowledgeItem, Project } from "@/lib/crm-types";

type KnowledgeImportType = "text" | "faq" | "file" | "url" | "call" | "social";

type PreparedKnowledgeSource = {
  id: string;
  type: KnowledgeImportType;
  title: string;
  location: string;
  approval: "Zu pruefen" | "Freigegeben" | "Nur intern";
  status: "Import bereit" | "Review offen" | "Vector bereit";
  chunks: number;
  embeddedChunks: number;
  gaps: number;
};

const importTypes: Array<{
  id: KnowledgeImportType;
  label: string;
  description: string;
  badge: string;
}> = [
  {
    id: "text",
    label: "Text",
    description: "Plain Text, Verkaufsargumente, interne Notizen oder Skripte.",
    badge: "TXT",
  },
  {
    id: "faq",
    label: "FAQ",
    description: "Fragen und Antworten fuer wiederkehrende Bot-Antworten.",
    badge: "FAQ",
  },
  {
    id: "file",
    label: "Datei",
    description: "PDFs, Whitepaper, Exposes, Preislisten oder Vertragsmuster.",
    badge: "PDF",
  },
  {
    id: "url",
    label: "URL",
    description: "Help-Center, Landingpages, Projektseiten oder Blogartikel.",
    badge: "URL",
  },
  {
    id: "call",
    label: "Call",
    description: "Call-Aufzeichnungen, Transkripte und Beratungsnotizen.",
    badge: "REC",
  },
  {
    id: "social",
    label: "Social",
    description: "Instagram, Facebook, LinkedIn, YouTube oder Ad-Kommentare.",
    badge: "SOC",
  },
];

function parseCoverage(value: string) {
  return Number(value.replace("%", "")) || 0;
}

function estimateChunks(value: string) {
  return Math.max(1, Math.ceil(value.length / 700));
}

function statusForApproval(approval: PreparedKnowledgeSource["approval"]) {
  if (approval === "Freigegeben") return "Vector bereit";
  if (approval === "Nur intern") return "Import bereit";
  return "Review offen";
}

export function KnowledgeCommandCenter({
  items,
  projectLabel,
  projects,
}: {
  items: KnowledgeItem[];
  projectLabel: string;
  projects: Project[];
}) {
  const [selectedType, setSelectedType] = useState<KnowledgeImportType>("text");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [approval, setApproval] = useState<PreparedKnowledgeSource["approval"]>("Zu pruefen");
  const [context, setContext] = useState("");
  const [preparedSources, setPreparedSources] = useState<PreparedKnowledgeSource[]>([
    {
      id: "prepared_call",
      type: "call",
      title: "Beratungscall Wohnpark Graz",
      location: "Transkript / Call Recording",
      approval: "Zu pruefen",
      status: "Review offen",
      chunks: 24,
      embeddedChunks: 0,
      gaps: 3,
    },
    {
      id: "prepared_url",
      type: "url",
      title: "Projektseite Novalure.eu",
      location: "https://novalure.eu/projekte",
      approval: "Freigegeben",
      status: "Vector bereit",
      chunks: 38,
      embeddedChunks: 38,
      gaps: 1,
    },
  ]);

  const existingSources = useMemo(
    () =>
      items.map<PreparedKnowledgeSource>((item) => {
        const chunks = Math.max(1, item.items * 3);
        const approved = item.status === "approved";

        return {
          id: item.id,
          type: item.name.toLowerCase().includes("expose") ? "file" : "faq",
          title: item.name,
          location: projects.find((project) => project.id === item.projectId)?.name ?? projectLabel,
          approval: approved ? "Freigegeben" : "Zu pruefen",
          status: approved ? "Vector bereit" : "Review offen",
          chunks,
          embeddedChunks: approved ? Math.round((chunks * parseCoverage(item.coverage)) / 100) : 0,
          gaps: approved ? 0 : Math.max(1, Math.round((100 - parseCoverage(item.coverage)) / 8)),
        };
      }),
    [items, projectLabel, projects],
  );

  const sources = useMemo(
    () => [...preparedSources, ...existingSources],
    [existingSources, preparedSources],
  );
  const totals = useMemo(() => {
    const chunks = sources.reduce((sum, source) => sum + source.chunks, 0);
    const embedded = sources.reduce((sum, source) => sum + source.embeddedChunks, 0);
    const reviews = sources.filter((source) => source.status === "Review offen").length;
    const gaps = sources.reduce((sum, source) => sum + source.gaps, 0);

    return {
      chunks,
      embedded,
      reviews,
      gaps,
      coverage: chunks ? Math.round((embedded / chunks) * 100) : 0,
    };
  }, [sources]);

  function prepareSource() {
    const sourceTitle = title.trim() || `${importTypes.find((item) => item.id === selectedType)?.label} Quelle`;
    const sourceContent = content.trim() || context.trim() || "Quelle vorbereitet";
    const chunks = estimateChunks(sourceContent);
    const status = statusForApproval(approval);

    setPreparedSources((current) => [
      {
        id: `prepared_${Date.now()}`,
        type: selectedType,
        title: sourceTitle,
        location: context.trim() || sourceContent.slice(0, 90),
        approval,
        status,
        chunks,
        embeddedChunks: status === "Vector bereit" ? chunks : 0,
        gaps: status === "Vector bereit" ? 0 : 1,
      },
      ...current,
    ]);
    setTitle("");
    setContent("");
    setContext("");
  }

  function simulateIndexing() {
    setPreparedSources((current) =>
      current.map((source) =>
        source.approval === "Freigegeben"
          ? {
              ...source,
              status: "Vector bereit",
              embeddedChunks: source.chunks,
              gaps: Math.max(0, source.gaps - 1),
            }
          : source,
      ),
    );
  }

  return (
    <section className="grid gap-4">
      <article className="rounded-lg border border-stone-200 bg-white p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
              Agent fuettern
            </p>
            <h3 className="mt-1 text-2xl font-semibold">Wissensdatenbank aufbauen</h3>
            <p className="mt-2 max-w-4xl break-words text-sm leading-6 text-stone-600">
              Importiere externes Wissen wie Call-Aufzeichnungen, PDFs, Whitepaper,
              Webseiten, Social-Media-Links, FAQs oder Freitext. Jede Quelle wird fuer
              Review, Chunking, Embeddings, Zitate und spaetere Bot-Freigabe vorbereitet.
            </p>
          </div>
          <div className="grid min-w-[320px] gap-2 sm:grid-cols-4 xl:max-w-xl">
            {[
              ["Quellen", sources.length],
              ["Chunks", totals.chunks],
              ["Vector", `${totals.coverage}%`],
              ["Review", totals.reviews],
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

      <section className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
        <article className="rounded-lg border border-stone-200 bg-white p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-lg font-semibold">Upload und Import</h3>
              <p className="mt-1 text-sm text-stone-600">
                Waehle einen Quellentyp und bereite ihn fuer die Freigabe vor.
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
                  className={`grid h-9 w-9 place-items-center rounded-md text-xs font-black ${
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
              Titel
              <input
                className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-900"
                onChange={(event) => setTitle(event.target.value)}
                placeholder="z.B. Rueckerstattungs-FAQ, Call Mitschnitt Q2, Preis-PDF"
                value={title}
              />
            </label>
            <label className="grid gap-1 text-sm font-semibold text-slate-900">
              Quelle oder Inhalt
              <textarea
                className="min-h-28 rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-900"
                onChange={(event) => setContent(event.target.value)}
                placeholder="Text einfuegen, URL eintragen oder Datei/Blob-Pfad vorbereiten"
                value={content}
              />
            </label>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="grid gap-1 text-sm font-semibold text-slate-900">
                Freigabe
                <select
                  className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-900"
                  onChange={(event) =>
                    setApproval(event.target.value as PreparedKnowledgeSource["approval"])
                  }
                  value={approval}
                >
                  <option>Zu pruefen</option>
                  <option>Freigegeben</option>
                  <option>Nur intern</option>
                </select>
              </label>
              <label className="grid gap-1 text-sm font-semibold text-slate-900">
                Domain / Kontext
                <input
                  className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-900"
                  onChange={(event) => setContext(event.target.value)}
                  placeholder="z.B. novalure.eu oder Support DACH"
                  value={context}
                />
              </label>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <button
                className="rounded-md bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white"
                onClick={prepareSource}
                type="button"
              >
                Quelle vorbereiten
              </button>
              <button
                className="rounded-md border border-stone-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800"
                onClick={simulateIndexing}
                type="button"
              >
                Indexierung simulieren
              </button>
            </div>
          </div>
        </article>

        <article className="rounded-lg border border-stone-200 bg-slate-950 p-5 text-white">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <h3 className="text-lg font-semibold">Ingestion Pipeline</h3>
              <p className="mt-1 max-w-2xl text-sm text-slate-300">
                Diese Schritte bereiten Quellen fuer Vercel Blob, Postgres/pgvector,
                Zitate und Bot-Antworten mit striktem Wissensmodus vor.
              </p>
            </div>
            <span className="rounded-md bg-white/10 px-3 py-2 text-xs font-semibold">
              {totals.gaps} Wissensluecken
            </span>
          </div>
          <div className="mt-5 grid gap-3 md:grid-cols-5">
            {["Import", "Bereinigung", "Chunking", "Embedding", "Freigabe"].map((step, index) => (
              <div className="rounded-lg border border-white/10 bg-white/5 p-3" key={step}>
                <span className="grid h-8 w-8 place-items-center rounded-md bg-emerald-300 text-sm font-black text-slate-950">
                  {index + 1}
                </span>
                <p className="mt-3 break-words text-sm font-semibold">{step}</p>
              </div>
            ))}
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-2">
            {[
              "Call-Aufzeichnungen werden zuerst transkribiert und dann geprueft.",
              "PDFs und Whitepaper landen spaeter in Vercel Blob.",
              "URLs und Social Links werden nur aus erlaubten Domains verarbeitet.",
              "Freigegebene Chunks koennen mit pgvector fuer Bot-Antworten gesucht werden.",
            ].map((item) => (
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
            <h3 className="text-lg font-semibold">Quellen und Freigabe</h3>
            <p className="mt-1 text-sm text-stone-600">
              Sichtbar fuer den Bot erst nach Freigabe. Quellen mit Review offen bleiben intern.
            </p>
          </div>
          <span className="rounded-md bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800">
            {totals.embedded} eingebettete Chunks
          </span>
        </div>
        <div className="mt-4 grid gap-3">
          {sources.map((source) => (
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
                  Status
                </p>
                <p className="mt-1 text-sm font-semibold">{source.status}</p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                  Chunks
                </p>
                <p className="mt-1 text-sm font-semibold">
                  {source.embeddedChunks}/{source.chunks}
                </p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                  Review
                </p>
                <p className="mt-1 text-sm font-semibold">{source.approval}</p>
              </div>
            </div>
          ))}
        </div>
      </article>
    </section>
  );
}
