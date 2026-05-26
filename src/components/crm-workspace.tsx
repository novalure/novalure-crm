"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  automations,
  botCallInsights,
  botLeadWorkflows,
  botLanguageRules,
  contactRelationships,
  contactTimeline,
  consents,
  conversations,
  crmBotConversations,
  crmBotTools,
  customerWorkspaceAccess,
  funnels,
  knowledgeBase,
  leadSequenceEvents,
  leadSequences,
  newsletterAutomations,
  newsletterDeliverability,
  newsletterSuppressions,
  newsletterTemplates,
  organizations,
  sellerListings,
  pipeline,
  users,
  workspace,
} from "@/lib/crm-source";
import { BotCommandCenter } from "@/components/bot-command-center";
import { BotLanguageTester } from "@/components/bot-language-tester";
import { CalendarCommandCenter } from "@/components/calendar-command-center";
import { CrmAnalysisBot } from "@/components/crm-analysis-bot";
import { ContactCommandCenter } from "@/components/contact-command-center";
import { CustomerAccessCockpit } from "@/components/customer-access-cockpit";
import { DashboardOverview } from "@/components/dashboard-overview";
import { DataHygieneBoard } from "@/components/data-hygiene-board";
import { DealPipelineWorkspace } from "@/components/deal-pipeline-workspace";
import { FormCommandCenter } from "@/components/form-command-center";
import { FunnelCommandCenter } from "@/components/funnel-command-center";
import { KnowledgeCommandCenter } from "@/components/knowledge-command-center";
import { LeadInbox } from "@/components/lead-inbox";
import { LeadSequenceCommandCenter } from "@/components/lead-sequence-command-center";
import { MobileDailyWork, type MobileDailyPanel } from "@/components/mobile-daily-work";
import { NewsletterCommandCenter } from "@/components/newsletter-command-center";
import { TaskCommandCenter } from "@/components/task-command-center";
import { UnitBoard } from "@/components/unit-board";
import type { CoreCrmDataResult } from "@/lib/db/crm-loaders";
import type {
  CalendarEvent,
  BrokerMandate,
  ConsentRecord,
  Contact,
  Conversation,
  CustomerWorkspaceAccess,
  BuyerSearchProfile,
  Deal,
  Lead,
  Project,
  PropertyReservation,
  PropertyUnit,
  SellerListing,
  Task,
  WorkspaceUser,
  WorkspaceRole,
} from "@/lib/crm-types";
import {
  createWorkspaceProductContext,
  hasProductCapability,
  type CalendarProviderChoice,
  type ProductRole,
  type WorkspaceCustomerType,
  type WorkspaceOperatingModel,
  type WorkspaceProductContext,
  type WorkspaceTeamStructure,
} from "@/lib/product-model";
import {
  defaultLanguage,
  getDashboardCopy,
  getCrmStatusLabel,
  languageStorageKeys,
  resolveLanguage,
  supportedLanguages,
  type LanguageCode,
} from "@/lib/i18n";

type DashboardSection =
  | "dashboard"
  | "analytics"
  | "leadInbox"
  | "pipelines"
  | "projects"
  | "objectsMandates"
  | "settings"
  | "units"
  | "customerAccess"
  | "managedService"
  | "onboarding"
  | "customerSuccess"
  | "contacts"
  | "communication"
  | "dataHygiene"
  | "tasks"
  | "sequences"
  | "analysis"
  | "funnels"
  | "bots"
  | "knowledge"
  | "newsletter"
  | "forms"
  | "calendar";

type HeaderActionModal = "import" | "project" | null;

type ImportSource = "hubspot" | "csv" | "contacts" | "meetings";

type ProjectWizardDraft = {
  calendarProvider: CalendarProviderChoice;
  customerType: WorkspaceCustomerType;
  funnelTemplateId: string;
  meetingProvider: "microsoft-teams" | "google-meet" | "manual-link";
  name: string;
  notes: string;
  operatingModel: WorkspaceOperatingModel;
  ownerUserId: string;
  pipelineId: string;
  teamStructure: WorkspaceTeamStructure;
  type: string;
};

type ManagedWorkspaceOption = {
  activeCalendarProvider?: CalendarProviderChoice | null;
  activeProjects?: number;
  activeUsers?: number;
  customerType?: WorkspaceCustomerType | null;
  id: string;
  name: string;
  operatingModel?: WorkspaceOperatingModel | null;
  productRole?: ProductRole | null;
  teamStructure?: WorkspaceTeamStructure | null;
};

type NavigationPresetId =
  | "novalureInternal"
  | "realEstateBroker"
  | "propertyDeveloper"
  | "managedService"
  | "hybridRealEstate"
  | "sales"
  | "salesLead"
  | "marketing"
  | "assistant"
  | "management"
  | "newUser"
  | "admin";

type NavigationEntryId =
  | "analysis"
  | "analytics"
  | "appointments"
  | "approvals"
  | "auditLog"
  | "bots"
  | "buyerLeads"
  | "buyerProfiles"
  | "calendar"
  | "consultations"
  | "contacts"
  | "communication"
  | "customerAccess"
  | "customerReport"
  | "customerSuccess"
  | "customerSwitch"
  | "dashboard"
  | "dailyQueue"
  | "dataHygiene"
  | "demosTrials"
  | "developerLeads"
  | "forms"
  | "followUpQueue"
  | "funnels"
  | "knowledge"
  | "leadInbox"
  | "managedService"
  | "newsletter"
  | "objectsMandates"
  | "onboarding"
  | "pipelines"
  | "projectAnalytics"
  | "projectOverview"
  | "projectPipeline"
  | "projects"
  | "reservations"
  | "sellerLeads"
  | "settings"
  | "slaCockpit"
  | "tasks"
  | "units"
  | "workspaces";

type QuickActionId =
  | "reviewImport"
  | "newProject"
  | "dashboard"
  | "leadInbox"
  | "pipeline"
  | "tasks"
  | "meetings"
  | "customerAccess"
  | "dataHygiene"
  | "units"
  | "analysis"
  | "newsletter"
  | "bots"
  | "funnels"
  | "forms";

type NavigationPreset = {
  mobilePanels: MobileDailyPanel[];
  navigationEntries: NavigationEntryId[];
  startSection: DashboardSection;
  startEntry: NavigationEntryId;
  quickActions: QuickActionId[];
};

const navigationPresetStorageKey = "novalure-crm-navigation-preset-v1";

const navigationPresetOrder: NavigationPresetId[] = [
  "novalureInternal",
  "realEstateBroker",
  "propertyDeveloper",
  "sales",
  "salesLead",
  "management",
  "marketing",
  "assistant",
  "newUser",
  "admin",
  "managedService",
  "hybridRealEstate",
];

const navigationPresets: Record<NavigationPresetId, NavigationPreset> = {
  novalureInternal: {
    mobilePanels: ["overdueSla", "hotLeads", "meetings", "tasks"],
    navigationEntries: [
      "dashboard",
      "workspaces",
      "projects",
      "leadInbox",
      "pipelines",
      "tasks",
      "calendar",
      "funnels",
      "newsletter",
      "bots",
      "knowledge",
      "analytics",
      "dataHygiene",
      "settings",
    ],
    startSection: "dashboard",
    startEntry: "dashboard",
    quickActions: ["customerAccess", "dataHygiene", "leadInbox", "pipeline", "newProject"],
  },
  realEstateBroker: {
    mobilePanels: ["overdueSla", "hotLeads", "meetings", "tasks"],
    navigationEntries: [
      "dashboard",
      "leadInbox",
      "sellerLeads",
      "buyerLeads",
      "contacts",
      "communication",
      "objectsMandates",
      "pipelines",
      "tasks",
      "calendar",
      "funnels",
      "newsletter",
      "bots",
      "knowledge",
      "analytics",
      "settings",
    ],
    startSection: "dashboard",
    startEntry: "dashboard",
    quickActions: ["leadInbox", "pipeline", "tasks", "meetings", "funnels"],
  },
  propertyDeveloper: {
    mobilePanels: ["overdueSla", "hotLeads", "meetings", "tasks"],
    navigationEntries: [
      "projectOverview",
      "developerLeads",
      "units",
      "reservations",
      "projectPipeline",
      "tasks",
      "calendar",
      "communication",
      "buyerProfiles",
      "projectAnalytics",
    ],
    startSection: "projects",
    startEntry: "projectOverview",
    quickActions: ["units", "pipeline", "meetings", "tasks", "funnels"],
  },
  managedService: {
    mobilePanels: ["overdueSla", "meetings", "tasks"],
    navigationEntries: [
      "customerSwitch",
      "managedService",
      "slaCockpit",
      "leadInbox",
      "communication",
      "tasks",
      "followUpQueue",
      "approvals",
      "customerReport",
      "auditLog",
      "dataHygiene",
      "calendar",
      "projectPipeline",
    ],
    startSection: "managedService",
    startEntry: "managedService",
    quickActions: ["customerAccess", "leadInbox", "tasks", "meetings", "pipeline"],
  },
  hybridRealEstate: {
    mobilePanels: ["overdueSla", "hotLeads", "meetings", "tasks"],
    navigationEntries: [
      "dashboard",
      "leadInbox",
      "sellerLeads",
      "buyerLeads",
      "projects",
      "units",
      "reservations",
      "pipelines",
      "contacts",
      "communication",
      "tasks",
      "calendar",
      "funnels",
      "bots",
      "knowledge",
      "newsletter",
      "analytics",
      "settings",
    ],
    startSection: "dashboard",
    startEntry: "dashboard",
    quickActions: ["leadInbox", "units", "pipeline", "tasks", "meetings"],
  },
  sales: {
    mobilePanels: ["overdueSla", "hotLeads", "meetings", "tasks"],
    navigationEntries: ["dailyQueue", "leadInbox", "contacts", "communication", "pipelines", "tasks", "calendar"],
    startSection: "tasks",
    startEntry: "dailyQueue",
    quickActions: ["leadInbox", "pipeline", "tasks", "meetings"],
  },
  salesLead: {
    mobilePanels: ["overdueSla", "hotLeads", "meetings", "tasks"],
    navigationEntries: ["dashboard", "pipelines", "leadInbox", "tasks", "contacts", "communication", "analytics"],
    startSection: "dashboard",
    startEntry: "dashboard",
    quickActions: ["leadInbox", "pipeline", "tasks", "dataHygiene"],
  },
  marketing: {
    mobilePanels: ["hotLeads", "meetings", "tasks"],
    navigationEntries: ["dashboard", "funnels", "newsletter", "leadInbox", "forms", "analytics", "communication"],
    startSection: "dashboard",
    startEntry: "dashboard",
    quickActions: ["funnels", "newsletter", "leadInbox", "analysis"],
  },
  assistant: {
    mobilePanels: ["meetings", "tasks"],
    navigationEntries: ["tasks", "dataHygiene", "contacts", "calendar", "communication", "forms", "leadInbox"],
    startSection: "tasks",
    startEntry: "tasks",
    quickActions: ["tasks", "meetings", "forms", "leadInbox"],
  },
  management: {
    mobilePanels: ["overdueSla", "hotLeads", "meetings", "tasks"],
    navigationEntries: ["dashboard", "analytics", "pipelines", "tasks", "customerAccess", "dataHygiene"],
    startSection: "analytics",
    startEntry: "analytics",
    quickActions: ["dashboard", "analysis", "pipeline", "dataHygiene"],
  },
  newUser: {
    mobilePanels: ["hotLeads", "meetings", "tasks"],
    navigationEntries: ["dashboard", "leadInbox", "tasks", "calendar", "pipelines"],
    startSection: "dashboard",
    startEntry: "dashboard",
    quickActions: ["leadInbox", "tasks", "meetings", "pipeline"],
  },
  admin: {
    mobilePanels: ["overdueSla", "meetings", "tasks"],
    navigationEntries: [
      "dashboard",
      "projects",
      "settings",
      "dataHygiene",
      "contacts",
      "communication",
      "calendar",
      "newsletter",
      "bots",
      "knowledge",
      "analytics",
    ],
    startSection: "settings",
    startEntry: "settings",
    quickActions: ["dataHygiene", "leadInbox", "newsletter", "bots", "newProject"],
  },
};

const quickActionSections: Partial<Record<QuickActionId, DashboardSection>> = {
  analysis: "analysis",
  bots: "bots",
  customerAccess: "customerAccess",
  dashboard: "dashboard",
  dataHygiene: "dataHygiene",
  forms: "forms",
  funnels: "funnels",
  leadInbox: "leadInbox",
  meetings: "calendar",
  newsletter: "newsletter",
  pipeline: "pipelines",
  tasks: "tasks",
  units: "units",
};

type NavigationEntry = {
  id: NavigationEntryId;
  leadTypes?: string[];
  section: DashboardSection;
};

const navigationEntries: Record<NavigationEntryId, NavigationEntry> = {
  analysis: { id: "analysis", section: "analysis" },
  analytics: { id: "analytics", section: "analytics" },
  appointments: { id: "appointments", section: "calendar" },
  approvals: { id: "approvals", section: "managedService" },
  auditLog: { id: "auditLog", section: "managedService" },
  bots: { id: "bots", section: "bots" },
  buyerLeads: { id: "buyerLeads", leadTypes: ["Käufer"], section: "leadInbox" },
  buyerProfiles: { id: "buyerProfiles", section: "objectsMandates" },
  calendar: { id: "calendar", section: "calendar" },
  consultations: { id: "consultations", section: "calendar" },
  contacts: { id: "contacts", section: "contacts" },
  communication: { id: "communication", section: "communication" },
  customerAccess: { id: "customerAccess", section: "customerAccess" },
  customerReport: { id: "customerReport", section: "managedService" },
  customerSuccess: { id: "customerSuccess", section: "customerSuccess" },
  customerSwitch: { id: "customerSwitch", section: "managedService" },
  dashboard: { id: "dashboard", section: "dashboard" },
  dailyQueue: { id: "dailyQueue", section: "tasks" },
  dataHygiene: { id: "dataHygiene", section: "dataHygiene" },
  demosTrials: { id: "demosTrials", section: "onboarding" },
  developerLeads: { id: "developerLeads", section: "leadInbox" },
  forms: { id: "forms", section: "forms" },
  followUpQueue: { id: "followUpQueue", section: "tasks" },
  funnels: { id: "funnels", section: "funnels" },
  knowledge: { id: "knowledge", section: "knowledge" },
  leadInbox: { id: "leadInbox", section: "leadInbox" },
  managedService: { id: "managedService", section: "managedService" },
  newsletter: { id: "newsletter", section: "newsletter" },
  objectsMandates: { id: "objectsMandates", section: "objectsMandates" },
  onboarding: { id: "onboarding", section: "onboarding" },
  pipelines: { id: "pipelines", section: "pipelines" },
  projectAnalytics: { id: "projectAnalytics", section: "analytics" },
  projectOverview: { id: "projectOverview", section: "projects" },
  projectPipeline: { id: "projectPipeline", section: "pipelines" },
  projects: { id: "projects", section: "projects" },
  reservations: { id: "reservations", section: "units" },
  sellerLeads: { id: "sellerLeads", leadTypes: ["Verkäufer"], section: "leadInbox" },
  settings: { id: "settings", section: "settings" },
  slaCockpit: { id: "slaCockpit", section: "leadInbox" },
  tasks: { id: "tasks", section: "tasks" },
  units: { id: "units", section: "units" },
  workspaces: { id: "workspaces", section: "managedService" },
};

function getDefaultNavigationPresetId(context: WorkspaceProductContext): NavigationPresetId {
  if (context.operatingModel === "novalure_internal") return "novalureInternal";
  if (context.operatingModel === "managed_by_novalure") return "managedService";
  if (context.customerType === "property_developer") return "propertyDeveloper";
  if (context.customerType === "hybrid_real_estate" || context.operatingModel === "hybrid") {
    return "hybridRealEstate";
  }
  return "realEstateBroker";
}

function getAllowedNavigationPresetIds(context: WorkspaceProductContext): NavigationPresetId[] {
  if (hasProductCapability(context.productRole, "novalure:internal")) {
    return navigationPresetOrder;
  }

  if (context.productRole === "assistant_backoffice") return ["assistant", getDefaultNavigationPresetId(context)];
  if (context.productRole === "developer_sales" || context.productRole === "project_sales_member") {
    return ["sales", "salesLead", "propertyDeveloper", "newUser"];
  }
  if (context.productRole === "broker_agent" || context.productRole === "team_member") {
    return ["sales", "newUser", "realEstateBroker"];
  }
  if (context.productRole === "customer_owner" || context.productRole === "workspace_admin") {
    return [getDefaultNavigationPresetId(context), "management", "salesLead", "sales", "marketing", "assistant", "admin", "newUser"];
  }
  if (context.operatingModel === "managed_by_novalure") return ["managedService"];
  if (context.customerType === "property_developer") return ["propertyDeveloper"];
  if (context.customerType === "hybrid_real_estate" || context.operatingModel === "hybrid") {
    return ["hybridRealEstate", "realEstateBroker", "propertyDeveloper"];
  }
  return ["realEstateBroker"];
}

const statusStyles: Record<string, string> = {
  Aktiv: "bg-emerald-100 text-emerald-800",
  Skaliert: "bg-blue-100 text-blue-800",
  Review: "bg-amber-100 text-amber-800",
  Neu: "bg-emerald-100 text-emerald-800",
  Qualifizieren: "bg-blue-100 text-blue-800",
  "Termin offen": "bg-amber-100 text-amber-800",
  Übergabe: "bg-violet-100 text-violet-800",
  Archiviert: "bg-slate-100 text-slate-700",
  Bereit: "bg-emerald-100 text-emerald-800",
  Training: "bg-violet-100 text-violet-800",
  Verbinden: "bg-blue-100 text-blue-800",
  Geplant: "bg-slate-100 text-slate-700",
};

const actionStatusStyles = {
  action: "border-blue-200 bg-blue-50 text-blue-900",
  ready: "border-emerald-200 bg-emerald-50 text-emerald-900",
  warning: "border-amber-200 bg-amber-50 text-amber-900",
} as const;

const normalRoleHiddenRecordPatterns = [
  /\bqa\b/i,
  /qa crm audit/i,
  /qa contact db first ui/i,
  /qa date deal/i,
  /qa public lead/i,
  /example\.test/i,
  /\bAUTO-[A-Z0-9-]+/i,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i,
  /\uFFFD/,
  /Ã/,
];

function isVisibleBusinessRecord(values: Array<string | number | null | undefined>) {
  const searchable = values
    .filter((value) => value !== null && value !== undefined)
    .map((value) => String(value))
    .join(" ");

  return !normalRoleHiddenRecordPatterns.some((pattern) => pattern.test(searchable));
}

function ModalShell({
  children,
  closeLabel,
  footer,
  onClose,
  title,
  eyebrow,
}: {
  children: ReactNode;
  closeLabel: string;
  eyebrow: string;
  footer: ReactNode;
  onClose: () => void;
  title: string;
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/35 px-4 py-6">
      <section
        aria-modal="true"
        className="max-h-[92vh] w-full max-w-5xl overflow-y-auto rounded-lg border border-stone-200 bg-white shadow-2xl"
        role="dialog"
      >
        <div className="flex items-start justify-between gap-4 border-b border-stone-200 px-5 py-4">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
              {eyebrow}
            </p>
            <h3 className="mt-1 break-words text-xl font-semibold text-slate-950">{title}</h3>
          </div>
          <button
            aria-label={closeLabel}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-stone-300 bg-white text-lg font-semibold text-slate-700 hover:bg-stone-100"
            onClick={onClose}
            type="button"
          >
            x
          </button>
        </div>
        <div className="px-5 py-5">{children}</div>
        <div className="flex flex-col gap-2 border-t border-stone-200 bg-stone-50 px-5 py-4 sm:flex-row sm:justify-end">
          {footer}
        </div>
      </section>
    </div>
  );
}

