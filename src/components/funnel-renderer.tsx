"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getDeviceValue,
  type FunnelDevice,
  type FunnelRenderMode,
} from "@/lib/funnel-schema";
import type {
  PublicFunnelDto,
  PublicFunnelElement,
  PublicFunnelField,
  PublicFunnelPage,
  PublicFunnelRule,
  PublicFunnelRuleGroup,
} from "@/lib/funnel-public-dto";
import { toSafeFunnelText } from "@/lib/funnel-safe-content";
import {
  buildFunnelSubmissionRequest,
  clearFunnelSubmissionIntentId,
  getOrCreateFunnelSubmissionIntentId,
} from "@/lib/funnel-submission-request";
import {
  getOrCreatePublicFunnelVisitId,
  isFunnelPublicationStaleResponse,
} from "@/lib/funnel-runtime-contract";
import { getFunnelRendererCopy, type LanguageCode } from "@/lib/i18n";
import {
  parsePublicSubmissionProof,
  publicSubmissionControlFields,
  publicSubmissionProofRefreshLeadSeconds,
  type PublicSubmissionProof,
} from "@/lib/public-submission-contract";
import { csrfFetch } from "@/lib/security/csrf-client";

type FunnelRendererProps = {
  blueprint: PublicFunnelDto;
  device?: FunnelDevice;
  language?: LanguageCode;
  mode?: FunnelRenderMode;
  onEvent?: (event: { label: string; detail: string; status: string }) => void;
  publicationRevision?: number;
  submissionProof?: PublicSubmissionProof;
  visitTrackingEnabled?: boolean;
};

type FieldValue = string | string[] | boolean | number | null;
type FunnelRendererText = ReturnType<typeof getFunnelRendererCopy>;

const deviceWidths: Record<FunnelDevice, string> = {
  desktop: "max-w-5xl",
  tablet: "max-w-3xl",
  mobile: "max-w-[390px]",
};

function fieldInitialValue(field: PublicFunnelField): FieldValue {
  if (field.type === "multiChoice") return [];
  if (field.type === "consent") return false;
  if (field.type === "number" || field.type === "slider" || field.type === "rating") return field.defaultValue ? Number(field.defaultValue) : null;
  return field.defaultValue ?? "";
}

function collectFields(blueprint: PublicFunnelDto) {
  return blueprint.pages.flatMap((page) =>
    page.sections.flatMap((section) =>
      section.rows.flatMap((row) =>
        row.columns.flatMap((column) =>
          column.elements.flatMap((element) => element.fields ?? []),
        ),
      ),
    ),
  );
}

function buildInitialAnswers(blueprint: PublicFunnelDto) {
  return Object.fromEntries(collectFields(blueprint).map((field) => [field.id, fieldInitialValue(field)]));
}

function buildAnswerLookup(fields: PublicFunnelField[], answers: Record<string, FieldValue>) {
  const lookup = new Map<string, FieldValue>();

  fields.forEach((field) => {
    const value = answers[field.id];
    lookup.set(field.id, value);
    lookup.set(field.label, value);
    lookup.set(field.label.toLowerCase(), value);
  });

  return lookup;
}

function stringifyAnswer(value: FieldValue) {
  if (Array.isArray(value)) return value.join(", ");
  if (value === true) return "Ja";
  if (value === false || value === null || value === undefined) return "";
  return String(value);
}

function resolveTokens(value: string | undefined, fields: PublicFunnelField[], answers: Record<string, FieldValue>) {
  if (!value) return value;
  const lookup = buildAnswerLookup(fields, answers);

  return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, token: string) => stringifyAnswer(lookup.get(token) ?? lookup.get(token.toLowerCase()) ?? ""));
}

function compareRule(rule: PublicFunnelRule, lookup: Map<string, FieldValue>) {
  const value = lookup.get(rule.field) ?? lookup.get(rule.field.toLowerCase());
  const expected = rule.value;
  const valueText = Array.isArray(value) ? value.join(" ") : String(value ?? "");
  const expectedText = String(expected ?? "");

  if (rule.operator === "exists") return value !== null && value !== "" && value !== false && value !== undefined;
  if (rule.operator === "equals") return valueText === expectedText;
  if (rule.operator === "notEquals") return valueText !== expectedText;
  if (rule.operator === "contains") return valueText.toLowerCase().includes(expectedText.toLowerCase());
  if (rule.operator === "greaterThan") return Number(value) > Number(expected);
  if (rule.operator === "lessThan") return Number(value) < Number(expected);
  return true;
}

