export type PropertyCoreNumericField = "areaSqm" | "price";
export type PropertyCoreNumericState = { version: 1; areaSqm: "known" | "unknown"; price: "known" | "unknown" };

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
