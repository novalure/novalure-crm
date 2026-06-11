import {
  hasProductCapability,
  type ProductRole,
  type TechnicalAppRole,
} from "@/lib/product-model";
import type { LanguageCode } from "@/lib/language-runtime";

export type OnboardingAudience = "admin" | "agent" | "viewer";

export type OnboardingStepId =
  | "workspace_profile"
  | "first_contact"
  | "first_lead_or_deal"
  | "pipeline_setup"
  | "team_invite"
  | "roles_rights"
  | "calendar_meetings"
  | "notifications"
  | "lead_center"
  | "daily_tasks"
  | "appointments"
  | "read_only_orientation"
  | "finish";

export type OnboardingStepStatus = "open" | "started" | "completed" | "skipped";

export type OnboardingStep = {
  actionLabel: string;
  audience: OnboardingAudience[];
  body: string;
  canSkip: boolean;
  id: OnboardingStepId;
  safetyNote?: string;
  targetHash: string;
  title: string;
  why: string;
};

const adminProductRoles = new Set<ProductRole>([
  "platform_admin",
  "novalureAdmin",
  "novalure_onboarding",
  "novalure_customer_success",
  "customer_owner",
  "workspace_admin",
]);

const viewerProductRoles = new Set<ProductRole>(["external_partner", "viewer"]);

export function getOnboardingAudience(productRole: ProductRole, technicalRole: TechnicalAppRole): OnboardingAudience {
  if (viewerProductRoles.has(productRole)) return "viewer";
  if (adminProductRoles.has(productRole) || technicalRole === "owner" || technicalRole === "admin") return "admin";
  if (hasProductCapability(productRole, "workspace:admin") || hasProductCapability(productRole, "customer-access:manage")) {
    return "admin";
  }

  return "agent";
}

