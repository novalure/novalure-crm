"use client";

import { useEffect, useMemo, useState } from "react";
import { calculateAbTestResults } from "@/lib/funnel-ab-testing";
import { createTrackingSnippet } from "@/lib/funnel-tracking";
import { funnelFieldTypes, type FunnelBlueprint, type FunnelElement, type FunnelElementType, type FunnelField, type FunnelMediaAsset, type FunnelVersion } from "@/lib/funnel-schema";

type FunnelBlueprintDesignerProps = {
  initialBlueprint: FunnelBlueprint;
  onEvent?: (event: { label: string; detail: string; status: string }) => void;
};

type SaveState = "idle" | "saving" | "saved" | "error";

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

function addElementToFirstEditableColumn(blueprint: FunnelBlueprint, type: FunnelElementType) {
  const next = cloneBlueprint(blueprint);
  const column = next.pages[0]?.sections.at(-1)?.rows[0]?.columns[0] ?? next.pages[0]?.sections[0]?.rows[0]?.columns[0];
  if (!column) return next;

  const id = `${blueprint.id}_element_${Date.now()}`;
  column.elements.push({
    id,
    type,
    name: type === "headline" ? "Neue Headline" : type === "button" ? "Neuer Button" : "Neues Element",
    content: type === "headline" ? "Neue Headline" : type === "form" ? "Kontaktformular" : "Inhalt bearbeiten",
    ctaLabel: type === "button" ? "Weiter" : undefined,
    fields: type === "form" ? buildDefaultFields(id) : undefined,
    visibility: { desktop: true, tablet: true, mobile: true },
  });
  return next;
}

