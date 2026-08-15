"use client";

import { useEffect, useMemo, useState } from "react";
import { calculateAbTestResults } from "@/lib/funnel-ab-testing";
import { createTrackingSnippet } from "@/lib/funnel-tracking";
import { funnelFieldTypes, type FunnelBlueprint, type FunnelDevice, type FunnelElement, type FunnelElementType, type FunnelField, type FunnelMediaAsset, type FunnelPage, type FunnelRule, type FunnelRuleOperator, type FunnelVersion } from "@/lib/funnel-schema";
import { getFunnelDesignerCopy, getLocale, type LanguageCode } from "@/lib/i18n";
import { MediaLibraryPicker, type CrmMediaAsset } from "@/components/media-library-picker";

type FunnelBlueprintDesignerProps = {
  initialBlueprint: FunnelBlueprint;
  language?: LanguageCode;
  onEvent?: (event: { label: string; detail: string; status: string }) => void;
  variant?: "embedded" | "immersive";
};

type SaveState = "idle" | "saving" | "saved" | "error";
type FunnelDesignerText = ReturnType<typeof getFunnelDesignerCopy>;

const emojiGroups = [
  { label: "Leads", emojis: ["😀", "😁", "🙂", "😊", "😍", "🤝", "🙌", "👏", "👍", "✅", "⭐", "🔥", "🎯", "🚀", "💡", "📈"] },
  { label: "Immobilien", emojis: ["🏡", "🏠", "🏢", "🏘️", "🏗️", "📍", "🗺️", "🔑", "🚪", "🛋️", "🌳", "☀️", "🏙️", "🧱", "📐", "📏"] },
  { label: "Kontakt", emojis: ["📞", "☎️", "📱", "💬", "💌", "📧", "📨", "📅", "⏰", "🕒", "👤", "👥", "📝", "📎", "📤", "📥"] },
  { label: "Conversion", emojis: ["🎉", "🏆", "💎", "💰", "📊", "📌", "🔔", "⚡", "✨", "🎁", "🔍", "🧭", "➡️", "⬇️", "❗", "❓"] },
];
const elementTypes: FunnelElementType[] = ["headline", "text", "button", "image", "video", "form", "choice", "calendar", "html", "spacer", "countdown", "testimonial"];

function cloneBlueprint(blueprint: FunnelBlueprint): FunnelBlueprint {
  return structuredClone(blueprint);
}

function firstElementId(blueprint: FunnelBlueprint) {
  return blueprint.pages[0]?.sections[0]?.rows[0]?.columns[0]?.elements[0]?.id ?? "";
}

function collectElements(blueprint: FunnelBlueprint) {
  return blueprint.pages.flatMap((page) =>
    page.sections.flatMap((section) =>
      section.rows.flatMap((row) =>
        row.columns.flatMap((column) =>
          column.elements.map((element) => ({
            element,
            pageId: page.id,
            sectionId: section.id,
            rowId: row.id,
            columnId: column.id,
          })),
        ),
      ),
    ),
  );
}

function findElement(blueprint: FunnelBlueprint, elementId: string) {
  return collectElements(blueprint).find((item) => item.element.id === elementId)?.element ?? null;
}

function updateElement(blueprint: FunnelBlueprint, elementId: string, patch: Partial<FunnelElement>) {
  const next = cloneBlueprint(blueprint);
  for (const page of next.pages) {
    for (const section of page.sections) {
      for (const row of section.rows) {
        for (const column of row.columns) {
          column.elements = column.elements.map((element) => (element.id === elementId ? { ...element, ...patch } : element));
        }
      }
    }
  }
  return next;
}

function updateElementFields(blueprint: FunnelBlueprint, elementId: string, fields: FunnelField[]) {
  return updateElement(blueprint, elementId, { fields });
}

function addElementToPage(blueprint: FunnelBlueprint, pageId: string, type: FunnelElementType, text: FunnelDesignerText) {
  const next = cloneBlueprint(blueprint);
  const page = next.pages.find((item) => item.id === pageId) ?? next.pages[0];
  const column = page?.sections.at(-1)?.rows[0]?.columns[0] ?? page?.sections[0]?.rows[0]?.columns[0];
  if (!column) return next;

  const id = `${blueprint.id}_element_${new Date().getTime()}`;
  column.elements.push({
    id,
    type,
    name: type === "headline" ? text.defaultHeadline : type === "button" ? text.defaultButton : text.defaultElement,
    content: type === "headline" ? text.defaultHeadline : type === "form" ? text.defaultForm : text.defaultContent,
    ctaLabel: type === "button" ? text.defaultCta : undefined,
    fields: type === "form" ? buildDefaultFields(id, text) : undefined,
    visibility: { desktop: true, tablet: true, mobile: true },
  });
  return next;
}

