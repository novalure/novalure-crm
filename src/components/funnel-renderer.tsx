"use client";

import { useEffect, useMemo, useState } from "react";
import { getDeviceValue, type FunnelBlueprint, type FunnelDevice, type FunnelElement, type FunnelField, type FunnelRenderMode } from "@/lib/funnel-schema";

type FunnelRendererProps = {
  blueprint: FunnelBlueprint;
  device?: FunnelDevice;
  mode?: FunnelRenderMode;
  onEvent?: (event: { label: string; detail: string; status: string }) => void;
};

type FieldValue = string | string[] | boolean | number | null;

const deviceWidths: Record<FunnelDevice, string> = {
  desktop: "max-w-5xl",
  tablet: "max-w-3xl",
  mobile: "max-w-[390px]",
};

function fieldInitialValue(field: FunnelField): FieldValue {
  if (field.type === "multiChoice") return [];
  if (field.type === "consent") return false;
  if (field.type === "number" || field.type === "slider" || field.type === "rating") return field.defaultValue ? Number(field.defaultValue) : null;
  return field.defaultValue ?? "";
}

function collectFields(blueprint: FunnelBlueprint) {
  return blueprint.pages.flatMap((page) =>
    page.sections.flatMap((section) =>
      section.rows.flatMap((row) =>
        row.columns.flatMap((column) =>
          column.elements.flatMap((element) => element.fields ?? []),
        ),
      ),
    ),
  );
}

function buildInitialAnswers(blueprint: FunnelBlueprint) {
  return Object.fromEntries(collectFields(blueprint).map((field) => [field.id, fieldInitialValue(field)]));
}

function validateField(field: FunnelField, value: FieldValue) {
  if (!field.required) return null;
  if (field.type === "consent" && value !== true) return field.errorMessage ?? "Dieses Feld ist erforderlich.";
  if (Array.isArray(value) && value.length === 0) return field.errorMessage ?? "Bitte mindestens eine Option wählen.";
  if (value === null || value === "" || value === false) return field.errorMessage ?? "Dieses Feld ist erforderlich.";
  if (field.validationPattern && typeof value === "string") {
    try {
      if (!new RegExp(field.validationPattern).test(value)) return field.errorMessage ?? "Bitte gültigen Wert eintragen.";
    } catch {
      return null;
    }
  }
  return null;
}

function isVisible(element: FunnelElement, device: FunnelDevice) {
  return element.visibility?.[device] ?? true;
}

function formatDestination(destination: FunnelBlueprint["crmHandover"]["destination"]) {
  if (destination === "pipeline") return "Pipeline";
  if (destination === "calendar") return "Kalender";
  if (destination === "newsletter") return "Newsletter Segment";
  return "Lead Inbox";
}

function RichContent({ className, value }: { className?: string; value?: string }) {
  const content = value ?? "";
  if (content.includes("<")) {
    return <span className={className} dangerouslySetInnerHTML={{ __html: content }} />;
  }
  return <span className={className}>{content}</span>;
}

