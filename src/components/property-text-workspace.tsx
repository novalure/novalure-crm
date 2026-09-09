"use client";

import { useEffect, useState } from "react";
import type { PropertyTextBlock } from "@/lib/crm-types";
import { PROPERTY_TEXT_FIELDS } from "@/lib/property-department";
import { PropertyTextEditor, type PropertyEditorValue } from "./property-text-editor";

export function PropertyTextWorkspace({ propertyId, projectId, title, blocks, language, canEdit, onSaved, initialDraft, onDraftChange }: {
  propertyId: string; projectId?: string; title: string; blocks: PropertyTextBlock[];
  language: string; canEdit: boolean; onSaved?: () => Promise<void> | void;
  initialDraft?: Record<string, PropertyEditorValue>;
  onDraftChange: (values: Record<string, PropertyEditorValue> | undefined) => void;
}) {
  const de = language === "de";
  const [values, setValues] = useState<Record<string, PropertyEditorValue>>(() => initialDraft ?? Object.fromEntries(PROPERTY_TEXT_FIELDS.map((field) => {
    const block = blocks.find((item) => item.textKey === field.key);
    return [field.key, { text: block?.content ?? "", document: block?.metadata?.editorDocument as PropertyEditorValue["document"] }];
  })));
  const [dirty, setDirty] = useState(Boolean(initialDraft));
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function save() {
    if (!canEdit || saving || !dirty) return;
    setSaving(true);
    setNotice("");
    try {
      const textBlocks = [...blocks.filter((block) => !PROPERTY_TEXT_FIELDS.some((field) => field.key === block.textKey)), ...PROPERTY_TEXT_FIELDS.map((field) => {
        const existing = blocks.find((item) => item.textKey === field.key);
        return { ...existing, textKey: field.key, title: existing?.title ?? field.label, channel: existing?.channel ?? field.channel,
          content: values[field.key].text, visibility: existing?.visibility ?? (field.key === "internal" ? "internal" : "public"),
          status: values[field.key].text === existing?.content && JSON.stringify(values[field.key].document) === JSON.stringify(existing?.metadata?.editorDocument)
            ? existing?.status : (field.key === "internal" ? "approved" : "draft"),
          metadata: { ...existing?.metadata, editorDocument: values[field.key].document },
        };
      })];
      const response = await fetch("/api/crm/properties", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation: "save_text_blocks", propertyId, projectId, textBlocks }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || (de ? "Speichern fehlgeschlagen" : "Save failed"));
      setDirty(false);
      onDraftChange(undefined);
      setNotice(de ? "Texte gespeichert." : "Texts saved.");
      await onSaved?.();
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  }

  return <article className="grid gap-5 rounded-lg border border-stone-200 bg-white p-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h4 className="text-xl font-semibold">{de ? "Texte & Exposé" : "Texts & exposé"} · {title}</h4><p>{de ? "Texte bearbeiten und anschließend ausdrücklich speichern." : "Edit your texts, then save your changes."}</p></div>
      <button className="min-h-11 rounded-md bg-slate-950 px-4 py-2 font-semibold text-white disabled:opacity-50" type="button" disabled={!canEdit || !dirty || saving} onClick={() => void save()}>{saving ? (de ? "Speichert …" : "Saving …") : (de ? "Texte speichern" : "Save texts")}</button>
    </div>
    <p role="status">{notice || (dirty ? (de ? "Ungespeicherte Änderungen" : "Unsaved changes") : (de ? "Keine ungespeicherten Änderungen" : "No unsaved changes"))}</p>
    {PROPERTY_TEXT_FIELDS.map((field) => <PropertyTextEditor key={field.key} label={de ? field.label : ({ expose: "Exposé", website: "Website", portal: "Portals", internal: "Internal", newsletter: "Newsletter" }[field.key])} language={language} disabled={!canEdit || saving} value={values[field.key]} onChange={(value) => { const next = { ...values, [field.key]: value }; setValues(next); onDraftChange(next); setDirty(true); }} />)}
    <button className="min-h-11 rounded-md bg-slate-950 px-4 py-2 font-semibold text-white disabled:opacity-50" type="button" disabled={!canEdit || !dirty || saving} onClick={() => void save()}>{de ? "Texte speichern" : "Save texts"}</button>
  </article>;
}
