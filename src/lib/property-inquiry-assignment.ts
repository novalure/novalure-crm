import type { PropertyAssetSummary } from "./property-department";

export type ConfirmedPropertyInquiryAssignment = {
  id: string;
  version: string;
  propertyId: string | null;
  propertyTitle: string | null;
  projectId: string | null;
  unitId: string | null;
  unitNumber: string | null;
};

export type PropertyInquiryCandidate = {
  leadId: string;
  contactName: string;
  intent: string;
  projectId: string | null;
  projectName: string | null;
  source: string;
  assignment: ConfirmedPropertyInquiryAssignment | null;
};

export function inquiryAssignmentTargets(
  assets: PropertyAssetSummary[], workspaceId: string, projectId: string | null,
) {
  return assets.filter((asset) => asset.kind === "property" && asset.workspaceId === workspaceId &&
    Boolean(asset.sellerListingId) && asset.id === `listing:${asset.sellerListingId}` &&
    (asset.projectId || null) === projectId);
}

export function isConfirmedInquiryResponse(
  payload: unknown, leadId: string, propertyId: string, unitId: string | null,
): payload is { persisted: true; data: PropertyInquiryCandidate } {
  if (!payload || typeof payload !== "object") return false;
  const result = payload as { persisted?: unknown; data?: PropertyInquiryCandidate };
  return result.persisted === true && result.data?.leadId === leadId &&
    result.data.assignment?.propertyId === propertyId && result.data.assignment.unitId === unitId &&
    Boolean(result.data.assignment.id && result.data.assignment.version);
}
