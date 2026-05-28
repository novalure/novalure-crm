import type { BotLanguageMode, LanguageCode } from "@/lib/i18n";
import type {
  CalendarProviderChoice,
  ProductRole,
  WorkspaceCustomerType,
  WorkspaceOperatingModel,
  WorkspaceTeamStructure,
} from "@/lib/product-model";

export type ID = string;

export type WorkspaceRole = "owner" | "admin" | "agent" | "assistant";

export type ProjectStatus = "Aktiv" | "Skaliert" | "Review" | "Archiviert";

export type OrganizationType =
  | "Privat"
  | "Immobilienagentur"
  | "Bauträger"
  | "Investmentgesellschaft"
  | "Hausverwaltung"
  | "Finanzierungspartner";

export type ContactRelationshipRole =
  | "Eigentümer"
  | "Miteigentümer"
  | "Käufer"
  | "Investor"
  | "Entscheider"
  | "Ansprechpartner"
  | "Finanzierer"
  | "Makler"
  | "Bauträger";

export const CRM_LEAD_SOURCES = [
  "Website Funnel",
  "Website",
  "willhaben",
  "ImmobilienScout",
  "Empfehlung",
  "WhatsApp",
  "Instagram",
  "Newsletter",
  "Manual",
] as const;

export type LeadSource = (typeof CRM_LEAD_SOURCES)[number];

export type LeadType = "Käufer" | "Verkäufer" | "Investor" | "Bauträger" | "Makler";

export type LeadStatus =
  | "Neu"
  | "Qualifizieren"
  | "Termin offen"
  | "Übergabe"
  | "Archiviert";

export type Region = "Wien" | "Steiermark" | "Tirol" | "Salzburg" | "Oberösterreich" | "Niederösterreich" | "Kärnten" | "Burgenland" | "Vorarlberg";

export type PropertyType = "Wohnung" | "Haus" | "Neubau" | "Zinshaus" | "Gewerbe" | "Grundstück" | "Portfolio";

export type FinancingStatus = "offen" | "vorqualifiziert" | "Eigenmittel" | "Finanzierungszusage";

export type DealStage =
  | "Neu"
  | "Qualifizieren"
  | "Termin vereinbaren"
  | "Termin gebucht"
  | "Besichtigung/Beratung"
  | "Beratung / Besichtigung"
  | "Besichtigung / Bewertung"
  | "Angebot/Reservierung"
  | "Reservierung"
  | "Angebot / Mandat"
  | "Abschlussprüfung"
  | "Abschlusspruefung"
  | "Vertragsprüfung"
  | "Vertragspruefung"
  | "Anfrage"
  | "Audit geplant"
  | "Angebot"
  | "Onboarding"
  | "Aktiv"
  | "Pausiert / Verloren"
  | "Gewonnen"
  | "Verloren"
  | "Disqualifiziert";

export type DealCloseReasonCategory =
  | "budget"
  | "timing"
  | "competitor"
  | "no_response"
  | "not_qualified"
  | "project_mismatch"
  | "duplicate"
  | "won"
  | "other";

export type TaskPriority = "Hoch" | "Mittel" | "Normal";

export type ConsentChannel = "Newsletter" | "WhatsApp" | "Instagram" | "Telefon" | "E-Mail";

export type ConsentStatus = "Opt-in" | "Opt-out" | "Nur CRM" | "Unbekannt";

export type ConversationChannel =
  | "WhatsApp"
  | "Instagram"
  | "Facebook Messenger"
  | "E-Mail"
  | "Telefon"
  | "Webchat"
  | "Website Bot";

export type Workspace = {
  id: ID;
  name: string;
  plan: string;
  activeProjects: number;
  activeUsers: number;
  activeCalendarProvider?: CalendarProviderChoice;
  customerType?: WorkspaceCustomerType;
  operatingModel?: WorkspaceOperatingModel;
  setupState?: Record<string, unknown>;
  teamStructure?: WorkspaceTeamStructure;
};

