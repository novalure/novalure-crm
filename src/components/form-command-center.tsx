"use client";

import { useEffect, useState } from "react";
import { FormRuntimeClient } from "@/components/form-runtime-client";
import type { CalendarEvent, Contact, Funnel, Lead, Project, Task, WorkspaceUser } from "@/lib/crm-types";
import {
  createFormField,
  formLayoutVariants,
  formPublishVariants,
  isFormPublishVariant,
  isNumericFieldType,
  isOptionFieldType,
  type FormField,
  type FormFieldType,
  type FormProgressMode,
  type FormsRuntimePayload,
  type FormStep,
  type FormStatus,
  type FormSubmissionSummary,
  type FormTarget,
  type FormTemplate,
  type WebsiteForm,
} from "@/lib/form-types";
import { getFormCommandCenterCopy, getLocale, type LanguageCode } from "@/lib/i18n";

type FormCommandCenterProps = {
  contacts: Contact[];
  events: CalendarEvent[];
  funnels: Funnel[];
  language: LanguageCode;
  leads: Lead[];
  projectLabel: string;
  projects: Project[];
  tasks: Task[];
  users: WorkspaceUser[];
  workspacePublicKey?: string;
};

type FormTab = "overview" | "builder" | "crm" | "embed" | "automation" | "submissions";
type Platform = "wordpress" | "webflow" | "shopify" | "wix" | "custom";
type FormCommandCenterCopy = ReturnType<typeof getFormCommandCenterCopy>;

const statusStyles: Record<FormStatus, string> = {
  aktiv: "border-emerald-200 bg-emerald-50 text-emerald-900",
  eingebaut: "border-blue-200 bg-blue-50 text-blue-900",
  entwurf: "border-stone-200 bg-stone-50 text-stone-700",
  fehler: "border-red-200 bg-red-50 text-red-900",
};

const formStatusIds: FormStatus[] = ["entwurf", "aktiv", "eingebaut", "fehler"];

const formTemplateIds: FormTemplate[] = [
  "sellerValuation",
  "buyerProfile",
  "investorProfile",
  "viewing",
  "projectExpose",
  "consultation",
  "contact",
  "leadMagnet",
  "newsletter",
  "support",
];

const formTargetIds: FormTarget[] = ["contact", "deal", "lead", "ticket"];

const fieldTypeIds = [
  "text",
  "email",
  "phone",
  "company",
  "textarea",
  "select",
  "radio",
  "multiCheckbox",
  "number",
  "range",
  "rating",
  "date",
  "time",
  "url",
  "file",
  "checkbox",
  "consent",
  "hidden",
] as const satisfies readonly FormFieldType[];

type PreviewDevice = "desktop" | "tablet" | "mobile";

const platformIds: Platform[] = ["wordpress", "webflow", "shopify", "wix", "custom"];

function uniqueBuilderId(prefix: string) {
  return `${prefix}_${new Date().getTime()}_${Math.random().toString(16).slice(2)}`;
}

function createStep(title: string, description = "", id = uniqueBuilderId("step")): FormStep {
  return { description, id, title };
}

function createContactStep() {
  return createStep("Kontakt", "", "step_contact");
}

function defaultFieldOptions(type: FormFieldType) {
  if (type === "select" || type === "radio") return ["Wohnung", "Haus", "Grundstück"];
  if (type === "multiCheckbox") return ["Graz", "Wien", "Umland", "Online"];
  return [];
}

function defaultCrmField(type: FormFieldType) {
  const fields: Record<FormFieldType, string> = {
    checkbox: "consent_detail",
    company: "company",
    consent: "privacy_consent",
    date: "preferred_date",
    email: "email",
    file: "attachment",
    hidden: "utm_content",
    multiCheckbox: "preferences",
    number: "budget",
    phone: "phone",
    radio: "interest",
    range: "priority",
    rating: "rating",
    select: "property_type",
    text: "name",
    textarea: "message",
    time: "preferred_time",
    url: "website",
  };
  return fields[type];
}

function createField(
  type: FormFieldType,
  copy: FormCommandCenterCopy,
  stepId = "step_contact",
  patch: Partial<FormField> = {},
): FormField {
  const labels: Record<FormFieldType, string> = {
    checkbox: copy.fieldTypes.checkbox,
    company: copy.fieldTypes.company,
    consent: copy.fields.consentLabel,
    date: copy.fieldTypes.date,
    email: copy.fieldTypes.email,
    file: copy.fieldTypes.file,
    hidden: copy.fieldTypes.hidden,
    multiCheckbox: copy.fieldTypes.multiCheckbox,
    number: copy.fieldTypes.number,
    phone: copy.fieldTypes.phone,
    radio: copy.fieldTypes.radio,
    range: copy.fieldTypes.range,
    rating: copy.fieldTypes.rating,
    select: copy.fieldTypes.select,
    text: copy.fieldTypes.text,
    textarea: copy.fieldTypes.textarea,
    time: copy.fieldTypes.time,
    url: copy.fieldTypes.url,
  };

  return createFormField({
    crmField: patch.crmField ?? defaultCrmField(type),
    defaultValue: patch.defaultValue ?? "",
    errorMessage: patch.errorMessage ?? "",
    fileAccept: patch.fileAccept ?? (type === "file" ? ".pdf,.jpg,.jpeg,.png,.doc,.docx" : ""),
    fileMaxMb: patch.fileMaxMb ?? (type === "file" ? 10 : 0),
    helpText: patch.helpText ?? (type === "consent" ? copy.fields.consentHelp : ""),
    id: patch.id ?? uniqueBuilderId(`form_field_${type}`),
    label: patch.label ?? labels[type],
    maxValue: patch.maxValue ?? (type === "rating" ? "5" : type === "range" ? "100" : ""),
    minValue: patch.minValue ?? (type === "rating" || type === "range" ? "1" : ""),
    multiple: patch.multiple ?? false,
    options: patch.options ?? defaultFieldOptions(type),
    placeholder:
      patch.placeholder ??
      (type === "email" ? copy.fields.emailPlaceholder : type === "phone" ? copy.fields.phonePlaceholder : ""),
    required: patch.required ?? (type === "email" || type === "consent"),
    stepId: patch.stepId ?? stepId,
    type,
    validationPattern: patch.validationPattern ?? "",
  });
}

function ensureFormStructure(form: WebsiteForm, copy: FormCommandCenterCopy): WebsiteForm {
  const steps = form.steps?.length ? form.steps : [createContactStep()];
  const firstStepId = steps[0]?.id ?? "step_contact";

  return {
    ...form,
    fields: form.fields.map((field) =>
      createFormField({
        ...field,
        crmField: field.crmField || defaultCrmField(field.type),
        id: field.id,
        label: field.label || copy.fieldTypes[field.type],
        stepId: field.type === "hidden" ? "" : field.stepId || firstStepId,
      }),
    ),
    progressMode: form.progressMode ?? "none",
    slug: form.slug || slugify(form.name),
    steps,
  };
}

