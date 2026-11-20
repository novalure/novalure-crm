/**
 * A projection contract, not an authorization boundary or an HTTP endpoint.
 * A future server integration must authenticate and authorize the exact actor,
 * workspace, project, unit, purpose and individual fields before supplying a
 * database row. The existing synthetic service identity grants no access here.
 * Values are observations, not approved or customer-authoritative facts.
 */
export const PROPERTY_OBSERVATION_VERSION = "crm-property-observation-v1" as const;
export const PROPERTY_OBSERVATION_FIELDS = [
  "priceCents", "areaSqm", "rooms", "status", "balconyAreaSqm",
  "terraceAreaSqm", "gardenAreaSqm", "undergroundParkingCount",
  "carportCount", "outdoorParkingCount",
] as const;
export type PropertyObservationField = typeof PROPERTY_OBSERVATION_FIELDS[number];
export type PropertyObservationValueState = "PRESENT" | "EXPLICIT_UNKNOWN" | "NOT_EXPOSED";
export type PropertyObservationValue = number | "available" | "reserved" | "sold" | "blocked" | "UNKNOWN" | null;
export type PropertyObservation = Readonly<{
  contractVersion: typeof PROPERTY_OBSERVATION_VERSION;
  actorId: string;
  workspaceId: string;
  projectId: string;
  unitId: string;
  purpose: "property_read";
  sourceRevision: string;
  deploymentId: string;
  objectVersion: number;
  updatedAt: string;
  fields: readonly Readonly<{ field: PropertyObservationField; value: PropertyObservationValue; valueState: PropertyObservationValueState }>[];
  authority: "NOT_ESTABLISHED";
  sourceApproval: "NOT_EXPOSED";
}>;

const identifier = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha = /^[a-f0-9]{40}$/;
const deployment = /^dpl_[A-Za-z0-9]+$/;
const supported = new Set<string>(PROPERTY_OBSERVATION_FIELDS);
const integerFields = new Set<PropertyObservationField>(["priceCents", "undergroundParkingCount", "carportCount", "outdoorParkingCount"]);
const statuses = new Set(["available", "reserved", "sold", "blocked"]);

export type PropertyObservationInput = Readonly<{
  /** All scope fields are trusted server bindings, never caller-provided authority. */
  actorId: string; workspaceId: string; projectId: string; unitId: string;
  sourceRevision: string; deploymentId: string; objectVersion: number; updatedAt: string;
  requestedFields: readonly PropertyObservationField[];
  /** Selected raw columns. A missing property means the field was not exposed. */
  row: Readonly<Partial<Record<PropertyObservationField, unknown>>>;
}>;

function invalid(): never { throw new Error("CRM_PROPERTY_OBSERVATION_INVALID"); }

function numberValue(field: PropertyObservationField, raw: unknown): number {
  if (typeof raw !== "number" && typeof raw !== "string") return invalid();
  const text = String(raw);
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(text)) return invalid();
  if (integerFields.has(field) && !/^(?:0|[1-9]\d*)$/.test(text)) return invalid();
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) return invalid();
  if (integerFields.has(field) && !Number.isSafeInteger(value)) return invalid();
  if (field !== "priceCents" && value > 99_999_999) return invalid();
  return value;
}

/** Call only after the server has checked the current exact field-level grant. */
export function makePropertyObservation(input: PropertyObservationInput): PropertyObservation {
  if (![input.actorId, input.workspaceId, input.projectId, input.unitId].every(value => identifier.test(value)) ||
      !sha.test(input.sourceRevision) || !deployment.test(input.deploymentId) ||
      !Number.isSafeInteger(input.objectVersion) || input.objectVersion < 1 ||
      typeof input.updatedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(input.updatedAt) ||
      !Number.isFinite(Date.parse(input.updatedAt)) ||
      !Array.isArray(input.requestedFields) || input.requestedFields.length < 1 || input.requestedFields.length > PROPERTY_OBSERVATION_FIELDS.length ||
      new Set(input.requestedFields).size !== input.requestedFields.length || input.requestedFields.some(field => !supported.has(field)) ||
      !input.row || typeof input.row !== "object" || Array.isArray(input.row)) return invalid();

  const fields = input.requestedFields.map((field: PropertyObservationField) => {
    if (!Object.hasOwn(input.row, field)) return Object.freeze({ field, value: null, valueState: "NOT_EXPOSED" as const });
    const raw = input.row[field];
    if (raw === null) return Object.freeze({ field, value: null, valueState: "EXPLICIT_UNKNOWN" as const });
    if (field === "status") {
      if (typeof raw !== "string") return invalid();
      const value = statuses.has(raw) ? raw as "available" | "reserved" | "sold" | "blocked" : "UNKNOWN" as const;
      return Object.freeze({ field, value, valueState: "PRESENT" as const });
    }
    return Object.freeze({ field, value: numberValue(field, raw), valueState: "PRESENT" as const });
  });
  return Object.freeze({
    contractVersion: PROPERTY_OBSERVATION_VERSION, actorId: input.actorId.toLowerCase(),
    workspaceId: input.workspaceId.toLowerCase(), projectId: input.projectId.toLowerCase(), unitId: input.unitId.toLowerCase(),
    purpose: "property_read", sourceRevision: input.sourceRevision, deploymentId: input.deploymentId,
    objectVersion: input.objectVersion, updatedAt: input.updatedAt, fields: Object.freeze(fields),
    authority: "NOT_ESTABLISHED", sourceApproval: "NOT_EXPOSED",
  });
}