export type WorkspaceUser = {
  id: ID;
  workspaceId: ID;
  name: string;
  email: string;
  role: WorkspaceRole;
  productRole?: ProductRole;
  status: "active" | "invited";
};

export type Project = {
  id: ID;
  workspaceId: ID;
  name: string;
  type: string;
  leads: number;
  revenue: string;
  status: ProjectStatus;
  defaultPipelineId: ID;
  customerType?: WorkspaceCustomerType;
  defaultOperatingModel?: WorkspaceOperatingModel;
  setupDefaults?: ProjectSetupDefaults;
};

export type ProjectSetupDefaults = {
  calendarProvider?: CalendarProviderChoice;
  meetingProvider?: "microsoft-teams" | "google-meet" | "manual-link";
  teamStructure?: WorkspaceTeamStructure;
  [key: string]: unknown;
};

export type Contact = {
  id: ID;
  workspaceId: ID;
  projectId: ID;
  organizationId?: ID;
  name: string;
  role: LeadType;
  project: string;
  source: LeadSource;
  intent: string;
  consent: string;
  email?: string;
  phone?: string;
};

export type Organization = {
  id: ID;
  workspaceId: ID;
  projectId?: ID;
  name: string;
  type: OrganizationType;
  domain?: string;
  city: string;
  ownerUserId?: ID;
  openDeals: number;
  activeContacts: number;
  lifecycleStage: "Lead" | "Opportunity" | "Kunde" | "Partner";
  lastActivityAt: string;
};

export type ContactRelationship = {
  id: ID;
  workspaceId: ID;
  contactId: ID;
  organizationId?: ID;
  projectId?: ID;
  role: ContactRelationshipRole;
  influence: "hoch" | "mittel" | "niedrig";
  isPrimary: boolean;
};

export type ContactTimelineItem = {
  id: ID;
  workspaceId: ID;
  contactId: ID;
  projectId?: ID;
  organizationId?: ID;
  channel: ConversationChannel | "Microsoft 365" | "Aufgabe" | "Notiz" | "Deal";
  title: string;
  detail: string;
  occurredAt: string;
  outcome: "offen" | "erledigt" | "risiko" | "info";
};

export type Lead = {
  id: ID;
  workspaceId: ID;
  projectId: ID;
  contactId: ID;
  source: LeadSource;
  type: LeadType;
  status: LeadStatus;
  score: number;
  budget?: string;
  intent: string;
  nextAction: string;
  receivedAt: string;
  slaDueAt: string;
  lastContactAt?: string;
  nextContactAt?: string;
  region?: Region;
  objectType?: PropertyType;
  rooms?: number;
  areaSqm?: number;
  hotStatus?: boolean;
  buyerProfile?: {
    budgetFrom: number;
    budgetTo: number;
    financingStatus: FinancingStatus;
    desiredLocation?: string;
    mustHaveCriteria?: string[];
    niceToHaveCriteria?: string[];
    propertyType?: PropertyType;
    purchaseTimeline?: string;
    useCase: "Eigennutzung" | "Anlage";
  };
  sellerProfile?: {
    address: string;
    yearBuilt: number;
    marketValue: number;
    askingPrice: number;
    sellingReason: string;
    competingBroker: boolean;
    brokerContractStatus: "offen" | "in Verhandlung" | "aktiv" | "läuft aus";
    commissionRate: number;
    documentStatus?: string;
    expiringBrokerContractAt?: string;
    mandateStatus?: string;
    mandateType?: string;
    marketingStatus?: string;
    motivation?: string;
    objectCondition?: string;
    sellingTimeline?: string;
  };
  investorProfile?: {
    investmentVolumeFrom: number;
    investmentVolumeTo: number;
    grossYieldExpectation: number;
    netYieldExpectation: number;
    investmentType: "Anlegerwohnung" | "Zinshaus" | "Gewerbe" | "Portfolio";
    financingStatus: FinancingStatus;
    previousPurchases: number;
  };
  assignedToUserId?: ID;
};

