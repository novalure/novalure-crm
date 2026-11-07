import type { PropertyPriceVisibility } from "./crm-types";
import { resolveWebsitePriceVisibility } from "./property-website-price-visibility";

export type PropertyChannelPriceEdits = Readonly<Record<string, PropertyPriceVisibility>>;

export type PropertyChannelPriceState = {
  propertyId: string;
  workspaceId: string;
  projectId: string | null;
  revision: string;
  priceVisibility: PropertyPriceVisibility;
  channelPriceVisibility: Record<string, PropertyPriceVisibility>;
};

/** Existing-object edits merge into that object's current saved map. They never
 * borrow defaults or pending values from the separate property-create wizard.
 */
export function applyPropertyChannelPriceEdits(
  saved: Readonly<Record<string, PropertyPriceVisibility>> | null | undefined,
  edits: PropertyChannelPriceEdits = {},
): Record<string, PropertyPriceVisibility> {
  const result = { ...saved, ...edits };
  // Only an explicit native Website edit replaces its historical alias. Merely
  // viewing or editing another channel must retain an existing restrictive key.
  if (Object.hasOwn(edits, "Eigene Website")) delete result.Website;
  return result;
}

export function propertyChannelPriceValue(
  map: Readonly<Record<string, PropertyPriceVisibility>>,
  channel: string,
  fallback: PropertyPriceVisibility,
): PropertyPriceVisibility {
  return channel === "Eigene Website" ? resolveWebsitePriceVisibility(map, fallback) : map[channel] ?? fallback;
}
