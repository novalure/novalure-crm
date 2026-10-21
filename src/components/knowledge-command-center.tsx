"use client";

import {
  Children,
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import type { KnowledgeItem, Project } from "@/lib/crm-types";
import type { LanguageCode } from "@/lib/i18n";
import { getKnowledgeCenterCopy, getKnowledgeErrorMessage } from "@/lib/knowledge-center/copy";
import { getKnowledgeLifecycleCopy, knowledgeMonitoringError } from "@/lib/knowledge-center/lifecycle-copy";
import { KnowledgeLifecyclePanel } from "@/components/knowledge-lifecycle-panel";
import { KnowledgeMonitoringPanel } from "@/components/knowledge-monitoring-panel";
import { KnowledgeMaintenancePanel } from "@/components/knowledge-maintenance-panel";
import {
  addKnowledgeTemplateFields,
  createStructuredKnowledgeRows,
  knowledgeField,
  knowledgeFieldLabel,
  knowledgeLabel,
  knowledgeTemplates,
  serializeStructuredKnowledge,
  structuredKnowledgeSummary,
  type StructuredKnowledgeRow,
} from "@/lib/knowledge-center/templates";
import type {
  KnowledgeArea,
  KnowledgeAreaKind,
  KnowledgeCenterSnapshot,
  KnowledgeChannel,
  KnowledgeSource,
  KnowledgeSourceType,
  KnowledgeVersion,
} from "@/lib/knowledge-center/types";
import { csrfFetch } from "@/lib/security/csrf-client";
import { uploadKnowledgeDocument } from "@/lib/knowledge-center/document-upload-client";

const inputClass =
  "evelyn-domain-input min-h-11 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-slate-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:bg-stone-100";
const buttonClass =
  "evelyn-domain-button min-h-11 rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 transition hover:bg-stone-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:cursor-not-allowed disabled:opacity-50";
const primaryClass = `${buttonClass} evelyn-domain-button-primary border-emerald-800 bg-emerald-800 text-white hover:bg-emerald-900`;
const sourceTypes: KnowledgeSourceType[] = [
  "manual",
  "faq",
  "structured",
  "url",
  "file",
];
const channels: KnowledgeChannel[] = [
  "webchat",
  "whatsapp",
  "instagram",
  "messenger",
  "email",
  "internal",
  "voice",
];
type Tab = "sources" | "areas" | "assistants" | "maintenance" | "usage";
type WebsiteImportResponse = {
  source: KnowledgeSource;
  websiteImport: { status: "ready" | "scan_failed" | "busy" | "changes_pending" | "stale"; errorCode?: string };
};
type SourceEditor = {
  sourceId: string;
  revision: number;
  areaId: string;
  name: string;
  type: KnowledgeSourceType;
  content: string;
  question: string;
  answer: string;
  structuredBase: Record<string, unknown>;
  structuredRows: StructuredKnowledgeRow[];
  structuredRemovedKeys: string[];
  structuredTemplate: string;
  url: string;
  mediaAssetId: string;
  documentName: string;
};
const emptyEditor: SourceEditor = {
  sourceId: "",
  revision: 0,
  areaId: "",
  name: "",
  type: "manual",
  content: "",
  question: "",
  answer: "",
  structuredBase: {},
  structuredRows: addKnowledgeTemplateFields([], {}, "company"),
  structuredRemovedKeys: [],
  structuredTemplate: "company",
  url: "",
  mediaAssetId: "",
  documentName: "",
};

async function readResponse<T>(
  response: Response,
  fallback: string,
): Promise<T> {
  const payload = (await response.json().catch(() => null)) as
    | (T & { code?: string })
    | null;
  if (!response.ok || !payload) throw new Error(payload?.code || fallback);
  return payload;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  const generatedId = useId();
  const childList = Children.toArray(children);
  const controlIndex = childList.findIndex(
    (child) =>
      isValidElement(child) &&
      typeof child.type === "string" &&
      ["input", "select", "textarea"].includes(child.type),
  );
  const control = childList[controlIndex];
  const controlId = isValidElement<{ id?: string }>(control)
    ? control.props.id || generatedId
    : generatedId;
  const fields = childList.map((child, index) =>
    index === controlIndex && isValidElement<{ id?: string }>(child)
      ? cloneElement(child, { id: controlId })
      : child,
  );
  return (
    <div className="evelyn-domain-field grid min-w-0 gap-1.5 text-sm font-medium text-slate-800">
      <label htmlFor={controlId || generatedId}>{label}</label>
      {fields}
    </div>
  );
}

function EmptyState({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="evelyn-domain-empty rounded-xl border border-dashed border-stone-300 bg-stone-50 px-5 py-10 text-center">
      <p className="font-semibold text-slate-900">{title}</p>
      {description ? (
        <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-stone-600">
          {description}
        </p>
      ) : null}
    </div>
  );
}

function KnowledgeIcon({
  type,
}: {
  type: "file" | "url" | "manual" | "webchat" | "voice";
}) {
  const path = {
    file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm0 0v6h6M8 15h8m-8 4h5",
    url: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z",
    manual: "M4 5h16M4 10h16M4 15h10M4 20h10",
    webchat: "M21 11a8 8 0 0 1-8 8H6l-4 3V11a8 8 0 0 1 8-8h3a8 8 0 0 1 8 8ZM7 10h9M7 14h6",
    voice: "M22 17v3a2 2 0 0 1-2 2C10 21 3 14 2 4a2 2 0 0 1 2-2h3l2 5-2 2a16 16 0 0 0 8 8l2-2 5 2Z",
  }[type];
  return (
    <svg
      aria-hidden="true"
      className="h-6 w-6 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
      viewBox="0 0 24 24"
    >
      <path d={path} />
    </svg>
  );
}

function formatBytes(value: number, language: LanguageCode) {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  const unit =
    safe >= 1024 ** 3
      ? "GB"
      : safe >= 1024 ** 2
        ? "MB"
        : safe >= 1024
          ? "KB"
          : "B";
  const divisor =
    unit === "GB"
      ? 1024 ** 3
      : unit === "MB"
        ? 1024 ** 2
        : unit === "KB"
          ? 1024
          : 1;
  return `${new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(safe / divisor)} ${unit}`;
}

type KnowledgeCommandCenterProps = {
  items?: KnowledgeItem[];
  language: LanguageCode;
  projectLabel?: string;
  projects?: Project[];
  workspaceId?: string;
  workspaceName?: string;
};

export function KnowledgeCommandCenter(props: KnowledgeCommandCenterProps) {
  return (
    <KnowledgeCenterContent key={props.workspaceId ?? "session"} {...props} />
  );
}

function KnowledgeCenterContent({
  language,
  workspaceId,
  workspaceName,
}: KnowledgeCommandCenterProps) {
  const text = getKnowledgeCenterCopy(language);
  const lifecycleText = getKnowledgeLifecycleCopy(language);
  const formId = useId();
  const [snapshot, setSnapshot] = useState<KnowledgeCenterSnapshot | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [tab, setTab] = useState<Tab>("sources");
  const [projectId, setProjectId] = useState("");
  const [areaFilter, setAreaFilter] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("active");
  const [editor, setEditor] = useState<SourceEditor | null>(null);
  const [showAreaForm, setShowAreaForm] = useState(false);
  const [editingAreaId, setEditingAreaId] = useState("");
  const [areaName, setAreaName] = useState("");
  const [areaKind, setAreaKind] = useState<KnowledgeAreaKind>("company");
  const [areaProjectId, setAreaProjectId] = useState("");
  const [areaDescription, setAreaDescription] = useState("");
  const [botId, setBotId] = useState("");
  const [channel, setChannel] = useState<KnowledgeChannel>("webchat");
  const [assignmentDraft, setAssignmentDraft] = useState<string[] | null>(null);
  const [reviewSourceId, setReviewSourceId] = useState("");
  const [historySourceId, setHistorySourceId] = useState("");
  const [monitoringSourceId, setMonitoringSourceId] = useState("");

  const scopedPath = useCallback(
    (path: string) => {
      if (!workspaceId) return path;
      const [pathname, query = ""] = path.split("?");
      const params = new URLSearchParams(query);
      params.set("workspaceId", workspaceId);
      return `${pathname}?${params.toString()}`;
    },
    [workspaceId],
  );

  const loadSnapshot = useCallback(
    async (signal?: AbortSignal) => {
      const response = await csrfFetch(scopedPath("/api/knowledge-center"), {
        cache: "no-store",
        signal,
      });
      const payload = await readResponse<{ snapshot: KnowledgeCenterSnapshot }>(
        response,
        text.loadError,
      );
      if (
        !payload.snapshot ||
        !Array.isArray(payload.snapshot.sources) ||
        !Array.isArray(payload.snapshot.areas)
      )
        throw new Error(text.loadError);
      return payload.snapshot;
    },
    [scopedPath, text.loadError],
  );

  useEffect(() => {
    const controller = new AbortController();
    loadSnapshot(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setSnapshot(data);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setLoadError(getKnowledgeErrorMessage(language, cause, text.loadError));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [language, loadSnapshot, text.loadError]);

  async function refresh() {
    setLoadError("");
    setLoading(true);
    try {
      setSnapshot(await loadSnapshot());
    } catch (cause) {
      setLoadError(getKnowledgeErrorMessage(language, cause, text.loadError));
    } finally {
      setLoading(false);
    }
  }

  async function mutate<Result = Record<string, unknown>>(path: string, body: object, method = "POST") {
    const response = await csrfFetch(scopedPath(path), {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return readResponse<Result>(response, text.saveError);
  }

  async function runAction(
    key: string,
    action: () => Promise<void>,
    success = text.saved,
  ) {
    setBusy(key);
    setError("");
    setNotice("");
    try {
      await action();
      setSnapshot(await loadSnapshot());
      setNotice(success);
    } catch (cause) {
      setError(getKnowledgeErrorMessage(language, cause, text.saveError));
    } finally {
      setBusy("");
    }
  }

  const activeAreas = useMemo(
    () => snapshot?.areas.filter((area) => !area.archivedAt) ?? [],
    [snapshot],
  );
  const visibleAreas = activeAreas.filter(
    (area) => !projectId || !area.projectId || area.projectId === projectId,
  );
  const visibleSources =
    snapshot?.sources.filter(
      (source) =>
        (statusFilter === "all" || (statusFilter === "active" ? !source.archivedAt : effectiveSourceState(source) === statusFilter)) &&
        (!projectId || !source.projectId || source.projectId === projectId) &&
        (!areaFilter || source.areaId === areaFilter) &&
        source.name
          .toLocaleLowerCase(language)
          .includes(search.trim().toLocaleLowerCase(language)),
    ) ?? [];
  const selectedBot = snapshot?.bots.find((bot) => bot.id === botId);
  const eligibleAreas = activeAreas.filter(
    (area) => !area.projectId || area.projectId === selectedBot?.projectId,
  );
  const assignedAreaIds =
    assignmentDraft ??
    snapshot?.assignments
      .filter((item) => item.botId === botId && item.channel === channel)
      .map((item) => item.areaId) ??
    [];
  const canWrite = Boolean(
    snapshot?.available &&
      snapshot.entitlement.enabled &&
      snapshot.permissions.canWrite,
  );
  const canAssign = Boolean(
    snapshot?.available &&
      snapshot.entitlement.enabled &&
      snapshot.permissions.canAssign,
  );
  const sourceLimitReached = Boolean(
    snapshot && snapshot.usage.sources >= snapshot.entitlement.maxSources,
  );
  const areaLimitReached = Boolean(
    snapshot && activeAreas.length >= snapshot.entitlement.limits.maxAreas,
  );
  const disabled = Boolean(busy);
  const areaTypeLabel = (kind: KnowledgeAreaKind) =>
    kind === "company"
      ? text.companyArea
      : kind === "business"
        ? text.businessArea
        : text.projectArea;
  function effectiveSourceState(source: KnowledgeSource) {
    if (source.archivedAt) return "archived";
    if (source.version?.processingStatus === "failed" || source.version?.processingStatus === "needs_ocr") return "error";
    const workflowState = (source as KnowledgeSource & { workflowState?: string }).workflowState;
    if (workflowState) return workflowState;
    if (source.approvedVersionId && !source.draftVersionId) return "published";
    return source.status === "needs-review" || source.status === "pending_review" ? "draft" : source.status;
  }
  const statusLabel = (status: string) =>
    ({
      submitted: lifecycleText.submitted,
      reviewed: lifecycleText.reviewed,
      revoked: lifecycleText.revoked,
      error: lifecycleText.error,
      draft: text.draft,
      approved: text.approved,
      published: text.published,
      archived: text.archived,
      pending: text.pending,
      pending_review: text.pending,
      active: text.active,
      "needs-review": text.pending,
      rejected: text.rejected,
    })[status] ?? status;
  const channelLabel = (value: KnowledgeChannel) =>
    value === "telephone" ? text.voice : text[value];
  const dateLabel = (value: string) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? "—"
      : new Intl.DateTimeFormat(language, {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(date);
  };

  function startSource(
    source?: KnowledgeSource,
    type: KnowledgeSourceType = "manual",
  ) {
    const version = source?.version;
    const faqData = version?.structuredData;
    setEditor(
      source
        ? {
            sourceId: source.id,
            revision: source.revision,
            areaId: source.areaId,
            name: source.name,
            type: source.type,
            content: version?.content ?? "",
            question:
              typeof faqData?.question === "string" ? faqData.question : "",
            answer:
              typeof faqData?.answer === "string"
                ? faqData.answer
                : (version?.content ?? ""),
            structuredBase: version?.structuredData ?? {},
            structuredRows: createStructuredKnowledgeRows(
              version?.structuredData ?? {},
            ),
            structuredRemovedKeys: [],
            structuredTemplate: "custom",
            url: version?.url ?? "",
            mediaAssetId: version?.mediaAssetId ?? "",
            documentName: version?.mediaAssetId ? source.name : "",
          }
        : { ...emptyEditor, type, areaId: areaFilter || visibleAreas[0]?.id || "" },
    );
    setError("");
    setNotice("");
    window.requestAnimationFrame(() => {
      const nameInput = document.getElementById(`${formId}-source-name`);
      nameInput?.scrollIntoView({ block: "nearest" });
      nameInput?.focus({ preventScroll: true });
    });
  }

  function updateEditor(patch: Partial<SourceEditor>) {
    setEditor((current) => (current ? { ...current, ...patch } : current));
  }

  async function saveSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor) return;
    const current = editor;
    let structuredData: Record<string, unknown> | undefined;
    if (current.type === "structured") {
      try {
        structuredData = serializeStructuredKnowledge(
          current.structuredBase,
          current.structuredRows,
          current.structuredRemovedKeys,
        );
      } catch {
        setError(text.invalidField);
        return;
      }
      if (!Object.keys(structuredData).length) {
        setError(text.emptyStructured);
        return;
      }
    }
    if (current.type === "faq")
      structuredData = {
        question: current.question.trim(),
        answer: current.answer.trim(),
      };
    const content =
      current.type === "faq"
        ? `${current.question.trim()}\n${current.answer.trim()}`
        : current.content.trim();
    const payload = {
      name: current.name.trim(),
      ...(current.type === "manual" ||
      current.type === "faq" ||
      (current.type === "file" && content)
        ? { content }
        : {}),
      ...(structuredData ? { structuredData } : {}),
      ...(current.type === "url" ? { url: current.url.trim() } : {}),
      ...(current.type === "file"
        ? { mediaAssetId: current.mediaAssetId }
        : {}),
    };
    if (
      !payload.name ||
      !current.areaId ||
      (current.type === "file" && !current.mediaAssetId)
    ) {
      setError(text.requiredFields);
      return;
    }
    if (current.type === "url" && !current.sourceId) {
      await importWebsite(undefined, { areaId: current.areaId, name: payload.name, url: current.url.trim() });
      return;
    }
    await runAction("source", async () => {
      await mutate(
        current.sourceId
          ? "/api/knowledge-center/versions"
          : "/api/knowledge-center/sources",
        current.sourceId
          ? {
              ...payload,
              sourceId: current.sourceId,
              expectedVersion: current.revision,
            }
          : { ...payload, type: current.type, areaId: current.areaId },
      );
      setEditor(null);
      setHistorySourceId("");
    });
  }

  async function importWebsite(existing?: KnowledgeSource, create?: { areaId: string; name: string; url: string }) {
    setBusy(existing ? `website:${existing.id}` : "website");
    setError("");
    setNotice("");
    try {
      const result = await mutate<WebsiteImportResponse>("/api/knowledge-center/websites", existing
        ? { action: "import", sourceId: existing.id, expectedVersion: existing.revision }
        : { action: "create", ...create });
      if (!result.source?.id || !result.websiteImport?.status) throw new Error(text.saveError);
      const source = result.source;
      // Keep the created ID even if the follow-up refresh fails. A failed fetch
      // is a saved URL with a partial import, not a reason to create a duplicate.
      setSnapshot((current) => current ? {
        ...current, sources: [source, ...current.sources.filter((item) => item.id !== source.id)],
      } : current);
      setEditor(null);
      setSearch("");
      setAreaFilter(source.areaId);
      setHistorySourceId("");
      setReviewSourceId(result.websiteImport.status === "ready" ? source.id : "");
      setMonitoringSourceId(result.websiteImport.status === "ready" ? "" : source.id);
      const status = result.websiteImport.status;
      setNotice(status === "ready" ? text.websiteImported
        : status === "busy" ? text.websiteImportBusy
          : status === "changes_pending" ? text.websiteChangesPending
            : status === "stale" ? text.websiteImportStale
              : `${text.websiteImportPending}${result.websiteImport.errorCode ? ` ${knowledgeMonitoringError(language, result.websiteImport.errorCode)}` : ""}`);
      setSnapshot(await loadSnapshot());
    } catch (cause) {
      setError(getKnowledgeErrorMessage(language, cause, text.saveError));
    } finally {
      setBusy("");
    }
  }

  async function uploadDocument(file: File, replacement?: KnowledgeSource) {
    const areaId = replacement?.areaId || editor?.areaId;
    if (!areaId) {
      setError(text.requiredUploadArea);
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError(text.tooLarge);
      return;
    }
    setBusy("upload");
    setError("");
    setNotice("");
    try {
      const response = await uploadKnowledgeDocument(scopedPath("/api/knowledge-center/documents"), file, {
        name: replacement?.name || editor?.name.trim() || file.name, areaId,
        ...(replacement ? { sourceId: replacement.id, expectedVersion: replacement.revision } : {}),
      });
      const { asset, source } = await readResponse<{
        asset: { id: string; name: string };
        source: KnowledgeSource;
      }>(response, text.uploadError);
      if (!asset?.id || !source?.id) throw new Error(text.uploadError);
      setSnapshot((current) => current ? {
        ...current,
        sources: [
          source,
          ...current.sources.filter((item) => item.id !== source.id),
        ],
      } : current);
      setEditor(null);
      setSearch("");
      setAreaFilter(areaId);
      setReviewSourceId(source.id);
      setHistorySourceId("");
      setNotice(text.uploadSuccess);
      setSnapshot(await loadSnapshot());
    } catch (cause) {
      setError(getKnowledgeErrorMessage(language, cause, text.uploadError));
    } finally {
      setBusy("");
    }
  }

  function processingLabel(version: KnowledgeVersion) {
    return version.processingStatus === "ready"
      ? text.recognizedReady
      : version.processingStatus === "needs_ocr"
        ? text.needsReadableFile
        : version.processingStatus === "failed"
          ? text.importFailed
          : text.manualContent;
  }

  function needsReadableFile(version: KnowledgeVersion) {
    return (
      version.processingStatus === "needs_ocr" ||
      version.processingStatus === "failed"
    );
  }

  function toggleReview(sourceId: string) {
    setReviewSourceId((current) => current === sourceId ? "" : sourceId);
  }

  async function saveArea(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runAction("area", async () => {
      const payload = {
        name: areaName.trim(),
        description: areaDescription.trim(),
      };
      await mutate(
        editingAreaId
          ? `/api/knowledge-center/areas/${encodeURIComponent(editingAreaId)}`
          : "/api/knowledge-center/areas",
        editingAreaId
          ? { ...payload, action: "update" }
          : {
              ...payload,
              kind: areaKind,
              ...(areaKind === "project" ? { projectId: areaProjectId } : {}),
            },
        editingAreaId ? "PATCH" : "POST",
      );
      setAreaName("");
      setAreaDescription("");
      setEditingAreaId("");
      setShowAreaForm(false);
    });
  }

  function startArea(area?: KnowledgeArea) {
    setEditingAreaId(area?.id ?? "");
    setAreaName(area?.name ?? "");
    setAreaDescription(area?.description ?? "");
    setAreaKind(area?.kind ?? "company");
    setAreaProjectId(area?.projectId ?? projectId);
    setShowAreaForm(true);
    setTab("areas");
    setError("");
    setNotice("");
  }

  function loadHistory(sourceId: string) {
    setHistorySourceId((current) => current === sourceId ? "" : sourceId);
  }

  async function reloadSnapshot() {
    setSnapshot(await loadSnapshot());
  }

  function renderStructuredFields() {
    if (!editor) return null;
    const editableKeys = new Set(
      createStructuredKnowledgeRows(editor.structuredBase).map(
        (row) => row.key,
      ),
    );
    const preservedEntries = Object.entries(editor.structuredBase).filter(
      ([key]) => !editableKeys.has(key),
    );
    const dynamicCrm =
      knowledgeTemplates.find(
        (template) => template.id === editor.structuredTemplate,
      )?.dynamicCrm ||
      editor.structuredRows.some((row) =>
        /price|pricing|rental|availability/i.test(row.key),
      );
    const updateRow = (id: string, patch: Partial<StructuredKnowledgeRow>) =>
      updateEditor({
        structuredRows: editor.structuredRows.map((row) =>
          row.id === id ? { ...row, ...patch } : row,
        ),
      });
    return (
      <div className="grid gap-4">
        <Field label={text.template}>
          <select
            className={inputClass}
            disabled={disabled}
            onChange={(event) =>
              updateEditor({
                structuredTemplate: event.target.value,
                structuredRows: addKnowledgeTemplateFields(
                  editor.structuredRows,
                  editor.structuredBase,
                  event.target.value,
                ),
              })
            }
            value={editor.structuredTemplate}
          >
            <option value="custom">{text.customTemplate}</option>
            {knowledgeTemplates.map((template) => (
              <option key={template.id} value={template.id}>
                {knowledgeLabel(template.label, language)}
              </option>
            ))}
          </select>
          <span className="text-xs font-normal leading-5 text-stone-600">
            {text.structuredHint}
          </span>
        </Field>
        <div className="grid gap-3">
          {editor.structuredRows.map((row) => {
            const field = row.custom ? undefined : knowledgeField(row.key);
            return (
              <div
                className="grid items-start gap-3 rounded-lg border border-stone-200 bg-white p-3 sm:grid-cols-[minmax(0,1fr)_auto]"
                key={row.id}
              >
                <div className="grid gap-3">
                  {!field ? (
                    <Field label={text.fieldName}>
                      <input
                        className={inputClass}
                        disabled={disabled}
                        maxLength={160}
                        onChange={(event) =>
                          updateRow(row.id, { key: event.target.value })
                        }
                        value={row.key}
                      />
                    </Field>
                  ) : null}
                  <Field
                    label={
                      field
                        ? knowledgeLabel(field.label, language)
                        : text.fieldValue
                    }
                  >
                    {field?.multiline ? (
                      <textarea
                        className={`${inputClass} min-h-24`}
                        disabled={disabled}
                        maxLength={10000}
                        onChange={(event) =>
                          updateRow(row.id, { value: event.target.value })
                        }
                        value={row.value}
                      />
                    ) : (
                      <input
                        className={inputClass}
                        disabled={disabled}
                        maxLength={10000}
                        onChange={(event) =>
                          updateRow(row.id, { value: event.target.value })
                        }
                        value={row.value}
                      />
                    )}
                  </Field>
                </div>
                <button
                  aria-label={`${text.removeField}${row.key ? `: ${knowledgeFieldLabel(row.key, language)}` : ""}`}
                  className={buttonClass}
                  disabled={disabled}
                  onClick={() =>
                    updateEditor({
                      structuredRows: editor.structuredRows.filter(
                        (item) => item.id !== row.id,
                      ),
                      structuredRemovedKeys: row.originalKey
                        ? [...editor.structuredRemovedKeys, row.originalKey]
                        : editor.structuredRemovedKeys,
                    })
                  }
                  type="button"
                >
                  {text.removeField}
                </button>
              </div>
            );
          })}
        </div>
        <div>
          <button
            className={buttonClass}
            disabled={disabled}
            onClick={() =>
              updateEditor({
                structuredRows: [
                  ...editor.structuredRows,
                  { id: crypto.randomUUID(), key: "", value: "", custom: true },
                ],
              })
            }
            type="button"
          >
            {text.addField}
          </button>
        </div>
        {preservedEntries.length ? (
          <details className="rounded-lg border border-stone-200 bg-stone-50 p-3">
            <summary className="min-h-8 cursor-pointer text-sm font-medium">
              {text.preservedDetails}
            </summary>
            <p className="mt-2 text-xs leading-5 text-stone-600">
              {text.preservedHint}
            </p>
            <dl className="mt-3 grid gap-3">
              {preservedEntries.map(([key, value]) => (
                <div key={key}>
                  <dt className="text-sm font-medium">
                    {knowledgeFieldLabel(key, language)}
                  </dt>
                  <dd className="mt-1 whitespace-pre-wrap break-words text-sm text-stone-600">
                    {structuredKnowledgeSummary(value, language)}
                  </dd>
                </div>
              ))}
            </dl>
          </details>
        ) : null}
        {dynamicCrm ? (
          <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-950">
            {text.dynamicCrmHint}
          </p>
        ) : null}
      </div>
    );
  }

  function renderSourceForm() {
    if (!editor) return null;
    return (
      <form
        aria-labelledby={`${formId}-source-title`}
        className="evelyn-knowledge-editor grid gap-4 rounded-xl border border-emerald-200 bg-emerald-50/40 p-4 sm:p-5"
        id={`${formId}-source-form`}
        onSubmit={(event) => void saveSource(event)}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4
            className="font-semibold text-slate-950"
            id={`${formId}-source-title`}
          >
            {editor.sourceId ? text.newVersion : text.newSource}
          </h4>
          <button
            className={buttonClass}
            disabled={disabled}
            onClick={() => setEditor(null)}
            type="button"
          >
            {text.cancel}
          </button>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={text.type}>
            <select
              className={inputClass}
              disabled={disabled || Boolean(editor.sourceId)}
              onChange={(event) =>
                updateEditor({
                  type: event.target.value as KnowledgeSourceType,
                })
              }
              value={editor.type}
            >
              {sourceTypes.map((type) => (
                <option
                  disabled={
                    type === "url" &&
                    !snapshot?.entitlement.features.websiteImport
                  }
                  key={type}
                  value={type}
                >
                  {text[type]}
                </option>
              ))}
            </select>
          </Field>
          <Field label={text.area}>
            <select
              className={inputClass}
              disabled={disabled || Boolean(editor.sourceId)}
              onChange={(event) => updateEditor({ areaId: event.target.value })}
              required
              value={editor.areaId}
            >
              <option value="">{text.selectArea}</option>
              {activeAreas.map((area) => (
                <option key={area.id} value={area.id}>
                  {area.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label={editor.type === "file" && !editor.sourceId ? `${text.name} (${text.optional})` : text.name}>
          <input
            autoComplete="off"
            className={inputClass}
            disabled={disabled}
            id={`${formId}-source-name`}
            maxLength={200}
            onChange={(event) => updateEditor({ name: event.target.value })}
            required={editor.type !== "file" || Boolean(editor.sourceId)}
            value={editor.name}
          />
          {editor.type === "file" && !editor.sourceId ? (
            <span className="text-xs font-normal text-stone-600">{text.fileNameHint}</span>
          ) : null}
        </Field>
        {editor.type === "faq" ? (
          <div className="grid gap-4">
            <Field label={text.question}>
              <input
                className={inputClass}
                disabled={disabled}
                onChange={(event) =>
                  updateEditor({ question: event.target.value })
                }
                required
                value={editor.question}
              />
            </Field>
            <Field label={text.answer}>
              <textarea
                className={`${inputClass} min-h-32`}
                disabled={disabled}
                onChange={(event) =>
                  updateEditor({ answer: event.target.value })
                }
                required
                value={editor.answer}
              />
            </Field>
          </div>
        ) : null}
        {editor.type === "manual" ? (
          <Field label={text.content}>
            <textarea
              className={`${inputClass} min-h-44`}
              disabled={disabled}
              maxLength={100000}
              onChange={(event) =>
                updateEditor({ content: event.target.value })
              }
              required
              value={editor.content}
            />
          </Field>
        ) : null}
        {editor.type === "structured" ? renderStructuredFields() : null}
        {editor.type === "url" ? (
          <Field label={text.website}>
            <input
              aria-describedby={`${formId}-website-hint`}
              className={inputClass}
              disabled={disabled}
              onChange={(event) => updateEditor({ url: event.target.value })}
              required
              type="url"
              value={editor.url}
            />
            <span
              className="text-xs font-normal leading-5 text-stone-600"
              id={`${formId}-website-hint`}
            >
              {text.websiteHint}
            </span>
          </Field>
        ) : null}
        {editor.type === "file" ? (
          <div className="grid gap-3">
            <p className="text-sm font-medium leading-6 text-emerald-950">{text.importFlow}</p>
            <Field label={busy === "upload" ? text.uploading : text.upload}>
              <input
                accept=".pdf,.docx,.txt,.md,.csv,.json,.png,.jpg,.jpeg,.webp"
                aria-describedby={`${formId}-file-hint`}
                className={`${inputClass} cursor-pointer file:mr-3 file:rounded-md file:border-0 file:bg-stone-100 file:px-3 file:py-1`}
                disabled={disabled || !editor.areaId || !canWrite}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void uploadDocument(file, editor.sourceId ? snapshot?.sources.find((source) => source.id === editor.sourceId) : undefined);
                  event.target.value = "";
                }}
                type="file"
              />
              <span
                className="text-xs font-normal leading-5 text-stone-600"
                id={`${formId}-file-hint`}
              >
                {text.documentHint}
              </span>
            </Field>
            {editor.documentName ? (
              <p className="break-words rounded-lg border border-emerald-200 bg-white p-3 text-sm font-medium text-emerald-900">
                {editor.documentName}
              </p>
            ) : null}
            {editor.sourceId ? <Field label={text.recognizedContent}>
              <textarea
                className={`${inputClass} min-h-24`}
                disabled={disabled}
                onChange={(event) =>
                  updateEditor({ content: event.target.value })
                }
                value={editor.content}
              />
            </Field> : null}
          </div>
        ) : null}
        <p className="text-xs leading-5 text-stone-600">{text.draftHint}</p>
        {editor.type !== "file" || editor.sourceId ? <div>
          <button
            className={primaryClass}
            disabled={
              disabled ||
              !canWrite ||
              (!editor.sourceId && sourceLimitReached) ||
              (editor.type === "file" && !editor.mediaAssetId)
            }
            type="submit"
          >
            {busy === "website"
              ? text.importingWebsite
              : busy === "source" ? text.saving
              : editor.sourceId
                ? text.newVersion
                : text.save}
          </button>
        </div> : null}
      </form>
    );
  }

  const companyName = snapshot?.workspace.name || workspaceName || "—";
  return (
    <section
      aria-labelledby={`${formId}-heading`}
      className="evelyn-knowledge-center grid min-w-0 gap-5 text-slate-950"
      data-knowledge-center="true"
    >
      <header className="evelyn-domain-hero evelyn-knowledge-hero rounded-xl border border-stone-200 bg-white p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="evelyn-domain-eyebrow text-xs font-semibold uppercase tracking-[0.14em] text-emerald-800">
              Evelyn
            </p>
            <h3
              className="evelyn-domain-title mt-1 break-words text-xl font-semibold sm:text-2xl"
              id={`${formId}-heading`}
            >
              {text.title}
            </h3>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-600">
              {text.description}
            </p>
          </div>
          <button
            aria-label={text.refresh}
            className={buttonClass}
            disabled={loading || disabled}
            onClick={() => void refresh()}
            type="button"
          >
            {text.refresh}
          </button>
        </div>
        <div className="evelyn-knowledge-context mt-5 grid gap-3 sm:grid-cols-2">
          <Field label={text.company}>
            <select
              aria-readonly="true"
              className={inputClass}
              disabled
              value={snapshot?.workspace.id || workspaceId || ""}
            >
              <option value={snapshot?.workspace.id || workspaceId || ""}>
                {companyName}
              </option>
            </select>
          </Field>
          <Field label={text.project}>
            <select
              className={inputClass}
              disabled={!snapshot || loading || disabled}
              onChange={(event) => {
                setProjectId(event.target.value);
                setAreaFilter("");
              }}
              value={projectId}
            >
              <option value="">{text.allProjects}</option>
              {snapshot?.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {snapshot?.available ? (
          <dl className="evelyn-knowledge-summary">
            <div><dt>{text.sources}</dt><dd>{visibleSources.length}</dd></div>
            <div><dt>{text.approved}</dt><dd>{visibleSources.filter((source) => Boolean(source.approvedVersionId)).length}</dd></div>
            <div><dt>{text.draft}</dt><dd>{visibleSources.filter((source) => Boolean(source.draftVersionId)).length}</dd></div>
          </dl>
        ) : null}
      </header>
      {loading ? (
        <p
          aria-live="polite"
          className="rounded-xl border border-stone-200 bg-white p-6 text-sm text-stone-600"
          role="status"
        >
          {text.loading}
        </p>
      ) : loadError ? (
        <div
          className="rounded-xl border border-red-200 bg-red-50 p-5"
          role="alert"
        >
          <p className="text-sm font-medium text-red-900">{loadError}</p>
          <button
            className={`${buttonClass} mt-3`}
            onClick={() => void refresh()}
            type="button"
          >
            {text.retry}
          </button>
        </div>
      ) : snapshot ? (
        <>
          {!snapshot.available && snapshot.entitlement.enabled ? (
            <EmptyState
              description={text.unavailableHint}
              title={text.unavailable}
            />
          ) : (
            <>
              {!snapshot.entitlement.enabled ? (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
                  <p className="font-semibold text-amber-950">
                    {text.disabled}
                  </p>
                  <p className="mt-1 text-sm leading-6 text-amber-900">
                    {text.disabledHint}
                  </p>
                </div>
              ) : !snapshot.permissions.canWrite ? (
                <p className="rounded-lg bg-stone-100 p-3 text-sm text-stone-700">
                  {text.readOnly}
                </p>
              ) : null}
              <div className="evelyn-knowledge-workspace">
              <nav aria-label={text.title} className="evelyn-knowledge-nav flex flex-wrap gap-2">
                {(["sources", "areas", "assistants", "maintenance", "usage"] as const).filter((value) => value !== "maintenance" || snapshot.permissions.canWrite).map(
                  (value) => (
                    <button
                      aria-controls={`${formId}-panel`}
                      aria-pressed={tab === value}
                      className={`${buttonClass} evelyn-knowledge-nav-item ${tab === value ? "border-emerald-800 bg-emerald-50 text-emerald-950" : ""}`}
                      key={value}
                      onClick={() => {
                        setTab(value);
                        setError("");
                        setNotice("");
                      }}
                      type="button"
                    >
                      {value === "maintenance" ? lifecycleText.maintenance : text[value]}
                      {value === "sources"
                        ? ` (${snapshot.sources.filter((source) => !source.archivedAt).length})`
                        : value === "areas"
                          ? ` (${activeAreas.length})`
                          : ""}
                    </button>
                  ),
                )}
              </nav>
              <div className="evelyn-knowledge-main">
              {error ? (
                <p
                  className="break-words rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900"
                  role="alert"
                >
                  {error}
                </p>
              ) : null}
              {notice ? (
                <p
                  aria-live="polite"
                  className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950"
                  role="status"
                >
                  {notice}
                </p>
              ) : null}
              {busy === "upload" ? (
                <p aria-live="polite" className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950" role="status">{text.uploading}</p>
              ) : null}
              <div
                className="evelyn-knowledge-panel min-w-0 rounded-xl border border-stone-200 bg-white p-4 sm:p-5"
                id={`${formId}-panel`}
              >
                {tab === "sources" ? (
                  <div className="evelyn-knowledge-section evelyn-knowledge-section-sources grid gap-5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <h4 className="text-lg font-semibold">{text.sources}</h4>
                      {canWrite ? (
                        <button
                          aria-controls={editor ? `${formId}-source-form` : undefined}
                          aria-expanded={Boolean(editor)}
                          className={primaryClass}
                          disabled={
                            disabled ||
                            !activeAreas.length ||
                            sourceLimitReached
                          }
                          onClick={() => startSource()}
                          type="button"
                        >
                          {text.newSource}
                        </button>
                      ) : null}
                    </div>
                    {canWrite && activeAreas.length ? (
                      <div className="evelyn-knowledge-actions grid gap-3 md:grid-cols-3">
                        {([
                          { type: "file", title: text.addDocument, hint: text.documentActionHint },
                          { type: "url", title: text.addWebsite, hint: text.websiteActionHint },
                          { type: "manual", title: text.addText, hint: text.textActionHint },
                        ] as const).map((action) => (
                          <button
                            aria-controls={editor ? `${formId}-source-form` : undefined}
                            aria-describedby={`${formId}-action-hint-${action.type}`}
                            aria-label={action.title}
                            className="evelyn-knowledge-add-source flex min-h-28 min-w-0 gap-3 rounded-xl border border-emerald-200 bg-emerald-50/40 p-4 text-left transition hover:border-emerald-600 hover:bg-emerald-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                            disabled={disabled || sourceLimitReached || (action.type === "url" && !snapshot.entitlement.features.websiteImport)}
                            key={action.type}
                            onClick={() => startSource(undefined, action.type)}
                            type="button"
                          >
                            <span className="rounded-lg bg-white p-2 text-emerald-800"><KnowledgeIcon type={action.type} /></span>
                            <span className="min-w-0"><span className="block font-semibold">{action.title}</span><span className="mt-1 block text-xs font-normal leading-5 text-stone-600" id={`${formId}-action-hint-${action.type}`}>{action.hint}</span></span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                    {sourceLimitReached && canWrite ? (
                      <p className="text-sm text-amber-900">
                        {text.sourceLimit}
                      </p>
                    ) : null}
                    {renderSourceForm()}
                    {activeAreas.length ? (
                      <div className="evelyn-knowledge-filters grid gap-3 sm:grid-cols-2">
                        <Field label={text.area}>
                          <select
                            className={inputClass}
                            onChange={(event) =>
                              setAreaFilter(event.target.value)
                            }
                            value={areaFilter}
                          >
                            <option value="">{text.allAreas}</option>
                            {visibleAreas.map((area) => (
                              <option key={area.id} value={area.id}>
                                {area.name}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <Field label={lifecycleText.state}>
                          <select className={inputClass} value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                            <option value="active">{lifecycleText.activeStates}</option>
                            <option value="all">{lifecycleText.allStates}</option>
                            {(["draft", "submitted", "reviewed", "approved", "published", "error"] as const).map((value) => <option key={value} value={value}>{lifecycleText[value]}</option>)}
                          </select>
                        </Field>
                        <Field label={text.search}>
                          <input
                            className={inputClass}
                            onChange={(event) => setSearch(event.target.value)}
                            type="search"
                            value={search}
                          />
                        </Field>
                      </div>
                    ) : null}
                    {!activeAreas.length ? (
                      <div className="grid gap-3">
                        <EmptyState
                          description={canWrite ? text.noAreasHint : text.readOnly}
                          title={text.noAreas}
                        />
                        {canWrite ? (
                          <div>
                            <button
                              className={primaryClass}
                              disabled={disabled || areaLimitReached}
                              onClick={() => startArea()}
                              type="button"
                            >
                              {text.newArea}
                            </button>
                          </div>
                        ) : null}
                      </div>
                    ) : !visibleSources.length ? (
                      <EmptyState
                        description={
                          snapshot.sources.length
                            ? undefined
                            : text.noSourcesHint
                        }
                        title={
                          snapshot.sources.length
                            ? text.noMatches
                            : text.noSources
                        }
                      />
                    ) : (
                      <ul className="evelyn-knowledge-sources grid gap-3">
                        {visibleSources.map((source) => (
                          <li
                            className="evelyn-knowledge-source min-w-0 rounded-xl border border-stone-200 p-4"
                            data-knowledge-source-id={source.id}
                            data-source-status={source.status}
                            data-has-draft={Boolean(source.draftVersionId)}
                            key={source.id}
                          >
                            <div className="evelyn-knowledge-source-header flex flex-wrap items-start justify-between gap-3">
                              <span className="evelyn-knowledge-source-icon"><KnowledgeIcon type={source.type === "file" ? "file" : source.type === "url" ? "url" : "manual"} /></span>
                              <div className="evelyn-knowledge-source-title min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="rounded-md bg-stone-100 px-2 py-1 text-xs font-medium text-stone-700">
                                    {text[source.type]}
                                  </span>
                                  <span
                                    className={`evelyn-domain-source-status rounded-md px-2 py-1 text-xs font-semibold ${effectiveSourceState(source) === "approved" || effectiveSourceState(source) === "published" ? "bg-emerald-50 text-emerald-900" : "bg-amber-50 text-amber-900"}`}
                                  >
                                    {statusLabel(effectiveSourceState(source))}
                                  </span>
                                </div>
                                <h5 className="mt-2 break-words font-semibold text-slate-950">
                                  {source.name}
                                </h5>
                                <p className="mt-1 break-words text-xs text-stone-600">
                                  {
                                    activeAreas.find(
                                      (area) => area.id === source.areaId,
                                    )?.name
                                  }
                                </p>
                              </div>
                              <div className="evelyn-knowledge-source-version text-xs leading-6 text-stone-600">
                                <p>
                                  {text.version}:{" "}
                                  {source.version?.version ?? "—"}
                                </p>
                                {source.version?.createdAt ? (
                                  <p>
                                    {text.updated}:{" "}
                                    {dateLabel(source.version.createdAt)}
                                  </p>
                                ) : null}
                              </div>
                            </div>
                            {source.version?.content ? (
                              <p className="mt-3 line-clamp-3 whitespace-pre-wrap break-words text-sm leading-6 text-stone-600">
                                {source.version.content}
                              </p>
                            ) : source.version?.url ? (
                              <p className="mt-3 break-all text-sm text-stone-600">
                                {source.version.url}
                              </p>
                            ) : source.type === "structured" &&
                              source.version ? (
                              <p className="mt-3 line-clamp-4 whitespace-pre-wrap break-words rounded-lg bg-stone-50 p-3 text-sm leading-6 text-stone-700">
                                {structuredKnowledgeSummary(
                                  source.version.structuredData,
                                  language,
                                )}
                              </p>
                            ) : null}
                            {source.type === "file" && source.version ? (
                              <div className={`mt-3 rounded-lg border p-3 text-sm ${needsReadableFile(source.version) ? "border-amber-200 bg-amber-50 text-amber-950" : "border-emerald-200 bg-emerald-50 text-emerald-950"}`}>
                                <p className="font-medium">{processingLabel(source.version)}</p>
                                {source.version.processingMessage ? <p className="mt-1 text-xs leading-5">{source.version.processingMessage}</p> : null}
                                {needsReadableFile(source.version) ? <p className="mt-1 text-xs leading-5">{text.extractionHelp}</p> : null}
                              </div>
                            ) : null}
                            <p className={`evelyn-knowledge-publication-state mt-3 text-xs font-medium ${source.approvedVersionId ? "text-emerald-900" : "text-amber-900"}`}>
                              {source.approvedVersionId
                                ? source.draftVersionId ? text.approvedPrevious : text.approvedCurrent
                                : text.notApproved}
                            </p>
                            <div className="evelyn-domain-actions mt-4 flex flex-wrap gap-2">
                              {source.version ? <button
                                aria-controls={reviewSourceId === source.id ? `${formId}-review-${source.id}` : undefined}
                                aria-expanded={reviewSourceId === source.id}
                                className={buttonClass}
                                disabled={disabled}
                                onClick={() => toggleReview(source.id)}
                                type="button"
                              >{reviewSourceId === source.id ? text.closeReview : text.reviewContent}</button> : null}
                              {canWrite && !source.archivedAt ? (
                                <button
                                  className={buttonClass}
                                  disabled={disabled}
                                  onClick={() => startSource(source)}
                                  type="button"
                                >
                                  {text.edit}
                                </button>
                              ) : null}
                              {canWrite && !source.archivedAt && source.type === "file" ? (
                                <label className={`${buttonClass} inline-flex cursor-pointer items-center focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-emerald-700 ${disabled ? "cursor-not-allowed opacity-50" : ""}`}>
                                  {text.replaceFile}
                                  <input
                                    accept=".pdf,.docx,.txt,.md,.csv,.json,.png,.jpg,.jpeg,.webp"
                                    aria-label={`${text.replaceFile}: ${source.name}`}
                                    className="sr-only"
                                    disabled={disabled}
                                    onChange={(event) => {
                                      const file = event.target.files?.[0];
                                      if (file) void uploadDocument(file, source);
                                      event.target.value = "";
                                    }}
                                    type="file"
                                  />
                                </label>
                              ) : null}
                              <button
                                aria-expanded={historySourceId === source.id}
                                className={buttonClass}
                                disabled={disabled}
                                onClick={() => void loadHistory(source.id)}
                                type="button"
                              >
                                {text.versions}
                              </button>
                              {source.type === "file" &&
                              source.version?.mediaAssetId ? (
                                <a
                                  className={`${buttonClass} inline-flex items-center`}
                                  href={scopedPath(
                                    `/api/knowledge-center/sources/${encodeURIComponent(source.id)}/document`,
                                  )}
                                  rel="noopener noreferrer"
                                  target="_blank"
                                >
                                  {text.documentOpen}
                                </a>
                              ) : null}
                              {canWrite && !source.archivedAt && source.type === "url" && snapshot.entitlement.features.websiteImport ? (
                                <>
                                  {!source.approvedVersionId && source.revision === 1 && source.version?.version === 1 && !source.version.content.trim() && !Object.keys(source.version.structuredData).length ? (
                                    <button className={buttonClass} type="button" disabled={disabled} onClick={() => void importWebsite(source)}>
                                      {busy === `website:${source.id}` ? text.importingWebsite : text.importWebsiteContent}
                                    </button>
                                  ) : null}
                                  <button className={buttonClass} type="button" aria-expanded={monitoringSourceId === source.id} disabled={disabled} onClick={() => setMonitoringSourceId((current) => current === source.id ? "" : source.id)}>{lifecycleText.monitoring}</button>
                                </>
                              ) : null}
                              {canWrite && !source.archivedAt ? (
                                <details className="group">
                                  <summary
                                    className={`${buttonClass} cursor-pointer list-none`}
                                  >
                                    {text.archive}
                                  </summary>
                                  <div className="mt-2 max-w-xs rounded-lg border border-stone-200 bg-stone-50 p-3">
                                    <p className="text-xs leading-5 text-stone-600">
                                      {text.archiveHint}
                                    </p>
                                    <button
                                      className={`${buttonClass} mt-2 text-red-900`}
                                      disabled={disabled}
                                      onClick={() =>
                                        void runAction(
                                          `archive:${source.id}`,
                                          async () => {
                                            await mutate(
                                              `/api/knowledge-center/sources/${encodeURIComponent(source.id)}`,
                                              {
                                                action: "archive",
                                                expectedVersion:
                                                  source.revision,
                                              },
                                              "PATCH",
                                            );
                                            if (editor?.sourceId === source.id)
                                              setEditor(null);
                                          },
                                        )
                                      }
                                      type="button"
                                    >
                                      {text.archive}
                                    </button>
                                  </div>
                                </details>
                              ) : null}
                            </div>
                            {(reviewSourceId === source.id || historySourceId === source.id) && source.version ? (
                              <div id={`${formId}-review-${source.id}`}>
                                <KnowledgeLifecyclePanel source={source} snapshot={snapshot} language={language} scopedPath={scopedPath} onChanged={reloadSnapshot} showHistory={historySourceId === source.id} />
                              </div>
                            ) : null}
                            {monitoringSourceId === source.id ? <KnowledgeMonitoringPanel source={source} snapshot={snapshot} language={language} scopedPath={scopedPath} onChanged={reloadSnapshot} /> : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}
                {tab === "areas" ? (
                  <div className="evelyn-knowledge-section evelyn-knowledge-section-areas grid gap-5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <h4 className="text-lg font-semibold">{text.areas}</h4>
                      {canWrite ? (
                        <button
                          aria-expanded={showAreaForm}
                          className={primaryClass}
                          disabled={
                            disabled || (!showAreaForm && areaLimitReached)
                          }
                          onClick={() =>
                            showAreaForm ? setShowAreaForm(false) : startArea()
                          }
                          type="button"
                        >
                          {showAreaForm ? text.cancel : text.newArea}
                        </button>
                      ) : null}
                    </div>
                    {areaLimitReached && canWrite ? (
                      <p className="text-sm text-amber-900">{text.areaLimit}</p>
                    ) : null}
                    {showAreaForm && canWrite ? (
                      <form
                        className="evelyn-knowledge-editor grid gap-4 rounded-xl border border-emerald-200 bg-emerald-50/40 p-4"
                        onSubmit={(event) => void saveArea(event)}
                      >
                        <h5 className="font-semibold">
                          {editingAreaId ? text.edit : text.newArea}
                        </h5>
                        <div className="grid gap-4 sm:grid-cols-2">
                          <Field label={text.name}>
                            <input
                              className={inputClass}
                              disabled={disabled}
                              maxLength={160}
                              onChange={(event) =>
                                setAreaName(event.target.value)
                              }
                              required
                              value={areaName}
                            />
                          </Field>
                          <Field label={text.kind}>
                            <select
                              className={inputClass}
                              disabled={disabled || Boolean(editingAreaId)}
                              onChange={(event) =>
                                setAreaKind(
                                  event.target.value as KnowledgeAreaKind,
                                )
                              }
                              value={areaKind}
                            >
                              {(
                                ["company", "business", "project"] as const
                              ).map((kind) => (
                                <option key={kind} value={kind}>
                                  {areaTypeLabel(kind)}
                                </option>
                              ))}
                            </select>
                          </Field>
                        </div>
                        {areaKind === "project" ? (
                          <Field label={text.project}>
                            <select
                              className={inputClass}
                              disabled={disabled || Boolean(editingAreaId)}
                              onChange={(event) =>
                                setAreaProjectId(event.target.value)
                              }
                              required
                              value={areaProjectId}
                            >
                              <option value="">{text.selectProject}</option>
                              {snapshot.projects.map((project) => (
                                <option key={project.id} value={project.id}>
                                  {project.name}
                                </option>
                              ))}
                            </select>
                          </Field>
                        ) : null}
                        <Field
                          label={`${text.descriptionLabel} (${text.optional})`}
                        >
                          <textarea
                            className={`${inputClass} min-h-24`}
                            disabled={disabled}
                            maxLength={2000}
                            onChange={(event) =>
                              setAreaDescription(event.target.value)
                            }
                            value={areaDescription}
                          />
                        </Field>
                        <div>
                          <button
                            className={primaryClass}
                            disabled={disabled}
                            type="submit"
                          >
                            {busy === "area" ? text.saving : text.save}
                          </button>
                        </div>
                      </form>
                    ) : null}
                    {visibleAreas.length ? (
                      <ul className="evelyn-knowledge-area-list grid gap-3 md:grid-cols-2">
                        {visibleAreas.map((area) => (
                          <li
                            className="evelyn-knowledge-area min-w-0 rounded-xl border border-stone-200 p-4"
                            key={area.id}
                          >
                            <p className="text-xs font-medium text-emerald-800">
                              {areaTypeLabel(area.kind)}
                            </p>
                            <h5 className="mt-2 break-words font-semibold">
                              {area.name}
                            </h5>
                            {area.projectId ? (
                              <p className="mt-1 text-xs text-stone-600">
                                {
                                  snapshot.projects.find(
                                    (project) => project.id === area.projectId,
                                  )?.name
                                }
                              </p>
                            ) : null}
                            {area.description ? (
                              <p className="mt-2 break-words text-sm leading-6 text-stone-600">
                                {area.description}
                              </p>
                            ) : null}
                            <p className="mt-3 text-xs text-stone-600">
                              {
                                snapshot.sources.filter(
                                  (source) =>
                                    source.areaId === area.id &&
                                    !source.archivedAt,
                                ).length
                              }{" "}
                              {text.sources}
                            </p>
                            <div className="mt-3 flex flex-wrap gap-2">
                              <button
                                className={buttonClass}
                                onClick={() => {
                                  setAreaFilter(area.id);
                                  setTab("sources");
                                }}
                                type="button"
                              >
                                {text.sources}
                              </button>
                              {canWrite ? (
                                <>
                                  <button
                                    className={buttonClass}
                                    disabled={disabled}
                                    onClick={() => startArea(area)}
                                    type="button"
                                  >
                                    {text.edit}
                                  </button>
                                  <details>
                                    <summary
                                      className={`${buttonClass} cursor-pointer list-none`}
                                    >
                                      {text.archive}
                                    </summary>
                                    <div className="mt-2 max-w-xs rounded-lg border border-stone-200 bg-stone-50 p-3">
                                      <p className="text-xs leading-5 text-stone-600">
                                        {text.archiveAreaHint}
                                      </p>
                                      <button
                                        className={`${buttonClass} mt-2 text-red-900`}
                                        disabled={disabled}
                                        onClick={() =>
                                          void runAction(
                                            `archive-area:${area.id}`,
                                            async () => {
                                              await mutate(
                                                `/api/knowledge-center/areas/${encodeURIComponent(area.id)}`,
                                                { action: "archive" },
                                                "PATCH",
                                              );
                                              if (areaFilter === area.id)
                                                setAreaFilter("");
                                              if (editor?.areaId === area.id)
                                                setEditor(null);
                                              if (editingAreaId === area.id)
                                                setShowAreaForm(false);
                                            },
                                          )
                                        }
                                        type="button"
                                      >
                                        {text.archive}
                                      </button>
                                    </div>
                                  </details>
                                </>
                              ) : null}
                            </div>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <EmptyState
                        description={canWrite ? text.noAreasHint : text.readOnly}
                        title={text.noAreas}
                      />
                    )}
                  </div>
                ) : null}
                {tab === "assistants" ? (
                  <div className="evelyn-knowledge-section evelyn-knowledge-section-assistants grid gap-5">
                    <div>
                      <h4 className="text-lg font-semibold">
                        {text.assistants}
                      </h4>
                      <p className="mt-2 text-sm leading-6 text-stone-600">
                        {text.assignmentHint}
                      </p>
                    </div>
                    {snapshot.bots.length ? (
                      <>
                        <div className="evelyn-knowledge-channels grid gap-3 sm:grid-cols-2">
                          {(["webchat", "voice"] as const).map((value) => (
                            <button
                              aria-label={channelLabel(value)}
                              aria-pressed={channel === value}
                              className={`evelyn-knowledge-channel flex min-h-28 min-w-0 items-start gap-3 rounded-xl border p-4 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 ${channel === value ? "border-emerald-800 bg-emerald-50" : "border-stone-200 bg-white hover:bg-stone-50"}`}
                              disabled={disabled}
                              key={value}
                              onClick={() => { setChannel(value); setAssignmentDraft(null); }}
                              type="button"
                            >
                              <span className="rounded-lg bg-stone-100 p-2 text-emerald-900"><KnowledgeIcon type={value} /></span>
                              <span className="min-w-0">
                                <span className="block font-semibold">{channelLabel(value)}</span>
                                <span className="mt-1 block text-xs leading-5 text-stone-600">{text.channelIndependent}</span>
                                {botId ? <span className="mt-2 block text-xs font-medium text-emerald-900">{snapshot.assignments.filter((item) => item.botId === botId && item.channel === value).length} {text.assignedAreas}</span> : null}
                              </span>
                            </button>
                          ))}
                        </div>
                        <div className="grid gap-4 sm:grid-cols-2">
                          <Field label={text.assistant}>
                            <select
                              className={inputClass}
                              disabled={disabled}
                              onChange={(event) => {
                                setBotId(event.target.value);
                                setAssignmentDraft(null);
                              }}
                              value={botId}
                            >
                              <option value="">{text.selectAssistant}</option>
                              {snapshot.bots.map((bot) => (
                                <option key={bot.id} value={bot.id}>
                                  {bot.name}
                                </option>
                              ))}
                            </select>
                          </Field>
                          <Field label={text.channel}>
                            <select
                              className={inputClass}
                              disabled={disabled}
                              onChange={(event) => {
                                setChannel(
                                  event.target.value as KnowledgeChannel,
                                );
                                setAssignmentDraft(null);
                              }}
                              value={channel}
                            >
                              {channels.map((value) => (
                                <option key={value} value={value}>
                                  {channelLabel(value)}
                                </option>
                              ))}
                            </select>
                          </Field>
                        </div>
                        {botId ? (
                          <fieldset
                            className="evelyn-knowledge-grants grid gap-3"
                            disabled={!canAssign || disabled}
                          >
                            <legend className="mb-3 text-sm font-semibold">
                              {text.selectedChannel} {channelLabel(channel)}
                            </legend>
                            {eligibleAreas.length ? (
                              eligibleAreas.map((area) => (
                                <label
                                  className="evelyn-knowledge-grant flex min-h-14 cursor-pointer items-start gap-3 rounded-lg border border-stone-200 p-3 text-sm"
                                  key={area.id}
                                >
                                  <input
                                    checked={assignedAreaIds.includes(area.id)}
                                    className="mt-0.5 h-5 w-5 shrink-0 accent-emerald-800"
                                    onChange={(event) =>
                                      setAssignmentDraft(
                                        event.target.checked
                                          ? [...assignedAreaIds, area.id]
                                          : assignedAreaIds.filter(
                                              (id) => id !== area.id,
                                            ),
                                      )
                                    }
                                    type="checkbox"
                                  />
                                  <span className="min-w-0">
                                    <span className="block break-words font-medium">
                                      {area.name}
                                    </span>
                                    <span className="mt-1 block text-xs text-stone-600">
                                      {areaTypeLabel(area.kind)}
                                    </span>
                                  </span>
                                </label>
                              ))
                            ) : (
                              <EmptyState title={text.noAreas} />
                            )}
                            <p className="text-xs leading-5 text-stone-600">
                              {text.assignmentEmpty}
                            </p>
                            <div>
                              <button
                                className={primaryClass}
                                disabled={!canAssign || disabled}
                                onClick={() =>
                                  void runAction(
                                    "assignments",
                                    async () => {
                                      await mutate(
                                        "/api/knowledge-center/assignments",
                                        {
                                          botId,
                                          channel,
                                          areaIds: assignedAreaIds,
                                        },
                                      );
                                      setAssignmentDraft(null);
                                    },
                                    text.assignmentsSaved,
                                  )
                                }
                                type="button"
                              >
                                {busy === "assignments"
                                  ? text.saving
                                  : text.saveAssignments}
                              </button>
                            </div>
                          </fieldset>
                        ) : null}
                      </>
                    ) : (
                      <EmptyState title={text.noAssistants} />
                    )}
                    <p className="rounded-lg bg-stone-50 p-4 text-xs leading-5 text-stone-600">
                      {text.phonePrepared}
                    </p>
                  </div>
                ) : null}
                {tab === "maintenance" ? <KnowledgeMaintenancePanel snapshot={snapshot} language={language} scopedPath={scopedPath} onChanged={reloadSnapshot} /> : null}
                {tab === "usage" ? (
                  <div className="evelyn-knowledge-section evelyn-knowledge-section-usage grid gap-5">
                    <div>
                      <h4 className="text-lg font-semibold">{text.usage}</h4>
                      <p className="mt-2 text-sm leading-6 text-stone-600">
                        {text.usageHint}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-stone-200 bg-stone-50 p-4">
                      <p className="font-medium">{text.module}</p>
                      <span
                        className={`rounded-lg px-3 py-2 text-sm font-semibold ${snapshot.entitlement.enabled ? "bg-emerald-100 text-emerald-950" : "bg-amber-100 text-amber-950"}`}
                      >
                        {snapshot.entitlement.enabled
                          ? text.enabled
                          : text.notEnabled}
                      </span>
                    </div>
                    {snapshot.entitlement.contractReference ? (
                      <p className="break-words text-sm text-stone-600">
                        {text.contract}:{" "}
                        {snapshot.entitlement.contractReference}
                      </p>
                    ) : null}
                    <div className="evelyn-knowledge-usage grid gap-3 lg:grid-cols-3">
                      {[
                        {
                          label: text.sourceUsage,
                          value: snapshot.usage.sources,
                          limit: snapshot.entitlement.maxSources,
                          bytes: false,
                        },
                        {
                          label: text.storageUsage,
                          value: snapshot.usage.storageBytes,
                          limit: snapshot.entitlement.maxStorageBytes,
                          bytes: true,
                        },
                        {
                          label: text.queryUsage,
                          value: snapshot.usage.queriesThisMonth,
                          limit: snapshot.entitlement.maxQueriesPerMonth,
                          bytes: false,
                        },
                      ].map((item) => (
                        <div
                          className="evelyn-knowledge-usage-card rounded-xl border border-stone-200 p-4"
                          key={item.label}
                        >
                          <p className="text-sm font-medium text-stone-600">
                            {item.label}
                          </p>
                          <p className="mt-3 text-xl font-semibold">
                            {item.bytes
                              ? formatBytes(item.value, language)
                              : new Intl.NumberFormat(language).format(
                                  item.value,
                                )}
                            <span className="text-sm font-normal text-stone-500">
                              {" "}
                              /{" "}
                              {item.bytes
                                ? formatBytes(item.limit, language)
                                : new Intl.NumberFormat(language).format(
                                    item.limit,
                                  )}
                            </span>
                          </p>
                          <progress
                            aria-label={item.label}
                            className="mt-4 h-2 w-full overflow-hidden rounded-full accent-emerald-800"
                            max={Math.max(1, item.limit)}
                            value={Math.min(
                              item.value,
                              Math.max(1, item.limit),
                            )}
                          />
                        </div>
                      ))}
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="rounded-xl border border-stone-200 p-4">
                        <h5 className="font-semibold">{text.module}</h5>
                        <dl className="mt-3 grid gap-3">
                          {[
                            {
                              label: text.websiteImport,
                              enabled:
                                snapshot.entitlement.features.websiteImport,
                            },
                            {
                              label: text.monitoring,
                              enabled: snapshot.entitlement.features.monitoring,
                            },
                            {
                              label: text.advancedMaintenance,
                              enabled:
                                snapshot.entitlement.features
                                  .advancedMaintenance,
                            },
                          ].map((item) => (
                            <div
                              className="flex flex-wrap justify-between gap-2 text-sm"
                              key={item.label}
                            >
                              <dt className="text-stone-600">{item.label}</dt>
                              <dd className="font-medium">
                                {item.enabled ? text.enabled : text.notEnabled}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      </div>
                      <div className="rounded-xl border border-stone-200 p-4">
                        <h5 className="font-semibold">{text.usage}</h5>
                        <dl className="mt-3 grid gap-3">
                          {[
                            {
                              label: text.areas,
                              limit: snapshot.entitlement.limits.maxAreas,
                            },
                            {
                              label: text.websiteLimit,
                              limit: snapshot.entitlement.limits.maxWebsites,
                            },
                            {
                              label: text.scanLimit,
                              limit:
                                snapshot.entitlement.limits.maxScansPerMonth,
                            },
                            {
                              label: text.userLimit,
                              limit: snapshot.entitlement.limits.maxUsers,
                            },
                            {
                              label: text.assistantLimit,
                              limit: snapshot.entitlement.limits.maxAssistants,
                            },
                          ].map((item) => (
                            <div
                              className="flex flex-wrap justify-between gap-2 text-sm"
                              key={item.label}
                            >
                              <dt className="text-stone-600">{item.label}</dt>
                              <dd className="font-medium">
                                {new Intl.NumberFormat(language).format(
                                  item.limit,
                                )}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      </div>
                    </div>
                    <div className="rounded-xl border border-stone-200 p-4">
                      <h5 className="font-semibold">{text.permissions}</h5>
                      <dl className="mt-3 grid gap-3">
                        {[
                          {
                            label: text.write,
                            allowed: snapshot.permissions.canWrite,
                          },
                          {
                            label: text.assign,
                            allowed: snapshot.permissions.canAssign,
                          },
                          {
                            label: text.publish,
                            allowed: snapshot.permissions.canPublish,
                          },
                        ].map((item) => (
                          <div
                            className="flex flex-wrap justify-between gap-2 text-sm"
                            key={item.label}
                          >
                            <dt className="text-stone-600">{item.label}</dt>
                            <dd className="font-medium">
                              {item.allowed ? text.allowed : text.notAllowed}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  </div>
                ) : null}
              </div>
              </div>
              </div>
            </>
          )}
        </>
      ) : null}
    </section>
  );
}