function duplicateElement(blueprint: FunnelBlueprint, elementId: string) {
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
            column.elements.splice(index + 1, 0, { ...structuredClone(source), id: `${source.id}_copy_${Date.now()}`, name: `${source.name} Kopie` });
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

function buildDefaultFields(sourceId: string): FunnelField[] {
  return [
    { id: `${sourceId}_name`, type: "text", crmField: "name", label: "Name", placeholder: "Vor- und Nachname", required: true },
    { id: `${sourceId}_email`, type: "email", crmField: "email", label: "E-Mail", placeholder: "name@example.com", required: true },
    { id: `${sourceId}_phone`, type: "phone", crmField: "phone", label: "Telefon", placeholder: "+43 ...", required: true },
    { id: `${sourceId}_consent`, type: "consent", crmField: "privacy_consent", label: "DSGVO Zustimmung", required: true },
  ];
}

function insertToken(value: string | undefined, token: string) {
  return `${value ?? ""}${value ? " " : ""}${token}`;
}

export function FunnelBlueprintDesigner({ initialBlueprint, onEvent }: FunnelBlueprintDesignerProps) {
  const [blueprint, setBlueprint] = useState(initialBlueprint);
  const [selectedElementId, setSelectedElementId] = useState(firstElementId(initialBlueprint));
  const [draggedElementId, setDraggedElementId] = useState("");
  const [past, setPast] = useState<FunnelBlueprint[]>([]);
  const [future, setFuture] = useState<FunnelBlueprint[]>([]);
  const [versions, setVersions] = useState<FunnelVersion[]>([]);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [mediaDraft, setMediaDraft] = useState({ name: "", url: "", folder: "Projekt", type: "image" as FunnelMediaAsset["type"] });
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
    commit(updateElement(blueprint, selectedElement.id, patch), "Element bearbeitet");
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
      onEvent?.({ label: "Funnel gespeichert", detail: "Blueprint, Medien und Version wurden persistiert.", status: "CRM" });
    } catch {
      setSaveState("error");
    }
  }

  function addMediaAsset() {
    if (!mediaDraft.name.trim() || !mediaDraft.url.trim()) return;
    const asset: FunnelMediaAsset = {
      id: `${blueprint.id}_media_${Date.now()}`,
      name: mediaDraft.name.trim(),
      type: mediaDraft.type,
      url: mediaDraft.url.trim(),
      folder: mediaDraft.folder.trim() || "Projekt",
      alt: mediaDraft.name.trim(),
      createdAt: new Date().toISOString(),
    };
    commit({ ...blueprint, mediaLibrary: [asset, ...(blueprint.mediaLibrary ?? [])] }, "Medium hinzugefügt");
    setMediaDraft({ name: "", url: "", folder: "Projekt", type: "image" });
  }

  function applyMedia(asset: FunnelMediaAsset) {
    if (!selectedElement) return;
    updateSelectedElement({ type: asset.type === "video" ? "video" : "image", url: asset.url, alt: asset.alt, content: asset.name });
  }

  function updateField(fieldId: string, patch: Partial<FunnelField>) {
    if (!selectedElement) return;
    const fields = (selectedElement.fields ?? []).map((field) => (field.id === fieldId ? { ...field, ...patch } : field));
    commit(updateElementFields(blueprint, selectedElement.id, fields), "Feld bearbeitet");
  }

  function addField() {
    if (!selectedElement) return;
    const fields = [
      ...(selectedElement.fields ?? []),
      {
        id: `${selectedElement.id}_field_${Date.now()}`,
        type: "text" as const,
        crmField: "custom_field",
        label: "Neues Feld",
        placeholder: "",
        required: false,
      },
    ];
    commit(updateElementFields(blueprint, selectedElement.id, fields), "Feld hinzugefügt");
  }

  return (
    <div className="grid min-w-0 gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-stone-200 bg-white p-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold">Blueprint Designer</p>
          <p className="mt-1 break-words text-xs text-stone-600">Canvas, Inspector, Medien, Versionen und Tracking arbeiten auf dem neuen FunnelBlueprint.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold disabled:opacity-50" disabled={!past.length} onClick={undo} type="button">Undo</button>
          <button className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold disabled:opacity-50" disabled={!future.length} onClick={redo} type="button">Redo</button>
          <button className="rounded-md bg-slate-950 px-3 py-2 text-sm font-semibold text-white" onClick={saveBlueprint} type="button">{saveState === "saving" ? "Speichert..." : "Blueprint speichern"}</button>
        </div>
      </div>

      <div className="grid min-w-0 gap-4 2xl:grid-cols-[minmax(0,1fr)_390px]">
        <div className="grid min-w-0 gap-4 rounded-lg border border-stone-200 bg-stone-50 p-4">
          <div className="flex flex-wrap gap-2">
            {elementTypes.map((type) => (
              <button className="rounded-md border border-stone-300 bg-white px-3 py-2 text-xs font-semibold" key={type} onClick={() => commit(addElementToFirstEditableColumn(blueprint, type), "Element hinzugefügt")} type="button">{type}</button>
            ))}
          </div>
          {blueprint.pages[0]?.sections.map((section) => (
            <section className="grid min-w-0 gap-3 rounded-lg border border-stone-200 bg-white p-4" key={section.id}>
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{section.name}</p>
              {section.rows.map((row) => (
                <div className="grid min-w-0 gap-3" key={row.id}>
                  {row.columns.map((column) => (
                    <div className="grid min-w-0 gap-2" key={column.id}>
                      {column.elements.map((element) => (
                        <button
                          className={`grid min-w-0 gap-1 rounded-lg border p-3 text-left text-sm ${selectedElement?.id === element.id ? "border-slate-950 bg-slate-950 text-white" : "border-stone-200 bg-stone-50 text-slate-950"}`}
                          draggable
                          key={element.id}
                          onClick={() => setSelectedElementId(element.id)}
                          onDragEnd={() => setDraggedElementId("")}
                          onDragOver={(event) => event.preventDefault()}
                          onDragStart={() => setDraggedElementId(element.id)}
                          onDrop={() => draggedElementId && commit(moveElementWithinColumn(blueprint, draggedElementId, element.id), "Element verschoben")}
                          type="button"
                        >
                          <span className="text-xs font-semibold uppercase tracking-[0.12em] opacity-70">{element.type}</span>
                          <span className="break-words font-semibold">{element.name}</span>
                          <span className="break-words text-xs opacity-70">{element.content ?? element.ctaLabel ?? element.url ?? "Ohne Inhalt"}</span>
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              ))}
            </section>
          ))}
        </div>

        <aside className="grid min-w-0 gap-4">
          <div className="rounded-lg border border-stone-200 bg-white p-4">
            <p className="text-sm font-semibold">Inspector</p>
            {selectedElement ? (
              <div className="mt-3 grid min-w-0 gap-3">
                <label className="grid gap-1 text-sm font-semibold">Typ<select className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm" value={selectedElement.type} onChange={(event) => updateSelectedElement({ type: event.target.value as FunnelElementType })}>{elementTypes.map((type) => <option key={type}>{type}</option>)}</select></label>
                <label className="grid gap-1 text-sm font-semibold">Name<input className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm" value={selectedElement.name} onChange={(event) => updateSelectedElement({ name: event.target.value })} /></label>
                <div className="grid gap-2">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">Rich Text</p>
                  <div className="flex flex-wrap gap-2">
                    <button className="rounded-md border border-stone-300 px-2 py-1 text-xs font-semibold" onClick={() => updateSelectedElement({ content: insertToken(selectedElement.content, "<strong>Text</strong>") })} type="button">B</button>
                    <button className="rounded-md border border-stone-300 px-2 py-1 text-xs font-semibold italic" onClick={() => updateSelectedElement({ content: insertToken(selectedElement.content, "<em>Text</em>") })} type="button">I</button>
                    <button className="rounded-md border border-stone-300 px-2 py-1 text-xs font-semibold underline" onClick={() => updateSelectedElement({ content: insertToken(selectedElement.content, "<u>Text</u>") })} type="button">U</button>
                    <button className="rounded-md border border-stone-300 px-2 py-1 text-xs font-semibold" onClick={() => updateSelectedElement({ content: insertToken(selectedElement.content, "<a href='#'>Link</a>") })} type="button">Link</button>
                    <button className="rounded-md border border-stone-300 px-2 py-1 text-xs font-semibold text-emerald-700" onClick={() => updateSelectedElement({ content: insertToken(selectedElement.content, "<span style='color:#047857'>Text</span>") })} type="button">Farbe</button>
                  </div>
                  <details className="rounded-md border border-stone-200 bg-white p-3">
                    <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">Emoji-Auswahl aufklappen</summary>
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
                <label className="grid gap-1 text-sm font-semibold">Inhalt<textarea className="min-h-28 w-full rounded-md border border-stone-300 px-3 py-2 text-sm" value={selectedElement.content ?? ""} onChange={(event) => updateSelectedElement({ content: event.target.value })} /></label>
                <label className="grid gap-1 text-sm font-semibold">Button Text<input className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm" value={selectedElement.ctaLabel ?? ""} onChange={(event) => updateSelectedElement({ ctaLabel: event.target.value })} /></label>
                <label className="grid gap-1 text-sm font-semibold">Medien URL<input className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm" value={selectedElement.url ?? ""} onChange={(event) => updateSelectedElement({ url: event.target.value })} /></label>
                <div className="grid grid-cols-2 gap-2">
                  <button className="rounded-md border border-stone-300 px-3 py-2 text-sm font-semibold" onClick={() => commit(duplicateElement(blueprint, selectedElement.id), "Element dupliziert")} type="button">Duplizieren</button>
                  <button className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-900" onClick={() => commit(removeElement(blueprint, selectedElement.id), "Element gelöscht")} type="button">Löschen</button>
                </div>
              </div>
            ) : null}
          </div>

          {selectedElement?.type === "form" ? (
            <div className="rounded-lg border border-stone-200 bg-white p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold">Formularfelder</p>
                <button className="rounded-md border border-stone-300 px-2 py-1 text-xs font-semibold" onClick={addField} type="button">Feld hinzufügen</button>
              </div>
              <div className="mt-3 grid gap-3">
                {(selectedElement.fields ?? []).map((field) => (
                  <div className="grid gap-2 rounded-md bg-stone-50 p-3" key={field.id}>
                    <input className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm font-semibold" value={field.label} onChange={(event) => updateField(field.id, { label: event.target.value })} />
                    <select className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm" value={field.type} onChange={(event) => updateField(field.id, { type: event.target.value as FunnelField["type"] })}>{funnelFieldTypes.map((type) => <option key={type.id} value={type.id}>{type.label}</option>)}</select>
                    <input className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm" value={field.placeholder ?? ""} placeholder="Placeholder" onChange={(event) => updateField(field.id, { placeholder: event.target.value })} />
                    <label className="flex items-center gap-2 text-sm font-semibold"><input checked={field.required} onChange={(event) => updateField(field.id, { required: event.target.checked })} type="checkbox" /> Pflichtfeld</label>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="rounded-lg border border-stone-200 bg-white p-4">
            <p className="text-sm font-semibold">Medienbibliothek</p>
            <div className="mt-3 grid gap-2">
              <input className="rounded-md border border-stone-300 px-3 py-2 text-sm" placeholder="Name" value={mediaDraft.name} onChange={(event) => setMediaDraft((current) => ({ ...current, name: event.target.value }))} />
              <input className="rounded-md border border-stone-300 px-3 py-2 text-sm" placeholder="https://..." value={mediaDraft.url} onChange={(event) => setMediaDraft((current) => ({ ...current, url: event.target.value }))} />
              <button className="rounded-md bg-slate-950 px-3 py-2 text-sm font-semibold text-white" onClick={addMediaAsset} type="button">Medium speichern</button>
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

      <div className="grid gap-4 xl:grid-cols-2">
        <div className="rounded-lg border border-stone-200 bg-white p-4">
          <p className="text-sm font-semibold">A/B-Auswertung</p>
          <div className="mt-3 grid gap-2 text-sm">
            {abRows.map((row) => (
              <div className="grid gap-1 rounded-md bg-stone-50 p-3" key={row.id}>
                <div className="flex justify-between gap-3"><span className="font-semibold">{row.name}</span><span>{(row.conversionRate * 100).toFixed(1)}%</span></div>
                <p className="break-words text-xs text-stone-600">{row.visits} Besuche / {row.conversions} Leads / Lift {row.liftAgainstControl.toFixed(1)}% / {row.confidenceLabel}{row.isWinner ? " / Gewinner" : ""}</p>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-lg border border-stone-200 bg-white p-4">
          <p className="text-sm font-semibold">Tracking-Injection</p>
          <div className="mt-3 grid gap-2">
            {trackingSnippet.warnings.map((warning) => <p className="rounded-md bg-amber-50 p-2 text-xs font-semibold text-amber-900" key={warning}>{warning}</p>)}
            <pre className="max-h-44 overflow-auto rounded-md bg-slate-950 p-3 text-xs text-slate-100">{trackingSnippet.head}</pre>
            <pre className="max-h-44 overflow-auto rounded-md bg-slate-950 p-3 text-xs text-slate-100">{trackingSnippet.body}</pre>
          </div>
        </div>
        <div className="rounded-lg border border-stone-200 bg-white p-4 xl:col-span-2">
          <p className="text-sm font-semibold">Versionen</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {versions.length ? versions.map((version) => <span className="rounded-md bg-stone-100 px-3 py-2 text-xs font-semibold" key={version.id}>{version.label} / {new Date(version.createdAt).toLocaleString("de-AT")}</span>) : <span className="text-sm text-stone-500">Noch keine gespeicherte Version.</span>}
          </div>
        </div>
      </div>
    </div>
  );
}