export type BrokerMandate = {
  address: string;
  areaSqm?: number;
  askingPrice?: number;
  commissionRate?: number;
  condition?: string;
  contactId?: ID;
  documentsStatus?: string;
  expiringBrokerContractAt?: string;
  id: ID;
  location?: string;
  mandateStatus: string;
  mandateType?: string;
  marketValue?: number;
  marketingStatus?: string;
  metadata?: Record<string, unknown>;
  motivation?: string;
  projectId?: ID;
  propertyType?: PropertyType;
  rooms?: number;
  sellerLeadId?: ID;
  sellingReason?: string;
  sellingTimeline?: string;
  title: string;
  updatedAt: string;
  workspaceId: ID;
  yearBuilt?: number;
};

export type BuyerSearchProfile = {
  areaSqm?: number;
  budgetFrom?: number;
  budgetTo?: number;
  buyerLeadId?: ID;
  contactId?: ID;
  desiredLocation?: string;
  financingStatus?: FinancingStatus;
  id: ID;
  matchingStatus: string;
  metadata?: Record<string, unknown>;
  mustHaveCriteria: string[];
  niceToHaveCriteria: string[];
  projectId?: ID;
  propertyType?: PropertyType;
  purchaseTimeline?: string;
  rooms?: number;
  title: string;
  updatedAt: string;
  workspaceId: ID;
};

export type CrmPipeline = {
  customerType?: WorkspaceCustomerType;
  id: ID;
  isDefault: boolean;
  key: string;
  metadata?: Record<string, unknown>;
  name: string;
  operatingModel?: WorkspaceOperatingModel;
  projectId?: ID;
  purpose: string;
  workspaceId: ID;
};

export type CrmPipelineStage = {
  category: string;
  id: ID;
  key: string;
  metadata?: Record<string, unknown>;
  name: string;
  pipelineId: ID;
  position: number;
  probability: number;
  projectId?: ID;
  slaHours?: number;
  workspaceId: ID;
};

export type ProjectPipelinePermission = {
  canCloseDeals: boolean;
  canEditDeals: boolean;
  canMoveDeals: boolean;
  canReopenDeals: boolean;
  id: ID;
  metadata?: Record<string, unknown>;
  productRole?: ProductRole;
  projectId: ID;
  updatedAt?: string;
  userEmail?: string;
  userId: ID;
  userName?: string;
  userRole?: WorkspaceRole;
  workspaceId: ID;
};

export type EditorPreflightType = "newsletter" | "bot" | "funnel" | "calendar";
export type EditorPreflightStatus = "pass" | "warning" | "blocked";

export type EditorPreflightCheck = {
  id: string;
  label: string;
  message: string;
  required: boolean;
  status: EditorPreflightStatus;
};

export type EditorPreflightRun = {
  blockers: string[];
  checks: EditorPreflightCheck[];
  createdAt: string;
  editorType: EditorPreflightType;
  entityId?: string;
  id: ID;
  metadata?: Record<string, unknown>;
  projectId?: ID;
  status: EditorPreflightStatus;
  warnings: string[];
  workspaceId: ID;
};

export type SellerListing = {
  id: ID;
  workspaceId: ID;
  projectId: ID;
  sellerLeadId: ID;
  title: string;
  address: string;
  region: Region;
  objectType: PropertyType;
  areaSqm: number;
  rooms?: number;
  yearBuilt: number;
  marketValue: number;
  targetPrice: number;
  expectedGrossYield?: number;
  mandateEndsAt?: string;
  createdAt: string;
};

export type PropertyUnitStatus = "available" | "reserved" | "sold" | "blocked";

export type PropertyBuilding = {
  id: ID;
  workspaceId: ID;
  projectId: ID;
  name: string;
  address: string;
  completionDate: string;
  floors: number;
};

export type PropertyUnit = {
  id: ID;
  workspaceId: ID;
  projectId: ID;
  buildingId: ID;
  unitNumber: string;
  floor: number;
  rooms: number;
  areaSqm: number;
  priceCents: number;
  status: PropertyUnitStatus;
  buyerContactId?: ID;
  dealId?: ID;
  reservationId?: ID;
  updatedAt: string;
};

