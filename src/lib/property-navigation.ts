import type { BrokerMandate, SellerListing } from "@/lib/crm-types";
import type { PropertyAssetSummary, PropertyUnitBoardScope, PropertyUnitObjectScope } from "@/lib/property-department";

export function createUnitBoardScope(asset: PropertyAssetSummary | undefined): PropertyUnitBoardScope | undefined {
  if (!asset) return undefined;
  const isProjectSummary = asset.kind === "project" && Boolean(asset.projectId);
  return {
    key: `${asset.id}:${isProjectSummary ? "project" : asset.unitIds.join("|")}`,
    label: asset.title,
    originAssetId: asset.id,
    projectId: asset.projectId,
    // Only a genuine project summary opens all current project units. For an
    // individual object, an empty explicit selection always means no linked units.
    unitIds: isProjectSummary ? undefined : [...asset.unitIds],
  };
}

export function isUnitWithinPropertyScope(
  unit: { id: string; projectId: string },
  scope: PropertyUnitBoardScope | null | undefined,
): boolean {
  if (!scope) return true;
  if (scope.projectId && scope.projectId !== unit.projectId) return false;
  return scope.unitIds === undefined || scope.unitIds.includes(unit.id);
}

export function resolvePropertyAssetIdFromUnit(
  scope: PropertyUnitObjectScope,
  listings: SellerListing[],
  workspaceId: string,
  mandates: BrokerMandate[] = [],
): string | undefined {
  const candidates = listings.filter((listing) =>
    listing.workspaceId === workspaceId &&
    (!scope.projectId || listing.projectId === scope.projectId),
  );
  const origin = candidates.find((listing) =>
    scope.originAssetId === `listing:${listing.id}` &&
    (!scope.unitId || listing.unitId === scope.unitId),
  );
  if (origin) return `listing:${origin.id}`;
  const mandateOrigin = !scope.unitId && mandates.find((mandate) =>
    scope.originAssetId === `mandate:${mandate.id}` &&
    mandate.workspaceId === workspaceId &&
    (!scope.projectId || mandate.projectId === scope.projectId),
  );
  if (mandateOrigin) return `mandate:${mandateOrigin.id}`;
  if (scope.projectId && scope.originAssetId === `project:${scope.projectId}`) {
    return scope.originAssetId;
  }
  const linkedListings = scope.unitId
    ? candidates.filter((listing) => listing.unitId === scope.unitId)
    : [];
  if (linkedListings.length === 1) return `listing:${linkedListings[0].id}`;
  // No relation (or an ambiguous one) is not permission to pick an unrelated listing.
  return scope.projectId ? `project:${scope.projectId}` : undefined;
}

export function isInquiryForPropertyAsset(
  asset: PropertyAssetSummary,
  route: { projectId?: string; propertyId?: string; unitId?: string; workspaceId?: string },
): boolean {
  if (route.workspaceId && route.workspaceId !== asset.workspaceId) return false;
  if (route.projectId && route.projectId !== asset.projectId) return false;
  if (asset.kind === "project") return Boolean(asset.projectId && route.projectId === asset.projectId);
  if (route.propertyId) {
    return (route.propertyId === asset.id || route.propertyId === asset.sellerListingId) &&
      (!route.unitId || asset.unitIds.includes(route.unitId));
  }
  return Boolean(route.unitId && asset.unitIds.includes(route.unitId));
}