function FieldControl({
  field,
  value,
  error,
  onChange,
}: {
  field: FunnelField;
  value: FieldValue;
  error?: string;
  onChange: (value: FieldValue) => void;
}) {
  if (field.type === "hidden") return null;

  const baseClass = "w-full min-w-0 rounded-md border border-stone-300 bg-white px-3 py-2 text-sm text-slate-950 outline-none focus:border-emerald-700";
  const label = (
    <span className="flex min-w-0 items-center justify-between gap-3">
      <span className="min-w-0 break-words">{field.label}</span>
      {field.required ? <span className="shrink-0 text-xs font-semibold text-emerald-700">Pflicht</span> : null}
    </span>
  );

  if (field.type === "textarea") {
    return (
      <label className="grid min-w-0 gap-1 text-sm font-semibold">
        {label}
        <textarea className={`${baseClass} min-h-24 resize-y`} placeholder={field.placeholder} value={String(value ?? "")} onChange={(event) => onChange(event.target.value)} />
        {field.helpText ? <span className="break-words text-xs font-medium text-stone-500">{field.helpText}</span> : null}
        {error ? <span className="break-words text-xs font-semibold text-red-700">{error}</span> : null}
      </label>
    );
  }

  if (field.type === "singleChoice") {
    return (
      <fieldset className="grid min-w-0 gap-2 text-sm font-semibold">
        <legend>{label}</legend>
        <div className="grid min-w-0 gap-2 sm:grid-cols-2">
          {(field.options ?? []).map((option) => (
            <label className="flex min-w-0 items-center gap-2 rounded-md border border-stone-200 bg-stone-50 px-3 py-2" key={option}>
              <input checked={value === option} name={field.id} onChange={() => onChange(option)} type="radio" />
              <span className="min-w-0 break-words">{option}</span>
            </label>
          ))}
        </div>
        {error ? <span className="break-words text-xs font-semibold text-red-700">{error}</span> : null}
      </fieldset>
    );
  }

  if (field.type === "multiChoice") {
    const selected = Array.isArray(value) ? value : [];
    return (
      <fieldset className="grid min-w-0 gap-2 text-sm font-semibold">
        <legend>{label}</legend>
        <div className="grid min-w-0 gap-2 sm:grid-cols-2">
          {(field.options ?? []).map((option) => (
            <label className="flex min-w-0 items-center gap-2 rounded-md border border-stone-200 bg-stone-50 px-3 py-2" key={option}>
              <input
                checked={selected.includes(option)}
                onChange={(event) =>
                  onChange(event.target.checked ? [...selected, option] : selected.filter((item) => item !== option))
                }
                type="checkbox"
              />
              <span className="min-w-0 break-words">{option}</span>
            </label>
          ))}
        </div>
        {error ? <span className="break-words text-xs font-semibold text-red-700">{error}</span> : null}
      </fieldset>
    );
  }

  if (field.type === "dropdown") {
    return (
      <label className="grid min-w-0 gap-1 text-sm font-semibold">
        {label}
        <select className={baseClass} value={String(value ?? "")} onChange={(event) => onChange(event.target.value)}>
          <option value="">Bitte wählen</option>
          {(field.options ?? []).map((option) => <option key={option}>{option}</option>)}
        </select>
        {error ? <span className="break-words text-xs font-semibold text-red-700">{error}</span> : null}
      </label>
    );
  }

  if (field.type === "consent") {
    return (
      <label className="flex min-w-0 items-start gap-2 rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-sm font-semibold">
        <input checked={value === true} className="mt-1 shrink-0" onChange={(event) => onChange(event.target.checked)} type="checkbox" />
        <span className="min-w-0 break-words">{field.label}</span>
        {error ? <span className="break-words text-xs font-semibold text-red-700">{error}</span> : null}
      </label>
    );
  }

  if (field.type === "slider") {
    return (
      <label className="grid min-w-0 gap-2 text-sm font-semibold">
        {label}
        <input
          className="w-full"
          max={field.max ?? 100}
          min={field.min ?? 0}
          onChange={(event) => onChange(Number(event.target.value))}
          step={field.step ?? 1}
          type="range"
          value={typeof value === "number" ? value : field.min ?? 0}
        />
        <span className="text-xs font-semibold text-stone-500">{String(value ?? field.min ?? 0)}</span>
        {error ? <span className="break-words text-xs font-semibold text-red-700">{error}</span> : null}
      </label>
    );
  }

  const inputType =
    field.type === "email" || field.type === "url" || field.type === "number" || field.type === "date" || field.type === "time"
      ? field.type
      : field.type === "phone"
        ? "tel"
        : "text";

  return (
    <label className="grid min-w-0 gap-1 text-sm font-semibold">
      {label}
      <input
        className={baseClass}
        max={field.max}
        min={field.min}
        placeholder={field.placeholder}
        type={inputType}
        value={String(value ?? "")}
        onChange={(event) => onChange(field.type === "number" ? Number(event.target.value) : event.target.value)}
      />
      {field.helpText ? <span className="break-words text-xs font-medium text-stone-500">{field.helpText}</span> : null}
      {error ? <span className="break-words text-xs font-semibold text-red-700">{error}</span> : null}
    </label>
  );
}

