"use client";

import { useMemo, useState } from "react";
import type {
  ConsentRecord,
  Lead,
  NewsletterAutomation,
  NewsletterCampaign,
  NewsletterDeliverability,
  NewsletterSegment,
  NewsletterSuppression,
  NewsletterTemplate,
  Project,
  WorkspaceUser,
} from "@/lib/crm-types";
import { languageOptionsByCode, type LanguageCode } from "@/lib/i18n";

type NewsletterCommandCenterProps = {
  automations: NewsletterAutomation[];
  campaigns: NewsletterCampaign[];
  consents: ConsentRecord[];
  deliverability: NewsletterDeliverability[];
  language: LanguageCode;
  leads: Lead[];
  projectLabel: string;
  projects: Project[];
  segments: NewsletterSegment[];
  suppressions: NewsletterSuppression[];
  templates: NewsletterTemplate[];
  users: WorkspaceUser[];
};

type NewsletterArea =
  | "campaigns"
  | "builder"
  | "segments"
  | "automations"
  | "analytics"
  | "deliverability";

type PreviewDevice = "desktop" | "mobile" | "dark";

type NewsletterEditorBlock =
  | {
      id: string;
      text: string;
      type: "text";
    }
  | {
      id: string;
      text: string;
      type: "heading";
    }
  | {
      alt: string;
      caption: string;
      id: string;
      imageUrl: string;
      type: "image";
    }
  | {
      id: string;
      label: string;
      type: "button";
      url: string;
    }
  | {
      ctaLabel: string;
      ctaUrl: string;
      detail: string;
      id: string;
      location: string;
      price: string;
      title: string;
      type: "property";
    }
  | {
      id: string;
      question: string;
      type: "feedback";
    }
  | {
      id: string;
      instagram: string;
      linkedin: string;
      type: "social";
      website: string;
    }
  | {
      id: string;
      size: "small" | "medium" | "large";
      type: "spacer";
    }
  | {
      id: string;
      type: "divider";
    };

type DraftState = {
  contentBlocks: NewsletterEditorBlock[];
  fromEmail: string;
  fromName: string;
  previewText: string;
  replyTo: string;
  sendAt: string;
  subject: string;
  variantA: string;
  variantB: string;
};

const campaignStatusStyles = {
  entwurf: "border-stone-200 bg-stone-50 text-stone-700",
  geplant: "border-blue-200 bg-blue-50 text-blue-900",
  bereit: "border-emerald-200 bg-emerald-50 text-emerald-900",
  gesendet: "border-violet-200 bg-violet-50 text-violet-900",
} as const;

const segmentHealthStyles = {
  bereit: "border-emerald-200 bg-emerald-50 text-emerald-900",
  prüfen: "border-amber-200 bg-amber-50 text-amber-900",
  wachstum: "border-blue-200 bg-blue-50 text-blue-900",
} as const;

const deliverabilityStyles = {
  bereit: "border-emerald-200 bg-emerald-50 text-emerald-900",
  prüfen: "border-amber-200 bg-amber-50 text-amber-900",
  blockiert: "border-red-200 bg-red-50 text-red-900",
} as const;

const automationStyles = {
  aktiv: "border-emerald-200 bg-emerald-50 text-emerald-900",
  pausiert: "border-amber-200 bg-amber-50 text-amber-900",
  entwurf: "border-stone-200 bg-stone-50 text-stone-700",
} as const;