function evaluateRuleGroup(group: PublicFunnelRuleGroup | undefined, fields: PublicFunnelField[], answers: Record<string, FieldValue>): boolean {
  if (!group) return true;
  const lookup = buildAnswerLookup(fields, answers);
  const results = group.rules.map((rule) =>
    "rules" in rule ? evaluateRuleGroup(rule, fields, answers) : compareRule(rule, lookup),
  );

  return group.mode === "or" ? results.some(Boolean) : results.every(Boolean);
}

function elementCanRender(element: PublicFunnelElement, device: FunnelDevice, fields: PublicFunnelField[], answers: Record<string, FieldValue>) {
  return isVisible(element, device) && evaluateRuleGroup(element.condition, fields, answers);
}

function pageHasVisibleContent(page: PublicFunnelPage, device: FunnelDevice, fields: PublicFunnelField[], answers: Record<string, FieldValue>) {
  return page.sections.some((section) =>
    section.rows.some((row) =>
      row.columns.some((column) => column.elements.some((element) => elementCanRender(element, device, fields, answers))),
    ),
  );
}

function validateField(field: PublicFunnelField, value: FieldValue, text: FunnelRendererText) {
  if (!field.required) return null;
  if (field.type === "consent" && value !== true) return field.errorMessage ?? text.requiredError;
  if (Array.isArray(value) && value.length === 0) return field.errorMessage ?? text.choiceRequiredError;
  if (value === null || value === "" || value === false) return field.errorMessage ?? text.requiredError;
  if (field.validationPattern && typeof value === "string") {
    try {
      if (!new RegExp(field.validationPattern).test(value)) return field.errorMessage ?? text.invalidError;
    } catch {
      return null;
    }
  }
  return null;
}

function buildConsentPayload(fields: PublicFunnelField[], answers: Record<string, FieldValue>) {
  const consentFields = fields.filter((field) => field.type === "consent");
  let analytics = false;
  let marketing = false;
  let privacy = false;

  consentFields.forEach((field) => {
    if (answers[field.id] !== true) return;
    analytics = analytics || field.consentCategories?.analytics === true;
    marketing = marketing || field.consentCategories?.marketing === true;
    privacy = privacy || field.consentCategories?.privacy === true;
  });

  return { analytics, marketing, privacy };
}

function readUtmParams() {
  if (typeof window === "undefined") return {};
  const params = new URLSearchParams(window.location.search);
  const entries = Array.from(params.entries()).filter(([key]) => key.startsWith("utm_") || key === "gclid" || key === "fbclid");

  return Object.fromEntries(entries);
}

function isVisible(element: PublicFunnelElement, device: FunnelDevice) {
  return element.visibility?.[device] ?? true;
}

function RichContent({ className, value }: { className?: string; value?: string }) {
  return <span className={`whitespace-pre-line ${className ?? ""}`.trim()}>{toSafeFunnelText(value)}</span>;
}