const stepCopy: Record<LanguageCode, Record<OnboardingStepId, Omit<OnboardingStep, "audience" | "canSkip" | "id" | "targetHash">>> = {
  de: {
    workspace_profile: {
      actionLabel: "Workspace prüfen",
      body: "Bestätige Kundentyp, Teamstruktur und Arbeitsprofil, damit Navigation und Startbereiche zum Alltag passen.",
      safetyNote: "Änderungen am Workspace betreffen das ganze Team.",
      title: "Workspace einrichten",
      why: "Ein sauberer Workspace verhindert falsche Startansichten und unklare Zuständigkeiten.",
    },
    first_contact: {
      actionLabel: "Zu Kontakten",
      body: "Lege den ersten echten Kontakt an oder prüfe importierte Kontakte auf Name, Rolle, Einwilligung und Quelle.",
      title: "Ersten Kontakt anlegen",
      why: "Kontakte sind die Basis für Leads, Aufgaben, Termine und spätere Pipeline-Auswertung.",
    },
    first_lead_or_deal: {
      actionLabel: "Zur Lead-Zentrale",
      body: "Erstelle oder prüfe den ersten Lead mit Quelle, Status, Zuständigkeit und nächster Aktion.",
      title: "Ersten Lead oder Deal erstellen",
      why: "Ein Lead ohne klare nächste Aktion wird schnell zu einer verlorenen Anfrage.",
    },
    pipeline_setup: {
      actionLabel: "Pipeline prüfen",
      body: "Prüfe Phasen, Abschlusswahrscheinlichkeit und Projektbezug, bevor das Team aktiv damit arbeitet.",
      safetyNote: "Pipeline-Änderungen können Berichte und Teamabläufe beeinflussen.",
      title: "Pipeline konfigurieren",
      why: "Eine passende Pipeline macht sichtbar, welche Chancen wirklich vorankommen.",
    },
    team_invite: {
      actionLabel: "Team verwalten",
      body: "Lade nur die Personen ein, die produktiv im Workspace arbeiten sollen.",
      safetyNote: "Einladungen geben Zugriff auf Workspace-Daten. Rollen vor dem Versand prüfen.",
      title: "Team einladen",
      why: "Das System funktioniert nur, wenn Zuständigkeiten an echte Nutzer gekoppelt sind.",
    },
    roles_rights: {
      actionLabel: "Rollen prüfen",
      body: "Prüfe Owner, Admins, Mitarbeiter und eingeschränkte Nutzer, bevor sensible Funktionen freigegeben werden.",
      safetyNote: "Zu breite Rechte erhöhen das Risiko für falsche Änderungen.",
      title: "Rollen und Rechte vergeben",
      why: "Rollen schützen Kundendaten und halten gefährliche Aktionen bei den richtigen Personen.",
    },
    calendar_meetings: {
      actionLabel: "Kalender öffnen",
      body: "Verbinde oder prüfe Kalender, Meetings und Terminlogik für Rückrufe, Besichtigungen und Beratung.",
      title: "Kalender und Meetings verbinden",
      why: "Termine ohne CRM-Kontext erzeugen Lücken zwischen Anfrage, Gespräch und Pipeline.",
    },
    notifications: {
      actionLabel: "Benachrichtigungen prüfen",
      body: "Prüfe Erinnerungen, offene Aufgaben und SLA-Hinweise, damit wichtige Leads nicht liegen bleiben.",
      title: "Benachrichtigungen prüfen",
      why: "Klare Hinweise helfen dem Team, die nächste Aktion rechtzeitig auszuführen.",
    },
    lead_center: {
      actionLabel: "Lead-Zentrale öffnen",
      body: "Starte mit neuen und heißen Leads. Prüfe Status, Zuständigkeit und nächste Aktion.",
      title: "Lead-Zentrale verstehen",
      why: "Hier entscheidet sich, welche Anfrage heute bearbeitet wird.",
    },
    daily_tasks: {
      actionLabel: "Aufgaben öffnen",
      body: "Prüfe deine offenen Aufgaben und arbeite zuerst überfällige oder zeitkritische Punkte ab.",
      title: "Aufgaben bearbeiten",
      why: "Aufgaben machen Follow-up verbindlich und reduzieren verlorene Chancen.",
    },
    appointments: {
      actionLabel: "Termine öffnen",
      body: "Prüfe anstehende Termine, Rückrufe und Meeting-Kontext im CRM.",
      title: "Termine prüfen",
      why: "Termine sind nur wertvoll, wenn Vorbereitung und nächste Aktion sichtbar sind.",
    },
    read_only_orientation: {
      actionLabel: "Arbeitsbereich ansehen",
      body: "Orientiere dich in Leads, Kontakten, Aufgaben und Pipeline, ohne Daten zu verändern.",
      title: "Lesenden Zugriff verstehen",
      why: "Eingeschränkte Nutzer sollen sicher erkennen, was relevant ist, ohne versehentlich etwas zu ändern.",
    },
    finish: {
      actionLabel: "Onboarding abschließen",
      body: "Schließe das Setup ab, wenn die relevanten Schritte geprüft oder bewusst übersprungen wurden.",
      title: "Onboarding abschließen",
      why: "Der Abschluss zeigt, dass der Workspace bereit für den nächsten produktiven Schritt ist.",
    },
  },
  en: {
    workspace_profile: {
      actionLabel: "Review workspace",
      body: "Confirm customer type, team structure and work profile so navigation and start areas match daily work.",
      safetyNote: "Workspace changes affect the whole team.",
      title: "Set up workspace",
      why: "A clean workspace prevents wrong start views and unclear ownership.",
    },
    first_contact: {
      actionLabel: "Open contacts",
      body: "Create the first real contact or review imported contacts for name, role, consent and source.",
      title: "Create first contact",
      why: "Contacts are the base for leads, tasks, meetings and later pipeline reporting.",
    },
    first_lead_or_deal: {
      actionLabel: "Open Lead Center",
      body: "Create or review the first lead with source, status, ownership and next action.",
      title: "Create first lead or deal",
      why: "A lead without a clear next action quickly becomes a lost inquiry.",
    },
    pipeline_setup: {
      actionLabel: "Review pipeline",
      body: "Review stages, probability and project context before the team works with the pipeline.",
      safetyNote: "Pipeline changes can affect reporting and team workflows.",
      title: "Configure pipeline",
      why: "A fitting pipeline makes real opportunity progress visible.",
    },
    team_invite: {
      actionLabel: "Manage team",
      body: "Invite only the people who should actively work in this workspace.",
      safetyNote: "Invitations grant access to workspace data. Review roles before sending.",
      title: "Invite team",
      why: "The system only works when ownership is tied to real users.",
    },
    roles_rights: {
      actionLabel: "Review roles",
      body: "Review owners, admins, team members and restricted users before sensitive functions are enabled.",
      safetyNote: "Overly broad rights increase the risk of incorrect changes.",
      title: "Assign roles and rights",
      why: "Roles protect customer data and keep risky actions with the right people.",
    },
    calendar_meetings: {
      actionLabel: "Open calendar",
      body: "Connect or review calendars, meetings and appointment logic for callbacks, viewings and consultations.",
      title: "Connect calendar and meetings",
      why: "Appointments without CRM context create gaps between inquiry, meeting and pipeline.",
    },
    notifications: {
      actionLabel: "Review notifications",
      body: "Review reminders, open tasks and SLA signals so important leads do not stall.",
      title: "Review notifications",
      why: "Clear signals help the team take the next action on time.",
    },
    lead_center: {
      actionLabel: "Open Lead Center",
      body: "Start with new and hot leads. Review status, ownership and next action.",
      title: "Understand Lead Center",
      why: "This is where the team decides which inquiry gets worked today.",
    },
    daily_tasks: {
      actionLabel: "Open tasks",
      body: "Review your open tasks and start with overdue or time-critical items.",
      title: "Work tasks",
      why: "Tasks make follow-up explicit and reduce lost opportunities.",
    },
    appointments: {
      actionLabel: "Open appointments",
      body: "Review upcoming appointments, callbacks and meeting context in the CRM.",
      title: "Review appointments",
      why: "Appointments only create value when preparation and next action are visible.",
    },
    read_only_orientation: {
      actionLabel: "View workspace",
      body: "Orient yourself in leads, contacts, tasks and pipeline without changing data.",
      title: "Understand read-only access",
      why: "Restricted users should safely understand what matters without accidental changes.",
    },
    finish: {
      actionLabel: "Complete onboarding",
      body: "Complete setup once the relevant steps are reviewed or intentionally skipped.",
      title: "Complete onboarding",
      why: "Completion shows that the workspace is ready for the next productive step.",
    },
  },
};

