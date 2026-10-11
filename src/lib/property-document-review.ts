import type { PropertyDocumentItem } from "@/lib/crm-types";
import type { PropertyAssetSummary } from "@/lib/property-department";
import { propertyWorkspaceEndpoint } from "@/lib/property-interactions";

export type PropertyDocumentReviewAction = "approve" | "revoke";
export type PropertyDocumentReviewTarget = Readonly<{
  documentId: string;
  propertyId: string;
  projectId: string | null;
  workspaceId: string;
  mediaAssetId: string;
  expectedStatus: "draft" | "needs_review" | "approved";
  expectedUpdatedAt: string;
}>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function propertyDocumentReviewTarget(
  document: PropertyDocumentItem,
  property: PropertyAssetSummary | undefined,
  workspaceId: string,
): PropertyDocumentReviewTarget | null {
  const projectId = property?.projectId || null;
  if (!property || property.kind !== "property" || !property.sellerListingId ||
    property.id !== `listing:${property.sellerListingId}` || property.workspaceId !== workspaceId ||
    document.workspaceId !== workspaceId || document.propertyId !== property.sellerListingId ||
    (document.projectId || null) !== projectId ||
    ![workspaceId, property.sellerListingId, document.id, document.mediaAssetId ?? ""].every((id) => uuidPattern.test(id)) ||
    (property.projectId && !uuidPattern.test(property.projectId)) ||
    document.assetAvailable === false || !["private", "internal"].includes(document.visibility) || document.publicUrl || document.sentAt ||
    !["draft", "needs_review", "approved"].includes(document.status) ||
    !Number.isFinite(Date.parse(document.updatedAt))) return null;
  return Object.freeze({
    documentId: document.id, propertyId: property.sellerListingId,
    projectId, workspaceId, mediaAssetId: document.mediaAssetId!,
    expectedStatus: document.status as PropertyDocumentReviewTarget["expectedStatus"],
    expectedUpdatedAt: document.updatedAt,
  });
}

export async function persistPropertyDocumentReview(input: {
  target: PropertyDocumentReviewTarget;
  action: PropertyDocumentReviewAction;
  request: (url: string, init: RequestInit) => Promise<Response>;
}) {
  const target = { ...input.target };
  if ((input.action === "approve" && !["draft", "needs_review"].includes(target.expectedStatus)) ||
    (input.action === "revoke" && target.expectedStatus !== "approved")) {
    throw new Error("Invalid internal document review transition");
  }
  const response = await input.request(propertyWorkspaceEndpoint("/api/crm/properties", target.workspaceId), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation: "review_document", ...target, action: input.action }),
  });
  const payload = await response.json().catch(() => null);
  const data = payload?.data;
  const expectedStatus = input.action === "approve" ? "approved" : "needs_review";
  if (!response.ok || payload?.persisted !== true || data?.id !== target.documentId ||
    data?.propertyId !== target.propertyId || data?.workspaceId !== target.workspaceId ||
    (data?.projectId ?? null) !== target.projectId || data?.status !== expectedStatus ||
    !["private", "internal"].includes(data?.visibility) || !Number.isFinite(Date.parse(data?.updatedAt))) {
    throw new Error(response.status === 409 ? "document_review_conflict" : "document_review_failed");
  }
  return data as { id: string; status: "approved" | "needs_review"; updatedAt: string };
}
