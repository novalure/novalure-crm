"use client";

import { useId, useState, useSyncExternalStore } from "react";
import type { PropertyDocumentItem } from "@/lib/crm-types";
import type { PropertyAssetSummary } from "@/lib/property-department";
import type { PropertyDraftStore } from "@/lib/property-draft-store";
import { persistPropertyDocumentReview, propertyDocumentReviewTarget } from "@/lib/property-document-review";
import { csrfFetch } from "@/lib/security/csrf-client";

export function PropertyDocumentReview({ document, property, workspaceId, canReview, draftStore, onChanged, language }: {
  document: PropertyDocumentItem;
  property: PropertyAssetSummary | undefined;
  workspaceId: string;
  canReview: boolean;
  draftStore: PropertyDraftStore;
  onChanged: () => Promise<void>;
  language: string;
}) {
  const busy = useSyncExternalStore(draftStore.subscribe, draftStore.isMutationBusy, () => false);
  const helpId = useId();
  const [reviewing, setReviewing] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [completedVersion, setCompletedVersion] = useState<string | null>(null);
  const target = propertyDocumentReviewTarget(document, property, workspaceId);
  const revoke = document.status === "approved";
  const copy = language === "de" ? {
    approve: "Intern freigeben", revoke: "Freigabe zurücknehmen",
    permission: "Interne Freigabe benötigt CRM-Schreibrechte und eine Administratorrolle.",
    unavailable: "Interne Freigabe ist nur für private, unversandte Dokumente dieses gespeicherten Objekts möglich. Öffentliche, versandte oder archivierte Dokumente benötigen einen separaten Lebenszyklus.",
    confirmApprove: `„${document.title}“ für „${property?.title ?? ""}“ intern freigeben? Es wird nicht veröffentlicht oder versandt; der Dateizugriff bleibt unverändert.`,
    confirmRevoke: `Die interne Freigabe von „${document.title}“ für „${property?.title ?? ""}“ zurücknehmen? Das Dokument bleibt gespeichert und wird wieder zur Prüfung vorgemerkt. Dies ist kein Widerruf öffentlicher Links.`,
    success: revoke ? "Interne Freigabe zurückgenommen. Dokument bleibt gespeichert." : "Dokument intern freigegeben. Nicht veröffentlicht oder versandt.",
    refresh: "Änderung gespeichert, aber die Ansicht konnte nicht aktualisiert werden. Bitte neu laden; nicht erneut speichern.",
    conflict: "Dokument oder Zuordnung wurde geändert, ist nicht mehr verfügbar oder hat öffentliche Zugriffe. Bitte neu laden und prüfen. Es wurde keine interne Freigabe bestätigt.",
    failed: "Interne Freigabe nicht bestätigt. Bitte neu laden und den Status prüfen, bevor du es erneut versuchst.",
  } : {
    approve: "Approve internally", revoke: "Withdraw approval",
    permission: "Internal approval requires CRM write access and an administrator role.",
    unavailable: "Internal approval is only available for private, unsent documents attached to this saved property. Public, sent or archived documents need a separate lifecycle.",
    confirmApprove: `Approve “${document.title}” for “${property?.title ?? ""}” internally? This does not publish or send the file; access remains unchanged.`,
    confirmRevoke: `Withdraw internal approval of “${document.title}” for “${property?.title ?? ""}”? The document stays saved and returns to review. This does not revoke public links.`,
    success: revoke ? "Internal approval withdrawn. Document remains saved." : "Document approved internally. Not published or sent.",
    refresh: "Change saved, but the view could not be refreshed. Please reload; do not save again.",
    conflict: "The document or its attachment changed, is unavailable or has public access. Reload and review. No internal approval was confirmed.",
    failed: "Internal review was not confirmed. Reload and check the status before retrying.",
  };

  async function review() {
    if (!target || !canReview || completedVersion === document.updatedAt) return;
    if (!window.confirm(revoke ? copy.confirmRevoke : copy.confirmApprove)) return;
    const token = draftStore.acquireMutation();
    if (!token) return;
    setReviewing(true);
    setNotice(null);
    try {
      await persistPropertyDocumentReview({ target, action: revoke ? "revoke" : "approve", request: csrfFetch });
      setCompletedVersion(document.updatedAt);
      setNotice({ text: copy.success, error: false });
      try { await onChanged(); } catch { setNotice({ text: copy.refresh, error: false }); }
    } catch (error) {
      setNotice({ text: error instanceof Error && error.message === "document_review_conflict" ? copy.conflict : copy.failed, error: true });
    } finally {
      draftStore.releaseMutation(token);
      setReviewing(false);
    }
  }

  return <div className="mt-3 min-w-0 space-y-2 break-words sm:col-span-2">
    <button type="button" onClick={() => void review()}
      aria-label={`${revoke ? copy.revoke : copy.approve}: ${document.title}`}
      aria-describedby={helpId}
      aria-busy={reviewing}
      disabled={!target || !canReview || busy || completedVersion === document.updatedAt}
      className="min-h-11 rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700 disabled:cursor-not-allowed disabled:opacity-50">
      {revoke ? copy.revoke : copy.approve}
    </button>
    <p id={helpId} className="text-sm text-stone-600">{!canReview ? copy.permission : !target ? copy.unavailable : language === "de" ? "Nur interne Prüfung: keine Veröffentlichung, kein Versand und keine Änderung des Dateizugriffs." : "Internal review only: no publication, sending or change to file access."}</p>
    <p role="status" aria-atomic="true" className="text-sm text-stone-600">{reviewing ? (language === "de" ? `Interne Prüfung für „${document.title}“ wird gespeichert …` : `Saving internal review for “${document.title}” …`) : ""}</p>
    {notice ? <p role={notice.error ? "alert" : "status"} aria-atomic="true" className={notice.error ? "text-sm text-red-800" : "text-sm text-emerald-800"}>{notice.text}</p> : null}
  </div>;
}
