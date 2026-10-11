"use client";

import { useId, useState, useSyncExternalStore } from "react";
import type { PropertyDocumentItem, PropertyMediaItem, SellerListing } from "@/lib/crm-types";
import type { PropertyDraftStore } from "@/lib/property-draft-store";
import { persistPropertyFileDelete, propertyFileDeleteTarget } from "@/lib/property-file-delete";
import { csrfFetch } from "@/lib/security/csrf-client";

export function PropertyFileDelete({ item, kind, property, workspaceId, canEdit, draftStore, onChanged, onNotice, language }: {
  item: PropertyMediaItem | PropertyDocumentItem;
  kind: "media" | "document";
  property: SellerListing | undefined;
  workspaceId: string;
  canEdit: boolean;
  draftStore: PropertyDraftStore;
  onChanged: () => Promise<void>;
  onNotice: (message: string, error: boolean) => void;
  language: string;
}) {
  const helpId = useId();
  const busy = useSyncExternalStore(draftStore.subscribe, draftStore.isMutationBusy, () => false);
  const [deleting, setDeleting] = useState(false);
  const [attemptedVersion, setAttemptedVersion] = useState<string | null>(null);
  const target = propertyFileDeleteTarget(item, kind, property, workspaceId);
  const title = item.title || item.assetName || (language === "de" ? "Datei" : "File");
  const objectTitle = property?.title ?? "";
  const version = target ? JSON.stringify(target) : null;
  const copy = language === "de" ? {
    action: kind === "media" ? "Bilddatei endgültig löschen" : "Dokumentdatei endgültig löschen",
    progress: "Datei wird gelöscht …",
    help: "Endgültige Löschung der Datei und dieser Zuordnung. Andere Verwendungen oder Versand-/Freigabelinks verhindern die Löschung. Es wird nichts veröffentlicht.",
    unavailable: "Nur private, gespeicherte, unversandte Dateien können hier gelöscht werden. Bestehende Verwendungen werden vor der Löschung geprüft.",
    permission: "Dateilöschung benötigt CRM-Schreibrechte.",
    confirm: `„${title}“ aus „${objectTitle}“ endgültig löschen?\n\nDie Datei und ihre Immobilienzuordnung werden entfernt. Dies kann nicht rückgängig gemacht werden. Andere Verwendungen verhindern die Löschung. Ein gelöschtes Cover wird nicht automatisch ersetzt.`,
    success: `„${title}“ aus „${objectTitle}“ endgültig gelöscht.`,
    refresh: `„${title}“ wurde gelöscht, aber die Ansicht konnte nicht aktualisiert werden. Bitte die Seite neu laden; nicht erneut löschen.`,
    conflict: `„${title}“ wurde nicht gelöscht: Die Zuordnung wurde geändert, die Datei wird noch verwendet oder ist nicht zur Löschung freigegeben. Bitte neu laden und prüfen.`,
    denied: `„${title}“ wurde nicht gelöscht: Die erforderlichen Rechte fehlen.`,
    failed: `Löschung von „${title}“ nicht vollständig bestätigt. Die Datei kann bereits fehlen. Bitte neu laden und prüfen; nicht erneut löschen.`,
  } : {
    action: kind === "media" ? "Permanently delete image file" : "Permanently delete document file",
    progress: "Deleting file …",
    help: "Permanently deletes the file and this attachment. Other uses or send/share links prevent deletion. Nothing is published.",
    unavailable: "Only private, saved, unsent files can be deleted here. Existing uses are checked before deletion.",
    permission: "File deletion requires CRM write access.",
    confirm: `Permanently delete “${title}” from “${objectTitle}”?\n\nThe file and its property attachment will be removed. This cannot be undone. Other uses prevent deletion. A deleted cover is not automatically replaced.`,
    success: `“${title}” permanently deleted from “${objectTitle}”.`,
    refresh: `“${title}” was deleted, but the view could not be refreshed. Reload the page; do not delete again.`,
    conflict: `“${title}” was not deleted: its attachment changed, it is still in use or it is not eligible for deletion. Reload and review.`,
    denied: `“${title}” was not deleted: required permission is missing.`,
    failed: `Deletion of “${title}” was not fully confirmed. The file may already be missing. Reload and review; do not delete again.`,
  };
  async function remove() {
    if (!target || !canEdit || attemptedVersion === version || busy || !window.confirm(copy.confirm)) return;
    const mutation = draftStore.acquireMutation();
    if (!mutation) return;
    setDeleting(true);
    // One request only: even a lost acknowledgement must not cause an automatic retry.
    setAttemptedVersion(version);
    try {
      await persistPropertyFileDelete({ target, request: csrfFetch });
      onNotice(copy.success, false);
      try { await onChanged(); } catch { onNotice(copy.refresh, true); }
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      onNotice(code === "property_file_delete_conflict" ? copy.conflict : code === "property_file_delete_denied" ? copy.denied : copy.failed, true);
    } finally {
      draftStore.releaseMutation(mutation);
      setDeleting(false);
    }
  }
  return <div className="grid min-w-0 gap-2 sm:col-span-2" data-property-file-delete={item.id}>
    <button type="button" onClick={() => void remove()} aria-label={`${copy.action}: ${title}`} aria-describedby={helpId}
      aria-busy={deleting} disabled={!canEdit || !target || busy || attemptedVersion === version}
      className="min-h-11 justify-self-start rounded-md border border-red-300 bg-white px-3 py-2 text-left text-sm font-semibold text-red-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-800 disabled:cursor-not-allowed disabled:opacity-50">
      {deleting ? copy.progress : copy.action}
    </button>
    <p id={helpId} className="text-xs text-stone-600">{!canEdit ? copy.permission : !target ? copy.unavailable : copy.help}</p>
  </div>;
}
