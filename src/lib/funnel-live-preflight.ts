import type { FunnelBlueprint, FunnelElement, FunnelField } from "@/lib/funnel-schema";
import { validateFunnelBlueprintSubmissionContract } from "@/lib/funnel-submission-validation";
import { getFunnelConsentCategories } from "./funnel-consent.js";

export type FunnelLivePreflight = Readonly<{
  blockers: string[];
  ok: boolean;
}>;

export class FunnelLivePreflightError extends Error {
  readonly preflight: FunnelLivePreflight;

  constructor(preflight: FunnelLivePreflight) {
    super("Funnel live preflight blocked publish");
    this.name = "FunnelLivePreflightError";
    this.preflight = preflight;
  }
}

export function runFunnelLivePreflight(blueprint: FunnelBlueprint): FunnelLivePreflight {
  const blockers: string[] = [];
  const elements = collectFunnelElements(blueprint);
  const formElements = elements.filter((element) => element.type === "form");
  const formFields = formElements.flatMap((element) => element.fields ?? []);

  if (!cleanString(blueprint.name)) blockers.push("name_missing");
  if (!cleanString(blueprint.projectId)) blockers.push("project_missing");
  if (formFields.length === 0) blockers.push("contact_form_missing");
  if (formElements.length !== 1) blockers.push("single_form_runtime_required");
  if (!hasRequiredPrivacyConsentField(formFields)) blockers.push("privacy_consent_missing");
  if (!cleanString(blueprint.crmHandover?.destination)) blockers.push("crm_handover_missing");
  if (formFields.some((field) => field.type === "file")) blockers.push("file_field_runtime_unavailable");
  if (formFields.some((field) => cleanString(field.validationPattern))) {
    blockers.push("custom_pattern_runtime_unavailable");
  }

  try {
    validateFunnelBlueprintSubmissionContract(blueprint);
  } catch {
    blockers.push("blueprint_field_alias_conflict");
  }

  for (const element of elements) {
    const contributesRequiredAnswer = element.type === "form"
      ? (element.fields ?? []).some((field) => field.required)
      : element.type === "choice" && element.required === true;
    if (element.type === "form" || contributesRequiredAnswer) {
      if (element.condition) blockers.push(`conditional_required_runtime_unsupported:${element.id}`);
      if (element.visibility && Object.values(element.visibility).some((visible) => visible === false)) {
        blockers.push(`device_hidden_required_runtime_unsupported:${element.id}`);
      }
    }
  }

  for (const field of formFields) {
    if (field.required && !cleanString(field.label)) {
      blockers.push(`required_field_label_missing:${cleanString(field.id) || "unknown"}`);
    }
  }

  const uniqueBlockers = Array.from(new Set(blockers));
  return { blockers: uniqueBlockers, ok: uniqueBlockers.length === 0 };
}

export function assertFunnelLivePreflight(blueprint: FunnelBlueprint) {
  if (blueprint.status !== "aktiv") return runFunnelLivePreflight(blueprint);
  const preflight = runFunnelLivePreflight(blueprint);
  if (!preflight.ok) throw new FunnelLivePreflightError(preflight);
  return preflight;
}

function collectFunnelElements(blueprint: FunnelBlueprint) {
  const elements: FunnelElement[] = [];
  for (const page of blueprint.pages ?? []) {
    for (const section of page.sections ?? []) {
      for (const row of section.rows ?? []) {
        for (const column of row.columns ?? []) {
          elements.push(...(column.elements ?? []));
        }
      }
    }
  }
  return elements;
}

function hasRequiredPrivacyConsentField(fields: FunnelField[]) {
  return fields.some((field) =>
    field.type === "consent" &&
    field.required &&
    getFunnelConsentCategories(field).privacy
  );
}

function cleanString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}
