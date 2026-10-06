// seller_listings.area_sqm and property_units.area_sqm use numeric(10,2).
// Accept decimal points/commas, but never strip arbitrary text or silently
// round an unsupported precision into a different stored area.
export const PROPERTY_AREA_MAX_SQM = 99_999_999.99;

export function isEmptyPropertyAreaInput(value: unknown) {
  return value == null || (typeof value === "string" && value.trim() === "");
}

export function parsePropertyAreaSqm(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  const text = String(value).trim();
  if (!/^\+?(?:\d+(?:[.,]\d{1,2})?|[.,]\d{1,2})$/.test(text)) return null;
  const parsed = Number(text.replace(",", "."));
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= PROPERTY_AREA_MAX_SQM ? parsed : null;
}

type PropertyAreaResult = { ok: true; value: number | null } | { ok: false; reason: string };

export function resolvePropertyAreaSqm(property: Record<string, unknown>): PropertyAreaResult {
  const fields = property.fieldValues && typeof property.fieldValues === "object" && !Array.isArray(property.fieldValues)
    ? property.fieldValues as Record<string, unknown>
    : {};
  // Retain the old umlaut-normalized field keys for existing form payloads.
  // Empty primary fields must not mask a supplied detail-field area.
  const values: Array<[string, unknown]> = [
    ["areaSqm", property.areaSqm],
    ["areas.wohnflaeche", fields["areas.wohnflaeche"]],
    ["areas.wohnfl_che", fields["areas.wohnfl_che"]],
    ["areas.nutzflaeche", fields["areas.nutzflaeche"]],
    ["areas.nutzfl_che", fields["areas.nutzfl_che"]],
    ["areas.gesamtflaeche", fields["areas.gesamtflaeche"]],
    ["areas.gesamtfl_che", fields["areas.gesamtfl_che"]],
  ];
  let selected: number | null = null;
  for (const [field, value] of values) {
    if (isEmptyPropertyAreaInput(value)) continue;
    const parsed = parsePropertyAreaSqm(value);
    if (parsed === null) {
      return { ok: false, reason: `Invalid property area: ${field} must be between 0 and ${PROPERTY_AREA_MAX_SQM} m2 with at most two decimal places` };
    }
    selected ??= parsed;
  }
  return { ok: true, value: selected };
}
