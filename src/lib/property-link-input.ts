const propertyLinkUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type PropertyLinkInputResult =
  | { ok: true; projectId: string | null; unitId: string | null }
  | { ok: false; reason: string };

/** Null/empty inputs preserve the existing partial-update contract; malformed IDs do not. */
export function parsePropertyLinkInput(input: Record<string, unknown>): PropertyLinkInputResult {
  const links: { projectId: string | null; unitId: string | null } = { projectId: null, unitId: null };
  for (const key of ["projectId", "unitId"] as const) {
    const value = input[key];
    if (value == null || (typeof value === "string" && !value.trim())) continue;
    if (typeof value !== "string" || !propertyLinkUuidPattern.test(value.trim())) {
      return { ok: false, reason: `Invalid property ${key}` };
    }
    links[key] = value.trim();
  }
  return { ok: true, ...links };
}

export const propertyRelationshipFields = ["sellerLeadId", "mandateId", "ownerContactId", "ownerUserId", "contactUserId"] as const;
type PropertyRelationshipField = typeof propertyRelationshipFields[number];

/** Only these optional relationships support explicit unlink. Project/unit keep
 * their existing contract above. Omitted/undefined keys never clear old links. */
export function parsePropertyRelationshipInput(input: Record<string, unknown>):
  | { ok: true; values: Record<PropertyRelationshipField, string | null>; supplied: Partial<Record<PropertyRelationshipField, true>> }
  | { ok: false; reason: string } {
  const values = {} as Record<PropertyRelationshipField, string | null>;
  const supplied: Partial<Record<PropertyRelationshipField, true>> = {};
  for (const field of propertyRelationshipFields) {
    values[field] = null;
    if (!Object.hasOwn(input, field) || input[field] === undefined) continue;
    const value = input[field];
    supplied[field] = true;
    if (value === null || (typeof value === "string" && !value.trim())) continue;
    if (typeof value !== "string" || !propertyLinkUuidPattern.test(value.trim())) {
      return { ok: false, reason: `Invalid property ${field}` };
    }
    values[field] = value.trim().toLowerCase();
  }
  return { ok: true, values, supplied };
}
