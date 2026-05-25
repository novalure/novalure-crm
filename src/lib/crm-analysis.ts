import type {
  CalendarEvent,
  ConsentChannel,
  ConsentRecord,
  Contact,
  CrmBot,
  CrmBotConversation,
  CustomerWorkspaceAccess,
  Deal,
  Funnel,
  KnowledgeItem,
  Lead,
  LeadSequenceDefinition,
  NewsletterCampaign,
  NewsletterSegment,
  NewsletterSuppression,
  PropertyReservation,
  PropertyUnit,
  Task,
  WorkspaceUser,
} from "@/lib/crm-types";
import type {
  CoreCrmModuleSource,
  CoreCrmModuleSources,
} from "@/lib/db/crm-loaders";

export type SprintModuleId =
  | "productionData"
  | "speedToLead"
  | "inventory"
  | "botGovernance"
  | "consentGating"
  | "funnelRuntime"
  | "novalureCockpit"
  | "microsoft365"
  | "analytics"
  | "roleHygiene";

export type SprintModuleStatus = "ready" | "partial" | "risk";

export type SprintModule = {
  id: SprintModuleId;
  score: number;
  status: SprintModuleStatus;
};

export type CrmMaturityModuleId =
  | "dataPersistence"
  | "leadInbox"
  | "dealPipeline"
  | "tasksSequences"
  | "funnelsForms"
  | "botGovernance"
  | "calendarTeams"
  | "newsletterConsent"
  | "analyticsAttribution"
  | "developerInventory"
  | "novalureCustomerAccess";

export type CrmMaturityStatus = "working" | "partial" | "missing" | "risk";

export type CrmAnalysisAudience = "developer" | "novalure" | "both";

export type CrmAnalysisPriority = "p0" | "p1" | "p2";

export type CrmMaturitySignal = {
  id: string;
  value?: number;
};

export type CrmMaturityModule = {
  evidence: CrmMaturitySignal[];
  id: CrmMaturityModuleId;
  missing: CrmMaturitySignal[];
  nextStepId: string;
  percent: number;
  present: CrmMaturitySignal[];
  score: number;
  status: CrmMaturityStatus;
  weight: number;
};

export type CrmMaturityAction = {
  audience: CrmAnalysisAudience;
  effort: "small" | "medium" | "large";
  id: string;
  moduleId: CrmMaturityModuleId;
  priority: CrmAnalysisPriority;
};

export type CrmMaturityRisk = {
  id: string;
  level: "high" | "medium" | "low";
  moduleId: CrmMaturityModuleId;
};

export type CrmMaturityAssessment = {
  missingItems: CrmMaturityAction[];
  modules: CrmMaturityModule[];
  nextSteps: CrmMaturityAction[];
  risks: CrmMaturityRisk[];
  score: number;
};

export type SpeedToLeadState = "covered" | "dueSoon" | "overdue";

export type SpeedToLeadAlert = {
  id: string;
  contactName: string;
  leadId: string;
  minutesUntilDue: number;
  nextAction: string;
  ownerName: string;
  state: SpeedToLeadState;
};

export type ConsentPolicyReason =
  | "optIn"
  | "crmOnly"
  | "optOut"
  | "missing"
  | "suppressed"
  | "noAddress";

export type ConsentPolicyDecision = {
  id: string;
  allowed: boolean;
  channel: ConsentChannel;
  contactName: string;
  projectId: string;
  purpose: "salesFollowUp" | "newsletter" | "botOutreach";
  reason: ConsentPolicyReason;
};

export type DataHygieneIssueKind =
  | "missingContactRoute"
  | "missingConsent"
  | "staleLead"
  | "missingNextAction"
  | "duplicateEmail"
  | "duplicatePhone";

export type DataHygieneIssue = {
  id: string;
  contactId?: string;
  duplicateCount?: number;
  duplicateKey?: string;
  entityLabel: string;
  entityType: "contact" | "lead";
  kind: DataHygieneIssueKind;
  lastContactAt?: string;
  leadId?: string;
  nextAction?: string;
  ownerUserId?: string;
  projectId: string;
  severity: "risk" | "warning";
  workspaceId: string;
};

export type InventorySummary = {
  available: number;
  blocked: number;
  expiringReservations: PropertyReservation[];
  reserved: number;
  sold: number;
  total: number;
  totalValueCents: number;
};

export type BotGovernanceSummary = {
  activeChannels: number;
  approvedKnowledgeItems: number;
  botsWithEvaluationGuardrails: number;
  botsWithoutStrictKnowledge: number;
  evaluationReadiness: number;
  handoffRules: number;
  needsReviewKnowledgeItems: number;
  openConversations: number;
  score: number;
};

export type CustomerAccessSummary = {
  averageActivationScore: number;
  healthy: number;
  priorityAccounts: CustomerWorkspaceAccess[];
  risk: number;
  total: number;
};

export type AnalysisSprintResult = {
  botGovernance: BotGovernanceSummary;
  consentDecisions: ConsentPolicyDecision[];
  customerAccess: CustomerAccessSummary;
  dataHygieneIssues: DataHygieneIssue[];
  inventory: InventorySummary;
  modules: SprintModule[];
  score: number;
  speedToLeadAlerts: SpeedToLeadAlert[];
  targetScore: number;
};

const TARGET_SCORE = 70;
const productionModuleKeys = [
  "calendarEvents",
  "contacts",
  "deals",
  "leads",
  "projects",
  "tasks",
] as const;

function parseDate(value?: string) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function minutesBetween(from: Date, to: Date) {
  return Math.round((to.getTime() - from.getTime()) / 60000);
}

function latestConsentFor(
  contactId: string,
  channel: ConsentChannel,
  consents: ConsentRecord[],
) {
  return consents
    .filter((consent) => consent.contactId === contactId && consent.channel === channel)
    .sort((left, right) => {
      const rightTime = parseDate(right.capturedAt)?.getTime() ?? 0;
      const leftTime = parseDate(left.capturedAt)?.getTime() ?? 0;
      return rightTime - leftTime;
    })[0];
}

function hasContactOptInLabel(value: string | null | undefined) {
  return /(opt.?in|einwilligung|zugestimmt|subscribed|newsletter\s+ja|ja\s+newsletter|yes|true)/i.test(value ?? "");
}

function hasContactOptOutLabel(value: string | null | undefined) {
  return /(opt.?out|abgemeldet|unsubscribe|unsubscribed|widerspruch|stop|no|false)/i.test(value ?? "");
}