export type PropertyReservationStatus = "hold" | "reserved" | "expired" | "converted";

export type PropertyReservation = {
  id: ID;
  workspaceId: ID;
  projectId: ID;
  unitId: ID;
  contactId: ID;
  dealId?: ID;
  status: PropertyReservationStatus;
  expiresAt: string;
  depositCents: number;
  contractMilestone:
    | "not_started"
    | "offer_sent"
    | "financing_check"
    | "contract_draft"
    | "signed";
  nextAction: string;
};

export type CustomerWorkspaceAccessStatus =
  | "lead"
  | "demo"
  | "trial"
  | "onboarding"
  | "active"
  | "risk";

export type CustomerWorkspaceAccess = {
  id: ID;
  workspaceId: ID;
  organizationId: ID;
  projectId?: ID;
  customerName: string;
  ownerUserId: ID;
  status: CustomerWorkspaceAccessStatus;
  plan: string;
  invitedUsers: number;
  activeUsers: number;
  activationScore: number;
  health: "healthy" | "attention" | "risk";
  lastCustomerActivityAt: string;
  nextOnboardingAction: string;
  risks: string[];
};

export type Deal = {
  closedAt?: string;
  id: ID;
  workspaceId: ID;
  projectId: ID;
  contactId: ID;
  organizationId?: ID;
  ownerUserId?: ID;
  leadId?: ID;
  name: string;
  stage: DealStage;
  value: string;
  probability: number;
  expectedCloseDate: string;
  riskLevel: "niedrig" | "mittel" | "hoch";
  source: LeadSource;
  lostReasonCategory?: DealCloseReasonCategory;
  lostReasonDetail?: string;
  lostAt?: string;
  nextAction: string;
};

export type DealStageHistoryEntry = {
  changedAt: string;
  changedByName?: string;
  changedByUserId?: ID;
  dealId: ID;
  fromStage?: DealStage;
  id: ID;
  projectId?: ID;
  reason?: string;
  reasonCategory?: DealCloseReasonCategory;
  reasonDetail?: string;
  toStage: DealStage;
  workspaceId: ID;
};

export type PipelineStage = {
  title: DealStage;
  total: number;
  value: string;
  cards: Array<{
    name: string;
    label: string;
    detail: string;
    next: string;
    score: number;
  }>;
};

export type Task = {
  id: ID;
  workspaceId: ID;
  projectId: ID;
  contactId?: ID;
  leadId?: ID;
  ownerUserId?: ID;
  title: string;
  description?: string;
  project: string;
  due: string;
  priority: TaskPriority;
  status: "open" | "done";
};

export type CalendarEvent = {
  id: ID;
  workspaceId: ID;
  projectId: ID;
  contactId?: ID;
  leadId?: ID;
  title: string;
  startsAt: string;
  endsAt: string;
  location: "Teams" | "Google Meet" | "Vor Ort" | "Telefon" | "Extern";
  status: "geplant" | "vorbereiten" | "bestätigt" | "nachfassen";
  preparation: string[];
  outcomeGoal: string;
  notes?: string;
  ownerUserId?: ID;
  calendarProvider?: "microsoft" | "google" | "manual";
  externalCalendarId?: string;
  googleMeetJoinUrl?: string;
  meetingProvider?: "microsoft-teams" | "google-meet" | "manual-link" | "phone";
  teamsJoinUrl?: string;
};

export type FunnelChannel =
  | "Website"
  | "Landingpage"
  | "WhatsApp"
  | "Instagram"
  | "Newsletter";

export type Funnel = {
  id: ID;
  workspaceId: ID;
  projectId: ID;
  name: string;
  goal: string;
  audience: LeadType;
  entryChannel: FunnelChannel;
  status: "aktiv" | "optimieren" | "entwurf";
  visits: number;
  leads: number;
  conversionRate: number;
  ownerUserId?: ID;
};

