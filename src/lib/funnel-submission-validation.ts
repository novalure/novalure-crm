import type {
  FunnelBlueprint,
  FunnelFieldType,
  FunnelSubmissionPayload,
} from "@/lib/funnel-schema";
import {
  getFunnelConsentCategories,
} from "./funnel-consent.js";

type FunnelConsentCategories = ReturnType<typeof getFunnelConsentCategories>;

type AnswerValue = FunnelSubmissionPayload["answers"][string];

type CanonicalField = {
  aliases: string[];
  canonicalKey: string;
  consentCategories?: FunnelConsentCategories;
  label: string;
  max?: number;
  min?: number;
  options: string[];
  required: boolean;
  type: FunnelFieldType | "choice";
};

export type CanonicalFunnelSubmissionSemantics = Readonly<{
  budget: string;
  contactName: string;
  email: string;
  intent: string;
  phone: string;
}>;

export class FunnelSubmissionValidationError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status = 400) {
    super(code);
    this.name = "FunnelSubmissionValidationError";
    this.code = code;
    this.status = status;
  }
}

export function canonicalizeFunnelSubmissionPayload(
  blueprint: FunnelBlueprint,
  payload: FunnelSubmissionPayload,
): FunnelSubmissionPayload {
  const fields = collectCanonicalFields(blueprint);
  const aliasToField = buildCanonicalFieldAliasIndex(fields);

  for (const key of Object.keys(payload.answers)) {
    if (!aliasToField.has(key)) {
      throw new FunnelSubmissionValidationError("unknown_funnel_answer");
    }
  }

  const answers: FunnelSubmissionPayload["answers"] = {};
  for (const field of fields) {
    const supplied = field.aliases
      .filter((alias) => Object.hasOwn(payload.answers, alias))
      .map((alias) => payload.answers[alias]);
    if (supplied.length > 1 && supplied.slice(1).some((value) => !answersEqual(value, supplied[0]))) {
      throw new FunnelSubmissionValidationError("funnel_answer_alias_conflict");
    }

    const value = supplied[0] ?? null;
    validateCanonicalAnswer(field, value);
    if (supplied.length > 0) answers[field.canonicalKey] = value;
  }

  assertSingleTypedIdentity(fields, answers, "email");
  assertSingleTypedIdentity(fields, answers, "phone");

  const consent = deriveCanonicalConsent(fields, answers);
  if (
    payload.consent.analytics !== consent.analytics ||
    payload.consent.marketing !== consent.marketing ||
    payload.consent.privacy !== consent.privacy
  ) {
    throw new FunnelSubmissionValidationError("funnel_consent_mismatch", 422);
  }

  return { ...payload, answers, consent };
}

export function validateFunnelBlueprintSubmissionContract(blueprint: FunnelBlueprint) {
  buildCanonicalFieldAliasIndex(collectCanonicalFields(blueprint));
}

export function resolveCanonicalFunnelSubmissionSemantics(
  blueprint: FunnelBlueprint,
  answers: FunnelSubmissionPayload["answers"],
): CanonicalFunnelSubmissionSemantics {
  const fields = collectCanonicalFields(blueprint);
  const email = firstCanonicalString(fields.filter((field) => field.type === "email"), answers);
  const phone = firstCanonicalString(fields.filter((field) => field.type === "phone"), answers);

  return {
    budget: firstSemanticString(fields, answers, /(budget|price|preis|investment|kaufpreis)/iu),
    contactName: firstSemanticString(
      fields,
      answers,
      /(^|[^a-z])(full.?name|fullname|contact.?name|name|vorname|nachname)([^a-z]|$)/iu,
    ),
    email,
    intent: firstSemanticString(
      fields,
      answers,
      /(intent|bedarf|interest|interesse|message|nachricht|anliegen)/iu,
    ),
    phone,
  };
}

export function scoreCanonicalFunnelAnswers(
  answers: FunnelSubmissionPayload["answers"],
) {
  const score = Object.values(answers).reduce<number>((total, value) => {
    if (value === true) return total + 5;
    if (typeof value === "number" && value > 0) return total + Math.min(20, value);
    if (typeof value === "string" && value.trim()) return total + 10;
    if (Array.isArray(value) && value.length > 0) return total + value.length * 5;
    return total;
  }, 0);
  return Math.min(100, Math.max(0, score));
}

function collectCanonicalFields(blueprint: FunnelBlueprint) {
  const fields: CanonicalField[] = [];
  const canonicalKeys = new Set<string>();
  for (const page of blueprint.pages) {
    for (const section of page.sections) {
      for (const row of section.rows) {
        for (const column of row.columns) {
          for (const element of column.elements) {
            for (const field of element.fields ?? []) {
              const canonicalKey = field.crmField.trim() || field.id.trim();
              pushCanonicalField(fields, canonicalKeys, {
                aliases: uniqueNonEmpty([field.id, field.crmField]),
                canonicalKey,
                ...(field.type === "consent"
                  ? { consentCategories: getFunnelConsentCategories(field) }
                  : {}),
                label: field.label,
                max: field.max,
                min: field.min,
                options: field.options ?? [],
                required: field.required,
                type: field.type,
              });
            }
            if (element.type === "choice") {
              const canonicalKey = element.crmField?.trim() || element.id.trim();
              pushCanonicalField(fields, canonicalKeys, {
                aliases: uniqueNonEmpty([element.id, element.crmField]),
                canonicalKey,
                label: element.name,
                options: element.options ?? [],
                required: element.required === true,
                type: "choice",
              });
            }
          }
        }
      }
    }
  }
  return fields;
}

