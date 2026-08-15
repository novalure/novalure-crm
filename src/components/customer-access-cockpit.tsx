"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CustomerWorkspaceAccess, Project, WorkspaceRole, WorkspaceUser } from "@/lib/crm-types";
import type {
  CustomerAccessCockpitPayload,
  CustomerAccessGrantStatus,
  CustomerAccessLevel,
  CustomerAccessProjectGrant,
  CustomerAccessProjectRole,
} from "@/lib/db/customer-access-repositories";
import {
  getCustomerAccessCockpitCopy,
  getLocale,
  type LanguageCode,
} from "@/lib/i18n";
import { productRoles, type ProductRole } from "@/lib/product-model";

type CustomerAccessCockpitProps = {
  activeProjectId?: string;
  customerAccess: CustomerWorkspaceAccess[];
  language: LanguageCode;
  projectLabel: string;
  projects: Project[];
  users: WorkspaceUser[];
};

type CustomerDraft = {
  activationScore: string;
  activeUsers: string;
  health: CustomerWorkspaceAccess["health"];
  invitedUsers: string;
  nextOnboardingAction: string;
  plan: string;
  risks: string;
  status: CustomerWorkspaceAccess["status"];
};

type GrantDraft = {
  accessId: string;
  accessLevel: CustomerAccessLevel;
  canEditProject: boolean;
  canExportData: boolean;
  canViewContacts: boolean;
  canViewProject: boolean;
  projectId: string;
  projectRole: CustomerAccessProjectRole;
  status: CustomerAccessGrantStatus;
  userId: string;
};

type UserDraft = {
  productRole: ProductRole;
  role: WorkspaceRole;
  status: WorkspaceUser["status"];
  userId: string;
};

type InviteDraft = {
  email: string;
  name: string;
  productRole: ProductRole;
  role: WorkspaceRole;
};

type SaveState = "idle" | "loading" | "saved" | "error";

const accessLevels: CustomerAccessLevel[] = ["viewer", "editor", "admin"];
const grantStatuses: CustomerAccessGrantStatus[] = ["active", "invited", "suspended"];
const healthValues: CustomerWorkspaceAccess["health"][] = ["healthy", "attention", "risk"];
const statusValues: CustomerWorkspaceAccess["status"][] = ["lead", "demo", "trial", "onboarding", "active", "risk"];
const workspaceRoles: WorkspaceRole[] = ["owner", "admin", "agent", "assistant"];
const workspaceStatuses: WorkspaceUser["status"][] = ["active", "invited"];

const healthStyles = {
  attention: "border-amber-200 bg-amber-50 text-amber-900",
  healthy: "border-emerald-200 bg-emerald-50 text-emerald-900",
  risk: "border-rose-200 bg-rose-50 text-rose-900",
} as const;

const statusStyles = {
  active: "border-emerald-200 bg-emerald-50 text-emerald-900",
  demo: "border-blue-200 bg-blue-50 text-blue-900",
  lead: "border-slate-200 bg-slate-50 text-slate-800",
  onboarding: "border-amber-200 bg-amber-50 text-amber-900",
  risk: "border-rose-200 bg-rose-50 text-rose-900",
  trial: "border-violet-200 bg-violet-50 text-violet-900",
} as const;

function defaultPayload(input: CustomerAccessCockpitProps): CustomerAccessCockpitPayload {
  return {
    audits: [],
    customerAccess: input.customerAccess,
    grants: [],
    projects: input.projects,
    source: "fallback",
    users: input.users,
  };
}