function createTemplateParts(
  template: FormTemplate,
  copy: FormCommandCenterCopy,
): Pick<WebsiteForm, "actions" | "crmTarget" | "doubleOptIn" | "fields" | "progressMode" | "steps" | "template"> {
  const contact = createStep("Kontakt", "Kontaktdaten für die Rückmeldung.", "step_contact");
  const details = createStep("Details", "Qualifizierung für das passende CRM-Follow-up.", "step_details");
  const timing = createStep("Termin", "Zeitfenster und nächster Schritt.", "step_timing");
  const baseActions: WebsiteForm["actions"] = {
    createTask: true,
    followUpEmail: true,
    internalNotification: true,
    newsletterList: false,
    redirectUrl: "",
    showMeeting: template === "consultation" || template === "viewing",
    thankYouMessage:
      template === "newsletter"
        ? copy.defaults.thankYouNewsletter
        : template === "support"
          ? copy.defaults.thankYouSupport
          : copy.defaults.thankYouConsultation,
  };

  if (template === "sellerValuation") {
    return {
      actions: { ...baseActions, showMeeting: true },
      crmTarget: "lead",
      doubleOptIn: false,
      fields: [
        createField("text", copy, contact.id, { crmField: "name", label: "Name", required: true }),
        createField("email", copy, contact.id, { crmField: "email", required: true }),
        createField("phone", copy, contact.id, { crmField: "phone", required: true }),
        createField("select", copy, details.id, {
          crmField: "property_type",
          label: "Immobilientyp",
          options: ["Wohnung", "Haus", "Grundstück", "Zinshaus", "Gewerbe"],
          required: true,
        }),
        createField("text", copy, details.id, { crmField: "property_address", label: "Objektadresse", placeholder: "Ort, Straße oder Bezirk" }),
        createField("number", copy, details.id, { crmField: "living_area", label: "Wohnfläche m²", minValue: "1" }),
        createField("select", copy, details.id, {
          crmField: "selling_timeline",
          label: "Verkaufszeitraum",
          options: ["Sofort", "1-3 Monate", "3-6 Monate", "Später"],
        }),
        createField("textarea", copy, timing.id, { crmField: "message", label: "Hinweise zum Objekt", placeholder: "Zustand, Besonderheiten, Wunschpreis" }),
        createField("consent", copy, timing.id),
      ],
      progressMode: "steps",
      steps: [contact, details, timing],
      template,
    };
  }

  if (template === "buyerProfile") {
    return {
      actions: { ...baseActions, showMeeting: true },
      crmTarget: "lead",
      doubleOptIn: false,
      fields: [
        createField("text", copy, contact.id, { crmField: "name", label: "Name", required: true }),
        createField("email", copy, contact.id, { crmField: "email", required: true }),
        createField("phone", copy, contact.id, { crmField: "phone" }),
        createField("select", copy, details.id, {
          crmField: "property_type",
          label: "Gesuchte Immobilie",
          options: ["Wohnung", "Haus", "Penthouse", "Anlageobjekt", "Grundstück"],
          required: true,
        }),
        createField("multiCheckbox", copy, details.id, {
          crmField: "search_regions",
          label: "Suchregionen",
          options: ["Graz", "Wien", "Linz", "Salzburg", "Umland"],
        }),
        createField("number", copy, details.id, { crmField: "budget", label: "Budget", minValue: "0", placeholder: "500000" }),
        createField("number", copy, details.id, { crmField: "rooms", label: "Zimmer", minValue: "1" }),
        createField("consent", copy, timing.id),
      ],
      progressMode: "percent",
      steps: [contact, details, timing],
      template,
    };
  }

  if (template === "investorProfile") {
    return {
      actions: baseActions,
      crmTarget: "lead",
      doubleOptIn: false,
      fields: [
        createField("text", copy, contact.id, { crmField: "name", label: "Name", required: true }),
        createField("email", copy, contact.id, { crmField: "email", required: true }),
        createField("phone", copy, contact.id, { crmField: "phone" }),
        createField("company", copy, contact.id, { crmField: "company", label: "Firma / Family Office" }),
        createField("number", copy, details.id, { crmField: "investment_volume", label: "Investmentvolumen", minValue: "0" }),
        createField("select", copy, details.id, {
          crmField: "investment_strategy",
          label: "Strategie",
          options: ["Core", "Core Plus", "Value Add", "Projektentwicklung", "Bestand"],
          required: true,
        }),
        createField("multiCheckbox", copy, details.id, {
          crmField: "asset_classes",
          label: "Assetklassen",
          options: ["Wohnen", "Gewerbe", "Grundstück", "Mikroapartments", "Mixed Use"],
        }),
        createField("consent", copy, timing.id),
      ],
      progressMode: "steps",
      steps: [contact, details, timing],
      template,
    };
  }

  if (template === "viewing") {
    return {
      actions: { ...baseActions, showMeeting: true },
      crmTarget: "lead",
      doubleOptIn: false,
      fields: [
        createField("text", copy, contact.id, { crmField: "name", label: "Name", required: true }),
        createField("email", copy, contact.id, { crmField: "email", required: true }),
        createField("phone", copy, contact.id, { crmField: "phone", required: true }),
        createField("date", copy, timing.id, { crmField: "preferred_date", label: "Wunschdatum", required: true }),
        createField("time", copy, timing.id, { crmField: "preferred_time", label: "Wunschzeit" }),
        createField("textarea", copy, timing.id, { crmField: "message", label: "Notiz", placeholder: "Objekt, Personenanzahl oder Rückfragen" }),
        createField("consent", copy, timing.id),
      ],
      progressMode: "steps",
      steps: [contact, timing],
      template,
    };
  }

  if (template === "projectExpose") {
    return {
      actions: { ...baseActions, followUpEmail: true, newsletterList: true },
      crmTarget: "lead",
      doubleOptIn: true,
      fields: [
        createField("text", copy, contact.id, { crmField: "name", label: "Name", required: true }),
        createField("email", copy, contact.id, { crmField: "email", required: true }),
        createField("phone", copy, contact.id, { crmField: "phone" }),
        createField("radio", copy, details.id, {
          crmField: "interest",
          label: "Interesse",
          options: ["Exposé erhalten", "Beratung buchen", "Preisliste anfragen"],
          required: true,
        }),
        createField("checkbox", copy, details.id, {
          crmField: "marketing_consent",
          helpText: "Ich möchte Updates zu diesem Projekt erhalten.",
          label: "Projekt-Updates",
        }),
        createField("consent", copy, details.id),
      ],
      progressMode: "steps",
      steps: [contact, details],
      template,
    };
  }

  const simpleSteps = [contact];
  const simpleFields: Record<FormTemplate, FormField[]> = {
    buyerProfile: [],
    consultation: [
      createField("text", copy, contact.id, { crmField: "name", label: "Name", required: true }),
      createField("email", copy, contact.id, { crmField: "email", required: true }),
      createField("phone", copy, contact.id, { crmField: "phone" }),
      createField("textarea", copy, contact.id, { crmField: "message", label: "Nachricht", placeholder: "Worum geht es?" }),
      createField("consent", copy, contact.id),
    ],
    contact: [
      createField("text", copy, contact.id, { crmField: "name", label: "Name", required: true }),
      createField("email", copy, contact.id, { crmField: "email", required: true }),
      createField("phone", copy, contact.id, { crmField: "phone" }),
      createField("textarea", copy, contact.id, { crmField: "message", label: "Nachricht" }),
      createField("consent", copy, contact.id),
    ],
    investorProfile: [],
    leadMagnet: [
      createField("text", copy, contact.id, { crmField: "name", label: "Name" }),
      createField("email", copy, contact.id, { crmField: "email", required: true }),
      createField("company", copy, contact.id, { crmField: "company" }),
      createField("hidden", copy, "", { crmField: "lead_magnet", defaultValue: "download" }),
      createField("consent", copy, contact.id),
    ],
    newsletter: [
      createField("email", copy, contact.id, { crmField: "email", required: true }),
      createField("checkbox", copy, contact.id, {
        crmField: "marketing_consent",
        helpText: "Ich möchte regelmäßig Immobilien-Updates erhalten.",
        label: "Newsletter",
        required: true,
      }),
      createField("consent", copy, contact.id),
    ],
    projectExpose: [],
    sellerValuation: [],
    support: [
      createField("text", copy, contact.id, { crmField: "name", label: "Name", required: true }),
      createField("email", copy, contact.id, { crmField: "email", required: true }),
      createField("textarea", copy, contact.id, { crmField: "message", label: "Anliegen", required: true }),
      createField("file", copy, contact.id, { crmField: "attachment", label: "Anhang", multiple: true }),
      createField("consent", copy, contact.id),
    ],
    viewing: [],
  };

  return {
    actions: {
      ...baseActions,
      createTask: template !== "newsletter",
      newsletterList: template === "newsletter",
      showMeeting: template === "consultation",
    },
    crmTarget: template === "newsletter" ? "contact" : template === "support" ? "ticket" : "lead",
    doubleOptIn: template === "newsletter",
    fields: simpleFields[template].length ? simpleFields[template] : simpleFields.contact,
    progressMode: "none",
    steps: simpleSteps,
    template,
  };
}

