import type { PropertyPriceVisibility } from "./crm-types";

const policies = ["publish_price", "price_on_request", "hide_price"] as const;
const websiteKeys = ["Eigene Website", "Website"] as const;
const validPolicy = (value: unknown): value is PropertyPriceVisibility =>
  typeof value === "string" && policies.includes(value as PropertyPriceVisibility);

/** Native UI key plus the historical Website key. Only present website aliases
 * compete; an explicit channel override retains precedence over the global rule.
 * Read without rewriting stored maps or unrelated channel policies.
 */
export function resolveWebsitePriceVisibility(channels: unknown, fallback: unknown): PropertyPriceVisibility {
  const values = channels && typeof channels === "object" && !Array.isArray(channels)
    ? websiteKeys.filter(key => Object.hasOwn(channels, key)).map(key => Reflect.get(channels, key))
    : [];
  if (!values.length) return validPolicy(fallback) ? fallback : "hide_price";
  if (values.some(value => !validPolicy(value) || value === "hide_price")) return "hide_price";
  return values.includes("price_on_request") ? "price_on_request" : "publish_price";
}

/** Preserve the same fail-closed meaning in read DTOs. Their older generic
 * normalization must not turn a malformed website policy into publish_price
 * before an unrelated channel edit is saved back by the UI.
 */
export function websitePriceVisibilityReadValues(channels: unknown): Record<string, PropertyPriceVisibility> {
  if (!channels || typeof channels !== "object" || Array.isArray(channels)) return {};
  return Object.fromEntries(websiteKeys.filter(key => Object.hasOwn(channels, key)).map(key => {
    const value: unknown = Reflect.get(channels, key);
    return [key, validPolicy(value) ? value : "hide_price"];
  }));
}
