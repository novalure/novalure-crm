import type { PropertyDocumentItem, PropertyMediaItem, SellerListing } from "@/lib/crm-types";

export type PropertyFileDeleteTarget = Readonly<{
  workspaceId: string;
  assetId: string;
  propertyId: string;
  attachmentKind: "media" | "document";
  attachmentId: string;
  expectedUpdatedAt: string;
}>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** UI eligibility only. The server locks and verifies all file references again. */
export function propertyFileDeleteTarget(item: PropertyMediaItem | PropertyDocumentItem,
  kind: "media" | "document", property: SellerListing | undefined, workspaceId: string): PropertyFileDeleteTarget | null {
  if (!property || property.workspaceId !== workspaceId || item.workspaceId !== workspaceId ||
    item.propertyId !== property.id || (item.projectId || null) !== (property.projectId || null) ||
    ![workspaceId, property.id, item.id, item.mediaAssetId ?? ""].every(id => uuid.test(id)) ||
    item.assetAvailable === false || item.visibility !== "private" || item.publicUrl ||
    !["draft", "needs_review", "approved"].includes(item.status) ||
    (kind === "document" && (item as PropertyDocumentItem).sentAt) ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(item.updatedAt) ||
    !Number.isFinite(Date.parse(item.updatedAt)) || new Date(item.updatedAt).toISOString() !== item.updatedAt) return null;
  return Object.freeze({ workspaceId, propertyId: property.id, assetId: item.mediaAssetId!,
    attachmentKind: kind, attachmentId: item.id, expectedUpdatedAt: item.updatedAt });
}

export async function persistPropertyFileDelete(input: {
  target: PropertyFileDeleteTarget;
  request: (url: string, init: RequestInit) => Promise<Response>;
}) {
  const { workspaceId, assetId, ...attachment } = input.target;
  if (![workspaceId, assetId, attachment.propertyId, attachment.attachmentId].every(id => uuid.test(id))) throw new Error("property_file_delete_invalid");
  const response = await input.request(`/api/media/${assetId}?${new URLSearchParams({ workspaceId })}`, {
    method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify(attachment),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.deletionComplete !== true || payload?.deleted?.id !== assetId ||
    payload?.attachment?.id !== attachment.attachmentId || payload?.attachment?.kind !== attachment.attachmentKind ||
    payload?.attachment?.propertyId !== attachment.propertyId) {
    throw new Error(response.status === 409 ? "property_file_delete_conflict" :
      response.status === 403 ? "property_file_delete_denied" : "property_file_delete_unconfirmed");
  }
  return input.target;
}
