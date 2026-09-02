"use client";

import { useMemo, useRef, useState } from "react";

import type { CrmEntityKind } from "@/lib/list-query-state";
import type { BulkActionKind } from "@/lib/list-productivity";
import { csrfFetch } from "@/lib/security/csrf-client";

export type ListProductivityToolbarProps = Readonly<{
  canManage: boolean;
  currentColumnState?: readonly string[];
  currentQueryState: Readonly<Record<string, unknown>>;
  entityType: CrmEntityKind;
  language?: "de" | "en";
  onCompleted?: () => void | Promise<void>;
  projectId?: string | null;
  selectedIds: readonly string[];
  workspaceId?: string | null;
}>;

const supportedActions: Readonly<Partial<Record<CrmEntityKind, readonly BulkActionKind[]>>> = {
  contact: ["assign_owner", "add_tags", "create_follow_up", "archive"],
  deal: ["assign_owner", "add_tags", "create_follow_up"],
  lead: ["assign_owner", "add_tags", "create_follow_up"],
  organization: ["assign_owner", "add_tags"],
  property: ["assign_owner", "add_tags", "pause_portal"],
  task: ["assign_owner", "add_tags"],
};

function endpoint(path: string, workspaceId?: string | null) {
  if (!workspaceId) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}workspaceId=${encodeURIComponent(workspaceId)}`;
}

export function ListProductivityToolbar({
  canManage,
  currentColumnState = [],
  currentQueryState,
  entityType,
  language = "de",
  onCompleted,
  projectId = null,
  selectedIds,
  workspaceId,
}: ListProductivityToolbarProps) {
  const de = language === "de";
  const actions = useMemo(() => supportedActions[entityType] ?? [], [entityType]);
  const [action, setAction] = useState<BulkActionKind | "">("");
  const [ownerUserId, setOwnerUserId] = useState("");
  const [tags, setTags] = useState("");
  const [followUpTitle, setFollowUpTitle] = useState("");
  const [followUpDueAt, setFollowUpDueAt] = useState("");
  const [viewName, setViewName] = useState("");
  const [confirmationCount, setConfirmationCount] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const pendingBulkRequest = useRef<{ key: string; signature: string } | null>(null);
  const destructive = action === "archive" || action === "pause_portal";
  const confirmationMatches = !destructive || Number(confirmationCount) === selectedIds.length;

  const labels: Record<BulkActionKind, string> = {
    add_tags: de ? "Tags ergänzen" : "Add tags",
    archive: de ? "Archivieren" : "Archive",
    assign_owner: de ? "Verantwortung ändern" : "Change owner",
    create_follow_up: de ? "Folgeaufgabe erstellen" : "Create follow-up",
    pause_portal: de ? "Portalkanäle pausieren" : "Pause portal channels",
  };

  async function saveView() {
    if (!viewName.trim()) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await csrfFetch(endpoint("/api/crm/productivity/saved-views", workspaceId), {
        body: JSON.stringify({
          columnState: currentColumnState,
          entityType,
          isShared: false,
          name: viewName,
          projectId,
          queryState: currentQueryState,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || (de ? "Ansicht konnte nicht gespeichert werden." : "View could not be saved."));
      setViewName("");
      setMessage(de ? "Ansicht serverseitig gespeichert." : "View saved on the server.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : (de ? "Ansicht konnte nicht gespeichert werden." : "View could not be saved."));
    } finally {
      setBusy(false);
    }
  }

  async function runBulkAction() {
    if (!action || !selectedIds.length || !confirmationMatches) return;
    const payload: Record<string, unknown> = {};
    if (action === "assign_owner") payload.ownerUserId = ownerUserId.trim();
    if (action === "add_tags") payload.tags = tags.split(",").map((tag) => tag.trim()).filter(Boolean);
    if (action === "create_follow_up") {
      payload.dueAt = followUpDueAt;
      payload.priority = "Normal";
      payload.title = followUpTitle.trim();
    }
    if (destructive) payload.confirmedCount = Number(confirmationCount);
    const requestBody = { action, entityIds: [...selectedIds], entityType, payload, projectId };
    const requestSignature = JSON.stringify({
      ...requestBody,
      entityIds: [...selectedIds].sort(),
      payload: action === "add_tags"
        ? { ...payload, tags: [...(payload.tags as string[])].sort() }
        : payload,
    });
    if (!pendingBulkRequest.current || pendingBulkRequest.current.signature !== requestSignature) {
      pendingBulkRequest.current = {
        key: `bulk:${action}:${crypto.randomUUID()}`,
        signature: requestSignature,
      };
    }
    const idempotencyKey = pendingBulkRequest.current.key;

    setBusy(true);
    setMessage("");
    try {
      const response = await csrfFetch(endpoint("/api/crm/productivity/bulk-actions", workspaceId), {
        body: JSON.stringify(requestBody),
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        method: "POST",
      });
      const result = await response.json() as {
        batch?: { blockedCount?: number; succeededCount?: number };
        error?: string;
      };
      if (!response.ok) {
        if (response.status < 500) pendingBulkRequest.current = null;
        throw new Error(result.error || (de ? "Mehrfachaktion fehlgeschlagen." : "Bulk action failed."));
      }
      pendingBulkRequest.current = null;
      const succeeded = result.batch?.succeededCount ?? 0;
      const blocked = result.batch?.blockedCount ?? 0;
      setMessage(
        de
          ? `${succeeded} Datensätze geändert${blocked ? `, ${blocked} blockiert` : ""}.`
          : `${succeeded} records changed${blocked ? `, ${blocked} blocked` : ""}.`,
      );
      setConfirmationCount("");
      await onCompleted?.();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : (de ? "Mehrfachaktion fehlgeschlagen." : "Bulk action failed."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label={de ? "Listenwerkzeuge" : "List tools"} className="grid gap-3 rounded-lg border border-stone-200 bg-white p-4">
      <div className="grid gap-2 md:grid-cols-[minmax(12rem,1fr)_auto]">
        <label className="grid gap-1 text-sm font-semibold text-slate-900">
          {de ? "Aktuelle Ansicht speichern" : "Save current view"}
          <input
            className="min-h-11 rounded-md border border-stone-300 px-3 py-2 font-normal"
            maxLength={100}
            onChange={(event) => setViewName(event.target.value)}
            placeholder={de ? "z. B. Aktive Käufer in Wien" : "e.g. Active buyers in Vienna"}
            value={viewName}
          />
        </label>
        <button
          className="min-h-11 self-end rounded-md border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={busy || !viewName.trim()}
          onClick={() => void saveView()}
          type="button"
        >
          {de ? "Ansicht speichern" : "Save view"}
        </button>
      </div>

      {actions.length ? (
        <div className="grid gap-2 border-t border-stone-200 pt-3">
          <p className="text-sm font-semibold text-slate-950">
            {de ? `${selectedIds.length} ausgewählt` : `${selectedIds.length} selected`}
          </p>
          <div className="grid gap-2 md:grid-cols-2">
            <label className="grid gap-1 text-sm font-semibold text-slate-900">
              {de ? "Mehrfachaktion" : "Bulk action"}
              <select
                className="min-h-11 rounded-md border border-stone-300 bg-white px-3 py-2 font-normal"
                disabled={!canManage || busy}
                onChange={(event) => {
                  setAction(event.target.value as BulkActionKind | "");
                  setConfirmationCount("");
                }}
                value={action}
              >
                <option value="">{de ? "Aktion wählen" : "Choose action"}</option>
                {actions.map((item) => <option key={item} value={item}>{labels[item]}</option>)}
              </select>
            </label>
            {action === "assign_owner" ? (
              <label className="grid gap-1 text-sm font-semibold text-slate-900">
                {de ? "Benutzer-ID des Verantwortlichen" : "Owner user ID"}
                <input className="min-h-11 rounded-md border border-stone-300 px-3 py-2 font-normal" onChange={(event) => setOwnerUserId(event.target.value)} value={ownerUserId} />
              </label>
            ) : null}
            {action === "add_tags" ? (
              <label className="grid gap-1 text-sm font-semibold text-slate-900">
                {de ? "Tags, kommagetrennt" : "Comma-separated tags"}
                <input className="min-h-11 rounded-md border border-stone-300 px-3 py-2 font-normal" onChange={(event) => setTags(event.target.value)} value={tags} />
              </label>
            ) : null}
            {action === "create_follow_up" ? (
              <>
                <label className="grid gap-1 text-sm font-semibold text-slate-900">
                  {de ? "Titel der Folgeaufgabe" : "Follow-up title"}
                  <input className="min-h-11 rounded-md border border-stone-300 px-3 py-2 font-normal" maxLength={160} onChange={(event) => setFollowUpTitle(event.target.value)} value={followUpTitle} />
                </label>
                <label className="grid gap-1 text-sm font-semibold text-slate-900">
                  {de ? "Fällig" : "Due"}
                  <input className="min-h-11 rounded-md border border-stone-300 px-3 py-2 font-normal" onChange={(event) => setFollowUpDueAt(event.target.value)} type="datetime-local" value={followUpDueAt} />
                </label>
              </>
            ) : null}
            {destructive ? (
              <label className="grid gap-1 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm font-semibold text-amber-950">
                {de ? `Zur Bestätigung exakt ${selectedIds.length} eingeben` : `Enter exactly ${selectedIds.length} to confirm`}
                <input className="min-h-11 rounded-md border border-amber-300 bg-white px-3 py-2 font-normal" inputMode="numeric" onChange={(event) => setConfirmationCount(event.target.value)} value={confirmationCount} />
              </label>
            ) : null}
          </div>
          <button
            className="min-h-11 justify-self-start rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!canManage || busy || !action || !selectedIds.length || !confirmationMatches}
            onClick={() => void runBulkAction()}
            type="button"
          >
            {busy ? (de ? "Wird verarbeitet …" : "Processing …") : (de ? "Auf Auswahl anwenden" : "Apply to selection")}
          </button>
        </div>
      ) : null}
      <p aria-live="polite" className="min-h-5 text-sm font-semibold text-stone-700" role="status">{message}</p>
    </section>
  );
}