const stepConfig: Array<Pick<OnboardingStep, "audience" | "canSkip" | "id" | "targetHash">> = [
  { audience: ["admin"], canSkip: false, id: "workspace_profile", targetHash: "settings" },
  { audience: ["admin"], canSkip: false, id: "first_contact", targetHash: "contacts" },
  { audience: ["admin"], canSkip: false, id: "first_lead_or_deal", targetHash: "lead-inbox" },
  { audience: ["admin"], canSkip: false, id: "pipeline_setup", targetHash: "pipelines" },
  { audience: ["admin"], canSkip: true, id: "team_invite", targetHash: "customer-access" },
  { audience: ["admin"], canSkip: false, id: "roles_rights", targetHash: "customer-access" },
  { audience: ["admin"], canSkip: true, id: "calendar_meetings", targetHash: "meetings" },
  { audience: ["admin"], canSkip: true, id: "notifications", targetHash: "tasks" },
  { audience: ["agent"], canSkip: false, id: "lead_center", targetHash: "lead-inbox" },
  { audience: ["agent"], canSkip: false, id: "first_contact", targetHash: "contacts" },
  { audience: ["agent"], canSkip: false, id: "first_lead_or_deal", targetHash: "lead-inbox" },
  { audience: ["agent"], canSkip: false, id: "daily_tasks", targetHash: "tasks" },
  { audience: ["agent"], canSkip: true, id: "appointments", targetHash: "meetings" },
  { audience: ["agent"], canSkip: true, id: "notifications", targetHash: "tasks" },
  { audience: ["viewer"], canSkip: false, id: "read_only_orientation", targetHash: "dashboard" },
  { audience: ["viewer"], canSkip: false, id: "lead_center", targetHash: "lead-inbox" },
  { audience: ["viewer"], canSkip: true, id: "appointments", targetHash: "meetings" },
  { audience: ["admin", "agent", "viewer"], canSkip: false, id: "finish", targetHash: "dashboard" },
];

export function getOnboardingSteps(
  productRole: ProductRole,
  technicalRole: TechnicalAppRole,
  language: LanguageCode,
) {
  const audience = getOnboardingAudience(productRole, technicalRole);

  return stepConfig
    .filter((step) => step.audience.includes(audience))
    .map((step) => ({
      ...step,
      ...stepCopy[language][step.id],
    }));
}

export function getNextOnboardingStepId(
  steps: Pick<OnboardingStep, "id">[],
  completedStepIds: string[],
  skippedStepIds: string[],
) {
  const done = new Set([...completedStepIds, ...skippedStepIds]);
  return steps.find((step) => !done.has(step.id))?.id ?? steps.at(-1)?.id ?? "finish";
}

export function normalizeOnboardingStepId(value: unknown, allowedStepIds: string[]) {
  return typeof value === "string" && allowedStepIds.includes(value)
    ? value as OnboardingStepId
    : null;
}