export type FunnelStep = {
  id: ID;
  workspaceId: ID;
  projectId: ID;
  funnelId: ID;
  name: string;
  channel: FunnelChannel;
  status: "aktiv" | "prüfen" | "blockiert" | "entwurf";
  visits: number;
  leads: number;
  conversionRate: number;
  dropOffReason: string;
  nextOptimization: string;
  botRuleId?: ID;
};

export type NewsletterSegment = {
  id: ID;
  workspaceId: ID;
  projectId?: ID;
  name: string;
  audience: LeadType | "Alle";
  language: LanguageCode;
  source: "CRM" | "Funnel" | "Resend";
  contacts: number;
  optIns: number;
  health: "bereit" | "prüfen" | "wachstum";
  rules: string[];
  resendAudienceId?: string;
};

export type NewsletterCampaign = {
  id: ID;
  workspaceId: ID;
  projectId?: ID;
  segmentId: ID;
  templateId?: ID;
  name: string;
  fromName?: string;
  fromEmail?: string;
  replyTo?: string;
  subject: string;
  previewText: string;
  status: "entwurf" | "geplant" | "bereit" | "gesendet";
  goal: string;
  recipients: number;
  sendAt?: string;
  openRate?: number;
  clickRate?: number;
  bounceRate?: number;
  unsubscribeRate?: number;
  abTest?: {
    variantA: string;
    variantB: string;
    testSizePercent: number;
    winnerMetric: "open" | "click";
  };
  utmCampaign?: string;
  contentBlocks: string[];
  ownerUserId?: ID;
};

export type NewsletterTemplate = {
  id: ID;
  workspaceId: ID;
  name: string;
  category: "Projektupdate" | "Bewertung" | "Investment" | "Reaktivierung";
  language: LanguageCode;
  status: "bereit" | "entwurf";
  subjectPattern: string;
  previewPattern: string;
  blocks: string[];
  personalizationFields: string[];
};

export type NewsletterAutomation = {
  id: ID;
  workspaceId: ID;
  projectId?: ID;
  name: string;
  trigger: string;
  segmentId: ID;
  status: "aktiv" | "pausiert" | "entwurf";
  steps: Array<{
    delay: string;
    channel: "Email" | "Aufgabe" | "WhatsApp";
    action: string;
  }>;
  goal: string;
};

export type LeadSequenceChannel =
  | "email"
  | "whatsapp"
  | "task"
  | "call"
  | "teams"
  | "calendar";

export type LeadSequenceTrigger =
  | "contact_created"
  | "funnel_submitted"
  | "document_sent"
  | "document_opened"
  | "meeting_booked"
  | "no_reply";

export type LeadSequenceOwnerMode =
  | "contact_owner"
  | "project_owner"
  | "team_rotation"
  | "manual";

export type LeadSequenceStopRule =
  | "reply_received"
  | "meeting_booked"
  | "opt_out"
  | "bounce"
  | "deal_won"
  | "deal_lost"
  | "manual_pause";

export type LeadSequenceCondition =
  | "always"
  | "high_score"
  | "document_opened"
  | "document_not_opened"
  | "no_reply"
  | "whatsapp_allowed"
  | "email_available"
  | "meeting_not_booked";

export type LeadSequenceStep = {
  id: ID;
  sequenceId: ID;
  position: number;
  title: string;
  delayLabel: string;
  delayHours: number;
  channel: LeadSequenceChannel;
  action: string;
  ownerMode: LeadSequenceOwnerMode;
  conditions: LeadSequenceCondition[];
  stopRules: LeadSequenceStopRule[];
  templateSubject?: string;
  templateBody?: string;
  taskPriority?: TaskPriority;
};

export type LeadSequenceDefinition = {
  id: ID;
  workspaceId: ID;
  projectId?: ID;
  name: string;
  audience: LeadType | "Alle";
  goal: string;
  trigger: LeadSequenceTrigger;
  status: "active" | "paused" | "draft";
  businessHours: string;
  maxTouchpoints14Days: number;
  minHoursBetweenTouches: number;
  steps: LeadSequenceStep[];
};

