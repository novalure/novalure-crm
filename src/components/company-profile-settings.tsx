"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  CompanyProfile,
  CompanyProfilePreflightIssue,
  CompanyProfileScope,
  CompanyProfileStatus,
  CompanyProfileUsageKey,
  CompanyProfileVersion,
  WorkspaceRole,
  WorkspaceUser,
} from "@/lib/crm-types";
import {
  mapProductRoleToTechnicalRole,
  type ProductRole,
  type WorkspaceProductContext,
} from "@/lib/product-model";
import type { LanguageCode } from "@/lib/i18n";

type CountryFieldRequirement = {
  appliesToRealEstate?: boolean;
  countryCode: "AT" | "DE" | "IE";
  field: keyof CompanyProfile | "licenses.realEstate" | "representatives";
  label: string;
  required: boolean;
};

type CompanyProfilePayload = {
  canApprove: boolean;
  canEdit: boolean;
  fieldRequirements: CountryFieldRequirement[];
  preflight: {
    blockers: CompanyProfilePreflightIssue[];
    issues: CompanyProfilePreflightIssue[];
    warnings: CompanyProfilePreflightIssue[];
  };
  profile: CompanyProfile;
  source: "database" | "fallback";
  versions: CompanyProfileVersion[];
};

type WorkspaceAccessSettingsPayload = {
  canManage: boolean;
  customerProductRoles: ProductRole[];
  source: "database" | "fallback";
  users: WorkspaceUser[];
  workspaceRoles: WorkspaceRole[];
};

type ProfileTab =
  | "master"
  | "register"
  | "contact"
  | "representation"
  | "licenses"
  | "privacy"
  | "branding"
  | "usage"
  | "approval";

type AccessAction = "invite" | "resend_invitation" | "revoke_invitation" | "password_reset";

const productRoleOptions: ProductRole[] = [
  "customer_owner",
  "workspace_admin",
  "team_member",
  "broker_agent",
  "developer_sales",
  "project_sales_member",
  "assistant_backoffice",
  "external_partner",
  "viewer",
];

const workspaceRoleOptions: WorkspaceRole[] = ["owner", "admin", "agent", "assistant"];

const usageKeys: CompanyProfileUsageKey[] = [
  "exposes",
  "emails",
  "forms",
  "invoices",
  "imprint",
  "privacy",
  "openImmo",
  "portalExport",
  "customerApprovals",
  "legalFooter",
  "botDisclosures",
];

const profileTabs: ProfileTab[] = [
  "master",
  "register",
  "contact",
  "representation",
  "licenses",
  "privacy",
  "branding",
  "usage",
  "approval",
];