function FieldControl({
  copy,
  field,
  value,
  error,
  onChange,
}: {
  copy: FunnelRendererText;
  field: PublicFunnelField;
  value: FieldValue;
  error?: string;
  onChange: (value: FieldValue) => void;
}) {
  if (field.type === "hidden") return null;

  const baseClass = "w-full min-w-0 rounded-md border border-stone-300 bg-white px-3 py-2 text-sm text-slate-950 outline-none focus:border-emerald-700";
  const label = (
      <span className="flex min-w-0 items-center justify-between gap-3">
      <span className="min-w-0 break-words">{field.label}</span>
      {field.required ? <span className="shrink-0 text-xs font-semibold text-emerald-700">{copy.required}</span> : null}
    </span>
  );

  if (field.type === "textarea") {
    return (
      <label className="grid min-w-0 gap-1 text-sm font-semibold">
        {label}
        <textarea className={`${baseClass} min-h-24 resize-y`} placeholder={field.placeholder} value={String(value ?? "")} onChange={(event) => onChange(event.target.value)} />
        {field.helpText ? <span className="break-words text-xs font-medium text-stone-500">{field.helpText}</span> : null}
        {error ? <span className="break-words text-xs font-semibold text-red-700">{error}</span> : null}
      </label>
    );
  }

  if (field.type === "singleChoice") {
    return (
      <fieldset className="grid min-w-0 gap-2 text-sm font-semibold">
        <legend>{label}</legend>
        <div className="grid min-w-0 gap-2 sm:grid-cols-2">
          {(field.options ?? []).map((option) => (
            <label className="flex min-w-0 items-center gap-2 rounded-md border border-stone-200 bg-stone-50 px-3 py-2" key={option}>
              <input checked={value === option} name={field.id} onChange={() => onChange(option)} type="radio" />
              <span className="min-w-0 break-words">{option}</span>
            </label>
          ))}
        </div>
        {error ? <span className="break-words text-xs font-semibold text-red-700">{error}</span> : null}
      </fieldset>
    );
  }

  if (field.type === "multiChoice") {
    const selected = Array.isArray(value) ? value : [];
    return (
      <fieldset className="grid min-w-0 gap-2 text-sm font-semibold">
        <legend>{label}</legend>
        <div className="grid min-w-0 gap-2 sm:grid-cols-2">
          {(field.options ?? []).map((option) => (
            <label className="flex min-w-0 items-center gap-2 rounded-md border border-stone-200 bg-stone-50 px-3 py-2" key={option}>
              <input
                checked={selected.includes(option)}
                onChange={(event) =>
                  onChange(event.target.checked ? [...selected, option] : selected.filter((item) => item !== option))
                }
                type="checkbox"
              />
              <span className="min-w-0 break-words">{option}</span>
            </label>
          ))}
        </div>
        {error ? <span className="break-words text-xs font-semibold text-red-700">{error}</span> : null}
      </fieldset>
    );
  }

  if (field.type === "dropdown") {
    return (
      <label className="grid min-w-0 gap-1 text-sm font-semibold">
        {label}
        <select className={baseClass} value={String(value ?? "")} onChange={(event) => onChange(event.target.value)}>
          <option value="">{copy.choose}</option>
          {(field.options ?? []).map((option) => <option key={option}>{option}</option>)}
        </select>
        {error ? <span className="break-words text-xs font-semibold text-red-700">{error}</span> : null}
      </label>
    );
  }

  if (field.type === "consent") {
    return (
      <label className="flex min-w-0 items-start gap-2 rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-sm font-semibold">
        <input checked={value === true} className="mt-1 shrink-0" onChange={(event) => onChange(event.target.checked)} type="checkbox" />
        <span className="min-w-0 break-words">{field.label}</span>
        {error ? <span className="break-words text-xs font-semibold text-red-700">{error}</span> : null}
      </label>
    );
  }

  if (field.type === "slider") {
    return (
      <label className="grid min-w-0 gap-2 text-sm font-semibold">
        {label}
        <input
          className="w-full"
          max={field.max ?? 100}
          min={field.min ?? 0}
          onChange={(event) => onChange(Number(event.target.value))}
          step={field.step ?? 1}
          type="range"
          value={typeof value === "number" ? value : field.min ?? 0}
        />
        <span className="text-xs font-semibold text-stone-500">{String(value ?? field.min ?? 0)}</span>
        {error ? <span className="break-words text-xs font-semibold text-red-700">{error}</span> : null}
      </label>
    );
  }

  const inputType =
    field.type === "email" || field.type === "url" || field.type === "number" || field.type === "date" || field.type === "time"
      ? field.type
      : field.type === "phone"
        ? "tel"
        : "text";

  return (
    <label className="grid min-w-0 gap-1 text-sm font-semibold">
      {label}
      <input
        className={baseClass}
        max={field.max}
        min={field.min}
        placeholder={field.placeholder}
        type={inputType}
        value={String(value ?? "")}
        onChange={(event) => onChange(field.type === "number" ? Number(event.target.value) : event.target.value)}
      />
      {field.helpText ? <span className="break-words text-xs font-medium text-stone-500">{field.helpText}</span> : null}
      {error ? <span className="break-words text-xs font-semibold text-red-700">{error}</span> : null}
    </label>
  );
}

