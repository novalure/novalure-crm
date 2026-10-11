"use client";

import { useId, useState, useSyncExternalStore } from "react";
import type { PropertyMediaItem, SellerListing } from "@/lib/crm-types";
import type { PropertyDraftStore } from "@/lib/property-draft-store";
import { propertyPresentationLabel } from "@/lib/property-presentation";
import { persistPropertyMediaOrder, propertyMediaOrderChange, propertyMediaOrderTarget, propertyMediaVersion, sortedPropertyMedia, type PropertyMediaAction } from "@/lib/property-media-order";
import { csrfFetch } from "@/lib/security/csrf-client";
import { PropertyFileDelete } from "@/components/property-file-delete";

const buttonClass = "min-h-11 rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700 disabled:cursor-not-allowed disabled:opacity-50";

export function PropertyMediaGallery({ media, property, workspaceId, canEdit, draftStore, onChanged, onNotice, language }: {
  media: PropertyMediaItem[];
  property: SellerListing | undefined;
  workspaceId: string;
  canEdit: boolean;
  draftStore: PropertyDraftStore;
  onChanged: () => Promise<void>;
  onNotice: (message: string, error: boolean) => void;
  language: string;
}) {
  const busy = useSyncExternalStore(draftStore.subscribe, draftStore.isMutationBusy, () => false);
  const helpId = useId();
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [completedVersion, setCompletedVersion] = useState<string | null>(null);
  const target = propertyMediaOrderTarget(property, workspaceId, media);
  const version = propertyMediaVersion(target);
  const copy = language === "de" ? {
    cover: "Coverbild", gallery: "Galeriebild", position: "Position", category: "Kategorie",
    legacyCover: "Beim Upload als Titelbild eingeordnet", preview: "Bildvorschau", empty: "Noch keine Bilder gespeichert.",
    select: "Als Coverbild verwenden", up: "Bild nach oben", down: "Bild nach unten", reload: "Bilder neu laden",
    help: "Änderungen werden sofort gespeichert. Cover und Reihenfolge ändern weder Sichtbarkeit noch Freigabestatus. Es wird nichts veröffentlicht oder versandt.",
    permission: "Zum Ändern von Cover und Reihenfolge sind CRM-Schreibrechte erforderlich.",
    unavailable: "Die vollständige Bildzuordnung kann nicht sicher bestätigt werden. Bitte neu laden und prüfen.",
    saving: "Bildverwaltung wird gespeichert …", success: "Bildverwaltung gespeichert.",
    refreshed: "Bildverwaltung neu geladen.", refreshFailed: "Die Ansicht konnte nicht aktualisiert werden. Bitte die Seite neu laden und prüfen.",
    savedRefreshFailed: "Änderung gespeichert, aber die Ansicht konnte nicht aktualisiert werden. Bitte neu laden; nicht erneut speichern.",
    conflict: "Die Bildverwaltung wurde zwischenzeitlich geändert oder die Zuordnung ist nicht mehr gültig. Bitte neu laden und prüfen. Diese Änderung wurde nicht bestätigt.",
    failed: "Speicherung nicht bestätigt. Bitte neu laden und die Bildverwaltung prüfen, bevor du es erneut versuchst.",
  } : {
    cover: "Cover image", gallery: "Gallery image", position: "Position", category: "Category",
    legacyCover: "Categorized as cover at upload", preview: "Image preview", empty: "No images saved yet.",
    select: "Use as cover image", up: "Move image up", down: "Move image down", reload: "Reload images",
    help: "Changes are saved immediately. Cover and order do not change visibility or approval status. Nothing is published or sent.",
    permission: "Changing cover and order requires CRM write access.",
    unavailable: "The complete image attachment cannot be confirmed safely. Reload and review.",
    saving: "Saving image management …", success: "Image management saved.",
    refreshed: "Image management reloaded.", refreshFailed: "The view could not be refreshed. Reload the page and review.",
    savedRefreshFailed: "Change saved, but the view could not be refreshed. Reload; do not save again.",
    conflict: "Image management changed or its attachment is no longer valid. Reload and review. This change was not confirmed.",
    failed: "Saving was not confirmed. Reload and review image management before retrying.",
  };

  async function change(mediaId: string, action: PropertyMediaAction) {
    if (!target || !canEdit || completedVersion === version || !propertyMediaOrderChange(target, mediaId, action)) return;
    const token = draftStore.acquireMutation();
    if (!token) return;
    setSaving(true);
    setNotice(null);
    try {
      await persistPropertyMediaOrder({ target, mediaId, action, request: csrfFetch });
      setCompletedVersion(version);
      setNotice({ text: copy.success, error: false });
      try { await onChanged(); } catch { setNotice({ text: copy.savedRefreshFailed, error: false }); }
    } catch (error) {
      setCompletedVersion(version);
      setNotice({ text: error instanceof Error && error.message === "media_order_conflict" ? copy.conflict : copy.failed, error: true });
    } finally {
      draftStore.releaseMutation(token);
      setSaving(false);
    }
  }

  async function refresh() {
    const token = draftStore.acquireMutation();
    if (!token) return;
    try {
      await onChanged();
      setCompletedVersion(null);
      setNotice({ text: copy.refreshed, error: false });
    } catch { setNotice({ text: copy.refreshFailed, error: true }); }
    finally { draftStore.releaseMutation(token); }
  }

  return <div className="grid min-w-0 gap-3" data-property-media-manager>
    {media.length ? <>
      <p id={helpId} className="text-sm text-stone-600">{!canEdit ? copy.permission : !target ? copy.unavailable : copy.help}</p>
      <div className="grid gap-2">
        {sortedPropertyMedia(media).map((item, index) => {
          const title = item.title || item.assetName || `${copy.gallery} ${index + 1}`;
          const disabled = !target || !canEdit || busy || completedVersion === version;
          return <div key={item.id} data-property-media-id={item.id} className="grid min-w-0 gap-3 rounded-md border border-stone-200 bg-stone-50 p-3 sm:grid-cols-[88px_minmax(0,1fr)]">
            {item.assetAvailable === false || !(item.mediaAssetId || item.url || item.publicUrl) ? <span className="flex min-h-20 items-center rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-950">{language === "de" ? "Datei fehlt – keine Bildvorschau" : "File missing – no image preview"}</span> : item.mediaType === "image" ? <span className="h-20 rounded-md bg-stone-200 bg-cover bg-center" role="img" aria-label={item.altText || `${copy.preview}: ${title}`}
              style={{ backgroundImage: item.publicUrl || item.url ? `url("${item.publicUrl ?? item.url}")` : undefined }} /> :
              <span className="flex min-h-20 items-center justify-center rounded-md bg-stone-200 p-2 text-center text-xs text-stone-700">{propertyPresentationLabel(item.mediaType, language)}</span>}
            <div className="min-w-0 break-words">
              <strong className="block text-sm text-slate-950">{title}</strong>
              <p className="mt-1 text-sm font-semibold text-slate-800">{item.isCover && item.assetAvailable !== false && (item.mediaAssetId || item.url || item.publicUrl) ? copy.cover : item.mediaType === "image" ? copy.gallery : propertyPresentationLabel(item.mediaType, language)} · {copy.position} {index + 1}</p>
              <p className="mt-1 text-xs text-stone-600">{copy.category}: {item.category === "cover" ? copy.legacyCover : propertyPresentationLabel(item.category, language)}</p>
              <p className="mt-1 text-xs text-stone-600">{propertyPresentationLabel(item.visibility, language)} / {propertyPresentationLabel(item.status, language)}</p>
            </div>
            {item.mediaType === "image" ? <div className="flex flex-wrap gap-2 sm:col-span-2">
              {([ ["cover", copy.select], ["up", copy.up], ["down", copy.down] ] as const).map(([action, label]) => <button
                key={action} type="button" aria-label={`${label}: ${title}`} aria-describedby={helpId} aria-busy={saving}
                disabled={disabled || !target || !propertyMediaOrderChange(target, item.id, action)}
                onClick={() => void change(item.id, action)} className={buttonClass}>{label}</button>)}
            </div> : null}
            <PropertyFileDelete item={item} kind="media" property={property} workspaceId={workspaceId}
              canEdit={canEdit} draftStore={draftStore} onChanged={onChanged} onNotice={onNotice} language={language} />
          </div>;
        })}
      </div>
      <button type="button" disabled={busy} onClick={() => void refresh()} className={`${buttonClass} justify-self-start`}>{copy.reload}</button>
    </> : <p className="rounded-md border border-dashed border-stone-300 bg-stone-50 p-4 text-sm text-stone-600">{copy.empty}</p>}
    <p role="status" aria-atomic="true" className="text-sm text-stone-600">{saving ? copy.saving : ""}</p>
    {notice ? <p role={notice.error ? "alert" : "status"} aria-atomic="true" className={notice.error ? "text-sm text-red-800" : "text-sm text-emerald-800"}>{notice.text}</p> : null}
  </div>;
}
