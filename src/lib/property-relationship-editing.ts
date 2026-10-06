import type { BrokerMandate, Contact, Lead, SellerListing, WorkspaceUser } from "./crm-types";
import { createPropertyCoreDraft } from "./property-core-editing";
import type { PropertyDraft, PropertyDraftStore } from "./property-draft-store";
import { normalizePropertyRelationshipSnapshot, propertyRelationshipKeys, propertyRelationshipSnapshot, type PropertyRelationshipKey } from "./property-relationship-snapshot";

export type PropertyRelationshipOption = { id: string; label: string; sellerLeadId?: string | null };
export type PropertyRelationshipSources = { leads: Lead[]; contacts: Contact[]; brokerMandates: BrokerMandate[]; users: WorkspaceUser[] };
export type PropertyRelationshipOptions = Record<PropertyRelationshipKey, PropertyRelationshipOption[]>;
export const emptyPropertyRelationshipOptions = (): PropertyRelationshipOptions => ({ sellerLeadId: [], mandateId: [], ownerContactId: [], ownerUserId: [], contactUserId: [] });

export async function fetchPropertyRelationshipOptions(input: {
  workspaceId: string; propertyId: string; projectId: string | null; signal?: AbortSignal;
  request: (url: string, init: RequestInit) => Promise<Response>;
}): Promise<PropertyRelationshipOptions> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (![input.workspaceId, input.propertyId].every(id => uuid.test(id)) || (input.projectId !== null && !uuid.test(input.projectId))) throw new Error("property_relationship_options_invalid");
  const query = new URLSearchParams({ workspaceId: input.workspaceId, operation: "relationship_options", propertyId: input.propertyId });
  const response = await input.request(`/api/crm/properties?${query}`, { method: "GET", cache: "no-store", credentials: "same-origin", signal: input.signal });
  const payload = await response.json().catch(() => null);
  const data = payload?.data;
  if (!response.ok || payload?.persisted !== true || payload.source !== "database" || data?.propertyId !== input.propertyId ||
    data.workspaceId !== input.workspaceId || data.projectId !== input.projectId || !data.options ||
    Object.keys(data.options).length !== propertyRelationshipKeys.length || !propertyRelationshipKeys.every(key => Object.hasOwn(data.options, key))) throw new Error("property_relationship_options_unconfirmed");
  for (const key of propertyRelationshipKeys) {
    const values = data.options[key];
    if (!Array.isArray(values) || values.length > 500 || new Set(values.map(value => value?.id)).size !== values.length ||
      values.some(value => !value || typeof value !== "object" || Array.isArray(value) || !uuid.test(value.id) || typeof value.label !== "string" || !value.label.trim() ||
        Object.keys(value).some(field => !["id", "label", ...(key === "mandateId" ? ["sellerLeadId"] : [])].includes(field)) ||
        (key === "mandateId" && !(value.sellerLeadId === null || uuid.test(value.sellerLeadId))))) throw new Error("property_relationship_options_invalid");
  }
  return data.options as PropertyRelationshipOptions;
}
export function propertyRelationshipDraftKey(userId: string, workspaceId: string, propertyId: string) {
  return JSON.stringify(["property-relationships", userId, workspaceId, propertyId]);
}
export function createPropertyRelationshipDraft(listing: SellerListing): PropertyDraft {
  const snapshot = propertyRelationshipSnapshot(listing);
  return { ...createPropertyCoreDraft(listing), coreEdit: { propertyId: listing.id, workspaceId: listing.workspaceId, expected: snapshot },
    fieldValues: Object.fromEntries(propertyRelationshipKeys.map(key => [key, snapshot[key] ?? ""])) };
}
export function propertyRelationshipOptions(sources: PropertyRelationshipSources, workspaceId: string, projectId: string | null, sellerLeadId: string): PropertyRelationshipOptions {
  const sameWorkspace = (row: { workspaceId: string }) => row.workspaceId === workspaceId;
  const sameProjectOrGlobal = (row: { projectId?: string }) => !row.projectId || row.projectId === projectId;
  const contacts = sources.contacts.filter(sameWorkspace);
  const sorted = (options: PropertyRelationshipOption[]) => options.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  const team = sorted(sources.users.filter(row => sameWorkspace(row) && row.status === "active").map(row => ({ id: row.id, label: row.name })));
  return {
    sellerLeadId: sorted(sources.leads.filter(row => sameWorkspace(row) && sameProjectOrGlobal(row) &&
      (/verk|seller/i.test(row.type) || (!!row.sellerProfile && typeof row.sellerProfile === "object" && !Array.isArray(row.sellerProfile) && Object.keys(row.sellerProfile).length > 0)))
      .map(row => ({ id: row.id, label: `${contacts.find(contact => contact.id === row.contactId)?.name || row.intent || "Lead"}${row.sellerProfile?.address ? ` · ${row.sellerProfile.address}` : ""}` }))),
    mandateId: sorted(sources.brokerMandates.filter(row => sameWorkspace(row) && sameProjectOrGlobal(row) &&
      (!sellerLeadId || !row.sellerLeadId || row.sellerLeadId === sellerLeadId)).map(row => ({ id: row.id, label: row.title }))),
    ownerContactId: sorted(contacts.map(row => ({ id: row.id, label: row.name }))),
    ownerUserId: team, contactUserId: team,
  };
}
export function propertyRelationshipUpdatePayload(draft: PropertyDraft, workspaceId: string, propertyId: string, options: PropertyRelationshipOptions) {
  const expected = normalizePropertyRelationshipSnapshot(draft.coreEdit?.expected);
  if (!expected || expected.id !== propertyId || expected.workspaceId !== workspaceId || draft.coreEdit?.propertyId !== propertyId || draft.coreEdit.workspaceId !== workspaceId) throw new Error("property_relationship_target_invalid");
  const changes: Partial<Record<PropertyRelationshipKey, string | null>> = {};
  for (const key of propertyRelationshipKeys) {
    const value = draft.fieldValues[key];
    if (typeof value !== "string") throw new Error("property_relationship_input_invalid");
    const normalized = value || null;
    if (normalized === expected[key]) continue;
    if (value && !options[key].some(option => option.id === value)) throw new Error("property_relationship_target_unavailable");
    changes[key] = normalized;
  }
  // Changing the seller must not silently discard or contradict an existing mandate.
  if (Object.hasOwn(changes, "sellerLeadId") && draft.fieldValues.sellerLeadId && draft.fieldValues.mandateId &&
      !options.mandateId.some(option => option.id === draft.fieldValues.mandateId)) throw new Error("property_relationship_mandate_conflict");
  if (!Object.keys(changes).length) throw new Error("property_relationship_unchanged");
  return { operation: "update_relationships", propertyId, property: { ...changes, expectedRelationships: expected } };
}

