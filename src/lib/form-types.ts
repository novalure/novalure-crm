export type FormStatus = "entwurf" | "aktiv" | "eingebaut" | "fehler";

export const formLayoutVariants = ["embed", "popup", "slideIn", "stickyTop", "stickyBottom"] as const;
export const formPublishVariants = ["button", "standalone", "qr"] as const;

export type FormLayoutVariant = (typeof formLayoutVariants)[number];
export type FormPublishVariant = (typeof formPublishVariants)[number];
export type FormVariant = FormLayoutVariant | FormPublishVariant;

export type FormTemplate =
  | "buyerProfile"
  | "consultation"
  | "contact"
  | "investorProfile"
  | "leadMagnet"
  | "newsletter"
  | "projectExpose"
  | "sellerValuation"
  | "support"
  | "viewing";

export type FormTarget = "contact" | "lead" | "deal" | "ticket";
export type FormProgressMode = "none" | "steps" | "percent";

export type FormFieldType =
  | "checkbox"
  | "company"
  | "consent"
  | "date"
  | "email"
  | "file"
  | "hidden"
  | "multiCheckbox"
  | "number"
  | "phone"
  | "radio"
  | "range"
  | "rating"
  | "select"
  | "text"
  | "textarea"
  | "time"
  | "url";

export type FormStep = {
  description: string;
  id: string;
  title: string;
};

export type FormField = {
  conditionalFieldId: string;
  conditionalValue: string;
  crmField: string;
  defaultValue: string;
  errorMessage: string;
  fileAccept: string;
  fileMaxMb: number;
  helpText: string;
  id: string;
  label: string;
  maxValue: string;
  minValue: string;
  multiple: boolean;
  options: string[];
  placeholder: string;
  required: boolean;
  stepId: string;
  type: FormFieldType;
  validationPattern: string;
};

export function createFormField(input: {
  conditionalFieldId?: string;
  conditionalValue?: string;
  crmField: string;
  defaultValue?: string;
  errorMessage?: string;
  fileAccept?: string;
  fileMaxMb?: number;
  helpText?: string;
  id: string;
  label: string;
  maxValue?: string;
  minValue?: string;
  multiple?: boolean;
  options?: string[];
  placeholder?: string;
  required?: boolean;
  stepId?: string;
  type: FormFieldType;
  validationPattern?: string;
}): FormField {
  return {
    conditionalFieldId: input.conditionalFieldId ?? "",
    conditionalValue: input.conditionalValue ?? "",
    crmField: input.crmField,
    defaultValue: input.defaultValue ?? "",
    errorMessage: input.errorMessage ?? "",
    fileAccept: input.fileAccept ?? "",
    fileMaxMb: input.fileMaxMb ?? 0,
    helpText: input.helpText ?? "",
    id: input.id,
    label: input.label,
    maxValue: input.maxValue ?? "",
    minValue: input.minValue ?? "",
    multiple: input.multiple ?? false,
    options: input.options ?? [],
    placeholder: input.placeholder ?? "",
    required: input.required ?? false,
    stepId: input.stepId ?? "",
    type: input.type,
    validationPattern: input.validationPattern ?? "",
  };
}

export type WebsiteForm = {
  actions: {
    createTask: boolean;
    followUpEmail: boolean;
    internalNotification: boolean;
    newsletterList: boolean;
    redirectUrl: string;
    showMeeting: boolean;
    thankYouMessage: string;
  };
  campaign: string;
  conversionRate: number;
  crmTarget: FormTarget;
  doubleOptIn: boolean;
  fields: FormField[];
  funnelId: string;
  id: string;
  lastSubmission: string;
  name: string;
  ownerMode: "roundRobin" | "user";
  ownerUserId: string;
  pipelineStage: string;
  progressMode: FormProgressMode;
  spamProtection: boolean;
  status: FormStatus;
  steps: FormStep[];
  submissions: number;
  tags: string;
  template: FormTemplate;
  utmCapture: boolean;
  variant: FormVariant;
  visits: number;
};

export type FormSubmissionSummary = {
  contactEmail: string;
  contactName: string;
  createdAt: string;
  formId: string;
  id: string;
  intent: string;
  leadId: string | null;
  nextAction: string;
  score: number;
  status: string;
};

export type FormsRuntimePayload = {
  error?: string;
  forms: WebsiteForm[];
  source: "database" | "fallback";
  submissions: FormSubmissionSummary[];
};

export function isFormLayoutVariant(value: FormVariant): value is FormLayoutVariant {
  return formLayoutVariants.includes(value as FormLayoutVariant);
}

export function isFormPublishVariant(value: FormVariant): value is FormPublishVariant {
  return formPublishVariants.includes(value as FormPublishVariant);
}

export function resolveRuntimeLayoutVariant(value: FormVariant): FormLayoutVariant {
  if (isFormLayoutVariant(value)) return value;
  if (value === "button") return "popup";
  return "embed";
}

export function isOptionFieldType(value: FormFieldType) {
  return value === "select" || value === "radio" || value === "multiCheckbox";
}

export function isNumericFieldType(value: FormFieldType) {
  return value === "number" || value === "range" || value === "rating";
}
