import type { PropertyMediaItem, SellerListing } from "@/lib/crm-types";
import { propertyWorkspaceEndpoint } from "@/lib/property-interactions";

type MediaVersion = Readonly<{ id: string; position: number; isCover: boolean; updatedAt: string }>;
export type PropertyMediaOrderTarget = Readonly<{
  workspaceId: string;
  propertyId: string;
  projectId: string | null;
  expectedMedia: readonly MediaVersion[];
  images: readonly string[];
}>;
export type PropertyMediaAction = "cover" | "up" | "down";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const canonicalId = (value: string | undefined | null) => value?.toLowerCase() || null;
const validDate = (value: string) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

export function sortedPropertyMedia(media: readonly PropertyMediaItem[]) {
  return [...media].sort((a, b) => a.position - b.position || a.id.toLowerCase().localeCompare(b.id.toLowerCase()));
}

/** Capture the complete gallery and its target before any asynchronous work. */
export function propertyMediaOrderTarget(property: SellerListing | undefined, workspaceId: string, media: readonly PropertyMediaItem[]): PropertyMediaOrderTarget | null {
  const projectId = canonicalId(property?.projectId);
  if (!property || !uuid.test(workspaceId) || !uuid.test(property.id) || canonicalId(property.workspaceId) !== canonicalId(workspaceId) ||
    (projectId !== null && !uuid.test(projectId)) || media.length === 0 || media.length > 200 ||
    media.some(item => !uuid.test(item.id) || canonicalId(item.workspaceId) !== canonicalId(workspaceId) ||
      canonicalId(item.propertyId) !== canonicalId(property.id) || canonicalId(item.projectId) !== projectId ||
      !Number.isInteger(item.position) || item.position < 0 || item.position > 2147483647 || typeof item.isCover !== "boolean" || !validDate(item.updatedAt)) ||
    new Set(media.map(item => item.id.toLowerCase())).size !== media.length) return null;
  const sorted = sortedPropertyMedia(media);
  return Object.freeze({
    workspaceId: workspaceId.toLowerCase(), propertyId: property.id.toLowerCase(), projectId,
    expectedMedia: Object.freeze(sorted.map(item => Object.freeze({ id: item.id.toLowerCase(), position: item.position, isCover: item.isCover, updatedAt: item.updatedAt }))),
    images: Object.freeze(sorted.filter(item => item.mediaType === "image" && item.assetAvailable !== false).map(item => item.id.toLowerCase())),
  });
}

export function propertyMediaVersion(target: PropertyMediaOrderTarget | null) {
  return target ? JSON.stringify([target.workspaceId, target.propertyId, target.projectId, target.expectedMedia]) : null;
}

export function propertyMediaOrderChange(target: PropertyMediaOrderTarget, mediaId: string, action: PropertyMediaAction) {
  const id = mediaId.toLowerCase();
  const imageIndex = target.images.indexOf(id);
  if (imageIndex < 0) return null;
  const items = target.expectedMedia.map(item => ({ id: item.id, position: item.position, isCover: item.isCover }));
  const index = items.findIndex(item => item.id === id);
  if (action === "cover") {
    if (items[index].isCover && items.filter(item => item.isCover).length === 1) return null;
    return items.map(item => ({ ...item, isCover: item.id === id }));
  }
  if (action !== "up" && action !== "down") return null;
  const neighbor = target.images[imageIndex + (action === "up" ? -1 : 1)];
  if (!neighbor) return null;
  const neighborIndex = items.findIndex(item => item.id === neighbor);
  [items[index], items[neighborIndex]] = [items[neighborIndex], items[index]];
  // Keep non-image slots and all metadata intact; ordering has no publication side effect.
  return items.map((item, position) => ({ ...item, position }));
}

export async function persistPropertyMediaOrder(input: {
  target: PropertyMediaOrderTarget;
  mediaId: string;
  action: PropertyMediaAction;
  request: (url: string, init: RequestInit) => Promise<Response>;
}) {
  const mediaItems = propertyMediaOrderChange(input.target, input.mediaId, input.action);
  if (!mediaItems) throw new Error("media_order_invalid");
  const { workspaceId, propertyId, projectId, expectedMedia } = input.target;
  const response = await input.request(propertyWorkspaceEndpoint("/api/crm/properties", workspaceId), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation: "update_media_order", propertyId, projectId, expectedMedia, mediaItems }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.persisted !== true || payload?.data?.count !== mediaItems.length) {
    throw new Error(response.status === 409 ? "media_order_conflict" : "media_order_unconfirmed");
  }
}