function formatDate(value: string, language: LanguageCode) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "-";

  return new Intl.DateTimeFormat(getLocale(language), {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

function getCustomerDraft(record: CustomerWorkspaceAccess): CustomerDraft {
  return {
    activationScore: String(record.activationScore),
    activeUsers: String(record.activeUsers),
    health: record.health,
    invitedUsers: String(record.invitedUsers),
    nextOnboardingAction: record.nextOnboardingAction,
    plan: record.plan,
    risks: record.risks.join("\n"),
    status: record.status,
  };
}

function getCustomerDrafts(records: CustomerWorkspaceAccess[]) {
  return Object.fromEntries(records.map((record) => [record.id, getCustomerDraft(record)]));
}

function getGrantDefaults(payload: CustomerAccessCockpitPayload, activeProjectId?: string): GrantDraft {
  const customer = payload.customerAccess[0];
  const project =
    payload.projects.find((item) => item.id === activeProjectId)
    ?? payload.projects.find((item) => item.id === customer?.projectId)
    ?? payload.projects[0];
  const user =
    payload.users.find((item) => item.id === customer?.ownerUserId)
    ?? payload.users.find((item) => item.status === "active")
    ?? payload.users[0];

  return {
    accessId: customer?.id ?? "",
    accessLevel: "viewer",
    canEditProject: false,
    canExportData: false,
    canViewContacts: false,
    canViewProject: true,
    projectId: project?.id ?? "",
    projectRole: user?.role ?? "assistant",
    status: "active",
    userId: user?.id ?? "",
  };
}

function getUserDefaults(users: WorkspaceUser[]): UserDraft {
  const user = users[0];

  return {
    productRole: user?.productRole ?? "viewer",
    role: user?.role ?? "assistant",
    status: user?.status ?? "invited",
    userId: user?.id ?? "",
  };
}

function getInviteDefaults(): InviteDraft {
  return {
    email: "",
    name: "",
    productRole: "viewer",
    role: "assistant",
  };
}

function getGrantLabel(copy: ReturnType<typeof getCustomerAccessCockpitCopy>, grant: CustomerAccessProjectGrant) {
  return `${grant.customerName} / ${grant.projectName} / ${grant.userName} / ${copy.accessLevels[grant.accessLevel]}`;
}

function getCustomerPriority(record: CustomerWorkspaceAccess) {
  let priority = 0;

  if (record.health === "risk" || record.status === "risk") priority += 50;
  if (record.status === "onboarding") priority += 25;
  if (record.status === "trial" || record.status === "demo") priority += 15;
  if (record.activationScore < 60) priority += 20;
  if (record.invitedUsers > 0 && record.activeUsers === 0) priority += 15;
  if (record.risks.length > 0) priority += 10;

  return priority;
}

export function CustomerAccessCockpit({
  activeProjectId = "all",
  customerAccess,
  language,
  projectLabel,
  projects,
  users,
}: CustomerAccessCockpitProps) {
  const copy = getCustomerAccessCockpitCopy(language);
  const initialPayload = useMemo(
    () => defaultPayload({ activeProjectId, customerAccess, language, projectLabel, projects, users }),
    [activeProjectId, customerAccess, language, projectLabel, projects, users],
  );
  const [payload, setPayload] = useState<CustomerAccessCockpitPayload>(() => initialPayload);
  const [customerDrafts, setCustomerDrafts] = useState<Record<string, CustomerDraft>>(() =>
    getCustomerDrafts(initialPayload.customerAccess),
  );
  const [grantDraft, setGrantDraft] = useState<GrantDraft>(() => getGrantDefaults(initialPayload, activeProjectId));
  const [userDraft, setUserDraft] = useState<UserDraft>(() => getUserDefaults(users));
  const [inviteDraft, setInviteDraft] = useState<InviteDraft>(() => getInviteDefaults());
  const [inviteNotice, setInviteNotice] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");

  const applyPayload = useCallback((nextPayload: CustomerAccessCockpitPayload) => {
    setPayload(nextPayload);
    setCustomerDrafts(getCustomerDrafts(nextPayload.customerAccess));
    setGrantDraft((current) => ({
      ...getGrantDefaults(nextPayload, activeProjectId),
      ...current,
      accessId: nextPayload.customerAccess.some((item) => item.id === current.accessId)
        ? current.accessId
        : nextPayload.customerAccess[0]?.id ?? "",
      projectId: nextPayload.projects.some((item) => item.id === current.projectId)
        ? current.projectId
        : getGrantDefaults(nextPayload, activeProjectId).projectId,
      userId: nextPayload.users.some((item) => item.id === current.userId)
        ? current.userId
        : nextPayload.users[0]?.id ?? "",
    }));
    setUserDraft((current) => {
      const nextUser = nextPayload.users.find((item) => item.id === current.userId) ?? nextPayload.users[0];

      return {
        productRole: nextUser?.productRole ?? "viewer",
        role: nextUser?.role ?? "assistant",
        status: nextUser?.status ?? "invited",
        userId: nextUser?.id ?? "",
      };
    });
  }, [activeProjectId, setCustomerDrafts, setGrantDraft, setPayload, setUserDraft]);

  const loadCockpit = useCallback(async () => {
    const params = new URLSearchParams();
    if (activeProjectId && activeProjectId !== "all") params.set("projectId", activeProjectId);

    try {
      const response = await fetch(`/api/crm/customer-access?${params.toString()}`, { cache: "no-store" });
      if (!response.ok) return;

      const nextPayload = (await response.json()) as CustomerAccessCockpitPayload;
      applyPayload(nextPayload);
    } catch {
      applyPayload(initialPayload);
    }
  }, [activeProjectId, applyPayload, initialPayload]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadCockpit();
    }, 0);

    return () => window.clearTimeout(timeout);
  }, [loadCockpit]);

  const metrics = useMemo(() => {
    const activeCustomers = payload.customerAccess.filter((item) => item.status === "active").length;
    const onboarding = payload.customerAccess.filter((item) => item.status === "onboarding").length;
    const risk = payload.customerAccess.filter((item) => item.health === "risk" || item.status === "risk").length;
    const trial = payload.customerAccess.filter((item) => item.status === "trial").length;
    const activeUsers = payload.customerAccess.reduce((sum, item) => sum + item.activeUsers, 0);

    return { activeCustomers, activeUsers, onboarding, risk, trial };
  }, [payload.customerAccess]);

  const internalCockpit = useMemo(() => {
    const stageCounts = statusValues.map((status) => ({
      count: payload.customerAccess.filter((record) => record.status === status).length,
      status,
    }));
    const prioritizedAccounts = [...payload.customerAccess]
      .sort(
        (left, right) =>
          getCustomerPriority(right) - getCustomerPriority(left) ||
          left.activationScore - right.activationScore,
      );
    const priorityAccounts = prioritizedAccounts
      .filter((record) => getCustomerPriority(record) > 0)
      .slice(0, 4);
    const bottlenecks = [
      {
        count: payload.customerAccess.filter((record) => record.health === "risk" || record.status === "risk").length,
        id: "risk",
      },
      {
        count: payload.customerAccess.filter((record) => record.activationScore < 60).length,
        id: "lowActivation",
      },
      {
        count: payload.customerAccess.filter((record) => record.invitedUsers > 0 && record.activeUsers === 0).length,
        id: "invitedNoActive",
      },
      {
        count: payload.grants.filter((grant) => grant.status === "suspended").length,
        id: "suspendedAccess",
      },
    ];

    return {
      bottlenecks,
      priorityAccountCount: prioritizedAccounts.filter((record) => getCustomerPriority(record) > 0).length,
      priorityAccounts,
      stageCounts,
    };
  }, [payload.customerAccess, payload.grants]);

  async function persist(input: Record<string, unknown>) {
    setSaveState("loading");

    const params = new URLSearchParams();
    if (activeProjectId && activeProjectId !== "all") params.set("projectId", activeProjectId);

    try {
      const response = await fetch(`/api/crm/customer-access?${params.toString()}`, {
        body: JSON.stringify(input),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      const result = (await response.json()) as {
        data?: {
          deliveryConfigured?: boolean;
          user?: { email?: string };
        };
        payload?: CustomerAccessCockpitPayload;
      };

      if (!response.ok || !result.payload) throw new Error("save_failed");
      applyPayload(result.payload);
      if (input.operation === "invite_user") {
        const email = result.data?.user?.email ?? String(input.email ?? "");
        setInviteNotice(
          result.data?.deliveryConfigured === false
            ? copy.invite.testModeSaved(email)
            : copy.invite.sent(email),
        );
        setInviteDraft(getInviteDefaults());
      }
      setSaveState("saved");
    } catch {
      setSaveState("error");
    }
  }

  async function runRiskAutomation() {
    setSaveState("loading");

    try {
      const response = await fetch("/api/crm/recommendation-runtime", {
        body: JSON.stringify({
          operation: "customer_onboarding_risks",
          projectId: activeProjectId && activeProjectId !== "all" ? activeProjectId : null,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      if (!response.ok) throw new Error("risk_automation_failed");

      await loadCockpit();
      setSaveState("saved");
    } catch {
      setSaveState("error");
    }
  }

  function updateCustomerDraft(id: string, patch: Partial<CustomerDraft>) {
    setCustomerDrafts((current) => ({
      ...current,
      [id]: {
        ...(current[id] ?? getCustomerDraft(payload.customerAccess.find((item) => item.id === id)!)),
        ...patch,
      },
    }));
  }

  async function inviteUser() {
    const email = inviteDraft.email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setInviteNotice(copy.invite.invalidEmail);
      setSaveState("error");
      return;
    }

    setInviteNotice("");
    await persist({
      email,
      name: inviteDraft.name,
      operation: "invite_user",
      productRole: inviteDraft.productRole,
      role: inviteDraft.role,
    });
  }

  const saveNotice =
    saveState === "saved"
      ? copy.notices.saved
      : saveState === "error"
        ? copy.notices.saveError
        : "";

  return (
    <section className="grid gap-5">
      <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">{projectLabel}</p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-950">{copy.title}</h2>
            <p className="mt-2 max-w-3xl text-sm text-stone-600">{copy.subtitle}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className="rounded-md border border-stone-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-stone-100"
              onClick={() => void loadCockpit()}
              type="button"
            >
              {copy.actions.refresh}
            </button>
            <button
              className="rounded-md bg-slate-950 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={saveState === "loading"}
              onClick={() => void runRiskAutomation()}
              type="button"
            >
              {copy.actions.runRiskAutomation}
            </button>
          </div>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {[
            [copy.metrics.active, metrics.activeCustomers],
            [copy.metrics.onboarding, metrics.onboarding],
            [copy.metrics.trial, metrics.trial],
            [copy.metrics.risk, metrics.risk],
            [copy.metrics.activeUsers, metrics.activeUsers],
          ].map(([label, value]) => (
            <div className="rounded-lg border border-stone-200 bg-stone-50 p-3" key={label}>
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-stone-500">{label}</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">{value}</p>
            </div>
          ))}
        </div>
        {saveNotice ? (
          <p className={`mt-4 text-sm font-semibold ${saveState === "error" ? "text-rose-700" : "text-emerald-700"}`}>
            {saveNotice}
          </p>
        ) : null}
      </div>

      <section className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <h3 className="text-lg font-semibold text-slate-950">{copy.internal.title}</h3>
            <p className="mt-1 max-w-3xl text-sm text-stone-600">{copy.internal.subtitle}</p>
          </div>
          <span className="rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-sm font-semibold text-slate-700">
            {copy.internal.priorityCount(internalCockpit.priorityAccountCount)}
          </span>
        </div>

        <div className="mt-5 grid gap-4 xl:grid-cols-3">
          <div className="rounded-lg border border-stone-200 bg-stone-50 p-4">
            <h4 className="text-sm font-semibold uppercase tracking-[0.12em] text-stone-500">{copy.internal.stagesTitle}</h4>
            <div className="mt-3 grid gap-2">
              {internalCockpit.stageCounts.map(({ count, status }) => (
                <div className="flex items-center justify-between gap-3 rounded-md bg-white px-3 py-2 text-sm" key={status}>
                  <span className="font-semibold text-slate-900">{copy.statusLabels[status]}</span>
                  <span className={`rounded-md border px-2 py-1 text-xs font-semibold ${statusStyles[status]}`}>{count}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-stone-200 bg-stone-50 p-4">
            <h4 className="text-sm font-semibold uppercase tracking-[0.12em] text-stone-500">{copy.internal.bottlenecksTitle}</h4>
            <div className="mt-3 grid gap-2">
              {internalCockpit.bottlenecks.map((item) => (
                <div className="flex items-center justify-between gap-3 rounded-md bg-white px-3 py-2 text-sm" key={item.id}>
                  <span className="break-words font-semibold text-slate-900">
                    {copy.internal.bottlenecks[item.id as keyof typeof copy.internal.bottlenecks]}
                  </span>
                  <span className="rounded-md border border-stone-200 bg-stone-50 px-2 py-1 text-xs font-semibold text-slate-700">
                    {item.count}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-stone-200 bg-stone-50 p-4">
            <h4 className="text-sm font-semibold uppercase tracking-[0.12em] text-stone-500">{copy.internal.nextActionsTitle}</h4>
            <div className="mt-3 grid gap-2">
              {internalCockpit.priorityAccounts.length ? (
                internalCockpit.priorityAccounts.map((record) => (
                  <div className="rounded-md bg-white p-3 text-sm" key={record.id}>
                    <div className="flex items-start justify-between gap-3">
                      <p className="break-words font-semibold text-slate-950">{record.customerName}</p>
                      <span className={`shrink-0 rounded-md border px-2 py-1 text-xs font-semibold ${healthStyles[record.health]}`}>
                        {copy.healthLabels[record.health]}
                      </span>
                    </div>
                    <p className="mt-1 break-words text-xs text-stone-600">
                      {copy.internal.activation}: {record.activationScore}% / {copy.statusLabels[record.status]}
                    </p>
                    <p className="mt-2 break-words text-sm text-slate-700">
                      {record.nextOnboardingAction || copy.internal.noNextAction}
                    </p>
                  </div>
                ))
              ) : (
                <p className="rounded-md border border-dashed border-stone-300 bg-white p-3 text-sm text-stone-600">
                  {copy.internal.noPriorityAccounts}
                </p>
              )}
            </div>
          </div>
        </div>
      </section>

      <div className="grid gap-5 xl:grid-cols-[1.25fr_0.95fr]">
        <div className="grid gap-4">
          {payload.customerAccess.map((record) => {
            const draft = customerDrafts[record.id] ?? getCustomerDraft(record);
            const owner = payload.users.find((user) => user.id === record.ownerUserId);
            const project = payload.projects.find((item) => item.id === record.projectId);

            return (
              <article className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm" key={record.id}>
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="break-words text-lg font-semibold text-slate-950">{record.customerName}</h3>
                      <span className={`rounded-md border px-2 py-1 text-xs font-semibold ${statusStyles[record.status]}`}>
                        {copy.statusLabels[record.status]}
                      </span>
                      <span className={`rounded-md border px-2 py-1 text-xs font-semibold ${healthStyles[record.health]}`}>
                        {copy.healthLabels[record.health]}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-stone-600">
                      {record.plan} / {project?.name ?? projectLabel} / {owner?.name ?? "-"}
                    </p>
                  </div>
                  <div className="min-w-[120px] rounded-lg border border-stone-200 bg-stone-50 p-3 text-right">
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-stone-500">Score</p>
                    <p className="text-2xl font-semibold text-slate-950">{record.activationScore}</p>
                  </div>
                </div>

                <div className="mt-4 grid gap-3 lg:grid-cols-5">
                  <label className="grid gap-1 text-sm font-semibold text-slate-700">
                    {copy.filters.status}
                    <select
                      className="rounded-md border border-stone-300 px-3 py-2 text-sm font-normal"
                      onChange={(event) => updateCustomerDraft(record.id, { status: event.target.value as CustomerWorkspaceAccess["status"] })}
                      value={draft.status}
                    >
                      {statusValues.map((status) => (
                        <option key={status} value={status}>{copy.statusLabels[status]}</option>
                      ))}
                    </select>
                  </label>
                  <label className="grid gap-1 text-sm font-semibold text-slate-700">
                    {copy.filters.health}
                    <select
                      className="rounded-md border border-stone-300 px-3 py-2 text-sm font-normal"
                      onChange={(event) => updateCustomerDraft(record.id, { health: event.target.value as CustomerWorkspaceAccess["health"] })}
                      value={draft.health}
                    >
                      {healthValues.map((health) => (
                        <option key={health} value={health}>{copy.healthLabels[health]}</option>
                      ))}
                    </select>
                  </label>
                  <label className="grid gap-1 text-sm font-semibold text-slate-700">
                    {copy.metrics.invitedUsers}
                    <input
                      className="rounded-md border border-stone-300 px-3 py-2 text-sm font-normal"
                      min="0"
                      onChange={(event) => updateCustomerDraft(record.id, { invitedUsers: event.target.value })}
                      type="number"
                      value={draft.invitedUsers}
                    />
                  </label>
                  <label className="grid gap-1 text-sm font-semibold text-slate-700">
                    {copy.metrics.activeUsers}
                    <input
                      className="rounded-md border border-stone-300 px-3 py-2 text-sm font-normal"
                      min="0"
                      onChange={(event) => updateCustomerDraft(record.id, { activeUsers: event.target.value })}
                      type="number"
                      value={draft.activeUsers}
                    />
                  </label>
                  <label className="grid gap-1 text-sm font-semibold text-slate-700">
                    Score
                    <input
                      className="rounded-md border border-stone-300 px-3 py-2 text-sm font-normal"
                      max="100"
                      min="0"
                      onChange={(event) => updateCustomerDraft(record.id, { activationScore: event.target.value })}
                      type="number"
                      value={draft.activationScore}
                    />
                  </label>
                </div>

                <div className="mt-3 grid gap-3 lg:grid-cols-[0.9fr_1.1fr]">
                  <label className="grid gap-1 text-sm font-semibold text-slate-700">
                    Plan
                    <input
                      className="rounded-md border border-stone-300 px-3 py-2 text-sm font-normal"
                      onChange={(event) => updateCustomerDraft(record.id, { plan: event.target.value })}
                      value={draft.plan}
                    />
                  </label>
                  <label className="grid gap-1 text-sm font-semibold text-slate-700">
                    {copy.filters.risks}
                    <input
                      className="rounded-md border border-stone-300 px-3 py-2 text-sm font-normal"
                      onChange={(event) => updateCustomerDraft(record.id, { risks: event.target.value })}
                      value={draft.risks.replaceAll("\n", ", ")}
                    />
                  </label>
                </div>

                <label className="mt-3 grid gap-1 text-sm font-semibold text-slate-700">
                  {copy.metrics.onboarding}
                  <textarea
                    className="min-h-20 rounded-md border border-stone-300 px-3 py-2 text-sm font-normal"
                    onChange={(event) => updateCustomerDraft(record.id, { nextOnboardingAction: event.target.value })}
                    value={draft.nextOnboardingAction}
                  />
                </label>

                <div className="mt-4 flex flex-col gap-3 text-sm text-stone-600 sm:flex-row sm:items-center sm:justify-between">
                  <p>{formatDate(record.lastCustomerActivityAt, language)}</p>
                  <button
                    className="rounded-md bg-slate-950 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
                    disabled={saveState === "loading"}
                    onClick={() =>
                      void persist({
                        accessId: record.id,
                        activeUsers: draft.activeUsers,
                        activationScore: draft.activationScore,
                        health: draft.health,
                        invitedUsers: draft.invitedUsers,
                        nextOnboardingAction: draft.nextOnboardingAction,
                        operation: "access",
                        plan: draft.plan,
                        risks: draft.risks,
                        status: draft.status,
                      })
                    }
                    type="button"
                  >
                    {copy.actions.saveCustomer}
                  </button>
                </div>
              </article>
            );
          })}

          {payload.customerAccess.length === 0 ? (
            <div className="rounded-lg border border-dashed border-stone-300 bg-stone-50 p-5 text-sm text-stone-600">
              {copy.empty}
            </div>
          ) : null}
        </div>

        <aside className="grid gap-4">
          <section className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
            <h3 className="text-lg font-semibold text-slate-950">{copy.grant.title}</h3>
            <div className="mt-4 grid gap-3">
              <label className="grid gap-1 text-sm font-semibold text-slate-700">
                {copy.filters.customer}
                <select
                  className="rounded-md border border-stone-300 px-3 py-2 text-sm font-normal"
                  onChange={(event) => setGrantDraft((current) => ({ ...current, accessId: event.target.value }))}
                  value={grantDraft.accessId}
                >
                  {payload.customerAccess.map((record) => (
                    <option key={record.id} value={record.id}>{record.customerName}</option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-sm font-semibold text-slate-700">
                {copy.filters.project}
                <select
                  className="rounded-md border border-stone-300 px-3 py-2 text-sm font-normal"
                  onChange={(event) => setGrantDraft((current) => ({ ...current, projectId: event.target.value }))}
                  value={grantDraft.projectId}
                >
                  {payload.projects.map((project) => (
                    <option key={project.id} value={project.id}>{project.name}</option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-sm font-semibold text-slate-700">
                {copy.filters.user}
                <select
                  className="rounded-md border border-stone-300 px-3 py-2 text-sm font-normal"
                  onChange={(event) => setGrantDraft((current) => ({ ...current, userId: event.target.value }))}
                  value={grantDraft.userId}
                >
                  {payload.users.map((user) => (
                    <option key={user.id} value={user.id}>{user.name} / {user.email}</option>
                  ))}
                </select>
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1 text-sm font-semibold text-slate-700">
                  {copy.filters.projectRole}
                  <select
                    className="rounded-md border border-stone-300 px-3 py-2 text-sm font-normal"
                    onChange={(event) => setGrantDraft((current) => ({ ...current, projectRole: event.target.value as CustomerAccessProjectRole }))}
                    value={grantDraft.projectRole}
                  >
                    {workspaceRoles.map((role) => (
                      <option key={role} value={role}>{copy.roles[role]}</option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-sm font-semibold text-slate-700">
                  {copy.filters.accessLevel}
                  <select
                    className="rounded-md border border-stone-300 px-3 py-2 text-sm font-normal"
                    onChange={(event) => {
                      const accessLevel = event.target.value as CustomerAccessLevel;
                      setGrantDraft((current) => ({
                        ...current,
                        accessLevel,
                        canEditProject: accessLevel !== "viewer",
                        canExportData: accessLevel === "admin",
                        canViewContacts: accessLevel !== "viewer",
                        canViewProject: true,
                      }));
                    }}
                    value={grantDraft.accessLevel}
                  >
                    {accessLevels.map((level) => (
                      <option key={level} value={level}>{copy.accessLevels[level]}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="grid gap-2 rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm text-slate-700">
                {[
                  ["canViewProject", copy.grant.viewProject],
                  ["canEditProject", copy.grant.editProject],
                  ["canViewContacts", copy.grant.viewContacts],
                  ["canExportData", copy.grant.exportData],
                ].map(([key, label]) => (
                  <label className="flex items-center gap-2" key={key}>
                    <input
                      checked={Boolean(grantDraft[key as keyof GrantDraft])}
                      onChange={(event) => setGrantDraft((current) => ({ ...current, [key]: event.target.checked }))}
                      type="checkbox"
                    />
                    {label}
                  </label>
                ))}
              </div>
              <label className="grid gap-1 text-sm font-semibold text-slate-700">
                {copy.filters.status}
                <select
                  className="rounded-md border border-stone-300 px-3 py-2 text-sm font-normal"
                  onChange={(event) => setGrantDraft((current) => ({ ...current, status: event.target.value as CustomerAccessGrantStatus }))}
                  value={grantDraft.status}
                >
                  {grantStatuses.map((status) => (
                    <option key={status} value={status}>{copy.userStatus[status]}</option>
                  ))}
                </select>
              </label>
              <button
                className="rounded-md bg-slate-950 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
                disabled={saveState === "loading" || !grantDraft.accessId || !grantDraft.projectId || !grantDraft.userId}
                onClick={() => void persist({ ...grantDraft, operation: "project_grant" })}
                type="button"
              >
                {copy.actions.saveAccess}
              </button>
            </div>

            <div className="mt-4 grid gap-2">
              {payload.grants.map((grant) => (
                <div className="rounded-lg border border-stone-200 bg-white p-3 text-sm" key={grant.id}>
                  <p className="font-semibold text-slate-950">{getGrantLabel(copy, grant)}</p>
                  <p className="mt-1 text-stone-600">{copy.userStatus[grant.status]} / {formatDate(grant.updatedAt, language)}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
            <h3 className="text-lg font-semibold text-slate-950">{copy.invite.title}</h3>
            <p className="mt-1 text-sm text-stone-600">{copy.invite.description}</p>
            <div className="mt-4 grid gap-3">
              <label className="grid gap-1 text-sm font-semibold text-slate-700">
                {copy.invite.email}
                <input
                  className="rounded-md border border-stone-300 px-3 py-2 text-sm font-normal"
                  onChange={(event) => setInviteDraft((current) => ({ ...current, email: event.target.value }))}
                  type="email"
                  value={inviteDraft.email}
                />
              </label>
              <label className="grid gap-1 text-sm font-semibold text-slate-700">
                {copy.invite.name}
                <input
                  className="rounded-md border border-stone-300 px-3 py-2 text-sm font-normal"
                  onChange={(event) => setInviteDraft((current) => ({ ...current, name: event.target.value }))}
                  value={inviteDraft.name}
                />
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1 text-sm font-semibold text-slate-700">
                  {copy.invite.role}
                  <select
                    className="rounded-md border border-stone-300 px-3 py-2 text-sm font-normal"
                    onChange={(event) => setInviteDraft((current) => ({ ...current, role: event.target.value as WorkspaceRole }))}
                    value={inviteDraft.role}
                  >
                    {workspaceRoles.map((role) => (
                      <option key={role} value={role}>{copy.roles[role]}</option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-sm font-semibold text-slate-700">
                  {copy.invite.productRole}
                  <select
                    className="rounded-md border border-stone-300 px-3 py-2 text-sm font-normal"
                    onChange={(event) =>
                      setInviteDraft((current) => ({ ...current, productRole: event.target.value as ProductRole }))
                    }
                    value={inviteDraft.productRole}
                  >
                    {productRoles.map((role) => (
                      <option key={role} value={role}>{copy.productRoles[role]}</option>
                    ))}
                  </select>
                </label>
              </div>
              <button
                className="rounded-md bg-slate-950 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
                disabled={saveState === "loading"}
                onClick={() => void inviteUser()}
                type="button"
              >
                {copy.actions.inviteUser}
              </button>
              {inviteNotice ? (
                <p className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-semibold text-blue-950">
                  {inviteNotice}
                </p>
              ) : null}
            </div>
          </section>

          <section className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
            <h3 className="text-lg font-semibold text-slate-950">{copy.filters.workspaceRole}</h3>
            <div className="mt-4 grid gap-3">
              <label className="grid gap-1 text-sm font-semibold text-slate-700">
                {copy.filters.user}
                <select
                  className="rounded-md border border-stone-300 px-3 py-2 text-sm font-normal"
                  onChange={(event) => {
                    const selectedUser = payload.users.find((user) => user.id === event.target.value);
                    setUserDraft({
                      productRole: selectedUser?.productRole ?? "viewer",
                      role: selectedUser?.role ?? "assistant",
                      status: selectedUser?.status ?? "invited",
                      userId: selectedUser?.id ?? "",
                    });
                  }}
                  value={userDraft.userId}
                >
                  {payload.users.map((user) => (
                    <option key={user.id} value={user.id}>{user.name} / {user.email}</option>
                  ))}
                </select>
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1 text-sm font-semibold text-slate-700">
                  {copy.filters.workspaceRole}
                  <select
                    className="rounded-md border border-stone-300 px-3 py-2 text-sm font-normal"
                    onChange={(event) => setUserDraft((current) => ({ ...current, role: event.target.value as WorkspaceRole }))}
                    value={userDraft.role}
                  >
                    {workspaceRoles.map((role) => (
                      <option key={role} value={role}>{copy.roles[role]}</option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-sm font-semibold text-slate-700">
                  {copy.filters.productRole}
                  <select
                    className="rounded-md border border-stone-300 px-3 py-2 text-sm font-normal"
                    onChange={(event) =>
                      setUserDraft((current) => ({ ...current, productRole: event.target.value as ProductRole }))
                    }
                    value={userDraft.productRole}
                  >
                    {productRoles.map((role) => (
                      <option key={role} value={role}>{copy.productRoles[role]}</option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-sm font-semibold text-slate-700">
                  {copy.filters.workspaceStatus}
                  <select
                    className="rounded-md border border-stone-300 px-3 py-2 text-sm font-normal"
                    onChange={(event) => setUserDraft((current) => ({ ...current, status: event.target.value as WorkspaceUser["status"] }))}
                    value={userDraft.status}
                  >
                    {workspaceStatuses.map((status) => (
                      <option key={status} value={status}>{copy.userStatus[status]}</option>
                    ))}
                  </select>
                </label>
              </div>
              <button
                className="rounded-md border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-stone-100 disabled:opacity-60"
                disabled={saveState === "loading" || !userDraft.userId}
                onClick={() => void persist({ ...userDraft, operation: "workspace_user" })}
                type="button"
              >
                {copy.actions.saveUser}
              </button>
            </div>
          </section>

          <section className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
            <h3 className="text-lg font-semibold text-slate-950">{copy.audit.title}</h3>
            <div className="mt-4 grid gap-2">
              {payload.audits.map((audit) => (
                <div className="rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm" key={audit.id}>
                  <p className="font-semibold text-slate-950">{audit.action}</p>
                  <p className="mt-1 text-stone-600">{audit.summary}</p>
                  <p className="mt-2 text-xs text-stone-500">
                    {audit.actorName ?? "-"} / {formatDate(audit.createdAt, language)}
                  </p>
                </div>
              ))}
              {payload.audits.length === 0 ? (
                <p className="rounded-lg border border-dashed border-stone-300 bg-stone-50 p-3 text-sm text-stone-600">
                  {copy.audit.empty}
                </p>
              ) : null}
            </div>
          </section>
        </aside>
      </div>
    </section>
  );
}
