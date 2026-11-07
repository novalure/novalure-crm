import { parsePropertyIntegerCents } from "./property-money";

export type PropertyCoreNumericField = "areaSqm" | "price";
export type PropertyCoreNumericState = { version: 1; areaSqm: "known" | "unknown"; price: "known" | "unknown"; publicPrice?: "known" | "unknown"; rentPrice?: "known" | "unknown" };

/** Existing zero columns remain legacy unknown sentinels. Only versioned server
 * writes can state that a new, explicitly supplied zero is actually known. */
export function propertyCoreNumberIsKnown(canonicalPayload: unknown, field: PropertyCoreNumericField, storedValue: unknown): boolean {
  const payload = canonicalPayload && typeof canonicalPayload === "object" && !Array.isArray(canonicalPayload) ? canonicalPayload as Record<string, unknown> : {};
  const state = payload.coreNumericState && typeof payload.coreNumericState === "object" && !Array.isArray(payload.coreNumericState)
    ? payload.coreNumericState as Record<string, unknown> : {};
  const number = typeof storedValue === "number" || typeof storedValue === "string" && storedValue.trim() !== "" ? Number(storedValue) : Number.NaN;
  if (!Number.isFinite(number) || number < 0) return false;
  return state.version === 1 ? state[field] === "known" : number > 0;
}

/** Nullable legacy zero prices can also originate from an empty guided form.
 * Stamping an unrelated core field must never turn those old sentinels into a
 * public free offer. Only the specific optional-price flag can qualify a zero. */
export function propertyOptionalPriceIsKnown(canonicalPayload: unknown, field: "publicPrice" | "rentPrice", storedCents: unknown): boolean {
  const cents = parsePropertyIntegerCents(storedCents);
  if (cents === null) return false;
  const payload = canonicalPayload && typeof canonicalPayload === "object" && !Array.isArray(canonicalPayload) ? canonicalPayload as Record<string, unknown> : {};
  const state = payload.coreNumericState && typeof payload.coreNumericState === "object" && !Array.isArray(payload.coreNumericState) ? payload.coreNumericState as Record<string, unknown> : {};
  if (state.version === 1 && Object.hasOwn(state, field)) return state[field] === "known";
  return cents > 0;
}
