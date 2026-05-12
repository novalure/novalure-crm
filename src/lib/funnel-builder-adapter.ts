import type { Funnel, FunnelStep, Project, WorkspaceUser } from "@/lib/crm-types";
import {
  funnelSchemaVersion,
  normalizeFieldName,
  type FunnelBlueprint,
  type FunnelCrmHandover,
  type FunnelElement,
  type FunnelField,
  type FunnelPage,
  type FunnelTheme,
  type FunnelTrackingConfig,
} from "@/lib/funnel-schema";

export type FunnelDraft = Funnel & {
  brandPreset?: string;
  highlightColor?: string;
  customDomain?: string;
  headerMode?: "Logo" | "Navigation" | "Minimal";
  landingPageBlocks?: string[];
  designerHeroTitle?: string;
  designerHeroSubtitle?: string;
  designerCtaLabel?: string;
  designerLogoText?: string;
  designerBackgroundColor?: string;
  designerTextColor?: string;
  designerBlockText?: string;
  designerFontPreset?: "System" | "Editorial" | "Modern" | "Serif";
  designerButtonRadius?: string;
  designerBlockRadius?: string;
  designerSectionSpacing?: string;
  leadDestination?: "Lead Inbox" | "Pipeline" | "Kalender" | "Newsletter Segment";
  crmStage?: string;
  statusTemplate?: string;
  leadQualityRule?: string;
  notificationRecipients?: string;
  followUp?: string;
  triggerLeadInbox?: boolean;
  triggerTask?: boolean;
  triggerAppointment?: boolean;
  metaPixelId?: string;
  metaCapiToken?: string;
  gaMeasurementId?: string;
  gtmId?: string;
  matomoSiteId?: string;
  consentMode?: "intern" | "bereit" | "aktiv";
  webhookUrl?: string;
};

export type FunnelStepDraft = FunnelStep & {
  type?: string;
  question?: string;
  options?: string[];
  score?: number;
  required?: boolean;
  crmField?: string;
  analyticsEvent?: string;
};

type BuildFunnelBlueprintInput = {
  funnel: FunnelDraft;
  project?: Project;
  owner?: WorkspaceUser;
  steps: FunnelStepDraft[];
};

const defaultBlocks = ["Hero", "Vorteile", "Kontaktformular", "Kalender"];

