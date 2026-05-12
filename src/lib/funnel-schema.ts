import type { FunnelChannel, ID, LeadType } from "@/lib/crm-types";

export const funnelSchemaVersion = 1;

export type FunnelRenderMode = "edit" | "preview" | "live" | "test";
export type FunnelDevice = "desktop" | "tablet" | "mobile";

export type FunnelFieldType =
  | "text"
  | "textarea"
  | "email"
  | "phone"
  | "url"
  | "number"
  | "date"
  | "time"
  | "singleChoice"
  | "multiChoice"
  | "dropdown"
  | "slider"
  | "rating"
  | "file"
  | "consent"
  | "hidden"
  | "custom";

export const funnelFieldTypes: Array<{ id: FunnelFieldType; label: string }> = [
  { id: "text", label: "Text" },
  { id: "textarea", label: "Textarea" },
  { id: "email", label: "E-Mail" },
  { id: "phone", label: "Telefon" },
  { id: "url", label: "URL" },
  { id: "number", label: "Zahl" },
  { id: "date", label: "Datum" },
  { id: "time", label: "Zeit" },
  { id: "singleChoice", label: "Single-Choice" },
  { id: "multiChoice", label: "Multi-Choice" },
  { id: "dropdown", label: "Dropdown" },
  { id: "slider", label: "Slider / Range" },
  { id: "rating", label: "Rating" },
  { id: "file", label: "Datei-Upload" },
  { id: "consent", label: "DSGVO Consent" },
  { id: "hidden", label: "Hidden Field" },
  { id: "custom", label: "Custom-Feld" },
];

export type FunnelBreakpointValue<T> = {
  desktop?: T;
  tablet?: T;
  mobile?: T;
};

export type FunnelTheme = {
  id: ID;
  name: string;
  fontFamily: "system" | "modern" | "editorial" | "serif";
  colors: {
    background: string;
    text: string;
    accent: string;
    muted: string;
  };
  radii: {
    button: number;
    block: number;
  };
  spacing: FunnelBreakpointValue<number>;
  logoText: string;
  faviconUrl?: string;
  customCss?: string;
};

export type FunnelField = {
  id: ID;
  type: FunnelFieldType;
  crmField: string;
  label: string;
  placeholder?: string;
  defaultValue?: string;
  required: boolean;
  validationPattern?: string;
  errorMessage?: string;
  helpText?: string;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  fileTypes?: string[];
  maxFileSizeMb?: number;
  hiddenValueSource?: "static" | "utm" | "urlParam" | "system";
};

export type FunnelElementType =
  | "headline"
  | "text"
  | "button"
  | "image"
  | "video"
  | "form"
  | "choice"
  | "calendar"
  | "html"
  | "spacer"
  | "countdown"
  | "testimonial";

export type FunnelElement = {
  id: ID;
  type: FunnelElementType;
  name: string;
  content?: string;
  richText?: unknown;
  url?: string;
  alt?: string;
  ctaLabel?: string;
  fields?: FunnelField[];
  options?: string[];
  score?: number;
  required?: boolean;
  crmField?: string;
  analyticsEvent?: string;
  visibility?: {
    desktop: boolean;
    tablet: boolean;
    mobile: boolean;
  };
  styles?: {
    align?: "left" | "center" | "right";
    padding?: FunnelBreakpointValue<number>;
    margin?: FunnelBreakpointValue<number>;
    background?: string;
    textColor?: string;
    borderColor?: string;
    borderWidth?: number;
    borderRadius?: number;
  };
  condition?: FunnelRuleGroup;
};

export type FunnelColumn = {
  id: ID;
  width: FunnelBreakpointValue<number>;
  elements: FunnelElement[];
};

export type FunnelRow = {
  id: ID;
  columns: FunnelColumn[];
};

export type FunnelSection = {
  id: ID;
  name: string;
  rows: FunnelRow[];
  styles?: {
    background?: string;
    padding?: FunnelBreakpointValue<number>;
  };
};

export type FunnelPage = {
  id: ID;
  name: string;
  slug: string;
  kind: "landing" | "step" | "result" | "thankYou";
  sections: FunnelSection[];
};

export type FunnelRuleOperator =
  | "equals"
  | "notEquals"
  | "contains"
  | "greaterThan"
  | "lessThan"
  | "exists";

export type FunnelRule = {
  id: ID;
  field: string;
  operator: FunnelRuleOperator;
  value?: string | number | boolean;
};

export type FunnelRuleGroup = {
  id: ID;
  mode: "and" | "or";
  rules: Array<FunnelRule | FunnelRuleGroup>;
};

export type FunnelVariant = {
  id: ID;
  name: string;
  trafficPercent: number;
  visits?: number;
  conversions?: number;
  pageOverrides?: Partial<Record<ID, Partial<FunnelPage>>>;
};

export type FunnelMediaAsset = {
  id: ID;
  name: string;
  type: "image" | "video" | "icon" | "document";
  url: string;
  folder: string;
  alt?: string;
  createdAt: string;
};

export type FunnelVersion = {
  id: ID;
  label: string;
  createdAt: string;
  blueprint: FunnelBlueprint;
};

export type FunnelTrackingConfig = {
  metaPixelId?: string;
  metaCapiToken?: string;
  gaMeasurementId?: string;
  gtmId?: string;
  matomoSiteId?: string;
  consentMode: "internal" | "ready" | "active";
  webhookUrl?: string;
};

export type FunnelCrmHandover = {
  destination: "leadInbox" | "pipeline" | "calendar" | "newsletter";
  pipelineStage: string;
  statusTemplate: string;
  qualityRule: string;
  notificationRecipients: string;
  followUp: string;
  createLeadInboxEntry: boolean;
  createTask: boolean;
  createAppointment: boolean;
};

export type FunnelBlueprint = {
  schemaVersion: typeof funnelSchemaVersion;
  id: ID;
  workspaceId: ID;
  projectId: ID;
  name: string;
  goal: string;
  audience: LeadType;
  entryChannel: FunnelChannel;
  status: "aktiv" | "optimieren" | "entwurf";
  theme: FunnelTheme;
  pages: FunnelPage[];
  variants: FunnelVariant[];
  tracking: FunnelTrackingConfig;
  crmHandover: FunnelCrmHandover;
  mediaLibrary?: FunnelMediaAsset[];
  createdFrom: "crm-data" | "editor-draft";
};

export type FunnelSubmissionPayload = {
  funnelId: ID;
  mode: "test" | "live";
  answers: Record<string, string | string[] | boolean | number | null>;
  visitor: {
    id?: string;
    userAgent?: string;
    sourceUrl?: string;
  };
  consent: {
    analytics: boolean;
    marketing: boolean;
    privacy: boolean;
  };
  utm?: Record<string, string>;
};

export function getDeviceValue<T>(value: FunnelBreakpointValue<T> | undefined, device: FunnelDevice, fallback: T): T {
  return value?.[device] ?? value?.desktop ?? value?.tablet ?? value?.mobile ?? fallback;
}

export function normalizeFieldName(label: string) {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_|_$/g, "");
}
