"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LanguageCode } from "@/lib/i18n";
import { csrfFetch } from "@/lib/security/csrf-client";
import type {
  PropertyExportAvailability,
  PropertyExportJobView,
  PropertyPublicationStatus,
} from "@/lib/property-export/types";

export type PropertyExportPanelProps = Readonly<{
  canExport: boolean;
  language: LanguageCode;
  propertyId: string;
  propertyTitle: string;
  workspaceId?: string | null;
}>;

type ExportListResponse = {
  availability?: PropertyExportAvailability;
  data?: { jobs?: PropertyExportLifecycleJobView[] };
  error?: string;
};

type ExportMutationResponse = {
  error?: string;
  job?: PropertyExportLifecycleJobView;
  preflight?: { blockers?: string[] };
};

type PropertyExportLifecycleAction = "mark_update_required" | "pause" | "resume" | "withdraw";

type PropertyExportLifecycleJobView = PropertyExportJobView & Readonly<{
  channelStatus?: PropertyPublicationStatus;
  channelUpdatedAt?: string;
  scheduledAt?: string | null;
}>;

type ScheduleValidation =
  | { ok: true; scheduledAt: string | null }
  | { ok: false; reason: "invalid" | "past" | "too_far" };

const MAX_SCHEDULE_AHEAD_MS = 90 * 24 * 60 * 60 * 1_000;

const copy = {
  de: {
    attempts: "Versuche",
    availableAt: "Verarbeitbar ab",
    blocked: "Der serverseitige Export-Preflight ist blockiert.",
    channelStatus: "Lokaler Kanalstatus",
    create: "QA-Testexport erstellen",
    controlledRepublish: "Erneute QA-Ausgabe immer als neuen Testexport mit erneutem Preflight starten. Es erfolgt keine stille Wiederveröffentlichung.",
    disabled: "Für diesen Benutzer fehlen Exportrechte.",
    download: "Geschützte XML-Vorschau laden",
    empty: "Noch kein QA-Testexport für dieses Objekt.",
    external: "Echte Immobilienportale",
    externalDetail: "Nicht konfiguriert · Launch-OFF",
    hash: "SHA-256",
    history: "Exportverlauf",
    loading: "Exportverlauf wird geladen …",
    notCertified: "Preview-QA-Sink · kein Portalversand · nicht XSD-zertifiziert",
    pause: "Lokal pausieren",
    refresh: "Aktualisieren",
    resume: "Lokale Verarbeitung fortsetzen",
    retry: "Erneut versuchen",
    scheduleHelp: "Leer lassen für sofortige Verarbeitung. Die Gerätezeit wird als ISO-Zeitpunkt übertragen; maximal 90 Tage im Voraus.",
    scheduleInvalid: "Bitte einen gültigen lokalen Zeitpunkt eingeben.",
    scheduleLabel: "QA-Verarbeitung planen (optional)",
    schedulePast: "Der geplante Zeitpunkt muss in der Zukunft liegen.",
    scheduleTooFar: "Der geplante Zeitpunkt darf höchstens 90 Tage in der Zukunft liegen.",
    scheduledFor: "Geplant für",
    sinkDisabled: "Der Preview-QA-Sink ist in dieser Laufzeit nicht freigeschaltet.",
    title: "OpenImmo-Testexport",
    transitionFailed: "Die lokale Statusänderung ist fehlgeschlagen.",
    transitionUnavailable: "Der Kanalstatus ist noch nicht vollständig geladen. Bitte aktualisieren.",
    updateRequired: "Aktualisierung markieren",
    withdraw: "Lokal zurückziehen",
  },
  en: {
    attempts: "Attempts",
    availableAt: "Eligible for processing from",
    blocked: "The server-side export preflight is blocked.",
    channelStatus: "Local channel status",
    create: "Create QA test export",
    controlledRepublish: "Always start another QA delivery as a new test export with a fresh preflight. No silent republishing occurs.",
    disabled: "This user does not have export rights.",
    download: "Download protected XML preview",
    empty: "No QA test export exists for this property yet.",
    external: "Real property portals",
    externalDetail: "Not configured · Launch-OFF",
    hash: "SHA-256",
    history: "Export history",
    loading: "Loading export history …",
    notCertified: "Preview QA sink · no portal delivery · not XSD certified",
    pause: "Pause locally",
    refresh: "Refresh",
    resume: "Resume local processing",
    retry: "Retry",
    scheduleHelp: "Leave blank to process immediately. Device-local time is sent as an ISO timestamp; up to 90 days ahead.",
    scheduleInvalid: "Enter a valid local date and time.",
    scheduleLabel: "Schedule QA processing (optional)",
    schedulePast: "The scheduled time must be in the future.",
    scheduleTooFar: "The scheduled time must be no more than 90 days in the future.",
    scheduledFor: "Scheduled for",
    sinkDisabled: "The Preview QA sink is not enabled in this runtime.",
    title: "OpenImmo test export",
    transitionFailed: "The local status change failed.",
    transitionUnavailable: "The channel status has not loaded completely. Refresh and try again.",
    updateRequired: "Mark update required",
    withdraw: "Withdraw locally",
  },
} as const;

