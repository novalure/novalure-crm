"use client";

import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { csrfFetch } from "@/lib/security/csrf-client";

export type BrokerOperationsPanelProps = {
  canManage: boolean;
  className?: string;
  contactId?: string;
  initialSelectedClosingId?: string | null;
  initialTab?: BrokerTab;
  language?: "de" | "en";
  leadId?: string;
  projectId: string;
  workspaceId?: string;
};

export type BrokerTab = "profiles" | "matches" | "offers" | "viewings" | "activities" | "closings";
type ApiRecord = Record<string, unknown>;
type EditableTab = Exclude<BrokerTab, "matches">;
type EditorState = { record?: ApiRecord; tab: EditableTab } | null;
type OfferContentOption = Readonly<{
  id: string;
  label: string;
  projectId: string | null;
  reference: string;
  versionNumber: number;
  visibility?: string;
}>;

const tabOrder: BrokerTab[] = ["profiles", "matches", "offers", "viewings", "activities", "closings"];

const copy = {
  de: {
    blockedDelivery: "Der Provider hat nicht angenommen. Es wurde nichts versendet.",
    empty: "Für diesen Filter sind noch keine Datensätze vorhanden.",
    error: "Die Broker-Daten konnten nicht geladen werden.",
    loading: "Broker-Daten werden geladen …",
    noProfile: "Wählen Sie zuerst ein Suchprofil aus.",
    recalculate: "Matching neu berechnen",
    refresh: "Aktualisieren",
    tabs: {
      activities: "Aktivitäten",
      closings: "Abschlüsse",
      matches: "Matching",
      offers: "Angebote",
      profiles: "Suchprofile",
      viewings: "Besichtigungen",
    },
    title: "Broker Operations",
  },
  en: {
    blockedDelivery: "The provider did not accept the request. Nothing was sent.",
    empty: "No records exist for this filter yet.",
    error: "Broker data could not be loaded.",
    loading: "Loading broker data …",
    noProfile: "Select a search profile first.",
    recalculate: "Recalculate matching",
    refresh: "Refresh",
    tabs: {
      activities: "Activities",
      closings: "Closings",
      matches: "Matching",
      offers: "Offers",
      profiles: "Search profiles",
      viewings: "Viewings",
    },
    title: "Broker Operations",
  },
} as const;

function stringValue(value: unknown, fallback = "—") {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number") return String(value);
  return fallback;
}