export function analyzeSpeedToLead(
  leads: Lead[],
  contacts: Contact[],
  users: WorkspaceUser[],
  now = new Date(),
): SpeedToLeadAlert[] {
  return leads
    .filter((lead) => lead.status !== "Archiviert")
    .map((lead) => {
      const contact = contacts.find((item) => item.id === lead.contactId);
      const owner = users.find((user) => user.id === lead.assignedToUserId);
      const dueAt = parseDate(lead.slaDueAt);
      const receivedAt = parseDate(lead.receivedAt);
      const lastContactAt = parseDate(lead.lastContactAt);
      const hasFirstResponse =
        Boolean(receivedAt && lastContactAt && lastContactAt.getTime() >= receivedAt.getTime());
      const minutesUntilDue = dueAt ? minutesBetween(now, dueAt) : 0;
      const state: SpeedToLeadState = hasFirstResponse
        ? "covered"
        : minutesUntilDue < 0
          ? "overdue"
          : minutesUntilDue <= 120
            ? "dueSoon"
            : "covered";

      return {
        id: `sla_${lead.id}`,
        contactName: contact?.name ?? lead.id,
        leadId: lead.id,
        minutesUntilDue,
        nextAction: lead.nextAction,
        ownerName: owner?.name ?? "-",
        state,
      };
    })
    .sort((left, right) => {
      const severityRank: Record<SpeedToLeadState, number> = {
        overdue: 0,
        dueSoon: 1,
        covered: 2,
      };

      return severityRank[left.state] - severityRank[right.state] || left.minutesUntilDue - right.minutesUntilDue;
    });
}

export function canContact(
  contact: Contact,
  channel: ConsentChannel,
  purpose: ConsentPolicyDecision["purpose"],
  consents: ConsentRecord[],
  suppressions: NewsletterSuppression[] = [],
): ConsentPolicyDecision {
  const latestConsent = latestConsentFor(contact.id, channel, consents);
  const suppressedEmail =
    channel === "Newsletter" &&
    Boolean(contact.email) &&
    suppressions.some((item) => item.email.toLowerCase() === contact.email?.toLowerCase());
  const hasAddress =
    channel === "Telefon" || channel === "WhatsApp"
      ? Boolean(contact.phone)
      : Boolean(contact.email) || channel === "Instagram";
  const reason: ConsentPolicyReason = !hasAddress
    ? "noAddress"
    : suppressedEmail
      ? "suppressed"
      : latestConsent?.status === "Opt-in"
        ? "optIn"
        : hasContactOptInLabel(contact.consent)
          ? "optIn"
          : latestConsent?.status === "Opt-out" || hasContactOptOutLabel(contact.consent)
            ? "optOut"
            : latestConsent?.status === "Nur CRM" || contact.consent === "Nur CRM"
              ? "crmOnly"
              : "missing";

  return {
    id: `consent_${contact.id}_${channel}_${purpose}`,
    allowed: reason === "optIn",
    channel,
    contactName: contact.name,
    projectId: contact.projectId,
    purpose,
    reason,
  };
}

export function analyzeConsentGating(
  contacts: Contact[],
  consents: ConsentRecord[],
  suppressions: NewsletterSuppression[] = [],
) {
  return contacts.flatMap((contact) => [
    canContact(contact, "Newsletter", "newsletter", consents, suppressions),
    canContact(contact, "WhatsApp", "botOutreach", consents, suppressions),
    canContact(contact, "E-Mail", "salesFollowUp", consents, suppressions),
  ]);
}

export function analyzeDataHygiene(
  contacts: Contact[],
  leads: Lead[],
  consents: ConsentRecord[],
  now = new Date(),
): DataHygieneIssue[] {
  const issues: DataHygieneIssue[] = [];
  const emailCounts = new Map<string, number>();
  const phoneCounts = new Map<string, number>();

  contacts.forEach((contact) => {
    if (contact.email) {
      emailCounts.set(contact.email.toLowerCase(), (emailCounts.get(contact.email.toLowerCase()) ?? 0) + 1);
    }

    if (contact.phone) {
      phoneCounts.set(contact.phone, (phoneCounts.get(contact.phone) ?? 0) + 1);
    }
  });

  contacts.forEach((contact) => {
    if (!contact.email && !contact.phone) {
      issues.push({
        contactId: contact.id,
        id: `hygiene_route_${contact.id}`,
        entityLabel: contact.name,
        entityType: "contact",
        kind: "missingContactRoute",
        projectId: contact.projectId,
        severity: "risk",
        workspaceId: contact.workspaceId,
      });
    }

    if (!consents.some((consent) => consent.contactId === contact.id && consent.status === "Opt-in")) {
      issues.push({
        contactId: contact.id,
        id: `hygiene_consent_${contact.id}`,
        entityLabel: contact.name,
        entityType: "contact",
        kind: "missingConsent",
        projectId: contact.projectId,
        severity: "warning",
        workspaceId: contact.workspaceId,
      });
    }

    const duplicateEmailCount = contact.email ? emailCounts.get(contact.email.toLowerCase()) ?? 0 : 0;
    if (contact.email && duplicateEmailCount > 1) {
      issues.push({
        contactId: contact.id,
        duplicateCount: duplicateEmailCount,
        duplicateKey: contact.email,
        id: `hygiene_email_${contact.id}`,
        entityLabel: contact.email,
        entityType: "contact",
        kind: "duplicateEmail",
        projectId: contact.projectId,
        severity: "risk",
        workspaceId: contact.workspaceId,
      });
    }

    const duplicatePhoneCount = contact.phone ? phoneCounts.get(contact.phone) ?? 0 : 0;
    if (contact.phone && duplicatePhoneCount > 1) {
      issues.push({
        contactId: contact.id,
        duplicateCount: duplicatePhoneCount,
        duplicateKey: contact.phone,
        id: `hygiene_phone_${contact.id}`,
        entityLabel: contact.phone,
        entityType: "contact",
        kind: "duplicatePhone",
        projectId: contact.projectId,
        severity: "risk",
        workspaceId: contact.workspaceId,
      });
    }
  });

  leads
    .filter((lead) => lead.status !== "Archiviert")
    .forEach((lead) => {
      const contact = contacts.find((item) => item.id === lead.contactId);
      const lastContactAt = parseDate(lead.lastContactAt);
      const stale =
        !lastContactAt || minutesBetween(lastContactAt, now) > 10080;

      if (stale) {
        issues.push({
          id: `hygiene_stale_${lead.id}`,
          contactId: contact?.id ?? lead.contactId,
          entityLabel: contact?.name ?? lead.id,
          entityType: "lead",
          kind: "staleLead",
          lastContactAt: lead.lastContactAt,
          leadId: lead.id,
          nextAction: lead.nextAction,
          ownerUserId: lead.assignedToUserId,
          projectId: lead.projectId,
          severity: lead.score >= 80 ? "risk" : "warning",
          workspaceId: lead.workspaceId,
        });
      }

      if (!lead.nextAction.trim()) {
        issues.push({
          id: `hygiene_next_${lead.id}`,
          contactId: contact?.id ?? lead.contactId,
          entityLabel: contact?.name ?? lead.id,
          entityType: "lead",
          kind: "missingNextAction",
          lastContactAt: lead.lastContactAt,
          leadId: lead.id,
          nextAction: lead.nextAction,
          ownerUserId: lead.assignedToUserId,
          projectId: lead.projectId,
          severity: "warning",
          workspaceId: lead.workspaceId,
        });
      }
    });

  return issues.sort((left, right) => {
    const severityRank = { risk: 0, warning: 1 };
    return severityRank[left.severity] - severityRank[right.severity];
  });
}