function NavigationIcon({ section }: { section: DashboardSection }) {
  const iconClass = "h-4 w-4";

  switch (section) {
    case "dashboard":
      return (
        <svg aria-hidden="true" className={iconClass} fill="none" viewBox="0 0 24 24">
          <path d="M4 5.5h6v6H4zM14 5.5h6v6h-6zM4 15h6v3.5H4zM14 15h6v3.5h-6z" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      );
    case "leadInbox":
      return (
        <svg aria-hidden="true" className={iconClass} fill="none" viewBox="0 0 24 24">
          <path d="M4 5h16v10l-3 4H7l-3-4z" stroke="currentColor" strokeWidth="1.8" />
          <path d="M8 15h8M9 9h6" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
        </svg>
      );
    case "pipelines":
      return (
        <svg aria-hidden="true" className={iconClass} fill="none" viewBox="0 0 24 24">
          <path d="M5 5h4v14H5zM10 8h4v11h-4zM15 11h4v8h-4z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" />
        </svg>
      );
    case "units":
      return (
        <svg aria-hidden="true" className={iconClass} fill="none" viewBox="0 0 24 24">
          <path d="M5 20V5h14v15M8 9h2M14 9h2M8 13h2M14 13h2M4 20h16" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
          <path d="M10 20v-4h4v4" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" />
        </svg>
      );
    case "customerAccess":
      return (
        <svg aria-hidden="true" className={iconClass} fill="none" viewBox="0 0 24 24">
          <path d="M12 4.5 19 8v5c0 4-2.7 6.4-7 7-4.3-.6-7-3-7-7V8z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" />
          <path d="M9.5 12.5 11.4 14.4 15.3 10" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
        </svg>
      );
    case "managedService":
      return (
        <svg aria-hidden="true" className={iconClass} fill="none" viewBox="0 0 24 24">
          <path d="M5 5.5h14v13H5z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" />
          <path d="M8 9h8M8 13h5M8 17h7" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
        </svg>
      );
    case "onboarding":
      return (
        <svg aria-hidden="true" className={iconClass} fill="none" viewBox="0 0 24 24">
          <path d="M5 12.5 10 17 19 7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
          <path d="M5 20h14" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
        </svg>
      );
    case "customerSuccess":
      return (
        <svg aria-hidden="true" className={iconClass} fill="none" viewBox="0 0 24 24">
          <path d="M12 20s7-4.2 7-10a4 4 0 0 0-7-2.7A4 4 0 0 0 5 10c0 5.8 7 10 7 10Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" />
        </svg>
      );
    case "contacts":
      return (
        <svg aria-hidden="true" className={iconClass} fill="none" viewBox="0 0 24 24">
          <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM5 20c.9-3.4 3.4-5 7-5s6.1 1.6 7 5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
        </svg>
      );
    case "communication":
      return (
        <svg aria-hidden="true" className={iconClass} fill="none" viewBox="0 0 24 24">
          <path d="M5 6.5h14v9H9l-4 3z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" />
          <path d="M8.5 10h7M8.5 13h4" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
        </svg>
      );
    case "dataHygiene":
      return (
        <svg aria-hidden="true" className={iconClass} fill="none" viewBox="0 0 24 24">
          <path d="M5 6h14M5 12h14M5 18h14" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
          <path d="m7 6 1.2 1.2L10.5 5M7 12l1.2 1.2 2.3-2.2M7 18l1.2 1.2 2.3-2.2" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
        </svg>
      );
    case "tasks":
      return (
        <svg aria-hidden="true" className={iconClass} fill="none" viewBox="0 0 24 24">
          <path d="M7 6h12M7 12h12M7 18h12" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
          <path d="m3.5 6 1 1 1.8-2M3.5 12l1 1 1.8-2M3.5 18l1 1 1.8-2" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
        </svg>
      );
    case "sequences":
      return (
        <svg aria-hidden="true" className={iconClass} fill="none" viewBox="0 0 24 24">
          <path d="M5 6h5M14 6h5M5 12h8M17 12h2M5 18h3M12 18h7" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
          <path d="M10 6h4M13 12h4M8 18h4" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
        </svg>
      );
    case "analysis":
    case "analytics":
      return (
        <svg aria-hidden="true" className={iconClass} fill="none" viewBox="0 0 24 24">
          <path d="M5 5.5h14v13H5z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" />
          <path d="M8 14.5v-3M12 14.5v-6M16 14.5v-4" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
          <path d="M8 17h8" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
        </svg>
      );
    case "projects":
      return (
        <svg aria-hidden="true" className={iconClass} fill="none" viewBox="0 0 24 24">
          <path d="M4.5 19.5v-12h6l1.7 2H19.5v10z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" />
          <path d="M8 13h8M8 16h5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
        </svg>
      );
    case "objectsMandates":
      return (
        <svg aria-hidden="true" className={iconClass} fill="none" viewBox="0 0 24 24">
          <path d="m4.5 11 7.5-6 7.5 6v8.5h-15z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" />
          <path d="M9 19.5v-5h6v5M8.5 11.5h7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
        </svg>
      );
    case "settings":
      return (
        <svg aria-hidden="true" className={iconClass} fill="none" viewBox="0 0 24 24">
          <path d="M12 8.3a3.7 3.7 0 1 1 0 7.4 3.7 3.7 0 0 1 0-7.4Z" stroke="currentColor" strokeWidth="1.8" />
          <path d="m5.8 9.4 1-1.8 2 .3 1-1.6h4.4l1 1.6 2-.3 1 1.8-1.2 1.6.2 1-.2 1 1.2 1.6-1 1.8-2-.3-1 1.6H9.8l-1-1.6-2 .3-1-1.8L7 13l-.2-1 .2-1z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.5" />
        </svg>
      );
    case "funnels":
      return (
        <svg aria-hidden="true" className={iconClass} fill="none" viewBox="0 0 24 24">
          <path d="M4 5h16l-6.2 7v5.5L10.2 19v-7z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" />
        </svg>
      );
    case "bots":
      return (
        <svg aria-hidden="true" className={iconClass} fill="none" viewBox="0 0 24 24">
          <path d="M7 8h10a3 3 0 0 1 3 3v3a3 3 0 0 1-3 3H9l-4 3v-3H7a3 3 0 0 1-3-3v-3a3 3 0 0 1 3-3Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" />
          <path d="M9 12h.01M15 12h.01" stroke="currentColor" strokeLinecap="round" strokeWidth="2.4" />
        </svg>
      );
    case "knowledge":
      return (
        <svg aria-hidden="true" className={iconClass} fill="none" viewBox="0 0 24 24">
          <path d="M5 5.5h6a3 3 0 0 1 3 3V20a3 3 0 0 0-3-3H5zM14 8.5a3 3 0 0 1 3-3h2v11.5h-2a3 3 0 0 0-3 3z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" />
        </svg>
      );
    case "newsletter":
      return (
        <svg aria-hidden="true" className={iconClass} fill="none" viewBox="0 0 24 24">
          <path d="M4 6h16v12H4z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" />
          <path d="m5 7 7 6 7-6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
        </svg>
      );
    case "forms":
      return (
        <svg aria-hidden="true" className={iconClass} fill="none" viewBox="0 0 24 24">
          <path d="M6 4.5h12v15H6z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" />
          <path d="M9 8h6M9 12h6M9 16h3" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
        </svg>
      );
    case "calendar":
      return (
        <svg aria-hidden="true" className={iconClass} fill="none" viewBox="0 0 24 24">
          <path d="M5 6h14v13H5zM5 10h14M8 4v4M16 4v4" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
        </svg>
      );
  }
}

function NovalureGlyph() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24">
      <path d="M12 3 20 8v8l-8 5-8-5V8z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="m8.5 13 2.3 2.4 4.9-6.3" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </svg>
  );
}

type CrmWorkspaceProps = {
  coreData: CoreCrmDataResult;
  sessionProductRole: ProductRole;
  sessionRole: WorkspaceRole;
  sessionWorkspace: {
    activeCalendarProvider?: CalendarProviderChoice;
    customerType?: WorkspaceCustomerType;
    id: string;
    name: string;
    operatingModel?: WorkspaceOperatingModel;
    setupState?: Record<string, unknown>;
    teamStructure?: WorkspaceTeamStructure;
  };
};

function readStoredLanguage(storageKey: string, fallback = defaultLanguage) {
  if (typeof window === "undefined") {
    return fallback;
  }

  return resolveLanguage(window.localStorage.getItem(storageKey), fallback);
}

function readUrlLanguage(): LanguageCode | null {
  if (typeof window === "undefined") {
    return null;
  }

  const queryLanguage = new URLSearchParams(window.location.search).get("lang");
  if (!queryLanguage) return null;

  return resolveLanguage(queryLanguage, defaultLanguage);
}

function getBrowserLanguageFallback(): LanguageCode {
  if (typeof window === "undefined") {
    return defaultLanguage;
  }

  return window.navigator.language.toLowerCase().startsWith("de") ? "de" : defaultLanguage;
}

function isNavigationPresetId(value: unknown): value is NavigationPresetId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(navigationPresets, value);
}

function readStoredPresetId(fallback: NavigationPresetId, allowedPresetIds: NavigationPresetId[]): NavigationPresetId {
  if (typeof window === "undefined") {
    return fallback;
  }

  const storedPresetId = window.localStorage.getItem(navigationPresetStorageKey);
  return isNavigationPresetId(storedPresetId) && allowedPresetIds.includes(storedPresetId)
    ? storedPresetId
    : fallback;
}

function readInitialSection(fallbackSection: DashboardSection = "dashboard"): DashboardSection {
  if (typeof window === "undefined") {
    return fallbackSection;
  }

  const hash = window.location.hash.replace("#", "").toLowerCase();
  const sections: Record<string, DashboardSection> = {
    analysis: "analysis",
    analyse: "analysis",
    "analyse-bot": "analysis",
    analytics: "analytics",
    bots: "bots",
    "buyer-leads": "leadInbox",
    "buyer-profiles": "objectsMandates",
    calendar: "calendar",
    contacts: "contacts",
    customer: "customerAccess",
    "customer-access": "customerAccess",
    "customeraccess": "customerAccess",
    datahygiene: "dataHygiene",
    "data-hygiene": "dataHygiene",
    dashboard: "dashboard",
    datenhygiene: "dataHygiene",
    "daten-hygiene": "dataHygiene",
    "daily-queue": "tasks",
    einstellungen: "settings",
    funnels: "funnels",
    form: "forms",
    forms: "forms",
    formulare: "forms",
    formular: "forms",
    kalender: "calendar",
    knowledge: "knowledge",
    customers: "managedService",
    hygiene: "dataHygiene",
    kunden: "managedService",
    leadinbox: "leadInbox",
    "lead-inbox": "leadInbox",
    jarvis: "analysis",
    meeting: "calendar",
    meetings: "calendar",
    newsletter: "newsletter",
    mandates: "objectsMandates",
    mandate: "objectsMandates",
    objects: "objectsMandates",
    "objects-mandates": "objectsMandates",
    onboarding: "onboarding",
    "managed-service": "managedService",
    managedservice: "managedService",
    "customer-success": "customerSuccess",
    customersuccess: "customerSuccess",
    overview: "dashboard",
    pipelines: "pipelines",
    projects: "projects",
    projekte: "projects",
    "seller-leads": "leadInbox",
    einheiten: "units",
    settings: "settings",
    inventory: "units",
    sequence: "sequences",
    sequences: "sequences",
    sequenzen: "sequences",
    tasks: "tasks",
    units: "units",
    workspaces: "managedService",
  };

  return sections[hash] ?? fallbackSection;
}

function parseCrmMoney(value: string) {
  const lower = value.toLowerCase();
  const multiplier = lower.includes("mio") ? 1_000_000 : 1;
  const normalized = value
    .toLowerCase()
    .replace(/mio\.?/g, "")
    .replace(/eur/g, "")
    .replace(/€/g, "")
    .replace(/\s/g, "")
    .replace(/\./g, "")
    .replace(",", ".");
  const parsed = Number(normalized.replace(/[^\d.]/g, ""));

  return Number.isFinite(parsed) ? parsed * multiplier : 0;
}

function formatCompactEuro(value: number) {
  return new Intl.NumberFormat("de-AT", {
    currency: "EUR",
    maximumFractionDigits: 0,
    notation: value >= 1_000_000 ? "compact" : "standard",
    style: "currency",
  }).format(value);
}

function getSectionHash(section: DashboardSection) {
  if (section === "customerAccess") return "customer-access";
  if (section === "managedService") return "managed-service";
  if (section === "customerSuccess") return "customer-success";
  if (section === "dataHygiene") return "data-hygiene";
  if (section === "objectsMandates") return "objects-mandates";
  return section === "calendar" ? "meetings" : section;
}

function getNavigationHash(section: DashboardSection, entryId?: NavigationEntryId) {
  const entryHashes: Partial<Record<NavigationEntryId, string>> = {
    buyerLeads: "buyer-leads",
    buyerProfiles: "buyer-profiles",
    dailyQueue: "daily-queue",
    developerLeads: "leads",
    objectsMandates: "objects-mandates",
    projectAnalytics: "analytics",
    projectOverview: "projects",
    projects: "projects",
    sellerLeads: "seller-leads",
    settings: "settings",
    workspaces: "workspaces",
  };

  return entryId && entryHashes[entryId] ? entryHashes[entryId] : getSectionHash(section);
}

type WorkspaceSetupState = Pick<
  WorkspaceProductContext,
  "activeCalendarProvider" | "customerType" | "operatingModel" | "teamStructure"
>;
type WorkspaceSetupSaveState = "idle" | "saving" | "saved" | "error";

type ProjectCommandCenterCopy = {
  title: string;
  description: string;
  leads: string;
  deals: string;
  tasks: string;
  pipeline: string;
  noPipeline: string;
};

type ObjectCommandCenterCopy = {
  title: string;
  description: string;
  sellerListings: string;
  brokerMandates: string;
  buyerProfiles: string;
  active: string;
  units: string;
  available: string;
  reserved: string;
  sold: string;
  focusTitle: string;
  empty: string;
};

type AnalyticsCommandCenterCopy = {
  title: string;
  description: string;
  leads: string;
  conversion: string;
  pipelineValue: string;
  weightedValue: string;
  meetings: string;
  tasks: string;
  overdueTasks: string;
  speedToLead: string;
  sources: string;
  empty: string;
};

type CommunicationCommandCenterCopy = {
  title: string;
  description: string;
  conversations: string;
  channel: string;
  contact: string;
  project: string;
  lastMessage: string;
  nextAction: string;
  owner: string;
  mode: string;
  consent: string;
  botMode: string;
  manualMode: string;
  contactUnknown: string;
  noNextAction: string;
  noOwner: string;
  noConsent: string;
  empty: string;
  emptyCta: string;
};

type SettingsCommandCenterCopy = {
  title: string;
  description: string;
  workspaceSetup: string;
  calendarProvider: string;
  roleProfile: string;
  databaseStatus: string;
  integrations: string;
  operatingModel: string;
  notConnected: string;
  moduleSources: string;
  missingTables: string;
  adminAreasTitle?: string;
  adminAreasDescription?: string;
  adminAreas?: string[];
  rolesTitle?: string;
  rolesDescription?: string;
  roleMatrix?: Array<{
    role: string;
    access: string;
    canCreate: string;
    canEdit: string;
    protectedAction: string;
  }>;
  fieldStructureTitle: string;
  fieldStructureDescription: string;
  fieldGroupsTitle: string;
  contactFieldsTitle: string;
  companyFieldsTitle: string;
  roleRecommendationsTitle: string;
  customFieldsTitle: string;
  fieldDraftLabel: string;
  fieldDraftPlaceholder: string;
  addField: string;
  emptyCustomFields: string;
  recommended: string;
  optional: string;
  qualityChecked: string;
  fieldGroups: string[];
  contactFieldDefaults: string[];
  companyFieldDefaults: string[];
  roleFieldRecommendations: Array<{ role: string; fields: string[] }>;
  technicalDetails?: string;
  access?: string;
  create?: string;
  edit?: string;
  protectedActions?: string;
};

type CommandCentersCopy = {
  projects: ProjectCommandCenterCopy;
  mandates: ObjectCommandCenterCopy;
  inventory: ObjectCommandCenterCopy;
  analytics: AnalyticsCommandCenterCopy;
  communication: CommunicationCommandCenterCopy;
  settings: SettingsCommandCenterCopy;
};

const fallbackCommandCentersCopy: CommandCentersCopy = {
  projects: {
    title: "Project overview",
    description: "Projects show leads, deals, open tasks and the assigned default pipeline.",
    leads: "Leads",
    deals: "Deals",
    tasks: "Open tasks",
    pipeline: "Pipeline",
    noPipeline: "Setup pending",
  },
  mandates: {
    title: "Objects / mandates",
    description: "Broker objects, seller mandates and buyer search profiles are managed separately from contacts.",
    sellerListings: "Seller listings",
    brokerMandates: "Mandates",
    buyerProfiles: "Buyer profiles",
    active: "Active",
    units: "Units",
    available: "Available",
    reserved: "Reserved",
    sold: "Sold",
    focusTitle: "Current object work",
    empty: "No objects or mandates in this filter.",
  },
  inventory: {
    title: "Units / inventory",
    description: "Developer inventory, reservations and sold units are separated from broker mandates.",
    sellerListings: "Seller listings",
    brokerMandates: "Mandates",
    buyerProfiles: "Buyer profiles",
    active: "Active",
    units: "Units",
    available: "Available",
    reserved: "Reserved",
    sold: "Sold",
    focusTitle: "Current inventory",
    empty: "No units in this filter.",
  },
  analytics: {
    title: "Analytics",
    description: "Management view for lead sources, conversion, pipeline value, appointments, tasks and speed-to-lead.",
    leads: "Leads",
    conversion: "Conversion",
    pipelineValue: "Pipeline value",
    weightedValue: "Weighted value",
    meetings: "Meetings",
    tasks: "Tasks",
    overdueTasks: "Overdue tasks",
    speedToLead: "Within SLA",
    sources: "Lead sources",
    empty: "No lead source data in this filter.",
  },
  communication: {
    title: "Communication",
    description: "All conversations by channel, contact, project, next action, owner and consent status.",
    conversations: "Conversations",
    channel: "Channel",
    contact: "Contact",
    project: "Project",
    lastMessage: "Last message",
    nextAction: "Next action",
    owner: "Owner",
    mode: "Mode",
    consent: "Consent",
    botMode: "Bot / prepared",
    manualMode: "Manual",
    contactUnknown: "Contact not known yet",
    noNextAction: "No next action set",
    noOwner: "No owner assigned",
    noConsent: "Consent not documented",
    empty:
      "There are no conversations in the current project filter yet. Once leads arrive by form, WhatsApp, email or bot, they appear here with the next action.",
    emptyCta: "Open Lead Inbox",
  },
  settings: {
    title: "Settings",
    description: "Workspace, projects, roles, rights and integrations in one admin view.",
    workspaceSetup: "Workspace setup",
    calendarProvider: "Calendar provider",
    roleProfile: "Role / profile",
    databaseStatus: "Database status",
    integrations: "Integrations",
    operatingModel: "Operating model",
    notConnected: "Not connected",
    moduleSources: "Module sources",
    missingTables: "Missing tables",
    adminAreasTitle: "Admin structure",
    adminAreasDescription: "Manage the areas that define daily CRM work.",
    adminAreas: ["Workspace", "Projects", "Users", "Roles & rights", "Calendar", "Teams", "Newsletter", "Bot channels", "Data hygiene", "Language", "Integrations", "Security"],
    rolesTitle: "Roles and permissions",
    rolesDescription: "Show what each role can see and which actions need admin control.",
    roleMatrix: [
      { role: "Admin", access: "All areas", canCreate: "yes", canEdit: "yes", protectedAction: "roles, integrations, bot activation" },
      { role: "Management", access: "Forecast, analytics, risks", canCreate: "limited", canEdit: "limited", protectedAction: "exports and settings" },
      { role: "Sales lead", access: "Pipeline, owners, tasks", canCreate: "yes", canEdit: "yes", protectedAction: "delete and send" },
      { role: "Broker / sales", access: "Leads, contacts, tasks, deals", canCreate: "yes", canEdit: "own records", protectedAction: "newsletter and bot activation" },
      { role: "Project manager", access: "Projects, objects, meetings", canCreate: "yes", canEdit: "project records", protectedAction: "workspace settings" },
      { role: "Marketing", access: "Funnels, newsletter, consent", canCreate: "yes", canEdit: "campaigns", protectedAction: "send only with opt-in" },
      { role: "Backoffice", access: "Contacts, consents, tasks", canCreate: "yes", canEdit: "data quality", protectedAction: "delete and integrations" },
      { role: "Read only", access: "Dashboards and reports", canCreate: "no", canEdit: "no", protectedAction: "none" },
    ],
    fieldStructureTitle: "Fields & contact structure",
    fieldStructureDescription:
      "Define which contact and company fields are available, recommended, quality-checked or shown first by role. Fields stay optional unless an admin explicitly marks them required.",
    fieldGroupsTitle: "Field groups",
    contactFieldsTitle: "Recommended contact fields",
    companyFieldsTitle: "Recommended company fields",
    roleRecommendationsTitle: "Role-first fields",
    customFieldsTitle: "Workspace custom fields",
    fieldDraftLabel: "New optional field",
    fieldDraftPlaceholder: "e.g. Preferred viewing day",
    addField: "Add field",
    emptyCustomFields:
      "Novalure CRM uses recommended standard fields for real estate contacts. You can add workspace-specific contact and company fields here.",
    recommended: "Recommended",
    optional: "Optional",
    qualityChecked: "Data quality",
    fieldGroups: [
      "Overview",
      "Person",
      "Contact routes",
      "Address",
      "Company",
      "Real estate profile",
      "CRM control",
      "Consent",
      "Relationships",
      "Timeline",
      "Admin / technical details",
    ],
    contactFieldDefaults: [
      "Salutation",
      "First name",
      "Last name",
      "Full name",
      "Email",
      "Phone",
      "Mobile / WhatsApp",
      "Preferred contact route",
      "Best contact time",
      "Language",
      "Address",
      "Company",
      "LinkedIn",
      "Note",
    ],
    companyFieldDefaults: [
      "Company name",
      "Website",
      "Domain",
      "Phone",
      "General email",
      "Industry",
      "Company type",
      "Employees",
      "Address",
      "Main contact",
      "Real estate role",
      "Note",
    ],
    roleFieldRecommendations: [
      { role: "Broker / sales", fields: ["Phone", "WhatsApp", "Project", "Lead type", "Next action"] },
      { role: "Backoffice", fields: ["Email", "Phone", "Address", "Consent", "Company", "Duplicate check"] },
      { role: "Marketing", fields: ["Opt-ins", "Segments", "Source", "Campaign", "Newsletter status"] },
      { role: "Management", fields: ["Project", "Deal value", "Status", "Owner", "Last contact"] },
    ],
    technicalDetails: "Technical details",
    access: "Access",
    create: "Create",
    edit: "Edit",
    protectedActions: "Protected actions",
  },
};