const labels = {
  de: {
    title: "Newsletter und Resend",
    description:
      "Vollständiger Newsletter-Arbeitsbereich mit Segmenten, Editor, Vorlagen, A/B-Test, Automationen, Analytics, Consent, Unterdrückungsliste und Zustellbarkeit.",
    campaigns: "Kampagnen",
    builder: "Editor",
    segments: "Segmente",
    automations: "Automationen",
    analytics: "Analytics",
    deliverability: "Zustellbarkeit",
    search: "Suche",
    searchPlaceholder: "Kampagne, Segment, Betreff oder Ziel suchen",
    recipients: "Empfänger",
    optIns: "Opt-ins",
    avgOpenRate: "Ø Öffnung",
    suppressions: "Unterdrückungen",
    selectedCampaign: "Ausgewählte Kampagne",
    subject: "Betreff",
    previewText: "Preheader",
    fromName: "Absendername",
    fromEmail: "Absender-E-Mail",
    replyTo: "Antwort an",
    sendAt: "Versandzeit",
    contentBlocks: "Inhaltsblöcke",
    preview: "Live-Vorschau",
    finalPreview: "Fertige Newsletter-Vorschau",
    inboxPreview: "Posteingang-Vorschau",
    finishedEmail: "Fertige E-Mail",
    desktopPreview: "Desktop",
    mobilePreview: "Mobil",
    darkPreview: "Dark Mode",
    fromLine: "Von",
    toLine: "An",
    sampleRecipient: "maria.muster@example.com",
    browserVersion: "Im Browser ansehen",
    unsubscribeLink: "Abmelden",
    footerNote:
      "Du erhaeltst diese E-Mail, weil du Informationen zu Immobilienprojekten von Novalure angefragt hast.",
    legalAddress: "Novalure Immobilien CRM, Herrengasse 1, 8010 Graz",
    abTest: "A/B-Test",
    variantA: "Variante A",
    variantB: "Variante B",
    recommendationTitle: "Empfehlung für Novalure",
    recommendationPrompt:
      "Baue einen Immobilien-Newsletter-Bereich wie Brevo und CleverReach, aber spezialisiert auf CRM-Leads: Drag-and-drop-ähnliche Blöcke, Immobilienkarten, gespeicherte Snippets, Personalisierung, Desktop/Mobil/Dark-Mode-Vorschau, DSGVO- und Zustellbarkeitscheck sowie Rückgabe warmer Klicks an Lead Inbox, Aufgaben und Deals.",
    snippets: "Schnellbausteine",
    personalization: "Personalisierung",
    personalizationHint:
      "Diese Platzhalter werden später pro Kontakt aus CRM, Projekt und Sprache gefüllt.",
    addProjectSnippet: "Projektupdate",
    addViewingSnippet: "Besichtigung",
    addSellerSnippet: "Eigentuemer",
    addFeedbackSnippet: "Feedback",
    addTextBlock: "Text",
    addHeadingBlock: "Überschrift",
    addImageBlock: "Bild",
    addButtonBlock: "Button",
    addPropertyBlock: "Immobilienkarte",
    addFeedbackBlock: "Feedback",
    addSocialBlock: "Social",
    addSpacerBlock: "Abstand",
    addDividerBlock: "Trennlinie",
    removeBlock: "Entfernen",
    textBlock: "Textblock",
    headingBlock: "Überschrift",
    imageBlock: "Bildblock",
    buttonBlock: "Button",
    propertyBlock: "Immobilienkarte",
    feedbackBlock: "Feedbackblock",
    socialBlock: "Social Links",
    spacerBlock: "Abstand",
    dividerBlock: "Trennlinie",
    headingText: "Überschrift",
    imageUrl: "Bild-URL",
    imageAlt: "Alternativtext",
    imageCaption: "Bildunterschrift",
    buttonLabel: "Button-Text",
    buttonUrl: "Button-Link",
    propertyTitle: "Immobilie / Projekt",
    propertyLocation: "Lage",
    propertyPrice: "Preis / Status",
    propertyDetail: "Kurzbeschreibung",
    feedbackQuestion: "Feedback-Frage",
    socialWebsite: "Website",
    socialInstagram: "Instagram",
    socialLinkedin: "LinkedIn",
    spacerSize: "Abstand",
    small: "Klein",
    medium: "Mittel",
    large: "Gross",
    blockPlaceholder: "Schreibe deinen Newsletter-Text frei.",
    imageUrlPlaceholder: "https://...",
    imageAltPlaceholder: "Beschreibe das Bild für Empfänger ohne Bildanzeige",
    imageCaptionPlaceholder: "Optionale Bildunterschrift",
    buttonLabelPlaceholder: "Termin buchen",
    buttonUrlPlaceholder: "https://...",
    propertyTitlePlaceholder: "Wohnpark Graz - Einheit B12",
    propertyLocationPlaceholder: "Graz, Geidorf",
    propertyPricePlaceholder: "ab 389.000 EUR",
    propertyDetailPlaceholder: "3 Zimmer, Balkon, provisionsfrei, Besichtigung diese Woche moeglich.",
    feedbackQuestionPlaceholder: "Ist dieses Projekt für Sie interessant?",
    imageHint:
      "Bilder kannst du jetzt per Bild-URL einfügen. Datei-Upload kann danach mit Vercel Blob ergänzt werden.",
    checklist: "Versand-Checkliste",
    ready: "bereit",
    review: "prüfen",
    missing: "fehlt",
    template: "Vorlage",
    campaignGoal: "Kampagnenziel",
    segment: "Segment",
    owner: "Verantwortlich",
    project: "Projekt",
    status: "Status",
    language: "Sprache",
    source: "Quelle",
    rules: "Regeln",
    resendMapping: "Resend Broadcast Mapping",
    noCampaigns: "Keine Kampagnen für diese Ansicht.",
    noSegment: "Kein Segment verknüpft",
    noSendAt: "Noch nicht geplant",
    openRate: "Öffnung",
    clickRate: "Klickrate",
    bounceRate: "Bounces",
    unsubscribeRate: "Abmeldungen",
    complaintRate: "Beschwerden",
    reputation: "Reputation",
    spf: "SPF",
    dkim: "DKIM",
    dmarc: "DMARC",
    trigger: "Trigger",
    goal: "Ziel",
    steps: "Schritte",
    noMetric: "Noch nicht gesendet",
    consentSafe: "Nur Newsletter Opt-ins im Segment",
    unsubscribeSafe: "Abmelde-Link über Resend Broadcasts",
    domainSafe: "Absenderdomain bereit",
    contentSafe: "Betreff, Preheader und Inhalt vollständig",
    personalizationSafe: "CRM-Personalisierung vorbereitet",
    ctaSafe: "Mindestens ein klarer Termin- oder Expose-CTA",
    imageAltSafe: "Bildbeschreibungen für Barrierefreiheit",
    legalFooterSafe: "DSGVO-Footer und Abmeldelink vorhanden",
    crmHandover:
      "Antworten und Klicks sollen später als Aktivität am Kontakt landen und warme Kontakte wieder in Lead Inbox, Aufgabe oder Deal übergeben.",
  },
  en: {
    title: "Newsletter and Resend",
    description:
      "Complete newsletter workspace with segments, editor, templates, A/B test, automations, analytics, consent, suppression list and deliverability.",
    campaigns: "Campaigns",
    builder: "Builder",
    segments: "Segments",
    automations: "Automations",
    analytics: "Analytics",
    deliverability: "Deliverability",
    search: "Search",
    searchPlaceholder: "Search campaign, segment, subject or goal",
    recipients: "Recipients",
    optIns: "Opt-ins",
    avgOpenRate: "Avg open",
    suppressions: "Suppressions",
    selectedCampaign: "Selected campaign",
    subject: "Subject",
    previewText: "Preheader",
    fromName: "From name",
    fromEmail: "From email",
    replyTo: "Reply to",
    sendAt: "Send time",
    contentBlocks: "Content blocks",
    preview: "Live preview",
    finalPreview: "Final newsletter preview",
    inboxPreview: "Inbox preview",
    finishedEmail: "Finished email",
    desktopPreview: "Desktop",
    mobilePreview: "Mobile",
    darkPreview: "Dark mode",
    fromLine: "From",
    toLine: "To",
    sampleRecipient: "maria.sample@example.com",
    browserVersion: "View in browser",
    unsubscribeLink: "Unsubscribe",
    footerNote:
      "You receive this email because you requested information about real estate projects from Novalure.",
    legalAddress: "Novalure Real Estate CRM, Herrengasse 1, 8010 Graz",
    abTest: "A/B test",
    variantA: "Variant A",
    variantB: "Variant B",
    recommendationTitle: "Recommendation for Novalure",
    recommendationPrompt:
      "Build a real estate newsletter workspace like Brevo and CleverReach, but specialized for CRM leads: drag-and-drop-like blocks, property cards, saved snippets, personalization, desktop/mobile/dark-mode preview, GDPR and deliverability checks, and warm-click handover to Lead Inbox, Tasks and Deals.",
    snippets: "Snippets",
    personalization: "Personalization",
    personalizationHint:
      "These placeholders will later be filled from CRM, project and language data per contact.",
    addProjectSnippet: "Project update",
    addViewingSnippet: "Viewing",
    addSellerSnippet: "Seller",
    addFeedbackSnippet: "Feedback",
    addTextBlock: "Text",
    addHeadingBlock: "Heading",
    addImageBlock: "Image",
    addButtonBlock: "Button",
    addPropertyBlock: "Property card",
    addFeedbackBlock: "Feedback",
    addSocialBlock: "Social",
    addSpacerBlock: "Spacing",
    addDividerBlock: "Divider",
    removeBlock: "Remove",
    textBlock: "Text block",
    headingBlock: "Heading",
    imageBlock: "Image block",
    buttonBlock: "Button",
    propertyBlock: "Property card",
    feedbackBlock: "Feedback block",
    socialBlock: "Social links",
    spacerBlock: "Spacing",
    dividerBlock: "Divider",
    headingText: "Heading",
    imageUrl: "Image URL",
    imageAlt: "Alt text",
    imageCaption: "Image caption",
    buttonLabel: "Button text",
    buttonUrl: "Button link",
    propertyTitle: "Property / project",
    propertyLocation: "Location",
    propertyPrice: "Price / status",
    propertyDetail: "Short description",
    feedbackQuestion: "Feedback question",
    socialWebsite: "Website",
    socialInstagram: "Instagram",
    socialLinkedin: "LinkedIn",
    spacerSize: "Spacing",
    small: "Small",
    medium: "Medium",
    large: "Large",
    blockPlaceholder: "Write your newsletter text freely.",
    imageUrlPlaceholder: "https://...",
    imageAltPlaceholder: "Describe the image for recipients without image display",
    imageCaptionPlaceholder: "Optional image caption",
    buttonLabelPlaceholder: "Book a viewing",
    buttonUrlPlaceholder: "https://...",
    propertyTitlePlaceholder: "Wohnpark Graz - unit B12",
    propertyLocationPlaceholder: "Graz, Geidorf",
    propertyPricePlaceholder: "from EUR 389,000",
    propertyDetailPlaceholder: "3 rooms, balcony, commission-free, viewing available this week.",
    feedbackQuestionPlaceholder: "Is this project interesting for you?",
    imageHint:
      "Images can now be inserted by image URL. File upload can be added next with Vercel Blob.",
    checklist: "Send checklist",
    ready: "ready",
    review: "review",
    missing: "missing",
    template: "Template",
    campaignGoal: "Campaign goal",
    segment: "Segment",
    owner: "Owner",
    project: "Project",
    status: "Status",
    language: "Language",
    source: "Source",
    rules: "Rules",
    resendMapping: "Resend broadcast mapping",
    noCampaigns: "No campaigns for this view.",
    noSegment: "No segment linked",
    noSendAt: "Not scheduled yet",
    openRate: "Open rate",
    clickRate: "Click rate",
    bounceRate: "Bounces",
    unsubscribeRate: "Unsubscribes",
    complaintRate: "Complaints",
    reputation: "Reputation",
    spf: "SPF",
    dkim: "DKIM",
    dmarc: "DMARC",
    trigger: "Trigger",
    goal: "Goal",
    steps: "Steps",
    noMetric: "Not sent yet",
    consentSafe: "Only newsletter opt-ins in segment",
    unsubscribeSafe: "Unsubscribe link via Resend Broadcasts",
    domainSafe: "Sender domain ready",
    contentSafe: "Subject, preheader and content complete",
    personalizationSafe: "CRM personalization prepared",
    ctaSafe: "At least one clear viewing or exposé CTA",
    imageAltSafe: "Image descriptions for accessibility",
    legalFooterSafe: "GDPR footer and unsubscribe link present",
    crmHandover:
      "Replies and clicks should later land as contact activity and move warm contacts back to Lead Inbox, Tasks or Deals.",
  },
} as const;

type BlockLabelText = {
  buttonBlock: string;
  dividerBlock: string;
  feedbackBlock: string;
  headingBlock: string;
  imageBlock: string;
  propertyBlock: string;
  socialBlock: string;
  spacerBlock: string;
  textBlock: string;
};

function formatNumber(value: number, language: LanguageCode) {
  return new Intl.NumberFormat(language === "de" ? "de-AT" : "en-US").format(value);
}

function formatPercent(value: number | undefined, language: LanguageCode, fallback: string) {
  if (typeof value !== "number") {
    return fallback;
  }

  return `${new Intl.NumberFormat(language === "de" ? "de-AT" : "en-US", {
    maximumFractionDigits: 1,
    minimumFractionDigits: 1,
  }).format(value)}%`;
}

function formatDateTime(value: string | undefined, locale: string, fallback: string) {
  if (!value) {
    return fallback;
  }

  return new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
  }).format(new Date(value));
}

