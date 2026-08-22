import type { FormField } from "./form-types";

const phonePattern = /^\+?[0-9\s()./-]{6,}$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const optionFieldTypes = new Set<FormField["type"]>(["multiCheckbox", "radio", "select"]);
const numericFieldTypes = new Set<FormField["type"]>(["number", "range", "rating"]);

export function validatePublicFormFieldValue(field: FormField, value: unknown) {
  const values = normalizeValues(value);
  if (values.length === 0) return "";
  const reasonSuffix = `:${field.id}`;

  if (optionFieldTypes.has(field.type)) {
    const allowed = new Set(field.options);
    if (values.some((entry) => !allowed.has(entry))) return `invalid_option${reasonSuffix}`;
  }

  if (field.type === "rating" && values.some((entry) => !["1", "2", "3", "4", "5"].includes(entry))) {
    return `invalid_option${reasonSuffix}`;
  }

  if (field.type === "email" && values.some((entry) => !emailPattern.test(entry.trim()))) {
    return `invalid_email${reasonSuffix}`;
  }

  if (field.type === "phone" && values.some((entry) => !phonePattern.test(entry.trim()))) {
    return `invalid_phone${reasonSuffix}`;
  }

  if (field.type === "url" && values.some((entry) => !isAbsoluteUrl(entry))) {
    return `invalid_url${reasonSuffix}`;
  }

  if (numericFieldTypes.has(field.type)) {
    const minimum = parseConfiguredNumber(field.minValue);
    const maximum = parseConfiguredNumber(field.maxValue);
    if (minimum.invalid || maximum.invalid || (minimum.value !== null && maximum.value !== null && minimum.value > maximum.value)) {
      return `invalid_field_configuration${reasonSuffix}`;
    }
    for (const entry of values) {
      const numericValue = Number(entry);
      if (!Number.isFinite(numericValue)) return `invalid_number${reasonSuffix}`;
      if (minimum.value !== null && numericValue < minimum.value) return `invalid_min_value${reasonSuffix}`;
      if (maximum.value !== null && numericValue > maximum.value) return `invalid_max_value${reasonSuffix}`;
    }
  }

  if (field.type === "date") {
    const minimum = field.minValue ? parseIsoDate(field.minValue) : null;
    const maximum = field.maxValue ? parseIsoDate(field.maxValue) : null;
    if ((field.minValue && minimum === null) || (field.maxValue && maximum === null) || (minimum !== null && maximum !== null && minimum > maximum)) {
      return `invalid_field_configuration${reasonSuffix}`;
    }
    for (const entry of values) {
      const dateValue = parseIsoDate(entry);
      if (dateValue === null) return `invalid_date${reasonSuffix}`;
      if (minimum !== null && dateValue < minimum) return `invalid_min_value${reasonSuffix}`;
      if (maximum !== null && dateValue > maximum) return `invalid_max_value${reasonSuffix}`;
    }
  }

  if (field.type === "time") {
    const minimum = field.minValue ? parseTime(field.minValue) : null;
    const maximum = field.maxValue ? parseTime(field.maxValue) : null;
    if ((field.minValue && minimum === null) || (field.maxValue && maximum === null) || (minimum !== null && maximum !== null && minimum > maximum)) {
      return `invalid_field_configuration${reasonSuffix}`;
    }
    for (const entry of values) {
      const timeValue = parseTime(entry);
      if (timeValue === null) return `invalid_time${reasonSuffix}`;
      if (minimum !== null && timeValue < minimum) return `invalid_min_value${reasonSuffix}`;
      if (maximum !== null && timeValue > maximum) return `invalid_max_value${reasonSuffix}`;
    }
  }

  if (field.validationPattern) {
    let configuredPattern: RegExp;
    try {
      configuredPattern = new RegExp(`^(?:${field.validationPattern})$`, "u");
    } catch {
      return `invalid_field_configuration${reasonSuffix}`;
    }
    if (values.some((entry) => !configuredPattern.test(entry))) return `invalid_pattern${reasonSuffix}`;
  }

  return "";
}

function normalizeValues(value: unknown) {
  const values = Array.isArray(value) ? value : [value];
  return values
    .map((entry) => String(entry ?? ""))
    .filter((entry) => entry.trim() !== "");
}

function parseConfiguredNumber(value: string) {
  if (!value.trim()) return { invalid: false, value: null };
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? { invalid: false, value: parsed }
    : { invalid: true, value: null };
}

function isAbsoluteUrl(value: string) {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function parseIsoDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
    ? timestamp
    : null;
}

function parseTime(value: string) {
  const match = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] ?? "0");
  const milliseconds = Number((match[4] ?? "").padEnd(3, "0"));
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  return (((hours * 60) + minutes) * 60 + seconds) * 1_000 + milliseconds;
}
