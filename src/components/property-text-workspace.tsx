"use client";

import { useEffect, useRef, useState } from "react";
import type { PropertyTextBlock, SellerListing } from "@/lib/crm-types";
import { PROPERTY_TEXT_FIELDS } from "@/lib/property-department";
import { createPropertyCoreDraft } from "@/lib/property-core-editing";
import type { PropertyDraft, PropertyDraftStore } from "@/lib/property-draft-store";
import { propertyWorkspaceEndpoint } from "@/lib/property-interactions";
import { csrfFetch } from "@/lib/security/csrf-client";
import { usePropertyDraft } from "@/lib/use-property-draft";
import { PropertyTextEditor, type PropertyEditorValue } from "./property-text-editor";

type PropertyTextWorkspaceProps = {
  listing: SellerListing; workspaceId: string; blocks: PropertyTextBlock[];
  language: string; canEdit: boolean; draftStore: PropertyDraftStore;
  draftUserId: string; onSaved?: () => Promise<void> | void;
};

export function PropertyTextWorkspace(props: PropertyTextWorkspaceProps) {
  if (props.listing.workspaceId !== props.workspaceId) {
    return <p role="alert">{props.language === "de" ? "Kein gespeichertes Objekt in diesem Workspace ausgewählt." : "No saved property selected in this workspace."}</p>;
  }
  // Replacement saves allocate new block IDs. A confirmed refresh must load
  // those saved values, while the shared scoped store retains any newer draft.
  const revision = JSON.stringify(props.blocks.map((block) => [block.id, block.updatedAt]));
  return <PropertyTextWorkspaceForm key={`${props.workspaceId}:${props.listing.id}:${revision}`} {...props} />;
}

