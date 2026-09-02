"use client";

import {
  useCallback,
  useEffect,
  useState,
  type ButtonHTMLAttributes,
  type FormEvent,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { csrfFetch } from "@/lib/security/csrf-client";

export type PrivacyLifecyclePanelProps = {
  workspaceId: string;
  language: "de" | "en";
  canManage: boolean;
};

type Policy = {
  id: string;
  entityType: string;
  inactivityDays: number;
  proposedAction: string;
  legalBasis: string;
  isActive: boolean;
  updatedAt: string;
};
type Review = {
  id: string;
  entityType: string;
  entityId: string;
  proposedAction: string;
  rationale: string;
  status: string;
  legalHoldBlocked: boolean;
  updatedAt: string;
};
type LegalHold = {
  id: string;
  entityType: string;
  entityId: string | null;
  reason: string;
  reference: string;
  startsAt: string;
  expiresAt: string | null;
  releasedAt: string | null;
  updatedAt: string;
};
type DataRequest = {
  id: string;
  contactId: string | null;
  requestReference: string;
  requestType: string;
  status: string;
  identityVerifiedAt: string | null;
  legalHoldBlocked: boolean;
  updatedAt: string;
};
type Overview = {
  policies: Policy[];
  reviews: Review[];
  legalHolds: LegalHold[];
  dataSubjectRequests: DataRequest[];
  automaticHardDeleteEnabled: false;
};

const entityTypes = ["contact", "organization", "lead", "project", "property", "unit", "deal", "task", "document", "template"];

const copy = {
  de: {
    title: "Datenschutz-Lifecycle",
    description: "Aufbewahrung, Legal Holds und Betroffenenanfragen mit verpflichtender manueller Prüfung.",
    safety: "Sicherheitsgrenze: Es gibt keine automatische endgültige Löschung. Entscheidungen lösen keine Datenvernichtung aus.",
    denied: "Dieser Bereich ist Eigentümern, Administratoren und ausdrücklich autorisierten Produktrollen vorbehalten.",
    policies: "Aufbewahrungsregeln",
    reviews: "Prüfvorschläge",
    holds: "Legal Holds",
    requests: "Betroffenenanfragen",
    savePolicy: "Regel speichern",
    proposeReview: "Prüfung vorschlagen",
    createHold: "Legal Hold anlegen",
    createRequest: "Anfrage erfassen",
    save: "Speichern",
    release: "Freigeben",
    approveArchive: "Archivierung freigeben",
    approveAnonymize: "Anonymisierung freigeben",
    approveDelete: "Löschplan freigeben (keine Löschung)",
    reject: "Ablehnen",
    startReview: "Prüfung starten",
    startIdentityCheck: "Identitätsprüfung starten",
    verifyIdentity: "Identität bestätigt – Prüfung starten",
    approveRequest: "Anfrage freigeben",
    cancel: "Abbrechen",
    waitingForOperation: "Freigegeben; wartet auf getrennte Ausführung und unveränderlichen Nachweis.",
    scheduled: "geplant",
    active: "aktiv",
    expired: "abgelaufen",
    released: "freigegeben",
    exportMetadata: "Export-Metadaten als CSV",
    empty: "Keine Einträge.",
    loading: "Datenschutzdaten werden geladen …",
  },
  en: {
    title: "Privacy lifecycle",
    description: "Retention, legal holds and data-subject requests with mandatory manual review.",
    safety: "Safety boundary: there is no automatic permanent deletion. Decisions do not destroy data.",
    denied: "This area is restricted to owners, administrators, and explicitly authorized product roles.",
    policies: "Retention policies",
    reviews: "Review proposals",
    holds: "Legal holds",
    requests: "Data-subject requests",
    savePolicy: "Save policy",
    proposeReview: "Propose review",
    createHold: "Create legal hold",
    createRequest: "Record request",
    save: "Save",
    release: "Release",
    approveArchive: "Approve archiving",
    approveAnonymize: "Approve anonymization",
    approveDelete: "Approve deletion plan (no deletion)",
    reject: "Reject",
    startReview: "Start review",
    startIdentityCheck: "Start identity check",
    verifyIdentity: "Identity verified – start review",
    approveRequest: "Approve request",
    cancel: "Cancel",
    waitingForOperation: "Approved; waiting for separate execution and immutable evidence.",
    scheduled: "scheduled",
    active: "active",
    expired: "expired",
    released: "released",
    exportMetadata: "Export metadata as CSV",
    empty: "No entries.",
    loading: "Loading privacy data…",
  },
} as const;

function mutationKey() {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function parseResponse(response: Response) {
  const payload = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

export function PrivacyLifecyclePanel({ workspaceId, language, canManage }: PrivacyLifecyclePanelProps) {
  const t = copy[language];
  const [tab, setTab] = useState<"policies" | "reviews" | "holds" | "requests">("policies");
  const [overview, setOverview] = useState<Overview>({ policies: [], reviews: [], legalHolds: [],
    dataSubjectRequests: [], automaticHardDeleteEnabled: false });
  const [loading, setLoading] = useState(canManage);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [observedAt, setObservedAt] = useState(0);

  const load = useCallback(async () => {
    if (!canManage) return;
    setLoading(true);
    try {
      const response = await fetch(`/api/crm/privacy?workspaceId=${encodeURIComponent(workspaceId)}`, {
        cache: "no-store", credentials: "same-origin",
      });
      setOverview(await parseResponse(response) as Overview);
      setObservedAt(Date.now());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }, [canManage, workspaceId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function mutate(path: string, method: "POST" | "PATCH", body: Record<string, unknown>) {
    setBusy(true);
    setMessage("");
    try {
      const response = await csrfFetch(`/api/crm/privacy/${path}?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method,
        headers: { "Content-Type": "application/json", "Idempotency-Key": mutationKey() },
        body: JSON.stringify(body),
      });
      await parseResponse(response);
      setMessage(language === "de" ? "Änderung gespeichert. Es wurde nichts endgültig gelöscht." : "Change saved. Nothing was permanently deleted.");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  function savePolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const entityType = String(form.get("entityType"));
    const current = overview.policies.find((policy) => policy.entityType === entityType);
    void mutate("policies", "POST", {
      entityType,
      inactivityDays: Number(form.get("inactivityDays")),
      proposedAction: form.get("proposedAction"),
      legalBasis: form.get("legalBasis"),
      isActive: true,
      expectedUpdatedAt: current?.updatedAt,
    });
  }

  function proposeReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void mutate("reviews", "POST", {
      entityType: form.get("entityType"), entityId: form.get("entityId"),
      proposedAction: form.get("proposedAction"), rationale: form.get("rationale"),
    });
  }

  function createHold(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const entityType = String(form.get("entityType"));
    void mutate("holds", "POST", {
      entityType,
      entityId: entityType === "workspace" ? null : form.get("entityId"),
      reason: form.get("reason"), reference: form.get("reference"),
      startsAt: form.get("startsAt") || null, expiresAt: form.get("expiresAt") || null,
    });
  }

  function createRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void mutate("requests", "POST", {
      contactId: form.get("contactId") || null, requestReference: form.get("requestReference"),
      requestType: form.get("requestType"), reviewNote: form.get("reviewNote"),
    });
  }

  if (!canManage) {
    return <section aria-labelledby="privacy-lifecycle-title" className="rounded-2xl border border-slate-200 bg-white p-5">
      <h2 id="privacy-lifecycle-title" className="text-xl font-semibold text-slate-950">{t.title}</h2>
      <p className="mt-2 text-sm text-slate-600">{t.denied}</p>
    </section>;
  }

  return <section className="space-y-5" aria-labelledby="privacy-lifecycle-title">
    <div>
      <h2 id="privacy-lifecycle-title" className="text-xl font-semibold text-slate-950">{t.title}</h2>
      <p className="mt-1 text-sm text-slate-600">{t.description}</p>
      <p className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm font-medium text-amber-950" role="note">{t.safety}</p>
    </div>
    <div className="flex flex-wrap gap-2" role="tablist">
      {(["policies", "reviews", "holds", "requests"] as const).map((value) => (
        <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)}
          className={`min-h-11 rounded-xl px-4 text-sm font-semibold ${tab === value ? "bg-slate-950 text-white" : "border border-slate-300 bg-white text-slate-700"}`}>
          {t[value]}
        </button>
      ))}
    </div>
    <p className="min-h-6 text-sm text-slate-700" role="status" aria-live="polite">{loading ? t.loading : message}</p>

    {tab === "policies" && <div className="space-y-4">
      <form onSubmit={savePolicy} className="grid gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 md:grid-cols-2">
        <h3 className="font-semibold text-slate-900 md:col-span-2">{t.savePolicy}</h3>
        <SelectField name="entityType" label="Entity" values={entityTypes} />
        <Field name="inactivityDays" label={language === "de" ? "Inaktive Tage" : "Inactive days"} type="number" min="1" max="36500" required defaultValue="2555" />
        <SelectField name="proposedAction" label={language === "de" ? "Vorschlag" : "Proposal"}
          values={["propose_archive", "propose_anonymize", "propose_delete"]} />
        <Field name="legalBasis" label={language === "de" ? "Rechtsgrundlage" : "Legal basis"} required />
        <SaveButton busy={busy}>{t.save}</SaveButton>
      </form>
      <CardList empty={t.empty}>{overview.policies.map((policy) => <article key={policy.id} className="rounded-xl border border-slate-200 p-4">
        <h3 className="font-semibold text-slate-950">{policy.entityType}</h3>
        <p className="mt-1 text-sm text-slate-600">{policy.inactivityDays} days · {policy.proposedAction}</p>
        <p className="mt-2 text-sm text-slate-700">{policy.legalBasis}</p>
      </article>)}</CardList>
    </div>}

    {tab === "reviews" && <div className="space-y-4">
      <form onSubmit={proposeReview} className="grid gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 md:grid-cols-2">
        <h3 className="font-semibold text-slate-900 md:col-span-2">{t.proposeReview}</h3>
        <SelectField name="entityType" label="Entity" values={entityTypes} />
        <Field name="entityId" label="Entity UUID" required />
        <SelectField name="proposedAction" label={language === "de" ? "Vorschlag" : "Proposal"}
          values={["propose_archive", "propose_anonymize", "propose_delete"]} />
        <Field name="rationale" label={language === "de" ? "Begründung" : "Rationale"} required />
        <SaveButton busy={busy}>{t.save}</SaveButton>
      </form>
      <CardList empty={t.empty}>{overview.reviews.map((review) => <article key={review.id} className="rounded-xl border border-slate-200 p-4">
        <div className="flex flex-wrap justify-between gap-2"><h3 className="font-semibold text-slate-950">{review.entityType} · {review.entityId.slice(0, 8)}</h3>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold">{review.status}</span></div>
        <p className="mt-2 text-sm text-slate-700">{review.rationale}</p>
        {review.legalHoldBlocked && <p className="mt-2 text-sm font-semibold text-amber-800">Legal hold blocked</p>}
        {review.status === "proposed" && <div className="mt-3 flex flex-wrap gap-2">
          <SmallButton disabled={busy} onClick={() => void mutate(`reviews/${review.id}`, "PATCH", { status: "in_review", decisionNote: "Manual review started", expectedUpdatedAt: review.updatedAt })}>{t.startReview}</SmallButton>
          <SmallButton disabled={busy} onClick={() => void mutate(`reviews/${review.id}`, "PATCH", { status: "rejected", decisionNote: "Rejected after manual review", expectedUpdatedAt: review.updatedAt })}>{t.reject}</SmallButton>
        </div>}
        {review.status === "in_review" && <div className="mt-3 flex flex-wrap gap-2">
          {review.proposedAction === "propose_archive" && <SmallButton disabled={busy || review.legalHoldBlocked}
            onClick={() => void mutate(`reviews/${review.id}`, "PATCH", { status: "approved_archive", decisionNote: "Manual archive approval; no operation performed", expectedUpdatedAt: review.updatedAt })}>{t.approveArchive}</SmallButton>}
          {review.proposedAction === "propose_anonymize" && <SmallButton disabled={busy || review.legalHoldBlocked}
            onClick={() => void mutate(`reviews/${review.id}`, "PATCH", { status: "approved_anonymize", decisionNote: "Manual anonymization approval; no operation performed", expectedUpdatedAt: review.updatedAt })}>{t.approveAnonymize}</SmallButton>}
          {review.proposedAction === "propose_delete" && <SmallButton disabled={busy || review.legalHoldBlocked}
            onClick={() => void mutate(`reviews/${review.id}`, "PATCH", { status: "approved_delete", decisionNote: "Manual deletion-plan approval; no deletion performed", expectedUpdatedAt: review.updatedAt })}>{t.approveDelete}</SmallButton>}
          <SmallButton disabled={busy} onClick={() => void mutate(`reviews/${review.id}`, "PATCH", { status: "rejected", decisionNote: "Rejected after manual review", expectedUpdatedAt: review.updatedAt })}>{t.reject}</SmallButton>
        </div>}
        {review.status.startsWith("approved_") && <p className="mt-2 text-sm text-slate-600">{t.waitingForOperation}</p>}
      </article>)}</CardList>
    </div>}

    {tab === "holds" && <div className="space-y-4">
      <form onSubmit={createHold} className="grid gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 md:grid-cols-2">
        <h3 className="font-semibold text-slate-900 md:col-span-2">{t.createHold}</h3>
        <SelectField name="entityType" label="Entity" values={["workspace", ...entityTypes]} />
        <Field name="entityId" label="Entity UUID (not for workspace)" />
        <Field name="reason" label={language === "de" ? "Begründung" : "Reason"} required />
        <Field name="reference" label={language === "de" ? "Aktenzeichen" : "Reference"} />
        <Field name="startsAt" label={language === "de" ? "Beginn (optional)" : "Starts (optional)"} type="datetime-local" />
        <Field name="expiresAt" label={language === "de" ? "Ende (optional)" : "Expires (optional)"} type="datetime-local" />
        <SaveButton busy={busy}>{t.save}</SaveButton>
      </form>
      <CardList empty={t.empty}>{overview.legalHolds.map((hold) => {
        const holdState = hold.releasedAt
          ? "released"
          : Date.parse(hold.startsAt) > observedAt
            ? "scheduled"
            : hold.expiresAt && Date.parse(hold.expiresAt) <= observedAt
              ? "expired"
              : "active";
        return <article key={hold.id} className="rounded-xl border border-slate-200 p-4">
        <div className="flex flex-wrap justify-between gap-2"><h3 className="font-semibold text-slate-950">{hold.entityType}{hold.entityId ? ` · ${hold.entityId.slice(0, 8)}` : ""}</h3>
          <span className="text-xs font-semibold text-slate-600">{t[holdState]}</span></div>
        <p className="mt-2 text-sm text-slate-700">{hold.reason}</p>
        {!hold.releasedAt && <SmallButton disabled={busy} onClick={() => void mutate(`holds/${hold.id}`, "PATCH", {
          expectedUpdatedAt: hold.updatedAt, releaseNote: "Released after manual review",
        })}>{t.release}</SmallButton>}
      </article>})}</CardList>
    </div>}

    {tab === "requests" && <div className="space-y-4">
      <form onSubmit={createRequest} className="grid gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 md:grid-cols-2">
        <h3 className="font-semibold text-slate-900 md:col-span-2">{t.createRequest}</h3>
        <Field name="requestReference" label={language === "de" ? "Referenz" : "Reference"} required />
        <Field name="contactId" label="Contact UUID" />
        <SelectField name="requestType" label={language === "de" ? "Anfragetyp" : "Request type"}
          values={["access", "export", "rectification", "erasure", "restriction", "objection"]} />
        <Field name="reviewNote" label={language === "de" ? "Prüfnotiz" : "Review note"} />
        <SaveButton busy={busy}>{t.save}</SaveButton>
      </form>
      <CardList empty={t.empty}>{overview.dataSubjectRequests.map((request) => <article key={request.id} className="rounded-xl border border-slate-200 p-4">
        <div className="flex flex-wrap justify-between gap-2"><h3 className="font-semibold text-slate-950">{request.requestReference}</h3>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold">{request.status}</span></div>
        <p className="mt-1 text-sm text-slate-600">{request.requestType}{request.legalHoldBlocked ? " · Legal hold blocked" : ""}</p>
        {request.identityVerifiedAt && <p className="mt-1 text-sm text-slate-600">
          {language === "de" ? "Identität bestätigt" : "Identity verified"}
        </p>}
        {request.status === "received" && <div className="mt-3 flex flex-wrap gap-2">
          <SmallButton disabled={busy} onClick={() => void mutate(`requests/${request.id}`, "PATCH", {
            status: "identity_check", reviewNote: "Identity verification started", expectedUpdatedAt: request.updatedAt,
          })}>{t.startIdentityCheck}</SmallButton>
          <SmallButton disabled={busy} onClick={() => void mutate(`requests/${request.id}`, "PATCH", {
            status: "cancelled", reviewNote: "Cancelled after manual review", expectedUpdatedAt: request.updatedAt,
          })}>{t.cancel}</SmallButton>
        </div>}
        {request.status === "identity_check" && <div className="mt-3 flex flex-wrap gap-2">
          <SmallButton disabled={busy} onClick={() => void mutate(`requests/${request.id}`, "PATCH", {
            status: "in_review", identityVerifiedAt: request.identityVerifiedAt ?? new Date().toISOString(),
            reviewNote: "Identity manually verified; substantive review started", expectedUpdatedAt: request.updatedAt,
          })}>{t.verifyIdentity}</SmallButton>
          <SmallButton disabled={busy} onClick={() => void mutate(`requests/${request.id}`, "PATCH", {
            status: "rejected", reviewNote: "Rejected after identity review", expectedUpdatedAt: request.updatedAt,
          })}>{t.reject}</SmallButton>
          <SmallButton disabled={busy} onClick={() => void mutate(`requests/${request.id}`, "PATCH", {
            status: "cancelled", reviewNote: "Cancelled during identity review", expectedUpdatedAt: request.updatedAt,
          })}>{t.cancel}</SmallButton>
        </div>}
        {request.status === "in_review" && <div className="mt-3 flex flex-wrap gap-2">
          <SmallButton disabled={busy || (request.requestType === "erasure" && request.legalHoldBlocked)}
            onClick={() => void mutate(`requests/${request.id}`, "PATCH", {
              status: "approved", reviewNote: "Approved after manual review; no operation performed", expectedUpdatedAt: request.updatedAt,
            })}>{t.approveRequest}</SmallButton>
          <SmallButton disabled={busy} onClick={() => void mutate(`requests/${request.id}`, "PATCH", {
            status: "rejected", reviewNote: "Rejected after substantive review", expectedUpdatedAt: request.updatedAt,
          })}>{t.reject}</SmallButton>
          <SmallButton disabled={busy} onClick={() => void mutate(`requests/${request.id}`, "PATCH", {
            status: "cancelled", reviewNote: "Cancelled during substantive review", expectedUpdatedAt: request.updatedAt,
          })}>{t.cancel}</SmallButton>
        </div>}
        {request.status === "approved" && <p className="mt-2 text-sm text-slate-600">{t.waitingForOperation}</p>}
        <a href={`/api/crm/privacy/requests/${request.id}/export?workspaceId=${encodeURIComponent(workspaceId)}`}
          className="mt-3 inline-flex min-h-11 items-center rounded-xl border border-slate-300 px-3 text-sm font-semibold text-slate-800 hover:bg-slate-50">
          {t.exportMetadata}
        </a>
      </article>)}</CardList>
    </div>}
  </section>;
}

function Field(props: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const { label, ...inputProps } = props;
  return <label className="text-sm font-medium text-slate-700">{label}
    <input {...inputProps} className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 px-3 outline-none focus:ring-2 focus:ring-slate-200" />
  </label>;
}

function SelectField({ name, label, values }: { name: string; label: string; values: readonly string[] }) {
  return <label className="text-sm font-medium text-slate-700">{label}
    <select name={name} className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3">
      {values.map((value) => <option key={value} value={value}>{value}</option>)}
    </select>
  </label>;
}

function SaveButton({ busy, children }: { busy: boolean; children: ReactNode }) {
  return <button disabled={busy} className="min-h-11 self-end rounded-xl bg-slate-950 px-4 font-semibold text-white disabled:opacity-40">{children}</button>;
}

function SmallButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...props} className="mt-3 min-h-11 rounded-xl border border-slate-300 px-3 text-sm font-semibold hover:bg-slate-50 disabled:opacity-40" />;
}

function CardList({ children, empty }: { children: ReactNode; empty: string }) {
  const entries = Array.isArray(children) ? children : [children];
  return <div className="space-y-3">{entries.length && entries.some(Boolean) ? children
    : <p className="rounded-xl border border-dashed border-slate-300 p-6 text-sm text-slate-600">{empty}</p>}</div>;
}
