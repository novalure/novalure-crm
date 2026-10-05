export const DEFAULT_PURCHASE_ANCILLARY_RATE = "4.6";

export type PurchaseAncillaryCalculation = {
  mode: "percentage";
  rateBps: number;
  version: 1;
  jurisdiction: "AT";
};

/** Percentage points to basis points: "4,6" -> 460. No exponent/grouping/percent suffix. */
export function parsePurchaseAncillaryRate(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (!/^(?:0|[1-9]\d{0,2})(?:[.,]\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.replace(",", ".").split(".");
  const bps = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return bps <= 10_000 ? bps : null;
}

/** Integer-cent arithmetic, non-negative half-up rounding, no float money multiplication. */
export function calculatePurchaseAncillaryCents(priceCents: number, rateBps: number): number | null {
  if (!Number.isSafeInteger(priceCents) || priceCents < 0 || !Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10_000) return null;
  const amount = (BigInt(priceCents) * BigInt(rateBps) + BigInt(5_000)) / BigInt(10_000);
  return amount <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(amount) : null;
}

/** Only the versioned, allowlisted calculation is trusted; extra keys are rejected. */
export function normalizePurchaseAncillaryCalculation(value: unknown): PurchaseAncillaryCalculation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = ["mode", "rateBps", "version", "jurisdiction"];
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key)) ||
      record.mode !== "percentage" || record.version !== 1 || record.jurisdiction !== "AT" ||
      typeof record.rateBps !== "number" || !Number.isInteger(record.rateBps) || record.rateBps < 0 || record.rateBps > 10_000) return null;
  return { mode: "percentage", rateBps: record.rateBps, version: 1, jurisdiction: "AT" };
}

export function readPurchaseAncillaryCalculation(canonicalPayload: unknown): PurchaseAncillaryCalculation | null {
  if (!canonicalPayload || typeof canonicalPayload !== "object" || Array.isArray(canonicalPayload)) return null;
  return normalizePurchaseAncillaryCalculation((canonicalPayload as Record<string, unknown>).purchaseAncillaryCalculation);
}