export function FunnelRenderer({ blueprint, device = "mobile", mode = "preview", onEvent }: FunnelRendererProps) {
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, FieldValue>>(() => buildInitialAnswers(blueprint));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitState, setSubmitState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const pages = blueprint.pages;
  const page = pages[Math.min(currentPageIndex, pages.length - 1)];
  const allFields = useMemo(() => collectFields(blueprint), [blueprint]);
  const accent = blueprint.theme.colors.accent;
  const spacing = getDeviceValue(blueprint.theme.spacing, device, 16);

  useEffect(() => {
    if (blueprint.tracking.consentMode !== "active") return;
    const win = window as typeof window & { dataLayer?: Array<Record<string, unknown>>; fbq?: (...args: unknown[]) => void };
    win.dataLayer = win.dataLayer ?? [];
    win.dataLayer.push({ event: "funnel_renderer_loaded", funnelId: blueprint.id, projectId: blueprint.projectId });
    if (blueprint.tracking.metaPixelId && typeof win.fbq === "function") {
      win.fbq("track", "PageView", { funnel_id: blueprint.id });
    }
  }, [blueprint.id, blueprint.projectId, blueprint.tracking.consentMode, blueprint.tracking.metaPixelId]);

  function emit(label: string, detail: string, status: string = mode) {
    onEvent?.({ label, detail, status });
  }

  function setFieldValue(field: FunnelField, value: FieldValue) {
    setAnswers((current) => ({ ...current, [field.id]: value }));
    setErrors((current) => {
      const next = { ...current };
      delete next[field.id];
      return next;
    });
  }

  async function submit(testOnly = mode !== "live") {
    const nextErrors = Object.fromEntries(
      allFields
        .map((field) => [field.id, validateField(field, answers[field.id])] as const)
        .filter(([, error]) => Boolean(error)),
    ) as Record<string, string>;

    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      emit("Validierung", "Pflichtfelder fehlen oder sind ungültig.", "error");
      return;
    }

    setSubmitState("sending");
    try {
      const response = await fetch(`/api/funnels/${blueprint.id}/submissions`, {
        body: JSON.stringify({
          funnelId: blueprint.id,
          mode: testOnly ? "test" : "live",
          answers,
          visitor: { sourceUrl: typeof window !== "undefined" ? window.location.href : undefined },
          consent: { analytics: true, marketing: true, privacy: true },
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (!response.ok) throw new Error("Submission failed");
      const result = (await response.json()) as { leadPreview?: { destination?: string; score?: number } };
      setSubmitState("sent");
      emit(
        testOnly ? "Testlead gesendet" : "Lead gesendet",
        `${blueprint.name} -> ${result.leadPreview?.destination ?? formatDestination(blueprint.crmHandover.destination)}`,
        testOnly ? "test" : "live",
      );
    } catch {
      setSubmitState("error");
      emit("Submission Fehler", "Der Lead konnte nicht verarbeitet werden.", "error");
    }
  }

  function renderElement(element: FunnelElement) {
    if (!isVisible(element, device)) return null;

    if (element.type === "headline") {
      return <h1 className="break-words text-3xl font-semibold leading-tight text-slate-950 md:text-4xl"><RichContent value={element.content} /></h1>;
    }

    if (element.type === "text" || element.type === "testimonial") {
      return (
        <div className="min-w-0 rounded-lg border border-stone-200 bg-stone-50 p-4" style={{ borderRadius: blueprint.theme.radii.block }}>
          <p className="break-words text-sm font-semibold text-slate-950">{element.name}</p>
          <p className="mt-2 break-words text-sm text-stone-700"><RichContent value={element.content} /></p>
        </div>
      );
    }

    if (element.type === "image") {
      return element.url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img alt={element.alt ?? element.name} className="max-h-80 w-full rounded-lg object-cover" loading="lazy" src={element.url} />
      ) : (
        <div className="grid aspect-video min-w-0 place-items-center rounded-lg border border-dashed border-stone-300 bg-stone-50 p-4 text-center text-sm font-semibold text-stone-600">
          Bild aus Medienbibliothek wählen
        </div>
      );
    }

    if (element.type === "button") {
      return (
        <button
          className="w-full min-w-0 px-4 py-3 text-sm font-semibold text-white"
          onClick={() => {
            emit("Funnel gestartet", element.ctaLabel ?? "CTA", "preview");
            setCurrentPageIndex((current) => Math.min(current + 1, pages.length - 1));
          }}
          style={{ backgroundColor: accent, borderRadius: blueprint.theme.radii.button }}
          type="button"
        >
          {element.ctaLabel ?? "Weiter"}
        </button>
      );
    }

    if (element.type === "video") {
      return (
        <div className="grid aspect-video min-w-0 place-items-center rounded-lg border border-stone-200 bg-slate-950 p-4 text-center text-sm font-semibold text-white">
          {element.url ? "Video eingebettet" : "Video-Platzhalter"}
        </div>
      );
    }

    if (element.type === "calendar") {
      return (
        <div className="min-w-0 rounded-lg border border-emerald-200 bg-emerald-50 p-4">
          <p className="break-words text-sm font-semibold text-emerald-950">{element.content ?? "Termin buchen"}</p>
          <button className="mt-3 w-full rounded-md border border-emerald-700 bg-white px-3 py-2 text-sm font-semibold text-emerald-900" type="button">
            Kalender öffnen
          </button>
        </div>
      );
    }

    if (element.type === "html") {
      return <div className="min-w-0 overflow-auto rounded-lg border border-stone-200 bg-stone-50 p-4 text-sm" dangerouslySetInnerHTML={{ __html: element.content ?? "" }} />;
    }

    if (element.type === "choice") {
      return (
        <div className="grid min-w-0 gap-3">
          <p className="break-words text-xl font-semibold text-slate-950">{element.content}</p>
          <div className="grid min-w-0 gap-2">
            {(element.options ?? []).map((option) => (
              <button
                className="min-w-0 rounded-md border border-stone-200 bg-stone-50 p-3 text-left text-sm font-semibold hover:border-emerald-300 hover:bg-emerald-50"
                key={option}
                onClick={() => {
                  emit("Antwort gewählt", `${element.name}: ${option}`, "preview");
                  setCurrentPageIndex((current) => Math.min(current + 1, pages.length - 1));
                }}
                type="button"
              >
                <span className="block min-w-0 break-words">{option}</span>
              </button>
            ))}
          </div>
        </div>
      );
    }

    if (element.type === "form") {
      return (
        <form
          className="grid min-w-0 gap-4 rounded-lg border border-stone-200 bg-white p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(mode !== "live");
          }}
        >
          <div className="min-w-0">
            <p className="break-words text-lg font-semibold text-slate-950">{element.content ?? element.name}</p>
            <p className="mt-1 break-words text-sm text-stone-600">
              Ziel: {formatDestination(blueprint.crmHandover.destination)} / {blueprint.crmHandover.pipelineStage}
            </p>
          </div>
          {(element.fields ?? []).map((field) => (
            <FieldControl
              error={errors[field.id]}
              field={field}
              key={field.id}
              value={answers[field.id]}
              onChange={(value) => setFieldValue(field, value)}
            />
          ))}
          <button
            className="w-full rounded-md px-4 py-3 text-sm font-semibold text-white disabled:opacity-60"
            disabled={submitState === "sending"}
            style={{ backgroundColor: accent, borderRadius: blueprint.theme.radii.button }}
            type="submit"
          >
            {submitState === "sending" ? "Wird geprüft..." : mode === "live" ? "Anfrage senden" : "Testlead prüfen"}
          </button>
          {submitState === "sent" ? <p className="break-words text-sm font-semibold text-emerald-800">Submission wurde verarbeitet.</p> : null}
          {submitState === "error" ? <p className="break-words text-sm font-semibold text-red-700">Submission konnte nicht verarbeitet werden.</p> : null}
        </form>
      );
    }

    return (
      <div className="min-w-0 rounded-lg border border-stone-200 bg-stone-50 p-4">
        <p className="break-words text-sm font-semibold">{element.name}</p>
      </div>
    );
  }

  return (
    <div className={`mx-auto w-full ${deviceWidths[device]} min-w-0`} data-funnel-mode={mode}>
      <div
        className="min-w-0 rounded-[28px] border border-stone-200 bg-white p-4 shadow-sm"
        style={{ backgroundColor: blueprint.theme.colors.background, color: blueprint.theme.colors.text }}
      >
        <div className="mb-4 flex min-w-0 items-center justify-between gap-3 border-b border-stone-200 pb-3 text-xs font-semibold">
          <span className="min-w-0 break-words">{blueprint.theme.logoText}</span>
          <span className="shrink-0" style={{ color: accent }}>
            {device}
          </span>
        </div>
        <div className="mb-4 h-2 overflow-hidden rounded-full bg-stone-100">
          <div className="h-full rounded-full" style={{ backgroundColor: accent, width: `${((currentPageIndex + 1) / Math.max(1, pages.length)) * 100}%` }} />
        </div>
        <div className="grid min-w-0" style={{ gap: spacing }}>
          {page.sections.map((section) => (
            <section className="grid min-w-0 gap-4" key={section.id}>
              {section.rows.map((row) => (
                <div className="grid min-w-0 gap-4" key={row.id}>
                  {row.columns.map((column) => (
                    <div className="grid min-w-0" key={column.id} style={{ gap: spacing }}>
                      {column.elements.map((element) => <div className="min-w-0" key={element.id}>{renderElement(element)}</div>)}
                    </div>
                  ))}
                </div>
              ))}
            </section>
          ))}
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
          <button
            className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50"
            disabled={currentPageIndex === 0}
            onClick={() => setCurrentPageIndex((current) => Math.max(0, current - 1))}
            type="button"
          >
            Zurück
          </button>
          <button
            className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50"
            disabled={currentPageIndex >= pages.length - 1}
            onClick={() => setCurrentPageIndex((current) => Math.min(pages.length - 1, current + 1))}
            type="button"
          >
            Weiter
          </button>
        </div>
      </div>
    </div>
  );
}