export function summarizeInventory(
  units: PropertyUnit[],
  reservations: PropertyReservation[],
  now = new Date(),
): InventorySummary {
  return {
    available: units.filter((unit) => unit.status === "available").length,
    blocked: units.filter((unit) => unit.status === "blocked").length,
    expiringReservations: reservations.filter((reservation) => {
      const expiresAt = parseDate(reservation.expiresAt);
      return expiresAt ? minutesBetween(now, expiresAt) <= 2880 && reservation.status !== "converted" : false;
    }),
    reserved: units.filter((unit) => unit.status === "reserved").length,
    sold: units.filter((unit) => unit.status === "sold").length,
    total: units.length,
    totalValueCents: units.reduce((sum, unit) => sum + unit.priceCents, 0),
  };
}

export function analyzeBotGovernance(
  bots: CrmBot[],
  knowledgeItems: KnowledgeItem[],
  conversations: CrmBotConversation[],
): BotGovernanceSummary {
  const activeChannels = bots.flatMap((bot) => bot.channels).filter((channel) => channel.active).length;
  const activeChannelsReady = bots
    .flatMap((bot) => bot.channels)
    .filter((channel) => channel.active && ["connected", "ready"].includes(channel.setupStatus ?? "")).length;
  const approvedKnowledgeItems = knowledgeItems.filter((item) => item.status === "approved").length;
  const needsReviewKnowledgeItems = knowledgeItems.filter((item) => item.status === "needs-review").length;
  const strictBots = bots.filter((bot) => bot.strictKnowledge).length;
  const handoffRules = bots.flatMap((bot) => bot.channels.flatMap((channel) => channel.handoffRules)).length;
  const botsWithHandoffRules = bots.filter((bot) =>
    bot.channels.some((channel) => channel.handoffRules.length > 0),
  ).length;
  const botsWithEvaluationGuardrails = bots.filter(
    (bot) =>
      bot.strictKnowledge &&
      approvedKnowledgeItems > 0 &&
      bot.channels.some((channel) => channel.handoffRules.length > 0),
  ).length;
  const evaluationReadiness =
    bots.length > 0 ? Math.round((botsWithEvaluationGuardrails / bots.length) * 100) : 0;
  const openConversations = conversations.filter((conversation) => conversation.status === "open").length;

  const strictScore = bots.length > 0 ? Math.round((strictBots / bots.length) * 25) : 0;
  const knowledgeScore =
    knowledgeItems.length > 0 ? Math.round((approvedKnowledgeItems / knowledgeItems.length) * 20) : 0;
  const channelScore =
    activeChannels > 0 ? Math.round((activeChannelsReady / activeChannels) * 15) : 0;
  const handoffScore = bots.length > 0 ? Math.round((botsWithHandoffRules / bots.length) * 15) : 0;
  const evaluationScore = Math.round((evaluationReadiness / 100) * 15);
  const conversationScore = openConversations > 0 ? 10 : 6;

  return {
    activeChannels,
    approvedKnowledgeItems,
    botsWithEvaluationGuardrails,
    botsWithoutStrictKnowledge: bots.length - strictBots,
    evaluationReadiness,
    handoffRules,
    needsReviewKnowledgeItems,
    openConversations,
    score: Math.min(
      100,
      strictScore + knowledgeScore + channelScore + handoffScore + evaluationScore + conversationScore,
    ),
  };
}

export function summarizeCustomerAccess(
  customerWorkspaces: CustomerWorkspaceAccess[],
): CustomerAccessSummary {
  const totalActivation = customerWorkspaces.reduce(
    (sum, customerWorkspace) => sum + customerWorkspace.activationScore,
    0,
  );

  return {
    averageActivationScore:
      customerWorkspaces.length > 0 ? Math.round(totalActivation / customerWorkspaces.length) : 0,
    healthy: customerWorkspaces.filter((item) => item.health === "healthy").length,
    priorityAccounts: [...customerWorkspaces]
      .sort((left, right) => left.activationScore - right.activationScore)
      .slice(0, 3),
    risk: customerWorkspaces.filter((item) => item.health === "risk").length,
    total: customerWorkspaces.length,
  };
}

function moduleStatus(score: number): SprintModuleStatus {
  if (score >= 8) {
    return "ready";
  }

  return score >= 5 ? "partial" : "risk";
}

function maturityStatus(
  score: number,
  weight: number,
  hasProductionRisk = false,
): CrmMaturityStatus {
  if (score <= 0) {
    return "missing";
  }

  const percent = Math.round((score / weight) * 100);

  if (hasProductionRisk) {
    return "risk";
  }

  if (percent >= 85) {
    return "working";
  }

  return percent >= 45 ? "partial" : "risk";
}

function maturityModule(input: {
  evidence: CrmMaturitySignal[];
  id: CrmMaturityModuleId;
  missing: CrmMaturitySignal[];
  nextStepId: string;
  present: CrmMaturitySignal[];
  risk?: boolean;
  score: number;
  weight: number;
}): CrmMaturityModule {
  const score = Math.max(0, Math.min(input.weight, input.score));

  return {
    evidence: input.evidence,
    id: input.id,
    missing: input.missing,
    nextStepId: input.nextStepId,
    percent: Math.round((score / input.weight) * 100),
    present: input.present,
    score,
    status: maturityStatus(score, input.weight, input.risk),
    weight: input.weight,
  };
}