const copy = {
  de: {
    access: "Zugänge & Rollen",
    account: "Kundenunternehmen",
    accountOrgId: "Organisation-ID",
    accountOrgIdHint: "Account-Profile brauchen eine produktive CRM-Organisation.",
    approval: "Freigaben",
    approved: "Freigegeben",
    billingAddress: "Rechnungsanschrift",
    blockers: "Blocker",
    branding: "Branding",
    businessAddress: "Geschäftsanschrift",
    canEditNo: "Nur Lesen",
    canEditYes: "Bearbeitung erlaubt",
    contact: "Kontakt",
    countryCode: "Land",
    currentPassword: "Aktuelles Passwort",
    dataSourceFallback: "Fallback",
    dataSourceLive: "Datenbank",
    displayName: "Anzeigename",
    dpoContact: "DSB / Datenschutzkontakt",
    draft: "Entwurf",
    email: "E-Mail",
    invite: "Einladen",
    inviteLink: "Einladungslink",
    jurisdiction: "Jurisdiktion",
    legalForm: "Rechtsform",
    legalName: "Firmenname",
    licenses: "Lizenzen",
    master: "Stammdaten",
    newPassword: "Neues Passwort",
    noIssues: "Keine offenen Preflight-Punkte.",
    operator: "Novalure Betreiberprofil",
    password: "Passwort",
    passwordConfirm: "Neues Passwort bestätigen",
    passwordReset: "Passwortlink",
    passwordUpdated: "Passwort wurde aktualisiert.",
    privacy: "Datenschutz",
    privacyContact: "Privacy Kontakt",
    publicEmail: "Öffentliche E-Mail",
    publicPhone: "Telefon",
    register: "Recht & Register",
    registerCourt: "Registergericht",
    registeredOfficeAddress: "Sitz / Registered Office",
    registrationAuthority: "Registerbehörde",
    registrationNumber: "Registernummer",
    representation: "Vertretung",
    representatives: "Vertretungsbefugte Personen, je Zeile eine Person",
    resend: "Neu senden",
    revoke: "Sperren",
    save: "Speichern",
    setupSent: "Einrichtungslink erstellt.",
    status: "Status",
    suspended: "Gesperrt",
    taxNumber: "Steuernummer",
    title: "Unternehmen & Zugänge",
    usage: "Verwendung",
    users: "Mitarbeiter",
    vatId: "UID / VAT ID",
    website: "Website",
    workspace: "Mein Unternehmen",
  },
  en: {
    access: "Access & roles",
    account: "Customer company",
    accountOrgId: "Organization ID",
    accountOrgIdHint: "Account profiles require a production CRM organization.",
    approval: "Approvals",
    approved: "Approved",
    billingAddress: "Billing address",
    blockers: "Blockers",
    branding: "Branding",
    businessAddress: "Business address",
    canEditNo: "Read only",
    canEditYes: "Editing allowed",
    contact: "Contact",
    countryCode: "Country",
    currentPassword: "Current password",
    dataSourceFallback: "Fallback",
    dataSourceLive: "Database",
    displayName: "Display name",
    dpoContact: "DPO / privacy contact",
    draft: "Draft",
    email: "Email",
    invite: "Invite",
    inviteLink: "Invite link",
    jurisdiction: "Jurisdiction",
    legalForm: "Legal form",
    legalName: "Company name",
    licenses: "Licences",
    master: "Master data",
    newPassword: "New password",
    noIssues: "No open preflight issues.",
    operator: "Novalure operator profile",
    password: "Password",
    passwordConfirm: "Confirm new password",
    passwordReset: "Password link",
    passwordUpdated: "Password updated.",
    privacy: "Privacy",
    privacyContact: "Privacy contact",
    publicEmail: "Public email",
    publicPhone: "Phone",
    register: "Legal & register",
    registerCourt: "Register court",
    registeredOfficeAddress: "Registered office",
    registrationAuthority: "Registration authority",
    registrationNumber: "Registration number",
    representation: "Representation",
    representatives: "Authorised representatives, one person per line",
    resend: "Resend",
    revoke: "Suspend",
    save: "Save",
    setupSent: "Setup link created.",
    status: "Status",
    suspended: "Suspended",
    taxNumber: "Tax number",
    title: "Company & access",
    usage: "Usage",
    users: "Team members",
    vatId: "VAT ID",
    website: "Website",
    workspace: "My company",
  },
} as const;

const roleLabels: Record<ProductRole, string> = {
  assistant_backoffice: "Backoffice",
  broker_agent: "Makler / Agent",
  customer_owner: "Owner",
  developer_sales: "Projektvertrieb Lead",
  external_partner: "Externer Partner",
  novalureAdmin: "Novalure Admin",
  novalureGrowth: "Novalure Growth",
  novalureServiceOps: "Novalure Service Ops",
  novalure_customer_success: "Novalure Customer Success",
  novalure_onboarding: "Novalure Onboarding",
  novalure_operator: "Novalure Operator",
  novalure_sales: "Novalure Sales",
  platform_admin: "Platform Admin",
  project_sales_member: "Projektvertrieb",
  team_member: "Teammitglied",
  viewer: "Viewer",
  workspace_admin: "Workspace Admin",
};

function isOperatorAdmin(context: WorkspaceProductContext) {
  return context.productRole === "platform_admin" || context.productRole === "novalureAdmin";
}

function profileScopeLabel(scope: CompanyProfileScope, language: LanguageCode) {
  const text = copy[language];
  if (scope === "platform_operator") return text.operator;
  if (scope === "crm_account") return text.account;
  return text.workspace;
}

function tabLabel(tab: ProfileTab, language: LanguageCode) {
  return copy[language][tab];
}