function createBlockId(type: NewsletterEditorBlock["type"]) {
  return `newsletter-${type}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getBlockLabel(block: NewsletterEditorBlock, text: BlockLabelText) {
  if (block.type === "text") {
    return text.textBlock;
  }

  if (block.type === "heading") {
    return text.headingBlock;
  }

  if (block.type === "image") {
    return text.imageBlock;
  }

  if (block.type === "button") {
    return text.buttonBlock;
  }

  if (block.type === "property") {
    return text.propertyBlock;
  }

  if (block.type === "feedback") {
    return text.feedbackBlock;
  }

  if (block.type === "social") {
    return text.socialBlock;
  }

  if (block.type === "spacer") {
    return text.spacerBlock;
  }

  return text.dividerBlock;
}

function toEditorBlocks(campaign: NewsletterCampaign | undefined): NewsletterEditorBlock[] {
  return (campaign?.contentBlocks ?? []).map((block, index) => ({
    id: `${campaign?.id ?? "draft"}-text-${index}`,
    text: block,
    type: "text",
  }));
}

function hasCompleteContent(blocks: NewsletterEditorBlock[]) {
  return blocks.some((block) => {
    if (block.type === "text") {
      return block.text.trim().length > 0;
    }

    if (block.type === "heading") {
      return block.text.trim().length > 0;
    }

    if (block.type === "image") {
      return block.imageUrl.trim().length > 0 && block.alt.trim().length > 0;
    }

    if (block.type === "button") {
      return block.label.trim().length > 0 && block.url.trim().length > 0;
    }

    if (block.type === "property") {
      return block.title.trim().length > 0 && block.ctaUrl.trim().length > 0;
    }

    if (block.type === "feedback") {
      return block.question.trim().length > 0;
    }

    if (block.type === "social") {
      return Boolean(block.website.trim() || block.instagram.trim() || block.linkedin.trim());
    }

    return false;
  });
}

function hasPersonalization(draft: DraftState) {
  const fields = [
    draft.subject,
    draft.previewText,
    ...draft.contentBlocks.map((block) => {
      if (block.type === "text" || block.type === "heading") {
        return block.text;
      }

      if (block.type === "property") {
        return `${block.title} ${block.location} ${block.price} ${block.detail}`;
      }

      if (block.type === "feedback") {
        return block.question;
      }

      return "";
    }),
  ];

  return fields.some((field) => field.includes("{{"));
}

function hasClearCta(blocks: NewsletterEditorBlock[]) {
  return blocks.some((block) => {
    if (block.type === "button") {
      return block.label.trim().length > 0 && block.url.trim().length > 0;
    }

    if (block.type === "property") {
      return block.ctaLabel.trim().length > 0 && block.ctaUrl.trim().length > 0;
    }

    return false;
  });
}

function hasImageAltText(blocks: NewsletterEditorBlock[]) {
  return blocks.every((block) => block.type !== "image" || !block.imageUrl || block.alt.trim());
}

function getDefaultDraft(campaign: NewsletterCampaign | undefined): DraftState {
  return {
    contentBlocks: toEditorBlocks(campaign),
    fromEmail: campaign?.fromEmail ?? "newsletter@novalure.eu",
    fromName: campaign?.fromName ?? "Novalure",
    previewText: campaign?.previewText ?? "",
    replyTo: campaign?.replyTo ?? "hello@novalure.eu",
    sendAt: campaign?.sendAt ?? "",
    subject: campaign?.subject ?? "",
    variantA: campaign?.abTest?.variantA ?? campaign?.subject ?? "",
    variantB: campaign?.abTest?.variantB ?? "",
  };
}

export function NewsletterCommandCenter({
  automations,
  campaigns,
  consents,
  deliverability,
  language,
  leads,
  projectLabel,
  projects,
  segments,
  suppressions,
  templates,
  users,
}: NewsletterCommandCenterProps) {
  const text = labels[language];
  const locale = languageOptionsByCode[language].locale;
  const [activeArea, setActiveArea] = useState<NewsletterArea>("campaigns");
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedCampaignId, setSelectedCampaignId] = useState(campaigns[0]?.id ?? "");
  const [drafts, setDrafts] = useState<Record<string, Partial<DraftState>>>({});
  const [previewDevice, setPreviewDevice] = useState<PreviewDevice>("desktop");

  const decoratedCampaigns = useMemo(
    () =>
      campaigns.map((campaign) => {
        const segment = segments.find((item) => item.id === campaign.segmentId);
        const template = templates.find((item) => item.id === campaign.templateId);
        const project = campaign.projectId
          ? projects.find((item) => item.id === campaign.projectId)
          : undefined;
        const owner = campaign.ownerUserId
          ? users.find((item) => item.id === campaign.ownerUserId)
          : undefined;
        const sender = deliverability.find((item) => item.fromEmail === campaign.fromEmail);

        return { campaign, owner, project, segment, sender, template };
      }),
    [campaigns, deliverability, projects, segments, templates, users],
  );

  const filteredCampaigns = decoratedCampaigns.filter((item) => {
    const normalizedQuery = searchTerm.trim().toLowerCase();
    const searchable = [
      item.campaign.name,
      item.campaign.subject,
      item.campaign.previewText,
      item.campaign.goal,
      item.segment?.name,
      item.segment?.audience,
      item.template?.name,
      item.project?.name,
      item.owner?.name,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return !normalizedQuery || searchable.includes(normalizedQuery);
  });
  const selectedCampaign =
    decoratedCampaigns.find((item) => item.campaign.id === selectedCampaignId) ??
    filteredCampaigns[0] ??
    decoratedCampaigns[0];
  const selectedDraft: DraftState = {
    ...getDefaultDraft(selectedCampaign?.campaign),
    ...(selectedCampaign ? drafts[selectedCampaign.campaign.id] : {}),
  };
  const previewCanvasClass =
    previewDevice === "mobile" ? "max-w-[360px]" : "max-w-[620px]";
  const previewIsDark = previewDevice === "dark";
  const personalizationTokens = [
    "{{contact.firstName}}",
    "{{project.name}}",
    "{{project.city}}",
    "{{lead.budget}}",
    "{{agent.name}}",
    "{{booking.link}}",
  ];
  const totalRecipients = campaigns.reduce((sum, campaign) => sum + campaign.recipients, 0);
  const totalOptIns = segments.reduce((sum, segment) => sum + segment.optIns, 0);
  const sentCampaigns = campaigns.filter((campaign) => campaign.status === "gesendet");
  const avgOpenRate =
    sentCampaigns.length > 0
      ? sentCampaigns.reduce((sum, campaign) => sum + (campaign.openRate ?? 0), 0) /
        sentCampaigns.length
      : undefined;
  const newsletterOptIns = consents.filter(
    (consent) => consent.channel === "Newsletter" && consent.status === "Opt-in",
  );
  const currentSender = deliverability.find((item) => item.fromEmail === selectedDraft.fromEmail);
  const checklist = [
    {
      label: text.consentSafe,
      ready: Boolean(selectedCampaign?.segment && selectedCampaign.segment.optIns > 0),
    },
    {
      label: text.unsubscribeSafe,
      ready: Boolean(selectedCampaign?.segment?.resendAudienceId),
    },
    {
      label: text.domainSafe,
      ready: currentSender?.status === "bereit",
    },
    {
      label: text.contentSafe,
      ready: Boolean(
        selectedDraft.subject && selectedDraft.previewText && hasCompleteContent(selectedDraft.contentBlocks),
      ),
    },
    {
      label: text.personalizationSafe,
      ready: hasPersonalization(selectedDraft),
    },
    {
      label: text.ctaSafe,
      ready: hasClearCta(selectedDraft.contentBlocks),
    },
    {
      label: text.imageAltSafe,
      ready: hasImageAltText(selectedDraft.contentBlocks),
    },
    {
      label: text.legalFooterSafe,
      ready: true,
    },
  ];
  const areas: Array<{ id: NewsletterArea; label: string; count: number }> = [
    { id: "campaigns", label: text.campaigns, count: campaigns.length },
    { id: "builder", label: text.builder, count: selectedDraft.contentBlocks.length },
    { id: "segments", label: text.segments, count: segments.length },
    { id: "automations", label: text.automations, count: automations.length },
    { id: "analytics", label: text.analytics, count: sentCampaigns.length },
    { id: "deliverability", label: text.deliverability, count: deliverability.length },
  ];

  const updateDraft = (field: keyof DraftState, value: string | NewsletterEditorBlock[]) => {
    if (!selectedCampaign) {
      return;
    }

    setDrafts((current) => ({
      ...current,
      [selectedCampaign.campaign.id]: {
        ...current[selectedCampaign.campaign.id],
        [field]: value,
      },
    }));
  };

  const updateBlock = (blockId: string, nextBlock: NewsletterEditorBlock) => {
    const nextBlocks = selectedDraft.contentBlocks.map((block) =>
      block.id === blockId ? nextBlock : block,
    );
    updateDraft("contentBlocks", nextBlocks);
  };

  const addTextBlock = () => {
    updateDraft("contentBlocks", [
      ...selectedDraft.contentBlocks,
      { id: createBlockId("text"), text: "", type: "text" },
    ]);
  };

  const addHeadingBlock = () => {
    updateDraft("contentBlocks", [
      ...selectedDraft.contentBlocks,
      { id: createBlockId("heading"), text: "", type: "heading" },
    ]);
  };

  const addImageBlock = () => {
    updateDraft("contentBlocks", [
      ...selectedDraft.contentBlocks,
      {
        alt: "",
        caption: "",
        id: createBlockId("image"),
        imageUrl: "",
        type: "image",
      },
    ]);
  };

  const addButtonBlock = () => {
    updateDraft("contentBlocks", [
      ...selectedDraft.contentBlocks,
      {
        id: createBlockId("button"),
        label: "",
        type: "button",
        url: "",
      },
    ]);
  };

  const addPropertyBlock = () => {
    updateDraft("contentBlocks", [
      ...selectedDraft.contentBlocks,
      {
        ctaLabel: text.buttonLabelPlaceholder,
        ctaUrl: "{{booking.link}}",
        detail: text.propertyDetailPlaceholder,
        id: createBlockId("property"),
        location: text.propertyLocationPlaceholder,
        price: text.propertyPricePlaceholder,
        title: text.propertyTitlePlaceholder,
        type: "property",
      },
    ]);
  };

  const addFeedbackBlock = () => {
    updateDraft("contentBlocks", [
      ...selectedDraft.contentBlocks,
      {
        id: createBlockId("feedback"),
        question: text.feedbackQuestionPlaceholder,
        type: "feedback",
      },
    ]);
  };

  const addSocialBlock = () => {
    updateDraft("contentBlocks", [
      ...selectedDraft.contentBlocks,
      {
        id: createBlockId("social"),
        instagram: "https://instagram.com/novalure",
        linkedin: "https://linkedin.com/company/novalure",
        type: "social",
        website: "https://novalure.eu",
      },
    ]);
  };

  const addSpacerBlock = () => {
    updateDraft("contentBlocks", [
      ...selectedDraft.contentBlocks,
      { id: createBlockId("spacer"), size: "medium", type: "spacer" },
    ]);
  };

  const addDividerBlock = () => {
    updateDraft("contentBlocks", [
      ...selectedDraft.contentBlocks,
      { id: createBlockId("divider"), type: "divider" },
    ]);
  };

  const addSnippet = (snippet: "project" | "viewing" | "seller" | "feedback") => {
    const snippets: Record<typeof snippet, NewsletterEditorBlock[]> = {
      feedback: [
        {
          id: createBlockId("feedback"),
          question: text.feedbackQuestionPlaceholder,
          type: "feedback",
        },
      ],
      project: [
        {
          id: createBlockId("heading"),
          text: "Neuigkeiten zu {{project.name}}",
          type: "heading",
        },
        {
          ctaLabel: "Exposé ansehen",
          ctaUrl: "{{booking.link}}",
          detail: text.propertyDetailPlaceholder,
          id: createBlockId("property"),
          location: "{{project.city}}",
          price: text.propertyPricePlaceholder,
          title: "{{project.name}}",
          type: "property",
        },
      ],
      seller: [
        {
          id: createBlockId("heading"),
          text: "Was ist Ihre Immobilie aktuell wert?",
          type: "heading",
        },
        {
          id: createBlockId("text"),
          text:
            "Hallo {{contact.firstName}}, wir prüfen aktuell die Nachfrage in {{project.city}} und können eine kurze Ersteinschaetzung vorbereiten.",
          type: "text",
        },
        {
          id: createBlockId("button"),
          label: "Bewertung anfragen",
          type: "button",
          url: "{{booking.link}}",
        },
      ],
      viewing: [
        {
          id: createBlockId("text"),
          text:
            "Hallo {{contact.firstName}}, für {{project.name}} sind neue Besichtigungstermine verfügbar. Wählen Sie einfach einen passenden Termin.",
          type: "text",
        },
        {
          id: createBlockId("button"),
          label: "Besichtigung buchen",
          type: "button",
          url: "{{booking.link}}",
        },
      ],
    };

    updateDraft("contentBlocks", [...selectedDraft.contentBlocks, ...snippets[snippet]]);
  };

  const removeBlock = (blockId: string) => {
    updateDraft(
      "contentBlocks",
      selectedDraft.contentBlocks.filter((block) => block.id !== blockId),
    );
  };

  return (
    <section className="grid gap-4">
      <article className="rounded-lg border border-stone-200 bg-white p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
              {projectLabel}
            </p>
            <h3 className="mt-1 text-2xl font-semibold">{text.title}</h3>
            <p className="mt-2 max-w-4xl break-words text-sm text-stone-600">
              {text.description}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
            {[
              { label: text.recipients, value: formatNumber(totalRecipients, language) },
              { label: text.optIns, value: formatNumber(totalOptIns, language) },
              { label: text.avgOpenRate, value: formatPercent(avgOpenRate, language, "-") },
              { label: text.suppressions, value: suppressions.length },
            ].map((metric) => (
              <div className="rounded-md bg-stone-50 p-3" key={metric.label}>
                <p className="font-semibold">{metric.value}</p>
                <p className="break-words text-xs text-stone-500">{metric.label}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-5 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap gap-2">
            {areas.map((area) => (
              <button
                className={`rounded-md border px-3 py-2 text-sm font-semibold ${
                  activeArea === area.id
                    ? "border-slate-950 bg-slate-950 text-white"
                    : "border-stone-200 bg-stone-50 text-stone-700 hover:border-emerald-200 hover:bg-emerald-50"
                }`}
                key={area.id}
                onClick={() => setActiveArea(area.id)}
                type="button"
              >
                {area.label} · {area.count}
              </button>
            ))}
          </div>
          <label className="w-full text-xs font-semibold uppercase tracking-[0.12em] text-stone-500 lg:w-96">
            {text.search}
            <input
              className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none focus:border-slate-950"
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder={text.searchPlaceholder}
              type="search"
              value={searchTerm}
            />
          </label>
        </div>
      </article>

      {activeArea === "campaigns" ? (
        <section className="grid gap-4 xl:grid-cols-[1fr_390px]">
          <article className="rounded-lg border border-stone-200 bg-white p-4">
            <div className="grid gap-3">
              {filteredCampaigns.length > 0 ? (
                filteredCampaigns.map((item) => {
                  const isSelected = selectedCampaign?.campaign.id === item.campaign.id;

                  return (
                    <button
                      aria-pressed={isSelected}
                      className={`rounded-lg border p-4 text-left transition ${
                        isSelected
                          ? "border-slate-950 bg-slate-950 text-white"
                          : "border-stone-200 bg-stone-50 text-slate-950 hover:border-emerald-200 hover:bg-emerald-50"
                      }`}
                      key={item.campaign.id}
                      onClick={() => setSelectedCampaignId(item.campaign.id)}
                      type="button"
                    >
                      <span className="flex min-w-0 items-start justify-between gap-3">
                        <span className="min-w-0">
                          <span className="block break-words text-sm font-semibold">
                            {item.campaign.name}
                          </span>
                          <span
                            className={`mt-1 block break-words text-xs ${
                              isSelected ? "text-slate-300" : "text-stone-500"
                            }`}
                          >
                            {item.segment?.name ?? text.noSegment} · {item.campaign.subject}
                          </span>
                        </span>
                        <span
                          className={`shrink-0 rounded-md border px-2 py-1 text-xs font-semibold ${
                            isSelected
                              ? "border-white/10 bg-white/10 text-white"
                              : campaignStatusStyles[item.campaign.status]
                          }`}
                        >
                          {item.campaign.status}
                        </span>
                      </span>
                      <span className="mt-3 grid gap-2 text-xs md:grid-cols-4">
                        <span
                          className={`rounded-md px-2 py-1 font-semibold ${
                            isSelected ? "bg-white/10 text-white" : "bg-white text-stone-700"
                          }`}
                        >
                          {formatNumber(item.campaign.recipients, language)} {text.recipients}
                        </span>
                        <span
                          className={`rounded-md border px-2 py-1 font-semibold ${
                            isSelected
                              ? "border-white/10 bg-white/10 text-white"
                              : item.segment
                                ? segmentHealthStyles[item.segment.health]
                                : "border-stone-200 bg-stone-50 text-stone-700"
                          }`}
                        >
                          {item.segment?.health ?? text.noSegment}
                        </span>
                        <span
                          className={`rounded-md px-2 py-1 font-semibold ${
                            isSelected ? "bg-white/10 text-white" : "bg-white text-stone-700"
                          }`}
                        >
                          {formatDateTime(item.campaign.sendAt, locale, text.noSendAt)}
                        </span>
                        <span
                          className={`rounded-md px-2 py-1 font-semibold ${
                            isSelected ? "bg-white/10 text-white" : "bg-white text-stone-700"
                          }`}
                        >
                          {item.template?.name ?? text.template}
                        </span>
                      </span>
                    </button>
                  );
                })
              ) : (
                <div className="rounded-lg border border-dashed border-stone-300 bg-stone-50 p-5 text-sm text-stone-500">
                  {text.noCampaigns}
                </div>
              )}
            </div>
          </article>

          <aside className="rounded-lg border border-stone-200 bg-white p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
              {text.selectedCampaign}
            </p>
            <h4 className="mt-1 break-words text-xl font-semibold text-slate-950">
              {selectedCampaign?.campaign.name ?? text.noCampaigns}
            </h4>
            <div className="mt-4 grid gap-3 text-sm">
              {[
                [text.project, selectedCampaign?.project?.name ?? projectLabel],
                [text.segment, selectedCampaign?.segment?.name ?? text.noSegment],
                [text.template, selectedCampaign?.template?.name],
                [text.campaignGoal, selectedCampaign?.campaign.goal],
                [text.owner, selectedCampaign?.owner?.name],
                [text.status, selectedCampaign?.campaign.status],
              ].map(([label, value]) => (
                <div className="rounded-md bg-stone-50 p-3" key={label}>
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    {label}
                  </p>
                  <p className="mt-1 break-words font-semibold text-slate-900">{value ?? "-"}</p>
                </div>
              ))}
            </div>
            <div className="mt-4 rounded-lg border border-emerald-100 bg-emerald-50 p-4 text-emerald-950">
              <p className="break-words text-sm font-semibold">{text.crmHandover}</p>
              <p className="mt-2 text-sm">{leads.length} Leads aktuell im Projektfilter.</p>
            </div>
          </aside>
        </section>
      ) : null}

      {activeArea === "builder" ? (
        <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(430px,560px)]">
          <article className="rounded-lg border border-stone-200 bg-white p-5">
            <div className="grid gap-3 md:grid-cols-2">
              {[
                { field: "fromName", label: text.fromName, value: selectedDraft.fromName },
                { field: "fromEmail", label: text.fromEmail, value: selectedDraft.fromEmail },
                { field: "replyTo", label: text.replyTo, value: selectedDraft.replyTo },
                { field: "sendAt", label: text.sendAt, value: selectedDraft.sendAt },
              ].map((input) => (
                <label
                  className="grid gap-1 text-sm font-semibold text-slate-900"
                  key={input.field}
                >
                  {input.label}
                  <input
                    className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 outline-none focus:border-slate-950"
                    onChange={(event) =>
                      updateDraft(input.field as keyof DraftState, event.target.value)
                    }
                    value={input.value}
                  />
                </label>
              ))}
            </div>
            <label className="mt-4 grid gap-1 text-sm font-semibold text-slate-900">
              {text.subject}
              <input
                className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 outline-none focus:border-slate-950"
                onChange={(event) => updateDraft("subject", event.target.value)}
                value={selectedDraft.subject}
              />
            </label>
            <label className="mt-3 grid gap-1 text-sm font-semibold text-slate-900">
              {text.previewText}
              <textarea
                className="min-h-20 rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 outline-none focus:border-slate-950"
                onChange={(event) => updateDraft("previewText", event.target.value)}
                value={selectedDraft.previewText}
              />
            </label>

            <div className="mt-4 rounded-lg border border-emerald-100 bg-emerald-50 p-4">
              <p className="text-sm font-semibold text-emerald-950">{text.recommendationTitle}</p>
              <p className="mt-2 break-words text-xs leading-5 text-emerald-900">
                {text.recommendationPrompt}
              </p>
            </div>

            <div className="mt-4 grid gap-3 lg:grid-cols-2">
              <div className="rounded-lg border border-stone-200 bg-stone-50 p-4">
                <p className="text-sm font-semibold text-slate-950">{text.snippets}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {[
                    { action: () => addSnippet("project"), label: text.addProjectSnippet },
                    { action: () => addSnippet("viewing"), label: text.addViewingSnippet },
                    { action: () => addSnippet("seller"), label: text.addSellerSnippet },
                    { action: () => addSnippet("feedback"), label: text.addFeedbackSnippet },
                  ].map((item) => (
                    <button
                      className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-slate-900 hover:border-emerald-200 hover:bg-emerald-50"
                      key={item.label}
                      onClick={item.action}
                      type="button"
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="rounded-lg border border-stone-200 bg-stone-50 p-4">
                <p className="text-sm font-semibold text-slate-950">{text.personalization}</p>
                <p className="mt-1 text-xs text-stone-500">{text.personalizationHint}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {personalizationTokens.map((token) => (
                    <span
                      className="rounded-md border border-stone-200 bg-white px-2 py-1 text-xs font-semibold text-slate-700"
                      key={token}
                    >
                      {token}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <p className="text-sm font-semibold text-slate-950">{text.contentBlocks}</p>
                <div className="flex flex-wrap gap-2">
                  {[
                    { action: addTextBlock, label: text.addTextBlock },
                    { action: addHeadingBlock, label: text.addHeadingBlock },
                    { action: addImageBlock, label: text.addImageBlock },
                    { action: addButtonBlock, label: text.addButtonBlock },
                    { action: addPropertyBlock, label: text.addPropertyBlock },
                    { action: addFeedbackBlock, label: text.addFeedbackBlock },
                    { action: addSocialBlock, label: text.addSocialBlock },
                    { action: addSpacerBlock, label: text.addSpacerBlock },
                    { action: addDividerBlock, label: text.addDividerBlock },
                  ].map((item) => (
                    <button
                      className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-slate-900 hover:border-emerald-200 hover:bg-emerald-50"
                      key={item.label}
                      onClick={item.action}
                      type="button"
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
              <p className="mt-2 text-xs text-stone-500">{text.imageHint}</p>
              <div className="mt-3 grid gap-3">
                {selectedDraft.contentBlocks.map((block, index) => (
                  <div
                    className="rounded-lg border border-stone-200 bg-stone-50 p-3"
                    key={block.id}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                        {index + 1}. {getBlockLabel(block, text)}
                      </p>
                      <button
                        className="rounded-md border border-stone-300 bg-white px-2 py-1 text-xs font-semibold text-stone-700 hover:border-red-200 hover:bg-red-50 hover:text-red-800"
                        onClick={() => removeBlock(block.id)}
                        type="button"
                      >
                        {text.removeBlock}
                      </button>
                    </div>

                    {block.type === "text" ? (
                      <textarea
                        className="mt-3 min-h-28 w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 outline-none focus:border-slate-950"
                        onChange={(event) =>
                          updateBlock(block.id, { ...block, text: event.target.value })
                        }
                        placeholder={text.blockPlaceholder}
                        value={block.text}
                      />
                    ) : null}

                    {block.type === "heading" ? (
                      <label className="mt-3 grid gap-1 text-sm font-semibold text-slate-900">
                        {text.headingText}
                        <input
                          className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 outline-none focus:border-slate-950"
                          onChange={(event) =>
                            updateBlock(block.id, { ...block, text: event.target.value })
                          }
                          placeholder={text.headingText}
                          value={block.text}
                        />
                      </label>
                    ) : null}

                    {block.type === "image" ? (
                      <div className="mt-3 grid gap-3">
                        <label className="grid gap-1 text-sm font-semibold text-slate-900">
                          {text.imageUrl}
                          <input
                            className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 outline-none focus:border-slate-950"
                            onChange={(event) =>
                              updateBlock(block.id, {
                                ...block,
                                imageUrl: event.target.value,
                              })
                            }
                            placeholder={text.imageUrlPlaceholder}
                            value={block.imageUrl}
                          />
                        </label>
                        <div className="grid gap-3 md:grid-cols-2">
                          <label className="grid gap-1 text-sm font-semibold text-slate-900">
                            {text.imageAlt}
                            <input
                              className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 outline-none focus:border-slate-950"
                              onChange={(event) =>
                                updateBlock(block.id, { ...block, alt: event.target.value })
                              }
                              placeholder={text.imageAltPlaceholder}
                              value={block.alt}
                            />
                          </label>
                          <label className="grid gap-1 text-sm font-semibold text-slate-900">
                            {text.imageCaption}
                            <input
                              className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 outline-none focus:border-slate-950"
                              onChange={(event) =>
                                updateBlock(block.id, { ...block, caption: event.target.value })
                              }
                              placeholder={text.imageCaptionPlaceholder}
                              value={block.caption}
                            />
                          </label>
                        </div>
                        <div
                          aria-label={block.alt || text.imageBlock}
                          className="min-h-44 rounded-md border border-dashed border-stone-300 bg-white bg-cover bg-center p-4 text-sm font-semibold text-stone-500"
                          role="img"
                          style={
                            block.imageUrl
                              ? { backgroundImage: `url("${block.imageUrl}")` }
                              : undefined
                          }
                        >
                          {block.imageUrl ? null : text.imageBlock}
                        </div>
                      </div>
                    ) : null}

                    {block.type === "button" ? (
                      <div className="mt-3 grid gap-3 md:grid-cols-2">
                        <label className="grid gap-1 text-sm font-semibold text-slate-900">
                          {text.buttonLabel}
                          <input
                            className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 outline-none focus:border-slate-950"
                            onChange={(event) =>
                              updateBlock(block.id, { ...block, label: event.target.value })
                            }
                            placeholder={text.buttonLabelPlaceholder}
                            value={block.label}
                          />
                        </label>
                        <label className="grid gap-1 text-sm font-semibold text-slate-900">
                          {text.buttonUrl}
                          <input
                            className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 outline-none focus:border-slate-950"
                            onChange={(event) =>
                              updateBlock(block.id, { ...block, url: event.target.value })
                            }
                            placeholder={text.buttonUrlPlaceholder}
                            value={block.url}
                          />
                        </label>
                      </div>
                    ) : null}

                    {block.type === "property" ? (
                      <div className="mt-3 grid gap-3">
                        <div className="grid gap-3 md:grid-cols-2">
                          <label className="grid gap-1 text-sm font-semibold text-slate-900">
                            {text.propertyTitle}
                            <input
                              className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 outline-none focus:border-slate-950"
                              onChange={(event) =>
                                updateBlock(block.id, { ...block, title: event.target.value })
                              }
                              placeholder={text.propertyTitlePlaceholder}
                              value={block.title}
                            />
                          </label>
                          <label className="grid gap-1 text-sm font-semibold text-slate-900">
                            {text.propertyLocation}
                            <input
                              className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 outline-none focus:border-slate-950"
                              onChange={(event) =>
                                updateBlock(block.id, { ...block, location: event.target.value })
                              }
                              placeholder={text.propertyLocationPlaceholder}
                              value={block.location}
                            />
                          </label>
                        </div>
                        <div className="grid gap-3 md:grid-cols-2">
                          <label className="grid gap-1 text-sm font-semibold text-slate-900">
                            {text.propertyPrice}
                            <input
                              className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 outline-none focus:border-slate-950"
                              onChange={(event) =>
                                updateBlock(block.id, { ...block, price: event.target.value })
                              }
                              placeholder={text.propertyPricePlaceholder}
                              value={block.price}
                            />
                          </label>
                          <label className="grid gap-1 text-sm font-semibold text-slate-900">
                            {text.buttonUrl}
                            <input
                              className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 outline-none focus:border-slate-950"
                              onChange={(event) =>
                                updateBlock(block.id, { ...block, ctaUrl: event.target.value })
                              }
                              placeholder={text.buttonUrlPlaceholder}
                              value={block.ctaUrl}
                            />
                          </label>
                        </div>
                        <label className="grid gap-1 text-sm font-semibold text-slate-900">
                          {text.propertyDetail}
                          <textarea
                            className="min-h-20 rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 outline-none focus:border-slate-950"
                            onChange={(event) =>
                              updateBlock(block.id, { ...block, detail: event.target.value })
                            }
                            placeholder={text.propertyDetailPlaceholder}
                            value={block.detail}
                          />
                        </label>
                        <label className="grid gap-1 text-sm font-semibold text-slate-900">
                          {text.buttonLabel}
                          <input
                            className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 outline-none focus:border-slate-950"
                            onChange={(event) =>
                              updateBlock(block.id, { ...block, ctaLabel: event.target.value })
                            }
                            placeholder={text.buttonLabelPlaceholder}
                            value={block.ctaLabel}
                          />
                        </label>
                      </div>
                    ) : null}

                    {block.type === "feedback" ? (
                      <label className="mt-3 grid gap-1 text-sm font-semibold text-slate-900">
                        {text.feedbackQuestion}
                        <input
                          className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 outline-none focus:border-slate-950"
                          onChange={(event) =>
                            updateBlock(block.id, { ...block, question: event.target.value })
                          }
                          placeholder={text.feedbackQuestionPlaceholder}
                          value={block.question}
                        />
                      </label>
                    ) : null}

                    {block.type === "social" ? (
                      <div className="mt-3 grid gap-3">
                        <label className="grid gap-1 text-sm font-semibold text-slate-900">
                          {text.socialWebsite}
                          <input
                            className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 outline-none focus:border-slate-950"
                            onChange={(event) =>
                              updateBlock(block.id, { ...block, website: event.target.value })
                            }
                            placeholder={text.buttonUrlPlaceholder}
                            value={block.website}
                          />
                        </label>
                        <label className="grid gap-1 text-sm font-semibold text-slate-900">
                          {text.socialInstagram}
                          <input
                            className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 outline-none focus:border-slate-950"
                            onChange={(event) =>
                              updateBlock(block.id, { ...block, instagram: event.target.value })
                            }
                            placeholder={text.buttonUrlPlaceholder}
                            value={block.instagram}
                          />
                        </label>
                        <label className="grid gap-1 text-sm font-semibold text-slate-900">
                          {text.socialLinkedin}
                          <input
                            className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 outline-none focus:border-slate-950"
                            onChange={(event) =>
                              updateBlock(block.id, { ...block, linkedin: event.target.value })
                            }
                            placeholder={text.buttonUrlPlaceholder}
                            value={block.linkedin}
                          />
                        </label>
                      </div>
                    ) : null}

                    {block.type === "spacer" ? (
                      <label className="mt-3 grid gap-1 text-sm font-semibold text-slate-900">
                        {text.spacerSize}
                        <select
                          className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 outline-none focus:border-slate-950"
                          onChange={(event) =>
                            updateBlock(block.id, {
                              ...block,
                              size: event.target.value as "small" | "medium" | "large",
                            })
                          }
                          value={block.size}
                        >
                          <option value="small">{text.small}</option>
                          <option value="medium">{text.medium}</option>
                          <option value="large">{text.large}</option>
                        </select>
                      </label>
                    ) : null}

                    {block.type === "divider" ? (
                      <div className="mt-4 border-t border-stone-300" />
                    ) : null}
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-4 rounded-lg border border-stone-200 bg-stone-50 p-4">
              <p className="text-sm font-semibold text-slate-950">{text.abTest}</p>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <label className="grid gap-1 text-sm font-semibold text-slate-900">
                  {text.variantA}
                  <input
                    className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm"
                    onChange={(event) => updateDraft("variantA", event.target.value)}
                    value={selectedDraft.variantA}
                  />
                </label>
                <label className="grid gap-1 text-sm font-semibold text-slate-900">
                  {text.variantB}
                  <input
                    className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm"
                    onChange={(event) => updateDraft("variantB", event.target.value)}
                    value={selectedDraft.variantB}
                  />
                </label>
              </div>
            </div>
          </article>

          <aside className="grid gap-4">
            <article className="rounded-lg border border-stone-200 bg-white p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="text-sm font-semibold text-slate-950">{text.finalPreview}</p>
                  <p className="mt-1 text-xs text-stone-500">{text.finishedEmail}</p>
                </div>
                <div className="grid grid-cols-3 rounded-md border border-stone-200 bg-stone-50 p-1 text-xs font-semibold">
                  {[
                    { id: "desktop" as const, label: text.desktopPreview },
                    { id: "mobile" as const, label: text.mobilePreview },
                    { id: "dark" as const, label: text.darkPreview },
                  ].map((item) => (
                    <button
                      className={`rounded px-3 py-1.5 ${
                        previewDevice === item.id
                          ? "bg-slate-950 text-white"
                          : "text-stone-600 hover:bg-white"
                      }`}
                      key={item.id}
                      onClick={() => setPreviewDevice(item.id)}
                      type="button"
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>

              <div
                className={`mt-3 rounded-lg border p-3 ${
                  previewIsDark
                    ? "border-slate-700 bg-slate-950"
                    : "border-stone-200 bg-stone-100"
                }`}
              >
                <div
                  className={`rounded-md border p-3 shadow-sm ${
                    previewIsDark
                      ? "border-slate-700 bg-slate-900"
                      : "border-stone-200 bg-white"
                  }`}
                >
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    {text.inboxPreview}
                  </p>
                  <div
                    className={`mt-2 grid gap-1 text-xs ${
                      previewIsDark ? "text-slate-300" : "text-stone-600"
                    }`}
                  >
                    <p className="break-words">
                      <span
                        className={`font-semibold ${
                          previewIsDark ? "text-white" : "text-slate-900"
                        }`}
                      >
                        {text.fromLine}:
                      </span>{" "}
                      {selectedDraft.fromName} &lt;{selectedDraft.fromEmail}&gt;
                    </p>
                    <p className="break-words">
                      <span
                        className={`font-semibold ${
                          previewIsDark ? "text-white" : "text-slate-900"
                        }`}
                      >
                        {text.toLine}:
                      </span>{" "}
                      {text.sampleRecipient}
                    </p>
                    <p
                      className={`break-words font-semibold ${
                        previewIsDark ? "text-white" : "text-slate-950"
                      }`}
                    >
                      {selectedDraft.subject || text.subject}
                    </p>
                    <p className={previewIsDark ? "break-words text-slate-400" : "break-words text-stone-500"}>
                      {selectedDraft.previewText || text.previewText}
                    </p>
                  </div>
                </div>

                <div
                  className={`mx-auto mt-3 overflow-hidden rounded-lg border shadow-sm transition-all ${previewCanvasClass} ${
                    previewIsDark
                      ? "border-slate-700 bg-slate-900"
                      : "border-stone-200 bg-white"
                  }`}
                >
                  <div className="bg-slate-950 px-5 py-4 text-white">
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-200">
                      Novalure
                    </p>
                    <p className="mt-1 break-words text-lg font-semibold">
                      {selectedCampaign?.campaign.name ?? text.finishedEmail}
                    </p>
                    <p className="mt-1 break-words text-xs text-slate-300">
                      {selectedCampaign?.segment?.name ?? text.noSegment}
                    </p>
                  </div>

                  <div className="px-5 py-5">
                    <span className="text-xs font-semibold text-emerald-700">
                      {text.browserVersion}
                    </span>
                    <h4
                      className={`mt-4 break-words text-2xl font-semibold leading-tight ${
                        previewIsDark ? "text-white" : "text-slate-950"
                      }`}
                    >
                      {selectedDraft.subject || text.subject}
                    </h4>
                    <p
                      className={`mt-3 break-words text-sm leading-6 ${
                        previewIsDark ? "text-slate-300" : "text-stone-600"
                      }`}
                    >
                      {selectedDraft.previewText || text.previewText}
                    </p>

                    <div className="mt-5 grid gap-4">
                      {selectedDraft.contentBlocks.map((block) => (
                        <div key={block.id}>
                          {block.type === "text" ? (
                            <p
                              className={`whitespace-pre-line break-words text-sm leading-6 ${
                                previewIsDark ? "text-slate-200" : "text-slate-800"
                              }`}
                            >
                              {block.text || text.blockPlaceholder}
                            </p>
                          ) : null}

                          {block.type === "heading" ? (
                            <h5
                              className={`break-words text-xl font-semibold leading-tight ${
                                previewIsDark ? "text-white" : "text-slate-950"
                              }`}
                            >
                              {block.text || text.headingText}
                            </h5>
                          ) : null}

                          {block.type === "image" ? (
                            <div>
                              <div
                                aria-label={block.alt || text.imageBlock}
                                className={`min-h-52 rounded-md border bg-cover bg-center p-4 text-sm font-semibold ${
                                  previewIsDark
                                    ? "border-slate-700 bg-slate-800 text-slate-400"
                                    : "border-stone-200 bg-stone-50 text-stone-500"
                                }`}
                                role="img"
                                style={
                                  block.imageUrl
                                    ? { backgroundImage: `url("${block.imageUrl}")` }
                                    : undefined
                                }
                              >
                                {block.imageUrl ? null : text.imageBlock}
                              </div>
                              {block.caption ? (
                                <p className="mt-2 break-words text-xs text-stone-500">
                                  {block.caption}
                                </p>
                              ) : null}
                            </div>
                          ) : null}

                          {block.type === "button" ? (
                            <div>
                              <span className="inline-flex rounded-md bg-slate-950 px-5 py-3 text-sm font-semibold text-white">
                                {block.label || text.buttonLabel}
                              </span>
                            </div>
                          ) : null}

                          {block.type === "property" ? (
                            <div
                              className={`rounded-lg border p-4 ${
                                previewIsDark
                                  ? "border-slate-700 bg-slate-800"
                                  : "border-stone-200 bg-stone-50"
                              }`}
                            >
                              <p
                                className={`break-words text-lg font-semibold ${
                                  previewIsDark ? "text-white" : "text-slate-950"
                                }`}
                              >
                                {block.title || text.propertyTitlePlaceholder}
                              </p>
                              <p className="mt-1 break-words text-sm font-semibold text-emerald-700">
                                {block.location || text.propertyLocationPlaceholder}
                              </p>
                              <p
                                className={`mt-2 break-words text-sm ${
                                  previewIsDark ? "text-slate-300" : "text-stone-600"
                                }`}
                              >
                                {block.detail || text.propertyDetailPlaceholder}
                              </p>
                              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                                <span
                                  className={`rounded-md px-3 py-2 text-sm font-semibold ${
                                    previewIsDark
                                      ? "bg-slate-700 text-white"
                                      : "bg-white text-slate-950"
                                  }`}
                                >
                                  {block.price || text.propertyPricePlaceholder}
                                </span>
                                <span className="rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white">
                                  {block.ctaLabel || text.buttonLabelPlaceholder}
                                </span>
                              </div>
                            </div>
                          ) : null}

                          {block.type === "feedback" ? (
                            <div
                              className={`rounded-lg border p-4 ${
                                previewIsDark
                                  ? "border-slate-700 bg-slate-800"
                                  : "border-stone-200 bg-stone-50"
                              }`}
                            >
                              <p
                                className={`break-words text-sm font-semibold ${
                                  previewIsDark ? "text-white" : "text-slate-950"
                                }`}
                              >
                                {block.question || text.feedbackQuestionPlaceholder}
                              </p>
                              <div className="mt-3 flex flex-wrap gap-2">
                                {["Ja", "Vielleicht", "Nein"].map((answer) => (
                                  <span
                                    className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-900"
                                    key={answer}
                                  >
                                    {answer}
                                  </span>
                                ))}
                              </div>
                            </div>
                          ) : null}

                          {block.type === "social" ? (
                            <div className="flex flex-wrap gap-2">
                              {[
                                [text.socialWebsite, block.website],
                                [text.socialInstagram, block.instagram],
                                [text.socialLinkedin, block.linkedin],
                              ]
                                .filter((item) => item[1])
                                .map(([label]) => (
                                  <span
                                    className={`rounded-md border px-3 py-2 text-xs font-semibold ${
                                      previewIsDark
                                        ? "border-slate-700 bg-slate-800 text-slate-200"
                                        : "border-stone-200 bg-stone-50 text-slate-700"
                                    }`}
                                    key={label}
                                  >
                                    {label}
                                  </span>
                                ))}
                            </div>
                          ) : null}

                          {block.type === "spacer" ? (
                            <div
                              className={
                                block.size === "large"
                                  ? "h-10"
                                  : block.size === "small"
                                    ? "h-3"
                                    : "h-6"
                              }
                            />
                          ) : null}

                          {block.type === "divider" ? (
                            <div
                              className={
                                previewIsDark
                                  ? "border-t border-slate-700"
                                  : "border-t border-stone-200"
                              }
                            />
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div
                    className={`border-t px-5 py-4 text-xs leading-5 ${
                      previewIsDark
                        ? "border-slate-700 bg-slate-950 text-slate-400"
                        : "border-stone-200 bg-stone-50 text-stone-500"
                    }`}
                  >
                    <p className="break-words">{text.footerNote}</p>
                    <p className="mt-2 break-words">{text.legalAddress}</p>
                    <div
                      className={`mt-3 flex flex-wrap gap-3 font-semibold ${
                        previewIsDark ? "text-slate-200" : "text-slate-700"
                      }`}
                    >
                      <span>{text.unsubscribeLink}</span>
                      <span>{text.replyTo}: {selectedDraft.replyTo}</span>
                    </div>
                  </div>
                </div>
              </div>
            </article>
            <article className="rounded-lg border border-stone-200 bg-white p-5">
              <p className="text-sm font-semibold text-slate-950">{text.checklist}</p>
              <div className="mt-3 grid gap-2">
                {checklist.map((item) => (
                  <div
                    className={`rounded-md border p-3 text-sm font-semibold ${
                      item.ready
                        ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                        : "border-amber-200 bg-amber-50 text-amber-900"
                    }`}
                    key={item.label}
                  >
                    {item.ready ? text.ready : text.review} · {item.label}
                  </div>
                ))}
              </div>
            </article>
          </aside>
        </section>
      ) : null}

      {activeArea === "segments" ? (
        <section className="grid gap-3 lg:grid-cols-2">
          {segments.map((segment) => (
            <article className="rounded-lg border border-stone-200 bg-white p-5" key={segment.id}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h4 className="break-words text-lg font-semibold">{segment.name}</h4>
                  <p className="mt-1 text-sm text-stone-500">
                    {segment.audience} · {segment.source} · {segment.language.toUpperCase()}
                  </p>
                </div>
                <span className={`rounded-md border px-2 py-1 text-xs font-semibold ${segmentHealthStyles[segment.health]}`}>
                  {segment.health}
                </span>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
                <div className="rounded-md bg-stone-50 p-3">
                  <p className="font-semibold">{formatNumber(segment.contacts, language)}</p>
                  <p className="text-xs text-stone-500">{text.recipients}</p>
                </div>
                <div className="rounded-md bg-stone-50 p-3">
                  <p className="font-semibold">{formatNumber(segment.optIns, language)}</p>
                  <p className="text-xs text-stone-500">{text.optIns}</p>
                </div>
              </div>
              <div className="mt-3 grid gap-2">
                {segment.rules.map((rule) => (
                  <p className="rounded-md bg-stone-50 p-2 text-sm text-stone-700" key={rule}>
                    {rule}
                  </p>
                ))}
              </div>
            </article>
          ))}
        </section>
      ) : null}

      {activeArea === "automations" ? (
        <section className="grid gap-3 lg:grid-cols-2">
          {automations.map((automation) => {
            const segment = segments.find((item) => item.id === automation.segmentId);

            return (
              <article className="rounded-lg border border-stone-200 bg-white p-5" key={automation.id}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h4 className="break-words text-lg font-semibold">{automation.name}</h4>
                    <p className="mt-1 break-words text-sm text-stone-500">
                      {text.trigger}: {automation.trigger}
                    </p>
                  </div>
                  <span className={`rounded-md border px-2 py-1 text-xs font-semibold ${automationStyles[automation.status]}`}>
                    {automation.status}
                  </span>
                </div>
                <p className="mt-3 break-words rounded-md bg-blue-50 p-3 text-sm font-semibold text-blue-900">
                  {text.goal}: {automation.goal}
                </p>
                <p className="mt-3 text-sm text-stone-600">
                  {text.segment}: {segment?.name ?? text.noSegment}
                </p>
                <div className="mt-3 grid gap-2">
                  {automation.steps.map((step) => (
                    <div className="rounded-md border border-stone-200 p-3 text-sm" key={`${automation.id}-${step.delay}`}>
                      <p className="font-semibold">{step.delay} · {step.channel}</p>
                      <p className="mt-1 break-words text-stone-600">{step.action}</p>
                    </div>
                  ))}
                </div>
              </article>
            );
          })}
        </section>
      ) : null}

      {activeArea === "analytics" ? (
        <section className="grid gap-4 xl:grid-cols-[1fr_360px]">
          <article className="rounded-lg border border-stone-200 bg-white p-5">
            <h4 className="text-lg font-semibold">{text.analytics}</h4>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse text-left text-sm">
                <thead className="border-b border-stone-200 text-xs uppercase tracking-[0.12em] text-stone-500">
                  <tr>
                    <th className="py-2 pr-3 font-semibold">{text.campaigns}</th>
                    <th className="py-2 pr-3 font-semibold">{text.recipients}</th>
                    <th className="py-2 pr-3 font-semibold">{text.openRate}</th>
                    <th className="py-2 pr-3 font-semibold">{text.clickRate}</th>
                    <th className="py-2 pr-3 font-semibold">{text.bounceRate}</th>
                    <th className="py-2 font-semibold">{text.unsubscribeRate}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {campaigns.map((campaign) => (
                    <tr key={campaign.id}>
                      <td className="py-3 pr-3 font-semibold">{campaign.name}</td>
                      <td className="py-3 pr-3">{formatNumber(campaign.recipients, language)}</td>
                      <td className="py-3 pr-3">{formatPercent(campaign.openRate, language, text.noMetric)}</td>
                      <td className="py-3 pr-3">{formatPercent(campaign.clickRate, language, text.noMetric)}</td>
                      <td className="py-3 pr-3">{formatPercent(campaign.bounceRate, language, text.noMetric)}</td>
                      <td className="py-3">{formatPercent(campaign.unsubscribeRate, language, text.noMetric)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>
          <article className="rounded-lg border border-stone-200 bg-white p-5">
            <h4 className="text-lg font-semibold">{text.suppressions}</h4>
            <div className="mt-4 grid gap-2">
              {suppressions.map((item) => (
                <div className="rounded-md border border-stone-200 p-3 text-sm" key={item.id}>
                  <p className="break-words font-semibold">{item.email}</p>
                  <p className="mt-1 text-xs text-stone-500">
                    {item.reason} · {item.source}
                  </p>
                </div>
              ))}
            </div>
          </article>
        </section>
      ) : null}

      {activeArea === "deliverability" ? (
        <section className="grid gap-3 lg:grid-cols-2">
          {deliverability.map((sender) => (
            <article className="rounded-lg border border-stone-200 bg-white p-5" key={sender.id}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h4 className="break-words text-lg font-semibold">{sender.fromEmail}</h4>
                  <p className="mt-1 text-sm text-stone-500">{sender.domain}</p>
                </div>
                <span className={`rounded-md border px-2 py-1 text-xs font-semibold ${deliverabilityStyles[sender.status]}`}>
                  {sender.status}
                </span>
              </div>
              <div className="mt-4 grid grid-cols-3 gap-2 text-sm">
                {[
                  [text.spf, sender.spf],
                  [text.dkim, sender.dkim],
                  [text.dmarc, sender.dmarc],
                ].map(([label, value]) => (
                  <div className="rounded-md bg-stone-50 p-3" key={label}>
                    <p className="font-semibold">{value}</p>
                    <p className="text-xs text-stone-500">{label}</p>
                  </div>
                ))}
              </div>
              <div className="mt-4 grid grid-cols-3 gap-2 text-sm">
                <div className="rounded-md bg-stone-50 p-3">
                  <p className="font-semibold">{formatPercent(sender.bounceRate, language, "-")}</p>
                  <p className="text-xs text-stone-500">{text.bounceRate}</p>
                </div>
                <div className="rounded-md bg-stone-50 p-3">
                  <p className="font-semibold">{formatPercent(sender.complaintRate, language, "-")}</p>
                  <p className="text-xs text-stone-500">{text.complaintRate}</p>
                </div>
                <div className="rounded-md bg-stone-50 p-3">
                  <p className="font-semibold">{sender.reputationScore}</p>
                  <p className="text-xs text-stone-500">{text.reputation}</p>
                </div>
              </div>
              <div className="mt-4 rounded-lg bg-slate-950 p-4 text-white">
                <p className="text-sm font-semibold">{text.resendMapping}</p>
                <div className="mt-3 grid gap-2 text-xs text-slate-200">
                  <span>from · {sender.fromEmail}</span>
                  <span>audienceId · {selectedCampaign?.segment?.resendAudienceId ?? "-"}</span>
                  <span>subject · {selectedDraft.subject || "-"}</span>
                  <span>unsubscribe · {"{{{RESEND_UNSUBSCRIBE_URL}}}"}</span>
                </div>
              </div>
            </article>
          ))}
        </section>
      ) : null}

      <article className="rounded-lg border border-emerald-100 bg-emerald-50 p-4 text-sm text-emerald-950">
        <span className="font-semibold">{text.consentSafe}:</span> {newsletterOptIns.length}{" "}
        Newsletter Opt-ins im aktuellen Projektfilter.
      </article>
    </section>
  );
}