function PropertyTextWorkspaceForm({ listing, workspaceId, blocks, language, canEdit, draftStore, draftUserId, onSaved }: PropertyTextWorkspaceProps) {
  const de = language === "de";
  const [initialDraft, setInitialDraft] = useState<PropertyDraft>(() => ({
    ...createPropertyCoreDraft(listing),
    textBlocks: Object.fromEntries(PROPERTY_TEXT_FIELDS.map((field) => [field.key, blocks.find((item) => item.textKey === field.key)?.content ?? ""])),
    textDocuments: Object.fromEntries(PROPERTY_TEXT_FIELDS.map((field) => [field.key, blocks.find((item) => item.textKey === field.key)?.metadata?.editorDocument as PropertyEditorValue["document"]])),
  }));
  const scopeKey = JSON.stringify(["property-text", draftUserId, workspaceId, listing.id]);
  const { draft, setDraft, clearSubmittedDraft, resetDraft, isDraftDirty, isMutationBusy, acquireMutation, releaseMutation } = usePropertyDraft(draftStore, scopeKey, initialDraft);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!draftStore.hasDrafts() && !draftStore.isMutationBusy()) return;
      event.preventDefault(); event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [draftStore]);

  async function save() {
    if (!canEdit || isMutationBusy || !isDraftDirty) return;
    const mutation = acquireMutation();
    if (!mutation) return;
    const submittedDraft = draft;
    setSaving(true);
    setNotice(null);
    try {
      const textBlocks = [...blocks.filter((block) => !PROPERTY_TEXT_FIELDS.some((field) => field.key === block.textKey)), ...PROPERTY_TEXT_FIELDS.map((field) => {
        const existing = blocks.find((item) => item.textKey === field.key);
        const text = submittedDraft.textBlocks[field.key] ?? "";
        const document = submittedDraft.textDocuments?.[field.key];
        return { ...existing, textKey: field.key, title: existing?.title || field.label, channel: existing?.channel ?? field.channel,
          content: text, visibility: existing?.visibility ?? (field.key === "internal" ? "internal" : "public"),
          status: text === existing?.content && JSON.stringify(document) === JSON.stringify(existing?.metadata?.editorDocument)
            ? existing?.status : (field.key === "internal" ? "approved" : "draft"),
          metadata: { ...existing?.metadata, editorDocument: document },
        };
      })];
      const response = await csrfFetch(propertyWorkspaceEndpoint("/api/crm/properties", workspaceId), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation: "save_text_blocks", propertyId: listing.id, projectId: listing.projectId, textBlocks }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.persisted !== true || !Number.isSafeInteger(payload?.data?.count) || payload.data.count < PROPERTY_TEXT_FIELDS.length) {
        throw new Error("property_text_save_unconfirmed");
      }
      clearSubmittedDraft(submittedDraft);
      if (mounted.current) {
        setInitialDraft(submittedDraft);
        setNotice({ error: false, text: de ? "Texte gespeichert." : "Texts saved." });
      }
      try {
        if (!onSaved) throw new Error("refresh_unavailable");
        await onSaved();
      } catch {
        if (mounted.current) setNotice({ error: true, text: de ? "Texte sind gespeichert. Die Ansicht konnte nicht neu geladen werden. Bitte aktualisieren – nicht erneut speichern." : "Texts are saved, but the view could not refresh. Reload instead of saving again." });
      }
    } catch {
      if (mounted.current) setNotice({ error: true, text: de ? "Speicherung nicht bestätigt. Dein Textentwurf bleibt erhalten. Bei Verbindungsabbruch zuerst den gespeicherten Stand prüfen, bevor du erneut speicherst." : "Saving was not confirmed. Your text draft is retained. After a connection failure, check the saved record before retrying." });
    } finally {
      releaseMutation(mutation);
      if (mounted.current) setSaving(false);
    }
  }

  function discard() {
    if (isMutationBusy || !isDraftDirty || !window.confirm(de ? "Ungespeicherte Textänderungen an diesem Objekt wirklich verwerfen?" : "Discard unsaved text changes to this property?")) return;
    resetDraft(); setNotice(null);
  }

  return <article className="grid min-w-0 gap-5 rounded-lg border border-stone-200 bg-white p-5" aria-busy={isMutationBusy}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0"><h4 className="break-words text-xl font-semibold">{de ? "Texte & Exposé" : "Texts & exposé"} · {listing.title}</h4><p>{de ? "Texte bearbeiten und anschließend ausdrücklich speichern. Ungespeicherte Eingaben bleiben beim Sektionswechsel im Arbeitsspeicher erhalten, nicht nach Neuladen oder Abmelden." : "Edit your texts, then save explicitly. Unsaved inputs remain in memory across section changes, not reload or sign-out."}</p></div>
      <button className="min-h-11 rounded-md bg-slate-950 px-4 py-2 font-semibold text-white disabled:opacity-50" type="button" disabled={!canEdit || !isDraftDirty || isMutationBusy} onClick={() => void save()}>{saving ? (de ? "Speichert …" : "Saving …") : (de ? "Texte speichern" : "Save texts")}</button>
    </div>
    {!canEdit ? <p role="status">{de ? "Für Änderungen fehlen die Immobilien-Schreibrechte." : "Property write permission is required."}</p> : null}
    <p role={notice?.error ? "alert" : "status"} aria-atomic="true">{notice?.text || (isDraftDirty ? (de ? "Ungespeicherte Änderungen" : "Unsaved changes") : (de ? "Keine ungespeicherten Änderungen" : "No unsaved changes"))}</p>
    {PROPERTY_TEXT_FIELDS.map((field) => <PropertyTextEditor key={field.key} label={de ? field.label : ({ expose: "Exposé", website: "Website", portal: "Portals", internal: "Internal", newsletter: "Newsletter" }[field.key])} language={language} disabled={!canEdit || isMutationBusy}
      value={{ text: draft.textBlocks[field.key] ?? "", document: draft.textDocuments?.[field.key] }}
      onChange={(value) => setDraft((current) => ({ ...current, textBlocks: { ...current.textBlocks, [field.key]: value.text }, textDocuments: { ...current.textDocuments, [field.key]: value.document } }))} />)}
    <div className="flex flex-wrap gap-3">
      <button className="min-h-11 rounded-md bg-slate-950 px-4 py-2 font-semibold text-white disabled:opacity-50" type="button" disabled={!canEdit || !isDraftDirty || isMutationBusy} onClick={() => void save()}>{de ? "Texte speichern" : "Save texts"}</button>
      <button className="min-h-11 rounded-md border border-stone-300 px-4 py-2 font-semibold disabled:opacity-50" type="button" disabled={!isDraftDirty || isMutationBusy} onClick={discard}>{de ? "Textentwurf verwerfen" : "Discard text draft"}</button>
    </div>
  </article>;
}
