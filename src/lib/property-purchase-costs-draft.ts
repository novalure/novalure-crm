import type { PropertyDraft } from "./property-draft-store";
import { parsePropertyEuroCents } from "./property-money";
import { calculatePurchaseAncillaryCents, parsePurchaseAncillaryRate } from "./property-purchase-costs";

/** Auto amounts are derived again by the server; never submit a stale preview amount. */
export function propertyPurchaseCostsPayload(draft: PropertyDraft) {
  if (draft.marketingType === "rent") return {};
  if (draft.purchaseAncillaryMode === undefined) return {};
  if (draft.purchaseAncillaryMode === "manual") {
    if (draft.purchaseAncillaryCosts.trim() && parsePropertyEuroCents(draft.purchaseAncillaryCosts) === null) {
      throw new Error("Invalid property editor purchase ancillary amount");
    }
    return { purchaseAncillaryCalculation: null, purchaseAncillaryCosts: draft.purchaseAncillaryCosts };
  }
  const rateBps = parsePurchaseAncillaryRate(draft.purchaseAncillaryRate);
  const priceCents = parsePropertyEuroCents(draft.price);
  if (rateBps === null || priceCents === null || calculatePurchaseAncillaryCents(priceCents, rateBps) === null) {
    throw new Error("Invalid property editor purchase ancillary rate or purchase price");
  }
  return { purchaseAncillaryCalculation: { mode: "percentage" as const, rateBps, version: 1 as const, jurisdiction: "AT" as const }, purchaseAncillaryCosts: undefined };
}