export type LeadSequenceEvent = {
  id: ID;
  workspaceId: ID;
  projectId?: ID;
  contactId?: ID;
  leadId?: ID;
  sequenceId?: ID;
  stepId?: ID;
  type:
    | "document_sent"
    | "document_opened"
    | "email_sent"
    | "email_bounced"
    | "reply_received"
    | "meeting_booked"
    | "opt_out"
    | "task_created"
    | "manual_pause"
    | "deal_stage_changed";
  occurredAt: string;
  detail: string;
};

export type NewsletterDeliverability = {
  id: ID;
  workspaceId: ID;
  domain: string;
  fromEmail: string;
  status: "bereit" | "prüfen" | "blockiert";
  spf: "ok" | "prüfen";
  dkim: "ok" | "prüfen";
  dmarc: "ok" | "prüfen";
  bounceRate: number;
  complaintRate: number;
  reputationScore: number;
};

export type NewsletterSuppression = {
  id: ID;
  workspaceId: ID;
  email: string;
  reason: "unsubscribe" | "bounce" | "complaint" | "manual";
  source: string;
  capturedAt: string;
};

export type ConsentRecord = {
  id: ID;
  workspaceId: ID;
  contactId: ID;
  projectId?: ID;
  channel: ConsentChannel;
  status: ConsentStatus;
  source: string;
  capturedAt: string;
};

export type Conversation = {
  id: ID;
  workspaceId: ID;
  projectId: ID;
  contactId: ID;
  leadId?: ID;
  channel: ConversationChannel;
  direction: "inbound" | "outbound";
  summary: string;
  sentiment: "hot" | "warm" | "neutral" | "risk";
  lastMessageAt: string;
};

export type KnowledgeItem = {
  id: ID;
  workspaceId: ID;
  projectId: ID;
  name: string;
  items: number;
  coverage: string;
  status: "approved" | "needs-review";
};

export type Automation = {
  id: ID;
  workspaceId: ID;
  projectId?: ID;
  name: string;
  channel: string;
  status: "Bereit" | "Training" | "Verbinden" | "Geplant";
  detail: string;
};

export type CrmBotStatus = "draft" | "test" | "active" | "paused" | "error";

export type CrmBotRole =
  | "support_agent"
  | "sales_qualifier"
  | "appointment_agent"
  | "ticket_triage_agent"
  | "crm_data_agent"
  | "onboarding_agent";

export type CrmBotRiskLevel = "low" | "medium" | "high";

export type CrmBotTool = {
  id: ID;
  name: string;
  description: string;
  riskLevel: CrmBotRiskLevel;
  requiresHumanApproval: boolean;
  auditLogEnabled: boolean;
  enabled: boolean;
};

export type CrmBotModelConfig = {
  primaryModel: string;
  fallbackModel: string;
  temperature: number;
  maxSteps: number;
  costTag: string;
};

export type CrmBotChannelConfig = {
  id: ID;
  channel: ConversationChannel | "Email" | "API/Webhook" | "Slack/Teams" | "Voice";
  active: boolean;
  complianceNote?: string;
  greetingEn: string;
  greetingDe: string;
  handoffRules: string[];
  inboundMode?: string;
  outboundMode?: string;
  businessHours: string;
  language: LanguageCode | "auto";
  provider?: string;
  setupStatus?: "not_connected" | "ready" | "connected" | "needs_review" | "error";
  setupSteps?: string[];
  targetTeam: string;
  webhookPath?: string;
};

export type CrmBotConversationMessage = {
  id: ID;
  role: "user" | "assistant" | "tool";
  content: string;
  createdAt: string;
};

export type CrmBotConversation = {
  id: ID;
  workspaceId: ID;
  projectId?: ID;
  botId: ID;
  contactId?: ID;
  title: string;
  status: "open" | "handoff" | "resolved";
  updatedAt: string;
  messages: CrmBotConversationMessage[];
};