function formValue(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function arrayLength(value: unknown) {
  return Array.isArray(value) ? value.length : 0;
}

function dateTime(value: unknown, language: "de" | "en") {
  if (typeof value !== "string") return "—";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(language === "de" ? "de-AT" : "en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
}

function idempotencyKey(scope: string) {
  return `${scope}:${crypto.randomUUID()}`;
}

function optionalText(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function optionalNumber(value: FormDataEntryValue | null) {
  const text = optionalText(value);
  return text === undefined ? undefined : Number(text);
}

function dateTimeInput(value: unknown) {
  if (typeof value !== "string") return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function textList(value: FormDataEntryValue | null) {
  return String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function parseJsonArray(value: FormDataEntryValue | null, label: string) {
  const text = optionalText(value);
  if (!text) return undefined;
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error(`${label} must be a JSON array.`);
  return parsed;
}

function recordStringList(record: ApiRecord, key: string) {
  return Array.isArray(record[key]) ? record[key].filter((entry): entry is string => typeof entry === "string").join(", ") : "";
}

function recordStringArray(record: ApiRecord | undefined, key: string) {
  return Array.isArray(record?.[key])
    ? record[key].filter((entry): entry is string => typeof entry === "string")
    : [];
}

function offerTemplateReference(id: string, versionNumber: number) {
  return `content-template:${id}:v${versionNumber}`;
}

function parseOfferTemplateReference(reference: string) {
  const match = /^content-template:([0-9a-f-]{36}):v([1-9][0-9]*)$/i.exec(reference);
  if (!match) return null;
  return { id: match[1], versionNumber: Number(match[2]) };
}

export function BrokerOperationsPanel({
  canManage,
  className = "",
  contactId,
  initialSelectedClosingId = null,
  initialTab = "profiles",
  language = "de",
  leadId,
  projectId,
  workspaceId,
}: BrokerOperationsPanelProps) {
  const text = copy[language];
  const [activeTab, setActiveTab] = useState<BrokerTab>(initialTab);
  const [items, setItems] = useState<ApiRecord[]>([]);
  const [profiles, setProfiles] = useState<ApiRecord[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editor, setEditor] = useState<EditorState>(null);
  const [saving, setSaving] = useState(false);
  const [financialsAvailable, setFinancialsAvailable] = useState(false);
  const [offerContentLoading, setOfferContentLoading] = useState(false);
  const [offerContentError, setOfferContentError] = useState("");
  const [offerDocuments, setOfferDocuments] = useState<OfferContentOption[]>([]);
  const [offerTemplates, setOfferTemplates] = useState<OfferContentOption[]>([]);
  const [offerTemplatePreview, setOfferTemplatePreview] = useState<ApiRecord | null>(null);
  const [selectedOfferDocumentIds, setSelectedOfferDocumentIds] = useState<string[]>([]);
  const [selectedOfferMediaIds, setSelectedOfferMediaIds] = useState<string[]>([]);
  const [selectedOfferTemplate, setSelectedOfferTemplate] = useState("");
  const [formOpenedAt] = useState(() => new Date().toISOString());
  const offerBodyRef = useRef<HTMLTextAreaElement>(null);
  const offerSubjectRef = useRef<HTMLInputElement>(null);
  const selectedClosingRef = useRef<HTMLElement>(null);
  const focusedClosingIdRef = useRef<string | null>(null);

  const scopeParams = useMemo(() => {
    const params = new URLSearchParams({ limit: "50", offset: "0", projectId });
    if (workspaceId) params.set("workspaceId", workspaceId);
    if (contactId) params.set("contactId", contactId);
    if (leadId) params.set("leadId", leadId);
    if (initialSelectedClosingId) params.set("closingId", initialSelectedClosingId);
    return params;
  }, [contactId, initialSelectedClosingId, leadId, projectId, workspaceId]);

  const endpoint = useMemo(() => {
    if (activeTab === "profiles") return "/api/crm/broker/operations";
    if (activeTab === "matches") return "/api/crm/broker/matches";
    return `/api/crm/broker/${activeTab}`;
  }, [activeTab]);

  const load = useCallback(async (signal?: AbortSignal) => {
    // Keep the initial effect free of synchronous state writes. This also gives an
    // already-aborted navigation a chance to exit before starting a request.
    await Promise.resolve();
    if (signal?.aborted) return;
    if (activeTab === "matches" && !selectedProfileId) {
      setItems([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    const params = new URLSearchParams(scopeParams);
    if (activeTab === "matches") params.set("profileId", selectedProfileId);
    try {
      const response = await fetch(`${endpoint}?${params.toString()}`, {
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        signal,
      });
      const payload = await response.json() as { data?: unknown; error?: unknown; financialsVisible?: unknown };
      if (!response.ok) throw new Error(stringValue(payload.error, text.error));
      const records = Array.isArray(payload.data)
        ? payload.data.filter((entry): entry is ApiRecord => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
        : [];
      setItems(records);
      if (activeTab === "closings") setFinancialsAvailable(payload.financialsVisible === true);
      if (activeTab === "profiles") {
        setProfiles(records);
        setSelectedProfileId((current) => records.some((record) => stringValue(record.id, "") === current)
          ? current
          : stringValue(records[0]?.id, ""));
      }
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === "AbortError") return;
      setItems([]);
      setError(loadError instanceof Error ? loadError.message : text.error);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [activeTab, endpoint, scopeParams, selectedProfileId, text.error]);

  const loadOfferTemplatePreview = useCallback(async (reference: string, signal?: AbortSignal) => {
    if (!reference) {
      setOfferTemplatePreview(null);
      return;
    }
    const parsedReference = parseOfferTemplateReference(reference);
    if (!parsedReference) throw new Error(language === "de" ? "Ungültige Vorlagenreferenz." : "Invalid template reference.");
    const params = new URLSearchParams();
    if (workspaceId) params.set("workspaceId", workspaceId);
    const response = await fetch(`/api/crm/templates/${parsedReference.id}?${params.toString()}`, {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal,
    });
    const payload = await response.json() as { error?: unknown; template?: ApiRecord };
    if (!response.ok || !payload.template) {
      throw new Error(stringValue(payload.error, language === "de" ? "Vorlage nicht verfügbar." : "Template unavailable."));
    }
    const template = payload.template;
    const versions = Array.isArray(template.versions)
      ? template.versions.filter((entry): entry is ApiRecord => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
      : [];
    const version = versions.find((entry) => Number(entry.versionNumber) === parsedReference.versionNumber);
    if (
      !version
      || template.approvalStatus !== "approved"
      || template.archivedAt
      || template.channel !== "email"
      || Number(template.currentVersionNumber) !== parsedReference.versionNumber
      || (template.projectId && template.projectId !== projectId)
    ) {
      throw new Error(language === "de"
        ? "Die Vorlage ist nicht mehr als aktuelle E-Mail-Vorlage für dieses Projekt freigegeben."
        : "The template is no longer the approved current email template for this project.");
    }
    setOfferTemplatePreview({
      ...version,
      name: template.name,
      projectId: template.projectId,
      reference,
    });
    if (offerSubjectRef.current) offerSubjectRef.current.value = formValue(version.subject);
    if (offerBodyRef.current) offerBodyRef.current.value = formValue(version.body);
  }, [language, projectId, workspaceId]);

  const loadOfferContent = useCallback(async (templateReference: string, signal?: AbortSignal) => {
    setOfferContentLoading(true);
    setOfferContentError("");
    const params = new URLSearchParams({ page: "1", pageSize: "50" });
    if (workspaceId) params.set("workspaceId", workspaceId);
    try {
      const [templateResponse, documentResponse] = await Promise.all([
        fetch(`/api/crm/templates?${params.toString()}`, {
          cache: "no-store",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
          signal,
        }),
        fetch(`/api/crm/documents?${params.toString()}`, {
          cache: "no-store",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
          signal,
        }),
      ]);
      const [templatePayload, documentPayload] = await Promise.all([
        templateResponse.json() as Promise<{ error?: unknown; items?: unknown[] }>,
        documentResponse.json() as Promise<{ error?: unknown; items?: unknown[] }>,
      ]);
      if (!templateResponse.ok || !documentResponse.ok) {
        throw new Error(stringValue(
          templatePayload.error ?? documentPayload.error,
          language === "de" ? "Freigegebene Inhalte konnten nicht geladen werden." : "Approved content could not be loaded.",
        ));
      }
      const templates = (templatePayload.items ?? [])
        .filter((entry): entry is ApiRecord => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
        .filter((entry) => (
          entry.approvalStatus === "approved"
          && !entry.archivedAt
          && entry.channel === "email"
          && (!entry.projectId || entry.projectId === projectId)
        ))
        .map((entry): OfferContentOption => ({
          id: stringValue(entry.id, ""),
          label: stringValue(entry.name),
          projectId: typeof entry.projectId === "string" ? entry.projectId : null,
          reference: offerTemplateReference(stringValue(entry.id, ""), Number(entry.currentVersionNumber)),
          versionNumber: Number(entry.currentVersionNumber),
        }))
        .filter((entry) => entry.id && Number.isSafeInteger(entry.versionNumber));
      const documents = (documentPayload.items ?? [])
        .filter((entry): entry is ApiRecord => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
        .filter((entry) => (
          entry.approvalStatus === "approved"
          && !entry.archivedAt
          && (
            (entry.visibility === "customer" && entry.projectId === projectId)
            || (entry.visibility === "public" && (!entry.projectId || entry.projectId === projectId))
          )
        ))
        .map((entry): OfferContentOption => ({
          id: stringValue(entry.id, ""),
          label: stringValue(entry.title),
          projectId: typeof entry.projectId === "string" ? entry.projectId : null,
          reference: stringValue(entry.id, ""),
          versionNumber: Number(entry.currentVersionNumber),
          visibility: stringValue(entry.visibility, ""),
        }))
        .filter((entry) => entry.id && Number.isSafeInteger(entry.versionNumber));
      setOfferTemplates(templates);
      setOfferDocuments(documents);
      if (templateReference) await loadOfferTemplatePreview(templateReference, signal);
      else setOfferTemplatePreview(null);
    } catch (contentError) {
      if (contentError instanceof DOMException && contentError.name === "AbortError") return;
      setOfferTemplates([]);
      setOfferDocuments([]);
      setOfferTemplatePreview(null);
      setOfferContentError(contentError instanceof Error ? contentError.message : text.error);
    } finally {
      if (!signal?.aborted) setOfferContentLoading(false);
    }
  }, [language, loadOfferTemplatePreview, projectId, text.error, workspaceId]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [load]);

  useEffect(() => {
    if (editor?.tab !== "offers") return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const firstItem = Array.isArray(editor.record?.items) && editor.record.items[0]
        && typeof editor.record.items[0] === "object"
        && !Array.isArray(editor.record.items[0])
        ? editor.record.items[0] as ApiRecord
        : undefined;
      const templateReference = formValue(editor.record?.templateKey);
      setSelectedOfferTemplate(templateReference);
      setSelectedOfferDocumentIds(recordStringArray(firstItem, "selectedDocumentIds"));
      setSelectedOfferMediaIds(recordStringArray(firstItem, "selectedMediaIds"));
      void loadOfferContent(templateReference, controller.signal);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [editor, loadOfferContent]);

  useEffect(() => {
    if (
      activeTab !== "closings" ||
      loading ||
      !initialSelectedClosingId ||
      focusedClosingIdRef.current === initialSelectedClosingId ||
      !items.some((item) => stringValue(item.id, "") === initialSelectedClosingId)
    ) return;

    focusedClosingIdRef.current = initialSelectedClosingId;
    selectedClosingRef.current?.focus();
    selectedClosingRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeTab, initialSelectedClosingId, items, loading]);

  const recalculate = useCallback(async () => {
    if (!canManage || !selectedProfileId) return;
    setLoading(true);
    setError("");
    setNotice("");
    const params = new URLSearchParams();
    if (workspaceId) params.set("workspaceId", workspaceId);
    try {
      const response = await csrfFetch(`/api/crm/broker/matches?${params.toString()}`, {
        body: JSON.stringify({ limit: 100, offset: 0, operation: "recalculate", profileId: selectedProfileId, projectId }),
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey("broker-match-recalculate"),
        },
        method: "POST",
      });
      const payload = await response.json() as { data?: { items?: ApiRecord[] }; error?: unknown };
      if (!response.ok) throw new Error(stringValue(payload.error, text.error));
      setItems(Array.isArray(payload.data?.items) ? payload.data.items : []);
      setNotice(`${stringValue(payload.data?.items?.length, "0")} ${text.tabs.matches.toLowerCase()}`);
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : text.error);
    } finally {
      setLoading(false);
    }
  }, [canManage, projectId, selectedProfileId, text.error, text.tabs.matches, workspaceId]);

  const requestQaDelivery = useCallback(async (offerId: string) => {
    if (!canManage) return;
    setLoading(true);
    setError("");
    setNotice("");
    const params = new URLSearchParams();
    if (workspaceId) params.set("workspaceId", workspaceId);
    try {
      const response = await csrfFetch(`/api/crm/broker/offers?${params.toString()}`, {
        body: JSON.stringify({ offerId, operation: "qa_delivery" }),
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey("broker-offer-qa-delivery"),
        },
        method: "POST",
      });
      const payload = await response.json() as { data?: { delivered?: boolean }; error?: unknown };
      if (!response.ok || payload.data?.delivered !== true) {
        setNotice(text.blockedDelivery);
        return;
      }
      setNotice(text.blockedDelivery);
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : text.error);
    } finally {
      setLoading(false);
    }
  }, [canManage, text.blockedDelivery, text.error, workspaceId]);

  const chooseOfferTemplate = useCallback(async (reference: string) => {
    setSelectedOfferTemplate(reference);
    setOfferContentError("");
    if (!reference) {
      setOfferTemplatePreview(null);
      return;
    }
    setOfferContentLoading(true);
    try {
      await loadOfferTemplatePreview(reference);
    } catch (templateError) {
      setOfferTemplatePreview(null);
      setOfferContentError(templateError instanceof Error ? templateError.message : text.error);
    } finally {
      setOfferContentLoading(false);
    }
  }, [loadOfferTemplatePreview, text.error]);

  const closingsExportHref = useMemo(() => {
    const params = new URLSearchParams(scopeParams);
    params.set("format", "csv");
    return `/api/crm/broker/closings?${params.toString()}`;
  }, [scopeParams]);

  const closingsPdfHref = useMemo(() => {
    const params = new URLSearchParams(scopeParams);
    params.set("format", "pdf");
    return `/api/crm/broker/closings?${params.toString()}`;
  }, [scopeParams]);

  const saveEditor = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editor || !canManage) return;
    const form = new FormData(event.currentTarget);
    const record = editor.record;
    const base = {
      ...(record?.id ? { expectedVersion: Number(record.version) } : {}),
      ...(record?.id ? { id: record.id } : {}),
      projectId,
    } as ApiRecord;

    try {
      let endpoint = "";
      let body: ApiRecord;
      if (editor.tab === "profiles") {
        endpoint = "/api/crm/broker/search-profiles";
        body = {
          ...base,
          accessibility: form.get("accessibility"),
          areaFromSqm: optionalNumber(form.get("areaFromSqm")),
          areaToSqm: optionalNumber(form.get("areaToSqm")),
          autoMatchEnabled: form.get("autoMatchEnabled") === "on",
          budgetFromMinor: optionalText(form.get("budgetFromMinor")),
          budgetToMinor: optionalText(form.get("budgetToMinor")),
          contactId: optionalText(form.get("contactId")),
          equipment: textList(form.get("equipment")),
          expiresAt: optionalText(form.get("expiresAt")),
          intentType: form.get("intentType"),
          municipality: optionalText(form.get("municipality")),
          mustHaveCriteria: textList(form.get("mustHaveCriteria")),
          niceToHaveCriteria: textList(form.get("niceToHaveCriteria")),
          postalCode: optionalText(form.get("postalCode")),
          propertyType: optionalText(form.get("propertyType")),
          status: form.get("status"),
          title: form.get("title"),
        };
      } else if (editor.tab === "offers") {
        endpoint = "/api/crm/broker/offers";
        const selectedDocumentIds = form.getAll("selectedDocumentIds").map(String);
        const selectedMediaIds = form.getAll("selectedMediaIds").map(String);
        const structuredItem = {
          displayAddress: optionalText(form.get("displayAddress")) ?? "",
          priceMinor: optionalText(form.get("priceMinor")),
          priceReleased: form.get("priceReleased") === "on",
          selectedDocumentIds,
          selectedMediaIds,
          targetId: optionalText(form.get("targetId")),
          targetKind: form.get("targetKind"),
        };
        const advancedItems = parseJsonArray(form.get("items"), "Offer items");
        const items = advancedItems?.map((item, index) => (
          index === 0 && item && typeof item === "object" && !Array.isArray(item)
            ? { ...item as ApiRecord, selectedDocumentIds, selectedMediaIds }
            : item
        )) ?? [structuredItem];
        body = {
          ...base,
          addressVisibility: form.get("addressVisibility"),
          bodyText: form.get("bodyText"),
          commissionNotice: optionalText(form.get("commissionNotice")),
          contactId: optionalText(form.get("contactId")),
          dealId: optionalText(form.get("dealId")),
          items,
          leadId: optionalText(form.get("leadId")),
          priceReleased: form.get("priceReleased") === "on",
          recipientEmail: form.get("recipientEmail"),
          status: form.get("status"),
          subject: form.get("subject"),
          templateKey: optionalText(form.get("templateKey")),
        };
      } else if (editor.tab === "viewings") {
        endpoint = "/api/crm/broker/viewings";
        body = {
          ...base,
          addressMode: form.get("addressMode"),
          addressText: form.get("addressText"),
          contactId: optionalText(form.get("contactId")),
          createCalendarProjection: Boolean(record?.calendarEventId) || form.get("createCalendarProjection") === "on",
          dealId: optionalText(form.get("dealId")),
          endsAt: new Date(String(form.get("endsAt"))).toISOString(),
          invitationRequested: form.get("invitationRequested") === "on",
          leadId: optionalText(form.get("leadId")),
          personalNote: optionalText(form.get("personalNote")),
          startsAt: new Date(String(form.get("startsAt"))).toISOString(),
          status: form.get("status"),
          targetId: optionalText(form.get("targetId")),
          targetKind: form.get("targetKind"),
          timezone: form.get("timezone"),
        };
      } else if (editor.tab === "activities") {
        endpoint = "/api/crm/broker/activities";
        const followUpTitle = optionalText(form.get("followUpTitle"));
        const followUpDueAt = optionalText(form.get("followUpDueAt"));
        body = {
          ...base,
          activityType: form.get("activityType"),
          contactId: optionalText(form.get("contactId")),
          dealId: optionalText(form.get("dealId")),
          detail: optionalText(form.get("detail")),
          leadId: optionalText(form.get("leadId")),
          occurredAt: new Date(String(form.get("occurredAt"))).toISOString(),
          outcome: form.get("outcome"),
          title: form.get("title"),
          viewingId: optionalText(form.get("viewingId")),
          ...(followUpTitle ? { followUp: {
            description: optionalText(form.get("followUpDescription")) ?? "",
            ...(followUpDueAt ? { dueAt: new Date(followUpDueAt).toISOString() } : {}),
            priority: form.get("followUpPriority"),
            title: followUpTitle,
          } } : {}),
        };
      } else {
        endpoint = "/api/crm/broker/closings";
        body = {
          ...base,
          baseAmountMinor: form.get("baseAmountMinor"),
          buyerCommissionMinor: form.get("buyerCommissionMinor"),
          buyerContactId: optionalText(form.get("buyerContactId")),
          closingDate: optionalText(form.get("closingDate")),
          commissionSplits: parseJsonArray(form.get("commissionSplits"), "Commission splits"),
          contractDate: optionalText(form.get("contractDate")),
          contractType: form.get("contractType"),
          currency: form.get("currency"),
          dealId: optionalText(form.get("dealId")),
          grossCommissionMinor: form.get("grossCommissionMinor"),
          internalNotes: optionalText(form.get("internalNotes")),
          netCommissionMinor: form.get("netCommissionMinor"),
          paymentStatus: form.get("paymentStatus"),
          sellerCommissionMinor: form.get("sellerCommissionMinor"),
          sellerContactId: optionalText(form.get("sellerContactId")),
          status: form.get("status"),
          targetId: optionalText(form.get("targetId")),
          targetKind: form.get("targetKind"),
          taxMinor: form.get("taxMinor"),
        };
      }
      setSaving(true);
      setError("");
      setNotice("");
      const params = new URLSearchParams();
      if (workspaceId) params.set("workspaceId", workspaceId);
      const response = await csrfFetch(`${endpoint}?${params.toString()}`, {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey(`broker-${editor.tab}-save`) },
        method: record?.id ? "PATCH" : "POST",
      });
      const payload = await response.json() as { error?: unknown };
      if (!response.ok) throw new Error(stringValue(payload.error, text.error));
      setNotice(language === "de" ? "Änderung wurde gespeichert." : "Change saved.");
      setEditor(null);
      await load();
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : text.error);
    } finally {
      setSaving(false);
    }
  }, [canManage, editor, language, load, projectId, text.error, workspaceId]);

  function field(label: string, name: string, options: { defaultValue?: unknown; required?: boolean; type?: string } = {}) {
    return (
      <label className="grid gap-1 text-sm font-medium text-slate-700" key={name}>
        {label}
        <input
          className="min-h-11 rounded-xl border border-slate-300 bg-white px-3 text-slate-950"
          defaultValue={formValue(options.defaultValue)}
          name={name}
          required={options.required}
          type={options.type ?? "text"}
        />
      </label>
    );
  }

  function renderEditor() {
    if (!editor) return null;
    const record = editor.record ?? {};
    const firstOfferItem = Array.isArray(record.items) && record.items[0]
      && typeof record.items[0] === "object"
      && !Array.isArray(record.items[0])
      ? record.items[0] as ApiRecord
      : undefined;
    const knownOfferDocumentIds = new Set(offerDocuments.map((document) => document.id));
    const retainedOfferDocumentIds = selectedOfferDocumentIds.filter((id) => !knownOfferDocumentIds.has(id));
    const title = editor.record
      ? (language === "de" ? "Datensatz bearbeiten" : "Edit record")
      : (language === "de" ? "Neuen Datensatz anlegen" : "Create record");
    const submit = saving ? (language === "de" ? "Speichern …" : "Saving …") : (language === "de" ? "Speichern" : "Save");
    const contactDefault = formValue(record.contactId) || contactId || "";
    return (
      <form aria-label={title} className="mt-5 grid gap-3 rounded-2xl border border-indigo-200 bg-indigo-50 p-4 md:grid-cols-2" onSubmit={saveEditor}>
        <div className="md:col-span-2 flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-semibold text-slate-950">{title}</h3>
          <button className="min-h-11 rounded-xl border border-slate-300 bg-white px-4" disabled={saving} onClick={() => setEditor(null)} type="button">
            {language === "de" ? "Abbrechen" : "Cancel"}
          </button>
        </div>
        {editor.record ? <p className="md:col-span-2 text-xs text-slate-600">{language === "de" ? "Die gespeicherte Version wird mitgesendet. Bei einem Konflikt wird nichts überschrieben." : "The loaded version is included. A conflict never overwrites data."}</p> : null}

        {editor.tab === "profiles" ? <fieldset className="md:col-span-2 grid gap-3 rounded-xl border border-indigo-100 bg-white/70 p-4 md:grid-cols-2">
          <legend className="px-2 text-sm font-semibold text-indigo-950">{language === "de" ? "Suchprofil" : "Search profile"}</legend>
          {field(language === "de" ? "Titel" : "Title", "title", { defaultValue: record.title, required: true })}
          <label className="grid gap-1 text-sm font-medium text-slate-700">{language === "de" ? "Status" : "Status"}<select className="min-h-11 rounded-xl border border-slate-300 bg-white px-3" defaultValue={formValue(record.status) || "draft"} name="status"><option value="draft">draft</option><option value="active">active</option><option value="paused">paused</option><option value="expired">expired</option><option value="archived">archived</option></select></label>
          {field("Contact ID", "contactId", { defaultValue: contactDefault, required: true })}
          <label className="grid gap-1 text-sm font-medium text-slate-700">{language === "de" ? "Vorhaben" : "Intent"}<select className="min-h-11 rounded-xl border border-slate-300 bg-white px-3" defaultValue={formValue(record.intentType) || "purchase"} name="intentType"><option value="purchase">purchase</option><option value="rent">rent</option><option value="investment">investment</option></select></label>
          {field(language === "de" ? "Budget von (Cent)" : "Budget from (minor units)", "budgetFromMinor", { defaultValue: record.budgetFromMinor, type: "number" })}
          {field(language === "de" ? "Budget bis (Cent)" : "Budget to (minor units)", "budgetToMinor", { defaultValue: record.budgetToMinor, type: "number" })}
          {field(language === "de" ? "Objekttyp" : "Property type", "propertyType", { defaultValue: record.propertyType })}
          {field(language === "de" ? "Ort" : "Municipality", "municipality", { defaultValue: record.municipality })}
          {field(language === "de" ? "PLZ" : "Postal code", "postalCode", { defaultValue: record.postalCode })}
          {field(language === "de" ? "Ablaufdatum" : "Expiry date", "expiresAt", { defaultValue: record.expiresAt, type: "date" })}
          <label className="flex min-h-11 items-center gap-2 text-sm font-medium text-slate-700"><input defaultChecked={record.autoMatchEnabled === true} name="autoMatchEnabled" type="checkbox" />{language === "de" ? "Automatisches Matching aktivieren" : "Enable automatic matching"}</label>
          <label className="grid gap-1 text-sm font-medium text-slate-700">{language === "de" ? "Barrierefreiheit" : "Accessibility"}<select className="min-h-11 rounded-xl border border-slate-300 bg-white px-3" defaultValue={formValue(record.accessibility) || "none"} name="accessibility"><option value="none">none</option><option value="preferred">preferred</option><option value="required">required</option></select></label>
          <details className="md:col-span-2 rounded-xl border border-indigo-100 bg-white p-3"><summary className="flex min-h-11 cursor-pointer items-center font-medium">{language === "de" ? "Weitere Kriterien" : "More criteria"}</summary><div className="mt-3 grid gap-3 md:grid-cols-2">{field(language === "de" ? "Ausstattung (Komma-getrennt)" : "Equipment (comma separated)", "equipment", { defaultValue: recordStringList(record, "equipment") })}{field(language === "de" ? "Muss-Kriterien (Komma-getrennt)" : "Must-have criteria (comma separated)", "mustHaveCriteria", { defaultValue: recordStringList(record, "mustHaveCriteria") })}{field(language === "de" ? "Wunsch-Kriterien (Komma-getrennt)" : "Nice-to-have criteria (comma separated)", "niceToHaveCriteria", { defaultValue: recordStringList(record, "niceToHaveCriteria") })}{field(language === "de" ? "Fläche von m²" : "Area from sqm", "areaFromSqm", { defaultValue: record.areaFromSqm, type: "number" })}{field(language === "de" ? "Fläche bis m²" : "Area to sqm", "areaToSqm", { defaultValue: record.areaToSqm, type: "number" })}</div></details>
        </fieldset> : null}

        {editor.tab === "offers" ? <fieldset className="md:col-span-2 grid gap-3 rounded-xl border border-indigo-100 bg-white/70 p-4 md:grid-cols-2">
          <legend className="px-2 text-sm font-semibold text-indigo-950">{language === "de" ? "Angebotsentwurf" : "Offer draft"}</legend>
          <label className="md:col-span-2 grid gap-1 text-sm font-medium text-slate-700">
            {language === "de" ? "Freigegebene zentrale E-Mail-Vorlage" : "Approved central email template"}
            <select
              className="min-h-11 rounded-xl border border-slate-300 bg-white px-3"
              disabled={offerContentLoading}
              name="templateKey"
              onChange={(event) => void chooseOfferTemplate(event.target.value)}
              value={selectedOfferTemplate}
            >
              <option value="">{language === "de" ? "Keine – nur manueller Entwurf" : "None – manual draft only"}</option>
              {selectedOfferTemplate && !offerTemplates.some((template) => template.reference === selectedOfferTemplate) ? (
                <option value={selectedOfferTemplate}>{language === "de" ? "Gespeicherte Referenz – nicht mehr freigegeben" : "Saved reference – no longer approved"}</option>
              ) : null}
              {offerTemplates.map((template) => (
                <option key={template.reference} value={template.reference}>
                  {template.label} · v{template.versionNumber}{template.projectId ? ` · ${language === "de" ? "Projekt" : "project"}` : " · global"}
                </option>
              ))}
            </select>
          </label>
          {offerContentError ? <p className="md:col-span-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">{offerContentError}</p> : null}
          {offerTemplatePreview ? (
            <article aria-label={language === "de" ? "Vorlagenvorschau" : "Template preview"} className="md:col-span-2 rounded-xl border border-indigo-100 bg-white p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong>{stringValue(offerTemplatePreview.name)}</strong>
                <span className="text-xs text-slate-500">v{stringValue(offerTemplatePreview.versionNumber)} · {stringValue(offerTemplatePreview.language)}</span>
              </div>
              <p className="mt-2 text-sm font-medium text-slate-800">{stringValue(offerTemplatePreview.subject, language === "de" ? "Ohne Betreff" : "No subject")}</p>
              <p className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap text-sm text-slate-600">{stringValue(offerTemplatePreview.body)}</p>
              {arrayLength(offerTemplatePreview.allowedVariables) > 0 ? <p className="mt-2 text-xs text-slate-500">{language === "de" ? "Variablen" : "Variables"}: {recordStringList(offerTemplatePreview, "allowedVariables")}</p> : null}
            </article>
          ) : null}
          {field("Contact ID", "contactId", { defaultValue: contactDefault, required: true })}
          {field(language === "de" ? "Empfänger-E-Mail" : "Recipient email", "recipientEmail", { defaultValue: record.recipientEmail, required: true, type: "email" })}
          <label className="grid gap-1 text-sm font-medium text-slate-700">{language === "de" ? "Betreff" : "Subject"}<input className="min-h-11 rounded-xl border border-slate-300 bg-white px-3 text-slate-950" defaultValue={formValue(record.subject)} name="subject" ref={offerSubjectRef} required /></label>
          <label className="grid gap-1 text-sm font-medium text-slate-700">{language === "de" ? "Status" : "Status"}<select className="min-h-11 rounded-xl border border-slate-300 bg-white px-3" defaultValue={formValue(record.status) || "draft"} name="status"><option value="draft">draft</option><option value="ready">ready</option><option value="withdrawn">withdrawn</option></select></label>
          <label className="md:col-span-2 grid gap-1 text-sm font-medium text-slate-700">{language === "de" ? "Text" : "Body"}<textarea className="min-h-28 rounded-xl border border-slate-300 bg-white p-3 text-slate-950" defaultValue={formValue(record.bodyText)} name="bodyText" ref={offerBodyRef} required /></label>
          <label className="grid gap-1 text-sm font-medium text-slate-700">{language === "de" ? "Adresse zeigen" : "Address visibility"}<select className="min-h-11 rounded-xl border border-slate-300 bg-white px-3" defaultValue={formValue(record.addressVisibility) || "reduced"} name="addressVisibility"><option value="full">full</option><option value="reduced">reduced</option><option value="hidden">hidden</option></select></label>
          {field("Deal ID", "dealId", { defaultValue: record.dealId })}
          <details className="md:col-span-2 rounded-xl border border-indigo-100 bg-white p-3"><summary className="flex min-h-11 cursor-pointer items-center font-medium">{language === "de" ? "Angebotsobjekt und Anlagen" : "Offer item and attachments"}</summary><div className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="grid gap-1 text-sm font-medium text-slate-700">{language === "de" ? "Objektart" : "Target kind"}<select className="min-h-11 rounded-xl border border-slate-300 bg-white px-3" defaultValue={formValue(firstOfferItem?.targetKind) || "listing"} name="targetKind"><option value="listing">listing</option><option value="unit">unit</option></select></label>
            {field("Target ID", "targetId", { defaultValue: firstOfferItem?.targetId, required: !record.id })}
            {field(language === "de" ? "Anzeigeadresse" : "Display address", "displayAddress", { defaultValue: firstOfferItem?.displayAddress })}
            {field(language === "de" ? "Preis (Cent)" : "Price (minor units)", "priceMinor", { defaultValue: firstOfferItem?.priceMinor, type: "number" })}
            <label className="flex min-h-11 items-center gap-2 text-sm font-medium text-slate-700"><input defaultChecked={firstOfferItem?.priceReleased === true} name="priceReleased" type="checkbox" />{language === "de" ? "Preis freigeben" : "Release price"}</label>
            <section aria-labelledby="offer-approved-documents" className="md:col-span-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
              <h4 className="text-sm font-semibold text-slate-900" id="offer-approved-documents">{language === "de" ? "Freigegebene sichtbare Anlagen" : "Approved visible attachments"}</h4>
              <p className="mt-1 text-xs text-slate-600">{language === "de" ? "Nur aktuelle, aktive customer/public-Dokumente werden angeboten und serverseitig erneut geprüft." : "Only current active customer/public documents are offered and revalidated by the server."}</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {offerDocuments.map((document) => (
                  <label className="flex min-h-11 items-start gap-2 rounded-lg border border-slate-200 bg-white p-2 text-sm" key={document.id}>
                    <input
                      checked={selectedOfferDocumentIds.includes(document.id)}
                      className="mt-1"
                      name="selectedDocumentIds"
                      onChange={(event) => setSelectedOfferDocumentIds((current) => event.target.checked
                        ? [...new Set([...current, document.id])]
                        : current.filter((id) => id !== document.id))}
                      type="checkbox"
                      value={document.id}
                    />
                    <span><strong className="block">{document.label}</strong><span className="text-xs text-slate-500">{document.visibility} · v{document.versionNumber}{document.projectId ? " · project" : " · global"}</span></span>
                  </label>
                ))}
                {retainedOfferDocumentIds.map((id) => (
                  <label className="flex min-h-11 items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-sm" key={id}>
                    <input checked name="selectedDocumentIds" onChange={(event) => {
                      if (!event.target.checked) setSelectedOfferDocumentIds((current) => current.filter((entry) => entry !== id));
                    }} type="checkbox" value={id} />
                    <span><strong className="block">{language === "de" ? "Bestehende Objektanlage" : "Existing listing attachment"}</strong><span className="break-all text-xs text-slate-500">{id}</span></span>
                  </label>
                ))}
              </div>
              {offerDocuments.length === 0 && retainedOfferDocumentIds.length === 0 ? <p className="mt-2 text-sm text-slate-500">{offerContentLoading ? (language === "de" ? "Inhalte werden geladen …" : "Loading content …") : (language === "de" ? "Keine freigegebenen Anlagen verfügbar." : "No approved attachments available.")}</p> : null}
              {selectedOfferMediaIds.length > 0 ? <div className="mt-3"><h5 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{language === "de" ? "Bestehende freigegebene Medien" : "Existing approved media"}</h5>{selectedOfferMediaIds.map((id) => <label className="mt-1 flex min-h-11 items-center gap-2 rounded-lg border border-slate-200 bg-white p-2 text-sm" key={id}><input checked name="selectedMediaIds" onChange={(event) => { if (!event.target.checked) setSelectedOfferMediaIds((current) => current.filter((entry) => entry !== id)); }} type="checkbox" value={id} /><span className="break-all">{id}</span></label>)}</div> : null}
              <p className="mt-3 text-xs font-medium text-slate-700">{language === "de" ? "Auswahl" : "Selection"}: {selectedOfferDocumentIds.length} {language === "de" ? "Dokument(e)" : "document(s)"}, {selectedOfferMediaIds.length} {language === "de" ? "Medium/Medien" : "media item(s)"}</p>
            </section>
            <label className="md:col-span-2 grid gap-1 text-sm font-medium text-slate-700">{language === "de" ? "Erweiterte Mehrfachobjekte (optional, JSON)" : "Advanced multiple items (optional JSON)"}<textarea className="min-h-24 rounded-xl border border-slate-300 bg-white p-3 font-mono text-xs" defaultValue={Array.isArray(record.items) && record.items.length > 1 ? JSON.stringify(record.items, null, 2) : ""} name="items" placeholder='[{"targetKind":"listing","targetId":"UUID","displayAddress":"…","priceReleased":false}]' /></label>
          </div></details>
        </fieldset> : null}

        {editor.tab === "viewings" ? <fieldset className="md:col-span-2 grid gap-3 rounded-xl border border-indigo-100 bg-white/70 p-4 md:grid-cols-2">
          <legend className="px-2 text-sm font-semibold text-indigo-950">{language === "de" ? "Besichtigung" : "Viewing"}</legend>
          {field("Contact ID", "contactId", { defaultValue: contactDefault, required: true })}
          {field("Target ID", "targetId", { defaultValue: record.targetId, required: true })}
          <label className="grid gap-1 text-sm font-medium text-slate-700">{language === "de" ? "Objektart" : "Target kind"}<select className="min-h-11 rounded-xl border border-slate-300 bg-white px-3" defaultValue={formValue(record.targetKind) || "listing"} name="targetKind"><option value="listing">listing</option><option value="unit">unit</option></select></label>
          {field(language === "de" ? "Adresse" : "Address", "addressText", { defaultValue: record.addressText, required: true })}
          {field(language === "de" ? "Beginn" : "Starts", "startsAt", { defaultValue: dateTimeInput(record.startsAt), required: true, type: "datetime-local" })}
          {field(language === "de" ? "Ende" : "Ends", "endsAt", { defaultValue: dateTimeInput(record.endsAt), required: true, type: "datetime-local" })}
          <label className="grid gap-1 text-sm font-medium text-slate-700">{language === "de" ? "Status" : "Status"}<select className="min-h-11 rounded-xl border border-slate-300 bg-white px-3" defaultValue={formValue(record.status) || "planned"} name="status"><option value="planned">planned</option><option value="confirmed">confirmed</option><option value="completed">completed</option><option value="cancelled">cancelled</option><option value="no_show">no_show</option></select></label>
          {field(language === "de" ? "Zeitzone" : "Timezone", "timezone", { defaultValue: record.timezone || "Europe/Vienna", required: true })}
          {field("Deal ID", "dealId", { defaultValue: record.dealId })}
          {field("Lead ID", "leadId", { defaultValue: record.leadId })}
          <label className="md:col-span-2 grid gap-1 text-sm font-medium text-slate-700">{language === "de" ? "Persönliche Notiz" : "Personal note"}<textarea className="min-h-20 rounded-xl border border-slate-300 bg-white p-3" defaultValue={formValue(record.personalNote)} name="personalNote" /></label>
          <label className="flex min-h-11 items-center gap-2 text-sm font-medium text-slate-700"><input defaultChecked={Boolean(record.calendarEventId)} disabled={Boolean(record.calendarEventId)} name="createCalendarProjection" type="checkbox" />{record.calendarEventId ? (language === "de" ? "Kalendertermin verbunden; Änderungen werden synchronisiert" : "Calendar event linked; changes stay synchronized") : (language === "de" ? "Internen Kalendertermin anlegen" : "Create internal calendar event")}</label>
          <label className="flex min-h-11 items-center gap-2 text-sm font-medium text-slate-700"><input name="invitationRequested" type="checkbox" />{language === "de" ? "Einladung prüfen (Provider bleibt Launch-off)" : "Check invitation (provider remains launch-off)"}</label>
        </fieldset> : null}

        {editor.tab === "activities" ? <fieldset className="md:col-span-2 grid gap-3 rounded-xl border border-indigo-100 bg-white/70 p-4 md:grid-cols-2">
          <legend className="px-2 text-sm font-semibold text-indigo-950">{language === "de" ? "Aktivität und Nachfassaufgabe" : "Activity and follow-up"}</legend>
          {field("Contact ID", "contactId", { defaultValue: contactDefault, required: true })}
          {field(language === "de" ? "Titel" : "Title", "title", { required: true })}
          <label className="grid gap-1 text-sm font-medium text-slate-700">{language === "de" ? "Aktivität" : "Activity"}<select className="min-h-11 rounded-xl border border-slate-300 bg-white px-3" name="activityType"><option value="call">call</option><option value="email">email</option><option value="note">note</option><option value="viewing">viewing</option><option value="offer">offer</option><option value="question">question</option><option value="negotiation">negotiation</option><option value="document_sent">document_sent</option><option value="closing">closing</option><option value="other">other</option></select></label>
          <label className="grid gap-1 text-sm font-medium text-slate-700">{language === "de" ? "Ergebnis" : "Outcome"}<select className="min-h-11 rounded-xl border border-slate-300 bg-white px-3" name="outcome"><option value="info">info</option><option value="open">open</option><option value="done">done</option><option value="risk">risk</option></select></label>
          {field(language === "de" ? "Zeitpunkt" : "Occurred at", "occurredAt", { defaultValue: dateTimeInput(formOpenedAt), required: true, type: "datetime-local" })}
          {field("Deal ID", "dealId")}
          {field("Lead ID", "leadId")}
          {field("Viewing ID", "viewingId")}
          <label className="md:col-span-2 grid gap-1 text-sm font-medium text-slate-700">{language === "de" ? "Details" : "Details"}<textarea className="min-h-20 rounded-xl border border-slate-300 bg-white p-3" name="detail" /></label>
          <details className="md:col-span-2 rounded-xl border border-indigo-100 bg-white p-3"><summary className="flex min-h-11 cursor-pointer items-center font-medium">{language === "de" ? "Nachfassaufgabe (optional)" : "Follow-up task (optional)"}</summary><div className="mt-3 grid gap-3 md:grid-cols-2">{field(language === "de" ? "Titel der Aufgabe" : "Task title", "followUpTitle")}{field(language === "de" ? "Fällig am" : "Due at", "followUpDueAt", { type: "datetime-local" })}<label className="grid gap-1 text-sm font-medium text-slate-700">{language === "de" ? "Priorität" : "Priority"}<select className="min-h-11 rounded-xl border border-slate-300 bg-white px-3" name="followUpPriority"><option value="Normal">Normal</option><option value="Niedrig">Niedrig</option><option value="Hoch">Hoch</option></select></label><label className="grid gap-1 text-sm font-medium text-slate-700">{language === "de" ? "Beschreibung" : "Description"}<textarea className="min-h-11 rounded-xl border border-slate-300 bg-white p-3" name="followUpDescription" /></label></div></details>
        </fieldset> : null}

        {editor.tab === "closings" ? <fieldset className="md:col-span-2 grid gap-3 rounded-xl border border-indigo-100 bg-white/70 p-4 md:grid-cols-2">
          <legend className="px-2 text-sm font-semibold text-indigo-950">{language === "de" ? "Abschluss, Geldbeträge und Provision" : "Closing, money and commission"}</legend>
          <p className="md:col-span-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{language === "de" ? "Finanzdaten werden nur gespeichert, wenn der Server die Finanzberechtigung bestätigt. Vertrags- und Objektbeziehungen bleiben bis zum separaten Cutover unverändert." : "Financial data saves only when the server confirms financial permission. Contract and object relationships remain unchanged until the separate cutover."}</p>
          {field("Deal ID", "dealId", { defaultValue: record.dealId, required: true })}
          {field("Target ID", "targetId", { defaultValue: record.targetId, required: true })}
          {field(language === "de" ? "Käufer Contact ID" : "Buyer contact ID", "buyerContactId", { defaultValue: record.buyerContactId, required: true })}
          {field(language === "de" ? "Verkäufer Contact ID" : "Seller contact ID", "sellerContactId", { defaultValue: record.sellerContactId, required: true })}
          <label className="grid gap-1 text-sm font-medium text-slate-700">{language === "de" ? "Objektart" : "Target kind"}<select className="min-h-11 rounded-xl border border-slate-300 bg-white px-3" defaultValue={formValue(record.targetKind) || "listing"} name="targetKind"><option value="listing">listing</option><option value="unit">unit</option></select></label>
          <label className="grid gap-1 text-sm font-medium text-slate-700">{language === "de" ? "Vertragsart" : "Contract type"}<select className="min-h-11 rounded-xl border border-slate-300 bg-white px-3" defaultValue={formValue(record.contractType) || "purchase"} name="contractType"><option value="purchase">purchase</option><option value="rent">rent</option><option value="lease">lease</option><option value="other">other</option></select></label>
          {field(language === "de" ? "Basisbetrag (Cent)" : "Base amount (minor units)", "baseAmountMinor", { defaultValue: record.baseAmountMinor || "0", required: true, type: "number" })}
          {field(language === "de" ? "Bruttocourtage (Cent)" : "Gross commission (minor units)", "grossCommissionMinor", { defaultValue: record.grossCommissionMinor || "0", required: true, type: "number" })}
          {field(language === "de" ? "Käufercourtage (Cent)" : "Buyer commission (minor units)", "buyerCommissionMinor", { defaultValue: record.buyerCommissionMinor || "0", required: true, type: "number" })}
          {field(language === "de" ? "Verkäufercourtage (Cent)" : "Seller commission (minor units)", "sellerCommissionMinor", { defaultValue: record.sellerCommissionMinor || "0", required: true, type: "number" })}
          {field(language === "de" ? "Netto (Cent)" : "Net (minor units)", "netCommissionMinor", { defaultValue: record.netCommissionMinor || "0", required: true, type: "number" })}
          {field(language === "de" ? "Steuer (Cent)" : "Tax (minor units)", "taxMinor", { defaultValue: record.taxMinor || "0", required: true, type: "number" })}
          {field(language === "de" ? "Vertragsdatum" : "Contract date", "contractDate", { defaultValue: record.contractDate, type: "date" })}
          {field(language === "de" ? "Abschlussdatum" : "Closing date", "closingDate", { defaultValue: record.closingDate, type: "date" })}
          <label className="grid gap-1 text-sm font-medium text-slate-700">{language === "de" ? "Status" : "Status"}<select className="min-h-11 rounded-xl border border-slate-300 bg-white px-3" defaultValue={formValue(record.status) || "draft"} name="status"><option value="draft">draft</option><option value="reviewed">reviewed</option><option value="signed">signed</option><option value="invoiced">invoiced</option><option value="paid">paid</option><option value="cancelled">cancelled</option><option value="reversed">reversed</option></select></label>
          <label className="grid gap-1 text-sm font-medium text-slate-700">{language === "de" ? "Zahlungsstatus" : "Payment status"}<select className="min-h-11 rounded-xl border border-slate-300 bg-white px-3" defaultValue={formValue(record.paymentStatus) || "unpaid"} name="paymentStatus"><option value="unpaid">unpaid</option><option value="partially_paid">partially_paid</option><option value="paid">paid</option><option value="overdue">overdue</option><option value="refunded">refunded</option></select></label>
          {field(language === "de" ? "Währung" : "Currency", "currency", { defaultValue: record.currency || "EUR", required: true })}
          <label className="md:col-span-2 grid gap-1 text-sm font-medium text-slate-700">{language === "de" ? "Interne Notiz" : "Internal note"}<textarea className="min-h-20 rounded-xl border border-slate-300 bg-white p-3" defaultValue={formValue(record.internalNotes)} name="internalNotes" /></label>
          <details className="md:col-span-2 rounded-xl border border-indigo-100 bg-white p-3"><summary className="flex min-h-11 cursor-pointer items-center font-medium">{language === "de" ? "Courtage-Aufteilung (JSON)" : "Commission splits (JSON)"}</summary><p className="mt-2 text-xs text-slate-600">{language === "de" ? "Für reviewed und spätere Status erforderlich. Die Serverprüfung erzwingt exakte Summen." : "Required for reviewed and later statuses. The server enforces exact totals."}</p><textarea className="mt-2 min-h-32 w-full rounded-xl border border-slate-300 bg-white p-3 font-mono text-xs" defaultValue={Array.isArray(record.commissionSplits) ? JSON.stringify(record.commissionSplits, null, 2) : ""} name="commissionSplits" placeholder='[{"side":"buyer","sourceSide":"buyer","allocationType":"absolute","amountMinor":"0","label":"Internal"}]' /></details>
        </fieldset> : null}

        <div className="md:col-span-2 flex justify-end"><button className="min-h-11 rounded-xl bg-slate-950 px-5 text-white disabled:opacity-50" disabled={saving} type="submit">{submit}</button></div>
      </form>
    );
  }

  function renderRecord(record: ApiRecord) {
    const id = stringValue(record.id);
    if (activeTab === "profiles") {
      const selected = selectedProfileId === id;
      return (
        <button
          aria-pressed={selected}
          className={`min-h-11 w-full rounded-2xl border p-4 text-left ${selected ? "border-blue-500 bg-blue-50" : "border-slate-200 bg-white"}`}
          key={id}
          onClick={() => setSelectedProfileId(id)}
          type="button"
        >
          <span className="block font-semibold text-slate-950">{stringValue(record.title)}</span>
          <span className="mt-1 block text-sm text-slate-600">{stringValue(record.status)} · v{stringValue(record.version)}</span>
          {canManage ? <span className="mt-2 block text-xs text-slate-500">{language === "de" ? "Auswählen und oben bearbeiten" : "Select and edit above"}</span> : null}
        </button>
      );
    }
    if (activeTab === "matches") {
      const decision = record.decision && typeof record.decision === "object" ? record.decision as ApiRecord : {};
      return (
        <article className="rounded-2xl border border-slate-200 bg-white p-4" key={`${stringValue(record.targetKind)}:${stringValue(record.targetId)}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <strong>{stringValue(record.targetKind)} · {stringValue(record.targetId)}</strong>
            <span className="rounded-full bg-slate-100 px-3 py-1 text-sm">{stringValue(record.score, "0")}/100</span>
          </div>
          <p className="mt-2 text-sm text-slate-600">
            {stringValue(record.availability)} · {stringValue(decision.status, "new")} ·
            {` +${arrayLength(record.matchedCriteria)} / -${arrayLength(record.violatedCriteria)}`}
          </p>
        </article>
      );
    }
    if (activeTab === "offers") {
      return (
        <article className="rounded-2xl border border-slate-200 bg-white p-4" key={id}>
          <strong>{stringValue(record.subject)}</strong>
          <p className="mt-1 text-sm text-slate-600">{stringValue(record.recipientEmail)} · {stringValue(record.status)} · v{stringValue(record.currentVersion)}</p>
          {record.status === "ready" && canManage ? (
            <button className="mt-3 min-h-11 rounded-xl border border-slate-300 px-4" onClick={() => void requestQaDelivery(id)} type="button">
              QA-Delivery prüfen
            </button>
          ) : null}
          {canManage ? <button className="ml-2 mt-3 min-h-11 rounded-xl border border-slate-300 px-4" onClick={() => setEditor({ record, tab: "offers" })} type="button">{language === "de" ? "Bearbeiten" : "Edit"}</button> : null}
        </article>
      );
    }
    if (activeTab === "viewings") {
      return (
        <article className="rounded-2xl border border-slate-200 bg-white p-4" key={id}>
          <strong>{stringValue(record.addressText)}</strong>
          <p className="mt-1 text-sm text-slate-600">{dateTime(record.startsAt, language)} · {stringValue(record.status)}</p>
          <p className="mt-1 text-xs text-slate-500">Invite: {stringValue(record.invitationStatus)}</p>
          {canManage ? <button className="mt-3 min-h-11 rounded-xl border border-slate-300 px-4" onClick={() => setEditor({ record, tab: "viewings" })} type="button">{language === "de" ? "Bearbeiten" : "Edit"}</button> : null}
        </article>
      );
    }
    if (activeTab === "activities") {
      return (
        <article className="rounded-2xl border border-slate-200 bg-white p-4" key={id}>
          <strong>{stringValue(record.title)}</strong>
          <p className="mt-1 text-sm text-slate-600">{stringValue(record.activityType)} · {dateTime(record.occurredAt, language)}</p>
        </article>
      );
    }
    const selected = activeTab === "closings" && id === initialSelectedClosingId;
    return (
      <article
        aria-current={selected ? "true" : undefined}
        className={`rounded-2xl border bg-white p-4 outline-none ${selected ? "border-indigo-500 ring-2 ring-indigo-200" : "border-slate-200"}`}
        key={id}
        ref={selected ? selectedClosingRef : undefined}
        tabIndex={selected ? -1 : undefined}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <strong>{stringValue(record.contractType)} · {stringValue(record.status)}</strong>
          <span className="text-sm text-slate-600">v{stringValue(record.version)}</span>
        </div>
        <p className="mt-1 text-sm text-slate-600">
          {record.financialsVisible === false ? "Financials restricted" : `${stringValue(record.grossCommissionMinor, "0")} ${stringValue(record.currency)}`}
        </p>
        {canManage && financialsAvailable ? <button className="mt-3 min-h-11 rounded-xl border border-slate-300 px-4" onClick={() => setEditor({ record, tab: "closings" })} type="button">{language === "de" ? "Bearbeiten" : "Edit"}</button> : null}
      </article>
    );
  }

  return (
    <section aria-labelledby="broker-operations-title" className={`rounded-3xl border border-slate-200 bg-slate-50 p-4 sm:p-6 ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-slate-950" id="broker-operations-title">{text.title}</h2>
          <p className="mt-1 text-sm text-slate-600">Project {projectId}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canManage && activeTab !== "matches" && (activeTab !== "closings" || financialsAvailable) ? (
            <button className="min-h-11 rounded-xl bg-indigo-700 px-4 text-white" onClick={() => setEditor({ tab: activeTab })} type="button">
              {language === "de" ? "Neu anlegen" : "Create"}
            </button>
          ) : null}
          {canManage && activeTab === "profiles" && selectedProfileId ? (
            <button
              className="min-h-11 rounded-xl border border-slate-300 bg-white px-4"
              onClick={() => setEditor({ record: profiles.find((profile) => formValue(profile.id) === selectedProfileId), tab: "profiles" })}
              type="button"
            >
              {language === "de" ? "Ausgewähltes Profil bearbeiten" : "Edit selected profile"}
            </button>
          ) : null}
          {canManage && financialsAvailable && activeTab === "closings" ? (
            <>
              <a className="inline-flex min-h-11 items-center rounded-xl border border-slate-300 bg-white px-4" href={closingsExportHref}>
                {language === "de" ? "CSV exportieren" : "Export CSV"}
              </a>
              <a
                className="inline-flex min-h-11 items-center rounded-xl border border-slate-300 bg-white px-4"
                href={closingsPdfHref}
                onClick={() => setNotice(language === "de"
                  ? "Der PDF-Bericht ist ein operativer Export, keine Rechnung und kein signierter Vertrag."
                  : "The PDF is an operational report, not an invoice or signed contract.")}
              >
                {language === "de" ? "PDF-Bericht exportieren" : "Export PDF report"}
              </a>
            </>
          ) : null}
          {activeTab === "matches" && canManage ? (
            <button className="min-h-11 rounded-xl bg-slate-950 px-4 text-white disabled:opacity-50" disabled={!selectedProfileId || loading} onClick={() => void recalculate()} type="button">
              {text.recalculate}
            </button>
          ) : null}
          <button className="min-h-11 rounded-xl border border-slate-300 bg-white px-4 disabled:opacity-50" disabled={loading} onClick={() => void load()} type="button">
            {text.refresh}
          </button>
        </div>
      </div>

      <div aria-label={text.title} className="mt-5 flex gap-2 overflow-x-auto pb-2" role="tablist">
        {tabOrder.map((tab) => (
          <button
            aria-selected={activeTab === tab}
            className={`min-h-11 shrink-0 rounded-xl px-4 ${activeTab === tab ? "bg-slate-950 text-white" : "border border-slate-300 bg-white text-slate-800"}`}
            key={tab}
            onClick={() => setActiveTab(tab)}
            role="tab"
            type="button"
          >
            {text.tabs[tab]}
          </button>
        ))}
      </div>

      <div aria-live="polite" className="mt-4 min-h-6 text-sm">
        {loading ? text.loading : error ? <span className="text-red-700">{error}</span> : notice ? <span className="text-amber-800">{notice}</span> : null}
      </div>

      {renderEditor()}

      {activeTab === "matches" && !selectedProfileId ? (
        <p className="mt-3 rounded-2xl border border-dashed border-slate-300 bg-white p-5 text-slate-600">{text.noProfile}</p>
      ) : !loading && !error && items.length === 0 ? (
        <p className="mt-3 rounded-2xl border border-dashed border-slate-300 bg-white p-5 text-slate-600">{text.empty}</p>
      ) : (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">{items.map(renderRecord)}</div>
      )}

      {profiles.length > 0 && activeTab !== "profiles" ? (
        <label className="mt-5 block text-sm font-medium text-slate-700">
          {text.tabs.profiles}
          <select className="mt-2 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3" onChange={(event) => setSelectedProfileId(event.target.value)} value={selectedProfileId}>
            {profiles.map((profile) => (
              <option key={stringValue(profile.id)} value={stringValue(profile.id)}>{stringValue(profile.title)}</option>
            ))}
          </select>
        </label>
      ) : null}
    </section>
  );
}