function numberFromString(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function mapFont(value: FunnelDraft["designerFontPreset"]): FunnelTheme["fontFamily"] {
  if (value === "Editorial") return "editorial";
  if (value === "Modern") return "modern";
  if (value === "Serif") return "serif";
  return "system";
}

function mapDestination(value: FunnelDraft["leadDestination"]): FunnelCrmHandover["destination"] {
  if (value === "Pipeline") return "pipeline";
  if (value === "Kalender") return "calendar";
  if (value === "Newsletter Segment") return "newsletter";
  return "leadInbox";
}

function mapConsentMode(value: FunnelDraft["consentMode"]): FunnelTrackingConfig["consentMode"] {
  if (value === "aktiv") return "active";
  if (value === "bereit") return "ready";
  return "internal";
}

function buildTheme(funnel: FunnelDraft): FunnelTheme {
  return {
    id: `${funnel.id}_theme`,
    name: funnel.brandPreset ?? "Projekt-Branding",
    fontFamily: mapFont(funnel.designerFontPreset),
    colors: {
      background: funnel.designerBackgroundColor ?? "#ffffff",
      text: funnel.designerTextColor ?? "#020617",
      accent: funnel.highlightColor ?? "#047857",
      muted: "#f5f5f4",
    },
    radii: {
      button: numberFromString(funnel.designerButtonRadius, 8),
      block: numberFromString(funnel.designerBlockRadius, 8),
    },
    spacing: {
      desktop: numberFromString(funnel.designerSectionSpacing, 16),
      tablet: numberFromString(funnel.designerSectionSpacing, 16),
      mobile: Math.max(12, numberFromString(funnel.designerSectionSpacing, 16) - 4),
    },
    logoText: funnel.designerLogoText ?? funnel.name.split(" ")[0] ?? "Novalure",
  };
}

function buildDefaultContactFields(source: { id: string }): FunnelField[] {
  return [
    {
      id: `${source.id}_field_name`,
      type: "text",
      crmField: "name",
      label: "Name",
      placeholder: "Vor- und Nachname",
      required: true,
      errorMessage: "Bitte Namen eintragen.",
      helpText: "Wird für die CRM-Zuordnung verwendet.",
    },
    {
      id: `${source.id}_field_email`,
      type: "email",
      crmField: "email",
      label: "E-Mail",
      placeholder: "name@example.com",
      required: true,
      validationPattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$",
      errorMessage: "Bitte gültige E-Mail eintragen.",
    },
    {
      id: `${source.id}_field_phone`,
      type: "phone",
      crmField: "phone",
      label: "Telefon",
      placeholder: "+43 ...",
      required: true,
      errorMessage: "Bitte Telefonnummer eintragen.",
      helpText: "Später mit echter Nummernvalidierung verbinden.",
    },
    {
      id: `${source.id}_field_consent`,
      type: "consent",
      crmField: "privacy_consent",
      label: "Ich stimme der Verarbeitung meiner Angaben zu.",
      required: true,
      errorMessage: "Die Zustimmung ist erforderlich.",
    },
    {
      id: `${source.id}_field_utm_source`,
      type: "hidden",
      crmField: "utm_source",
      label: "UTM Source",
      required: false,
      hiddenValueSource: "utm",
    },
  ];
}

function buildStepElement(step: FunnelStepDraft, index: number): FunnelElement {
  const type = step.type === "Kontaktformular" ? "form" : step.type === "Kalender" ? "calendar" : "choice";
  const options = step.options?.length ? step.options : ["Ja, passt", "Noch unsicher", "Nicht relevant"];

  return {
    id: `${step.id}_element`,
    type,
    name: step.name,
    content: step.question ?? step.name,
    options,
    score: step.score ?? Math.max(10, Math.round(step.conversionRate * 3)),
    required: step.required ?? true,
    crmField: step.crmField ?? normalizeFieldName(step.name),
    analyticsEvent: step.analyticsEvent ?? (index === 0 ? "funnel_start" : "step_view"),
    fields: type === "form" ? buildDefaultContactFields(step) : undefined,
    visibility: { desktop: true, tablet: true, mobile: true },
  };
}

function buildBlockElement(block: string, funnel: FunnelDraft, index: number): FunnelElement {
  const normalized = block.toLowerCase();
  if (normalized.includes("video")) {
    return {
      id: `${funnel.id}_block_${index}_video`,
      type: "video",
      name: block,
      content: "Projektvideo",
      url: "",
      visibility: { desktop: true, tablet: true, mobile: true },
    };
  }
  if (normalized.includes("testimonial")) {
    return {
      id: `${funnel.id}_block_${index}_testimonial`,
      type: "testimonial",
      name: block,
      content: "Kundenstimmen und Vertrauen direkt im Funnel anzeigen.",
      visibility: { desktop: true, tablet: true, mobile: true },
    };
  }
  if (normalized.includes("kalender")) {
    return {
      id: `${funnel.id}_block_${index}_calendar`,
      type: "calendar",
      name: block,
      content: "Termin direkt buchen",
      visibility: { desktop: true, tablet: true, mobile: true },
    };
  }
  if (normalized.includes("formular")) {
    return {
      id: `${funnel.id}_block_${index}_form`,
      type: "form",
      name: block,
      content: "Kontaktdaten erfassen",
      fields: buildDefaultContactFields(funnel),
      visibility: { desktop: true, tablet: true, mobile: true },
    };
  }
  if (normalized.includes("countdown")) {
    return {
      id: `${funnel.id}_block_${index}_countdown`,
      type: "countdown",
      name: block,
      content: "Nächster Termin oder Angebotsfenster",
      visibility: { desktop: true, tablet: true, mobile: true },
    };
  }
  return {
    id: `${funnel.id}_block_${index}_text`,
    type: "text",
    name: block,
    content: funnel.designerBlockText ?? `${block} klar und conversion-orientiert erklären.`,
    visibility: { desktop: true, tablet: true, mobile: true },
  };
}

function buildLandingPage(funnel: FunnelDraft, steps: FunnelStepDraft[]): FunnelPage {
  const blocks = funnel.landingPageBlocks?.length ? funnel.landingPageBlocks : defaultBlocks;
  const blockElements = blocks.map((block, index) => buildBlockElement(block, funnel, index));
  const firstInteractiveStep = steps[0] ? buildStepElement(steps[0], 0) : undefined;

  return {
    id: `${funnel.id}_page_landing`,
    name: "Landingpage",
    slug: "landing",
    kind: "landing",
    sections: [
      {
        id: `${funnel.id}_section_hero`,
        name: "Hero",
        rows: [
          {
            id: `${funnel.id}_row_hero`,
            columns: [
              {
                id: `${funnel.id}_col_hero`,
                width: { desktop: 12, tablet: 12, mobile: 12 },
                elements: [
                  {
                    id: `${funnel.id}_headline`,
                    type: "headline",
                    name: "Headline",
                    content: funnel.designerHeroTitle ?? funnel.goal,
                    visibility: { desktop: true, tablet: true, mobile: true },
                  },
                  {
                    id: `${funnel.id}_subline`,
                    type: "text",
                    name: "Beschreibung",
                    content:
                      funnel.designerHeroSubtitle ??
                      `${funnel.audience} erhalten passende Informationen und den nächsten Schritt.`,
                    visibility: { desktop: true, tablet: true, mobile: true },
                  },
                  {
                    id: `${funnel.id}_cta`,
                    type: "button",
                    name: "CTA",
                    ctaLabel: funnel.designerCtaLabel ?? "Lead starten",
                    analyticsEvent: "funnel_start",
                    visibility: { desktop: true, tablet: true, mobile: true },
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        id: `${funnel.id}_section_blocks`,
        name: "Landingpage-Blöcke",
        rows: [
          {
            id: `${funnel.id}_row_blocks`,
            columns: [
              {
                id: `${funnel.id}_col_blocks`,
                width: { desktop: 12, tablet: 12, mobile: 12 },
                elements: firstInteractiveStep ? [...blockElements, firstInteractiveStep] : blockElements,
              },
            ],
          },
        ],
      },
    ],
  };
}

function buildStepPages(funnel: FunnelDraft, steps: FunnelStepDraft[]): FunnelPage[] {
  return steps.map((step, index) => ({
    id: `${step.id}_page`,
    name: step.name,
    slug: `step-${index + 1}`,
    kind: step.type === "Ergebnisseite" ? "result" : "step",
    sections: [
      {
        id: `${step.id}_section`,
        name: step.name,
        rows: [
          {
            id: `${step.id}_row`,
            columns: [
              {
                id: `${step.id}_col`,
                width: { desktop: 12, tablet: 12, mobile: 12 },
                elements: [buildStepElement(step, index)],
              },
            ],
          },
        ],
      },
    ],
  }));
}

export function buildFunnelBlueprint({ funnel, project, owner, steps }: BuildFunnelBlueprintInput): FunnelBlueprint {
  return {
    schemaVersion: funnelSchemaVersion,
    id: funnel.id,
    workspaceId: funnel.workspaceId,
    projectId: funnel.projectId,
    name: funnel.name,
    goal: funnel.goal,
    audience: funnel.audience,
    entryChannel: funnel.entryChannel,
    status: funnel.status,
    theme: buildTheme(funnel),
    pages: [buildLandingPage(funnel, steps), ...buildStepPages(funnel, steps)],
    variants: [
      {
        id: `${funnel.id}_variant_base`,
        name: "Basis",
        trafficPercent: 50,
        visits: funnel.visits,
        conversions: funnel.leads,
      },
      {
        id: `${funnel.id}_variant_mobile_short`,
        name: "Mobile Kurzform",
        trafficPercent: 50,
        visits: Math.round(funnel.visits * 0.35),
        conversions: Math.max(0, Math.round(funnel.leads * 0.42)),
      },
    ],
    tracking: {
      metaPixelId: funnel.metaPixelId,
      metaCapiToken: funnel.metaCapiToken,
      gaMeasurementId: funnel.gaMeasurementId,
      gtmId: funnel.gtmId,
      matomoSiteId: funnel.matomoSiteId,
      consentMode: mapConsentMode(funnel.consentMode),
      webhookUrl: funnel.webhookUrl,
    },
    crmHandover: {
      destination: mapDestination(funnel.leadDestination),
      pipelineStage: funnel.crmStage ?? "Lead Inbox",
      statusTemplate: funnel.statusTemplate ?? "Immobilien Vertrieb",
      qualityRule: funnel.leadQualityRule ?? "Telefon + E-Mail erforderlich, Score ab 60",
      notificationRecipients: funnel.notificationRecipients ?? owner?.name ?? project?.name ?? "Sales",
      followUp: funnel.followUp ?? "Lead prüfen und nächsten Schritt planen.",
      createLeadInboxEntry: funnel.triggerLeadInbox ?? true,
      createTask: funnel.triggerTask ?? true,
      createAppointment: funnel.triggerAppointment ?? false,
    },
    mediaLibrary: [
      {
        id: `${funnel.id}_media_project_image`,
        name: `${project?.name ?? funnel.name} Bild`,
        type: "image",
        url: "",
        folder: "Projekt",
        alt: project?.name ?? funnel.name,
        createdAt: new Date().toISOString(),
      },
    ],
    createdFrom: funnel.brandPreset ? "editor-draft" : "crm-data",
  };
}

export function findFunnelBlueprint(
  funnelId: string,
  data: {
    funnels: Funnel[];
    projects: Project[];
    steps: FunnelStep[];
    users: WorkspaceUser[];
  },
) {
  const funnel = data.funnels.find((item) => item.id === funnelId);
  if (!funnel) return null;

  return buildFunnelBlueprint({
    funnel,
    project: data.projects.find((item) => item.id === funnel.projectId),
    owner: funnel.ownerUserId ? data.users.find((item) => item.id === funnel.ownerUserId) : undefined,
    steps: data.steps.filter((step) => step.funnelId === funnel.id),
  });
}