function signal(id: string, value?: number): CrmMaturitySignal {
  return value === undefined ? { id } : { id, value };
}

function isDatabaseModule(input: { dataSource: CoreCrmModuleSource; moduleSources?: CoreCrmModuleSources }, key: keyof CoreCrmModuleSources) {
  return input.moduleSources ? input.moduleSources[key] === "database" : input.dataSource === "database";
}

function hasNoMissingTables(input: { missingTables?: string[] }, tableNames: string[]) {
  const missingTables = new Set(input.missingTables ?? []);
  return tableNames.every((tableName) => !missingTables.has(tableName));
}

export function buildCrmMaturityAssessment(input: {
  bots: CrmBot[];
  calendarEvents: CalendarEvent[];
  consentDecisions: ConsentPolicyDecision[];
  contacts: Contact[];
  crmBotConversations: CrmBotConversation[];
  customerWorkspaces: CustomerWorkspaceAccess[];
  dataHygieneIssues: DataHygieneIssue[];
  dataSource: CoreCrmModuleSource;
  deals: Deal[];
  funnels: Funnel[];
  knowledgeItems: KnowledgeItem[];
  leadSequences: LeadSequenceDefinition[];
  leads: Lead[];
  missingTables?: string[];
  moduleSources?: CoreCrmModuleSources;
  newsletterCampaigns: NewsletterCampaign[];
  newsletterSegments: NewsletterSegment[];
  newsletterSuppressions: NewsletterSuppression[];
  propertyReservations: PropertyReservation[];
  propertyUnits: PropertyUnit[];
  speedToLeadAlerts: SpeedToLeadAlert[];
  tasks: Task[];
}): CrmMaturityAssessment {
  const botGovernance = analyzeBotGovernance(input.bots, input.knowledgeItems, input.crmBotConversations);
  const microsoftEvents = input.calendarEvents.filter(
    (event) => event.meetingProvider === "microsoft-teams" || event.teamsJoinUrl,
  );
  const activeFunnels = input.funnels.filter((funnel) => funnel.status === "aktiv");
  const overdueSla = input.speedToLeadAlerts.filter((alert) => alert.state === "overdue");
  const blockedConsentDecisions = input.consentDecisions.filter((decision) => !decision.allowed);
  const riskHygieneIssues = input.dataHygieneIssues.filter((issue) => issue.severity === "risk");
  const reservationCoverage = input.propertyUnits.length > 0 && input.propertyReservations.length > 0;
  const customerAccessRisk = input.customerWorkspaces.some((access) => access.health === "risk");
  const moduleSourceEntries = input.moduleSources ? Object.values(input.moduleSources) : [];
  const databaseModuleCount = moduleSourceEntries.filter((source) => source === "database").length;
  const fallbackModuleCount = moduleSourceEntries.filter((source) => source === "fallback").length;
  const coreDatabaseCount = input.moduleSources
    ? productionModuleKeys.filter((key) => input.moduleSources?.[key] === "database").length
    : input.dataSource === "database"
      ? productionModuleKeys.length
      : 0;
  const missingTableCount = input.missingTables?.length ?? 0;
  const hasFollowUpRuntime = hasNoMissingTables(input, ["crm_follow_up_actions"]);
  const hasViewingOfferRuntime = hasNoMissingTables(input, [
    "property_viewing_slots",
    "property_unit_audit_events",
    "property_offer_milestones",
  ]);
  const hasBotAnswerChecks = hasNoMissingTables(input, ["bot_answer_quality_checks"]);
  const hasConversionSnapshots = hasNoMissingTables(input, ["crm_conversion_snapshots"]);
  const hasOnboardingRiskAlerts = hasNoMissingTables(input, ["customer_onboarding_risk_alerts"]);
  const hasCleanupWorkflow = hasNoMissingTables(input, ["data_quality_cleanup_actions"]);
  const hasBulkFollowUpRuntime = hasNoMissingTables(input, ["crm_bulk_runtime_batches"]);
  const hasOutreachDeliveryRuntime = hasNoMissingTables(input, ["crm_outreach_deliveries"]);
  const hasPermissionAuditRuntime = hasNoMissingTables(input, ["crm_permission_audit_runs"]);
  const hasRecommendationCompletionRuntime = hasNoMissingTables(input, ["crm_operational_recommendation_runs"]);
  const hasPipelineManagementRuntime = hasNoMissingTables(input, [
    "pipeline_forecast_snapshots",
    "pipeline_bulk_actions",
  ]);
  const hasFunnelConversionReports = hasNoMissingTables(input, ["funnel_conversion_reports"]);
  const hasMicrosoftBookingHealth = hasNoMissingTables(input, ["microsoft_booking_health_checks"]);
  const hasSequenceRuntimeReviews = hasNoMissingTables(input, ["sequence_runtime_reviews"]);
  const hasRevenueCohortAnalytics =
    hasConversionSnapshots && hasFunnelConversionReports && hasPipelineManagementRuntime;
  const hasProductionDataRisk =
    input.dataSource !== "database" ||
    fallbackModuleCount > 0 ||
    missingTableCount > 0 ||
    coreDatabaseCount < productionModuleKeys.length;
  const developmentReadiness = {
    analytics: hasNoMissingTables(input, [
      "analytics_events",
      "audit_logs",
      "crm_conversion_snapshots",
      "funnel_conversion_reports",
      "pipeline_forecast_snapshots",
    ]),
    botGovernance: hasNoMissingTables(input, [
      "bots",
      "bot_channel_accounts",
      "bot_channel_webhooks",
      "bot_evaluation_runs",
      "bot_answer_quality_checks",
      "knowledge_sources",
      "knowledge_chunks",
    ]),
    calendarTeams: hasNoMissingTables(input, [
      "calendar_events",
      "meeting_pages",
      "meeting_bookings",
      "meeting_notification_jobs",
      "provider_connections",
      "teams_notification_jobs",
      "teams_notification_targets",
      "microsoft_booking_health_checks",
    ]),
    consentRuntime: hasNoMissingTables(input, [
      "consent_records",
      "consent_policy_decisions",
      "newsletter_suppressions",
      "newsletter_sends",
    ]),
    customerAccess: hasNoMissingTables(input, [
      "customer_workspace_access",
      "customer_project_access",
      "customer_onboarding_risk_alerts",
      "project_pipeline_permissions",
    ]),
    funnelRuntime:
      isDatabaseModule(input, "funnels") &&
      isDatabaseModule(input, "funnelSteps") &&
      hasNoMissingTables(input, ["funnel_submissions", "forms", "form_submissions", "funnel_conversion_reports"]),
    inventory:
      isDatabaseModule(input, "propertyBuildings") &&
      isDatabaseModule(input, "propertyUnits") &&
      isDatabaseModule(input, "propertyReservations") &&
      hasViewingOfferRuntime,
    leadInbox:
      isDatabaseModule(input, "contacts") &&
      isDatabaseModule(input, "leads") &&
      isDatabaseModule(input, "tasks") &&
      hasNoMissingTables(input, [
        "speed_to_lead_events",
        "crm_follow_up_actions",
        "crm_outreach_deliveries",
        "data_quality_cleanup_actions",
        "crm_bulk_runtime_batches",
      ]),
    newsletters:
      isDatabaseModule(input, "newsletterSegments") &&
      isDatabaseModule(input, "newsletterCampaigns") &&
      hasNoMissingTables(input, ["newsletter_sends", "newsletter_suppressions"]),
    pipelines:
      isDatabaseModule(input, "deals") &&
      hasNoMissingTables(input, [
        "deal_stage_history",
        "project_pipeline_permissions",
        "pipeline_forecast_snapshots",
        "pipeline_bulk_actions",
      ]),
    sequences: hasNoMissingTables(input, [
      "sequence_definitions",
      "sequence_steps",
      "sequence_enrollments",
      "sequence_step_runs",
      "sequence_events",
      "sequence_runtime_reviews",
    ]),
  };

  const modules: CrmMaturityModule[] = [
    maturityModule({
      evidence: [
        signal(input.dataSource === "database" ? "data.liveDatabase" : "data.demoFallback"),
        signal("data.databaseModules", databaseModuleCount),
        signal("data.fallbackModules", fallbackModuleCount),
        signal("data.migrations", 1),
      ],
      id: "dataPersistence",
      missing:
        input.dataSource === "database" && missingTableCount === 0
          ? fallbackModuleCount > 0
            ? [signal("missing.optionalModuleFallbacks"), signal("missing.auditCoverage")]
            : hasPermissionAuditRuntime && hasRecommendationCompletionRuntime
              ? []
              : [
                  ...(!hasPermissionAuditRuntime ? [signal("missing.auditCoverage")] : []),
                  ...(!hasRecommendationCompletionRuntime ? [signal("missing.recommendationCompletionRun")] : []),
                ]
          : [
              signal("missing.persistentUi"),
              signal("missing.realApiWrites"),
              signal("missing.liveDatabase"),
              ...(missingTableCount > 0 ? [signal("missing.databaseTables", missingTableCount)] : []),
            ],
      nextStepId: hasProductionDataRisk
        ? "next.closePersistenceLoop"
        : hasRecommendationCompletionRuntime
          ? "next.auditCoverage"
          : "next.completeRecommendationRuntime",
      present: [
        signal("present.loaders"),
        signal("present.migrations"),
        signal("present.workspaceProjectIds"),
        ...(hasPermissionAuditRuntime ? [signal("present.permissionAuditRuntime")] : []),
        ...(hasRecommendationCompletionRuntime ? [signal("present.recommendationCompletionRuntime")] : []),
      ],
      risk: hasProductionDataRisk,
      score:
        input.dataSource === "database"
          ? fallbackModuleCount > 0 || missingTableCount > 0
            ? 11
            : hasPermissionAuditRuntime && hasRecommendationCompletionRuntime
              ? 15
              : hasPermissionAuditRuntime
                ? 14
                : 13
          : input.dataSource === "fallback"
            ? 8
            : 6,
      weight: 15,
    }),
    maturityModule({
      evidence: [
        signal("data.leads", input.leads.length),
        signal("data.contacts", input.contacts.length),
        signal("data.slaAlerts", input.speedToLeadAlerts.length),
      ],
      id: "leadInbox",
      missing:
        !hasFollowUpRuntime
          ? [signal("missing.manualFollowUpRuntime")]
          : overdueSla.length > 0
          ? [
              signal("missing.manualFollowUpRuntime"),
              ...(!hasBulkFollowUpRuntime ? [signal("missing.inboxBulkActions")] : []),
            ]
          : !hasCleanupWorkflow
            ? [signal("missing.dedupeMerge")]
            : !hasBulkFollowUpRuntime
              ? [signal("missing.inboxBulkActions")]
              : [],
      nextStepId: overdueSla.length > 0 ? "next.operationalFollowUps" : "next.leadInboxProductivity",
      present: [
        signal("present.leadScoring"),
        signal("present.contactContext"),
        signal("present.nextActions"),
        signal("present.speedToLeadEvents"),
        signal("present.ownerEscalation"),
        ...(hasFollowUpRuntime ? [signal("present.productiveFollowUps")] : []),
        ...(hasOutreachDeliveryRuntime ? [signal("present.outreachDeliveryRuntime")] : []),
        ...(hasCleanupWorkflow ? [signal("present.cleanupWorkflow")] : []),
        ...(hasBulkFollowUpRuntime ? [signal("present.bulkFollowUpRuntime")] : []),
      ],
      score: developmentReadiness.leadInbox ? 10 : input.leads.length > 0 && input.contacts.length > 0 ? 7 : 3,
      weight: 10,
    }),
    maturityModule({
      evidence: [signal("data.deals", input.deals.length), signal("data.stageHistoryMigration", 1)],
      id: "dealPipeline",
      missing: hasPipelineManagementRuntime
        ? []
        : [signal("missing.pipelineForecast"), signal("missing.pipelineBulkActions")],
      nextStepId: "next.pipelineManagementReporting",
      present: [
        signal("present.pipelineStages"),
        signal("present.dealRisk"),
        signal("present.dealOwnership"),
        signal("present.stageHistoryRuntime"),
        signal("present.lostReasons"),
        signal("present.pipelinePermissions"),
        ...(hasPermissionAuditRuntime ? [signal("present.permissionAuditRuntime")] : []),
        ...(hasPipelineManagementRuntime ? [signal("present.pipelineManagementRuntime")] : []),
      ],
      score: developmentReadiness.pipelines
        ? hasPipelineManagementRuntime
          ? 10
          : hasPermissionAuditRuntime
            ? 9
            : 8
        : input.deals.length > 0
          ? 7
          : 2,
      weight: 10,
    }),
    maturityModule({
      evidence: [signal("data.tasks", input.tasks.length), signal("data.leadSequences", input.leadSequences.length)],
      id: "tasksSequences",
      missing: hasSequenceRuntimeReviews
        ? []
        : [signal("missing.sequenceRuns"), signal("missing.stopRules"), signal("missing.followUpNotifications")],
      nextStepId: "next.persistSequenceRuns",
      present: [
        signal("present.tasks"),
        signal("present.sequenceTemplates"),
        signal("present.followUpLogic"),
        ...(hasSequenceRuntimeReviews ? [signal("present.sequenceRuntimeReviews")] : []),
      ],
      score: developmentReadiness.sequences && isDatabaseModule(input, "tasks")
        ? hasSequenceRuntimeReviews
          ? 8
          : 6
        : input.tasks.length > 0
          ? 5
          : 3,
      weight: 8,
    }),
    maturityModule({
      evidence: [signal("data.funnels", input.funnels.length), signal("data.activeFunnels", activeFunnels.length)],
      id: "funnelsForms",
      missing: hasFunnelConversionReports ? [] : [signal("missing.publishTokenUi"), signal("missing.conversionReporting")],
      nextStepId: "next.funnelOptimizationReporting",
      present: [
        signal("present.funnelBuilder"),
        signal("present.funnelMetrics"),
        signal("present.privacyControls"),
        signal("present.publicRenderer"),
        signal("present.funnelSubmissions"),
        signal("present.consentTracking"),
        ...(hasFunnelConversionReports ? [signal("present.funnelConversionReports")] : []),
      ],
      score: developmentReadiness.funnelRuntime
        ? hasFunnelConversionReports
          ? 10
          : 9
        : input.funnels.length > 0
          ? activeFunnels.length > 0
            ? 7
            : 5
          : 2,
      weight: 10,
    }),
    maturityModule({
      evidence: [
        signal("data.bots", input.bots.length),
        signal("data.approvedKnowledge", botGovernance.approvedKnowledgeItems),
        signal("data.botGovernanceScore", botGovernance.score),
        signal("data.botEvaluationReadiness", botGovernance.evaluationReadiness),
      ],
      id: "botGovernance",
      missing:
        botGovernance.evaluationReadiness >= 80
          ? hasBotAnswerChecks
            ? []
            : [signal("missing.botAnswerProtocolComparison")]
          : [signal("missing.botEvaluation"), signal("missing.redTeamTests"), signal("missing.sourceCoverage")],
      nextStepId:
        botGovernance.evaluationReadiness >= 80
          ? "next.botAnswerProtocolMetrics"
          : "next.hardenBotEvaluation",
      present: [
        signal("present.strictKnowledge"),
        signal("present.handoffRules"),
        signal("present.approvedKnowledge"),
        signal("present.governanceTestSet"),
        signal("present.redTeamEvaluation"),
        signal("present.botEvaluationUi"),
        ...(hasBotAnswerChecks ? [signal("present.botAnswerQualityChecks")] : []),
      ],
      risk:
        botGovernance.botsWithoutStrictKnowledge > 0 ||
        botGovernance.needsReviewKnowledgeItems > 0 ||
        (input.bots.length > 0 && botGovernance.evaluationReadiness < 80),
      score: developmentReadiness.botGovernance
        ? Math.max(9, Math.round((botGovernance.score / 100) * 10))
        : Math.max(4, Math.round((botGovernance.score / 100) * 10)),
      weight: 10,
    }),
    maturityModule({
      evidence: [signal("data.calendarEvents", input.calendarEvents.length), signal("data.teamsMeetings", microsoftEvents.length)],
      id: "calendarTeams",
      missing: hasMicrosoftBookingHealth
        ? []
        : [signal("missing.microsoftOAuth"), signal("missing.availability"), signal("missing.teamsNotifications")],
      nextStepId: "next.microsoftGraphBooking",
      present: [
        signal("present.calendarContext"),
        signal("present.teamsJoinUrl"),
        signal("present.meetingPreparation"),
        ...(hasMicrosoftBookingHealth ? [signal("present.microsoftBookingHealth")] : []),
      ],
      score: developmentReadiness.calendarTeams
        ? hasMicrosoftBookingHealth
          ? 8
          : microsoftEvents.length > 0
            ? 7
            : 6
        : microsoftEvents.length > 0
          ? 6
          : 2,
      weight: 8,
    }),
    maturityModule({
      evidence: [
        signal("data.newsletterSegments", input.newsletterSegments.length),
        signal("data.newsletterCampaigns", input.newsletterCampaigns.length),
        signal("data.suppressions", input.newsletterSuppressions.length),
      ],
      id: "newsletterConsent",
      missing: [signal("missing.doubleOptInConfirmationFlow"), signal("missing.capiWebhookConsentCoverage")],
      nextStepId: "next.consentCoverageReporting",
      present: [
        signal("present.segments"),
        signal("present.campaigns"),
        signal("present.suppressionList"),
        signal("present.consentRuntime"),
        signal("present.sendLogs"),
      ],
      risk: !developmentReadiness.consentRuntime,
      score:
        developmentReadiness.consentRuntime && developmentReadiness.newsletters
          ? 8
          : input.newsletterSegments.length > 0 && input.newsletterCampaigns.length > 0
            ? 6
            : 4,
      weight: 8,
    }),
    maturityModule({
      evidence: [signal("data.pipelineSignals", input.deals.length), signal("data.funnelSignals", input.funnels.length)],
      id: "analyticsAttribution",
      missing: hasRevenueCohortAnalytics
        ? []
        : hasConversionSnapshots
        ? [
            ...(!hasFunnelConversionReports ? [signal("missing.conversionReporting")] : []),
            ...(!hasPipelineManagementRuntime ? [signal("missing.salesVelocity")] : []),
            signal("missing.onboardingAnalytics"),
          ]
        : [signal("missing.closedRevenueAttribution"), signal("missing.onboardingAnalytics"), signal("missing.salesVelocity")],
      nextStepId: "next.completeRevenueAnalytics",
      present: [
        signal("present.dashboardKpis"),
        signal("present.funnelKpis"),
        signal("present.newsletterKpis"),
        signal("present.analyticsEventModel"),
        ...(hasConversionSnapshots ? [signal("present.conversionSnapshots")] : []),
        ...(hasFunnelConversionReports ? [signal("present.funnelConversionReports")] : []),
        ...(hasPipelineManagementRuntime ? [signal("present.pipelineForecastSnapshots")] : []),
      ],
      score: developmentReadiness.analytics
        ? hasRevenueCohortAnalytics
          ? 8
          : input.deals.length > 0 && input.funnels.length > 0
            ? 7
            : 6
        : 2,
      weight: 8,
    }),
    maturityModule({
      evidence: [signal("data.units", input.propertyUnits.length), signal("data.reservations", input.propertyReservations.length)],
      id: "developerInventory",
      missing:
        input.propertyUnits.length > 0
          ? reservationCoverage
            ? hasViewingOfferRuntime
              ? []
              : [signal("missing.viewingSlotsAndOfferMilestones")]
            : [signal("missing.reservationWorkflow")]
          : [signal("missing.unitsBoard"), signal("missing.reservationWorkflow"), signal("missing.contractMilestones")],
      nextStepId: reservationCoverage ? "next.viewingSlotsAndOfferMilestones" : "next.buildUnitsBoard",
      present: [
        signal("present.unitsBoard"),
        signal("present.projectSalesCockpit"),
        signal("present.unitLedger"),
        ...(reservationCoverage ? [signal("present.reservationWorkflow"), signal("present.contractMilestones")] : []),
        signal("present.reservationDeadlines"),
        signal("present.unitDealLinks"),
        ...(hasViewingOfferRuntime ? [signal("present.viewingOfferRuntime")] : []),
      ],
      score: developmentReadiness.inventory ? (reservationCoverage ? 8 : 7) : input.propertyUnits.length > 0 ? 5 : 1,
      weight: 8,
    }),
    maturityModule({
      evidence: [signal("data.customerWorkspaces", input.customerWorkspaces.length)],
      id: "novalureCustomerAccess",
      missing: hasOnboardingRiskAlerts
        ? []
        : [signal("missing.onboardingRiskAlerts"), signal("missing.customerSuccessAutomation")],
      nextStepId: "next.customerAccessAutomation",
      present: [
        signal("present.customerAccess"),
        signal("present.activationScore"),
        signal("present.onboardingAction"),
        signal("present.customerAccessCockpit"),
        signal("present.workspaceRoleRights"),
        signal("present.accessAudit"),
        ...(hasOnboardingRiskAlerts ? [signal("present.onboardingRiskAlerts")] : []),
        ...(hasPermissionAuditRuntime ? [signal("present.permissionAuditRuntime")] : []),
      ],
      score: developmentReadiness.customerAccess
        ? hasOnboardingRiskAlerts
          ? 5
          : customerAccessRisk
            ? 4
            : 5
        : input.customerWorkspaces.length > 0
          ? 3
          : 1,
      weight: 5,
    }),
  ];

  const missingItems: CrmMaturityAction[] = [
    ...(hasProductionDataRisk
      ? [{ audience: "both", effort: "medium", id: "remainingBrowserFallbacks", moduleId: "dataPersistence", priority: "p0" } as const]
      : []),
    ...(!hasFollowUpRuntime
      ? [{ audience: "both", effort: "medium", id: "productiveFollowUpActions", moduleId: "leadInbox", priority: "p1" } as const]
      : []),
    ...(!hasViewingOfferRuntime
      ? [
          { audience: "developer", effort: "medium", id: "viewingSlots", moduleId: "developerInventory", priority: "p1" } as const,
          { audience: "developer", effort: "medium", id: "priceBlockingAudit", moduleId: "developerInventory", priority: "p1" } as const,
        ]
      : []),
    ...(!hasRevenueCohortAnalytics
      ? [{ audience: "both", effort: "medium", id: "closedRevenueAttribution", moduleId: "analyticsAttribution", priority: "p1" } as const]
      : []),
    ...(!hasPipelineManagementRuntime
      ? [{ audience: "both", effort: "medium", id: "pipelineManagementReporting", moduleId: "dealPipeline", priority: "p1" } as const]
      : []),
    ...(!hasSequenceRuntimeReviews
      ? [{ audience: "both", effort: "medium", id: "sequenceRuntime", moduleId: "tasksSequences", priority: "p1" } as const]
      : []),
    ...(!hasFunnelConversionReports
      ? [{ audience: "both", effort: "medium", id: "funnelConversionReporting", moduleId: "funnelsForms", priority: "p1" } as const]
      : []),
    ...(!hasMicrosoftBookingHealth
      ? [{ audience: "both", effort: "medium", id: "microsoftBookingHealth", moduleId: "calendarTeams", priority: "p1" } as const]
      : []),
    ...(!hasOnboardingRiskAlerts
      ? [{ audience: "novalure", effort: "medium", id: "onboardingRiskAlerts", moduleId: "novalureCustomerAccess", priority: "p1" } as const]
      : []),
    ...(!developmentReadiness.consentRuntime
      ? [{ audience: "both", effort: "small", id: "consentCoverageReporting", moduleId: "newsletterConsent", priority: "p2" } as const]
      : []),
    ...(!hasCleanupWorkflow
      ? [{ audience: "both", effort: "small", id: "duplicateMergeWorkflow", moduleId: "leadInbox", priority: "p2" } as const]
      : []),
    ...(!hasPermissionAuditRuntime
      ? [{ audience: "both", effort: "medium", id: "modulePermissionAudit", moduleId: "novalureCustomerAccess", priority: "p2" } as const]
      : []),
  ];

  const nextSteps: CrmMaturityAction[] = [
    ...(!hasFollowUpRuntime
      ? [{ audience: "both", effort: "medium", id: "productiveFollowUpActions", moduleId: "leadInbox", priority: "p1" } as const]
      : []),
    ...(!hasViewingOfferRuntime
      ? [
          { audience: "developer", effort: "medium", id: "viewingSlots", moduleId: "developerInventory", priority: "p1" } as const,
          { audience: "developer", effort: "medium", id: "offerMilestones", moduleId: "developerInventory", priority: "p1" } as const,
        ]
      : []),
    ...(!hasRevenueCohortAnalytics
      ? [{ audience: "both", effort: "medium", id: "closedRevenueAttribution", moduleId: "analyticsAttribution", priority: "p1" } as const]
      : []),
    ...(!hasPipelineManagementRuntime
      ? [{ audience: "both", effort: "medium", id: "pipelineManagementReporting", moduleId: "dealPipeline", priority: "p1" } as const]
      : []),
    ...(!hasSequenceRuntimeReviews
      ? [{ audience: "both", effort: "medium", id: "sequenceRuntime", moduleId: "tasksSequences", priority: "p1" } as const]
      : []),
    ...(!hasFunnelConversionReports
      ? [{ audience: "both", effort: "medium", id: "funnelConversionReporting", moduleId: "funnelsForms", priority: "p1" } as const]
      : []),
    ...(!hasMicrosoftBookingHealth
      ? [{ audience: "both", effort: "medium", id: "microsoftBookingHealth", moduleId: "calendarTeams", priority: "p1" } as const]
      : []),
    ...(!hasOnboardingRiskAlerts
      ? [{ audience: "novalure", effort: "medium", id: "onboardingRiskAlerts", moduleId: "novalureCustomerAccess", priority: "p1" } as const]
      : []),
    ...(!hasBotAnswerChecks
      ? [{ audience: "both", effort: "small", id: "botAnswerProtocolMetrics", moduleId: "botGovernance", priority: "p2" } as const]
      : []),
    ...(!developmentReadiness.consentRuntime
      ? [{ audience: "both", effort: "small", id: "consentCoverageReporting", moduleId: "newsletterConsent", priority: "p2" } as const]
      : []),
    ...(!hasCleanupWorkflow
      ? [{ audience: "both", effort: "small", id: "duplicateMergeWorkflow", moduleId: "leadInbox", priority: "p2" } as const]
      : []),
    ...(!hasPermissionAuditRuntime
      ? [{ audience: "both", effort: "medium", id: "modulePermissionAudit", moduleId: "novalureCustomerAccess", priority: "p2" } as const]
      : []),
  ];

  const hasBotGovernanceRisk =
    botGovernance.botsWithoutStrictKnowledge > 0 ||
    botGovernance.needsReviewKnowledgeItems > 0 ||
    (input.bots.length > 0 && botGovernance.evaluationReadiness < 80);

  const risks: CrmMaturityRisk[] = [
    ...(input.dataSource === "mock"
      ? [{ id: "mockDataRisk", level: "high" as const, moduleId: "dataPersistence" as const }]
      : []),
    ...(!developmentReadiness.consentRuntime && blockedConsentDecisions.length > 0
      ? [{ id: "consentRuntimeRisk", level: "high" as const, moduleId: "newsletterConsent" as const }]
      : []),
    ...(hasBotGovernanceRisk
      ? [{ id: "botKnowledgeRisk", level: "high" as const, moduleId: "botGovernance" as const }]
      : []),
    ...(riskHygieneIssues.length > 0
      ? [{ id: "dataHygieneRisk", level: "medium" as const, moduleId: "leadInbox" as const }]
      : []),
    ...(customerAccessRisk
      ? [{ id: "customerAccessRisk", level: "medium" as const, moduleId: "novalureCustomerAccess" as const }]
      : []),
  ];

  return {
    missingItems,
    modules,
    nextSteps,
    risks,
    score: Math.round(modules.reduce((sum, item) => sum + item.score, 0)),
  };
}