function addPage(blueprint: FunnelBlueprint, kind: FunnelPage["kind"], text: FunnelDesignerText) {
  const next = cloneBlueprint(blueprint);
  const pageNumber = next.pages.length + 1;
  const id = `${blueprint.id}_page_${new Date().getTime()}`;

  next.pages.push({
    id,
    name: kind === "result" ? `${text.resultPage} ${pageNumber}` : kind === "thankYou" ? `${text.thankYouPage} ${pageNumber}` : `${text.stepPage} ${pageNumber}`,
    slug: `${kind}-${pageNumber}`,
    kind,
    sections: [
      {
        id: `${id}_section`,
        name: kind === "thankYou" ? text.thankYouPage : text.stepPage,
        rows: [
          {
            id: `${id}_row`,
            columns: [
              {
                id: `${id}_column`,
                width: { desktop: 12, tablet: 12, mobile: 12 },
                elements: [
                  {
                    id: `${id}_headline`,
                    type: "headline",
                    name: "Headline",
                    content: kind === "thankYou" ? text.defaultThankYou : text.defaultHeadline,
                    visibility: { desktop: true, tablet: true, mobile: true },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });

  return next;
}

function duplicateElement(blueprint: FunnelBlueprint, elementId: string, text: FunnelDesignerText) {
  const next = cloneBlueprint(blueprint);
  for (const page of next.pages) {
    for (const section of page.sections) {
      for (const row of section.rows) {
        for (const column of row.columns) {
          const index = column.elements.findIndex((element) => element.id === elementId);
          if (index >= 0) {
            const copy = cloneBlueprint({ ...blueprint, pages: [] } as FunnelBlueprint);
            void copy;
            const source = column.elements[index];
            column.elements.splice(index + 1, 0, { ...structuredClone(source), id: `${source.id}_copy_${new Date().getTime()}`, name: `${source.name} ${text.copySuffix}` });
            return next;
          }
        }
      }
    }
  }
  return next;
}

function removeElement(blueprint: FunnelBlueprint, elementId: string) {
  const next = cloneBlueprint(blueprint);
  for (const page of next.pages) {
    for (const section of page.sections) {
      for (const row of section.rows) {
        for (const column of row.columns) {
          if (column.elements.length > 1) {
            column.elements = column.elements.filter((element) => element.id !== elementId);
          }
        }
      }
    }
  }
  return next;
}

function moveElementWithinColumn(blueprint: FunnelBlueprint, draggedId: string, targetId: string) {
  if (draggedId === targetId) return blueprint;
  const next = cloneBlueprint(blueprint);
  for (const page of next.pages) {
    for (const section of page.sections) {
      for (const row of section.rows) {
        for (const column of row.columns) {
          const from = column.elements.findIndex((element) => element.id === draggedId);
          const to = column.elements.findIndex((element) => element.id === targetId);
          if (from >= 0 && to >= 0) {
            const [item] = column.elements.splice(from, 1);
            column.elements.splice(to, 0, item);
            return next;
          }
        }
      }
    }
  }
  return next;
}

function buildDefaultFields(sourceId: string, text: FunnelDesignerText): FunnelField[] {
  return [
    { id: `${sourceId}_name`, type: "text", crmField: "name", label: "Name", placeholder: "Vor- und Nachname", required: true },
    { id: `${sourceId}_email`, type: "email", crmField: "email", label: "E-Mail", placeholder: "name@example.com", required: true },
    { id: `${sourceId}_phone`, type: "phone", crmField: "phone", label: "Telefon", placeholder: "+43 ...", required: true },
    { id: `${sourceId}_consent`, type: "consent", crmField: "privacy_consent", label: text.defaultConsent, required: true, errorMessage: text.defaultConsentError },
  ];
}

function insertToken(value: string | undefined, token: string) {
  return `${value ?? ""}${value ? " " : ""}${token}`;
}

export function FunnelBlueprintDesigner({ initialBlueprint, language = "en", onEvent, variant = "embedded" }: FunnelBlueprintDesignerProps) {
  const text = getFunnelDesignerCopy(language);
  const locale = getLocale(language);
  const isImmersive = variant === "immersive";
  const [blueprint, setBlueprint] = useState(initialBlueprint);
  const [device, setDevice] = useState<FunnelDevice>("mobile");
  const [selectedPageId, setSelectedPageId] = useState(initialBlueprint.pages[0]?.id ?? "");
  const [selectedElementId, setSelectedElementId] = useState(firstElementId(initialBlueprint));
  const [draggedElementId, setDraggedElementId] = useState("");
  const [past, setPast] = useState<FunnelBlueprint[]>([]);
  const [future, setFuture] = useState<FunnelBlueprint[]>([]);
  const [versions, setVersions] = useState<FunnelVersion[]>([]);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [mediaDraft, setMediaDraft] = useState({ name: "", url: "", folder: text.defaultFolder, type: "image" as FunnelMediaAsset["type"] });
  const elements = useMemo(() => collectElements(blueprint), [blueprint]);
  const selectedElement = findElement(blueprint, selectedElementId) ?? elements[0]?.element ?? null;
  const abRows = useMemo(() => calculateAbTestResults(blueprint.variants), [blueprint.variants]);
  const trackingSnippet = useMemo(() => createTrackingSnippet(blueprint), [blueprint]);

  useEffect(() => {
    let active = true;
    fetch(`/api/funnels/${initialBlueprint.id}/blueprint`)
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: { blueprint?: FunnelBlueprint; versions?: FunnelVersion[] } | null) => {
        if (!active || !payload?.blueprint) return;
        setBlueprint(payload.blueprint);
        setVersions(payload.versions ?? []);
        setSelectedPageId(payload.blueprint.pages[0]?.id ?? "");
        setSelectedElementId(firstElementId(payload.blueprint));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [initialBlueprint]);

  function commit(next: FunnelBlueprint, label: string) {
    setPast((current) => [blueprint, ...current].slice(0, 50));
    setFuture([]);
    setBlueprint(next);
    onEvent?.({ label, detail: blueprint.name, status: "designer" });
  }

  function updateSelectedElement(patch: Partial<FunnelElement>) {
    if (!selectedElement) return;
    commit(updateElement(blueprint, selectedElement.id, patch), text.editedEvent);
  }

  function undo() {
    const previous = past[0];
    if (!previous) return;
    setFuture((current) => [blueprint, ...current].slice(0, 50));
    setPast((current) => current.slice(1));
    setBlueprint(previous);
  }

  function redo() {
    const next = future[0];
    if (!next) return;
    setPast((current) => [blueprint, ...current].slice(0, 50));
    setFuture((current) => current.slice(1));
    setBlueprint(next);
  }

  async function saveBlueprint() {
    setSaveState("saving");
    try {
      const response = await fetch(`/api/funnels/${blueprint.id}/blueprint`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ blueprint, label: "Designer-Version" }),
      });
      if (!response.ok) throw new Error("Save failed");
      const payload = (await response.json()) as { versions?: FunnelVersion[] };
      setVersions(payload.versions ?? []);
      setSaveState("saved");
      onEvent?.({ label: text.savedEvent, detail: text.savedDetail, status: "CRM" });
    } catch {
      setSaveState("error");
    }
  }

  function addMediaAsset() {
    if (!mediaDraft.name.trim() || !mediaDraft.url.trim()) return;
    const asset: FunnelMediaAsset = {
      id: `${blueprint.id}_media_${new Date().getTime()}`,
      name: mediaDraft.name.trim(),
      type: mediaDraft.type,
      url: mediaDraft.url.trim(),
      folder: mediaDraft.folder.trim() || text.defaultFolder,
      alt: mediaDraft.name.trim(),
      createdAt: new Date().toISOString(),
    };
    commit({ ...blueprint, mediaLibrary: [asset, ...(blueprint.mediaLibrary ?? [])] }, text.mediaAddedEvent);
    setMediaDraft({ name: "", url: "", folder: text.defaultFolder, type: "image" });
  }

  function applyMedia(asset: FunnelMediaAsset) {
    if (!selectedElement) return;
    updateSelectedElement({ type: asset.type === "video" ? "video" : "image", url: asset.url, alt: asset.alt, content: asset.name });
  }

  function applyUploadedMedia(asset: CrmMediaAsset) {
    if (!selectedElement) return;
    const funnelAsset: FunnelMediaAsset = {
      id: asset.id,
      name: asset.name,
      type: "image",
      url: asset.url,
      folder: asset.folder,
      alt: asset.alt || asset.name,
      createdAt: asset.createdAt,
    };
    const mediaLibrary = blueprint.mediaLibrary?.some((item) => item.id === asset.id)
      ? blueprint.mediaLibrary
      : [funnelAsset, ...(blueprint.mediaLibrary ?? [])];
    const next = updateElement({ ...blueprint, mediaLibrary }, selectedElement.id, {
      alt: funnelAsset.alt,
      content: funnelAsset.name,
      type: "image",
      url: funnelAsset.url,
    });
    commit(next, text.mediaAddedEvent);
  }

  function updateField(fieldId: string, patch: Partial<FunnelField>) {
    if (!selectedElement) return;
    const fields = (selectedElement.fields ?? []).map((field) => (field.id === fieldId ? { ...field, ...patch } : field));
    commit(updateElementFields(blueprint, selectedElement.id, fields), text.fieldEditedEvent);
  }

  function addField() {
    if (!selectedElement) return;
    const fields = [
      ...(selectedElement.fields ?? []),
      {
        id: `${selectedElement.id}_field_${new Date().getTime()}`,
        type: "text" as const,
        crmField: "custom_field",
        label: text.defaultField,
        placeholder: "",
        required: false,
      },
    ];
    commit(updateElementFields(blueprint, selectedElement.id, fields), text.fieldAddedEvent);
  }

  const selectedPage = blueprint.pages.find((page) => page.id === selectedPageId) ?? blueprint.pages[0];
  const pageElements = elements.filter((item) => item.pageId === selectedPage?.id);
  const fullPreviewUrl =
    typeof window === "undefined"
      ? `/preview/${blueprint.id}?device=${device}&mode=test&lang=${language}&token=local`
      : `${window.location.origin}/preview/${blueprint.id}?device=${device}&mode=test&lang=${language}&token=local`;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=144x144&data=${encodeURIComponent(fullPreviewUrl)}`;
  const deviceFrameClass: Record<FunnelDevice, string> = {
    desktop: "max-w-5xl",
    tablet: "max-w-3xl",
    mobile: "max-w-[390px]",
  };
  const conditionRule =
    selectedElement?.condition?.rules.find((rule): rule is FunnelRule => !("rules" in rule)) ?? null;
  const designerShellClass = isImmersive ? "flex h-full min-h-0 flex-col gap-3" : "grid min-w-0 gap-4";
  const designerToolbarClass = isImmersive
    ? "flex shrink-0 flex-wrap items-center justify-between gap-3 rounded-lg border border-stone-200 bg-white p-3"
    : "flex flex-wrap items-center justify-between gap-3 rounded-lg border border-stone-200 bg-white p-4";
  const workspaceGridClass = isImmersive
    ? "grid min-h-0 min-w-0 flex-1 gap-3 lg:grid-cols-[240px_minmax(0,1fr)] xl:grid-cols-[240px_minmax(0,1fr)_330px] 2xl:grid-cols-[280px_minmax(0,1fr)_380px]"
    : "grid min-w-0 gap-4 2xl:grid-cols-[260px_minmax(0,1fr)_390px]";
  const leftPanelClass = isImmersive
    ? "grid min-h-0 min-w-0 content-start gap-4 overflow-y-auto rounded-lg border border-stone-200 bg-white p-4"
    : "grid min-w-0 content-start gap-4 rounded-lg border border-stone-200 bg-white p-4";
  const canvasPanelClass = isImmersive
    ? "grid min-h-0 min-w-0 content-start gap-4 overflow-y-auto rounded-lg border border-stone-200 bg-stone-50 p-4"
    : "grid min-w-0 content-start gap-4 rounded-lg border border-stone-200 bg-stone-50 p-4";
  const previewGridClass = isImmersive
    ? "grid min-h-[520px] gap-4 2xl:grid-cols-[minmax(0,1fr)_160px]"
    : "grid gap-4 2xl:grid-cols-[minmax(0,1fr)_160px]";
  const inspectorPanelClass = isImmersive ? "grid min-h-0 min-w-0 content-start gap-4 overflow-y-auto pr-1" : "grid min-w-0 gap-4";
  const qrPanelClass = isImmersive
    ? "hidden content-start rounded-lg border border-stone-200 bg-white p-3 2xl:grid"
    : "hidden content-start rounded-lg border border-stone-200 bg-white p-3 2xl:grid";

  function selectPage(pageId: string) {
    setSelectedPageId(pageId);
    const firstElement = collectElements(blueprint).find((item) => item.pageId === pageId)?.element;
    if (firstElement) setSelectedElementId(firstElement.id);
  }

  function addDesignerPage(kind: FunnelPage["kind"]) {
    const next = addPage(blueprint, kind, text);
    const page = next.pages.at(-1);
    commit(next, text.pageAddedEvent);
    if (page) {
      setSelectedPageId(page.id);
      setSelectedElementId(firstElementId({ ...next, pages: [page] }));
    }
  }

  function addDesignerElement(type: FunnelElementType) {
    if (!selectedPage) return;
    const next = addElementToPage(blueprint, selectedPage.id, type, text);
    const addedElement = collectElements(next)
      .filter((item) => item.pageId === selectedPage.id)
      .at(-1)?.element;
    commit(next, text.addedEvent);
    if (addedElement) setSelectedElementId(addedElement.id);
  }

  function applyAssistantStep(step: "brand" | "offer" | "questions" | "form" | "calendar" | "tracking" | "publish") {
    const nextElement =
      step === "offer"
        ? elements.find((item) => item.element.type === "headline")?.element
        : step === "form"
          ? elements.find((item) => item.element.type === "form")?.element
          : step === "calendar"
            ? elements.find((item) => item.element.type === "calendar")?.element
            : step === "questions"
              ? elements.find((item) => item.element.type === "choice")?.element
              : null;

    if (nextElement) {
      setSelectedElementId(nextElement.id);
      const page = elements.find((item) => item.element.id === nextElement.id)?.pageId;
      if (page) setSelectedPageId(page);
    }

    onEvent?.({ label: text.assistantTitle, detail: text.assistantSteps[step], status: step === "publish" ? "preview" : "designer" });
  }

  function updateSelectedStyles(patch: NonNullable<FunnelElement["styles"]>) {
    if (!selectedElement) return;
    updateSelectedElement({ styles: { ...(selectedElement.styles ?? {}), ...patch } });
  }

  function updateSelectedVisibility(deviceKey: FunnelDevice, visible: boolean) {
    if (!selectedElement) return;
    updateSelectedElement({
      visibility: {
        desktop: selectedElement.visibility?.desktop ?? true,
        tablet: selectedElement.visibility?.tablet ?? true,
        mobile: selectedElement.visibility?.mobile ?? true,
        [deviceKey]: visible,
      },
    });
  }

  function setSelectedCondition(enabled: boolean) {
    if (!selectedElement) return;
    updateSelectedElement({
      condition: enabled
        ? {
            id: `${selectedElement.id}_condition`,
            mode: "and",
            rules: [
              {
                id: `${selectedElement.id}_condition_rule`,
                field: selectedElement.crmField ?? "interest",
                operator: "exists",
                value: "",
              },
            ],
          }
        : undefined,
    });
  }

  function updateSelectedCondition(patch: { field?: string; operator?: FunnelRuleOperator; value?: string }) {
    if (!selectedElement?.condition || !conditionRule) return;
    updateSelectedElement({
      condition: {
        ...selectedElement.condition,
        rules: selectedElement.condition.rules.map((rule) =>
          "rules" in rule ? rule : rule.id === conditionRule.id ? { ...rule, ...patch } : rule,
        ),
      },
    });
  }

  function richPreview(value: string | undefined) {
    const content = value ?? "";
    if (content.includes("<")) return <span dangerouslySetInnerHTML={{ __html: content }} />;
    return <span>{content}</span>;
  }

  function renderDesignerElement(element: FunnelElement) {
    const isSelected = selectedElement?.id === element.id;
    const radius = element.styles?.borderRadius ?? blueprint.theme.radii.block;
    const style = {
      backgroundColor: element.styles?.background,
      color: element.styles?.textColor,
      borderColor: element.styles?.borderColor,
      borderWidth: element.styles?.borderWidth,
      borderRadius: radius,
      textAlign: element.styles?.align,
    } as const;
    const wrapperClass = `w-full min-w-0 rounded-lg border p-3 text-left transition ${
      isSelected ? "border-slate-950 bg-white shadow-sm ring-2 ring-slate-950/10" : "border-stone-200 bg-white hover:border-slate-400"
    }`;

    return (
      <button className={wrapperClass} key={element.id} onClick={() => setSelectedElementId(element.id)} style={style} type="button">
        {element.type === "headline" ? <h2 className="break-words text-3xl font-semibold leading-tight">{richPreview(element.content)}</h2> : null}
        {element.type === "text" || element.type === "testimonial" ? (
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{element.name}</p>
            <p className="mt-2 break-words text-sm text-stone-700">{richPreview(element.content)}</p>
          </div>
        ) : null}
        {element.type === "button" ? (
          <span className="block rounded-md px-4 py-3 text-center text-sm font-semibold text-white" style={{ backgroundColor: blueprint.theme.colors.accent, borderRadius: blueprint.theme.radii.button }}>
            {element.ctaLabel ?? text.defaultCta}
          </span>
        ) : null}
        {element.type === "image" ? (
          element.url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img alt={element.alt ?? element.name} className="max-h-72 w-full rounded-md object-cover" src={element.url} />
          ) : (
            <span className="grid aspect-video place-items-center rounded-md border border-dashed border-stone-300 bg-stone-50 text-sm font-semibold text-stone-500">{text.imagePlaceholder}</span>
          )
        ) : null}
        {element.type === "video" ? <span className="grid aspect-video place-items-center rounded-md bg-slate-950 text-sm font-semibold text-white">{element.url ? text.videoEmbedded : text.videoPlaceholder}</span> : null}
        {element.type === "choice" ? (
          <div className="grid gap-2">
            <p className="break-words text-lg font-semibold">{element.content}</p>
            {(element.options ?? []).map((option) => <span className="rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-sm font-semibold" key={option}>{option}</span>)}
          </div>
        ) : null}
        {element.type === "form" ? (
          <div className="grid gap-2">
            <p className="break-words text-lg font-semibold">{element.content ?? element.name}</p>
            {(element.fields ?? []).slice(0, 4).map((field) => (
              <span className="rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-sm text-stone-600" key={field.id}>{field.label}</span>
            ))}
          </div>
        ) : null}
        {element.type === "calendar" ? <span className="block rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm font-semibold text-emerald-950">{element.content ?? text.calendarPlaceholder}</span> : null}
        {element.type === "html" ? <span className="block max-h-40 overflow-auto rounded-md bg-stone-50 p-3 text-xs">{element.content}</span> : null}
        {element.type === "spacer" ? <span className="block h-10 rounded-md border border-dashed border-stone-300 bg-stone-50" /> : null}
        {element.type === "countdown" ? <span className="block rounded-md bg-amber-50 p-4 text-center text-sm font-semibold text-amber-900">{element.content ?? text.countdownPlaceholder}</span> : null}
      </button>
    );
  }

  return (
    <div className={designerShellClass}>
      <div className={designerToolbarClass}>
        <div className="min-w-0">
          <p className="text-sm font-semibold">{text.title}</p>
          <p className="mt-1 break-words text-xs text-stone-600">{text.description}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold disabled:opacity-50" disabled={!past.length} onClick={undo} type="button">{text.undo}</button>
          <button className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold disabled:opacity-50" disabled={!future.length} onClick={redo} type="button">{text.redo}</button>
          <button className="rounded-md bg-slate-950 px-3 py-2 text-sm font-semibold text-white" onClick={saveBlueprint} type="button">{saveState === "saving" ? text.saving : text.save}</button>
        </div>
      </div>

      <div className={workspaceGridClass}>
        <aside className={leftPanelClass}>
          <div>
            <p className="text-sm font-semibold">{text.assistantTitle}</p>
            <div className="mt-3 grid gap-2">
              {(["brand", "offer", "questions", "form", "calendar", "tracking", "publish"] as const).map((step) => (
                <button className="rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-left text-xs font-semibold text-slate-800 hover:border-slate-400 hover:bg-white" key={step} onClick={() => applyAssistantStep(step)} type="button">
                  {text.assistantSteps[step]}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold">{text.pages}</p>
              <button className="rounded-md border border-stone-300 px-2 py-1 text-xs font-semibold" onClick={() => addDesignerPage("step")} type="button">{text.addPage}</button>
            </div>
            <div className="mt-3 grid gap-2">
              {blueprint.pages.map((page, index) => (
                <button className={`rounded-md border px-3 py-2 text-left text-sm ${selectedPage?.id === page.id ? "border-slate-950 bg-slate-950 text-white" : "border-stone-200 bg-stone-50 text-slate-900"}`} key={page.id} onClick={() => selectPage(page.id)} type="button">
                  <span className="block text-xs font-semibold uppercase tracking-[0.12em] opacity-70">{index + 1} · {page.kind}</span>
                  <span className="block break-words font-semibold">{page.name}</span>
                </button>
              ))}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button className="rounded-md border border-stone-300 px-2 py-1 text-xs font-semibold" onClick={() => addDesignerPage("result")} type="button">{text.resultPage}</button>
              <button className="rounded-md border border-stone-300 px-2 py-1 text-xs font-semibold" onClick={() => addDesignerPage("thankYou")} type="button">{text.thankYouPage}</button>
            </div>
          </div>

          <div>
            <p className="text-sm font-semibold">{text.pageElements}</p>
            <div className="mt-3 grid gap-2">
              {pageElements.map(({ element }) => (
                <button
                  className={`rounded-md border px-3 py-2 text-left text-xs font-semibold ${
                    selectedElement?.id === element.id
                      ? "border-slate-950 bg-slate-950 text-white"
                      : "border-stone-200 bg-stone-50 text-slate-700 hover:border-slate-400 hover:bg-white"
                  }`}
                  draggable
                  key={element.id}
                  onClick={() => setSelectedElementId(element.id)}
                  onDragEnd={() => setDraggedElementId("")}
                  onDragOver={(event) => event.preventDefault()}
                  onDragStart={() => setDraggedElementId(element.id)}
                  onDrop={() => draggedElementId && commit(moveElementWithinColumn(blueprint, draggedElementId, element.id), text.movedEvent)}
                  type="button"
                >
                  <span className="block break-words">{element.name}</span>
                  <span className="mt-1 block text-[11px] uppercase tracking-[0.1em] opacity-70">
                    {text.elementTypes[element.type]}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="text-sm font-semibold">{text.elements}</p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {elementTypes.map((type) => (
                <button className="rounded-md border border-stone-300 bg-white px-2 py-2 text-xs font-semibold" key={type} onClick={() => addDesignerElement(type)} type="button">{text.elementTypes[type]}</button>
              ))}
            </div>
          </div>
        </aside>

        <div className={canvasPanelClass}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-2">
              {(["mobile", "tablet", "desktop"] as const).map((item) => (
                <button className={`rounded-md border px-3 py-2 text-xs font-semibold ${device === item ? "border-slate-950 bg-slate-950 text-white" : "border-stone-300 bg-white text-slate-800"}`} key={item} onClick={() => setDevice(item)} type="button">
                  {item}
                </button>
              ))}
            </div>
            <a className="rounded-md bg-slate-950 px-3 py-2 text-xs font-semibold text-white" href={fullPreviewUrl} rel="noreferrer" target="_blank">{text.openPreview}</a>
          </div>
          <div className={previewGridClass}>
            <div className={`mx-auto grid w-full ${deviceFrameClass[device]} gap-4 rounded-[28px] border border-stone-300 bg-white p-4 shadow-sm`} style={{ backgroundColor: blueprint.theme.colors.background, color: blueprint.theme.colors.text }}>
              <div className="flex items-center justify-between border-b border-stone-200 pb-3 text-xs font-semibold">
                <span className="break-words">{blueprint.theme.logoText}</span>
                <span style={{ color: blueprint.theme.colors.accent }}>{selectedPage?.name}</span>
              </div>
              {selectedPage?.sections.map((section) => (
                <section className="grid gap-4" key={section.id}>
                  {section.rows.map((row) => (
                    <div className="grid gap-4" key={row.id}>
                      {row.columns.map((column) => (
                        <div className="grid gap-3" key={column.id}>
                          {column.elements.map(renderDesignerElement)}
                        </div>
                      ))}
                    </div>
                  ))}
                </section>
              ))}
            </div>
            <div className={qrPanelClass}>
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{text.mobileQr}</p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img alt={text.mobileQr} className="mt-3 h-36 w-36 rounded-md border border-stone-200" src={qrUrl} />
              <p className="mt-3 break-all text-xs text-stone-500">{fullPreviewUrl}</p>
            </div>
          </div>
        </div>

        <aside className={inspectorPanelClass}>
          <div className="rounded-lg border border-stone-200 bg-white p-4">
            <p className="text-sm font-semibold">{text.inspector}</p>
            {selectedElement ? (
              <div className="mt-3 grid min-w-0 gap-3">
                <label className="grid gap-1 text-sm font-semibold">{text.type}<select className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm" value={selectedElement.type} onChange={(event) => updateSelectedElement({ type: event.target.value as FunnelElementType })}>{elementTypes.map((type) => <option key={type} value={type}>{text.elementTypes[type]}</option>)}</select></label>
                <label className="grid gap-1 text-sm font-semibold">{text.name}<input className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm" value={selectedElement.name} onChange={(event) => updateSelectedElement({ name: event.target.value })} /></label>
                <div className="grid gap-2">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{text.richText}</p>
                  <div className="flex flex-wrap gap-2">
                    <button className="rounded-md border border-stone-300 px-2 py-1 text-xs font-semibold" onClick={() => updateSelectedElement({ content: insertToken(selectedElement.content, "<strong>Text</strong>") })} type="button">B</button>
                    <button className="rounded-md border border-stone-300 px-2 py-1 text-xs font-semibold italic" onClick={() => updateSelectedElement({ content: insertToken(selectedElement.content, "<em>Text</em>") })} type="button">I</button>
                    <button className="rounded-md border border-stone-300 px-2 py-1 text-xs font-semibold underline" onClick={() => updateSelectedElement({ content: insertToken(selectedElement.content, "<u>Text</u>") })} type="button">U</button>
                    <button className="rounded-md border border-stone-300 px-2 py-1 text-xs font-semibold" onClick={() => updateSelectedElement({ content: insertToken(selectedElement.content, "<a href='#'>Link</a>") })} type="button">Link</button>
                    <button className="rounded-md border border-stone-300 px-2 py-1 text-xs font-semibold text-emerald-700" onClick={() => updateSelectedElement({ content: insertToken(selectedElement.content, "<span style='color:#047857'>Text</span>") })} type="button">{text.color}</button>
                  </div>
                  <details className="rounded-md border border-stone-200 bg-white p-3">
                    <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{text.emojiToggle}</summary>
                    <div className="mt-3 grid gap-3">
                      {emojiGroups.map((group) => (
                        <div className="grid gap-2" key={group.label}>
                          <p className="text-xs font-semibold text-stone-600">{group.label}</p>
                          <div className="flex flex-wrap gap-1">
                            {group.emojis.map((emoji) => (
                              <button className="rounded-md border border-stone-200 bg-stone-50 px-2 py-1 text-sm hover:border-slate-400 hover:bg-white" key={`${group.label}_${emoji}`} onClick={() => updateSelectedElement({ content: insertToken(selectedElement.content, emoji) })} type="button">{emoji}</button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </details>
                </div>
                <label className="grid gap-1 text-sm font-semibold">{text.content}<textarea className="min-h-28 w-full rounded-md border border-stone-300 px-3 py-2 text-sm" value={selectedElement.content ?? ""} onChange={(event) => updateSelectedElement({ content: event.target.value })} /></label>
                <label className="grid gap-1 text-sm font-semibold">{text.buttonText}<input className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm" value={selectedElement.ctaLabel ?? ""} onChange={(event) => updateSelectedElement({ ctaLabel: event.target.value })} /></label>
                <label className="grid gap-1 text-sm font-semibold">{text.mediaUrl}<input className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm" value={selectedElement.url ?? ""} onChange={(event) => updateSelectedElement({ url: event.target.value })} /></label>
                <div className="grid gap-2 rounded-md border border-stone-200 bg-stone-50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{text.deviceVisibility}</p>
                  <div className="grid grid-cols-3 gap-2 text-xs font-semibold">
                    {(["mobile", "tablet", "desktop"] as const).map((item) => (
                      <label className="flex items-center gap-1" key={item}>
                        <input checked={selectedElement.visibility?.[item] ?? true} onChange={(event) => updateSelectedVisibility(item, event.target.checked)} type="checkbox" />
                        {item}
                      </label>
                    ))}
                  </div>
                </div>
                <div className="grid gap-2 rounded-md border border-stone-200 bg-stone-50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{text.stylePanel}</p>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="grid gap-1 text-xs font-semibold">{text.background}<input className="h-10 w-full rounded-md border border-stone-300 bg-white px-1" type="color" value={selectedElement.styles?.background ?? "#ffffff"} onChange={(event) => updateSelectedStyles({ background: event.target.value })} /></label>
                    <label className="grid gap-1 text-xs font-semibold">{text.textColor}<input className="h-10 w-full rounded-md border border-stone-300 bg-white px-1" type="color" value={selectedElement.styles?.textColor ?? blueprint.theme.colors.text} onChange={(event) => updateSelectedStyles({ textColor: event.target.value })} /></label>
                    <label className="grid gap-1 text-xs font-semibold">{text.borderColor}<input className="h-10 w-full rounded-md border border-stone-300 bg-white px-1" type="color" value={selectedElement.styles?.borderColor ?? "#e7e5e4"} onChange={(event) => updateSelectedStyles({ borderColor: event.target.value })} /></label>
                    <label className="grid gap-1 text-xs font-semibold">{text.radius}<input className="w-full rounded-md border border-stone-300 px-2 py-2 text-sm" type="number" value={selectedElement.styles?.borderRadius ?? blueprint.theme.radii.block} onChange={(event) => updateSelectedStyles({ borderRadius: Number(event.target.value) })} /></label>
                  </div>
                </div>
                <div className="grid gap-2 rounded-md border border-stone-200 bg-stone-50 p-3">
                  <label className="flex items-center gap-2 text-sm font-semibold"><input checked={Boolean(selectedElement.condition)} onChange={(event) => setSelectedCondition(event.target.checked)} type="checkbox" /> {text.conditionalDisplay}</label>
                  {selectedElement.condition && conditionRule ? (
                    <div className="grid gap-2">
                      <input className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm" value={conditionRule.field} onChange={(event) => updateSelectedCondition({ field: event.target.value })} placeholder={text.conditionField} />
                      <select className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm" value={conditionRule.operator} onChange={(event) => updateSelectedCondition({ operator: event.target.value as FunnelRuleOperator })}>
                        {(["exists", "equals", "notEquals", "contains", "greaterThan", "lessThan"] as const).map((operator) => <option key={operator} value={operator}>{operator}</option>)}
                      </select>
                      <input className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm" value={String(conditionRule.value ?? "")} onChange={(event) => updateSelectedCondition({ value: event.target.value })} placeholder={text.conditionValue} />
                    </div>
                  ) : null}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button className="rounded-md border border-stone-300 px-3 py-2 text-sm font-semibold" onClick={() => commit(duplicateElement(blueprint, selectedElement.id, text), text.duplicatedEvent)} type="button">{text.duplicate}</button>
                  <button className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-900" onClick={() => commit(removeElement(blueprint, selectedElement.id), text.removedEvent)} type="button">{text.remove}</button>
                </div>
              </div>
            ) : null}
          </div>

          {selectedElement?.type === "form" ? (
            <div className="rounded-lg border border-stone-200 bg-white p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold">{text.formFields}</p>
                <button className="rounded-md border border-stone-300 px-2 py-1 text-xs font-semibold" onClick={addField} type="button">{text.addField}</button>
              </div>
              <div className="mt-3 grid gap-3">
                {(selectedElement.fields ?? []).map((field) => (
                  <div className="grid gap-2 rounded-md bg-stone-50 p-3" key={field.id}>
                    <input className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm font-semibold" value={field.label} onChange={(event) => updateField(field.id, { label: event.target.value })} />
                    <select className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm" value={field.type} onChange={(event) => updateField(field.id, { type: event.target.value as FunnelField["type"] })}>{funnelFieldTypes.map((type) => <option key={type.id} value={type.id}>{type.label}</option>)}</select>
                    <input className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm" value={field.crmField} placeholder="CRM Feld" onChange={(event) => updateField(field.id, { crmField: event.target.value })} />
                    <input className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm" value={field.placeholder ?? ""} placeholder={text.placeholder} onChange={(event) => updateField(field.id, { placeholder: event.target.value })} />
                    <textarea className="min-h-20 w-full rounded-md border border-stone-300 px-3 py-2 text-sm" value={(field.options ?? []).join("\n")} placeholder={text.fieldOptions} onChange={(event) => updateField(field.id, { options: event.target.value.split("\n").filter(Boolean) })} />
                    <input className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm" value={field.errorMessage ?? ""} placeholder={text.errorMessage} onChange={(event) => updateField(field.id, { errorMessage: event.target.value })} />
                    <input className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm" value={field.helpText ?? ""} placeholder={text.helpText} onChange={(event) => updateField(field.id, { helpText: event.target.value })} />
                    <label className="flex items-center gap-2 text-sm font-semibold"><input checked={field.required} onChange={(event) => updateField(field.id, { required: event.target.checked })} type="checkbox" /> {text.requiredField}</label>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="rounded-lg border border-stone-200 bg-white p-4">
            <p className="text-sm font-semibold">{text.mediaLibrary}</p>
            <div className="mt-3 grid gap-2">
              <MediaLibraryPicker
                currentUrl={selectedElement?.url}
                folder="Funnel"
                language={language}
                onSelect={applyUploadedMedia}
              />
              <input className="rounded-md border border-stone-300 px-3 py-2 text-sm" placeholder={text.name} value={mediaDraft.name} onChange={(event) => setMediaDraft((current) => ({ ...current, name: event.target.value }))} />
              <input className="rounded-md border border-stone-300 px-3 py-2 text-sm" placeholder="https://..." value={mediaDraft.url} onChange={(event) => setMediaDraft((current) => ({ ...current, url: event.target.value }))} />
              <button className="rounded-md bg-slate-950 px-3 py-2 text-sm font-semibold text-white" onClick={addMediaAsset} type="button">{text.saveMedia}</button>
              {(blueprint.mediaLibrary ?? []).map((asset) => (
                <button className="rounded-md border border-stone-200 bg-stone-50 p-2 text-left text-xs font-semibold" key={asset.id} onClick={() => applyMedia(asset)} type="button">
                  <span className="block break-words">{asset.name}</span>
                  <span className="block break-words text-stone-500">{asset.folder} / {asset.type}</span>
                </button>
              ))}
            </div>
          </div>
        </aside>
      </div>

      <details className="rounded-lg border border-stone-200 bg-white p-4">
        <summary className="cursor-pointer text-sm font-semibold text-slate-900">{text.advanced}</summary>
      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <div className="rounded-lg border border-stone-200 bg-white p-4">
          <p className="text-sm font-semibold">{text.abResults}</p>
          <div className="mt-3 grid gap-2 text-sm">
            {abRows.map((row) => (
              <div className="grid gap-1 rounded-md bg-stone-50 p-3" key={row.id}>
                <div className="flex justify-between gap-3"><span className="font-semibold">{row.name}</span><span>{(row.conversionRate * 100).toFixed(1)}%</span></div>
                <p className="break-words text-xs text-stone-600">{row.visits} {text.visits} / {row.conversions} {text.leads} / {text.lift} {row.liftAgainstControl.toFixed(1)}% / {row.confidenceLabel}{row.isWinner ? ` / ${text.winner}` : ""}</p>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-lg border border-stone-200 bg-white p-4">
          <p className="text-sm font-semibold">{text.trackingInjection}</p>
          <div className="mt-3 grid gap-2">
            {trackingSnippet.warnings.map((warning) => <p className="rounded-md bg-amber-50 p-2 text-xs font-semibold text-amber-900" key={warning}>{warning}</p>)}
            <pre className="max-h-44 overflow-auto rounded-md bg-slate-950 p-3 text-xs text-slate-100">{trackingSnippet.head}</pre>
            <pre className="max-h-44 overflow-auto rounded-md bg-slate-950 p-3 text-xs text-slate-100">{trackingSnippet.body}</pre>
          </div>
        </div>
        <div className="rounded-lg border border-stone-200 bg-white p-4 xl:col-span-2">
          <p className="text-sm font-semibold">{text.versions}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {versions.length ? versions.map((version) => <span className="rounded-md bg-stone-100 px-3 py-2 text-xs font-semibold" key={version.id}>{version.label} / {new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(new Date(version.createdAt))}</span>) : <span className="text-sm text-stone-500">{text.noVersions}</span>}
          </div>
        </div>
      </div>
      </details>
    </div>
  );
}


