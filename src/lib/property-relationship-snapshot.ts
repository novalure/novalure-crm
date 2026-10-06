import type { SellerListing } from "./crm-types";

export const propertyRelationshipKeys = ["sellerLeadId", "mandateId", "ownerContactId", "ownerUserId", "contactUserId"] as const;
export type PropertyRelationshipKey = (typeof propertyRelationshipKeys)[number];
export type PropertyRelationshipSnapshot = { id: string; workspaceId: string; projectId: string | null } & Record<PropertyRelationshipKey, string | null>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const snapshotKeys = ["id", "workspaceId", "projectId", ...propertyRelationshipKeys];

/** Fixed-shape snapshot for the atomic UPDATE predicate, never a client permission check. */
export function normalizePropertyRelationshipSnapshot(value: unknown): PropertyRelationshipSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== snapshotKeys.length || snapshotKeys.some(key => !Object.hasOwn(row, key))) return null;
  if (!uuid.test(String(row.id)) || !uuid.test(String(row.workspaceId))) return null;
  if (["projectId", ...propertyRelationshipKeys].some(key => row[key] !== null && (typeof row[key] !== "string" || !uuid.test(row[key])))) return null;
  return Object.fromEntries(snapshotKeys.map(key => [key, typeof row[key] === "string" ? row[key].toLowerCase() : null])) as PropertyRelationshipSnapshot;
}

export function propertyRelationshipSnapshot(listing: SellerListing): PropertyRelationshipSnapshot {
  const snapshot = normalizePropertyRelationshipSnapshot({ id: listing.id, workspaceId: listing.workspaceId, projectId: listing.projectId || null,
    ...Object.fromEntries(propertyRelationshipKeys.map(key => [key, listing[key] || null])) });
  if (!snapshot) throw new Error("property_relationship_snapshot_invalid");
  return snapshot;
}
