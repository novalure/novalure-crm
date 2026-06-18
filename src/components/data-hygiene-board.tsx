"use client";

import { useEffect, useMemo, useState } from "react";
import type { ConsentRecord, Contact, Lead, Project, WorkspaceUser } from "@/lib/crm-types";
import {
  analyzeDataHygiene,
  type DataHygieneIssue,
  type DataHygieneIssueKind,
} from "@/lib/crm-analysis";
import {
  formatDate,
  formatNumber,
  getCrmSystemTextLabel,
  getDataHygieneBoardCopy,
  type LanguageCode,
} from "@/lib/i18n";

type DataHygieneBoardProps = {
  consents: ConsentRecord[];
  contacts: Contact[];
  language: LanguageCode;
  leads: Lead[];
  projectLabel: string;
  projects: Project[];
  users: WorkspaceUser[];
};

type EntityFilter = "all" | DataHygieneIssue["entityType"];
type SeverityFilter = "all" | DataHygieneIssue["severity"];
type HygieneActionId =
  | "checkConsent"
  | "cleanupHistory"
  | "closeLead"
  | "completeContact"
  | "mergeDuplicate"
  | "notifyOwner"
  | "quickEditContact";
type PersistedIssueStatus = "open" | "resolved" | "ignored";

type IssueView = {
  contact?: Contact;
  issue: DataHygieneIssue;
  lead?: Lead;
  ownerName: string;
  primaryLabel: string;
  projectLabel: string;
};

type DataQualityApiIssue = {
  clientIssueId: string;
  status: PersistedIssueStatus;
};

const issueKindOrder: DataHygieneIssueKind[] = [
  "missingContactRoute",
  "missingConsent",
  "duplicateEmail",
  "duplicatePhone",
  "staleLead",
  "missingNextAction",
];

const severityStyles: Record<DataHygieneIssue["severity"], string> = {
  risk: "border-rose-200 bg-rose-50 text-rose-900",
  warning: "border-amber-200 bg-amber-50 text-amber-900",
};

const filterButtonStyles = {
  active: "border-slate-950 bg-slate-950 text-white",
  inactive: "border-stone-300 bg-white text-slate-800 hover:bg-stone-100",
};

function getIssueActions(issue: DataHygieneIssue): HygieneActionId[] {
  switch (issue.kind) {
    case "missingContactRoute":
      return ["quickEditContact", "notifyOwner"];
    case "duplicateEmail":
    case "duplicatePhone":
      return ["mergeDuplicate", "completeContact", "notifyOwner"];
    case "missingConsent":
      return ["checkConsent", "notifyOwner"];
    case "staleLead":
    case "missingNextAction":
      return ["closeLead", "notifyOwner"];
  }
}

function normalizePhone(value: string | undefined) {
  return (value ?? "").replace(/^00/, "").replace(/[^0-9]/g, "");
}

function toDataQualityIssuePayload(issue: DataHygieneIssue) {
  const entityId = issue.entityType === "lead" ? issue.leadId : issue.contactId;

  return {
    clientIssueId: issue.id,
    contactId: issue.contactId ?? null,
    detail: issue.entityLabel,
    entityId: entityId ?? null,
    entityLabel: issue.entityLabel,
    entityType: issue.entityType,
    issueType: issue.kind,
    leadId: issue.leadId ?? null,
    metadata: {
      duplicateCount: issue.duplicateCount ?? null,
      duplicateKey: issue.duplicateKey ?? null,
      lastContactAt: issue.lastContactAt ?? null,
    },
    nextAction: issue.nextAction ?? "",
    ownerUserId: issue.ownerUserId ?? null,
    projectId: issue.projectId,
    severity: issue.severity,
  };
}