const statusCopy = {
  de: {
    cancelled: "Abgebrochen",
    completed: "Testexport abgeschlossen",
    dead_letter: "Manuelle Prüfung nötig",
    failed: "Fehlgeschlagen",
    queued: "Eingereiht",
    retry: "Wiederholung geplant",
    running: "Wird verarbeitet",
  },
  en: {
    cancelled: "Cancelled",
    completed: "Test export completed",
    dead_letter: "Manual review required",
    failed: "Failed",
    queued: "Queued",
    retry: "Retry scheduled",
    running: "Processing",
  },
} as const;

const channelStatusCopy = {
  de: {
    draft: "Entwurf",
    exporting: "QA-Export wird erzeugt",
    failed: "QA-Export fehlgeschlagen",
    partially_published: "Externer Teilstatus (im QA-Sink nicht bestätigt)",
    paused: "QA-Verarbeitung pausiert",
    preflight_failed: "Preflight nicht bestanden",
    published: "Externer Status (im QA-Sink nicht bestätigt)",
    queued: "QA-Export eingereiht",
    ready: "QA-Artefakt lokal bereit",
    update_required: "QA-Aktualisierung erforderlich",
    withdrawn: "Lokal zurückgezogen · kein Portalaufruf",
  },
  en: {
    draft: "Draft",
    exporting: "Generating QA export",
    failed: "QA export failed",
    partially_published: "External partial status (not confirmed by QA sink)",
    paused: "QA processing paused",
    preflight_failed: "Preflight failed",
    published: "External status (not confirmed by QA sink)",
    queued: "QA export queued",
    ready: "QA artifact ready locally",
    update_required: "QA update required",
    withdrawn: "Withdrawn locally · no portal request",
  },
} as const;

const transitionSuccessCopy = {
  de: {
    mark_update_required: "Der QA-Kanal wurde lokal als aktualisierungsbedürftig markiert.",
    pause: "Die QA-Verarbeitung wurde lokal pausiert.",
    resume: "Die lokale QA-Verarbeitung wurde fortgesetzt.",
    withdraw: "Der QA-Job wurde nur lokal zurückgezogen; kein Immobilienportal wurde kontaktiert.",
  },
  en: {
    mark_update_required: "The QA channel was marked locally as requiring an update.",
    pause: "QA processing was paused locally.",
    resume: "Local QA processing was resumed.",
    withdraw: "The QA job was withdrawn locally; no property portal was contacted.",
  },
} as const;