export function FunnelRenderer({
  blueprint,
  device = "mobile",
  language = "en",
  mode = "preview",
  onEvent,
  publicationRevision,
  submissionProof,
  visitTrackingEnabled = false,
}: FunnelRendererProps) {
  const text = getFunnelRendererCopy(language);
  const safeHtmlNotice = language === "de"
    ? "Gespeichertes HTML wird aus Sicherheitsgründen nur als Klartext angezeigt; Code und Links werden nicht ausgeführt."
    : "Stored HTML is shown as plain text for safety; code and links do not execute.";
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, FieldValue>>(() => buildInitialAnswers(blueprint));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [honeypot, setHoneypot] = useState("");
  const [activeSubmissionProof, setActiveSubmissionProof] = useState(submissionProof);
  const [reloadRequired, setReloadRequired] = useState(false);
  const [runtimeError, setRuntimeError] = useState("");
  const [submitState, setSubmitState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const proofRefreshPromiseRef = useRef<Promise<PublicSubmissionProof> | null>(null);
  const submissionProofRef = useRef<PublicSubmissionProof | undefined>(submissionProof);
  const visitRecordedRef = useRef<string | null>(null);
  const pages = blueprint.pages;
  const page = pages[Math.min(currentPageIndex, pages.length - 1)];
  const allFields = useMemo(() => collectFields(blueprint), [blueprint]);
  const runtimeConsent = useMemo(() => buildConsentPayload(allFields, answers), [allFields, answers]);
  const accent = blueprint.theme.colors.accent;
  const spacing = getDeviceValue(blueprint.theme.spacing, device, 16);
  const proofRefreshFailedCopy = language === "de"
    ? "Die sichere Sitzung konnte nicht erneuert werden. Bitte laden Sie die Seite neu."
    : "The secure session could not be renewed. Please reload the page.";
  const publicationStaleCopy = language === "de"
    ? "Dieser Funnel wurde inzwischen aktualisiert. Bitte laden Sie die Seite neu, bevor Sie fortfahren."
    : "This funnel has been updated. Please reload the page before continuing.";

  const markPublicationStale = useCallback(() => {
    setReloadRequired(true);
    setRuntimeError(publicationStaleCopy);
  }, [publicationStaleCopy]);

  const installSubmissionProof = useCallback((proof: PublicSubmissionProof) => {
    submissionProofRef.current = proof;
    setActiveSubmissionProof(proof);
    setRuntimeError("");
  }, []);

  const refreshSubmissionProof = useCallback(async () => {
    const currentProof = submissionProofRef.current;
    if (
      mode !== "live" ||
      !currentProof ||
      !Number.isSafeInteger(publicationRevision) ||
      Number(publicationRevision) < 0
    ) {
      throw new Error("submission_proof_missing");
    }
    if (proofRefreshPromiseRef.current) return proofRefreshPromiseRef.current;

    const refreshPromise = (async () => {
      const response = await fetch(
        `/api/funnels/${encodeURIComponent(blueprint.id)}/submission-proof`,
        {
          body: JSON.stringify({ proof: currentProof, publicationRevision }),
          cache: "no-store",
          credentials: "omit",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          method: "POST",
          referrerPolicy: "no-referrer",
        },
      );
      const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (isFunnelPublicationStaleResponse(payload)) {
        markPublicationStale();
        throw new Error("funnel_publication_stale");
      }
      const proof = parsePublicSubmissionProof(payload?.proof);
      if (
        !response.ok ||
        !proof ||
        proof.idempotencyKey !== currentProof.idempotencyKey ||
        payload?.publicationRevision !== publicationRevision
      ) {
        throw new Error("submission_proof_refresh_failed");
      }
      installSubmissionProof(proof);
      return proof;
    })();

    proofRefreshPromiseRef.current = refreshPromise;
    try {
      return await refreshPromise;
    } finally {
      if (proofRefreshPromiseRef.current === refreshPromise) {
        proofRefreshPromiseRef.current = null;
      }
    }
  }, [blueprint.id, installSubmissionProof, markPublicationStale, mode, publicationRevision]);

  useEffect(() => {
    if (mode !== "live" || reloadRequired || !activeSubmissionProof) return;
    const refreshAt =
      (activeSubmissionProof.expiresAt - publicSubmissionProofRefreshLeadSeconds) * 1_000;
    const delay = Math.max(0, Math.min(2_147_483_647, refreshAt - Date.now()));
    const timer = window.setTimeout(() => {
      void refreshSubmissionProof().catch((error: unknown) => {
        if (!(error instanceof Error) || error.message !== "funnel_publication_stale") {
          setRuntimeError(proofRefreshFailedCopy);
        }
      });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [activeSubmissionProof, mode, proofRefreshFailedCopy, refreshSubmissionProof, reloadRequired]);

  useEffect(() => {
    if (
      mode !== "live" ||
      !visitTrackingEnabled ||
      !runtimeConsent.analytics ||
      reloadRequired ||
      !activeSubmissionProof ||
      !Number.isSafeInteger(publicationRevision) ||
      Number(publicationRevision) < 0
    ) {
      return;
    }
    const visitKey = `${blueprint.id}:publication:${publicationRevision}`;
    if (visitRecordedRef.current === visitKey) return;
    const visitId = getOrCreatePublicFunnelVisitId(blueprint.id, Number(publicationRevision));
    let cancelled = false;

    const sendVisit = async (proof: PublicSubmissionProof, allowExpiredRefresh: boolean): Promise<void> => {
      const response = await fetch(`/api/funnels/${encodeURIComponent(blueprint.id)}/visits`, {
        body: JSON.stringify({ proof, publicationRevision, visitId }),
        cache: "no-store",
        credentials: "omit",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        method: "POST",
        referrerPolicy: "no-referrer",
      });
      const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (isFunnelPublicationStaleResponse(payload)) {
        if (!cancelled) markPublicationStale();
        return;
      }
      if (
        !response.ok &&
        allowExpiredRefresh &&
        payload?.error === "submission_proof_expired"
      ) {
        const refreshedProof = await refreshSubmissionProof();
        return sendVisit(refreshedProof, false);
      }
      if (response.ok && payload?.ok === true && !cancelled) {
        visitRecordedRef.current = visitKey;
      }
    };

    void sendVisit(activeSubmissionProof, true).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [
    activeSubmissionProof,
    blueprint.id,
    markPublicationStale,
    mode,
    publicationRevision,
    refreshSubmissionProof,
    reloadRequired,
    runtimeConsent.analytics,
    visitTrackingEnabled,
  ]);

  useEffect(() => {
    if (!blueprint.tracking.clientAnalyticsEnabled || !runtimeConsent.analytics) return;
    const win = window as typeof window & { dataLayer?: Array<Record<string, unknown>>; fbq?: (...args: unknown[]) => void };
    win.dataLayer = win.dataLayer ?? [];
    win.dataLayer.push({ event: "funnel_renderer_loaded", funnelId: blueprint.id });
    if (blueprint.tracking.metaPixelEnabled && typeof win.fbq === "function") {
      win.fbq("track", "PageView", { funnel_id: blueprint.id });
    }
  }, [blueprint.id, blueprint.tracking.clientAnalyticsEnabled, blueprint.tracking.metaPixelEnabled, runtimeConsent.analytics]);

  function emit(label: string, detail: string, status: string = mode) {
    onEvent?.({ label, detail, status });
  }

  function withRuntimeHiddenAnswers(current: Record<string, FieldValue>) {
    if (typeof window === "undefined") return current;
    const params = new URLSearchParams(window.location.search);
    const next = { ...current };

    allFields.forEach((field) => {
      if (field.type !== "hidden") return;
      let value = field.defaultValue ?? "";
      if (field.hiddenValueSource === "utm" && field.publicQueryParameter) {
        value = params.get(field.publicQueryParameter)
          ?? params.get(`utm_${field.publicQueryParameter.replace(/^utm_/, "")}`)
          ?? value;
      }
      if (field.hiddenValueSource === "urlParam" && field.publicQueryParameter) {
        value = params.get(field.publicQueryParameter) ?? value;
      }
      if (field.captureSourceUrl) value = window.location.href;
      if (value) {
        next[field.id] = value;
      }
    });

    return next;
  }

  function setFieldValue(field: PublicFunnelField, value: FieldValue) {
    setAnswers((current) => ({ ...current, [field.id]: value }));
    setErrors((current) => {
      const next = { ...current };
      delete next[field.id];
      return next;
    });
  }

  function goToNext(nextAnswers = answers) {
    const nextIndex = pages.findIndex((candidate, index) =>
      index > currentPageIndex && pageHasVisibleContent(candidate, device, allFields, nextAnswers),
    );
    setCurrentPageIndex(nextIndex >= 0 ? nextIndex : Math.min(currentPageIndex + 1, pages.length - 1));
  }

  async function submit(testOnly = mode !== "live") {
    const runtimeAnswers = withRuntimeHiddenAnswers(answers);
    const nextErrors = Object.fromEntries(
      allFields
        .map((field) => [field.id, validateField(field, runtimeAnswers[field.id], text)] as const)
        .filter(([, error]) => Boolean(error)),
    ) as Record<string, string>;

    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      emit(text.validation, text.validationDetail, "error");
      return;
    }

    setSubmitState("sending");
    try {
      const consent = buildConsentPayload(allFields, runtimeAnswers);
      const apiFetch = testOnly ? csrfFetch : fetch;
      const submissionIntentId = testOnly ? undefined : getOrCreateFunnelSubmissionIntentId(blueprint.id);
      const utm = readUtmParams();
      const visitor = {
        id: typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("visitorId") ?? undefined : undefined,
        sourceUrl: typeof window !== "undefined" ? window.location.href : undefined,
        userAgent: typeof window !== "undefined" ? window.navigator.userAgent : undefined,
      };

      const sendAttempt = async (
        proof: PublicSubmissionProof | undefined,
        allowExpiredProofRetry: boolean,
      ): Promise<void> => {
        if (!testOnly && !proof) throw new Error("submission_proof_missing");
        const submissionRequest = buildFunnelSubmissionRequest({
          answers: runtimeAnswers,
          consent,
          funnelId: blueprint.id,
          honeypot,
          intentId: submissionIntentId,
          mode: testOnly ? "test" : "live",
          proof,
          utm,
          visitor,
        });
        const response = await apiFetch(submissionRequest.endpoint, submissionRequest.init);
        const responsePayload = await response.json().catch(() => null) as Record<string, unknown> | null;
        if (!testOnly && isFunnelPublicationStaleResponse(responsePayload)) {
          markPublicationStale();
          throw new Error("funnel_publication_stale");
        }
        if (response.ok) return;

        if (
          !testOnly &&
          allowExpiredProofRetry &&
          responsePayload?.error === "submission_proof_expired"
        ) {
          const refreshedProof = await refreshSubmissionProof();
          return sendAttempt(refreshedProof, false);
        }

        // A rotation between refresh and submit invalidates the old signature.
        // Refresh is used only to classify the current publication; unlike the
        // explicit expiry branch above, an invalid proof is never auto-retried.
        if (!testOnly && responsePayload?.error === "submission_proof_invalid") {
          await refreshSubmissionProof();
        }
        throw new Error("submission_failed");
      };

      await sendAttempt(testOnly ? undefined : submissionProofRef.current, true);
      if (!testOnly) clearFunnelSubmissionIntentId(blueprint.id);
      setSubmitState("sent");
      setRuntimeError("");
      emit(
        testOnly ? text.testLeadSent : text.leadSent,
        blueprint.name,
        testOnly ? "test" : "live",
      );
    } catch (error) {
      setSubmitState("error");
      if (!(error instanceof Error) || error.message !== "funnel_publication_stale") {
        setRuntimeError((current) => current || proofRefreshFailedCopy);
      }
      emit(text.submissionError, text.submissionErrorDetail, "error");
    }
  }

  function renderElement(element: PublicFunnelElement) {
    if (!elementCanRender(element, device, allFields, answers)) return null;

    if (element.type === "headline") {
      return <h1 className="break-words text-3xl font-semibold leading-tight text-slate-950 md:text-4xl"><RichContent value={resolveTokens(element.content, allFields, answers)} /></h1>;
    }

    if (element.type === "text" || element.type === "testimonial") {
      return (
        <div className="min-w-0 rounded-lg border border-stone-200 bg-stone-50 p-4" style={{ borderRadius: blueprint.theme.radii.block }}>
          <p className="break-words text-sm font-semibold text-slate-950">{element.name}</p>
          <p className="mt-2 break-words text-sm text-stone-700"><RichContent value={resolveTokens(element.content, allFields, answers)} /></p>
        </div>
      );
    }

    if (element.type === "image") {
      return element.url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img alt={element.alt ?? element.name} className="max-h-80 w-full rounded-lg object-cover" loading="lazy" referrerPolicy="no-referrer" src={element.url} />
      ) : (
        <div className="grid aspect-video min-w-0 place-items-center rounded-lg border border-dashed border-stone-300 bg-stone-50 p-4 text-center text-sm font-semibold text-stone-600">
          {text.imagePlaceholder}
        </div>
      );
    }

    if (element.type === "button") {
      return (
        <button
          className="w-full min-w-0 px-4 py-3 text-sm font-semibold text-white"
          onClick={() => {
            emit(text.funnelStarted, element.ctaLabel ?? "CTA", "preview");
            goToNext();
          }}
          style={{ backgroundColor: accent, borderRadius: blueprint.theme.radii.button }}
          type="button"
        >
          {element.ctaLabel ?? text.next}
        </button>
      );
    }

    if (element.type === "video") {
      return (
        <div className="grid aspect-video min-w-0 place-items-center rounded-lg border border-stone-200 bg-slate-950 p-4 text-center text-sm font-semibold text-white">
          {element.hasMedia ? text.videoEmbedded : text.videoPlaceholder}
        </div>
      );
    }

    if (element.type === "calendar") {
      const content = toSafeFunnelText(resolveTokens(element.content, allFields, answers)) || text.bookAppointment;
      return (
        <div className="min-w-0 rounded-lg border border-emerald-200 bg-emerald-50 p-4">
          <p className="whitespace-pre-line break-words text-sm font-semibold text-emerald-950">{content}</p>
          <button className="mt-3 w-full rounded-md border border-emerald-700 bg-white px-3 py-2 text-sm font-semibold text-emerald-900" type="button">
            {text.openCalendar}
          </button>
        </div>
      );
    }

    if (element.type === "html") {
      const content = toSafeFunnelText(resolveTokens(element.content, allFields, answers));
      return (
        <div className="min-w-0 overflow-auto rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
          <p className="font-semibold">{safeHtmlNotice}</p>
          <pre className="mt-3 whitespace-pre-wrap break-words font-mono text-xs text-slate-800">{content}</pre>
        </div>
      );
    }

    if (element.type === "choice") {
      return (
        <div className="grid min-w-0 gap-3">
          <p className="whitespace-pre-line break-words text-xl font-semibold text-slate-950">{toSafeFunnelText(resolveTokens(element.content, allFields, answers))}</p>
          <div className="grid min-w-0 gap-2">
            {(element.options ?? []).map((option) => (
              <button
                className="min-w-0 rounded-md border border-stone-200 bg-stone-50 p-3 text-left text-sm font-semibold hover:border-emerald-300 hover:bg-emerald-50"
                key={option}
                onClick={() => {
                  emit(text.answerSelected, `${element.name}: ${option}`, "preview");
                  const nextAnswers = { ...answers, [element.id]: option };
                  setAnswers(nextAnswers);
                  goToNext(nextAnswers);
                }}
                type="button"
              >
                <span className="block min-w-0 break-words">{option}</span>
              </button>
            ))}
          </div>
        </div>
      );
    }

    if (element.type === "form") {
      return (
        <form
          className="grid min-w-0 gap-4 rounded-lg border border-stone-200 bg-white p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(mode !== "live");
          }}
        >
          {mode === "live" ? (
            <input
              aria-hidden="true"
              autoComplete="off"
              className="pointer-events-none absolute -left-[10000px] h-px w-px opacity-0"
              name={publicSubmissionControlFields.honeypot}
              onChange={(event) => setHoneypot(event.target.value)}
              tabIndex={-1}
              value={honeypot}
            />
          ) : null}
          <div className="min-w-0">
            <p className="whitespace-pre-line break-words text-lg font-semibold text-slate-950">{toSafeFunnelText(resolveTokens(element.content ?? element.name, allFields, answers))}</p>
          </div>
          {(element.fields ?? []).map((field) => (
            <FieldControl
              copy={text}
              error={errors[field.id]}
              field={field}
              key={field.id}
              value={answers[field.id]}
              onChange={(value) => setFieldValue(field, value)}
            />
          ))}
          <button
            className="w-full rounded-md px-4 py-3 text-sm font-semibold text-white disabled:opacity-60"
            disabled={submitState === "sending" || reloadRequired}
            style={{ backgroundColor: accent, borderRadius: blueprint.theme.radii.button }}
            type="submit"
          >
            {submitState === "sending" ? text.checking : mode === "live" ? text.sendRequest : text.testLead}
          </button>
          {submitState === "sent" ? <p className="break-words text-sm font-semibold text-emerald-800">{text.processed}</p> : null}
          {submitState === "error" ? <p className="break-words text-sm font-semibold text-red-700">{text.failed}</p> : null}
        </form>
      );
    }

    return (
      <div className="min-w-0 rounded-lg border border-stone-200 bg-stone-50 p-4">
        <p className="break-words text-sm font-semibold">{element.name}</p>
      </div>
    );
  }

  return (
    <div className={`mx-auto w-full ${deviceWidths[device]} min-w-0`} data-funnel-mode={mode}>
      {runtimeError ? (
        <div
          aria-live="assertive"
          className="mb-4 rounded-lg border border-red-300 bg-red-50 p-4 text-sm font-semibold text-red-900"
          data-funnel-runtime-error={reloadRequired ? "publication-stale" : "proof-refresh"}
          role="alert"
        >
          <p>{runtimeError}</p>
          {reloadRequired ? (
            <button
              className="mt-3 rounded-md border border-red-700 bg-white px-3 py-2 text-sm font-semibold text-red-900"
              onClick={() => window.location.reload()}
              type="button"
            >
              {language === "de" ? "Seite neu laden" : "Reload page"}
            </button>
          ) : null}
        </div>
      ) : null}
      <div
        className="min-w-0 rounded-[28px] border border-stone-200 bg-white p-4 shadow-sm"
        style={{ backgroundColor: blueprint.theme.colors.background, color: blueprint.theme.colors.text }}
      >
        <div className="mb-4 flex min-w-0 items-center justify-between gap-3 border-b border-stone-200 pb-3 text-xs font-semibold">
          <span className="min-w-0 break-words">{blueprint.theme.logoText}</span>
          <span className="shrink-0" style={{ color: accent }}>
            {device}
          </span>
        </div>
        <div className="mb-4 h-2 overflow-hidden rounded-full bg-stone-100">
          <div className="h-full rounded-full" style={{ backgroundColor: accent, width: `${((currentPageIndex + 1) / Math.max(1, pages.length)) * 100}%` }} />
        </div>
        <div className="grid min-w-0" style={{ gap: spacing }}>
          {page.sections.map((section) => (
            <section className="grid min-w-0 gap-4" key={section.id}>
              {section.rows.map((row) => (
                <div className="grid min-w-0 gap-4" key={row.id}>
                  {row.columns.map((column) => (
                    <div className="grid min-w-0" key={column.id} style={{ gap: spacing }}>
                      {column.elements.map((element) => <div className="min-w-0" key={element.id}>{renderElement(element)}</div>)}
                    </div>
                  ))}
                </div>
              ))}
            </section>
          ))}
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
          <button
            className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50"
            disabled={currentPageIndex === 0}
            onClick={() => setCurrentPageIndex((current) => Math.max(0, current - 1))}
            type="button"
          >
            {text.back}
          </button>
          <button
            className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50"
            disabled={currentPageIndex >= pages.length - 1}
            onClick={() => setCurrentPageIndex((current) => Math.min(pages.length - 1, current + 1))}
            type="button"
          >
            {text.next}
          </button>
        </div>
      </div>
    </div>
  );
}
