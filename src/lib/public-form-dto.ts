import type {
  FormField,
  FormFieldType,
  FormProgressMode,
  FormStep,
  WebsiteForm,
} from "@/lib/form-types";
import { isLaunchSurfaceEnabled } from "@/lib/launch-scope";

const privacyConsentFields = new Set(["privacy", "privacy_consent"]);
const marketingConsentFields = new Set(["marketing_consent", "newsletter_consent"]);
const analyticsConsentFields = new Set(["analytics_consent"]);

export type PublicFormFieldType = Exclude<FormFieldType, "file" | "hidden">;

export type PublicFormFieldDto = Readonly<{
  defaultValue: string;
  errorMessage: string;
  helpText: string;
  id: string;
  label: string;
  maxValue: string;
  minValue: string;
  name: string;
  options: string[];
  placeholder: string;
  required: boolean;
  stepId: string;
  type: PublicFormFieldType;
  validationPattern: string;
  visibleWhen: Readonly<{ fieldId: string; value: string }> | null;
}>;

export type PublicFormDto = Readonly<{
  fields: PublicFormFieldDto[];
  name: string;
  progressMode: FormProgressMode;
  steps: FormStep[];
  thankYouMessage: string;
}>;

export type PublicFormLaunchBlockReason =
  | "form_consent_configuration_unavailable"
  | "form_custom_pattern_unavailable"
  | "form_file_upload_unavailable"
  | "form_owner_unavailable"
  | "form_round_robin_unavailable";

/**
 * Explicit public render contract. Keep this projection intentionally small:
 * ownership, CRM routing, campaigns, counters, funnel IDs and automation
 * actions are server-side configuration and must never cross the public RSC
 * boundary.
 */
export function toPublicFormDto(form: WebsiteForm): PublicFormDto {
  return {
    fields: form.fields.flatMap((field) => {
      if (field.type === "file" || field.type === "hidden") return [];
      const conditionController = form.fields.find((candidate) =>
        candidate.id === field.conditionalFieldId ||
        candidate.crmField === field.conditionalFieldId
      );
      if (
        conditionController?.type === "hidden" &&
        conditionController.defaultValue !== field.conditionalValue
      ) return [];
      return [{
        defaultValue: field.defaultValue,
        errorMessage: field.errorMessage,
        helpText: field.helpText,
        id: field.id,
        label: field.label,
        maxValue: field.maxValue,
        minValue: field.minValue,
        name: field.id,
        options: [...field.options],
        placeholder: field.placeholder,
        required: field.required,
        stepId: field.stepId,
        type: field.type,
        validationPattern: field.validationPattern,
        visibleWhen: conditionController && conditionController.type !== "hidden" && field.conditionalValue
          ? { fieldId: conditionController.id, value: field.conditionalValue }
          : null,
      }];
    }),
    name: form.name,
    progressMode: form.progressMode,
    steps: form.steps.map((step) => ({
      description: step.description,
      id: step.id,
      title: step.title,
    })),
    thankYouMessage: form.actions.thankYouMessage,
  };
}

export function getPublicFormLaunchBlockReason(
  form: WebsiteForm,
  ownerActive = true,
): PublicFormLaunchBlockReason | null {
  if (form.ownerMode !== "user" && !isLaunchSurfaceEnabled("publicFormRoundRobin")) {
    return "form_round_robin_unavailable";
  }
  if (!ownerActive) return "form_owner_unavailable";
  if (
    !isLaunchSurfaceEnabled("publicFormCustomPattern") &&
    form.fields.some((field) => Boolean(field.validationPattern.trim()))
  ) {
    return "form_custom_pattern_unavailable";
  }
  if (
    !isLaunchSurfaceEnabled("publicFormAdvancedConsent") &&
    !hasSupportedPublicConsentConfiguration(form)
  ) {
    return "form_consent_configuration_unavailable";
  }
  if (
    !isLaunchSurfaceEnabled("publicFormFileUpload") &&
    form.fields.some((field) => field.type === "file")
  ) {
    return "form_file_upload_unavailable";
  }
  return null;
}

export function isPrivacyConsentField(field: FormField) {
  return field.type === "consent" && privacyConsentFields.has(normalizeConsentField(field.crmField));
}

export function isMarketingConsentField(field: FormField) {
  return marketingConsentFields.has(normalizeConsentField(field.crmField));
}

export function hasSupportedPublicConsentConfiguration(form: WebsiteForm) {
  const consentFields = form.fields.filter((field) => field.type === "consent");
  if (consentFields.some((field) => !isPrivacyConsentField(field))) return false;
  if (form.fields.some((field) => analyticsConsentFields.has(normalizeConsentField(field.crmField)))) return false;
  if (form.fields.some((field) =>
    isMarketingConsentField(field) &&
    (
      field.type !== "checkbox" ||
      Boolean(field.defaultValue.trim()) ||
      Boolean(field.conditionalFieldId) ||
      Boolean(field.conditionalValue)
    )
  )) return false;
  return consentFields.some((field) =>
    isPrivacyConsentField(field) &&
    field.required &&
    !field.defaultValue.trim() &&
    !field.conditionalFieldId &&
    !field.conditionalValue
  );
}

function normalizeConsentField(value: string) {
  return value.trim().toLowerCase();
}
