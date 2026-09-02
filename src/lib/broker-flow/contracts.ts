export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const searchProfileStatuses = ["draft", "active", "paused", "expired", "archived"] as const;
export type SearchProfileStatus = (typeof searchProfileStatuses)[number];

export const matchDecisionStatuses = ["new", "shortlisted", "declined", "archived"] as const;
export type MatchDecisionStatus = (typeof matchDecisionStatuses)[number];

export const offerStatuses = ["draft", "ready", "withdrawn"] as const;
export type OfferStatus = (typeof offerStatuses)[number];

export const viewingStatuses = ["planned", "confirmed", "completed", "cancelled", "no_show"] as const;
export type ViewingStatus = (typeof viewingStatuses)[number];

export const closingStatuses = ["draft", "reviewed", "signed", "invoiced", "paid", "cancelled", "reversed"] as const;
export type ClosingStatus = (typeof closingStatuses)[number];

export const paymentStatuses = ["unpaid", "partially_paid", "paid", "overdue", "refunded"] as const;
export type PaymentStatus = (typeof paymentStatuses)[number];

export const activityTypes = [
  "call",
  "email",
  "viewing",
  "note",
  "offer",
  "question",
  "negotiation",
  "document_sent",
  "closing",
  "other",
] as const;
export type BrokerActivityType = (typeof activityTypes)[number];

export class BrokerDomainError extends Error {
  readonly code: string;
  readonly details?: unknown;
  readonly status: number;

  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = "BrokerDomainError";
    this.code = code;
    this.details = details;
    this.status = status;
  }
}

export function asRecord(value: unknown, field = "payload"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrokerDomainError("invalid_payload", `${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function cleanString(value: unknown, maximum = 10_000) {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  if (normalized.length > maximum) {
    throw new BrokerDomainError("text_too_long", `Text exceeds the ${maximum} character limit.`);
  }
  return normalized;
}

export function requiredString(value: unknown, field: string, maximum = 500) {
  const normalized = cleanString(value, maximum);
  if (!normalized) throw new BrokerDomainError("required_field", `${field} is required.`);
  return normalized;
}

export function optionalString(value: unknown, maximum = 500): string | null {
  const normalized = cleanString(value, maximum);
  return normalized || null;
}

export function requiredUuid(value: unknown, field: string) {
  const normalized = cleanString(value, 64);
  if (!uuidPattern.test(normalized)) {
    throw new BrokerDomainError("invalid_reference", `${field} must be a valid UUID.`);
  }
  return normalized;
}

export function optionalUuid(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  return requiredUuid(value, field);
}

export function optionalFiniteNumber(value: unknown, field: string, minimum?: number, maximum?: number): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new BrokerDomainError("invalid_number", `${field} must be a finite number.`);
  }
  if (minimum !== undefined && parsed < minimum) {
    throw new BrokerDomainError("number_out_of_range", `${field} must be at least ${minimum}.`);
  }
  if (maximum !== undefined && parsed > maximum) {
    throw new BrokerDomainError("number_out_of_range", `${field} must be at most ${maximum}.`);
  }
  return parsed;
}

export function requiredInteger(value: unknown, field: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = optionalFiniteNumber(value, field, minimum, maximum);
  if (parsed === null || !Number.isSafeInteger(parsed)) {
    throw new BrokerDomainError("invalid_integer", `${field} must be a safe integer.`);
  }
  return parsed;
}

export function optionalInteger(value: unknown, field: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number | null {
  if (value === null || value === undefined || value === "") return null;
  return requiredInteger(value, field, minimum, maximum);
}

export function optionalIsoDate(value: unknown, field: string): string | null {
  const normalized = optionalString(value, 64);
  if (!normalized) return null;
  const parsed = new Date(normalized);
  if (!Number.isFinite(parsed.getTime())) {
    throw new BrokerDomainError("invalid_date", `${field} must be an ISO date or timestamp.`);
  }
  return parsed.toISOString();
}

export function stringList(value: unknown, field: string, maximumItems = 50, maximumItemLength = 160) {
  if (value === null || value === undefined) return [] as string[];
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new BrokerDomainError("invalid_list", `${field} must contain at most ${maximumItems} entries.`);
  }
  const unique = new Set<string>();
  for (const entry of value) {
    const normalized = requiredString(entry, field, maximumItemLength);
    unique.add(normalized);
  }
  return [...unique];
}

export function uuidList(value: unknown, field: string, maximumItems = 100) {
  if (value === null || value === undefined) return [] as string[];
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new BrokerDomainError("invalid_list", `${field} must contain at most ${maximumItems} IDs.`);
  }
  return [...new Set(value.map((entry) => requiredUuid(entry, field)))];
}

export function enumValue<const Values extends readonly string[]>(
  value: unknown,
  field: string,
  values: Values,
  fallback?: Values[number],
): Values[number] {
  const normalized = cleanString(value, 80);
  if (!normalized && fallback !== undefined) return fallback;
  if (!values.includes(normalized)) {
    throw new BrokerDomainError("invalid_status", `${field} must be one of: ${values.join(", ")}.`);
  }
  return normalized as Values[number];
}

export function booleanValue(value: unknown, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "boolean") throw new BrokerDomainError("invalid_boolean", "Expected a boolean value.");
  return value;
}

export function expectedVersion(value: unknown) {
  return requiredInteger(value, "expectedVersion", 1, 2_147_483_647);
}

export type Pagination = Readonly<{ limit: number; offset: number }>;

export function parsePagination(url: URL): Pagination {
  const rawLimit = url.searchParams.get("limit");
  const rawOffset = url.searchParams.get("offset");
  const limit = rawLimit === null ? 50 : requiredInteger(rawLimit, "limit", 1, 100);
  const offset = rawOffset === null ? 0 : requiredInteger(rawOffset, "offset", 0, 1_000_000);
  return { limit, offset };
}

export function requireIdempotencyKey(request: Request) {
  const value = request.headers.get("idempotency-key")?.trim() ?? "";
  if (!/^[A-Za-z0-9._:-]{16,160}$/u.test(value)) {
    throw new BrokerDomainError(
      "invalid_idempotency_key",
      "A 16-160 character Idempotency-Key header is required.",
    );
  }
  return value;
}

export function isValidTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