export async function savePropertyRelationshipDraft(input: {
  draft: PropertyDraft; workspaceId: string; propertyId: string; scopeKey: string; store: PropertyDraftStore; options: PropertyRelationshipOptions;
  request: (url: string, init: RequestInit) => Promise<Response>; onChanged: () => void | Promise<void>;
}): Promise<{ kind: "saved" | "saved_refresh_failed"; listing: SellerListing } | { kind: "busy" }> {
  const body = propertyRelationshipUpdatePayload(input.draft, input.workspaceId, input.propertyId, input.options);
  const token = input.store.acquireMutation(); if (!token) return { kind: "busy" };
  try {
    const response = await input.request(`/api/crm/properties?workspaceId=${encodeURIComponent(input.workspaceId)}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null) as { persisted?: unknown; data?: SellerListing } | null;
    if (response.status === 409) throw new Error("property_relationship_conflict");
    if (!response.ok || payload?.persisted !== true || payload.data?.id !== input.propertyId || payload.data.workspaceId !== input.workspaceId) throw new Error("property_relationship_save_unconfirmed");
    const actual = propertyRelationshipSnapshot(payload.data), expected = body.property.expectedRelationships;
    if (actual.projectId !== expected.projectId || propertyRelationshipKeys.some(key => actual[key] !== (Object.hasOwn(body.property, key) ? body.property[key] : expected[key]))) throw new Error("property_relationship_save_unconfirmed");
    input.store.clear(input.scopeKey, input.draft);
    try { await input.onChanged(); } catch { return { kind: "saved_refresh_failed", listing: payload.data }; }
    return { kind: "saved", listing: payload.data };
  } finally { input.store.releaseMutation(token); }
}