export function buildAnalysisSprint(input: {
  bots: CrmBot[];
  calendarEvents: CalendarEvent[];
  consentDecisions: ConsentPolicyDecision[];
  customerWorkspaces: CustomerWorkspaceAccess[];
  dataHygieneIssues: DataHygieneIssue[];
  dataSource: CoreCrmModuleSource;
  deals: Deal[];
  funnels: Funnel[];
  knowledgeItems: KnowledgeItem[];
  leadSequences: LeadSequenceDefinition[];
  moduleSources?: CoreCrmModuleSources;
  newsletterCampaigns: NewsletterCampaign[];
  newsletterSegments: NewsletterSegment[];
  propertyReservations: PropertyReservation[];
  propertyUnits: PropertyUnit[];
  speedToLeadAlerts: SpeedToLeadAlert[];
  tasks: Task[];
}) {
  const overdueSla = input.speedToLeadAlerts.filter((alert) => alert.state === "overdue").length;
  const blockedConsentDecisions = input.consentDecisions.filter((decision) => !decision.allowed).length;
  const riskHygieneIssues = input.dataHygieneIssues.filter((issue) => issue.severity === "risk").length;
  const microsoftEvents = input.calendarEvents.filter(
    (event) => event.meetingProvider === "microsoft-teams" || event.teamsJoinUrl,
  ).length;
  const activeFunnels = input.funnels.filter((funnel) => funnel.status === "aktiv").length;
  const coreDatabaseCount = input.moduleSources
    ? productionModuleKeys.filter((key) => input.moduleSources?.[key] === "database").length
    : input.dataSource === "database"
      ? productionModuleKeys.length
      : 0;
  const productionDataScore =
    input.dataSource === "database"
      ? coreDatabaseCount === productionModuleKeys.length
        ? 10
        : 8
      : input.dataSource === "fallback"
        ? 5
        : 3;

  const moduleScores: Array<[SprintModuleId, number]> = [
    ["productionData", productionDataScore],
    ["speedToLead", input.speedToLeadAlerts.length > 0 ? (overdueSla > 0 ? 7 : 10) : 4],
    ["inventory", input.propertyUnits.length > 0 && input.propertyReservations.length > 0 ? 10 : 2],
    ["botGovernance", analyzeBotGovernance(input.bots, input.knowledgeItems, []).score >= 70 ? 8 : 5],
    ["consentGating", input.consentDecisions.length > 0 ? (blockedConsentDecisions > 0 ? 8 : 10) : 3],
    ["funnelRuntime", activeFunnels > 0 && input.leadSequences.length > 0 ? 7 : 4],
    ["novalureCockpit", input.customerWorkspaces.length > 0 ? 8 : 2],
    ["microsoft365", microsoftEvents > 0 ? 6 : 3],
    ["analytics", input.deals.length > 0 && input.newsletterCampaigns.length > 0 ? 7 : 4],
    ["roleHygiene", input.dataHygieneIssues.length > 0 ? (riskHygieneIssues > 0 ? 6 : 8) : 4],
  ];
  const modules = moduleScores.map(([id, score]) => ({
    id,
    score,
    status: moduleStatus(score),
  }));

  return {
    modules,
    score: modules.reduce((sum, module) => sum + module.score, 0),
    targetScore: TARGET_SCORE,
  };
}