function createInitialForms(
  users: WorkspaceUser[],
  funnels: Funnel[],
  copy: FormCommandCenterCopy,
): WebsiteForm[] {
  const ownerId = users[0]?.id ?? "";
  const primaryFunnelId = funnels[0]?.id ?? "";
  const consultation = createTemplateParts("consultation", copy);
  const newsletter = createTemplateParts("newsletter", copy);
  const support = createTemplateParts("support", copy);

  const initialForms: WebsiteForm[] = [
    {
      actions: consultation.actions,
      campaign: "Wohnpark Graz Launch",
      conversionRate: 4.8,
      crmTarget: consultation.crmTarget,
      doubleOptIn: consultation.doubleOptIn,
      fields: consultation.fields,
      funnelId: primaryFunnelId,
      id: "form_beratung_wohnpark",
      lastSubmission: "2026-05-13T17:12:00+02:00",
      name: "Wohnpark Graz Beratung",
      ownerMode: "roundRobin",
      ownerUserId: ownerId,
      pipelineStage: "Lead Inbox",
      progressMode: consultation.progressMode,
      spamProtection: true,
      status: "eingebaut",
      steps: consultation.steps,
      submissions: 42,
      slug: "wohnpark-graz-beratung",
      tags: "wohnpark, website, beratung",
      template: consultation.template,
      utmCapture: true,
      variant: "embed",
      visits: 875,
    },
    {
      actions: newsletter.actions,
      campaign: "Novalure Newsletter",
      conversionRate: 7.2,
      crmTarget: newsletter.crmTarget,
      doubleOptIn: newsletter.doubleOptIn,
      fields: newsletter.fields,
      funnelId: funnels.find((funnel) => funnel.entryChannel === "Newsletter")?.id ?? primaryFunnelId,
      id: "form_newsletter_optin",
      lastSubmission: "2026-05-13T15:44:00+02:00",
      name: "Newsletter Opt-in Website",
      ownerMode: "user",
      ownerUserId: ownerId,
      pipelineStage: "Newsletter Segment",
      progressMode: newsletter.progressMode,
      spamProtection: true,
      status: "aktiv",
      steps: newsletter.steps,
      submissions: 118,
      slug: "newsletter-opt-in-website",
      tags: "newsletter, optin",
      template: newsletter.template,
      utmCapture: true,
      variant: "stickyBottom",
      visits: 1638,
    },
    {
      actions: support.actions,
      campaign: "Support Anfrage",
      conversionRate: 0,
      crmTarget: support.crmTarget,
      doubleOptIn: support.doubleOptIn,
      fields: support.fields,
      funnelId: primaryFunnelId,
      id: "form_support_ticket",
      lastSubmission: "",
      name: "Support Ticket Formular",
      ownerMode: "user",
      ownerUserId: ownerId,
      pipelineStage: "Support neu",
      progressMode: support.progressMode,
      spamProtection: false,
      status: "entwurf",
      steps: support.steps,
      submissions: 0,
      slug: "support-ticket-formular",
      tags: "support, ticket",
      template: support.template,
      utmCapture: false,
      variant: "standalone",
      visits: 0,
    },
  ];

  return initialForms.map((form) => ensureFormStructure(form, copy));
}