function getRecordText(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function formatRepresentatives(value: unknown[]) {
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && "name" in item && typeof item.name === "string") {
        return item.name;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function parseRepresentatives(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((name) => ({ name }));
}

function getProfileUrl(scope: CompanyProfileScope, organizationId: string) {
  const params = new URLSearchParams({ scope });
  if (scope === "crm_account" && organizationId) params.set("organizationId", organizationId);
  return `/api/settings/company-profile?${params.toString()}`;
}

async function readJsonResponse<T>(response: Response): Promise<T | null> {
  try {
    return await response.json() as T;
  } catch {
    return null;
  }
}

function inputClass() {
  return "min-h-10 rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-slate-950 outline-none focus:border-slate-950";
}

function labelClass() {
  return "grid gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500";
}

function SmallButton({
  children,
  disabled,
  onClick,
  type = "button",
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
}) {
  return (
    <button
      className="rounded-md border border-slate-950 bg-slate-950 px-3 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:border-stone-300 disabled:bg-stone-200 disabled:text-stone-500"
      disabled={disabled}
      onClick={onClick}
      type={type}
    >
      {children}
    </button>
  );
}

function Field({
  label,
  onChange,
  value,
  disabled,
  type = "text",
}: {
  disabled?: boolean;
  label: string;
  onChange: (value: string) => void;
  type?: string;
  value: string;
}) {
  return (
    <label className={labelClass()}>
      {label}
      <input
        className={inputClass()}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        type={type}
        value={value}
      />
    </label>
  );
}

function IssueList({
  issues,
  language,
}: {
  issues: CompanyProfilePreflightIssue[];
  language: LanguageCode;
}) {
  const text = copy[language];
  if (!issues.length) {
    return (
      <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-900">
        {text.noIssues}
      </p>
    );
  }

  return (
    <div className="grid gap-2">
      {issues.map((issue) => (
        <p
          className={`rounded-md border px-3 py-2 text-sm font-semibold ${
            issue.severity === "blocker"
              ? "border-amber-200 bg-amber-50 text-amber-950"
              : "border-blue-200 bg-blue-50 text-blue-950"
          }`}
          key={`${issue.field}-${issue.message}`}
        >
          {issue.message}
        </p>
      ))}
    </div>
  );
}

export function CompanyProfileSettings({
  context,
  language,
}: {
  context: WorkspaceProductContext;
  language: LanguageCode;
}) {
  const text = copy[language];
  const [profileScope, setProfileScope] = useState<CompanyProfileScope>("workspace_owner");
  const [activeTab, setActiveTab] = useState<ProfileTab>("master");
  const [organizationId, setOrganizationId] = useState("");
  const [payload, setPayload] = useState<CompanyProfilePayload | null>(null);
  const [draft, setDraft] = useState<CompanyProfile | null>(null);
  const [representativesText, setRepresentativesText] = useState("");
  const [profileMessage, setProfileMessage] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);
  const [accessPayload, setAccessPayload] = useState<WorkspaceAccessSettingsPayload | null>(null);
  const [accessMessage, setAccessMessage] = useState("");
  const [accessBusy, setAccessBusy] = useState("");
  const [inviteDraft, setInviteDraft] = useState({
    email: "",
    name: "",
    productRole: "team_member" as ProductRole,
  });
  const [passwordDraft, setPasswordDraft] = useState({
    confirmation: "",
    currentPassword: "",
    password: "",
  });
  const canLoadCurrentProfile = profileScope !== "crm_account" || organizationId.trim().length > 0;
  const canShowOperator = isOperatorAdmin(context);
  const profileScopes = useMemo<CompanyProfileScope[]>(
    () => canShowOperator ? ["workspace_owner", "platform_operator", "crm_account"] : ["workspace_owner", "crm_account"],
    [canShowOperator],
  );

  const loadProfile = useCallback(async () => {
    await Promise.resolve();

    if (!canLoadCurrentProfile) {
      setPayload(null);
      setDraft(null);
      setRepresentativesText("");
      return;
    }

    setProfileBusy(true);
    setProfileMessage("");
    const response = await fetch(getProfileUrl(profileScope, organizationId.trim()));
    const nextPayload = response.ok ? await readJsonResponse<CompanyProfilePayload>(response) : null;
    if (!nextPayload) {
      setPayload(null);
      setDraft(null);
      setProfileMessage(response.status === 403 ? "forbidden" : "load_failed");
      setProfileBusy(false);
      return;
    }

    setPayload(nextPayload);
    setDraft(nextPayload.profile);
    setRepresentativesText(formatRepresentatives(nextPayload.profile.representatives));
    setProfileBusy(false);
  }, [canLoadCurrentProfile, organizationId, profileScope]);

  const loadAccess = useCallback(async () => {
    await Promise.resolve();

    const response = await fetch("/api/settings/access/users");
    const nextPayload = response.ok ? await readJsonResponse<WorkspaceAccessSettingsPayload>(response) : null;
    if (nextPayload) setAccessPayload(nextPayload);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadProfile();
    }, 0);

    return () => window.clearTimeout(timer);
  }, [loadProfile]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadAccess();
    }, 0);

    return () => window.clearTimeout(timer);
  }, [loadAccess]);

  function updateProfileField<K extends keyof CompanyProfile>(field: K, value: CompanyProfile[K]) {
    setDraft((current) => current ? { ...current, [field]: value } : current);
  }

  function updateRecordField(field: "brand" | "licenses", key: string, value: string) {
    setDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        [field]: {
          ...current[field],
          [key]: value,
        },
      };
    });
  }

  function updateUsage(key: CompanyProfileUsageKey, value: boolean) {
    setDraft((current) => current ? {
      ...current,
      usageSettings: {
        ...current.usageSettings,
        [key]: value,
      },
    } : current);
  }

  async function saveProfile() {
    if (!draft) return;
    setProfileBusy(true);
    setProfileMessage("");
    const response = await fetch("/api/settings/company-profile", {
      body: JSON.stringify({
        ...draft,
        organizationId: profileScope === "crm_account" ? organizationId.trim() : undefined,
        profileScope,
        representatives: parseRepresentatives(representativesText),
      }),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    });
    const nextPayload = response.ok ? await readJsonResponse<CompanyProfilePayload>(response) : null;
    if (!nextPayload) {
      const failure = await readJsonResponse<{ error?: string }>(response);
      setProfileMessage(failure?.error ?? "save_failed");
      setProfileBusy(false);
      return;
    }
    setPayload(nextPayload);
    setDraft(nextPayload.profile);
    setRepresentativesText(formatRepresentatives(nextPayload.profile.representatives));
    setProfileMessage("saved");
    setProfileBusy(false);
  }

  function patchAccessUser(userId: string, patch: Partial<WorkspaceUser>) {
    setAccessPayload((current) => current ? {
      ...current,
      users: current.users.map((user) => user.id === userId ? { ...user, ...patch } : user),
    } : current);
  }

  async function refreshAccessFromResponse(response: Response) {
    const nextPayload = response.ok ? await readJsonResponse<WorkspaceAccessSettingsPayload & { lastAction?: { setupUrl?: string } }>(response) : null;
    if (!nextPayload) {
      const failure = await readJsonResponse<{ error?: string }>(response);
      setAccessMessage(failure?.error ?? "access_failed");
      return;
    }
    setAccessPayload(nextPayload);
    setAccessMessage(nextPayload.lastAction?.setupUrl ? `${text.setupSent} ${nextPayload.lastAction.setupUrl}` : "saved");
  }

  async function inviteUser() {
    setAccessBusy("invite");
    setAccessMessage("");
    const role = mapProductRoleToTechnicalRole(inviteDraft.productRole);
    const response = await fetch("/api/settings/access/users", {
      body: JSON.stringify({ ...inviteDraft, role }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    await refreshAccessFromResponse(response);
    if (response.ok) setInviteDraft({ email: "", name: "", productRole: "team_member" });
    setAccessBusy("");
  }

  async function updateUser(user: WorkspaceUser) {
    setAccessBusy(user.id);
    setAccessMessage("");
    const response = await fetch("/api/settings/access/users", {
      body: JSON.stringify({
        productRole: user.productRole,
        role: user.role,
        status: user.status,
        userId: user.id,
      }),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    });
    await refreshAccessFromResponse(response);
    setAccessBusy("");
  }

  async function runAccessAction(action: AccessAction, userId: string) {
    setAccessBusy(`${action}:${userId}`);
    setAccessMessage("");
    const response = await fetch("/api/settings/access/users", {
      body: JSON.stringify({ operation: action, userId }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    await refreshAccessFromResponse(response);
    setAccessBusy("");
  }

  async function changePassword() {
    setAccessBusy("password");
    setAccessMessage("");
    const response = await fetch("/api/settings/access/password", {
      body: JSON.stringify(passwordDraft),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    });
    if (response.ok) {
      setPasswordDraft({ confirmation: "", currentPassword: "", password: "" });
      setAccessMessage(text.passwordUpdated);
    } else {
      const failure = await readJsonResponse<{ error?: string }>(response);
      setAccessMessage(failure?.error ?? "password_failed");
    }
    setAccessBusy("");
  }

  const statusOptions: CompanyProfileStatus[] = payload?.canApprove
    ? ["draft", "needs_review", "approved", "locked"]
    : ["draft", "needs_review"];

  return (
    <section className="grid min-w-0 gap-4">
      <article className="min-w-0 rounded-lg border border-slate-200 bg-white p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">{text.title}</p>
            <h4 className="mt-1 break-words text-xl font-semibold text-slate-950">
              {profileScopeLabel(profileScope, language)}
            </h4>
          </div>
          <div className="flex flex-wrap gap-2">
            {profileScopes.map((scope) => (
              <button
                className={`rounded-md border px-3 py-2 text-sm font-semibold ${
                  profileScope === scope
                    ? "border-slate-950 bg-slate-950 text-white"
                    : "border-stone-300 bg-white text-stone-700 hover:border-slate-950"
                }`}
                key={scope}
                onClick={() => {
                  setProfileScope(scope);
                  setActiveTab("master");
                }}
                type="button"
              >
                {profileScopeLabel(scope, language)}
              </button>
            ))}
          </div>
        </div>

        {profileScope === "crm_account" ? (
          <div className="mt-4 grid gap-2 md:grid-cols-[minmax(240px,1fr)_minmax(0,2fr)]">
            <Field
              label={text.accountOrgId}
              onChange={setOrganizationId}
              value={organizationId}
            />
            <p className="self-end rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-950">
              {text.accountOrgIdHint}
            </p>
          </div>
        ) : null}

        <div className="mt-4 flex flex-wrap gap-2">
          {profileTabs.map((tab) => (
            <button
              className={`rounded-md border px-3 py-2 text-xs font-semibold ${
                activeTab === tab
                  ? "border-emerald-700 bg-emerald-50 text-emerald-900"
                  : "border-stone-200 bg-stone-50 text-stone-600 hover:border-stone-400"
              }`}
              key={tab}
              onClick={() => setActiveTab(tab)}
              type="button"
            >
              {tabLabel(tab, language)}
            </button>
          ))}
        </div>

        {!canLoadCurrentProfile ? (
          <p className="mt-5 rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-sm font-semibold text-stone-700">
            {text.accountOrgIdHint}
          </p>
        ) : null}

        {draft ? (
          <div className="mt-5 grid gap-4">
            {activeTab === "master" ? (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                <Field disabled={!payload?.canEdit} label={text.displayName} onChange={(value) => updateProfileField("displayName", value)} value={draft.displayName} />
                <Field disabled={!payload?.canEdit} label={text.legalName} onChange={(value) => updateProfileField("legalName", value)} value={draft.legalName} />
                <Field disabled={!payload?.canEdit} label={text.legalForm} onChange={(value) => updateProfileField("legalForm", value)} value={draft.legalForm} />
                <label className={labelClass()}>
                  {text.countryCode}
                  <select
                    className={inputClass()}
                    disabled={!payload?.canEdit}
                    onChange={(event) => updateProfileField("countryCode", event.target.value)}
                    value={draft.countryCode}
                  >
                    <option value="AT">AT</option>
                    <option value="DE">DE</option>
                    <option value="IE">IE</option>
                  </select>
                </label>
                <Field disabled={!payload?.canEdit} label={text.jurisdiction} onChange={(value) => updateProfileField("jurisdiction", value)} value={draft.jurisdiction} />
              </div>
            ) : null}

            {activeTab === "register" ? (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                <Field disabled={!payload?.canEdit} label={text.registrationNumber} onChange={(value) => updateProfileField("registrationNumber", value)} value={draft.registrationNumber} />
                <Field disabled={!payload?.canEdit} label={text.registrationAuthority} onChange={(value) => updateProfileField("registrationAuthority", value)} value={draft.registrationAuthority} />
                <Field disabled={!payload?.canEdit} label={text.registerCourt} onChange={(value) => updateProfileField("registerCourt", value)} value={draft.registerCourt} />
                <Field disabled={!payload?.canEdit} label={text.vatId} onChange={(value) => updateProfileField("vatId", value)} value={draft.vatId} />
                <Field disabled={!payload?.canEdit} label={text.taxNumber} onChange={(value) => updateProfileField("taxNumber", value)} value={draft.taxNumber} />
              </div>
            ) : null}

            {activeTab === "contact" ? (
              <div className="grid gap-3 md:grid-cols-2">
                <Field disabled={!payload?.canEdit} label={text.businessAddress} onChange={(value) => updateProfileField("businessAddress", value)} value={draft.businessAddress} />
                <Field disabled={!payload?.canEdit} label={text.registeredOfficeAddress} onChange={(value) => updateProfileField("registeredOfficeAddress", value)} value={draft.registeredOfficeAddress} />
                <Field disabled={!payload?.canEdit} label={text.billingAddress} onChange={(value) => updateProfileField("billingAddress", value)} value={draft.billingAddress} />
                <Field disabled={!payload?.canEdit} label={text.publicEmail} onChange={(value) => updateProfileField("publicEmail", value)} type="email" value={draft.publicEmail} />
                <Field disabled={!payload?.canEdit} label={text.publicPhone} onChange={(value) => updateProfileField("publicPhone", value)} value={draft.publicPhone} />
                <Field disabled={!payload?.canEdit} label={text.website} onChange={(value) => updateProfileField("website", value)} value={draft.website} />
              </div>
            ) : null}

            {activeTab === "representation" ? (
              <label className={labelClass()}>
                {text.representatives}
                <textarea
                  className="min-h-32 rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold normal-case tracking-normal text-slate-950 outline-none focus:border-slate-950"
                  disabled={!payload?.canEdit}
                  onChange={(event) => setRepresentativesText(event.target.value)}
                  value={representativesText}
                />
              </label>
            ) : null}

            {activeTab === "licenses" ? (
              <div className="grid gap-3 md:grid-cols-2">
                <Field disabled={!payload?.canEdit} label="Real Estate / Maklerlizenz" onChange={(value) => updateRecordField("licenses", "realEstate", value)} value={getRecordText(draft.licenses, "realEstate")} />
                <Field disabled={!payload?.canEdit} label="Aufsichtsbehoerde" onChange={(value) => updateRecordField("licenses", "supervisoryAuthority", value)} value={getRecordText(draft.licenses, "supervisoryAuthority")} />
                <Field disabled={!payload?.canEdit} label="Gewerbebehoerde" onChange={(value) => updateRecordField("licenses", "tradeAuthority", value)} value={getRecordText(draft.licenses, "tradeAuthority")} />
                <Field disabled={!payload?.canEdit} label="PSRA Licence" onChange={(value) => updateRecordField("licenses", "psraLicence", value)} value={getRecordText(draft.licenses, "psraLicence")} />
              </div>
            ) : null}

            {activeTab === "privacy" ? (
              <div className="grid gap-3 md:grid-cols-2">
                <Field disabled={!payload?.canEdit} label={text.privacyContact} onChange={(value) => updateProfileField("privacyContact", value)} value={draft.privacyContact} />
                <Field disabled={!payload?.canEdit} label={text.dpoContact} onChange={(value) => updateProfileField("dpoContact", value)} value={draft.dpoContact} />
              </div>
            ) : null}

            {activeTab === "branding" ? (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                <Field disabled={!payload?.canEdit} label="Brand Name" onChange={(value) => updateRecordField("brand", "businessName", value)} value={getRecordText(draft.brand, "businessName")} />
                <Field disabled={!payload?.canEdit} label="Logo URL" onChange={(value) => updateRecordField("brand", "logoUrl", value)} value={getRecordText(draft.brand, "logoUrl")} />
                <Field disabled={!payload?.canEdit} label="Primary Color" onChange={(value) => updateRecordField("brand", "primaryColor", value)} value={getRecordText(draft.brand, "primaryColor")} />
              </div>
            ) : null}

            {activeTab === "usage" ? (
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {usageKeys.map((key) => (
                  <label className="flex min-h-12 items-center gap-3 rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-sm font-semibold text-slate-900" key={key}>
                    <input
                      checked={Boolean(draft.usageSettings[key])}
                      disabled={!payload?.canEdit}
                      onChange={(event) => updateUsage(key, event.target.checked)}
                      type="checkbox"
                    />
                    {key}
                  </label>
                ))}
              </div>
            ) : null}

            {activeTab === "approval" ? (
              <div className="grid gap-4 lg:grid-cols-[minmax(0,0.75fr)_minmax(0,1.25fr)]">
                <label className={labelClass()}>
                  {text.status}
                  <select
                    className={inputClass()}
                    disabled={!payload?.canEdit}
                    onChange={(event) => updateProfileField("status", event.target.value as CompanyProfileStatus)}
                    value={draft.status}
                  >
                    {statusOptions.map((status) => (
                      <option key={status} value={status}>{status}</option>
                    ))}
                  </select>
                </label>
                <div className="grid gap-3">
                  <IssueList issues={payload?.preflight.issues ?? []} language={language} />
                  {payload?.versions.length ? (
                    <div className="max-h-56 overflow-auto rounded-md border border-stone-200">
                      <table className="w-full min-w-[540px] text-left text-sm">
                        <thead className="bg-stone-50 text-xs uppercase tracking-[0.12em] text-stone-500">
                          <tr>
                            <th className="px-3 py-2 font-semibold">Action</th>
                            <th className="px-3 py-2 font-semibold">Fields</th>
                            <th className="px-3 py-2 font-semibold">Date</th>
                          </tr>
                        </thead>
                        <tbody>
                          {payload.versions.map((version) => (
                            <tr className="border-t border-stone-200" key={version.id}>
                              <td className="px-3 py-2 font-semibold text-slate-950">{version.action}</td>
                              <td className="px-3 py-2 text-stone-700">{version.changedFields.join(", ")}</td>
                              <td className="px-3 py-2 text-stone-700">{version.createdAt.slice(0, 16).replace("T", " ")}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-stone-200 pt-4">
              <div className="flex flex-wrap gap-2 text-xs font-semibold">
                <span className="rounded-md bg-stone-100 px-2.5 py-1.5 text-stone-700">
                  {payload?.source === "database" ? text.dataSourceLive : text.dataSourceFallback}
                </span>
                <span className={`rounded-md px-2.5 py-1.5 ${payload?.canEdit ? "bg-emerald-50 text-emerald-900" : "bg-stone-100 text-stone-600"}`}>
                  {payload?.canEdit ? text.canEditYes : text.canEditNo}
                </span>
                {payload?.preflight.blockers.length ? (
                  <span className="rounded-md bg-amber-50 px-2.5 py-1.5 text-amber-950">
                    {text.blockers}: {payload.preflight.blockers.length}
                  </span>
                ) : null}
              </div>
              <SmallButton disabled={!payload?.canEdit || profileBusy} onClick={saveProfile}>
                {profileBusy ? "..." : text.save}
              </SmallButton>
            </div>
            {profileMessage ? (
              <p className="rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-sm font-semibold text-stone-700">{profileMessage}</p>
            ) : null}
          </div>
        ) : null}
      </article>

      <article className="min-w-0 rounded-lg border border-slate-200 bg-white p-5">
        <div className="flex flex-col gap-1">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">{text.access}</p>
          <h4 className="break-words text-xl font-semibold text-slate-950">{text.users}</h4>
        </div>

        <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(280px,0.8fr)]">
          <div className="min-w-0">
            {accessPayload?.canManage ? (
              <div className="mb-4 grid gap-3 rounded-lg border border-stone-200 bg-stone-50 p-4 md:grid-cols-[minmax(180px,1fr)_minmax(180px,1fr)_minmax(180px,1fr)_auto]">
                <Field label="Name" onChange={(value) => setInviteDraft((current) => ({ ...current, name: value }))} value={inviteDraft.name} />
                <Field label={text.email} onChange={(value) => setInviteDraft((current) => ({ ...current, email: value }))} type="email" value={inviteDraft.email} />
                <label className={labelClass()}>
                  Rolle
                  <select
                    className={inputClass()}
                    onChange={(event) => setInviteDraft((current) => ({ ...current, productRole: event.target.value as ProductRole }))}
                    value={inviteDraft.productRole}
                  >
                    {productRoleOptions.map((role) => (
                      <option key={role} value={role}>{roleLabels[role]}</option>
                    ))}
                  </select>
                </label>
                <div className="self-end">
                  <SmallButton disabled={accessBusy === "invite"} onClick={inviteUser}>{text.invite}</SmallButton>
                </div>
              </div>
            ) : null}

            <div className="max-w-full overflow-x-auto rounded-lg border border-stone-200">
              <table className="w-full min-w-[860px] text-left text-sm">
                <thead className="bg-stone-50 text-xs uppercase tracking-[0.12em] text-stone-500">
                  <tr>
                    <th className="px-3 py-2 font-semibold">Name</th>
                    <th className="px-3 py-2 font-semibold">{text.email}</th>
                    <th className="px-3 py-2 font-semibold">Produktrolle</th>
                    <th className="px-3 py-2 font-semibold">Workspace Rolle</th>
                    <th className="px-3 py-2 font-semibold">{text.status}</th>
                    <th className="px-3 py-2 font-semibold">Aktion</th>
                  </tr>
                </thead>
                <tbody>
                  {(accessPayload?.users ?? []).map((user) => (
                    <tr className="border-t border-stone-200 align-top" key={user.id}>
                      <td className="px-3 py-3 font-semibold text-slate-950">{user.name}</td>
                      <td className="px-3 py-3 text-stone-700">{user.email}</td>
                      <td className="px-3 py-3">
                        <select
                          className="min-h-9 rounded-md border border-stone-300 bg-white px-2 py-1 text-xs font-semibold text-slate-950"
                          disabled={!accessPayload?.canManage}
                          onChange={(event) => {
                            const productRole = event.target.value as ProductRole;
                            patchAccessUser(user.id, {
                              productRole,
                              role: mapProductRoleToTechnicalRole(productRole),
                            });
                          }}
                          value={user.productRole ?? "viewer"}
                        >
                          {productRoleOptions.map((role) => (
                            <option key={role} value={role}>{roleLabels[role]}</option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-3">
                        <select
                          className="min-h-9 rounded-md border border-stone-300 bg-white px-2 py-1 text-xs font-semibold text-slate-950"
                          disabled={!accessPayload?.canManage}
                          onChange={(event) => patchAccessUser(user.id, { role: event.target.value as WorkspaceRole })}
                          value={user.role}
                        >
                          {workspaceRoleOptions.map((role) => (
                            <option key={role} value={role}>{role}</option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-3">
                        <select
                          className="min-h-9 rounded-md border border-stone-300 bg-white px-2 py-1 text-xs font-semibold text-slate-950"
                          disabled={!accessPayload?.canManage}
                          onChange={(event) => patchAccessUser(user.id, { status: event.target.value as WorkspaceUser["status"] })}
                          value={user.status}
                        >
                          <option value="active">{text.approved}</option>
                          <option value="invited">{text.inviteLink}</option>
                          <option value="suspended">{text.suspended}</option>
                        </select>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex flex-wrap gap-2">
                          <SmallButton disabled={!accessPayload?.canManage || accessBusy === user.id} onClick={() => updateUser(user)}>{text.save}</SmallButton>
                          {user.status === "invited" ? (
                            <SmallButton disabled={!accessPayload?.canManage || accessBusy === `resend_invitation:${user.id}`} onClick={() => runAccessAction("resend_invitation", user.id)}>{text.resend}</SmallButton>
                          ) : null}
                          <SmallButton disabled={!accessPayload?.canManage || accessBusy === `password_reset:${user.id}`} onClick={() => runAccessAction("password_reset", user.id)}>{text.passwordReset}</SmallButton>
                          <SmallButton disabled={!accessPayload?.canManage || accessBusy === `revoke_invitation:${user.id}`} onClick={() => runAccessAction("revoke_invitation", user.id)}>{text.revoke}</SmallButton>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {accessPayload && !accessPayload.users.length ? (
                    <tr>
                      <td className="px-3 py-4 text-sm font-semibold text-stone-600" colSpan={6}>
                        {text.users}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>

          <div className="min-w-0 rounded-lg border border-stone-200 bg-stone-50 p-4">
            <h5 className="text-sm font-semibold text-slate-950">{text.password}</h5>
            <div className="mt-3 grid gap-3">
              <Field label={text.currentPassword} onChange={(value) => setPasswordDraft((current) => ({ ...current, currentPassword: value }))} type="password" value={passwordDraft.currentPassword} />
              <Field label={text.newPassword} onChange={(value) => setPasswordDraft((current) => ({ ...current, password: value }))} type="password" value={passwordDraft.password} />
              <Field label={text.passwordConfirm} onChange={(value) => setPasswordDraft((current) => ({ ...current, confirmation: value }))} type="password" value={passwordDraft.confirmation} />
              <SmallButton disabled={accessBusy === "password"} onClick={changePassword}>{text.save}</SmallButton>
            </div>
            {accessMessage ? (
              <p className="mt-4 break-words rounded-md border border-stone-200 bg-white px-3 py-2 text-sm font-semibold text-stone-700">
                {accessMessage}
              </p>
            ) : null}
          </div>
        </div>
      </article>
    </section>
  );
}