export type CrmBot = {
  id: ID;
  workspaceId: ID;
  projectId?: ID;
  name: string;
  description: string;
  role: CrmBotRole;
  status: CrmBotStatus;
  audience: string;
  language: LanguageCode | "auto";
  tone: string;
  answerLength: "short" | "normal" | "detailed";
  brandVoice: string;
  strictKnowledge: boolean;
  modelConfig: CrmBotModelConfig;
  channels: CrmBotChannelConfig[];
  actionPolicies?: Array<{
    action: string;
    approval: "audit" | "optional" | "required";
    rule: string;
  }>;
  documentLibrary?: Array<{
    approvalRequired: boolean;
    id: ID;
    name: string;
    status: "approved" | "needs_review" | "draft";
    type: "expose" | "offer" | "pdf" | "checklist";
  }>;
  setupChecklist?: Array<{
    done: boolean;
    label: string;
    owner: "customer" | "admin" | "team";
  }>;
  tools: CrmBotTool[];
  createdAt: string;
  updatedAt: string;
};

export type RagKnowledgeChunk = {
  id: ID;
  sourceId: ID;
  chunkIndex: number;
  content: string;
  tokenCount: number;
  citationTitle: string;
  citationUrl?: string;
  embeddingReady: boolean;
};

export type RagSearchResult = {
  chunkId: ID;
  title: string;
  excerpt: string;
  citationUrl?: string;
  score: number;
};

export type BotEvaluationCaseKind = "allowed" | "unknown" | "prompt_injection" | "risky";

export type BotEvaluationCaseResult = {
  citationsRequired: boolean;
  expected: "answer_with_citation" | "refuse" | "handoff";
  id: ID;
  kind: BotEvaluationCaseKind;
  passed: boolean;
  prompt: string;
  result: "answered" | "refused" | "handoff";
  riskFlags: string[];
  sourceCount: number;
  citationCount: number;
};

export type BotEvaluationRun = {
  id: ID;
  workspaceId: ID;
  projectId?: ID;
  botId?: ID;
  score: number;
  sourceCoverage: number;
  hallucinationFailures: number;
  handoffFailures: number;
  redTeamFailures: number;
  testSetVersion: string;
  cases: BotEvaluationCaseResult[];
  createdAt: string;
};

export type BotLeadWorkflowStep =
  | "capture"
  | "research"
  | "qualify"
  | "capture_contact"
  | "send_document"
  | "book_meeting"
  | "draft_email"
  | "human_approval"
  | "create_deal"
  | "handoff";

export type BotLeadWorkflow = {
  id: ID;
  workspaceId: ID;
  projectId?: ID;
  name: string;
  trigger: "funnel_submit" | "chat_qualified" | "webhook" | "manual";
  steps: BotLeadWorkflowStep[];
  humanApprovalRequired: boolean;
  active: boolean;
  runsToday: number;
  approvalQueue: number;
  lastRunAt: string;
  resultPreview: {
    qualification: "qualified" | "follow_up" | "support" | "nurture" | "disqualified";
    score: number;
    researchBrief: string;
    nextAction: string;
    emailSubject: string;
  };
};

export type BotCallInsight = {
  id: ID;
  workspaceId: ID;
  projectId?: ID;
  contactId?: ID;
  botId: ID;
  source: "Gong" | "Zoom" | "Google Meet" | "Upload" | "Manual";
  summary: string;
  sentiment: "positive" | "neutral" | "critical" | "high_interest";
  objections: string[];
  actionItems: Array<{
    title: string;
    owner: string;
    priority: "low" | "normal" | "high";
  }>;
  dealSignals: string[];
  knowledgeGaps: string[];
  requiresApproval: boolean;
  createdAt: string;
};

export type BotChannel = "WhatsApp" | "Instagram" | "Website Bot" | "Newsletter";

export type BotLanguageRule = {
  id: ID;
  workspaceId: ID;
  projectId?: ID;
  channel: BotChannel;
  mode: BotLanguageMode;
  fallbackLanguage: LanguageCode;
  fixedLanguage?: LanguageCode;
  detectionSignals: Array<"browser" | "chat" | "form" | "profile" | "workspace">;
  confidence: number;
  promptRule: string;
};