function createNewForm(
  users: WorkspaceUser[],
  funnels: Funnel[],
  copy: FormCommandCenterCopy,
): WebsiteForm {
  const parts = createTemplateParts("consultation", copy);
  return {
    ...createInitialForms(users, funnels, copy)[0],
    actions: parts.actions,
    campaign: copy.defaults.campaignNew,
    conversionRate: 0,
    fields: parts.fields,
    id: `form_new_${new Date().getTime()}`,
    lastSubmission: "",
    name: copy.defaults.newForm,
    progressMode: parts.progressMode,
    status: "entwurf",
    steps: parts.steps,
    submissions: 0,
    tags: copy.defaults.tagsNew,
    template: parts.template,
    visits: 0,
  };
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function formatDateTime(value: string, language: LanguageCode, copy: FormCommandCenterCopy) {
  if (!value) return copy.defaults.noSubmission;

  return new Intl.DateTimeFormat(getLocale(language), {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
  }).format(new Date(value));
}

function formatPercent(value: number, language: LanguageCode) {
  return `${new Intl.NumberFormat(getLocale(language), {
    maximumFractionDigits: 1,
    minimumFractionDigits: 1,
  }).format(value)}%`;
}

export function FormCommandCenter({
  contacts,
  events,
  funnels,
  language,
  leads,
  projectLabel,
  projects,
  tasks,
  users,
  workspacePublicKey,
}: FormCommandCenterProps) {
  const copy = getFormCommandCenterCopy(language);
  const variantLabels = copy.variants;
  const templateLabels = copy.templates;
  const targetLabels = copy.targets;
  const fieldTypes = fieldTypeIds.map((id) => ({ id, label: copy.fieldTypes[id] }));
  const platformInstructions = copy.platformInstructions;
  const [forms, setForms] = useState<WebsiteForm[]>(() => createInitialForms(users, funnels, copy));
  const [selectedFormId, setSelectedFormId] = useState("form_beratung_wohnpark");
  const [activeTab, setActiveTab] = useState<FormTab>("overview");
  const [platform, setPlatform] = useState<Platform>("wordpress");
  const [installStatus, setInstallStatus] = useState<"idle" | "detected" | "missing">("idle");
  const [submissionRows, setSubmissionRows] = useState<FormSubmissionSummary[]>([]);
  const [persistenceSource, setPersistenceSource] = useState<"local" | "database" | "fallback">("local");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [selectedFieldId, setSelectedFieldId] = useState("");
  const [previewDevice, setPreviewDevice] = useState<PreviewDevice>("desktop");
  const selectedForm = forms.find((form) => form.id === selectedFormId) ?? forms[0];
  const selectedSteps = selectedForm?.steps?.length ? selectedForm.steps : [createContactStep()];
  const selectedFunnel = funnels.find((funnel) => funnel.id === selectedForm?.funnelId);
  const linkedMeeting = events.find((event) => event.projectId === selectedFunnel?.projectId);
  const totalSubmissions = forms.reduce((sum, form) => sum + form.submissions, 0);
  const totalVisits = forms.reduce((sum, form) => sum + form.visits, 0);
  const averageConversion = totalVisits > 0 ? (totalSubmissions / totalVisits) * 100 : 0;
  const readyForms = forms.filter((form) => form.status === "aktiv" || form.status === "eingebaut").length;
  const relatedLeads = selectedFunnel ? leads.filter((lead) => lead.projectId === selectedFunnel.projectId) : leads.slice(0, 4);
  const relatedTasks = selectedFunnel ? tasks.filter((task) => task.projectId === selectedFunnel.projectId) : tasks.slice(0, 3);
  const selectedSubmissionRows = selectedForm ? submissionRows.filter((row) => row.formId === selectedForm.id) : [];
  const selectedField =
    selectedForm?.fields.find((field) => field.id === selectedFieldId) ?? selectedForm?.fields[0];
  const selectedOwner = users.find((user) => user.id === selectedForm?.ownerUserId);
  const isFormEditorMode = activeTab === "builder";
  const backToFormsLabel = copy.backToForms;
  const formEditorLabel = copy.formEditor;
  const selectedWorkspacePublicKey = selectedForm?.workspacePublicKey || workspacePublicKey || "";
  const selectedFormSlug = selectedForm ? selectedForm.slug || slugify(selectedForm.name) : "";
  const publicPath = selectedForm
    ? selectedWorkspacePublicKey
      ? `/forms/${encodeURIComponent(selectedWorkspacePublicKey)}/${encodeURIComponent(selectedFormSlug)}`
      : `/forms/${encodeURIComponent(selectedFormSlug)}`
    : "";
  const publicFormKey =
    selectedForm && selectedWorkspacePublicKey
      ? `${selectedWorkspacePublicKey}/${selectedFormSlug}`
      : selectedForm?.id || "";
  const publicUrl =
    selectedForm && typeof window === "undefined"
      ? publicPath
      : selectedForm
        ? `${window.location.origin}${publicPath}`
        : "";
  const embedCode = selectedForm
    ? `<script src="${typeof window === "undefined" ? "" : window.location.origin}/forms/embed?form=${selectedForm.id}&variant=${selectedForm.variant}&campaign=${encodeURIComponent(selectedForm.campaign)}"></script>`
    : "";
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(publicUrl)}`;
  const tabs: Array<{ id: FormTab; label: string }> = [
    { id: "overview", label: copy.tabs.overview },
    { id: "builder", label: copy.tabs.builder },
    { id: "crm", label: copy.tabs.crm },
    { id: "embed", label: copy.tabs.embed },
    { id: "automation", label: copy.tabs.automation },
    { id: "submissions", label: copy.tabs.submissions },
  ];

  useEffect(() => {
    let cancelled = false;

    async function loadPersistedForms() {
      try {
        const response = await fetch("/api/forms", { cache: "no-store" });
        if (!response.ok) {
          setPersistenceSource("fallback");
          return;
        }

        const payload = (await response.json()) as FormsRuntimePayload;
        if (cancelled) return;

        setSubmissionRows(payload.submissions ?? []);
        setPersistenceSource(payload.source);

        if (payload.forms.length) {
          const normalizedForms = payload.forms.map((form) => ensureFormStructure(form, copy));
          setForms(normalizedForms);
          setSelectedFormId(normalizedForms[0].id);
        }
      } catch {
        if (!cancelled) setPersistenceSource("fallback");
      }
    }

    loadPersistedForms();

    return () => {
      cancelled = true;
    };
  }, [copy]);

  useEffect(() => {
    if (!isFormEditorMode) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isFormEditorMode]);

  function updateSelectedForm(patch: Partial<WebsiteForm>) {
    if (!selectedForm) return;
    setSaveStatus("idle");
    setForms((current) => current.map((form) => (form.id === selectedForm.id ? { ...form, ...patch } : form)));
  }

  function updateField(fieldId: string, patch: Partial<FormField>) {
    if (!selectedForm) return;
    updateSelectedForm({
      fields: selectedForm.fields.map((field) => (field.id === fieldId ? { ...field, ...patch } : field)),
    });
  }

  function addField(type: FormFieldType) {
    if (!selectedForm) return;
    const field = createField(type, copy, selectedField?.stepId || selectedSteps[0]?.id || "step_contact");
    updateSelectedForm({ fields: [...selectedForm.fields, field] });
    setSelectedFieldId(field.id);
  }

  function addStep() {
    if (!selectedForm) return;
    const nextStep = createStep(`${copy.builder.steps} ${selectedSteps.length + 1}`);
    updateSelectedForm({
      progressMode: selectedForm.progressMode === "none" ? "steps" : selectedForm.progressMode,
      steps: [...selectedSteps, nextStep],
    });
  }

  function updateStep(stepId: string, patch: Partial<FormStep>) {
    if (!selectedForm) return;
    updateSelectedForm({
      steps: selectedSteps.map((step) => (step.id === stepId ? { ...step, ...patch } : step)),
    });
  }

  function removeField(fieldId: string) {
    if (!selectedForm || selectedForm.fields.length <= 1) return;
    const nextFields = selectedForm.fields.filter((field) => field.id !== fieldId);
    updateSelectedForm({ fields: nextFields });
    if (selectedFieldId === fieldId) setSelectedFieldId(nextFields[0]?.id ?? "");
  }

  function addForm() {
    const form = createNewForm(users, funnels, copy);
    setForms((current) => [form, ...current]);
    setSelectedFormId(form.id);
    setActiveTab("builder");
    setInstallStatus("idle");
    setSaveStatus("idle");
    setSelectedFieldId(form.fields[0]?.id ?? "");
  }

  function applyTemplate(template: FormTemplate) {
    const parts = createTemplateParts(template, copy);

    updateSelectedForm({
      actions: parts.actions,
      crmTarget: parts.crmTarget,
      doubleOptIn: parts.doubleOptIn,
      fields: parts.fields,
      progressMode: parts.progressMode,
      steps: parts.steps,
      template,
    });
    setSelectedFieldId(parts.fields[0]?.id ?? "");
  }

  async function saveSelectedForm() {
    if (!selectedForm) return;
    setSaveStatus("saving");

    try {
      const response = await fetch("/api/forms", {
        body: JSON.stringify({ form: selectedForm }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

      if (!response.ok) {
        setSaveStatus("error");
        return;
      }

      const result = (await response.json()) as { form?: WebsiteForm; persisted?: boolean };
      if (result.form) {
        const normalizedForm = ensureFormStructure(result.form, copy);
        setForms((current) => current.map((form) => (form.id === selectedForm.id ? normalizedForm : form)));
        setSelectedFormId(normalizedForm.id);
      }
      setPersistenceSource("database");
      setSaveStatus("saved");
    } catch {
      setSaveStatus("error");
    }
  }

  if (!selectedForm) {
    return (
      <section className="rounded-lg border border-stone-200 bg-white p-5 text-sm text-stone-600">
        {copy.empty}
      </section>
    );
  }

  if (isFormEditorMode) {
    return (
      <section className="fixed inset-0 z-50 flex min-h-0 flex-col bg-[#eef7ff] text-slate-950">
        <header className="shrink-0 border-b border-stone-200 bg-white/95 px-4 py-3 shadow-sm backdrop-blur">
          <div className="flex min-w-0 flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <button
                className="shrink-0 rounded-md border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-stone-100"
                onClick={() => setActiveTab("overview")}
                type="button"
              >
                {backToFormsLabel}
              </button>
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-700">
                  {formEditorLabel}
                </p>
                <input
                  className="mt-1 w-full rounded-md border border-transparent bg-transparent px-0 text-xl font-semibold text-slate-950 outline-none focus:border-blue-200 focus:bg-white focus:px-2"
                  onChange={(event) => updateSelectedForm({ name: event.target.value })}
                  value={selectedForm.name}
                />
                <p className="mt-1 break-words text-xs text-stone-600">
                  {templateLabels[selectedForm.template]} · {variantLabels[selectedForm.variant]} · {targetLabels[selectedForm.crmTarget]}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-stone-100"
                onClick={() => setActiveTab("crm")}
                type="button"
              >
                {copy.header.crmTarget}
              </button>
              <button
                className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-stone-100"
                onClick={() => setActiveTab("embed")}
                type="button"
              >
                {copy.header.websiteInstall}
              </button>
              <a
                className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-stone-100"
                href={publicUrl}
                rel="noreferrer"
                target="_blank"
              >
                {copy.header.openPreview}
              </a>
              <button
                className="rounded-md bg-slate-950 px-3 py-2 text-sm font-semibold text-white disabled:bg-slate-400"
                disabled={saveStatus === "saving"}
                onClick={saveSelectedForm}
                type="button"
              >
                {saveStatus === "saving"
                  ? copy.header.saving
                  : saveStatus === "saved"
                    ? copy.header.saved
                    : copy.header.save}
              </button>
            </div>
          </div>
        </header>

        <div className="grid min-h-0 flex-1 gap-3 overflow-hidden p-3 xl:grid-cols-[300px_minmax(360px,1fr)_380px]">
          <aside className="min-h-0 overflow-auto rounded-lg border border-blue-200 bg-white p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-semibold">{copy.builder.structure}</p>
              <span className={`rounded-md border px-2 py-1 text-xs font-semibold ${statusStyles[selectedForm.status]}`}>
                {copy.builder.statusOptions[selectedForm.status]}
              </span>
            </div>

            <div className="mt-4 grid gap-2">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                {copy.builder.template}
              </p>
              {formTemplateIds.map((template) => (
                <button
                  className={`rounded-md border px-3 py-2 text-left text-sm font-semibold ${
                    selectedForm.template === template
                      ? "border-slate-950 bg-slate-950 text-white"
                      : "border-stone-200 bg-stone-50 text-slate-800 hover:border-blue-200 hover:bg-blue-50"
                  }`}
                  key={template}
                  onClick={() => applyTemplate(template)}
                  type="button"
                >
                  {templateLabels[template]}
                </button>
              ))}
            </div>

            <div className="mt-5 grid gap-2">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                  {copy.builder.steps}
                </p>
                <button
                  className="rounded-md border border-stone-300 bg-white px-2 py-1 text-xs font-semibold hover:border-blue-300 hover:bg-blue-50"
                  onClick={addStep}
                  type="button"
                >
                  + {copy.builder.addStep}
                </button>
              </div>
              {selectedSteps.map((step, index) => (
                <div className="grid gap-2 rounded-md border border-stone-200 bg-stone-50 p-3" key={step.id}>
                  <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    {copy.builder.steps} {index + 1}
                    <input
                      className="rounded-md border border-stone-300 px-2 py-2 text-sm normal-case tracking-normal"
                      onChange={(event) => updateStep(step.id, { title: event.target.value })}
                      value={step.title}
                    />
                  </label>
                  <input
                    className="rounded-md border border-stone-300 px-2 py-2 text-xs"
                    onChange={(event) => updateStep(step.id, { description: event.target.value })}
                    placeholder={copy.fields.helpText}
                    value={step.description}
                  />
                </div>
              ))}
            </div>

            <div className="mt-5 grid gap-2">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                  {copy.builder.fields}
                </p>
                <span className="rounded-md bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-900">
                  {selectedForm.fields.length}
                </span>
              </div>
              {selectedForm.fields.map((field, index) => (
                <button
                  aria-pressed={field.id === selectedField?.id}
                  className={`rounded-md border px-3 py-2 text-left text-sm transition ${
                    field.id === selectedField?.id
                      ? "border-blue-600 bg-blue-50 text-blue-950"
                      : "border-stone-200 bg-white text-slate-800 hover:border-blue-200"
                  }`}
                  key={field.id}
                  onClick={() => setSelectedFieldId(field.id)}
                  type="button"
                >
                  <span className="block font-semibold">{index + 1}. {field.label}</span>
                  <span className="mt-1 block break-words text-xs text-stone-500">
                    {copy.fieldTypes[field.type]} · {selectedSteps.find((step) => step.id === field.stepId)?.title ?? copy.fields.hiddenValue} ·{" "}
                    {field.required ? copy.fields.required : copy.fields.optional}
                  </span>
                </button>
              ))}
            </div>

            <div className="mt-5 grid grid-cols-2 gap-2">
              {fieldTypes.map((field) => (
                <button
                  className="rounded-md border border-stone-300 bg-white px-2 py-2 text-xs font-semibold hover:border-blue-300 hover:bg-blue-50"
                  key={field.id}
                  onClick={() => addField(field.id)}
                  type="button"
                >
                  + {field.label}
                </button>
              ))}
            </div>
          </aside>

          <main className="min-h-0 overflow-auto rounded-lg border border-blue-200 bg-[#f6fbff] p-4">
            <div className="mx-auto grid max-w-[760px] gap-4">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-blue-100 bg-white p-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-700">
                    {copy.builder.livePreview}
                  </p>
                  <p className="mt-1 text-sm text-stone-600">{copy.builder.previewHelp}</p>
                </div>
                <div className="grid gap-2">
                  <div className="flex flex-wrap gap-2">
                    <span className="self-center text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                      {copy.builder.layoutVariants}
                    </span>
                    {formLayoutVariants.map((variant) => (
                      <button
                        className={`rounded-md border px-2 py-1 text-xs font-semibold ${
                          selectedForm.variant === variant
                            ? "border-slate-950 bg-slate-950 text-white"
                            : "border-stone-200 bg-stone-50 text-stone-700"
                        }`}
                        key={variant}
                        onClick={() => updateSelectedForm({ variant })}
                        type="button"
                      >
                        {variantLabels[variant]}
                      </button>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <span className="self-center text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                      {copy.builder.publishVariants}
                    </span>
                    {formPublishVariants.map((variant) => (
                      <button
                        className={`rounded-md border px-2 py-1 text-xs font-semibold ${
                          selectedForm.variant === variant
                            ? "border-slate-950 bg-slate-950 text-white"
                            : "border-stone-200 bg-stone-50 text-stone-700"
                        }`}
                        key={variant}
                        onClick={() => updateSelectedForm({ variant })}
                        type="button"
                      >
                        {variantLabels[variant]}
                      </button>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {(["desktop", "tablet", "mobile"] as const).map((device) => (
                      <button
                        className={`rounded-md border px-2 py-1 text-xs font-semibold ${
                          previewDevice === device
                            ? "border-blue-700 bg-blue-50 text-blue-950"
                            : "border-stone-200 bg-white text-stone-700"
                        }`}
                        key={device}
                        onClick={() => setPreviewDevice(device)}
                        type="button"
                      >
                        {device === "desktop"
                          ? copy.builder.desktop
                          : device === "tablet"
                            ? copy.builder.tablet
                            : copy.builder.mobile}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="rounded-[28px] border border-stone-300 bg-white p-4 shadow-sm">
                <div
                  className={`mx-auto transition-all ${
                    previewDevice === "mobile"
                      ? "max-w-[390px]"
                      : previewDevice === "tablet"
                        ? "max-w-[620px]"
                        : "max-w-[760px]"
                  }`}
                >
                  {isFormPublishVariant(selectedForm.variant) ? (
                    <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm font-semibold text-amber-950">
                      {copy.embed.publicationOnly}
                    </div>
                  ) : null}
                  <FormRuntimeClient
                    copy={copy.runtime}
                    form={selectedForm}
                    mode="editor"
                    onFieldSelect={setSelectedFieldId}
                    previewOnly
                    publicKey={publicFormKey}
                    returnTo={publicPath}
                    selectedFieldId={selectedField?.id}
                    source="editor"
                  />
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                <div className="rounded-lg border border-blue-100 bg-white p-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">CRM</p>
                  <p className="mt-1 break-words text-sm font-semibold">{targetLabels[selectedForm.crmTarget]} · {selectedForm.pipelineStage}</p>
                </div>
                <div className="rounded-lg border border-blue-100 bg-white p-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    {copy.builder.install}
                  </p>
                  <p className="mt-1 break-words text-sm font-semibold">{variantLabels[selectedForm.variant]}</p>
                </div>
                <div className="rounded-lg border border-blue-100 bg-white p-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    {copy.builder.tracking}
                  </p>
                  <p className="mt-1 break-words text-sm font-semibold">
                    {selectedForm.utmCapture ? copy.builder.utmActive : copy.builder.utmOff}
                  </p>
                </div>
              </div>
            </div>
          </main>

          <aside className="min-h-0 overflow-auto rounded-lg border border-blue-200 bg-white p-4">
            <p className="text-sm font-semibold">{copy.builder.fieldSettings}</p>
            {selectedField ? (
              <div className="mt-4 grid gap-3">
                <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                  {copy.fields.label}
                  <input className="rounded-md border border-stone-300 px-3 py-2 text-sm normal-case tracking-normal" onChange={(event) => updateField(selectedField.id, { label: event.target.value })} value={selectedField.label} />
                </label>
                <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                  {copy.fields.type}
                  <select className="rounded-md border border-stone-300 px-3 py-2 text-sm normal-case tracking-normal" onChange={(event) => updateField(selectedField.id, { type: event.target.value as FormFieldType })} value={selectedField.type}>
                    {fieldTypes.map((type) => <option key={type.id} value={type.id}>{type.label}</option>)}
                  </select>
                </label>
                {selectedField.type !== "hidden" ? (
                  <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    {copy.fields.step}
                    <select
                      className="rounded-md border border-stone-300 px-3 py-2 text-sm normal-case tracking-normal"
                      onChange={(event) => updateField(selectedField.id, { stepId: event.target.value })}
                      value={selectedField.stepId || selectedSteps[0]?.id}
                    >
                      {selectedSteps.map((step) => (
                        <option key={step.id} value={step.id}>{step.title}</option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                  {copy.fields.crmField}
                  <input className="rounded-md border border-stone-300 px-3 py-2 text-sm normal-case tracking-normal" onChange={(event) => updateField(selectedField.id, { crmField: event.target.value })} value={selectedField.crmField} />
                </label>
                <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                  {copy.fields.placeholder}
                  <input className="rounded-md border border-stone-300 px-3 py-2 text-sm normal-case tracking-normal" onChange={(event) => updateField(selectedField.id, { placeholder: event.target.value })} value={selectedField.placeholder} />
                </label>
                <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                  {copy.fields.helpText}
                  <textarea className="min-h-20 rounded-md border border-stone-300 px-3 py-2 text-sm normal-case tracking-normal" onChange={(event) => updateField(selectedField.id, { helpText: event.target.value })} value={selectedField.helpText} />
                </label>
                <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                  {selectedField.type === "hidden" ? copy.fields.hiddenValue : copy.fields.defaultValue}
                  <input className="rounded-md border border-stone-300 px-3 py-2 text-sm normal-case tracking-normal" onChange={(event) => updateField(selectedField.id, { defaultValue: event.target.value })} value={selectedField.defaultValue} />
                </label>
                {isOptionFieldType(selectedField.type) ? (
                  <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    {copy.fields.options}
                    <textarea
                      className="min-h-24 rounded-md border border-stone-300 px-3 py-2 text-sm normal-case tracking-normal"
                      onChange={(event) => updateField(selectedField.id, { options: event.target.value.split("\n").map((item) => item.trim()).filter(Boolean) })}
                      value={selectedField.options.join("\n")}
                    />
                  </label>
                ) : null}
                {isNumericFieldType(selectedField.type) ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                      {copy.fields.minValue}
                      <input className="rounded-md border border-stone-300 px-3 py-2 text-sm normal-case tracking-normal" onChange={(event) => updateField(selectedField.id, { minValue: event.target.value })} value={selectedField.minValue} />
                    </label>
                    <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                      {copy.fields.maxValue}
                      <input className="rounded-md border border-stone-300 px-3 py-2 text-sm normal-case tracking-normal" onChange={(event) => updateField(selectedField.id, { maxValue: event.target.value })} value={selectedField.maxValue} />
                    </label>
                  </div>
                ) : null}
                {selectedField.type === "file" ? (
                  <div className="grid gap-3 rounded-md border border-stone-200 bg-stone-50 p-3">
                    <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                      {copy.fields.fileAccept}
                      <input className="rounded-md border border-stone-300 px-3 py-2 text-sm normal-case tracking-normal" onChange={(event) => updateField(selectedField.id, { fileAccept: event.target.value })} value={selectedField.fileAccept} />
                    </label>
                    <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                      {copy.fields.fileMaxMb}
                      <input className="rounded-md border border-stone-300 px-3 py-2 text-sm normal-case tracking-normal" min="0" onChange={(event) => updateField(selectedField.id, { fileMaxMb: Number(event.target.value) })} type="number" value={selectedField.fileMaxMb} />
                    </label>
                    <label className="flex items-center gap-2 text-sm font-semibold">
                      <input checked={selectedField.multiple} onChange={(event) => updateField(selectedField.id, { multiple: event.target.checked })} type="checkbox" />
                      {copy.fields.multiple}
                    </label>
                  </div>
                ) : null}
                <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                  {copy.fields.errorMessage}
                  <input className="rounded-md border border-stone-300 px-3 py-2 text-sm normal-case tracking-normal" onChange={(event) => updateField(selectedField.id, { errorMessage: event.target.value })} value={selectedField.errorMessage} />
                </label>
                <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                  {copy.fields.validationPattern}
                  <input className="rounded-md border border-stone-300 px-3 py-2 text-sm normal-case tracking-normal" onChange={(event) => updateField(selectedField.id, { validationPattern: event.target.value })} value={selectedField.validationPattern} />
                </label>
                <div className="grid gap-3 rounded-md border border-stone-200 bg-stone-50 p-3">
                  <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                    {copy.fields.conditionField}
                    <select
                      className="rounded-md border border-stone-300 px-3 py-2 text-sm normal-case tracking-normal"
                      onChange={(event) => updateField(selectedField.id, { conditionalFieldId: event.target.value, conditionalValue: event.target.value ? selectedField.conditionalValue : "" })}
                      value={selectedField.conditionalFieldId}
                    >
                      <option value="">{copy.fields.noCondition}</option>
                      {selectedForm.fields.filter((field) => field.id !== selectedField.id && field.type !== "hidden").map((field) => (
                        <option key={field.id} value={field.id}>{field.label}</option>
                      ))}
                    </select>
                  </label>
                  {selectedField.conditionalFieldId ? (
                    <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                      {copy.fields.conditionValue}
                      <input className="rounded-md border border-stone-300 px-3 py-2 text-sm normal-case tracking-normal" onChange={(event) => updateField(selectedField.id, { conditionalValue: event.target.value })} value={selectedField.conditionalValue} />
                    </label>
                  ) : null}
                </div>
                <label className="flex items-center gap-2 text-sm font-semibold">
                  <input checked={selectedField.required} onChange={(event) => updateField(selectedField.id, { required: event.target.checked })} type="checkbox" />
                  {copy.fields.required}
                </label>
                <button
                  className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-900"
                  disabled={selectedForm.fields.length <= 1}
                  onClick={() => removeField(selectedField.id)}
                  type="button"
                >
                  {copy.fields.removeField}
                </button>
              </div>
            ) : (
              <div className="mt-4 rounded-md border border-dashed border-stone-300 bg-stone-50 p-4 text-sm text-stone-500">
                {copy.fields.selectPrompt}
              </div>
            )}

            <div className="mt-6 grid gap-3 border-t border-stone-200 pt-4">
              <p className="text-sm font-semibold">{copy.builder.formSettings}</p>
              <label className="grid gap-1 text-sm font-semibold">
                {copy.builder.status}
                <select className="rounded-md border border-stone-300 px-3 py-2 text-sm" onChange={(event) => updateSelectedForm({ status: event.target.value as FormStatus })} value={selectedForm.status}>
                  {formStatusIds.map((status) => (
                    <option key={status} value={status}>
                      {copy.builder.statusOptions[status]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-sm font-semibold">
                {copy.builder.progressMode}
                <select
                  className="rounded-md border border-stone-300 px-3 py-2 text-sm"
                  onChange={(event) => updateSelectedForm({ progressMode: event.target.value as FormProgressMode })}
                  value={selectedForm.progressMode}
                >
                  <option value="none">{copy.builder.progressNone}</option>
                  <option value="steps">{copy.builder.progressSteps}</option>
                  <option value="percent">{copy.builder.progressPercent}</option>
                </select>
              </label>
              <label className="grid gap-1 text-sm font-semibold">
                {copy.crm.campaign}
                <input className="rounded-md border border-stone-300 px-3 py-2 text-sm" onChange={(event) => updateSelectedForm({ campaign: event.target.value })} value={selectedForm.campaign} />
              </label>
              <label className="grid gap-1 text-sm font-semibold">
                {copy.crm.tags}
                <input className="rounded-md border border-stone-300 px-3 py-2 text-sm" onChange={(event) => updateSelectedForm({ tags: event.target.value })} value={selectedForm.tags} />
              </label>
              <label className="flex items-start gap-2 text-sm font-semibold">
                <input checked={selectedForm.spamProtection} onChange={(event) => updateSelectedForm({ spamProtection: event.target.checked })} type="checkbox" />
                {copy.builder.spamProtection}
              </label>
              <label className="flex items-start gap-2 text-sm font-semibold">
                <input checked={selectedForm.doubleOptIn} onChange={(event) => updateSelectedForm({ doubleOptIn: event.target.checked })} type="checkbox" />
                {copy.builder.doubleOptIn}
              </label>
            </div>
          </aside>
        </div>
      </section>
    );
  }

  return (
    <section className="grid gap-4">
      <article className="rounded-lg border border-stone-200 bg-white p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
              {projectLabel}
            </p>
            <h3 className="mt-1 text-2xl font-semibold">{copy.overview.title}</h3>
            <p className="mt-2 max-w-3xl break-words text-sm text-stone-600">
              {copy.overview.description}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-md border px-3 py-2 text-xs font-semibold ${
              persistenceSource === "database"
                ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                : "border-amber-200 bg-amber-50 text-amber-900"
            }`}>
              {persistenceSource === "database" ? copy.overview.databaseActive : copy.overview.localPreview}
            </span>
            <button
              className="rounded-md bg-slate-950 px-4 py-3 text-sm font-semibold text-white"
              onClick={addForm}
              type="button"
            >
              {copy.overview.newForm}
            </button>
          </div>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-4">
          {[
            [copy.overview.title, forms.length],
            [copy.overview.activeInstalled, readyForms],
            [copy.overview.submissions, totalSubmissions],
            [copy.overview.avgConversion, formatPercent(averageConversion, language)],
          ].map(([label, value]) => (
            <div className="rounded-lg bg-stone-50 p-4" key={label}>
              <p className="text-lg font-semibold">{value}</p>
              <p className="mt-1 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">{label}</p>
            </div>
          ))}
        </div>
      </article>

      <section className="grid min-w-0 gap-4 xl:grid-cols-[minmax(300px,380px)_minmax(0,1fr)]">
        <aside className="grid min-w-0 content-start gap-3 rounded-lg border border-stone-200 bg-white p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold">{copy.overview.formList}</p>
            <span className="rounded-md bg-stone-50 px-2 py-1 text-xs font-semibold text-stone-600">
              {forms.length}
            </span>
          </div>
          {forms.map((form) => {
            const isSelected = form.id === selectedForm.id;
            return (
              <button
                aria-pressed={isSelected}
                className={`rounded-lg border p-4 text-left transition ${
                  isSelected
                    ? "border-slate-950 bg-slate-950 text-white"
                    : "border-stone-200 bg-stone-50 text-slate-950 hover:border-blue-200 hover:bg-blue-50"
                }`}
                key={form.id}
                onClick={() => {
                  setSelectedFormId(form.id);
                  setInstallStatus("idle");
                }}
                type="button"
              >
                <span className="flex min-w-0 items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block break-words text-sm font-semibold">{form.name}</span>
                    <span className={`mt-1 block text-xs ${isSelected ? "text-slate-200" : "text-stone-500"}`}>
                      {templateLabels[form.template]} · {variantLabels[form.variant]}
                    </span>
                  </span>
                  <span className={`shrink-0 rounded-md border px-2 py-1 text-xs font-semibold ${isSelected ? "border-white/15 bg-white/10 text-white" : statusStyles[form.status]}`}>
                    {copy.builder.statusOptions[form.status]}
                  </span>
                </span>
                <span className="mt-3 grid gap-2 text-xs">
                  <span className={`rounded-md px-2 py-1 font-semibold ${isSelected ? "bg-white/10 text-white" : "bg-white text-stone-700"}`}>
                    {form.submissions} {copy.overview.submissions} · {formatPercent(form.conversionRate, language)}
                  </span>
                  <span className={`rounded-md px-2 py-1 ${isSelected ? "bg-white/10 text-white" : "bg-blue-50 text-blue-900"}`}>
                    {copy.overview.lastSubmission} {formatDateTime(form.lastSubmission, language, copy)}
                  </span>
                </span>
              </button>
            );
          })}
        </aside>

        <section className="min-w-0 rounded-lg border border-stone-200 bg-white p-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
                {copy.overview.selectedForm}
              </p>
              <input
                className="mt-1 w-full rounded-md border border-transparent bg-transparent px-0 text-2xl font-semibold text-slate-950 outline-none focus:border-blue-200 focus:bg-white focus:px-2"
                onChange={(event) => updateSelectedForm({ name: event.target.value })}
                value={selectedForm.name}
              />
              <p className="mt-1 break-words text-sm text-stone-600">
                {targetLabels[selectedForm.crmTarget]} · {selectedForm.pipelineStage} ·{" "}
                {selectedOwner?.name ?? copy.crm.roundRobin}
              </p>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <select
                className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold"
                onChange={(event) => updateSelectedForm({ status: event.target.value as FormStatus })}
                value={selectedForm.status}
              >
                {formStatusIds.map((status) => (
                  <option key={status} value={status}>
                    {copy.builder.statusOptions[status]}
                  </option>
                ))}
              </select>
              <a
                className="rounded-md bg-slate-950 px-3 py-2 text-center text-sm font-semibold text-white"
                href={publicUrl}
                rel="noreferrer"
                target="_blank"
              >
                {copy.overview.openLink}
              </a>
              <button
                className="rounded-md bg-blue-600 px-3 py-2 text-center text-sm font-semibold text-white disabled:bg-blue-300"
                disabled={saveStatus === "saving"}
                onClick={saveSelectedForm}
                type="button"
              >
                {saveStatus === "saving"
                  ? copy.header.saving
                  : saveStatus === "saved"
                    ? copy.header.saved
                    : copy.header.save}
              </button>
            </div>
          </div>
          {saveStatus === "error" ? (
            <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-900">
              {copy.overview.cannotSave}
            </div>
          ) : null}

          <div className="mt-5 flex flex-wrap gap-2">
            {tabs.map((tab) => (
              <button
                className={`rounded-md border px-3 py-2 text-sm font-semibold ${
                  activeTab === tab.id
                    ? "border-slate-950 bg-slate-950 text-white"
                    : "border-stone-200 bg-stone-50 text-stone-700 hover:border-blue-200 hover:bg-blue-50"
                }`}
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                type="button"
              >
                {tab.label}
              </button>
            ))}
          </div>

          {activeTab === "overview" ? (
            <div className="mt-5 grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
              <div className="rounded-lg border border-stone-200 bg-stone-50 p-4">
                <p className="text-sm font-semibold">{copy.overview.variant}</p>
                <p className="mt-3 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                  {copy.builder.layoutVariants}
                </p>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {formLayoutVariants.map((variant) => (
                    <button
                      className={`rounded-md border px-3 py-2 text-left text-sm font-semibold ${
                        selectedForm.variant === variant
                          ? "border-slate-950 bg-slate-950 text-white"
                          : "border-stone-200 bg-white text-slate-800"
                      }`}
                      key={variant}
                      onClick={() => updateSelectedForm({ variant })}
                      type="button"
                    >
                      {variantLabels[variant]}
                    </button>
                  ))}
                </div>
                <p className="mt-4 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
                  {copy.builder.publishVariants}
                </p>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {formPublishVariants.map((variant) => (
                    <button
                      className={`rounded-md border px-3 py-2 text-left text-sm font-semibold ${
                        selectedForm.variant === variant
                          ? "border-slate-950 bg-slate-950 text-white"
                          : "border-stone-200 bg-white text-slate-800"
                      }`}
                      key={variant}
                      onClick={() => updateSelectedForm({ variant })}
                      type="button"
                    >
                      {variantLabels[variant]}
                    </button>
                  ))}
                </div>
              </div>
              <div className="rounded-lg border border-blue-100 bg-blue-50 p-4 text-blue-950">
                <p className="text-sm font-semibold">{copy.overview.betterTitle}</p>
                <div className="mt-3 grid gap-2 text-sm">
                  {copy.overview.betterItems.map((item) => (
                    <p key={item}>{item}</p>
                  ))}
                </div>
              </div>
              <div className="rounded-lg border border-stone-200 bg-white p-4 xl:col-span-2">
                <p className="text-sm font-semibold">{copy.overview.livePreview}</p>
                <div className="mt-4 mx-auto max-w-xl">
                  {isFormPublishVariant(selectedForm.variant) ? (
                    <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm font-semibold text-amber-950">
                      {copy.embed.publicationOnly}
                    </div>
                  ) : null}
                  <FormRuntimeClient
                    copy={copy.runtime}
                    form={selectedForm}
                    mode="editor"
                    previewOnly
                    publicKey={publicFormKey}
                    returnTo={publicPath}
                    source="overview"
                  />
                </div>
              </div>
            </div>
          ) : null}

          {activeTab === "crm" ? (
            <div className="mt-5 grid gap-4 xl:grid-cols-2">
              <div className="rounded-lg border border-stone-200 bg-stone-50 p-4">
                <p className="text-sm font-semibold">{copy.crm.mapping}</p>
                <div className="mt-3 grid gap-3">
                  <label className="grid gap-1 text-sm font-semibold">
                    {copy.crm.saveAs}
                    <select className="rounded-md border border-stone-300 px-3 py-2 text-sm" onChange={(event) => updateSelectedForm({ crmTarget: event.target.value as FormTarget })} value={selectedForm.crmTarget}>
                      {formTargetIds.map((target) => <option key={target} value={target}>{targetLabels[target]}</option>)}
                    </select>
                  </label>
                  <label className="grid gap-1 text-sm font-semibold">
                    {copy.crm.pipelineStage}
                    <input className="rounded-md border border-stone-300 px-3 py-2 text-sm" onChange={(event) => updateSelectedForm({ pipelineStage: event.target.value })} value={selectedForm.pipelineStage} />
                  </label>
                  <label className="grid gap-1 text-sm font-semibold">
                    {copy.crm.ownership}
                    <select className="rounded-md border border-stone-300 px-3 py-2 text-sm" onChange={(event) => updateSelectedForm({ ownerMode: event.target.value as WebsiteForm["ownerMode"] })} value={selectedForm.ownerMode}>
                      <option value="roundRobin">{copy.crm.roundRobin}</option>
                      <option value="user">{copy.crm.fixedOwner}</option>
                    </select>
                  </label>
                  {selectedForm.ownerMode === "user" ? (
                    <label className="grid gap-1 text-sm font-semibold">
                      {copy.crm.owner}
                      <select className="rounded-md border border-stone-300 px-3 py-2 text-sm" onChange={(event) => updateSelectedForm({ ownerUserId: event.target.value })} value={selectedForm.ownerUserId}>
                        {users.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
                      </select>
                    </label>
                  ) : null}
                  <label className="grid gap-1 text-sm font-semibold">
                    {copy.crm.tags}
                    <input className="rounded-md border border-stone-300 px-3 py-2 text-sm" onChange={(event) => updateSelectedForm({ tags: event.target.value })} value={selectedForm.tags} />
                  </label>
                  <label className="grid gap-1 text-sm font-semibold">
                    {copy.crm.campaign}
                    <input className="rounded-md border border-stone-300 px-3 py-2 text-sm" onChange={(event) => updateSelectedForm({ campaign: event.target.value })} value={selectedForm.campaign} />
                  </label>
                </div>
              </div>
              <div className="rounded-lg border border-blue-100 bg-blue-50 p-4 text-blue-950">
                <p className="text-sm font-semibold">{copy.crm.connections}</p>
                <div className="mt-3 grid gap-3">
                  <label className="grid gap-1 text-sm font-semibold">
                    {copy.crm.connectFunnel}
                    <select className="rounded-md border border-blue-200 bg-white px-3 py-2 text-sm" onChange={(event) => updateSelectedForm({ funnelId: event.target.value })} value={selectedForm.funnelId}>
                      {funnels.map((funnel) => <option key={funnel.id} value={funnel.id}>{funnel.name}</option>)}
                    </select>
                  </label>
                  <div className="rounded-md bg-white/70 p-3 text-sm">
                    <p className="font-semibold">{selectedFunnel?.name ?? copy.crm.noFunnel}</p>
                    <p className="mt-1 text-blue-900">
                      {copy.crm.flow} {linkedMeeting ? copy.header.websiteInstall : copy.crm.crmFollowUp}
                    </p>
                  </div>
                  <label className="flex items-start gap-2 text-sm font-semibold">
                    <input checked={selectedForm.utmCapture} onChange={(event) => updateSelectedForm({ utmCapture: event.target.checked })} type="checkbox" />
                    {copy.crm.utmCapture}
                  </label>
                  <label className="flex items-start gap-2 text-sm font-semibold">
                    <input checked type="checkbox" readOnly />
                    {copy.crm.updateDuplicates}
                  </label>
                </div>
              </div>
            </div>
          ) : null}

          {activeTab === "embed" ? (
            <div className="mt-5 grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
              <div className="rounded-lg border border-stone-200 bg-stone-50 p-4">
                <p className="text-sm font-semibold">{copy.embed.assistant}</p>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {platformIds.map((item) => (
                    <button className={`rounded-md border px-3 py-2 text-sm font-semibold ${platform === item ? "border-slate-950 bg-slate-950 text-white" : "border-stone-200 bg-white text-slate-800"}`} key={item} onClick={() => setPlatform(item)} type="button">
                      {platformInstructions[item].label}
                    </button>
                  ))}
                </div>
                <div className="mt-4 grid gap-2">
                  {platformInstructions[platform].steps.map((step, index) => (
                    <div className="rounded-md bg-white p-3 text-sm font-semibold" key={step}>
                      {index + 1}. {step}
                    </div>
                  ))}
                </div>
                <button className="mt-4 rounded-md bg-slate-950 px-3 py-2 text-sm font-semibold text-white" onClick={() => setInstallStatus((current) => current === "detected" ? "missing" : "detected")} type="button">
                  {copy.embed.checkStatus}
                </button>
                <div className={`mt-3 rounded-md border px-3 py-2 text-sm font-semibold ${installStatus === "detected" ? "border-emerald-200 bg-emerald-50 text-emerald-900" : installStatus === "missing" ? "border-red-200 bg-red-50 text-red-900" : "border-stone-200 bg-white text-stone-700"}`}>
                  {installStatus === "detected"
                    ? copy.embed.detected
                    : installStatus === "missing"
                      ? copy.embed.missing
                      : copy.embed.idle}
                </div>
              </div>
              <div className="grid gap-4">
                <div className="rounded-lg border border-stone-200 bg-white p-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold">{copy.embed.embedCode}</p>
                    <span className="rounded-md bg-stone-50 px-2 py-1 text-xs font-semibold">{variantLabels[selectedForm.variant]}</span>
                  </div>
                  <pre className="mt-3 max-h-40 overflow-auto rounded-md bg-slate-950 p-3 text-xs text-white">{embedCode}</pre>
                </div>
                <div className="grid gap-4 md:grid-cols-[180px_minmax(0,1fr)]">
                  <div className="rounded-lg border border-stone-200 bg-white p-4">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img alt={copy.embed.qrAlt} className="h-36 w-36 rounded-md border border-stone-200" src={qrUrl} />
                  </div>
                  <div className="rounded-lg border border-stone-200 bg-white p-4 text-sm">
                    <p className="font-semibold">{copy.embed.standaloneLink}</p>
                    <p className="mt-2 break-all text-stone-600">{publicUrl}</p>
                    <p className="mt-4 font-semibold">{copy.embed.hiddenFields}</p>
                    <p className="mt-1 text-stone-600">{copy.embed.hiddenFieldList}</p>
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {activeTab === "automation" ? (
            <div className="mt-5 grid gap-4 xl:grid-cols-2">
              <div className="rounded-lg border border-stone-200 bg-stone-50 p-4">
                <p className="text-sm font-semibold">{copy.automation.afterSubmit}</p>
                <div className="mt-3 grid gap-3">
                  <label className="grid gap-1 text-sm font-semibold">
                    {copy.automation.thankYouMessage}
                    <textarea className="min-h-24 rounded-md border border-stone-300 px-3 py-2 text-sm" onChange={(event) => updateSelectedForm({ actions: { ...selectedForm.actions, thankYouMessage: event.target.value } })} value={selectedForm.actions.thankYouMessage} />
                  </label>
                  <label className="grid gap-1 text-sm font-semibold">
                    {copy.automation.redirect}
                    <input className="rounded-md border border-stone-300 px-3 py-2 text-sm" onChange={(event) => updateSelectedForm({ actions: { ...selectedForm.actions, redirectUrl: event.target.value } })} placeholder="https://..." value={selectedForm.actions.redirectUrl} />
                  </label>
                  {[
                    ["showMeeting", copy.automation.actions.showMeeting],
                    ["internalNotification", copy.automation.actions.internalNotification],
                    ["createTask", copy.automation.actions.createTask],
                    ["followUpEmail", copy.automation.actions.followUpEmail],
                    ["newsletterList", copy.automation.actions.newsletterList],
                  ].map(([key, label]) => (
                    <label className="flex items-start gap-2 text-sm font-semibold" key={key}>
                      <input checked={Boolean(selectedForm.actions[key as keyof WebsiteForm["actions"]])} onChange={(event) => updateSelectedForm({ actions: { ...selectedForm.actions, [key]: event.target.checked } })} type="checkbox" />
                      {label}
                    </label>
                  ))}
                </div>
              </div>
              <div className="rounded-lg border border-blue-100 bg-blue-50 p-4 text-blue-950">
                <p className="text-sm font-semibold">{copy.automation.privacyQuality}</p>
                <div className="mt-3 grid gap-3 text-sm">
                  <label className="flex items-start gap-2 font-semibold">
                    <input checked={selectedForm.spamProtection} onChange={(event) => updateSelectedForm({ spamProtection: event.target.checked })} type="checkbox" />
                    {copy.automation.spamProtection}
                  </label>
                  <label className="flex items-start gap-2 font-semibold">
                    <input checked={selectedForm.doubleOptIn} onChange={(event) => updateSelectedForm({ doubleOptIn: event.target.checked })} type="checkbox" />
                    {copy.automation.doubleOptIn}
                  </label>
                  <label className="flex items-start gap-2 font-semibold">
                    <input checked={selectedForm.fields.some((field) => field.type === "consent")} readOnly type="checkbox" />
                    {copy.automation.privacyCheckbox}
                  </label>
                  <label className="flex items-start gap-2 font-semibold">
                    <input checked={selectedForm.utmCapture} readOnly type="checkbox" />
                    {copy.automation.sourceStored}
                  </label>
                </div>
              </div>
            </div>
          ) : null}

          {activeTab === "submissions" ? (
            <div className="mt-5 grid gap-4 xl:grid-cols-[1fr_0.9fr]">
              <div className="rounded-lg border border-stone-200 bg-white p-4">
                <p className="text-sm font-semibold">{copy.submissionsPanel.latest}</p>
                <div className="mt-3 grid gap-2">
                  {(selectedSubmissionRows.length ? selectedSubmissionRows : relatedLeads.slice(0, 5)).map((item) => (
                    <div className="grid gap-2 rounded-md bg-stone-50 p-3 text-sm md:grid-cols-[minmax(0,1fr)_90px_minmax(140px,auto)]" key={item.id}>
                      <span className="break-words font-semibold">{"contactName" in item ? item.contactName : item.intent}</span>
                      <span>{copy.submissionsPanel.score} {item.score}</span>
                      <span className="break-words text-stone-600">{item.nextAction}</span>
                    </div>
                  ))}
                  {!selectedSubmissionRows.length && !relatedLeads.length ? (
                    <div className="rounded-md border border-dashed border-stone-300 bg-stone-50 p-4 text-sm text-stone-500">
                      {copy.submissionsPanel.empty}
                    </div>
                  ) : null}
                </div>
              </div>
              <div className="rounded-lg border border-stone-200 bg-stone-50 p-4">
                <p className="text-sm font-semibold">{copy.submissionsPanel.followUp}</p>
                <div className="mt-3 grid gap-2 text-sm">
                  <div className="rounded-md bg-white p-3">
                    <span className="font-semibold">{copy.submissionsPanel.contacts}</span> {contacts.length}
                  </div>
                  <div className="rounded-md bg-white p-3">
                    <span className="font-semibold">{copy.submissionsPanel.openTasks}</span> {relatedTasks.length}
                  </div>
                  <div className="rounded-md bg-white p-3">
                    <span className="font-semibold">{copy.submissionsPanel.projects}</span> {projects.length}
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </section>
      </section>
    </section>
  );
}