function getCommandCentersCopy(copy: ReturnType<typeof getDashboardCopy>): CommandCentersCopy {
  const localized = (copy as ReturnType<typeof getDashboardCopy> & { commandCenters?: Partial<CommandCentersCopy> }).commandCenters;

  return {
    ...fallbackCommandCentersCopy,
    ...localized,
    settings: {
      ...fallbackCommandCentersCopy.settings,
      ...(localized?.settings ?? {}),
    },
  };
}

function ProjectsCommandCenter({
  context,
  copy,
  deals,
  leads,
  projects,
  tasks,
}: {
  context: WorkspaceProductContext;
  copy: ReturnType<typeof getDashboardCopy>;
  deals: Deal[];
  leads: Lead[];
  projects: Project[];
  tasks: Task[];
}) {
  const panelCopy = getCommandCentersCopy(copy).projects;

  return (
    <section className="grid gap-4">
      <article className="rounded-lg border border-stone-200 bg-white p-5">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">{context.workspaceName}</p>
        <h3 className="mt-1 break-words text-2xl font-semibold text-slate-950">{panelCopy.title}</h3>
        <p className="mt-2 max-w-3xl break-words text-sm leading-6 text-stone-600">{panelCopy.description}</p>
      </article>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {projects.map((project) => {
          const projectDeals = deals.filter((deal) => deal.projectId === project.id);
          const projectTasks = tasks.filter((task) => task.projectId === project.id && task.status === "open");
          const projectLeads = leads.filter((lead) => lead.projectId === project.id);

          return (
            <article className="rounded-lg border border-stone-200 bg-white p-4" key={project.id}>
              <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0">
                  <h4 className="break-words text-lg font-semibold text-slate-950">{project.name}</h4>
                  <p className="mt-1 break-words text-sm text-stone-500">{project.type}</p>
                </div>
                <span className={`shrink-0 rounded-md px-2 py-1 text-xs font-semibold ${statusStyles[project.status] ?? statusStyles.Review}`}>
                  {project.status}
                </span>
              </div>
              <div className="mt-4 grid grid-cols-3 gap-2 text-sm">
                {[
                  [panelCopy.leads, projectLeads.length],
                  [panelCopy.deals, projectDeals.length],
                  [panelCopy.tasks, projectTasks.length],
                ].map(([label, value]) => (
                  <div className="rounded-md bg-stone-50 p-3" key={label}>
                    <p className="font-semibold text-slate-950">{value}</p>
                    <p className="mt-1 break-words text-xs text-stone-500">{label}</p>
                  </div>
                ))}
              </div>
              <p className="mt-4 break-words text-xs font-semibold text-stone-500">
                {panelCopy.pipeline}: {project.defaultPipelineId || panelCopy.noPipeline}
              </p>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function ObjectMandateCommandCenter({
  brokerMandates,
  buyerSearchProfiles,
  context,
  copy,
  propertyReservations,
  propertyUnits,
  sellerListings,
}: {
  brokerMandates: BrokerMandate[];
  buyerSearchProfiles: BuyerSearchProfile[];
  context: WorkspaceProductContext;
  copy: ReturnType<typeof getDashboardCopy>;
  propertyReservations: PropertyReservation[];
  propertyUnits: PropertyUnit[];
  sellerListings: SellerListing[];
}) {
  const commandCentersCopy = getCommandCentersCopy(copy);
  const panelCopy = context.customerType === "property_developer"
    ? commandCentersCopy.inventory
    : commandCentersCopy.mandates;
  const inventoryStats = [
    [panelCopy.units, propertyUnits.length],
    [panelCopy.available, propertyUnits.filter((unit) => unit.status === "available").length],
    [panelCopy.reserved, propertyReservations.filter((reservation) => reservation.status === "hold" || reservation.status === "reserved").length],
    [panelCopy.sold, propertyUnits.filter((unit) => unit.status === "sold").length],
  ];
  const mandateStats = [
    [panelCopy.sellerListings, sellerListings.length],
    [panelCopy.brokerMandates, brokerMandates.length],
    [panelCopy.buyerProfiles, buyerSearchProfiles.length],
    [panelCopy.active, brokerMandates.filter((mandate) => ["active", "aktiv"].includes(mandate.mandateStatus.toLowerCase())).length],
  ];
  const stats = context.customerType === "property_developer" ? inventoryStats : mandateStats;
  const focusItems = context.customerType === "property_developer" ? propertyUnits.slice(0, 6) : sellerListings.slice(0, 6);

  return (
    <section className="grid gap-4">
      <article className="rounded-lg border border-stone-200 bg-white p-5">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">{context.workspaceName}</p>
        <h3 className="mt-1 break-words text-2xl font-semibold text-slate-950">{panelCopy.title}</h3>
        <p className="mt-2 max-w-3xl break-words text-sm leading-6 text-stone-600">{panelCopy.description}</p>
      </article>
      <div className="grid gap-3 md:grid-cols-4">
        {stats.map(([label, value]) => (
          <div className="rounded-lg border border-stone-200 bg-white p-4" key={label}>
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{label}</p>
            <p className="mt-2 text-2xl font-semibold text-slate-950">{value}</p>
          </div>
        ))}
      </div>
      <article className="rounded-lg border border-stone-200 bg-white p-5">
        <h4 className="text-lg font-semibold text-slate-950">{panelCopy.focusTitle}</h4>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {focusItems.length ? focusItems.map((item) => (
            <div className="rounded-md border border-stone-200 bg-stone-50 p-3" key={item.id}>
              <p className="break-words text-sm font-semibold text-slate-950">
                {"unitNumber" in item ? item.unitNumber : item.title}
              </p>
              <p className="mt-1 break-words text-xs text-stone-600">
                {"status" in item ? item.status : item.region}
              </p>
            </div>
          )) : (
            <p className="rounded-md border border-dashed border-stone-300 bg-stone-50 p-3 text-sm text-stone-500">
              {panelCopy.empty}
            </p>
          )}
        </div>
      </article>
    </section>
  );
}

function AnalyticsCommandCenter({
  calendarEvents,
  copy,
  deals,
  leads,
  projectLabel,
  tasks,
}: {
  calendarEvents: CalendarEvent[];
  copy: ReturnType<typeof getDashboardCopy>;
  deals: Deal[];
  leads: Lead[];
  projectLabel: string;
  tasks: Task[];
}) {
  const panelCopy = getCommandCentersCopy(copy).analytics;
  const openDeals = deals.filter((deal) => !["Gewonnen", "Verloren", "Disqualifiziert", "Pausiert / Verloren"].includes(deal.stage));
  const wonDeals = deals.filter((deal) => deal.stage === "Gewonnen" || deal.stage === "Aktiv");
  const pipelineValue = openDeals.reduce((sum, deal) => sum + parseCrmMoney(deal.value), 0);
  const weightedValue = openDeals.reduce((sum, deal) => sum + parseCrmMoney(deal.value) * (deal.probability / 100), 0);
  const conversion = leads.length ? Math.round((wonDeals.length / leads.length) * 100) : 0;
  const today = new Date().toISOString().slice(0, 10);
  const overdueTasks = tasks.filter((task) => task.status === "open" && task.due && task.due < today).length;
  const bySource = Array.from(
    leads.reduce<Map<string, number>>((summary, lead) => {
      summary.set(lead.source, (summary.get(lead.source) ?? 0) + 1);
      return summary;
    }, new Map()),
  ).sort((a, b) => b[1] - a[1]);

  return (
    <section className="grid gap-4">
      <article className="rounded-lg border border-stone-200 bg-white p-5">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">{projectLabel}</p>
        <h3 className="mt-1 break-words text-2xl font-semibold text-slate-950">{panelCopy.title}</h3>
        <p className="mt-2 max-w-3xl break-words text-sm leading-6 text-stone-600">{panelCopy.description}</p>
      </article>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {[
          [panelCopy.leads, leads.length],
          [panelCopy.conversion, `${conversion}%`],
          [panelCopy.pipelineValue, formatCompactEuro(pipelineValue)],
          [panelCopy.weightedValue, formatCompactEuro(weightedValue)],
          [panelCopy.meetings, calendarEvents.length],
          [panelCopy.tasks, tasks.length],
          [panelCopy.overdueTasks, overdueTasks],
          [panelCopy.speedToLead, leads.filter((lead) => lead.slaDueAt && lead.slaDueAt >= today).length],
        ].map(([label, value]) => (
          <div className="rounded-lg border border-stone-200 bg-white p-4" key={label}>
            <p className="break-words text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{label}</p>
            <p className="mt-2 break-words text-2xl font-semibold text-slate-950">{value}</p>
          </div>
        ))}
      </div>
      <article className="rounded-lg border border-stone-200 bg-white p-5">
        <h4 className="text-lg font-semibold text-slate-950">{panelCopy.sources}</h4>
        <div className="mt-4 grid gap-2">
          {bySource.length ? bySource.map(([source, count]) => (
            <div className="flex min-w-0 items-center justify-between gap-3 rounded-md bg-stone-50 p-3" key={source}>
              <span className="break-words text-sm font-semibold text-slate-900">{source}</span>
              <span className="shrink-0 rounded-md bg-white px-2 py-1 text-xs font-semibold text-stone-700">{count}</span>
            </div>
          )) : (
            <p className="rounded-md border border-dashed border-stone-300 bg-stone-50 p-3 text-sm text-stone-500">
              {panelCopy.empty}
            </p>
          )}
        </div>
      </article>
    </section>
  );
}

function CommunicationCommandCenter({
  consents,
  contacts,
  conversations,
  copy,
  language,
  leads,
  onOpenLeadInbox,
  projectLabel,
  projects,
  users,
}: {
  consents: ConsentRecord[];
  contacts: Contact[];
  conversations: Conversation[];
  copy: ReturnType<typeof getDashboardCopy>;
  language: LanguageCode;
  leads: Lead[];
  onOpenLeadInbox: () => void;
  projectLabel: string;
  projects: Project[];
  users: WorkspaceUser[];
}) {
  const panelCopy = getCommandCentersCopy(copy).communication;
  const locale = language === "de" ? "de-AT" : "en-GB";
  const sortedConversations = [...conversations].sort(
    (a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime(),
  );

  return (
    <section className="grid min-w-0 max-w-full gap-4 overflow-hidden">
      <article className="min-w-0 max-w-full rounded-lg border border-stone-200 bg-white p-5">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">{projectLabel}</p>
        <h3 className="mt-1 break-words text-2xl font-semibold text-slate-950">{panelCopy.title}</h3>
        <p className="mt-2 max-w-3xl break-words text-sm leading-6 text-stone-600">{panelCopy.description}</p>
      </article>

      <div className="grid gap-3 md:grid-cols-3">
        {[
          [panelCopy.conversations, sortedConversations.length],
          [panelCopy.noOwner, leads.filter((lead) => !lead.assignedToUserId).length],
          [panelCopy.noConsent, contacts.filter((contact) => !consents.some((consent) => consent.contactId === contact.id)).length],
        ].map(([label, value]) => (
          <div className="rounded-lg border border-stone-200 bg-white p-4" key={label}>
            <p className="break-words text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{label}</p>
            <p className="mt-2 text-2xl font-semibold text-slate-950">{value}</p>
          </div>
        ))}
      </div>

      <article className="min-w-0 max-w-full rounded-lg border border-stone-200 bg-white p-5">
        {sortedConversations.length ? (
          <div className="overflow-x-auto">
            <table className="min-w-[860px] w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-[0.12em] text-stone-500">
                <tr>
                  <th className="py-2 pr-4 font-semibold">{panelCopy.channel}</th>
                  <th className="py-2 pr-4 font-semibold">{panelCopy.contact}</th>
                  <th className="py-2 pr-4 font-semibold">{panelCopy.project}</th>
                  <th className="py-2 pr-4 font-semibold">{panelCopy.lastMessage}</th>
                  <th className="py-2 pr-4 font-semibold">{panelCopy.nextAction}</th>
                  <th className="py-2 pr-4 font-semibold">{panelCopy.owner}</th>
                  <th className="py-2 pr-4 font-semibold">{panelCopy.mode}</th>
                  <th className="py-2 font-semibold">{panelCopy.consent}</th>
                </tr>
              </thead>
              <tbody>
                {sortedConversations.map((conversation) => {
                  const contact = contacts.find((item) => item.id === conversation.contactId);
                  const lead = leads.find((item) => item.id === conversation.leadId || item.contactId === conversation.contactId);
                  const project = projects.find((item) => item.id === conversation.projectId);
                  const owner = lead?.assignedToUserId ? users.find((user) => user.id === lead.assignedToUserId) : undefined;
                  const consent = consents.find((item) => item.contactId === conversation.contactId);
                  const isBotMode = conversation.summary.toLowerCase().includes("bot") || conversation.channel === "WhatsApp";

                  return (
                    <tr className="border-t border-stone-200 align-top" key={conversation.id}>
                      <td className="py-3 pr-4 font-semibold text-slate-950">{conversation.channel}</td>
                      <td className="py-3 pr-4 text-stone-700">{contact?.name ?? panelCopy.contactUnknown}</td>
                      <td className="py-3 pr-4 text-stone-700">{project?.name ?? projectLabel}</td>
                      <td className="py-3 pr-4 text-stone-700">
                        <span className="block font-semibold text-slate-900">{conversation.summary}</span>
                        <span className="mt-1 block text-xs text-stone-500">
                          {new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(conversation.lastMessageAt))}
                        </span>
                      </td>
                      <td className="py-3 pr-4 text-stone-700">{lead?.nextAction || panelCopy.noNextAction}</td>
                      <td className="py-3 pr-4 text-stone-700">{owner?.name ?? panelCopy.noOwner}</td>
                      <td className="py-3 pr-4">
                        <span className="rounded-md bg-stone-100 px-2 py-1 text-xs font-semibold text-stone-700">
                          {isBotMode ? panelCopy.botMode : panelCopy.manualMode}
                        </span>
                      </td>
                      <td className="py-3">
                        <span className={`rounded-md px-2 py-1 text-xs font-semibold ${consent ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`}>
                          {consent ? `${consent.channel}: ${consent.status}` : panelCopy.noConsent}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-stone-300 bg-stone-50 p-5 text-sm text-stone-600">
            <p className="max-w-3xl break-words">{panelCopy.empty}</p>
            <button
              className="mt-4 rounded-md bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800"
              onClick={onOpenLeadInbox}
              type="button"
            >
              {panelCopy.emptyCta}
            </button>
          </div>
        )}
      </article>
    </section>
  );
}

function SettingsCommandCenter({
  context,
  copy,
  dataSource,
  missingTables,
  moduleSources,
  profileLabel,
}: {
  context: WorkspaceProductContext;
  copy: ReturnType<typeof getDashboardCopy>;
  dataSource: string;
  missingTables: string[];
  moduleSources: CoreCrmDataResult["moduleSources"];
  profileLabel: string;
}) {
  const panelCopy = getCommandCentersCopy(copy).settings;
  const [fieldDraft, setFieldDraft] = useState("");
  const [customFields, setCustomFields] = useState<string[]>([]);
  const modules = Object.entries(moduleSources).slice(0, 8);
  const roleMatrix = panelCopy.roleMatrix ?? fallbackCommandCentersCopy.settings.roleMatrix ?? [];
  const adminAreas = panelCopy.adminAreas ?? fallbackCommandCentersCopy.settings.adminAreas ?? [];
  const defaultFieldSections = [
    { fields: panelCopy.contactFieldDefaults, title: panelCopy.contactFieldsTitle },
    { fields: panelCopy.companyFieldDefaults, title: panelCopy.companyFieldsTitle },
  ];
  const addCustomField = () => {
    const nextField = fieldDraft.trim();
    if (!nextField) return;
    setCustomFields((current) => current.includes(nextField) ? current : [...current, nextField]);
    setFieldDraft("");
  };

  return (
    <section className="grid min-w-0 max-w-full gap-4 overflow-hidden">
      <article className="min-w-0 max-w-full rounded-lg border border-stone-200 bg-white p-5">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">{context.workspaceName}</p>
        <h3 className="mt-1 break-words text-2xl font-semibold text-slate-950">{panelCopy.title}</h3>
        <p className="mt-2 max-w-3xl break-words text-sm leading-6 text-stone-600">{panelCopy.description}</p>
      </article>
      <article className="min-w-0 max-w-full rounded-lg border border-stone-200 bg-white p-5">
        <h4 className="text-lg font-semibold text-slate-950">{panelCopy.adminAreasTitle}</h4>
        <p className="mt-1 max-w-3xl break-words text-sm text-stone-600">{panelCopy.adminAreasDescription}</p>
        <div className="mt-4 grid min-w-0 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {adminAreas.map((area) => (
            <div className="min-w-0 rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-sm font-semibold text-slate-900" key={area}>
              {area}
            </div>
          ))}
        </div>
      </article>
      <article className="min-w-0 max-w-full rounded-lg border border-stone-200 bg-white p-5">
        <h4 className="text-lg font-semibold text-slate-950">{panelCopy.rolesTitle}</h4>
        <p className="mt-1 max-w-3xl break-words text-sm text-stone-600">{panelCopy.rolesDescription}</p>
        <div className="mt-4 max-w-full overflow-x-auto">
          <table className="min-w-[760px] text-left text-sm">
            <thead className="text-xs uppercase tracking-[0.12em] text-stone-500">
              <tr>
                <th className="py-2 pr-4 font-semibold">{panelCopy.roleProfile}</th>
                <th className="py-2 pr-4 font-semibold">{panelCopy.access}</th>
                <th className="py-2 pr-4 font-semibold">{panelCopy.create}</th>
                <th className="py-2 pr-4 font-semibold">{panelCopy.edit}</th>
                <th className="py-2 pr-4 font-semibold">{panelCopy.protectedActions}</th>
              </tr>
            </thead>
            <tbody>
              {roleMatrix.map((row) => (
                <tr className="border-t border-stone-200" key={row.role}>
                  <td className="py-3 pr-4 font-semibold text-slate-950">{row.role}</td>
                  <td className="py-3 pr-4 text-stone-700">{row.access}</td>
                  <td className="py-3 pr-4 text-stone-700">{row.canCreate}</td>
                  <td className="py-3 pr-4 text-stone-700">{row.canEdit}</td>
                  <td className="py-3 pr-4 text-stone-700">{row.protectedAction}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </article>
      <article className="min-w-0 max-w-full rounded-lg border border-stone-200 bg-white p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <h4 className="text-lg font-semibold text-slate-950">{panelCopy.fieldStructureTitle}</h4>
            <p className="mt-1 max-w-3xl break-words text-sm text-stone-600">{panelCopy.fieldStructureDescription}</p>
          </div>
          <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(220px,1fr)_auto]">
            <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
              {panelCopy.fieldDraftLabel}
              <input
                className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold normal-case tracking-normal text-slate-950 outline-none focus:border-slate-950"
                onChange={(event) => setFieldDraft(event.target.value)}
                placeholder={panelCopy.fieldDraftPlaceholder}
                value={fieldDraft}
              />
            </label>
            <button
              className="self-end rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
              onClick={addCustomField}
              type="button"
            >
              {panelCopy.addField}
            </button>
          </div>
        </div>

        <div className="mt-5 grid min-w-0 gap-4 xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
          <div className="min-w-0 max-w-full rounded-lg border border-stone-200 bg-stone-50 p-4">
            <h5 className="text-sm font-semibold text-slate-950">{panelCopy.fieldGroupsTitle}</h5>
            <div className="mt-3 flex flex-wrap gap-2">
              {panelCopy.fieldGroups.map((group) => (
                <span className="rounded-md bg-white px-2.5 py-1.5 text-xs font-semibold text-stone-700" key={group}>
                  {group}
                </span>
              ))}
            </div>
          </div>

          <div className="grid min-w-0 gap-4 lg:grid-cols-2">
            {defaultFieldSections.map(({ fields, title }) => (
              <div className="min-w-0 max-w-full rounded-lg border border-stone-200 bg-stone-50 p-4" key={title}>
                <h5 className="text-sm font-semibold text-slate-950">{title}</h5>
                <div className="mt-3 grid gap-2">
                  {fields.slice(0, 8).map((field) => (
                    <div className="flex items-center justify-between gap-2 rounded-md bg-white px-3 py-2 text-sm" key={field}>
                      <span className="break-words font-semibold text-slate-900">{field}</span>
                      <span className="shrink-0 rounded-md bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-800">
                        {panelCopy.recommended}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-4 grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)]">
          <div className="min-w-0 max-w-full rounded-lg border border-stone-200 bg-white p-4">
            <h5 className="text-sm font-semibold text-slate-950">{panelCopy.roleRecommendationsTitle}</h5>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              {panelCopy.roleFieldRecommendations.map((item) => (
                <div className="min-w-0 rounded-md border border-stone-200 bg-stone-50 p-3" key={item.role}>
                  <p className="text-sm font-semibold text-slate-950">{item.role}</p>
                  <p className="mt-2 break-words text-xs text-stone-600">{item.fields.join(" · ")}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="min-w-0 max-w-full rounded-lg border border-stone-200 bg-white p-4">
            <h5 className="text-sm font-semibold text-slate-950">{panelCopy.customFieldsTitle}</h5>
            <div className="mt-3 flex flex-wrap gap-2">
              {customFields.length ? customFields.map((field) => (
                <span className="rounded-md border border-blue-100 bg-blue-50 px-2.5 py-1.5 text-xs font-semibold text-blue-900" key={field}>
                  {field} · {panelCopy.optional}
                </span>
              )) : (
                <p className="break-words rounded-md border border-dashed border-stone-300 bg-stone-50 p-3 text-sm text-stone-600">
                  {panelCopy.emptyCustomFields}
                </p>
              )}
            </div>
            <p className="mt-3 text-xs font-semibold text-emerald-800">
              {panelCopy.qualityChecked}: {panelCopy.contactFieldDefaults.slice(0, 5).join(", ")}
            </p>
          </div>
        </div>
      </article>
      <div className="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-4">
        {[
          [panelCopy.workspaceSetup, copy.workspaceMode.customerTypeLabels[context.customerType]],
          [panelCopy.calendarProvider, copy.workspaceMode.calendarProviderLabels[context.activeCalendarProvider]],
          [panelCopy.roleProfile, profileLabel],
          [panelCopy.integrations, context.connectedCalendarProviders.length ? context.connectedCalendarProviders.join(", ") : panelCopy.notConnected],
          [panelCopy.operatingModel, copy.workspaceMode.operatingModelLabels[context.operatingModel]],
        ].map(([label, value]) => (
          <div className="min-w-0 rounded-lg border border-stone-200 bg-white p-4" key={label}>
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{label}</p>
            <p className="mt-2 break-words text-sm font-semibold text-slate-950">{value}</p>
          </div>
        ))}
      </div>
      <details className="min-w-0 max-w-full rounded-lg border border-stone-200 bg-white p-5">
        <summary className="cursor-pointer text-lg font-semibold text-slate-950">{panelCopy.technicalDetails}</summary>
        <div className="mt-4 grid min-w-0 gap-3 md:grid-cols-2">
          <div className="min-w-0 rounded-md border border-stone-200 bg-stone-50 p-3">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{panelCopy.databaseStatus}</p>
            <p className="mt-1 break-words text-sm font-semibold text-slate-950">{dataSource}</p>
          </div>
          {modules.map(([moduleName, source]) => (
            <div className="flex min-w-0 items-center justify-between gap-3 rounded-md bg-stone-50 p-3" key={moduleName}>
              <span className="break-words text-sm font-semibold text-slate-900">{moduleName}</span>
              <span className="shrink-0 rounded-md bg-white px-2 py-1 text-xs font-semibold text-stone-700">{source}</span>
            </div>
          ))}
        </div>
        {missingTables.length ? (
          <p className="mt-4 break-words rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900">
            {panelCopy.missingTables}: {missingTables.join(", ")}
          </p>
        ) : null}
      </details>
    </section>
  );
}

function WorkspaceContextBar({
  areaLabel,
  copy,
  dataScopeLabel,
  profileLabel,
  projectLabel,
  workspaceName,
}: {
  areaLabel: string;
  copy: ReturnType<typeof getDashboardCopy>;
  dataScopeLabel: string;
  profileLabel: string;
  projectLabel: string;
  workspaceName: string;
}) {
  const contextCopy = (copy as typeof copy & {
    workspaceContextBar?: {
      area: string;
      dataScope: string;
      label: string;
      profile: string;
      project: string;
      workspace: string;
    };
  }).workspaceContextBar ?? {
    area: "Area",
    dataScope: "Data scope",
    label: "Work context",
    profile: "Role / profile",
    project: "Project filter",
    workspace: "Workspace",
  };

  const chips = [
    [contextCopy.workspace, workspaceName],
    [contextCopy.project, projectLabel],
    [contextCopy.profile, profileLabel],
    [contextCopy.area, areaLabel],
    [contextCopy.dataScope, dataScopeLabel],
  ];

  return (
    <section className="rounded-lg border border-stone-200 bg-white px-4 py-3 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">{contextCopy.label}</p>
      <h3 className="mt-1 break-words text-base font-semibold text-slate-950">
        {workspaceName} &gt; {projectLabel} &gt; {profileLabel} &gt; {areaLabel}
      </h3>
      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        {chips.map(([label, value]) => (
          <span className="rounded-md bg-stone-50 px-2.5 py-1.5 font-semibold text-stone-700" key={label}>
            {label}: <span className="text-slate-950">{value}</span>
          </span>
        ))}
      </div>
    </section>
  );
}

type RolePriorityPanelCopy = {
  description: string;
  metrics: Record<
    "hotLeads" | "openTasks" | "noOwner" | "appointments" | "pipeline" | "riskDeals" | "unlinkedTasks",
    string
  >;
  nextStepsLabel: string;
  profiles: Partial<Record<NavigationPresetId | "default", { description: string; nextSteps: string[]; title: string }>>;
  title: string;
};

function parseRolePanelDealValue(value: string) {
  const lowerValue = value.toLowerCase();
  const isMillion = lowerValue.includes("mio");
  const normalized = lowerValue
    .replace(/mio\.?/g, "")
    .replace(/eur/g, "")
    .replace(/\s/g, "")
    .replace(/\./g, "")
    .replace(",", ".");
  const parsed = Number(normalized.replace(/[^\d.]/g, ""));
  return Number.isFinite(parsed) ? (isMillion ? parsed * 1_000_000 : parsed) : 0;
}

function RolePriorityPanel({
  copy,
  deals,
  events,
  leads,
  language,
  presetId,
  tasks,
}: {
  copy: ReturnType<typeof getDashboardCopy>;
  deals: Deal[];
  events: CalendarEvent[];
  leads: Lead[];
  language: LanguageCode;
  presetId: NavigationPresetId;
  tasks: Task[];
}) {
  const roleCopy = (copy as typeof copy & { rolePriorities?: RolePriorityPanelCopy }).rolePriorities ?? {
    description: "Role-specific start priorities for daily CRM work.",
    metrics: {
      appointments: "Appointments",
      hotLeads: "Hot leads",
      noOwner: "Without owner",
      openTasks: "Open tasks",
      pipeline: "Pipeline value",
      riskDeals: "Risk deals",
      unlinkedTasks: "Unlinked tasks",
    },
    nextStepsLabel: "Next steps",
    profiles: {
      default: {
        description: "Start with the cases that need attention now.",
        nextSteps: ["Review hot leads", "Clear today's tasks", "Check pipeline risks"],
        title: "Today important",
      },
    },
    title: "Role start",
  };
  const profile = roleCopy.profiles[presetId] ?? roleCopy.profiles.default;
  const openTasks = tasks.filter((task) => task.status === "open");
  const now = new Date();
  const pipelineValue = deals
    .filter((deal) => !["Gewonnen", "Verloren", "Disqualifiziert"].includes(deal.stage))
    .reduce((sum, deal) => sum + parseRolePanelDealValue(deal.value) * (deal.probability / 100), 0);
  const locale = language === "de" ? "de-AT" : "en-US";
  const metricValues = {
    appointments: events.filter((event) => new Date(event.startsAt).getTime() >= now.getTime()).length,
    hotLeads: leads.filter((lead) => lead.score >= 80 || lead.hotStatus).length,
    noOwner: leads.filter((lead) => !lead.assignedToUserId).length,
    openTasks: openTasks.length,
    pipeline: new Intl.NumberFormat(locale, { currency: "EUR", maximumFractionDigits: 0, notation: "compact", style: "currency" }).format(pipelineValue),
    riskDeals: deals.filter((deal) => deal.riskLevel === "hoch" || deal.probability < 45).length,
    unlinkedTasks: openTasks.filter((task) => !task.contactId || !task.projectId).length,
  };
  const prioritizedMetricKeys: Array<keyof typeof metricValues> =
    presetId === "management"
      ? ["pipeline", "riskDeals", "hotLeads", "appointments"]
      : presetId === "salesLead"
        ? ["noOwner", "riskDeals", "openTasks", "pipeline"]
      : presetId === "marketing"
        ? ["hotLeads", "appointments", "pipeline", "openTasks"]
      : presetId === "assistant"
        ? ["unlinkedTasks", "noOwner", "openTasks", "appointments"]
        : presetId === "admin"
          ? ["noOwner", "unlinkedTasks", "openTasks", "riskDeals"]
        : presetId === "newUser"
          ? ["hotLeads", "openTasks", "appointments", "pipeline"]
        : presetId === "sales" || presetId === "realEstateBroker"
          ? ["hotLeads", "openTasks", "appointments", "pipeline"]
          : presetId === "propertyDeveloper"
            ? ["hotLeads", "appointments", "pipeline", "riskDeals"]
            : presetId === "novalureInternal" || presetId === "managedService"
              ? ["noOwner", "openTasks", "riskDeals", "appointments"]
              : ["hotLeads", "openTasks", "pipeline", "appointments"];

  return (
    <section className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
      <div className="grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-800">{roleCopy.title}</p>
          <h3 className="mt-1 break-words text-xl font-semibold text-slate-950">{profile?.title}</h3>
          <p className="mt-2 max-w-3xl break-words text-sm leading-6 text-emerald-950">{profile?.description ?? roleCopy.description}</p>
          <p className="mt-4 text-xs font-semibold uppercase tracking-[0.14em] text-emerald-800">{roleCopy.nextStepsLabel}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {(profile?.nextSteps ?? []).map((step) => (
              <span className="rounded-md border border-emerald-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-emerald-950" key={step}>
                {step}
              </span>
            ))}
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {prioritizedMetricKeys.map((key) => (
            <div className="rounded-md border border-emerald-200 bg-white p-3" key={key}>
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{roleCopy.metrics[key]}</p>
              <p className="mt-2 text-xl font-semibold text-slate-950">{metricValues[key]}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function WorkspaceSetupDetails({
  activeProjects,
  canSwitch,
  context,
  copy,
  leads,
  onChange,
  onSwitch,
  profileLabel,
  saveState,
  switchState,
  tasks,
  units,
  workspaces,
}: {
  activeProjects: number;
  canSwitch: boolean;
  context: WorkspaceProductContext;
  copy: ReturnType<typeof getDashboardCopy>;
  leads: { status: string; type: string }[];
  onChange: <Key extends keyof WorkspaceSetupState>(
    key: Key,
    value: WorkspaceSetupState[Key],
  ) => void;
  onSwitch: (workspaceId: string) => void;
  profileLabel: string;
  saveState: WorkspaceSetupSaveState;
  switchState: "idle" | "loading" | "error";
  tasks: { status: string }[];
  units: { status: string }[];
  workspaces: ManagedWorkspaceOption[];
}) {
  const setupCopy = (copy as typeof copy & {
    compactSetup?: {
      description: string;
      title: string;
    };
  }).compactSetup ?? {
    description: "Workspace setup is available here when role, project or integration defaults need to change.",
    title: "Workspace setup and admin defaults",
  };

  return (
    <details className="rounded-lg border border-stone-200 bg-white p-4">
      <summary className="cursor-pointer text-sm font-semibold text-slate-950">
        {setupCopy.title}
      </summary>
      <p className="mt-2 break-words text-sm text-stone-600">{setupCopy.description}</p>
      <div className="mt-4 grid gap-4">
        <WorkspaceModePanel
          context={context}
          copy={copy}
          onChange={onChange}
          saveState={saveState}
        />

        <WorkspaceScopePanel
          activeProjects={activeProjects}
          canSwitch={canSwitch}
          context={context}
          copy={copy}
          onSwitch={onSwitch}
          profileLabel={profileLabel}
          switchState={switchState}
          workspaces={workspaces}
        />

        <WorkspaceModeKpis
          context={context}
          copy={copy}
          leads={leads}
          tasks={tasks}
          units={units}
        />
      </div>
    </details>
  );
}

function WorkspaceModePanel({
  context,
  copy,
  onChange,
  saveState,
}: {
  context: WorkspaceProductContext;
  copy: ReturnType<typeof getDashboardCopy>;
  onChange: <Key extends keyof WorkspaceSetupState>(
    key: Key,
    value: WorkspaceSetupState[Key],
  ) => void;
  saveState: WorkspaceSetupSaveState;
}) {
  const modeCopy = copy.workspaceMode;
  const canUseInternalModes = hasProductCapability(context.productRole, "novalure:internal");
  const customerTypeOptions = modeCopy.customerTypeOptions.filter(
    (option) => canUseInternalModes || option.id !== "novalure_internal",
  );
  const operatingModelOptions = modeCopy.operatingModelOptions.filter(
    (option) => canUseInternalModes || option.id !== "novalure_internal",
  );
  const generatedDefaults = [
    {
      label: modeCopy.defaultNavigation,
      value: copy.navigationPresets.profiles[getDefaultNavigationPresetId(context)].label,
    },
    {
      label: modeCopy.defaultDashboard,
      value:
        context.customerType === "property_developer"
          ? modeCopy.dashboardLabels.developer
          : context.operatingModel === "novalure_internal"
            ? modeCopy.dashboardLabels.novalure
            : modeCopy.dashboardLabels.broker,
    },
    {
      label: modeCopy.defaultCalendar,
      value: modeCopy.calendarProviderLabels[context.activeCalendarProvider],
    },
  ];

  return (
    <section className="rounded-lg border border-stone-200 bg-white p-5">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
            {modeCopy.eyebrow}
          </p>
          <h3 className="mt-1 break-words text-xl font-semibold text-slate-950">
            {modeCopy.title}
          </h3>
          <p className="mt-2 max-w-3xl break-words text-sm leading-6 text-stone-600">
            {modeCopy.description}
          </p>
          {context.operatingModel === "managed_by_novalure" ? (
            <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-950">
              {modeCopy.workingFor(context.workspaceName)}
            </p>
          ) : null}
          {saveState !== "idle" ? (
            <p
              className={`mt-3 text-sm font-semibold ${
                saveState === "error" ? "text-rose-700" : "text-emerald-700"
              }`}
            >
              {saveState === "saving"
                ? modeCopy.saveState.saving
                : saveState === "saved"
                  ? modeCopy.saveState.saved
                  : modeCopy.saveState.error}
            </p>
          ) : null}
        </div>
        <div className="grid w-full min-w-0 gap-3 md:grid-cols-2 xl:max-w-3xl">
          <label className="grid min-w-0 gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
            {modeCopy.customerType}
            <select
              className="w-full min-w-0 max-w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold normal-case tracking-normal text-slate-950"
              onChange={(event) =>
                onChange("customerType", event.target.value as WorkspaceCustomerType)
              }
              value={context.customerType}
            >
              {customerTypeOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="grid min-w-0 gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
            {modeCopy.operatingModel}
            <select
              className="w-full min-w-0 max-w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold normal-case tracking-normal text-slate-950"
              onChange={(event) =>
                onChange("operatingModel", event.target.value as WorkspaceOperatingModel)
              }
              value={context.operatingModel}
            >
              {operatingModelOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="grid min-w-0 gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
            {modeCopy.teamStructure}
            <select
              className="w-full min-w-0 max-w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold normal-case tracking-normal text-slate-950"
              onChange={(event) =>
                onChange("teamStructure", event.target.value as WorkspaceTeamStructure)
              }
              value={context.teamStructure}
            >
              {modeCopy.teamStructureOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="grid min-w-0 gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
            {modeCopy.calendarProvider}
            <select
              className="w-full min-w-0 max-w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold normal-case tracking-normal text-slate-950"
              onChange={(event) =>
                onChange("activeCalendarProvider", event.target.value as CalendarProviderChoice)
              }
              value={context.activeCalendarProvider}
            >
              {modeCopy.calendarProviderOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        {generatedDefaults.map((item) => (
          <div className="rounded-md border border-stone-200 bg-stone-50 p-3" key={item.label}>
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
              {item.label}
            </p>
            <p className="mt-1 break-words text-sm font-semibold text-slate-950">
              {item.value}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function WorkspaceScopePanel({
  activeProjects,
  canSwitch,
  context,
  copy,
  onSwitch,
  profileLabel,
  switchState,
  workspaces,
}: {
  activeProjects: number;
  canSwitch: boolean;
  context: WorkspaceProductContext;
  copy: ReturnType<typeof getDashboardCopy>;
  onSwitch: (workspaceId: string) => void;
  profileLabel: string;
  switchState: "idle" | "loading" | "error";
  workspaces: ManagedWorkspaceOption[];
}) {
  const scopeCopy = (copy as typeof copy & {
    workspaceScope?: {
      customerType: string;
      description: string;
      error: string;
      eyebrow: string;
      loading: string;
      operatingModel: string;
      profile: string;
      projects: string;
      switchLabel: string;
      workspace: string;
    };
  }).workspaceScope ?? {
    customerType: copy.workspaceMode.customerType,
    description: "All CRM lists, project filters and pipeline boards use this workspace as their current data scope.",
    error: "Workspace data could not be loaded.",
    eyebrow: "Active workspace",
    loading: "Loading workspace data...",
    operatingModel: copy.workspaceMode.operatingModel,
    profile: "Role / profile",
    projects: "Active projects",
    switchLabel: "Workspace switch",
    workspace: "Workspace",
  };
  const workspaceOptions = workspaces.length
    ? workspaces
    : [{ id: context.workspaceId, name: context.workspaceName }];

  return (
    <section className="rounded-lg border border-stone-200 bg-white p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
            {scopeCopy.eyebrow}
          </p>
          <h3 className="mt-1 break-words text-xl font-semibold text-slate-950">
            {context.workspaceName}
          </h3>
          <p className="mt-2 max-w-3xl break-words text-sm leading-6 text-stone-600">
            {scopeCopy.description}
          </p>
        </div>
        {canSwitch ? (
          <label className="grid min-w-0 gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500 lg:w-80">
            {scopeCopy.switchLabel}
            <select
              className="w-full min-w-0 max-w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold normal-case tracking-normal text-slate-950"
              onChange={(event) => onSwitch(event.target.value)}
              value={context.workspaceId}
            >
              {workspaceOptions.map((workspaceItem) => (
                <option key={workspaceItem.id} value={workspaceItem.id}>
                  {workspaceItem.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        {[
          [scopeCopy.workspace, context.workspaceName],
          [scopeCopy.customerType, copy.workspaceMode.customerTypeLabels[context.customerType]],
          [scopeCopy.operatingModel, copy.workspaceMode.operatingModelLabels[context.operatingModel]],
          [scopeCopy.projects, String(activeProjects)],
          [scopeCopy.profile, profileLabel],
        ].map(([label, value]) => (
          <div className="rounded-md border border-stone-200 bg-stone-50 p-3" key={label}>
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{label}</p>
            <p className="mt-1 break-words text-sm font-semibold text-slate-950">{value}</p>
          </div>
        ))}
      </div>
      {switchState === "loading" ? (
        <p className="mt-3 text-sm font-semibold text-stone-600">{scopeCopy.loading}</p>
      ) : switchState === "error" ? (
        <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-800">
          {scopeCopy.error}
        </p>
      ) : null}
    </section>
  );
}

function WorkspaceModeKpis({
  context,
  copy,
  leads,
  tasks,
  units,
}: {
  context: WorkspaceProductContext;
  copy: ReturnType<typeof getDashboardCopy>;
  leads: { status: string; type: string }[];
  tasks: { status: string }[];
  units: { status: string }[];
}) {
  const kpiCopy = copy.workspaceMode.kpis;
  const sellerLeads = leads.filter((lead) => lead.type === "Verkäufer").length;
  const buyerLeads = leads.filter((lead) => lead.type === "Käufer").length;
  const openTasks = tasks.filter((task) => task.status === "open").length;
  const availableUnits = units.filter((unit) => unit.status === "available").length;
  const reservedUnits = units.filter((unit) => unit.status === "reserved").length;
  const soldUnits = units.filter((unit) => unit.status === "sold").length;

  const values =
    context.customerType === "property_developer"
      ? [
          [kpiCopy.projectLeads, leads.length],
          [kpiCopy.freeUnits, availableUnits],
          [kpiCopy.reservedUnits, reservedUnits],
          [kpiCopy.soldUnits, soldUnits],
        ]
      : context.operatingModel === "novalure_internal"
        ? [
            [kpiCopy.crmCustomerLeads, leads.length],
            [kpiCopy.demosTrials, leads.filter((lead) => lead.type === "Makler" || lead.type === "Bauträger").length],
            [kpiCopy.openApprovals, openTasks],
            [kpiCopy.managedSla, tasks.length],
          ]
        : [
            [kpiCopy.sellerLeads, sellerLeads],
            [kpiCopy.buyerLeads, buyerLeads],
            [kpiCopy.openTasks, openTasks],
            [kpiCopy.pipelineLeads, leads.length],
          ];

  return (
    <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      {values.map(([label, value]) => (
        <div className="rounded-lg border border-stone-200 bg-white p-4" key={label}>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
            {label}
          </p>
          <p className="mt-2 text-2xl font-semibold text-slate-950">{value}</p>
        </div>
      ))}
    </section>
  );
}

function InternalWorkspaceView({
  activeProject,
  calendarEvents,
  context,
  copy,
  customerAccess,
  deals,
  kind,
  leads,
  projectLabel,
  projects,
  tasks,
}: {
  activeProject?: Project;
  calendarEvents: CalendarEvent[];
  context: WorkspaceProductContext;
  copy: ReturnType<typeof getDashboardCopy>;
  customerAccess: CustomerWorkspaceAccess[];
  deals: Deal[];
  kind: "managedService" | "onboarding" | "customerSuccess";
  leads: Lead[];
  projectLabel: string;
  projects: Project[];
  tasks: Task[];
}) {
  const screen = copy.internalScreens[kind];
  const labels = copy.internalScreens.labels;
  const [managedWorkspaces, setManagedWorkspaces] = useState<ManagedWorkspaceOption[]>([]);
  const [selectedManagedWorkspaceId, setSelectedManagedWorkspaceId] = useState(context.workspaceId);
  const [selectedManagedProjectId, setSelectedManagedProjectId] = useState("all");
  const [managedCoreData, setManagedCoreData] = useState<CoreCrmDataResult | null>(null);
  const [managedSwitchState, setManagedSwitchState] = useState<"idle" | "loading" | "error">("idle");

  useEffect(() => {
    if (kind !== "managedService") return;

    let cancelled = false;
    void fetch("/api/workspaces", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Workspace list failed");
        const payload = (await response.json()) as { workspaces?: ManagedWorkspaceOption[] };
        if (!cancelled) {
          const nextWorkspaces = payload.workspaces?.length
            ? payload.workspaces
            : [{ id: context.workspaceId, name: context.workspaceName }];
          setManagedWorkspaces(nextWorkspaces);
          if (!nextWorkspaces.some((workspaceItem) => workspaceItem.id === selectedManagedWorkspaceId)) {
            setSelectedManagedWorkspaceId(nextWorkspaces[0]?.id ?? context.workspaceId);
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          setManagedWorkspaces([{ id: context.workspaceId, name: context.workspaceName }]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [context.workspaceId, context.workspaceName, kind, selectedManagedWorkspaceId]);

  useEffect(() => {
    if (kind !== "managedService") return;

    let cancelled = false;

    void fetch(`/api/crm/core?workspaceId=${encodeURIComponent(selectedManagedWorkspaceId)}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Managed workspace data failed");
        const payload = (await response.json()) as { data?: CoreCrmDataResult };
        if (!cancelled) {
          setManagedCoreData(payload.data ?? null);
          setManagedSwitchState(payload.data ? "idle" : "error");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setManagedCoreData(null);
          setManagedSwitchState("error");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [kind, selectedManagedWorkspaceId]);

  const sourceProjects = kind === "managedService" && managedCoreData ? managedCoreData.projects : projects;
  const sourceLeads = kind === "managedService" && managedCoreData ? managedCoreData.leads : leads;
  const sourceDeals = kind === "managedService" && managedCoreData ? managedCoreData.deals : deals;
  const sourceTasks = kind === "managedService" && managedCoreData ? managedCoreData.tasks : tasks;
  const sourceCalendarEvents = kind === "managedService" && managedCoreData
    ? managedCoreData.calendarEvents
    : calendarEvents;
  const managedActiveProject = kind === "managedService" && selectedManagedProjectId !== "all"
    ? sourceProjects.find((project) => project.id === selectedManagedProjectId)
    : activeProject;
  const scopedLeads = kind === "managedService" && selectedManagedProjectId !== "all"
    ? sourceLeads.filter((lead) => lead.projectId === selectedManagedProjectId)
    : sourceLeads;
  const scopedDealsForView = kind === "managedService" && selectedManagedProjectId !== "all"
    ? sourceDeals.filter((deal) => deal.projectId === selectedManagedProjectId)
    : sourceDeals;
  const scopedTasksForView = kind === "managedService" && selectedManagedProjectId !== "all"
    ? sourceTasks.filter((task) => task.projectId === selectedManagedProjectId)
    : sourceTasks;
  const scopedEventsForView = kind === "managedService" && selectedManagedProjectId !== "all"
    ? sourceCalendarEvents.filter((event) => event.projectId === selectedManagedProjectId)
    : sourceCalendarEvents;
  const selectedManagedWorkspace = managedWorkspaces.find((item) => item.id === selectedManagedWorkspaceId);
  const today = new Date().toISOString().slice(0, 10);
  const scopedCustomers =
    kind === "onboarding"
      ? customerAccess.filter((item) => ["demo", "trial", "onboarding"].includes(item.status))
      : kind === "customerSuccess"
        ? customerAccess.filter((item) => item.status === "active" || item.status === "risk" || item.health !== "healthy")
        : customerAccess;
  const newLeads = scopedLeads.filter((lead) => lead.status === "Neu");
  const overdueTasks = scopedTasksForView.filter((task) => task.status === "open" && task.due && task.due < today);
  const meetingsToday = scopedEventsForView.filter((event) => event.startsAt.slice(0, 10) === today);
  const openApprovals = scopedCustomers.filter((item) => item.health === "risk" || item.status === "onboarding");
  const selectedCustomerName = selectedManagedWorkspace?.name ?? scopedCustomers[0]?.customerName ?? context.workspaceName;
  const selectedProjectName = managedActiveProject?.name ?? (selectedManagedProjectId === "all" ? labels.allProjects : projectLabel);
  const nextActions = [
    ...overdueTasks.map((task) => task.title),
    ...newLeads.map((lead) => lead.nextAction),
    ...scopedCustomers.map((customer) => customer.nextOnboardingAction),
  ].filter(Boolean).slice(0, 5);

  const metrics =
    kind === "onboarding"
      ? [
            [labels.customers, scopedCustomers.length],
            [labels.blockedSetups, scopedCustomers.filter((item) => item.health === "risk").length],
            [labels.tasks, sourceTasks.filter((task) => task.status === "open").length],
            [labels.project, sourceProjects.length],
          ]
      : kind === "customerSuccess"
        ? [
            [labels.activeCustomers, scopedCustomers.filter((item) => item.status === "active").length],
            [labels.riskCustomers, scopedCustomers.filter((item) => item.health === "risk" || item.status === "risk").length],
            [labels.tasks, sourceTasks.filter((task) => task.status === "open").length],
            [labels.pipeline, sourceDeals.length],
          ]
        : [
            [labels.newLeads, newLeads.length],
            [labels.overdueFollowUps, overdueTasks.length],
            [labels.todaysMeetings, meetingsToday.length],
            [labels.openApprovals, openApprovals.length],
          ];

  return (
    <section className="grid gap-5">
      <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
          {screen.eyebrow}
        </p>
        <h2 className="mt-2 break-words text-2xl font-semibold text-slate-950">{screen.title}</h2>
        <p className="mt-2 max-w-3xl break-words text-sm leading-6 text-stone-600">
          {screen.subtitle}
        </p>
        {kind === "managedService" ? (
          <div className="mt-4 grid gap-3">
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-950">
              {copy.internalScreens.managedService.context(selectedCustomerName, selectedProjectName)}
            </p>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                {labels.workspaceSwitch}
                <select
                  className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold normal-case tracking-normal text-slate-900"
                  onChange={(event) => {
                    setManagedSwitchState("loading");
                    setSelectedManagedProjectId("all");
                    setSelectedManagedWorkspaceId(event.target.value);
                  }}
                  value={selectedManagedWorkspaceId}
                >
                  {(managedWorkspaces.length ? managedWorkspaces : [{ id: context.workspaceId, name: context.workspaceName }]).map((workspaceItem) => (
                    <option key={workspaceItem.id} value={workspaceItem.id}>
                      {workspaceItem.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                {labels.projectSwitch}
                <select
                  className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold normal-case tracking-normal text-slate-900"
                  onChange={(event) => setSelectedManagedProjectId(event.target.value)}
                  value={selectedManagedProjectId}
                >
                  <option value="all">{labels.allProjects}</option>
                  {sourceProjects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {managedSwitchState === "loading" ? (
              <p className="text-sm font-semibold text-stone-600">{labels.loadingWorkspace}</p>
            ) : managedSwitchState === "error" ? (
              <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-800">
                {labels.workspaceSwitchError}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {metrics.map(([label, value]) => (
          <div className="rounded-lg border border-stone-200 bg-white p-4" key={label}>
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
              {label}
            </p>
            <p className="mt-2 text-2xl font-semibold text-slate-950">{value}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.1fr_0.9fr]">
        <section className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
          <h3 className="text-lg font-semibold text-slate-950">{labels.workspace}</h3>
          <div className="mt-4 grid gap-3">
            {kind === "managedService"
              ? (managedWorkspaces.length ? managedWorkspaces : [{ id: context.workspaceId, name: context.workspaceName }]).slice(0, 8).map((workspaceItem) => (
                  <button
                    className={`rounded-md border p-3 text-left ${
                      workspaceItem.id === selectedManagedWorkspaceId
                        ? "border-slate-950 bg-slate-950 text-white"
                        : "border-stone-200 bg-stone-50 text-slate-950 hover:border-emerald-300"
                    }`}
                    key={workspaceItem.id}
                    onClick={() => {
                      setManagedSwitchState("loading");
                      setSelectedManagedProjectId("all");
                      setSelectedManagedWorkspaceId(workspaceItem.id);
                    }}
                    type="button"
                  >
                    <span className="block break-words font-semibold">{workspaceItem.name}</span>
                    <span className={`mt-1 block text-sm ${workspaceItem.id === selectedManagedWorkspaceId ? "text-slate-200" : "text-stone-600"}`}>
                      {labels.workspaceStats(workspaceItem.activeProjects ?? sourceProjects.length, workspaceItem.activeUsers ?? 0)}
                    </span>
                  </button>
                ))
              : scopedCustomers.slice(0, 6).map((customer) => (
                  <article className="rounded-md border border-stone-200 bg-stone-50 p-3" key={customer.id}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="break-words font-semibold text-slate-950">{customer.customerName}</p>
                        <p className="mt-1 break-words text-sm text-stone-600">{customer.plan}</p>
                      </div>
                      <span className="shrink-0 rounded-md border border-stone-200 bg-white px-2 py-1 text-xs font-semibold text-slate-700">
                        {customer.activationScore}%
                      </span>
                    </div>
                    <p className="mt-2 break-words text-sm text-slate-700">
                      {customer.nextOnboardingAction || labels.nextBestAction}
                    </p>
                  </article>
                ))}
            {kind !== "managedService" && scopedCustomers.length === 0 ? (
              <p className="rounded-md border border-dashed border-stone-300 bg-stone-50 p-4 text-sm text-stone-600">
                {screen.empty}
              </p>
            ) : null}
          </div>
        </section>

        <aside className="grid gap-5">
          <section className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
            <h3 className="text-lg font-semibold text-slate-950">{labels.nextBestAction}</h3>
            <div className="mt-4 grid gap-2">
              {nextActions.length ? (
                nextActions.map((action, index) => (
                  <p className="rounded-md border border-stone-200 bg-stone-50 p-3 text-sm text-slate-700" key={`${action}-${index}`}>
                    {action}
                  </p>
                ))
              ) : (
                <p className="rounded-md border border-dashed border-stone-300 bg-stone-50 p-3 text-sm text-stone-600">
                  {screen.empty}
                </p>
              )}
            </div>
          </section>

          <section className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
            <h3 className="text-lg font-semibold text-slate-950">{labels.auditExcerpt}</h3>
            <div className="mt-4 grid gap-2">
              {[...scopedDealsForView.slice(0, 2), ...scopedTasksForView.slice(0, 2)].slice(0, 4).map((item) => (
                <p className="rounded-md border border-stone-200 bg-stone-50 p-3 text-sm text-slate-700" key={item.id}>
                  {"stage" in item ? item.nextAction : item.title}
                </p>
              ))}
            </div>
          </section>
        </aside>
      </div>
    </section>
  );
}

export function CrmWorkspace({
  coreData,
  sessionProductRole,
  sessionRole,
  sessionWorkspace,
}: CrmWorkspaceProps) {
  const initialProductContext = createWorkspaceProductContext({
    activeCalendarProvider: sessionWorkspace.activeCalendarProvider ?? workspace.activeCalendarProvider,
    customerType: sessionWorkspace.customerType ?? workspace.customerType,
    operatingModel: sessionWorkspace.operatingModel ?? workspace.operatingModel,
    productRole: sessionProductRole,
    projects: coreData.projects,
    teamStructure: sessionWorkspace.teamStructure ?? workspace.teamStructure,
    technicalRole: sessionRole,
    workspaceId: sessionWorkspace.id,
    workspaceName: sessionWorkspace.name,
    workspacePlan: workspace.plan,
  });
  const initialPresetId = getDefaultNavigationPresetId(initialProductContext);
  const initialAllowedPresetIds = getAllowedNavigationPresetIds(initialProductContext);
  const initialAllowedPresetKey = initialAllowedPresetIds.join("|");
  const [activeProjectId, setActiveProjectId] = useState("all");
  const [workspaceSetup, setWorkspaceSetup] = useState(() => ({
    activeCalendarProvider: initialProductContext.activeCalendarProvider,
    customerType: initialProductContext.customerType,
    operatingModel: initialProductContext.operatingModel,
    teamStructure: initialProductContext.teamStructure,
  }));
  const [workspaceSetupSaveState, setWorkspaceSetupSaveState] =
    useState<WorkspaceSetupSaveState>("idle");
  const [activePresetId, setActivePresetId] = useState<NavigationPresetId>(initialPresetId);
  const activePreset = navigationPresets[activePresetId];
  const [activeNavigationEntryId, setActiveNavigationEntryId] =
    useState<NavigationEntryId>(activePreset.startEntry);
  const [activeSection, setActiveSection] = useState<DashboardSection>(activePreset.startSection);
  const [liveCoreData, setLiveCoreData] = useState(coreData);
  const [activeWorkspace, setActiveWorkspace] = useState<ManagedWorkspaceOption>(() => ({
    activeCalendarProvider: sessionWorkspace.activeCalendarProvider ?? workspace.activeCalendarProvider ?? "none",
    activeProjects: coreData.projects.length,
    activeUsers: users.length,
    customerType: sessionWorkspace.customerType ?? workspace.customerType ?? "real_estate_broker",
    id: sessionWorkspace.id,
    name: sessionWorkspace.name,
    operatingModel: sessionWorkspace.operatingModel ?? workspace.operatingModel ?? "self_service_customer",
    productRole: sessionProductRole,
    teamStructure: sessionWorkspace.teamStructure ?? workspace.teamStructure ?? "small_team",
  }));
  const [availableWorkspaces, setAvailableWorkspaces] = useState<ManagedWorkspaceOption[]>([]);
  const [workspaceSwitchState, setWorkspaceSwitchState] = useState<"idle" | "loading" | "error">("idle");
  const [coreDataStatus, setCoreDataStatus] = useState<"idle" | "loading" | "fresh" | "error">("idle");
  const [actionModal, setActionModal] = useState<HeaderActionModal>(null);
  const [importNotice, setImportNotice] = useState("");
  const [importSource, setImportSource] = useState<ImportSource>("hubspot");
  const [projectNotice, setProjectNotice] = useState("");
  const [projectNoticeTone, setProjectNoticeTone] = useState<"error" | "success">("success");
  const [isProjectSaving, setIsProjectSaving] = useState(false);
  const [language, setLanguage] = useState<LanguageCode>(defaultLanguage);
  const [languageHydrated, setLanguageHydrated] = useState(false);
  const copy = getDashboardCopy(language);
  const importSourceOptions = copy.dialogs.import.sources;
  const projectTypeOptions = copy.dialogs.project.projectTypes;
  const projectPipelineOptions = copy.dialogs.project.pipelines;
  const [projectDraft, setProjectDraft] = useState<ProjectWizardDraft>(() => ({
    calendarProvider: workspaceSetup.activeCalendarProvider,
    customerType: workspaceSetup.customerType,
    funnelTemplateId: funnels[0]?.id ?? "",
    meetingProvider:
      workspaceSetup.activeCalendarProvider === "google"
        ? "google-meet"
        : workspaceSetup.activeCalendarProvider === "microsoft"
          ? "microsoft-teams"
          : "manual-link",
    name: "",
    notes: "",
    operatingModel: workspaceSetup.operatingModel,
    ownerUserId: users[0]?.id ?? "",
    pipelineId: projectPipelineOptions[0]?.id ?? "pipeline_standard_sales",
    teamStructure: workspaceSetup.teamStructure,
    type: projectTypeOptions[0]?.id ?? "real_estate_project",
  }));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const canUseWorkspaceSwitch =
    hasProductCapability(sessionProductRole, "managed-service:operate") &&
    hasProductCapability(sessionProductRole, "novalure:internal");

  const refreshCoreData = useCallback(async (workspaceId = activeWorkspace.id) => {
    setCoreDataStatus("loading");

    try {
      const query = workspaceId && workspaceId !== sessionWorkspace.id
        ? `?workspaceId=${encodeURIComponent(workspaceId)}`
        : "";
      const response = await fetch(`/api/crm/core${query}`, { cache: "no-store" });

      if (!response.ok) {
        throw new Error("CRM data refresh failed");
      }

      const payload = (await response.json()) as { data?: CoreCrmDataResult };

      if (payload.data) {
        setLiveCoreData(payload.data);
        setCoreDataStatus("fresh");
        return true;
      } else {
        setCoreDataStatus("error");
        return false;
      }
    } catch {
      setCoreDataStatus("error");
      return false;
    }
  }, [activeWorkspace.id, sessionWorkspace.id]);

  useEffect(() => {
    if (!canUseWorkspaceSwitch) return;

    const fallbackWorkspace: ManagedWorkspaceOption = {
      activeCalendarProvider: activeWorkspace.activeCalendarProvider,
      activeProjects: activeWorkspace.activeProjects,
      activeUsers: activeWorkspace.activeUsers,
      customerType: activeWorkspace.customerType,
      id: activeWorkspace.id,
      name: activeWorkspace.name,
      operatingModel: activeWorkspace.operatingModel,
      productRole: activeWorkspace.productRole,
      teamStructure: activeWorkspace.teamStructure,
    };
    let cancelled = false;
    void fetch("/api/workspaces", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Workspace list failed");
        return await response.json() as { workspaces?: ManagedWorkspaceOption[] };
      })
      .then((payload) => {
        if (cancelled) return;
        const nextWorkspaces = payload.workspaces?.length
          ? payload.workspaces
          : [fallbackWorkspace];
        setAvailableWorkspaces(nextWorkspaces);
        const currentWorkspace = nextWorkspaces.find((item) => item.id === activeWorkspace.id);
        if (currentWorkspace) {
          setActiveWorkspace((current) => ({ ...current, ...currentWorkspace }));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAvailableWorkspaces([fallbackWorkspace]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeWorkspace.activeCalendarProvider,
    activeWorkspace.activeProjects,
    activeWorkspace.activeUsers,
    activeWorkspace.customerType,
    activeWorkspace.id,
    activeWorkspace.name,
    activeWorkspace.operatingModel,
    activeWorkspace.productRole,
    activeWorkspace.teamStructure,
    canUseWorkspaceSwitch,
  ]);

  async function handleWorkspaceSwitch(workspaceId: string) {
    const nextWorkspace = availableWorkspaces.find((item) => item.id === workspaceId);
    const nextActiveWorkspace = nextWorkspace ?? { ...activeWorkspace, id: workspaceId };
    setWorkspaceSwitchState("loading");
    setActiveProjectId("all");
    setActiveWorkspace(nextActiveWorkspace);
    setWorkspaceSetup({
      activeCalendarProvider: nextActiveWorkspace.activeCalendarProvider ?? "none",
      customerType: nextActiveWorkspace.customerType ?? "real_estate_broker",
      operatingModel: nextActiveWorkspace.operatingModel ?? "self_service_customer",
      teamStructure: nextActiveWorkspace.teamStructure ?? "small_team",
    });

    try {
      const loaded = await refreshCoreData(workspaceId);
      setWorkspaceSwitchState(loaded ? "idle" : "error");
    } catch {
      setWorkspaceSwitchState("error");
    }
  }

  const contacts = liveCoreData.contacts.filter((contact) =>
    isVisibleBusinessRecord([contact.name, contact.email, contact.phone, contact.intent, contact.source]),
  );
  const brokerMandates = liveCoreData.brokerMandates ?? [];
  const buyerSearchProfiles = liveCoreData.buyerSearchProfiles ?? [];
  const calendarEvents = liveCoreData.calendarEvents.filter((event) =>
    isVisibleBusinessRecord([event.title, event.outcomeGoal]),
  );
  const leads = liveCoreData.leads.filter((lead) =>
    isVisibleBusinessRecord([lead.intent, lead.nextAction, lead.source, lead.status]),
  );
  const deals = liveCoreData.deals.filter((deal) =>
    isVisibleBusinessRecord([deal.name, deal.nextAction, deal.source]),
  );
  const crmPipelines = liveCoreData.crmPipelines ?? [];
  const crmPipelineStages = liveCoreData.crmPipelineStages ?? [];
  const projectPipelinePermissions = liveCoreData.projectPipelinePermissions ?? [];
  const tasks = liveCoreData.tasks.filter((task) =>
    isVisibleBusinessRecord([task.title]),
  );
  const projectRecords = liveCoreData.projects;
  const funnelRecords = liveCoreData.funnels;
  const funnelStepRecords = liveCoreData.funnelSteps;
  const newsletterSegmentRecords = liveCoreData.newsletterSegments;
  const newsletterCampaignRecords = liveCoreData.newsletterCampaigns;
  const crmBotRecords = liveCoreData.crmBots;
  const propertyBuildingRecords = liveCoreData.propertyBuildings;
  const propertyUnitRecords = liveCoreData.propertyUnits;
  const propertyReservationRecords = liveCoreData.propertyReservations;
  const allProjects = projectRecords;
  const workspaceContext = createWorkspaceProductContext({
    activeCalendarProvider: workspaceSetup.activeCalendarProvider ?? activeWorkspace.activeCalendarProvider,
    customerType: workspaceSetup.customerType ?? activeWorkspace.customerType,
    operatingModel: workspaceSetup.operatingModel ?? activeWorkspace.operatingModel,
    productRole: sessionProductRole,
    projects: allProjects,
    teamStructure: workspaceSetup.teamStructure ?? activeWorkspace.teamStructure,
    technicalRole: sessionRole,
    workspaceId: activeWorkspace.id,
    workspaceName: activeWorkspace.name,
    workspacePlan: workspace.plan,
  });
  const allowedPresetIds = getAllowedNavigationPresetIds(workspaceContext);
  const normalizedActivePresetId = allowedPresetIds.includes(activePresetId)
    ? activePresetId
    : getDefaultNavigationPresetId(workspaceContext);
  const normalizedActivePreset = navigationPresets[normalizedActivePresetId];
  const activeProject = allProjects.find((project) => project.id === activeProjectId);
  const projectScopeLabel = activeProject?.name ?? copy.header.allProjects;
  const sidebarToggleLabel = sidebarCollapsed
    ? copy.shell.expandNavigation
    : copy.shell.collapseNavigation;
  const navigationLabels = copy.navigation as Record<string, string>;
  const profileNavigationItems = normalizedActivePreset.navigationEntries.map((entryId) => ({
    ...navigationEntries[entryId],
    label: navigationLabels[entryId] ?? navigationLabels[navigationEntries[entryId].section],
  }));
  const activeNavigationEntry =
    navigationEntries[activeNavigationEntryId] ?? navigationEntries[normalizedActivePreset.startEntry];
  const activeNavigationAllowed = normalizedActivePreset.navigationEntries.includes(
    activeNavigationEntry.id,
  );
  const visibleActiveNavigationEntry = activeNavigationAllowed
    ? activeNavigationEntry
    : navigationEntries[normalizedActivePreset.startEntry];
  const visibleActiveSection = activeNavigationAllowed
    ? activeSection
    : visibleActiveNavigationEntry.section;
  const focusedNavigationItems = profileNavigationItems;
  const activePresetProfile = copy.navigationPresets.profiles[normalizedActivePresetId];
  const activeAreaLabel =
    navigationLabels[visibleActiveNavigationEntry.id] ??
    navigationLabels[visibleActiveNavigationEntry.section] ??
    activePresetProfile.label;
  const visibleLeads = activeProject
    ? leads.filter((lead) => lead.projectId === activeProject.id)
    : leads;
  const activeLeadTypes = visibleActiveNavigationEntry.leadTypes;
  const activeLeadInboxLeads = activeLeadTypes?.length
    ? visibleLeads.filter((lead) => activeLeadTypes.includes(lead.type))
    : visibleLeads;
  const visibleContacts = activeProject
    ? contacts.filter((contact) => contact.projectId === activeProject.id)
    : contacts;
  const visibleOrganizations = activeProject
    ? organizations.filter((organization) =>
        organization.projectId === activeProject.id &&
        isVisibleBusinessRecord([organization.name, organization.domain, organization.city]),
      )
    : organizations.filter((organization) =>
        isVisibleBusinessRecord([organization.name, organization.domain, organization.city]),
      );
  const visibleContactRelationships = activeProject
    ? contactRelationships.filter((relationship) => relationship.projectId === activeProject.id)
    : contactRelationships;
  const visibleContactTimeline = activeProject
    ? contactTimeline.filter((item) =>
        item.projectId === activeProject.id &&
        isVisibleBusinessRecord([item.title, item.detail]),
      )
    : contactTimeline.filter((item) =>
        isVisibleBusinessRecord([item.title, item.detail]),
      );
  const visibleTasks = activeProject
    ? tasks.filter((task) => task.projectId === activeProject.id)
    : tasks;
  const visibleConsents = activeProject
    ? consents.filter((consent) => !consent.projectId || consent.projectId === activeProject.id)
    : consents;
  const visibleConversations = activeProject
    ? conversations.filter((conversation) =>
        conversation.projectId === activeProject.id &&
        isVisibleBusinessRecord([conversation.summary, conversation.channel, conversation.sentiment]),
      )
    : conversations.filter((conversation) =>
        isVisibleBusinessRecord([conversation.summary, conversation.channel, conversation.sentiment]),
      );
  const visibleDeals = activeProject
    ? deals.filter((deal) => deal.projectId === activeProject.id)
    : deals;
  const visibleCalendarEvents = activeProject
    ? calendarEvents.filter((event) => event.projectId === activeProject.id)
    : calendarEvents;
  const visibleFunnels = activeProject
    ? funnelRecords.filter((funnel) => funnel.projectId === activeProject.id)
    : funnelRecords;
  const visibleFunnelSteps = activeProject
    ? funnelStepRecords.filter((step) => step.projectId === activeProject.id)
    : funnelStepRecords;
  const visibleLeadSequences = activeProject
    ? leadSequences.filter(
        (sequence) => !sequence.projectId || sequence.projectId === activeProject.id,
      )
    : leadSequences;
  const visibleLeadSequenceEvents = activeProject
    ? leadSequenceEvents.filter(
        (event) => !event.projectId || event.projectId === activeProject.id,
      )
    : leadSequenceEvents;
  const visibleNewsletterSegments = activeProject
    ? newsletterSegmentRecords.filter(
        (segment) => !segment.projectId || segment.projectId === activeProject.id,
      )
    : newsletterSegmentRecords;
  const visibleNewsletterCampaigns = activeProject
    ? newsletterCampaignRecords.filter(
        (campaign) => !campaign.projectId || campaign.projectId === activeProject.id,
      )
    : newsletterCampaignRecords;
  const visibleNewsletterAutomations = activeProject
    ? newsletterAutomations.filter(
        (automation) => !automation.projectId || automation.projectId === activeProject.id,
      )
    : newsletterAutomations;
  const visibleAutomations = activeProject
    ? automations.filter((automation) => !automation.projectId || automation.projectId === activeProject.id)
    : automations;
  const visibleKnowledgeBase = activeProject
    ? knowledgeBase.filter((item) => item.projectId === activeProject.id)
    : knowledgeBase;
  const visibleBotLanguageRules = activeProject
    ? botLanguageRules.filter(
        (rule) => !rule.projectId || rule.projectId === activeProject.id,
      )
    : botLanguageRules;
  const visibleCrmBots = activeProject
    ? crmBotRecords.filter((bot) => !bot.projectId || bot.projectId === activeProject.id)
    : crmBotRecords;
  const visibleCrmBotConversations = activeProject
    ? crmBotConversations.filter(
        (conversation) => !conversation.projectId || conversation.projectId === activeProject.id,
      )
    : crmBotConversations;
  const visibleCustomerWorkspaceAccess = customerWorkspaceAccess.filter(
    (item) => !activeProject || !item.projectId || item.projectId === activeProject.id,
  );
  const visibleBotLeadWorkflows = activeProject
    ? botLeadWorkflows.filter(
        (workflow) => !workflow.projectId || workflow.projectId === activeProject.id,
      )
    : botLeadWorkflows;
  const visibleBotCallInsights = activeProject
    ? botCallInsights.filter(
        (insight) => !insight.projectId || insight.projectId === activeProject.id,
      )
    : botCallInsights;
  const visiblePipeline = pipeline.map((stage) => {
    if (!activeProject) {
      return stage;
    }

    const cards = stage.cards.filter((card) =>
      visibleContacts.some((contact) => contact.name === card.name),
    );

    return {
      ...stage,
      cards,
      total: cards.length,
      value: cards.length > 0 ? activeProject.revenue : "0",
    };
  });
  const selectedImportSource =
    importSourceOptions.find((option) => option.id === importSource) ?? importSourceOptions[0];
  const selectedProjectTypeLabel =
    projectTypeOptions.find((option) => option.id === projectDraft.type)?.label ??
    projectDraft.type;
  const selectedProjectPipelineLabel =
    projectPipelineOptions.find((option) => option.id === projectDraft.pipelineId)?.label ?? "-";
  const importChecks = [
    {
      detail: copy.dialogs.import.checks.contacts(contacts.length),
      label: copy.dialogs.import.checks.contactsLabel,
      status: contacts.length > 0 ? ("ready" as const) : ("warning" as const),
    },
    {
      detail: copy.dialogs.import.checks.leads(leads.length),
      label: copy.dialogs.import.checks.leadsLabel,
      status: leads.length > 0 ? ("ready" as const) : ("warning" as const),
    },
    {
      detail: copy.dialogs.import.checks.pipeline(deals.length),
      label: copy.dialogs.import.checks.pipelineLabel,
      status: deals.length > 0 ? ("ready" as const) : ("action" as const),
    },
    {
      detail: copy.dialogs.import.checks.meetings(calendarEvents.length),
      label: copy.dialogs.import.checks.meetingsLabel,
      status: calendarEvents.length > 0 ? ("ready" as const) : ("action" as const),
    },
    {
      detail: copy.dialogs.import.checks.duplicates,
      label: copy.dialogs.import.checks.duplicatesLabel,
      status: "action" as const,
    },
  ];
  const readyImportChecks = importChecks.filter((check) => check.status === "ready").length;
  const projectWizardChecks = [
    {
      detail: projectDraft.name.trim() || copy.dialogs.project.missingName,
      label: copy.dialogs.project.projectName,
      status: projectDraft.name.trim().length >= 3 ? ("ready" as const) : ("warning" as const),
    },
    {
      detail: selectedProjectTypeLabel,
      label: copy.dialogs.project.projectType,
      status: "ready" as const,
    },
    {
      detail: selectedProjectPipelineLabel || copy.dialogs.project.selectPipeline,
      label: copy.dialogs.project.pipeline,
      status: projectDraft.pipelineId ? ("ready" as const) : ("warning" as const),
    },
    {
      detail:
        projectDraft.calendarProvider === "google"
          ? copy.dialogs.project.googleMeeting
          : projectDraft.calendarProvider === "microsoft"
            ? copy.dialogs.project.microsoftMeeting
            : copy.dialogs.project.noCalendarYet,
      label: copy.dialogs.import.checks.meetingsLabel,
      status: "action" as const,
    },
  ];
  const canPrepareProject =
    projectDraft.name.trim().length >= 3 && Boolean(projectDraft.type && projectDraft.pipelineId);

  function openImportReview() {
    setImportNotice("");
    setActionModal("import");
  }

  function openProjectWizard() {
    setProjectNotice("");
    setProjectNoticeTone("success");
    setActionModal("project");
  }

  function handleImportReview() {
    setImportNotice(
      copy.dialogs.import.notice(selectedImportSource.label, readyImportChecks, importChecks.length),
    );
  }

  async function handlePrepareProject() {
    if (isProjectSaving) return;

    if (!canPrepareProject) {
      setProjectNoticeTone("error");
      setProjectNotice(copy.dialogs.project.requiredNotice);
      return;
    }

    const nextProject: Partial<Project> = {
      customerType: projectDraft.customerType,
      defaultOperatingModel: projectDraft.operatingModel,
      defaultPipelineId: projectDraft.pipelineId,
      name: projectDraft.name.trim(),
      setupDefaults: {
        calendarProvider: projectDraft.calendarProvider,
        meetingProvider: projectDraft.meetingProvider,
        teamStructure: projectDraft.teamStructure,
      },
      status: "Aktiv",
      type: selectedProjectTypeLabel,
      workspaceId: activeWorkspace.id,
    };

    setIsProjectSaving(true);
    setProjectNotice("");
    let saved = false;
    try {
      const response = await fetch("/api/crm/projects", {
        body: JSON.stringify({
          project: {
            ...nextProject,
            customerType: projectDraft.customerType,
            defaultOperatingModel: projectDraft.operatingModel,
            setupDefaults: {
              calendarProvider: projectDraft.calendarProvider,
              meetingProvider: projectDraft.meetingProvider,
              teamStructure: projectDraft.teamStructure,
            },
          },
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => null) as { error?: string; project?: Project } | null;

      if (!response.ok || !payload?.project) {
        throw new Error(payload?.error ?? copy.dialogs.project.saveError);
      }

      const persistedProject = payload.project;

      setLiveCoreData((current) => ({
        ...current,
        projects: [
          persistedProject,
          ...current.projects.filter((project) => project.id !== persistedProject.id),
        ],
      }));
      setActiveWorkspace((current) => ({
        ...current,
        activeProjects: Math.max(current.activeProjects ?? 0, projectRecords.length + 1),
      }));
      setActiveProjectId(persistedProject.id);
      setProjectNoticeTone("success");
      setProjectNotice(copy.dialogs.project.preparedNotice(persistedProject.name));
      setProjectDraft((current) => ({ ...current, name: "", notes: "" }));
      await refreshCoreData();
      saved = true;
    } catch (error) {
      setProjectNoticeTone("error");
      setProjectNotice(error instanceof Error ? error.message : copy.dialogs.project.saveError);
    } finally {
      setIsProjectSaving(false);
    }
    if (saved) handleSectionChange("dashboard");
  }

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const allowedPresetIds = initialAllowedPresetKey.split("|") as NavigationPresetId[];
      const storedPresetId = readStoredPresetId(initialPresetId, allowedPresetIds);
      const storedPreset = navigationPresets[storedPresetId] ?? navigationPresets[initialPresetId];
      const nextSection = readInitialSection(storedPreset.startSection);
      const nextEntryId =
        storedPreset.navigationEntries.find((entryId) => navigationEntries[entryId].section === nextSection)
        ?? storedPreset.startEntry;

      setActivePresetId(storedPresetId);
      setActiveNavigationEntryId(nextEntryId);
      setActiveSection(nextSection);
      setSidebarCollapsed(nextSection === "pipelines");
    });

    return () => window.cancelAnimationFrame(frame);
  }, [initialAllowedPresetKey, initialPresetId]);

  useEffect(() => {
    const syncSectionFromHash = () => {
      const nextSection = readInitialSection(normalizedActivePreset.startSection);
      const nextEntryId =
        normalizedActivePreset.navigationEntries.find((entryId) => navigationEntries[entryId].section === nextSection)
        ?? normalizedActivePreset.startEntry;
      setActiveNavigationEntryId(nextEntryId);
      setActiveSection(nextSection);
      setSidebarCollapsed(nextSection === "pipelines");
    };

    window.addEventListener("hashchange", syncSectionFromHash);

    return () => window.removeEventListener("hashchange", syncSectionFromHash);
  }, [normalizedActivePreset]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setLanguage(readUrlLanguage() ?? readStoredLanguage(languageStorageKeys.system, getBrowserLanguageFallback()));
      setLanguageHydrated(true);
    });

    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!languageHydrated) return;

    window.localStorage.setItem(languageStorageKeys.system, language);
  }, [language, languageHydrated]);

  function handleLanguageChange(nextLanguage: LanguageCode) {
    setLanguage(nextLanguage);
  }

  function handleWorkspaceSetupChange<Key extends keyof WorkspaceSetupState>(
    key: Key,
    value: WorkspaceSetupState[Key],
  ) {
    const nextSetup = { ...workspaceSetup, [key]: value };
    setWorkspaceSetup(nextSetup);
    void persistWorkspaceSetup(nextSetup);
    if (key === "activeCalendarProvider") {
      setProjectDraft((current) => ({
        ...current,
        calendarProvider: value as CalendarProviderChoice,
        meetingProvider:
          value === "google"
            ? "google-meet"
            : value === "microsoft"
              ? "microsoft-teams"
              : "manual-link",
      }));
    }
  }

  async function persistWorkspaceSetup(nextSetup: WorkspaceSetupState) {
    setWorkspaceSetupSaveState("saving");

    try {
      const query = activeWorkspace.id !== sessionWorkspace.id
        ? `?workspaceId=${encodeURIComponent(activeWorkspace.id)}`
        : "";
      const response = await fetch(`/api/workspaces${query}`, {
        body: JSON.stringify({
          ...nextSetup,
          setupState: {
            generatedDefaults: {
              calendarProvider: nextSetup.activeCalendarProvider,
              customerType: nextSetup.customerType,
              navigationPreset: getDefaultNavigationPresetId({
                ...workspaceContext,
                ...nextSetup,
              }),
              operatingModel: nextSetup.operatingModel,
              teamStructure: nextSetup.teamStructure,
            },
          },
        }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      const payload = response.ok
        ? await response.json() as { workspace?: Partial<WorkspaceSetupState> }
        : null;

      if (!response.ok || !payload?.workspace) {
        throw new Error("workspace_setup_save_failed");
      }

      setWorkspaceSetup((current) => ({
        activeCalendarProvider:
          payload.workspace?.activeCalendarProvider ?? current.activeCalendarProvider,
        customerType: payload.workspace?.customerType ?? current.customerType,
        operatingModel: payload.workspace?.operatingModel ?? current.operatingModel,
        teamStructure: payload.workspace?.teamStructure ?? current.teamStructure,
      }));
      setWorkspaceSetupSaveState("saved");
    } catch {
      setWorkspaceSetupSaveState("error");
    }
  }

  function handleSectionChange(nextSection: DashboardSection, preferredEntryId?: NavigationEntryId) {
    setActiveSection(nextSection);
    const matchingEntry =
      preferredEntryId ??
      normalizedActivePreset.navigationEntries.find(
        (entryId) => navigationEntries[entryId].section === nextSection,
      );
    if (matchingEntry) {
      setActiveNavigationEntryId(matchingEntry);
    }
    if (nextSection === "pipelines") {
      setSidebarCollapsed(true);
    }

    if ([
      "dashboard",
      "analysis",
      "analytics",
      "leadInbox",
      "contacts",
      "customerAccess",
      "customerSuccess",
      "dataHygiene",
      "managedService",
      "objectsMandates",
      "onboarding",
      "pipelines",
      "projects",
      "settings",
      "tasks",
      "sequences",
    ].includes(nextSection)) {
      void refreshCoreData();
    }

    if (typeof window === "undefined") {
      return;
    }

    const nextUrl =
      nextSection === "dashboard"
        ? `${window.location.pathname}${window.location.search}`
        : `${window.location.pathname}${window.location.search}#${getNavigationHash(nextSection, matchingEntry)}`;

    window.history.replaceState(null, "", nextUrl);
  }

  function handleNavigationChange(entryId: NavigationEntryId) {
    const entry = navigationEntries[entryId];
    handleSectionChange(entry.section, entryId);
  }

  function handlePresetChange(nextPresetId: NavigationPresetId) {
    const nextPreset = navigationPresets[nextPresetId];

    setActivePresetId(nextPresetId);
    setActiveNavigationEntryId(nextPreset.startEntry);

    if (typeof window !== "undefined") {
      window.localStorage.setItem(navigationPresetStorageKey, nextPresetId);
    }

    if (!nextPreset.navigationEntries.some((entryId) => navigationEntries[entryId].section === activeSection)) {
      handleSectionChange(nextPreset.startSection);
    }
  }

  function handleQuickAction(actionId: QuickActionId) {
    if (actionId === "reviewImport") {
      openImportReview();
      return;
    }

    if (actionId === "newProject") {
      openProjectWizard();
      return;
    }

    const nextSection = quickActionSections[actionId];
    if (nextSection) {
      handleSectionChange(nextSection);
    }
  }

  return (
    <main className="min-h-screen bg-[#f4f2ec] text-slate-950">
      <div className="mx-auto flex min-h-screen w-full max-w-[1500px]">
        <aside
          className={`hidden shrink-0 overflow-hidden border-r border-stone-200 bg-white py-6 transition-all duration-200 xl:block ${
            sidebarCollapsed ? "w-16 px-2" : "w-80 px-5"
          }`}
        >
          <div
            className={`mb-8 flex gap-3 ${
              sidebarCollapsed ? "flex-col items-center" : "items-start justify-between"
            }`}
          >
            {sidebarCollapsed ? (
              <div className="grid h-10 w-10 place-items-center rounded-md bg-slate-950 text-white">
                <NovalureGlyph />
              </div>
            ) : (
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-700">
                  Novalure
                </p>
                <h1 className="mt-2 text-2xl font-semibold">{copy.shell.appTitle}</h1>
              </div>
            )}
            <button
              aria-expanded={!sidebarCollapsed}
              aria-label={sidebarToggleLabel}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-md border border-stone-300 bg-white text-sm font-semibold text-slate-800 hover:bg-stone-100"
              onClick={() => setSidebarCollapsed((current) => !current)}
              title={sidebarToggleLabel}
              type="button"
            >
              {sidebarCollapsed ? ">>" : "<<"}
            </button>
          </div>

          {!sidebarCollapsed ? (
            <div className="mb-4 rounded-lg border border-stone-200 bg-stone-50 p-4">
              <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                {copy.navigationPresets.label}
                <select
                  className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold normal-case tracking-normal text-slate-900"
                  onChange={(event) =>
                    handlePresetChange(event.target.value as NavigationPresetId)
                  }
                  value={normalizedActivePresetId}
                >
                  {allowedPresetIds.map((presetId) => (
                    <option key={presetId} value={presetId}>
                      {copy.navigationPresets.profiles[presetId].label}
                    </option>
                  ))}
                </select>
              </label>
              <p className="mt-2 break-words text-sm font-medium text-slate-900">
                {activePresetProfile.description}
              </p>
              <p className="mt-2 break-words text-xs text-stone-500">
                {copy.navigationPresets.helper}
              </p>
            </div>
          ) : null}

          <nav className="space-y-1 text-sm font-medium">
            {focusedNavigationItems.map((item) => (
              <button
                aria-label={item.label}
                className={`flex w-full items-center rounded-md py-2.5 text-left ${
                  visibleActiveNavigationEntry.id === item.id
                    ? "bg-slate-950 text-white"
                    : "text-slate-600 hover:bg-stone-100 hover:text-slate-950"
                } ${sidebarCollapsed ? "justify-center px-0" : "justify-between px-3"}`}
                key={item.id}
                onClick={() => handleNavigationChange(item.id)}
                title={item.label}
                type="button"
              >
                {sidebarCollapsed ? (
                  <span className="grid h-8 w-8 place-items-center rounded-md">
                    <NavigationIcon section={item.section} />
                  </span>
                ) : (
                  <span className="min-w-0 break-words">{item.label}</span>
                )}
                {!sidebarCollapsed && visibleActiveNavigationEntry.id === item.id ? (
                  <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-300" />
                ) : null}
              </button>
            ))}
          </nav>

          {!sidebarCollapsed ? (
            <>
              <div className="mt-8 rounded-lg border border-stone-200 bg-stone-50 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-stone-500">
                  {copy.sidebar.workspace}
                </p>
                <p className="mt-2 break-words text-sm font-semibold">{workspaceContext.workspaceName}</p>
                <p className="mt-1 break-words text-xs text-stone-600">
                  {copy.workspaceMode.operatingModelLabels[workspaceContext.operatingModel]}
                </p>
                <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
                  <div className="rounded-md bg-white p-3">
                    <p className="font-semibold">{allProjects.length}</p>
                    <p className="break-words text-xs text-stone-500">{copy.sidebar.projects}</p>
                  </div>
                  <div className="rounded-md bg-white p-3">
                    <p className="font-semibold">{users.length}</p>
                    <p className="break-words text-xs text-stone-500">{copy.sidebar.users}</p>
                  </div>
                </div>
              </div>

              <details className="mt-4 rounded-lg border border-stone-200 bg-white p-4" open>
                <summary className="cursor-pointer select-none text-sm font-semibold text-slate-900">
                  {copy.sidebar.projects}
                </summary>
                <div className="mt-4 space-y-2">
                  <button
                    className={`block w-full rounded-md border p-3 text-left text-sm ${
                      activeProjectId === "all"
                        ? "border-slate-950 bg-slate-950 text-white"
                        : "border-stone-200 bg-stone-50 text-slate-900 hover:border-emerald-200 hover:bg-emerald-50"
                    }`}
                    onClick={() => setActiveProjectId("all")}
                    type="button"
                  >
                    <span className="flex min-w-0 items-center justify-between gap-2">
                      <span className="min-w-0">
                        <span className="block break-words font-semibold">{copy.header.allProjects}</span>
                        <span
                          className={`mt-1 block break-words text-xs ${
                            activeProjectId === "all" ? "text-slate-300" : "text-stone-500"
                          }`}
                        >
                          {copy.header.allProjectsSubtitle}
                        </span>
                      </span>
                      <span
                        className={`shrink-0 rounded-md px-2 py-1 text-xs font-semibold ${
                          activeProjectId === "all"
                            ? "bg-white/10 text-white"
                            : "bg-white text-stone-700"
                        }`}
                      >
                        {allProjects.length}
                      </span>
                    </span>
                  </button>
                  {allProjects.map((project) => (
                    <button
                      className={`block w-full rounded-md border p-3 text-left text-sm ${
                        activeProjectId === project.id
                          ? "border-slate-950 bg-slate-950 text-white"
                          : "border-stone-200 bg-stone-50 text-slate-900 hover:border-emerald-200 hover:bg-emerald-50"
                      }`}
                      key={project.name}
                      onClick={() => setActiveProjectId(project.id)}
                      type="button"
                    >
                      <span className="flex min-w-0 items-start justify-between gap-2">
                        <span className="min-w-0">
                          <span
                            className={`block break-words font-semibold ${
                              activeProjectId === project.id ? "text-white" : "text-slate-900"
                            }`}
                          >
                            {project.name}
                          </span>
                          <span
                            className={`mt-1 block break-words text-xs ${
                              activeProjectId === project.id ? "text-slate-300" : "text-stone-500"
                            }`}
                          >
                            {project.type}
                          </span>
                        </span>
                        <span
                          className={`shrink-0 rounded-md px-2 py-1 text-xs font-semibold ${
                            statusStyles[project.status] ?? statusStyles.Review
                          }`}
                        >
                          {getCrmStatusLabel(project.status, language)}
                        </span>
                      </span>
                      <span className="mt-3 grid grid-cols-2 gap-2 text-xs">
                        <span
                          className={`rounded-md p-2 ${
                            activeProjectId === project.id ? "bg-white/10" : "bg-white"
                          }`}
                        >
                          <span
                            className={`block font-semibold ${
                              activeProjectId === project.id ? "text-white" : "text-slate-900"
                            }`}
                          >
                            {project.leads}
                          </span>
                          <span
                            className={
                              activeProjectId === project.id ? "text-slate-300" : "text-stone-500"
                            }
                          >
                            {copy.sidebar.leads}
                          </span>
                        </span>
                        <span
                          className={`rounded-md p-2 ${
                            activeProjectId === project.id ? "bg-white/10" : "bg-white"
                          }`}
                        >
                          <span
                            className={`block break-words font-semibold ${
                              activeProjectId === project.id ? "text-white" : "text-slate-900"
                            }`}
                          >
                            {project.revenue}
                          </span>
                          <span
                            className={
                              activeProjectId === project.id ? "text-slate-300" : "text-stone-500"
                            }
                          >
                            {copy.sidebar.pipeline}
                          </span>
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              </details>
            </>
          ) : null}
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          <header className="border-b border-stone-200 bg-white/90 px-4 py-4 backdrop-blur md:px-8">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="min-w-0">
                <p className="break-words text-sm font-medium text-emerald-700">
                  {projectScopeLabel}
                </p>
                <h2 className="mt-1 max-w-3xl break-words text-2xl font-semibold md:text-4xl">
                  {activeProject
                    ? copy.header.projectHeadline(activeProject.type)
                    : copy.header.defaultHeadline}
                </h2>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-stretch sm:justify-end">
                <label className="flex flex-col gap-1 text-xs font-semibold text-stone-600">
                  {copy.language.systemLabel}
                  <select
                    className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800"
                    onChange={(event) => handleLanguageChange(event.target.value as LanguageCode)}
                    value={language}
                  >
                    {supportedLanguages.map((item) => (
                      <option key={item.code} value={item.code}>
                        {item.nativeName}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="min-h-12 min-w-32 rounded-md border border-stone-300 bg-white px-4 py-2.5 text-center text-sm font-semibold leading-5 text-slate-800 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={coreDataStatus === "loading"}
                  onClick={() => void refreshCoreData()}
                  type="button"
                >
                  {coreDataStatus === "loading" ? copy.header.refreshingButton : copy.header.refreshButton}
                </button>
                <button
                  className="min-h-12 min-w-32 rounded-md border border-stone-300 bg-white px-4 py-2.5 text-center text-sm font-semibold leading-5 text-slate-800 hover:bg-stone-100"
                  onClick={openImportReview}
                  type="button"
                >
                  {copy.header.importButton}
                </button>
                <button
                  className="min-h-12 min-w-32 rounded-md bg-slate-950 px-4 py-2.5 text-center text-sm font-semibold leading-5 text-white hover:bg-slate-800"
                  onClick={openProjectWizard}
                  type="button"
                >
                  {copy.header.newProjectButton}
                </button>
                <form action="/api/auth/logout" className="sm:flex" method="post">
                  <button
                    className="min-h-12 w-full min-w-32 rounded-md border border-stone-300 bg-white px-4 py-2.5 text-center text-sm font-semibold leading-5 text-slate-800 hover:bg-stone-100 sm:w-auto"
                    type="submit"
                  >
                    {copy.header.logout}
                  </button>
                </form>
              </div>
            </div>
            <div className="mt-4 flex flex-col gap-2 border-t border-stone-200 pt-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-stone-500">
                  {copy.navigationPresets.quickActionsLabel}
                </p>
                <p className="mt-1 break-words text-sm font-semibold text-slate-900">
                  {activePresetProfile.label}
                </p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end sm:justify-end">
                <label className="flex flex-col gap-1 text-xs font-semibold text-stone-600 xl:hidden">
                  {copy.navigationPresets.label}
                  <select
                    className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800"
                    onChange={(event) =>
                      handlePresetChange(event.target.value as NavigationPresetId)
                    }
                    value={normalizedActivePresetId}
                  >
                    {allowedPresetIds.map((presetId) => (
                      <option key={presetId} value={presetId}>
                        {copy.navigationPresets.profiles[presetId].label}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex flex-wrap gap-2">
                  {normalizedActivePreset.quickActions.map((actionId) => (
                    <button
                      className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-stone-100"
                      key={actionId}
                      onClick={() => handleQuickAction(actionId)}
                      type="button"
                    >
                      {copy.navigationPresets.quickActions[actionId]}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </header>

          <div className="min-w-0 space-y-6 px-4 py-6 md:px-8">
            <WorkspaceContextBar
              areaLabel={activeAreaLabel}
              copy={copy}
              dataScopeLabel={activeProject ? activeProject.name : copy.header.allProjects}
              profileLabel={activePresetProfile.label}
              projectLabel={projectScopeLabel}
              workspaceName={workspaceContext.workspaceName}
            />

            {visibleActiveSection === "dashboard" ? (
              <RolePriorityPanel
                copy={copy}
                deals={visibleDeals}
                events={visibleCalendarEvents}
                language={language}
                leads={visibleLeads}
                presetId={normalizedActivePresetId}
                tasks={visibleTasks}
              />
            ) : null}

            {visibleActiveSection === "dashboard" ? (
              <MobileDailyWork
                contacts={visibleContacts}
                events={visibleCalendarEvents}
                language={language}
                leads={visibleLeads}
                onOpenSection={handleSectionChange}
                panels={normalizedActivePreset.mobilePanels}
                projects={allProjects}
                tasks={visibleTasks}
                users={users}
              />
            ) : null}

            {visibleActiveSection === "dashboard" ? (
              <DashboardOverview
                calendarEvents={visibleCalendarEvents}
                contacts={visibleContacts}
                deals={visibleDeals}
                funnels={visibleFunnels}
                language={language}
                leads={visibleLeads}
                pipeline={visiblePipeline}
                projectLabel={projectScopeLabel}
                projects={allProjects}
                sellerListings={sellerListings.filter((listing) => !activeProject || listing.projectId === activeProject.id)}
                tasks={visibleTasks}
                users={users}
              />
            ) : null}

            {visibleActiveSection === "projects" ? (
              <ProjectsCommandCenter
                context={workspaceContext}
                copy={copy}
                deals={visibleDeals}
                leads={visibleLeads}
                projects={allProjects}
                tasks={visibleTasks}
              />
            ) : null}

            {visibleActiveSection === "objectsMandates" ? (
              <ObjectMandateCommandCenter
                brokerMandates={brokerMandates}
                buyerSearchProfiles={buyerSearchProfiles}
                context={workspaceContext}
                copy={copy}
                propertyReservations={propertyReservationRecords.filter(
                  (reservation) => !activeProject || reservation.projectId === activeProject.id,
                )}
                propertyUnits={propertyUnitRecords.filter(
                  (unit) => !activeProject || unit.projectId === activeProject.id,
                )}
                sellerListings={sellerListings.filter((listing) => !activeProject || listing.projectId === activeProject.id)}
              />
            ) : null}

            {visibleActiveSection === "analytics" ? (
              <AnalyticsCommandCenter
                calendarEvents={visibleCalendarEvents}
                copy={copy}
                deals={visibleDeals}
                leads={visibleLeads}
                projectLabel={projectScopeLabel}
                tasks={visibleTasks}
              />
            ) : null}

            {visibleActiveSection === "settings" ? (
              <SettingsCommandCenter
                context={workspaceContext}
                copy={copy}
                dataSource={liveCoreData.source}
                missingTables={liveCoreData.missingTables ?? []}
                moduleSources={liveCoreData.moduleSources}
                profileLabel={activePresetProfile.label}
              />
            ) : null}

            {visibleActiveSection === "analysis" ? (
              <CrmAnalysisBot
                automations={visibleAutomations}
                bots={visibleCrmBots}
                calendarEvents={visibleCalendarEvents}
                consents={visibleConsents}
                contacts={visibleContacts}
                crmBotConversations={visibleCrmBotConversations}
                customerWorkspaces={visibleCustomerWorkspaceAccess}
                dataSource={liveCoreData.source}
                missingTables={liveCoreData.missingTables ?? []}
                moduleSources={liveCoreData.moduleSources}
                deals={visibleDeals}
                funnels={visibleFunnels}
                knowledgeItems={visibleKnowledgeBase}
                language={language}
                leadSequences={visibleLeadSequences}
                leads={visibleLeads}
                newsletterCampaigns={visibleNewsletterCampaigns}
                newsletterSuppressions={newsletterSuppressions}
                newsletterSegments={visibleNewsletterSegments}
                propertyReservations={propertyReservationRecords.filter(
                  (reservation) => !activeProject || reservation.projectId === activeProject.id,
                )}
                propertyUnits={propertyUnitRecords.filter(
                  (unit) => !activeProject || unit.projectId === activeProject.id,
                )}
                projectLabel={projectScopeLabel}
                projects={allProjects}
                tasks={visibleTasks}
                users={users}
              />
            ) : null}

            {visibleActiveSection === "customerAccess" ? (
              <CustomerAccessCockpit
                activeProjectId={activeProject?.id ?? "all"}
                customerAccess={visibleCustomerWorkspaceAccess}
                language={language}
                projectLabel={projectScopeLabel}
                projects={allProjects}
                users={users}
              />
            ) : null}

            {visibleActiveSection === "managedService" ? (
              <InternalWorkspaceView
                activeProject={activeProject}
                calendarEvents={visibleCalendarEvents}
                context={workspaceContext}
                copy={copy}
                customerAccess={visibleCustomerWorkspaceAccess}
                deals={visibleDeals}
                kind="managedService"
                leads={visibleLeads}
                projectLabel={projectScopeLabel}
                projects={allProjects}
                tasks={visibleTasks}
              />
            ) : null}

            {visibleActiveSection === "onboarding" ? (
              <InternalWorkspaceView
                activeProject={activeProject}
                calendarEvents={visibleCalendarEvents}
                context={workspaceContext}
                copy={copy}
                customerAccess={visibleCustomerWorkspaceAccess}
                deals={visibleDeals}
                kind="onboarding"
                leads={visibleLeads}
                projectLabel={projectScopeLabel}
                projects={allProjects}
                tasks={visibleTasks}
              />
            ) : null}

            {visibleActiveSection === "customerSuccess" ? (
              <InternalWorkspaceView
                activeProject={activeProject}
                calendarEvents={visibleCalendarEvents}
                context={workspaceContext}
                copy={copy}
                customerAccess={visibleCustomerWorkspaceAccess}
                deals={visibleDeals}
                kind="customerSuccess"
                leads={visibleLeads}
                projectLabel={projectScopeLabel}
                projects={allProjects}
                tasks={visibleTasks}
              />
            ) : null}

            {visibleActiveSection === "dataHygiene" ? (
              <DataHygieneBoard
                consents={visibleConsents}
                contacts={visibleContacts}
                language={language}
                leads={visibleLeads}
                projectLabel={projectScopeLabel}
                projects={allProjects}
                users={users}
              />
            ) : null}

            {visibleActiveSection === "communication" ? (
              <CommunicationCommandCenter
                consents={visibleConsents}
                contacts={visibleContacts}
                conversations={visibleConversations}
                copy={copy}
                language={language}
                leads={visibleLeads}
                onOpenLeadInbox={() => handleSectionChange("leadInbox")}
                projectLabel={projectScopeLabel}
                projects={allProjects}
                users={users}
              />
            ) : null}

            {visibleActiveSection === "leadInbox" ? (
              <LeadInbox
                brokerMandates={brokerMandates}
                buyerSearchProfiles={buyerSearchProfiles}
                consents={visibleConsents}
                contacts={visibleContacts}
                conversations={visibleConversations}
                leads={activeLeadInboxLeads}
                language={language}
                onLeadsChanged={refreshCoreData}
                projects={allProjects}
                users={users}
              />
            ) : null}

            {visibleActiveSection === "bots" ? (
            <BotCommandCenter
              automations={visibleAutomations}
              bots={visibleCrmBots}
              callInsights={visibleBotCallInsights}
              conversations={visibleCrmBotConversations}
              knowledgeItems={visibleKnowledgeBase}
              language={language}
              projectLabel={projectScopeLabel}
              testPanel={
                <BotLanguageTester
                  language={language}
                  projects={allProjects}
                  rules={visibleBotLanguageRules}
                />
              }
              tools={crmBotTools}
              workflows={visibleBotLeadWorkflows}
            />
            ) : null}

            {visibleActiveSection === "pipelines" ? (
              <DealPipelineWorkspace
                calendarEvents={visibleCalendarEvents}
                contacts={visibleContacts}
                crmPipelineStages={crmPipelineStages.filter((stage) => !activeProject || stage.projectId === activeProject.id)}
                crmPipelines={crmPipelines.filter((pipeline) => !activeProject || pipeline.projectId === activeProject.id)}
                deals={visibleDeals}
                language={language}
                leads={visibleLeads}
                onDealsChanged={refreshCoreData}
                organizations={visibleOrganizations}
                pipeline={visiblePipeline}
                projectPipelinePermissions={projectPipelinePermissions.filter(
                  (permission) => !activeProject || permission.projectId === activeProject.id,
                )}
                projectLabel={projectScopeLabel}
                projects={allProjects}
                propertyReservations={propertyReservationRecords.filter(
                  (reservation) => !activeProject || reservation.projectId === activeProject.id,
                )}
                propertyUnits={propertyUnitRecords.filter(
                  (unit) => !activeProject || unit.projectId === activeProject.id,
                )}
                sellerListings={sellerListings.filter((listing) => !activeProject || listing.projectId === activeProject.id)}
                tasks={visibleTasks}
                users={users}
                workspaceId={activeWorkspace.id}
              />
            ) : null}

            {visibleActiveSection === "units" ? (
              <UnitBoard
                buildings={propertyBuildingRecords}
                contacts={contacts}
                deals={deals}
                initialProjectId={activeProject?.id ?? "all"}
                key={activeProject?.id ?? "all"}
                language={language}
                leads={visibleLeads}
                onReservationChanged={async () => {
                  await refreshCoreData();
                }}
                projectLabel={projectScopeLabel}
                projects={allProjects}
                reservations={propertyReservationRecords}
                units={propertyUnitRecords}
              />
            ) : null}

            {["tasks", "contacts"].includes(visibleActiveSection) ? (
            <section className="grid gap-4">
              {visibleActiveSection === "tasks" ? (
                <TaskCommandCenter
                  contacts={visibleContacts}
                  language={language}
                  leads={visibleLeads}
                  projectLabel={projectScopeLabel}
                  projects={allProjects}
                  tasks={visibleTasks}
                />
              ) : null}

              {visibleActiveSection === "contacts" ? (
                <ContactCommandCenter
                  consents={visibleConsents}
                  contacts={visibleContacts}
                  language={language}
                  leads={visibleLeads}
                  onContactsChanged={async () => {
                    await refreshCoreData();
                  }}
                  organizations={visibleOrganizations}
                  projects={allProjects}
                  relationships={visibleContactRelationships}
                  showTechnicalFields={
                    (normalizedActivePresetId === "admin" || normalizedActivePresetId === "novalureInternal") &&
                    (hasProductCapability(workspaceContext.productRole, "workspace:admin") ||
                      hasProductCapability(workspaceContext.productRole, "novalure:internal"))
                  }
                  tasks={visibleTasks}
                  timeline={visibleContactTimeline}
                  users={users}
                />
              ) : null}

            </section>
            ) : null}

            {visibleActiveSection === "knowledge" ? (
            <>
              <KnowledgeCommandCenter
                items={visibleKnowledgeBase}
                language={language}
                projectLabel={projectScopeLabel}
                projects={allProjects}
              />
            <section className="hidden gap-4 lg:grid-cols-[0.9fr_1.1fr]">
              <article className="rounded-lg border border-stone-200 bg-white p-5">
                <h3 className="text-lg font-semibold">{copy.panels.knowledge}</h3>
                <p className="mt-1 break-words text-sm text-stone-600">
                  {copy.panels.knowledgeDescription}
                </p>
                <div className="mt-4 space-y-3">
                  {visibleKnowledgeBase.map((item) => (
                    <div className="rounded-lg bg-stone-50 p-3" key={item.name}>
                      <div className="flex min-w-0 items-center justify-between gap-3">
                        <p className="min-w-0 break-words text-sm font-semibold">{item.name}</p>
                        <span className="shrink-0 text-sm font-semibold text-emerald-700">
                          {item.coverage}
                        </span>
                      </div>
                      <div className="mt-3 h-2 rounded-full bg-stone-200">
                        <div
                          className="h-2 rounded-full bg-emerald-700"
                          style={{ width: item.coverage }}
                        />
                      </div>
                      <p className="mt-2 break-words text-xs text-stone-500">
                        {item.items} {copy.panels.checkedEntries}
                      </p>
                    </div>
                  ))}
                  {visibleKnowledgeBase.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-stone-300 bg-stone-50 p-4 text-sm text-stone-500">
                      {copy.panels.noKnowledge}
                    </div>
                  ) : null}
                </div>
              </article>

              <article className="rounded-lg border border-stone-200 bg-slate-950 p-5 text-white">
                <h3 className="text-lg font-semibold">{copy.panels.technicalNext}</h3>
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  {copy.panels.technicalNextItems.map((item) => (
                    <div className="rounded-lg border border-white/10 bg-white/5 p-3" key={item}>
                      <p className="break-words text-sm font-medium text-slate-100">{item}</p>
                    </div>
                  ))}
                </div>
              </article>
            </section>
            </>
            ) : null}

            {visibleActiveSection === "calendar" ? (
              <CalendarCommandCenter
                contacts={visibleContacts}
                events={visibleCalendarEvents}
                language={language}
                leads={visibleLeads}
                projectLabel={projectScopeLabel}
                projects={allProjects}
                tasks={visibleTasks}
                users={users}
              />
            ) : null}

            {visibleActiveSection === "funnels" ? (
              <FunnelCommandCenter
                funnels={visibleFunnels}
                language={language}
                leads={visibleLeads}
                projectLabel={projectScopeLabel}
                projects={allProjects}
                steps={visibleFunnelSteps}
                users={users}
              />
            ) : null}

            {visibleActiveSection === "sequences" ? (
              <LeadSequenceCommandCenter
                consents={visibleConsents}
                contacts={visibleContacts}
                conversations={visibleConversations}
                deals={visibleDeals}
                events={visibleLeadSequenceEvents}
                language={language}
                leads={visibleLeads}
                projectLabel={projectScopeLabel}
                projects={allProjects}
                sequences={visibleLeadSequences}
                tasks={visibleTasks}
                users={users}
              />
            ) : null}

            {visibleActiveSection === "newsletter" ? (
              <NewsletterCommandCenter
                automations={visibleNewsletterAutomations}
                campaigns={visibleNewsletterCampaigns}
                consents={visibleConsents}
                contacts={visibleContacts}
                deliverability={newsletterDeliverability}
                language={language}
                leads={visibleLeads}
                projectLabel={projectScopeLabel}
                projects={allProjects}
                segments={visibleNewsletterSegments}
                suppressions={newsletterSuppressions}
                templates={newsletterTemplates}
                users={users}
              />
            ) : null}

            {visibleActiveSection === "forms" ? (
              <FormCommandCenter
                contacts={visibleContacts}
                events={visibleCalendarEvents}
                funnels={visibleFunnels}
                language={language}
                leads={visibleLeads}
                projectLabel={projectScopeLabel}
                projects={allProjects}
                tasks={visibleTasks}
                users={users}
              />
            ) : null}

            <WorkspaceSetupDetails
              activeProjects={allProjects.length}
              canSwitch={canUseWorkspaceSwitch}
              context={workspaceContext}
              copy={copy}
              leads={visibleLeads}
              onChange={handleWorkspaceSetupChange}
              onSwitch={(workspaceId) => void handleWorkspaceSwitch(workspaceId)}
              profileLabel={activePresetProfile.label}
              saveState={workspaceSetupSaveState}
              switchState={workspaceSwitchState}
              tasks={visibleTasks}
              units={propertyUnitRecords.filter(
                (unit) => !activeProject || unit.projectId === activeProject.id,
              )}
              workspaces={availableWorkspaces}
            />
          </div>
        </section>
      </div>
      {actionModal === "import" ? (
        <ModalShell
          closeLabel={copy.dialogs.close}
          eyebrow={copy.dialogs.import.eyebrow}
          footer={
            <>
              <button
                className="rounded-md border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-stone-100"
                onClick={() => setActionModal(null)}
                type="button"
              >
                {copy.dialogs.close}
              </button>
              <button
                className="rounded-md border border-blue-200 bg-white px-4 py-2 text-sm font-semibold text-blue-950 hover:bg-blue-50"
                onClick={() => {
                  setActionModal(null);
                  handleSectionChange("contacts");
                }}
                type="button"
              >
                {copy.dialogs.import.openDataQuality}
              </button>
              <button
                className="rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                onClick={handleImportReview}
                type="button"
              >
                {copy.dialogs.import.startReview}
              </button>
            </>
          }
          onClose={() => setActionModal(null)}
          title={copy.dialogs.import.title}
        >
          <div className="grid gap-5 lg:grid-cols-[0.85fr_1.15fr]">
            <div className="rounded-lg border border-stone-200 bg-stone-50 p-4">
              <h4 className="text-base font-semibold text-slate-950">{copy.dialogs.import.dataSource}</h4>
              <p className="mt-1 text-sm text-stone-600">
                {copy.dialogs.import.description}
              </p>
              <div className="mt-4 grid gap-2">
                {importSourceOptions.map((option) => (
                  <button
                    className={`rounded-md border p-3 text-left text-sm ${
                      importSource === option.id
                        ? "border-slate-950 bg-white text-slate-950"
                        : "border-stone-200 bg-white text-stone-700 hover:border-blue-200"
                    }`}
                    key={option.id}
                    onClick={() => setImportSource(option.id)}
                    type="button"
                  >
                    <span className="block font-semibold">{option.label}</span>
                    <span className="mt-1 block text-xs text-stone-500">
                      {option.description}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className="grid gap-4">
              <div className="rounded-lg border border-blue-100 bg-blue-50 p-4 text-blue-950">
                <p className="text-xs font-semibold uppercase tracking-[0.14em]">
                  {selectedImportSource.label}
                </p>
                <h4 className="mt-1 text-lg font-semibold">{copy.dialogs.import.readiness}</h4>
                <p className="mt-2 text-sm text-blue-900">
                  {copy.dialogs.import.readinessDescription(readyImportChecks, importChecks.length)}
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                {importChecks.map((check) => (
                  <div
                    className={`rounded-lg border p-4 ${actionStatusStyles[check.status]}`}
                    key={check.label}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <p className="font-semibold">{check.label}</p>
                      <span className="rounded-md bg-white/70 px-2 py-1 text-xs font-semibold">
                        {check.status === "ready"
                          ? copy.dialogs.statusReady
                          : check.status === "warning"
                            ? copy.dialogs.statusMissing
                            : copy.dialogs.statusReview}
                      </span>
                    </div>
                    <p className="mt-2 break-words text-sm opacity-80">{check.detail}</p>
                  </div>
                ))}
              </div>

              {importNotice ? (
                <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-900">
                  {importNotice}
                </div>
              ) : null}
            </div>
          </div>
        </ModalShell>
      ) : null}

      {actionModal === "project" ? (
        <ModalShell
          closeLabel={copy.dialogs.close}
          eyebrow={copy.dialogs.project.eyebrow}
          footer={
            <>
              <button
                className="rounded-md border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-stone-100"
                onClick={() => setActionModal(null)}
                type="button"
              >
                {copy.dialogs.cancel}
              </button>
              <button
                className="rounded-md border border-blue-200 bg-white px-4 py-2 text-sm font-semibold text-blue-950 hover:bg-blue-50"
                onClick={() => handleSectionChange("calendar")}
                type="button"
              >
                {copy.dialogs.project.viewMeetingSetup}
              </button>
              <button
                className="rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-stone-400"
                disabled={!canPrepareProject || isProjectSaving}
                onClick={handlePrepareProject}
                type="button"
              >
                {isProjectSaving ? copy.dialogs.project.saving : copy.dialogs.project.prepare}
              </button>
            </>
          }
          onClose={() => setActionModal(null)}
          title={copy.dialogs.project.title}
        >
          <div className="grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
            <div className="rounded-lg border border-stone-200 bg-white p-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500 sm:col-span-2">
                  {copy.dialogs.project.projectName}
                  <input
                    className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold normal-case tracking-normal text-slate-950 outline-none focus:border-slate-950"
                    onChange={(event) =>
                      setProjectDraft((current) => ({ ...current, name: event.target.value }))
                    }
                    placeholder={copy.dialogs.project.projectNamePlaceholder}
                    type="text"
                    value={projectDraft.name}
                  />
                </label>
                <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                  {copy.dialogs.project.projectType}
                  <select
                    className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold normal-case tracking-normal text-slate-950 outline-none focus:border-slate-950"
                    onChange={(event) =>
                      setProjectDraft((current) => ({ ...current, type: event.target.value }))
                    }
                    value={projectDraft.type}
                  >
                    {projectTypeOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                  {copy.workspaceMode.customerType}
                  <select
                    className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold normal-case tracking-normal text-slate-950 outline-none focus:border-slate-950"
                    onChange={(event) =>
                      setProjectDraft((current) => ({
                        ...current,
                        customerType: event.target.value as WorkspaceCustomerType,
                      }))
                    }
                    value={projectDraft.customerType}
                  >
                    {copy.workspaceMode.customerTypeOptions
                      .filter(
                        (option) =>
                          hasProductCapability(workspaceContext.productRole, "novalure:internal") ||
                          option.id !== "novalure_internal",
                      )
                      .map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                  {copy.workspaceMode.operatingModel}
                  <select
                    className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold normal-case tracking-normal text-slate-950 outline-none focus:border-slate-950"
                    onChange={(event) =>
                      setProjectDraft((current) => ({
                        ...current,
                        operatingModel: event.target.value as WorkspaceOperatingModel,
                      }))
                    }
                    value={projectDraft.operatingModel}
                  >
                    {copy.workspaceMode.operatingModelOptions
                      .filter(
                        (option) =>
                          hasProductCapability(workspaceContext.productRole, "novalure:internal") ||
                          option.id !== "novalure_internal",
                      )
                      .map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                  {copy.workspaceMode.teamStructure}
                  <select
                    className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold normal-case tracking-normal text-slate-950 outline-none focus:border-slate-950"
                    onChange={(event) =>
                      setProjectDraft((current) => ({
                        ...current,
                        teamStructure: event.target.value as WorkspaceTeamStructure,
                      }))
                    }
                    value={projectDraft.teamStructure}
                  >
                    {copy.workspaceMode.teamStructureOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                  {copy.dialogs.project.pipeline}
                  <select
                    className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold normal-case tracking-normal text-slate-950 outline-none focus:border-slate-950"
                    onChange={(event) =>
                      setProjectDraft((current) => ({ ...current, pipelineId: event.target.value }))
                    }
                    value={projectDraft.pipelineId}
                  >
                    {projectPipelineOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                  {copy.dialogs.project.owner}
                  <select
                    className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold normal-case tracking-normal text-slate-950 outline-none focus:border-slate-950"
                    onChange={(event) =>
                      setProjectDraft((current) => ({ ...current, ownerUserId: event.target.value }))
                    }
                    value={projectDraft.ownerUserId}
                  >
                    {users.map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                  {copy.dialogs.project.funnelTemplate}
                  <select
                    className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold normal-case tracking-normal text-slate-950 outline-none focus:border-slate-950"
                    onChange={(event) =>
                      setProjectDraft((current) => ({
                        ...current,
                        funnelTemplateId: event.target.value,
                      }))
                    }
                    value={projectDraft.funnelTemplateId}
                  >
                    {funnels.map((funnel) => (
                      <option key={funnel.id} value={funnel.id}>
                        {funnel.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                  {copy.dialogs.project.calendar}
                  <select
                    className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold normal-case tracking-normal text-slate-950 outline-none focus:border-slate-950"
                    onChange={(event) => {
                      const provider = event.target.value as ProjectWizardDraft["calendarProvider"];
                      setProjectDraft((current) => ({
                        ...current,
                        calendarProvider: provider,
                        meetingProvider:
                          provider === "google"
                            ? "google-meet"
                            : provider === "microsoft"
                              ? "microsoft-teams"
                              : "manual-link",
                      }));
                    }}
                    value={projectDraft.calendarProvider}
                  >
                    {copy.workspaceMode.calendarProviderOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                  {copy.dialogs.project.meetingProvider}
                  <select
                    className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold normal-case tracking-normal text-slate-950 outline-none focus:border-slate-950"
                    onChange={(event) =>
                      setProjectDraft((current) => ({
                        ...current,
                        meetingProvider: event.target.value as ProjectWizardDraft["meetingProvider"],
                      }))
                    }
                    value={projectDraft.meetingProvider}
                  >
                    <option value="microsoft-teams">Microsoft Teams</option>
                    <option value="google-meet">Google Meet</option>
                    <option value="manual-link">{copy.dialogs.project.manualMeeting}</option>
                  </select>
                </label>
                <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500 sm:col-span-2">
                  {copy.dialogs.project.notes}
                  <textarea
                    className="min-h-24 rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-950 outline-none focus:border-slate-950"
                    onChange={(event) =>
                      setProjectDraft((current) => ({ ...current, notes: event.target.value }))
                    }
                    placeholder={copy.dialogs.project.notesPlaceholder}
                    value={projectDraft.notes}
                  />
                </label>
              </div>
            </div>

            <div className="grid gap-4">
              <div className="rounded-lg border border-slate-200 bg-slate-950 p-4 text-white">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-300">
                  {copy.dialogs.project.preview}
                </p>
                <h4 className="mt-2 break-words text-xl font-semibold">
                  {projectDraft.name.trim() || copy.dialogs.project.newProject}
                </h4>
                <p className="mt-2 text-sm text-slate-300">{selectedProjectTypeLabel}</p>
                <div className="mt-4 grid gap-2 text-xs text-slate-200">
                  <span>
                    {copy.dialogs.project.pipeline}: {selectedProjectPipelineLabel}
                  </span>
                  <span>
                    {copy.dialogs.project.calendar}:{" "}
                    {projectDraft.calendarProvider === "google"
                      ? "Google Workspace"
                      : projectDraft.calendarProvider === "microsoft"
                        ? "Microsoft 365"
                        : copy.workspaceMode.calendarProviderLabels.none}
                  </span>
                  <span>
                    {copy.dialogs.project.meetingProvider}:{" "}
                    {projectDraft.meetingProvider === "google-meet"
                      ? "Google Meet"
                      : projectDraft.meetingProvider === "microsoft-teams"
                        ? "Microsoft Teams"
                        : copy.dialogs.project.manualMeeting}
                  </span>
                </div>
              </div>

              <div className="grid gap-2">
                {projectWizardChecks.map((check) => (
                  <div
                    className={`rounded-md border p-3 text-sm ${actionStatusStyles[check.status]}`}
                    key={check.label}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <p className="font-semibold">{check.label}</p>
                      <span className="rounded-md bg-white/70 px-2 py-1 text-xs font-semibold">
                        {check.status === "ready"
                          ? copy.dialogs.statusReady
                          : check.status === "warning"
                            ? copy.dialogs.statusMissing
                            : copy.dialogs.statusPrepared}
                      </span>
                    </div>
                    <p className="mt-1 break-words text-xs opacity-75">{check.detail}</p>
                  </div>
                ))}
              </div>

              {projectNotice ? (
                <div className={`rounded-md border px-3 py-2 text-sm font-semibold ${
                  projectNoticeTone === "error"
                    ? "border-red-200 bg-red-50 text-red-800"
                    : "border-emerald-200 bg-emerald-50 text-emerald-900"
                }`}>
                  {projectNotice}
                </div>
              ) : null}
            </div>
          </div>
        </ModalShell>
      ) : null}
    </main>
  );
}