export function DataHygieneBoard({
  consents,
  contacts,
  language,
  leads,
  projectLabel,
  projects,
  users,
}: DataHygieneBoardProps) {
  const text = getDataHygieneBoardCopy(language);
  const [entityFilter, setEntityFilter] = useState<EntityFilter>("all");
  const [kindFilter, setKindFilter] = useState<DataHygieneIssueKind | "all">("all");
  const [notice, setNotice] = useState("");
  const [busyIssueIds, setBusyIssueIds] = useState<Record<string, boolean>>({});
  const [hiddenIssueIds, setHiddenIssueIds] = useState<Set<string>>(() => new Set());
  const [projectFilter, setProjectFilter] = useState("all");
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("all");

  const issues = useMemo(
    () => analyzeDataHygiene(contacts, leads, consents),
    [consents, contacts, leads],
  );

  useEffect(() => {
    if (!issues.length) return;

    const controller = new AbortController();

    async function syncIssues() {
      try {
        const response = await fetch("/api/crm/data-quality", {
          body: JSON.stringify({
            issues: issues.map(toDataQualityIssuePayload),
            operation: "sync",
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
          signal: controller.signal,
        });

        if (!response.ok) return;

        const data = await response.json() as { issues?: DataQualityApiIssue[] };
        const savedIssues = Array.isArray(data.issues) ? data.issues : [];
        const closedIssueIds = savedIssues
          .filter((issue) => issue.status !== "open")
          .map((issue) => issue.clientIssueId);

        if (closedIssueIds.length) {
          setHiddenIssueIds((current) => {
            const next = new Set(current);
            closedIssueIds.forEach((id) => next.add(id));
            return next;
          });
        }
      } catch (error) {
        if ((error as { name?: string }).name !== "AbortError") {
          setNotice(text.saveError);
        }
      }
    }

    void syncIssues();

    return () => controller.abort();
  }, [issues, text.saveError]);

  const visibleIssues = useMemo(
    () => issues.filter((issue) => !hiddenIssueIds.has(issue.id)),
    [hiddenIssueIds, issues],
  );

  const issueViews = useMemo<IssueView[]>(() => {
    return visibleIssues.map((issue) => {
      const contact = issue.contactId
        ? contacts.find((item) => item.id === issue.contactId)
        : undefined;
      const lead = issue.leadId ? leads.find((item) => item.id === issue.leadId) : undefined;
      const project = projects.find((item) => item.id === issue.projectId);
      const owner = issue.ownerUserId
        ? users.find((item) => item.id === issue.ownerUserId)
        : undefined;

      return {
        contact,
        issue,
        lead,
        ownerName: owner?.name ?? text.fields.unknown,
        primaryLabel: contact?.name ?? issue.entityLabel,
        projectLabel: project?.name ?? text.fields.unassignedProject,
      };
    });
  }, [contacts, leads, projects, text.fields.unassignedProject, text.fields.unknown, users, visibleIssues]);

  const filteredIssueViews = useMemo(() => {
    return issueViews.filter(({ issue }) => {
      const matchesSeverity = severityFilter === "all" || issue.severity === severityFilter;
      const matchesProject = projectFilter === "all" || issue.projectId === projectFilter;
      const matchesEntity = entityFilter === "all" || issue.entityType === entityFilter;
      const matchesKind = kindFilter === "all" || issue.kind === kindFilter;

      return matchesSeverity && matchesProject && matchesEntity && matchesKind;
    });
  }, [entityFilter, issueViews, kindFilter, projectFilter, severityFilter]);

  const projectGroups = useMemo(() => {
    const groups = new Map<string, { id: string; label: string; issues: IssueView[] }>();

    filteredIssueViews.forEach((view) => {
      const group = groups.get(view.issue.projectId) ?? {
        id: view.issue.projectId,
        issues: [],
        label: view.projectLabel,
      };

      group.issues.push(view);
      groups.set(view.issue.projectId, group);
    });

    return Array.from(groups.values()).sort((left, right) => {
      const leftRisks = left.issues.filter((view) => view.issue.severity === "risk").length;
      const rightRisks = right.issues.filter((view) => view.issue.severity === "risk").length;
      return rightRisks - leftRisks || right.issues.length - left.issues.length;
    });
  }, [filteredIssueViews]);

  const projectOptions = useMemo(() => {
    const projectIds = Array.from(new Set(issueViews.map((view) => view.issue.projectId)));
    return projectIds
      .map((id) => ({
        id,
        label: projects.find((project) => project.id === id)?.name ?? text.fields.unassignedProject,
      }))
      .sort((left, right) => left.label.localeCompare(right.label));
  }, [issueViews, projects, text.fields.unassignedProject]);

  const metrics = {
    duplicates: visibleIssues.filter((issue) => issue.kind === "duplicateEmail" || issue.kind === "duplicatePhone").length,
    missingConsent: visibleIssues.filter((issue) => issue.kind === "missingConsent").length,
    missingNextAction: visibleIssues.filter((issue) => issue.kind === "missingNextAction").length,
    missingRoutes: visibleIssues.filter((issue) => issue.kind === "missingContactRoute").length,
    openIssues: visibleIssues.length,
    risks: visibleIssues.filter((issue) => issue.severity === "risk").length,
    staleLeads: visibleIssues.filter((issue) => issue.kind === "staleLead").length,
    warnings: visibleIssues.filter((issue) => issue.severity === "warning").length,
  };

  function findDuplicateContactId(issue: DataHygieneIssue) {
    if (!issue.contactId || !issue.duplicateKey) return null;

    if (issue.kind === "duplicateEmail") {
      const key = issue.duplicateKey.toLowerCase();
      return contacts.find((contact) => contact.id !== issue.contactId && contact.email?.toLowerCase() === key)?.id ?? null;
    }

    if (issue.kind === "duplicatePhone") {
      const key = normalizePhone(issue.duplicateKey);
      return contacts.find((contact) => contact.id !== issue.contactId && normalizePhone(contact.phone) === key)?.id ?? null;
    }

    return null;
  }

  async function prepareAction(actionId: HygieneActionId, issue: DataHygieneIssue, label: string) {
    setBusyIssueIds((current) => ({ ...current, [issue.id]: true }));

    try {
      const isCleanupAction = actionId === "mergeDuplicate" || actionId === "quickEditContact" || actionId === "cleanupHistory";
      const response = isCleanupAction
        ? await fetch("/api/crm/recommendation-runtime", {
            body: JSON.stringify({
              actionType: actionId,
              contactId: issue.contactId ?? null,
              duplicateContactId: findDuplicateContactId(issue),
              issueId: null,
              leadId: issue.leadId ?? null,
              operation: actionId === "mergeDuplicate" ? "contact_merge" : "data_quality_cleanup",
              ownerUserId: issue.ownerUserId ?? null,
              primaryContactId: issue.contactId ?? null,
              reason: `${text.actions[actionId]}: ${label}`,
              status: actionId === "cleanupHistory" ? "completed" : "planned",
            }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          })
        : await fetch("/api/crm/data-quality", {
            body: JSON.stringify({
              actionId,
              actionLabel: text.actions[actionId],
              issue: toDataQualityIssuePayload(issue),
              operation: "action",
            }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          });

      if (!response.ok) throw new Error("Action task could not be saved");

      setNotice(text.actionTaskNotice(text.actions[actionId], label));
    } catch {
      setNotice(text.saveError);
    } finally {
      setBusyIssueIds((current) => ({ ...current, [issue.id]: false }));
    }
  }

  async function persistIssueStatus(
    issue: DataHygieneIssue,
    label: string,
    status: Exclude<PersistedIssueStatus, "open">,
  ) {
    setBusyIssueIds((current) => ({ ...current, [issue.id]: true }));

    try {
      const response = await fetch("/api/crm/data-quality", {
        body: JSON.stringify({
          issue: toDataQualityIssuePayload(issue),
          operation: status === "resolved" ? "resolve" : "ignore",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      if (!response.ok) throw new Error("Issue status could not be saved");

      setHiddenIssueIds((current) => {
        const next = new Set(current);
        next.add(issue.id);
        return next;
      });
      setNotice(text.statusNotice[status](label));
    } catch {
      setNotice(text.saveError);
    } finally {
      setBusyIssueIds((current) => ({ ...current, [issue.id]: false }));
    }
  }

  function renderIssueDetail(issue: DataHygieneIssue) {
    if (issue.kind === "duplicateEmail" || issue.kind === "duplicatePhone") {
      return `${text.fields.duplicate}: ${issue.duplicateKey ?? issue.entityLabel} (${issue.duplicateCount ?? 2})`;
    }

    if (issue.entityType === "lead") {
      const lastContact = issue.lastContactAt
        ? formatDate(issue.lastContactAt, language)
        : text.fields.unknown;
      return `${text.fields.lastContact}: ${lastContact}`;
    }

    return text.issueDescriptions[issue.kind];
  }

  return (
    <section className="space-y-5">
      <div className="rounded-lg border border-stone-200 bg-white p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
              {text.scopeLabel}: {projectLabel}
            </p>
            <h3 className="mt-2 break-words text-2xl font-semibold text-slate-950">
              {text.title}
            </h3>
            <p className="mt-2 max-w-4xl break-words text-sm leading-6 text-stone-600">
              {text.subtitle}
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:min-w-[360px]">
            {[
              [text.metrics.openIssues, metrics.openIssues],
              [text.metrics.risks, metrics.risks],
              [text.metrics.warnings, metrics.warnings],
              [text.metrics.duplicates, metrics.duplicates],
            ].map(([label, value]) => (
              <div className="rounded-lg border border-stone-200 bg-stone-50 p-3" key={label}>
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                  {label}
                </p>
                <p className="mt-2 text-2xl font-semibold text-slate-950">
                  {formatNumber(value as number, language)}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[0.82fr_1.18fr]">
        <aside className="space-y-4">
          <section className="rounded-lg border border-stone-200 bg-white p-4">
            <h4 className="text-base font-semibold text-slate-950">{text.groups.workQueue}</h4>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {[
                [text.metrics.missingRoutes, metrics.missingRoutes],
                [text.metrics.missingConsent, metrics.missingConsent],
                [text.metrics.staleLeads, metrics.staleLeads],
                [text.metrics.missingNextAction, metrics.missingNextAction],
              ].map(([label, value]) => (
                <div
                  className="rounded-md border border-stone-200 bg-stone-50 p-3"
                  key={label}
                >
                  <span className="block text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    {label}
                  </span>
                  <span className="mt-2 block text-lg font-semibold text-slate-950">
                    {formatNumber(value as number, language)}
                  </span>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-lg border border-stone-200 bg-white p-4">
            <h4 className="text-base font-semibold text-slate-950">{text.filters.severity}</h4>
            <div className="mt-3 flex flex-wrap gap-2">
              {(["all", "risk", "warning"] as SeverityFilter[]).map((severity) => (
                <button
                  className={`rounded-md border px-3 py-2 text-sm font-semibold ${
                    severityFilter === severity
                      ? filterButtonStyles.active
                      : filterButtonStyles.inactive
                  }`}
                  key={severity}
                  onClick={() => setSeverityFilter(severity)}
                  type="button"
                >
                  {text.severityLabels[severity]}
                </button>
              ))}
            </div>
          </section>

          <section className="rounded-lg border border-stone-200 bg-white p-4">
            <h4 className="text-base font-semibold text-slate-950">{text.filters.entity}</h4>
            <div className="mt-3 flex flex-wrap gap-2">
              {(["all", "contact", "lead"] as EntityFilter[]).map((entity) => (
                <button
                  className={`rounded-md border px-3 py-2 text-sm font-semibold ${
                    entityFilter === entity ? filterButtonStyles.active : filterButtonStyles.inactive
                  }`}
                  key={entity}
                  onClick={() => setEntityFilter(entity)}
                  type="button"
                >
                  {text.entityLabels[entity]}
                </button>
              ))}
            </div>
          </section>

          <section className="rounded-lg border border-stone-200 bg-white p-4">
            <div className="grid gap-3">
              <label className="grid gap-2 text-sm font-semibold text-slate-800">
                {text.filters.project}
                <select
                  className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-900"
                  onChange={(event) => setProjectFilter(event.target.value)}
                  value={projectFilter}
                >
                  <option value="all">{text.filters.all}</option>
                  {projectOptions.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-2 text-sm font-semibold text-slate-800">
                {text.filters.kind}
                <select
                  className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-900"
                  onChange={(event) =>
                    setKindFilter(event.target.value as DataHygieneIssueKind | "all")
                  }
                  value={kindFilter}
                >
                  <option value="all">{text.filters.all}</option>
                  {issueKindOrder.map((kind) => (
                    <option key={kind} value={kind}>
                      {text.issueKinds[kind]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </section>
        </aside>

        <section className="rounded-lg border border-stone-200 bg-white p-4">
          <div className="flex flex-col gap-2 border-b border-stone-200 pb-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h4 className="text-base font-semibold text-slate-950">
                {text.groups.groupedByProject}
              </h4>
              <p className="mt-1 text-sm text-stone-600">
                {formatNumber(filteredIssueViews.length, language)} {text.metrics.openIssues}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <span className="rounded-md border border-stone-200 bg-stone-50 px-2 py-1 text-xs font-semibold text-stone-700">
                {text.groups.contactIssues}:{" "}
                {formatNumber(filteredIssueViews.filter((view) => view.issue.entityType === "contact").length, language)}
              </span>
              <span className="rounded-md border border-stone-200 bg-stone-50 px-2 py-1 text-xs font-semibold text-stone-700">
                {text.groups.leadIssues}:{" "}
                {formatNumber(filteredIssueViews.filter((view) => view.issue.entityType === "lead").length, language)}
              </span>
            </div>
          </div>

          {notice ? (
            <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-900">
              {notice}
            </div>
          ) : null}

          <div className="mt-4 space-y-4">
            {projectGroups.length > 0 ? (
              projectGroups.map((group) => (
                <section className="rounded-lg border border-stone-200" key={group.id}>
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-200 bg-stone-50 px-4 py-3">
                    <h5 className="break-words text-sm font-semibold text-slate-950">
                      {group.label}
                    </h5>
                    <span className="rounded-md border border-stone-200 bg-white px-2 py-1 text-xs font-semibold text-stone-700">
                      {formatNumber(group.issues.length, language)}
                    </span>
                  </div>
                  <div className="divide-y divide-stone-200">
                    {group.issues.map(({ contact, issue, lead, ownerName, primaryLabel }) => {
                      const isBusy = Boolean(busyIssueIds[issue.id]);

                      return (
                      <article className="p-4" key={issue.id}>
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span
                                className={`rounded-md border px-2 py-1 text-xs font-semibold ${severityStyles[issue.severity]}`}
                              >
                                {text.severityLabels[issue.severity]}
                              </span>
                              <span className="rounded-md border border-stone-200 bg-white px-2 py-1 text-xs font-semibold text-stone-700">
                                {text.issueKinds[issue.kind]}
                              </span>
                            </div>
                            <h6 className="mt-3 break-words text-base font-semibold text-slate-950">
                              {primaryLabel}
                            </h6>
                            <p className="mt-1 break-words text-sm text-stone-600">
                              {text.issueDescriptions[issue.kind]}
                            </p>
                            <dl className="mt-3 grid gap-2 text-sm text-stone-700 sm:grid-cols-2">
                              <div>
                                <dt className="font-semibold text-slate-900">{text.fields.contact}</dt>
                                <dd className="break-words">{contact?.name ?? text.fields.unknown}</dd>
                              </div>
                              <div>
                                <dt className="font-semibold text-slate-900">{text.fields.lead}</dt>
                                <dd className="break-words">{lead?.id ?? "-"}</dd>
                              </div>
                              <div>
                                <dt className="font-semibold text-slate-900">{text.fields.owner}</dt>
                                <dd className="break-words">{ownerName}</dd>
                              </div>
                              <div>
                                <dt className="font-semibold text-slate-900">{text.fields.nextAction}</dt>
                                <dd className="break-words">
                                  {lead?.nextAction || issue.nextAction
                                    ? getCrmSystemTextLabel(lead?.nextAction || issue.nextAction || "", language)
                                    : text.fields.noNextAction}
                                </dd>
                              </div>
                            </dl>
                            <p className="mt-3 break-words rounded-md bg-stone-50 px-3 py-2 text-sm text-stone-700">
                              {renderIssueDetail(issue)}
                            </p>
                          </div>
                          <div className="flex shrink-0 flex-wrap gap-2 lg:max-w-[220px] lg:justify-end">
                            {getIssueActions(issue).map((actionId) => (
                              <button
                                className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-60"
                                disabled={isBusy}
                                key={actionId}
                                onClick={() => void prepareAction(actionId, issue, primaryLabel)}
                                type="button"
                              >
                                {text.actions[actionId]}
                              </button>
                            ))}
                            <button
                              className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-900 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
                              disabled={isBusy}
                              onClick={() => void persistIssueStatus(issue, primaryLabel, "resolved")}
                              type="button"
                            >
                              {text.actions.markResolved}
                            </button>
                            <button
                              className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-60"
                              disabled={isBusy}
                              onClick={() => void persistIssueStatus(issue, primaryLabel, "ignored")}
                              type="button"
                            >
                              {text.actions.ignoreIssue}
                            </button>
                          </div>
                        </div>
                      </article>
                      );
                    })}
                  </div>
                </section>
              ))
            ) : (
              <p className="rounded-lg border border-dashed border-stone-300 bg-stone-50 p-4 text-sm text-stone-600">
                {text.empty}
              </p>
            )}
          </div>
        </section>
      </div>
    </section>
  );
}