function validateScheduledAtLocal(value: string, now = Date.now()): ScheduleValidation {
  const normalized = value.trim();
  if (!normalized) return { ok: true, scheduledAt: null };

  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(normalized);
  if (!match) return { ok: false, reason: "invalid" };

  const [, year, month, day, hour, minute] = match;
  const scheduledDate = new Date(normalized);
  if (
    !Number.isFinite(scheduledDate.getTime()) ||
    scheduledDate.getFullYear() !== Number(year) ||
    scheduledDate.getMonth() + 1 !== Number(month) ||
    scheduledDate.getDate() !== Number(day) ||
    scheduledDate.getHours() !== Number(hour) ||
    scheduledDate.getMinutes() !== Number(minute)
  ) {
    return { ok: false, reason: "invalid" };
  }

  const scheduledTime = scheduledDate.getTime();
  if (scheduledTime <= now) return { ok: false, reason: "past" };
  if (scheduledTime - now > MAX_SCHEDULE_AHEAD_MS) return { ok: false, reason: "too_far" };
  return { ok: true, scheduledAt: scheduledDate.toISOString() };
}

function formatTimestamp(value: string | null | undefined, language: LanguageCode) {
  if (!value) return "–";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "–";
  return new Intl.DateTimeFormat(language === "de" ? "de-AT" : "en-IE", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function eventStatusLabel(status: string, language: LanguageCode) {
  const jobStatuses = statusCopy[language] as Readonly<Record<string, string>>;
  const channelStatuses = channelStatusCopy[language] as Readonly<Record<string, string>>;
  return jobStatuses[status] ?? channelStatuses[status] ?? status;
}

function lifecycleActionsFor(job: PropertyExportLifecycleJobView): PropertyExportLifecycleAction[] {
  if (!job.channelStatus || !job.channelUpdatedAt) return [];
  const actions: PropertyExportLifecycleAction[] = [];
  if (["failed", "queued", "ready", "update_required"].includes(job.channelStatus)) actions.push("pause");
  if (job.channelStatus === "paused") actions.push("resume");
  if (
    job.status !== "running" &&
    ["failed", "paused", "queued", "ready", "update_required"].includes(job.channelStatus)
  ) {
    actions.push("withdraw");
  }
  if (job.channelStatus === "ready" && job.status === "completed") actions.push("mark_update_required");
  return actions;
}

function responseMessage(payload: ExportMutationResponse | ExportListResponse, fallback: string) {
  return typeof payload.error === "string" && payload.error.trim() ? payload.error : fallback;
}

async function fetchExportList(url: string, signal?: AbortSignal) {
  const response = await csrfFetch(url, { cache: "no-store", signal });
  const payload = await response.json().catch(() => ({})) as ExportListResponse;
  if (!response.ok) throw new Error(responseMessage(payload, "Property export history could not be loaded."));
  return payload;
}

export function PropertyExportPanel({
  canExport,
  language,
  propertyId,
  propertyTitle,
  workspaceId,
}: PropertyExportPanelProps) {
  const text = copy[language];
  const [availability, setAvailability] = useState<PropertyExportAvailability | null>(null);
  const [jobs, setJobs] = useState<PropertyExportLifecycleJobView[]>([]);
  const [loading, setLoading] = useState(canExport);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "error" | "success"; message: string } | null>(null);
  const [scheduledAtLocal, setScheduledAtLocal] = useState("");
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const pendingCreateRequest = useRef<{ key: string; signature: string } | null>(null);
  const pendingRetryRequests = useRef(new Map<string, string>());
  const pendingTransitionRequests = useRef(new Map<string, string>());
  const workspaceQuery = workspaceId ? `&workspaceId=${encodeURIComponent(workspaceId)}` : "";
  const listUrl = `/api/crm/property-exports?propertyId=${encodeURIComponent(propertyId)}${workspaceQuery}`;

  const loadJobs = useCallback(async (signal?: AbortSignal) => {
    if (!canExport) {
      return;
    }
    setLoading(true);
    try {
      const payload = await fetchExportList(listUrl, signal);
      setJobs(payload.data?.jobs ?? []);
      setAvailability(payload.availability ?? null);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setNotice({
        kind: "error",
        message: error instanceof Error ? error.message : "Property export history could not be loaded.",
      });
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [canExport, listUrl]);

  useEffect(() => {
    if (!canExport) return;
    const controller = new AbortController();
    void fetchExportList(listUrl, controller.signal)
      .then((payload) => {
        setJobs(payload.data?.jobs ?? []);
        setAvailability(payload.availability ?? null);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setNotice({
          kind: "error",
          message: error instanceof Error ? error.message : "Property export history could not be loaded.",
        });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [canExport, listUrl]);

  async function createExport() {
    if (!canExport || busyJobId) return;
    const schedule = validateScheduledAtLocal(scheduledAtLocal);
    if (!schedule.ok) {
      const errorMessage = schedule.reason === "past"
        ? text.schedulePast
        : schedule.reason === "too_far"
          ? text.scheduleTooFar
          : text.scheduleInvalid;
      setScheduleError(errorMessage);
      setNotice({ kind: "error", message: errorMessage });
      return;
    }
    const requestBody = {
      language,
      propertyId,
      providerKey: "novalure_qa_sink",
      scheduledAt: schedule.scheduledAt,
    };
    const requestSignature = JSON.stringify({ ...requestBody, workspaceId: workspaceId ?? null });
    if (!pendingCreateRequest.current || pendingCreateRequest.current.signature !== requestSignature) {
      pendingCreateRequest.current = {
        key: `property-export-ui:${crypto.randomUUID()}`,
        signature: requestSignature,
      };
    }
    const idempotencyKey = pendingCreateRequest.current.key;
    setBusyJobId("create");
    setNotice(null);
    try {
      const response = await csrfFetch(`/api/crm/property-exports${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ""}`, {
        body: JSON.stringify(requestBody),
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        method: "POST",
      });
      const payload = await response.json().catch(() => ({})) as ExportMutationResponse;
      if (!response.ok) {
        if (response.status < 500) pendingCreateRequest.current = null;
        const blockers = payload.preflight?.blockers?.join(", ");
        throw new Error(blockers ? `${text.blocked} ${blockers}` : responseMessage(payload, text.sinkDisabled));
      }
      pendingCreateRequest.current = null;
      setScheduledAtLocal("");
      setScheduleError(null);
      setNotice({
        kind: "success",
        message: statusCopy[language][payload.job?.status ?? "queued"],
      });
      await loadJobs();
    } catch (error) {
      setNotice({ kind: "error", message: error instanceof Error ? error.message : text.sinkDisabled });
    } finally {
      setBusyJobId(null);
    }
  }

  async function transitionExport(
    job: PropertyExportLifecycleJobView,
    action: PropertyExportLifecycleAction,
  ) {
    if (!canExport || busyJobId) return;
    if (!job.channelStatus || !job.channelUpdatedAt) {
      setNotice({ kind: "error", message: text.transitionUnavailable });
      return;
    }

    const signature = JSON.stringify({
      action,
      channelStatus: job.channelStatus,
      channelUpdatedAt: job.channelUpdatedAt,
      jobId: job.id,
      workspaceId: workspaceId ?? null,
    });
    const idempotencyKey = pendingTransitionRequests.current.get(signature) ??
      `property-export-transition-ui:${crypto.randomUUID()}`;
    pendingTransitionRequests.current.set(signature, idempotencyKey);
    const busyKey = `transition:${job.id}:${action}`;
    setBusyJobId(busyKey);
    setNotice(null);

    try {
      const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
      const response = await csrfFetch(`/api/crm/property-exports${query}`, {
        body: JSON.stringify({
          action,
          expectedChannelStatus: job.channelStatus,
          expectedChannelUpdatedAt: job.channelUpdatedAt,
          jobId: job.id,
        }),
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        method: "PATCH",
      });
      const payload = await response.json().catch(() => ({})) as ExportMutationResponse;
      if (!response.ok) {
        if (response.status < 500) pendingTransitionRequests.current.delete(signature);
        throw new Error(responseMessage(payload, text.transitionFailed));
      }
      pendingTransitionRequests.current.delete(signature);
      setNotice({ kind: "success", message: transitionSuccessCopy[language][action] });
      await loadJobs();
    } catch (error) {
      setNotice({
        kind: "error",
        message: error instanceof Error ? error.message : text.transitionFailed,
      });
    } finally {
      setBusyJobId(null);
    }
  }

  async function retryExport(jobId: string) {
    if (!canExport || busyJobId) return;
    const idempotencyKey = pendingRetryRequests.current.get(jobId) ??
      `property-export-retry-ui:${crypto.randomUUID()}`;
    pendingRetryRequests.current.set(jobId, idempotencyKey);
    setBusyJobId(jobId);
    setNotice(null);
    try {
      const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
      const response = await csrfFetch(`/api/crm/property-exports/${encodeURIComponent(jobId)}/retry${query}`, {
        headers: { "Idempotency-Key": idempotencyKey },
        method: "POST",
      });
      const payload = await response.json().catch(() => ({})) as ExportMutationResponse;
      if (!response.ok) {
        if (response.status < 500) pendingRetryRequests.current.delete(jobId);
        throw new Error(responseMessage(payload, "Property export retry failed."));
      }
      pendingRetryRequests.current.delete(jobId);
      setNotice({
        kind: "success",
        message: statusCopy[language][payload.job?.status ?? "retry"],
      });
      await loadJobs();
    } catch (error) {
      setNotice({ kind: "error", message: error instanceof Error ? error.message : "Property export retry failed." });
    } finally {
      setBusyJobId(null);
    }
  }

  return (
    <section aria-labelledby="property-export-title" className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-slate-950" id="property-export-title">{text.title}</h3>
          <p className="mt-1 text-sm text-stone-600">{propertyTitle}</p>
          <p className="mt-1 text-xs font-medium text-amber-800">{text.notCertified}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            className="min-h-11 rounded-md border border-stone-300 px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={loading || Boolean(busyJobId)}
            onClick={() => void loadJobs()}
            type="button"
          >
            {text.refresh}
          </button>
          <button
            className="min-h-11 rounded-md bg-slate-950 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!canExport || Boolean(busyJobId) || availability?.qaSink.state !== "ready"}
            onClick={() => void createExport()}
            title={!canExport ? text.disabled : availability?.qaSink.state !== "ready" ? text.sinkDisabled : undefined}
            type="button"
          >
            {busyJobId === "create" ? "…" : text.create}
          </button>
        </div>
      </div>

      <div aria-live="polite" className="mt-3 min-h-5 text-sm">
        {notice ? (
          <p className={notice.kind === "error" ? "text-red-700" : "text-emerald-700"}>{notice.message}</p>
        ) : null}
      </div>

      <div className="mt-3 rounded-lg border border-stone-200 bg-stone-50 p-3">
        <label className="block text-sm font-semibold text-slate-900" htmlFor={`property-export-schedule-${propertyId}`}>
          {text.scheduleLabel}
        </label>
        <input
          aria-describedby={`property-export-schedule-help-${propertyId}${scheduleError ? ` property-export-schedule-error-${propertyId}` : ""}`}
          aria-invalid={Boolean(scheduleError)}
          className="mt-2 min-h-11 w-full max-w-sm rounded-md border border-stone-300 bg-white px-3 py-2 text-sm text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!canExport || Boolean(busyJobId)}
          id={`property-export-schedule-${propertyId}`}
          onBlur={() => {
            const result = validateScheduledAtLocal(scheduledAtLocal);
            if (result.ok) {
              setScheduleError(null);
              return;
            }
            setScheduleError(
              result.reason === "past"
                ? text.schedulePast
                : result.reason === "too_far"
                  ? text.scheduleTooFar
                  : text.scheduleInvalid,
            );
          }}
          onChange={(event) => {
            setScheduledAtLocal(event.target.value);
            setScheduleError(null);
          }}
          step={60}
          type="datetime-local"
          value={scheduledAtLocal}
        />
        <p className="mt-1 text-xs text-stone-600" id={`property-export-schedule-help-${propertyId}`}>
          {text.scheduleHelp}
        </p>
        {scheduleError ? (
          <p className="mt-1 text-sm text-red-700" id={`property-export-schedule-error-${propertyId}`}>
            {scheduleError}
          </p>
        ) : null}
        <p className="mt-2 text-xs font-medium text-amber-800">{text.controlledRepublish}</p>
      </div>

      <div className="mt-3 rounded-lg bg-stone-50 p-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">{text.external}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {(availability?.externalPortals ?? []).map((portal) => (
            <span className="rounded-full border border-stone-200 bg-white px-2.5 py-1 text-xs text-stone-700" key={portal.key}>
              {portal.label}: {text.externalDetail}
            </span>
          ))}
        </div>
      </div>

      <h4 className="mt-5 text-sm font-semibold text-slate-900">{text.history}</h4>
      {loading ? <p className="mt-2 text-sm text-stone-600">{text.loading}</p> : null}
      {!loading && jobs.length === 0 ? <p className="mt-2 text-sm text-stone-600">{text.empty}</p> : null}
      <ol className="mt-2 space-y-3">
        {jobs.map((job) => {
          const mayRetry = job.channelStatus === "failed" &&
            (job.status === "failed" || job.status === "dead_letter");
          const lifecycleActions = lifecycleActionsFor(job);
          const payloadQuery = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
          return (
            <li className="rounded-lg border border-stone-200 p-3" key={job.id}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-slate-900">{statusCopy[language][job.status]}</p>
                  <p className="mt-1 text-xs text-stone-500">
                    {formatTimestamp(job.createdAt, language)}
                    {` · ${text.attempts}: ${job.attemptCount}/${job.maxAttempts}`}
                  </p>
                  <p className="mt-1 text-xs font-medium text-slate-700">
                    {text.channelStatus}: {job.channelStatus
                      ? channelStatusCopy[language][job.channelStatus]
                      : "–"}
                  </p>
                  {job.scheduledAt ? (
                    <p className="mt-1 text-xs text-stone-600">
                      {text.scheduledFor}: {formatTimestamp(job.scheduledAt, language)}
                    </p>
                  ) : null}
                  <p className="mt-1 text-xs text-stone-600">
                    {text.availableAt}: {formatTimestamp(job.availableAt, language)}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {job.status === "completed" && job.artifactFilename ? (
                    <a
                      className="inline-flex min-h-11 items-center rounded-md border border-stone-300 px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-stone-50"
                      href={`/api/crm/property-exports/${encodeURIComponent(job.id)}/payload${payloadQuery}`}
                    >
                      {text.download}
                    </a>
                  ) : null}
                  {mayRetry ? (
                    <button
                      className="min-h-11 rounded-md border border-stone-300 px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={!canExport || Boolean(busyJobId)}
                      onClick={() => void retryExport(job.id)}
                      type="button"
                    >
                      {busyJobId === job.id ? "…" : text.retry}
                    </button>
                  ) : null}
                  {lifecycleActions.map((action) => {
                    const busyKey = `transition:${job.id}:${action}`;
                    const label = action === "pause"
                      ? text.pause
                      : action === "resume"
                        ? text.resume
                        : action === "withdraw"
                          ? text.withdraw
                          : text.updateRequired;
                    return (
                      <button
                        className="min-h-11 rounded-md border border-stone-300 px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={!canExport || Boolean(busyJobId)}
                        key={action}
                        onClick={() => void transitionExport(job, action)}
                        type="button"
                      >
                        {busyJobId === busyKey ? "…" : label}
                      </button>
                    );
                  })}
                </div>
              </div>
              {job.payloadSha256 ? (
                <p className="mt-2 break-all font-mono text-[11px] text-stone-500">{text.hash}: {job.payloadSha256}</p>
              ) : null}
              {job.lastErrorMessage ? <p className="mt-2 text-sm text-red-700">{job.lastErrorMessage}</p> : null}
              {job.events.length ? (
                <details className="mt-2 text-xs text-stone-600">
                  <summary className="flex min-h-11 cursor-pointer items-center font-semibold">{text.history} ({job.events.length})</summary>
                  <ol className="mt-2 space-y-1 border-l border-stone-200 pl-3">
                    {job.events.map((event) => (
                      <li key={event.id}>
                        <span className="font-medium text-stone-800">{event.eventType}</span>
                        {` · ${eventStatusLabel(event.toStatus, language)}`}
                      </li>
                    ))}
                  </ol>
                </details>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