function pushCanonicalField(
  fields: CanonicalField[],
  canonicalKeys: Set<string>,
  field: CanonicalField,
) {
  if (!field.canonicalKey || field.aliases.length === 0 || canonicalKeys.has(field.canonicalKey)) {
    throw new FunnelSubmissionValidationError("funnel_blueprint_field_alias_conflict", 503);
  }
  canonicalKeys.add(field.canonicalKey);
  fields.push(field);
}

function buildCanonicalFieldAliasIndex(fields: CanonicalField[]) {
  const aliasToField = new Map<string, CanonicalField>();
  for (const field of fields) {
    for (const alias of field.aliases) {
      const existing = aliasToField.get(alias);
      if (existing && existing !== field) {
        throw new FunnelSubmissionValidationError("funnel_blueprint_field_alias_conflict", 503);
      }
      aliasToField.set(alias, field);
    }
  }
  return aliasToField;
}

function validateCanonicalAnswer(field: CanonicalField, value: AnswerValue) {
  if (field.required && isMissingRequiredValue(field.type, value)) {
    throw new FunnelSubmissionValidationError(`required_funnel_field_missing:${field.canonicalKey}`, 422);
  }
  if (value === null || value === "" || (Array.isArray(value) && value.length === 0)) return;

  if (field.type === "consent") {
    if (typeof value !== "boolean") throw new FunnelSubmissionValidationError("invalid_funnel_field_type", 422);
    return;
  }
  if (field.type === "number" || field.type === "slider" || field.type === "rating") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new FunnelSubmissionValidationError("invalid_funnel_field_type", 422);
    }
    if (typeof field.min === "number" && value < field.min) {
      throw new FunnelSubmissionValidationError("funnel_field_out_of_range", 422);
    }
    if (typeof field.max === "number" && value > field.max) {
      throw new FunnelSubmissionValidationError("funnel_field_out_of_range", 422);
    }
    return;
  }
  if (field.type === "multiChoice") {
    if (
      !Array.isArray(value) ||
      value.some((item) => typeof item !== "string") ||
      new Set(value).size !== value.length ||
      value.some((item) => !field.options.includes(item))
    ) {
      throw new FunnelSubmissionValidationError("invalid_funnel_field_option", 422);
    }
    return;
  }
  if (field.type === "singleChoice" || field.type === "dropdown" || field.type === "choice") {
    if (typeof value !== "string" || !field.options.includes(value)) {
      throw new FunnelSubmissionValidationError("invalid_funnel_field_option", 422);
    }
    return;
  }
  if (typeof value !== "string") {
    throw new FunnelSubmissionValidationError("invalid_funnel_field_type", 422);
  }
  if (field.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)) {
    throw new FunnelSubmissionValidationError("invalid_funnel_email", 422);
  }
  if (field.type === "phone" && !/^\+?[0-9\s()./-]{6,}$/u.test(value)) {
    throw new FunnelSubmissionValidationError("invalid_funnel_phone", 422);
  }
  if (field.type === "url" && !isSafeAbsoluteHttpUrl(value)) {
    throw new FunnelSubmissionValidationError("invalid_funnel_url", 422);
  }
  if (field.type === "date" && !isValidIsoDate(value)) {
    throw new FunnelSubmissionValidationError("invalid_funnel_date", 422);
  }
  if (field.type === "time" && !isValidTime(value)) {
    throw new FunnelSubmissionValidationError("invalid_funnel_time", 422);
  }
}

function isMissingRequiredValue(type: CanonicalField["type"], value: AnswerValue) {
  if (type === "consent") return value !== true;
  if (Array.isArray(value)) return value.length === 0;
  return value === null || value === "" || value === false;
}

function answersEqual(left: AnswerValue, right: AnswerValue) {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => value === right[index]);
  }
  return Object.is(left, right);
}

function assertSingleTypedIdentity(
  fields: CanonicalField[],
  answers: FunnelSubmissionPayload["answers"],
  type: "email" | "phone",
) {
  const values = fields
    .filter((field) => field.type === type)
    .map((field) => answers[field.canonicalKey])
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .map((value) => type === "email"
      ? value.trim().toLowerCase()
      : value.replace(/[^0-9+]/gu, ""))
    .filter(Boolean);
  if (new Set(values).size > 1) {
    throw new FunnelSubmissionValidationError(`multiple_funnel_${type}_values`, 422);
  }
}

function deriveCanonicalConsent(
  fields: CanonicalField[],
  answers: FunnelSubmissionPayload["answers"],
): FunnelSubmissionPayload["consent"] {
  const consent = { analytics: false, marketing: false, privacy: false };
  for (const field of fields) {
    if (field.type !== "consent" || answers[field.canonicalKey] !== true) continue;
    consent.analytics ||= field.consentCategories?.analytics === true;
    consent.marketing ||= field.consentCategories?.marketing === true;
    consent.privacy ||= field.consentCategories?.privacy === true;
  }
  return consent;
}

function firstCanonicalString(
  fields: CanonicalField[],
  answers: FunnelSubmissionPayload["answers"],
) {
  for (const field of fields) {
    const value = answers[field.canonicalKey];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function firstSemanticString(
  fields: CanonicalField[],
  answers: FunnelSubmissionPayload["answers"],
  pattern: RegExp,
) {
  return firstCanonicalString(
    fields.filter((field) => pattern.test(`${field.canonicalKey} ${field.label}`)),
    answers,
  );
}

function uniqueNonEmpty(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map((value) => value?.trim() ?? "").filter(Boolean)));
}

function isSafeAbsoluteHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function isValidIsoDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day;
}

function isValidTime(value: string) {
  const match = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/u.exec(value);
  if (!match) return false;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] ?? "0");
  return hours <= 23 && minutes <= 59 && seconds <= 59;
}
