import type { BotLanguageMode, LanguageCode } from "@/lib/i18n";

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

export type LeadSource =
  | "Website Funnel"
  | "WhatsApp"
  | "Instagram"
  | "Newsletter"
  | "Microsoft 365"
  | "willhaben"
  | "ImmobilienScout"
  | "Empfehlung"
  | "Website"
  | "Manual";

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
  | "Neuer Lead"
  | "Qualifiziert"
  | "Termin gebucht"
  | "Besichtigung"
  | "Abschluss";

export type TaskPriority = "Hoch" | "Mittel" | "Normal";

export type ConsentChannel = "Newsletter" | "WhatsApp" | "Instagram" | "Telefon" | "E-Mail";

export type ConsentStatus = "Opt-in" | "Opt-out" | "Nur CRM" | "Unbekannt";

export type ConversationChannel = "WhatsApp" | "Instagram" | "E-Mail" | "Telefon" | "Website Bot";

export type Workspace = {
  id: ID;
  name: string;
  plan: string;
  activeProjects: number;
  activeUsers: number;
};

export type WorkspaceUser = {
  id: ID;
  workspaceId: ID;
  name: string;
  email: string;
  role: WorkspaceRole;
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

export type Deal = {
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
  nextAction: string;
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
  title: string;
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
  location: "Teams" | "Vor Ort" | "Telefon" | "Extern";
  status: "geplant" | "vorbereiten" | "bestätigt" | "nachfassen";
  preparation: string[];
  outcomeGoal: string;
  ownerUserId?: ID;
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
