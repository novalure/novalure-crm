import { createHash } from "node:crypto";
import {
  runPropertyChannelPreflight,
  type PropertyAssetStatus,
  type PropertyAssetSummary,
  type PropertyPreflightCheck,
  type PropertyPreflightResult,
} from "@/lib/property-department";
import type { LanguageCode } from "@/lib/i18n";
import {
  PROPERTY_EXPORT_CHANNEL,
  PROPERTY_EXPORT_FORMAT,
  type PropertyExportSnapshot,
  type PropertyExportSource,
} from "@/lib/property-export/types";

const exportableTextStatuses = new Set(["approved", "published"]);
const exportableAssetStatuses = new Set(["approved", "published", "sent"]);
const exportableVisibilities = new Set(["channel", "public"]);
const exportableTextChannels = new Set(["all", "openimmo", "openimmo export"]);
const propertyStatuses = new Set<PropertyAssetStatus>([
  "draft",
  "needs_review",
  "published",
  "ready",
  "reserved",
  "sold",
]);

function normalizeText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeKey(value: unknown) {
  return normalizeText(value).toLowerCase();
}

function nullableText(value: unknown) {
  const normalized = normalizeText(value);
  return normalized || null;
}

function finiteNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function finiteInteger(value: unknown) {
  const parsed = finiteNumber(value);
  return parsed === null ? null : Math.trunc(parsed);
}

function dateOnly(value: string | Date | null | undefined) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function isoTimestamp(value: string | Date) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Property export source has an invalid updatedAt timestamp");
  }
  return parsed.toISOString();
}

function priceVisibility(source: PropertyExportSource) {
  const channelOverride = source.listing.channelPriceVisibility?.[PROPERTY_EXPORT_CHANNEL];
  const raw = typeof channelOverride === "string" ? channelOverride : source.listing.priceVisibility;
  return raw === "hide_price" || raw === "price_on_request" ? raw : "publish_price";
}

function exportableTexts(source: PropertyExportSource) {
  return source.texts
    .filter((item) => (
      exportableVisibilities.has(normalizeKey(item.visibility)) &&
      exportableTextStatuses.has(normalizeKey(item.status)) &&
      exportableTextChannels.has(normalizeKey(item.channel))
    ))
    .sort((left, right) => left.position - right.position || left.textKey.localeCompare(right.textKey) || left.id.localeCompare(right.id));
}

function exportableCosts(source: PropertyExportSource) {
  return source.costs
    .filter((item) => item.exposeVisible)
    .sort((left, right) => left.position - right.position || left.costKey.localeCompare(right.costKey) || left.id.localeCompare(right.id));
}

function exportableMedia(source: PropertyExportSource) {
  return source.media
    .filter((item) => (
      Boolean(item.mediaAssetId) &&
      exportableVisibilities.has(normalizeKey(item.visibility)) &&
      exportableAssetStatuses.has(normalizeKey(item.status))
    ))
    .sort((left, right) => Number(right.isCover) - Number(left.isCover) || left.position - right.position || left.id.localeCompare(right.id));
}

function exportableDocuments(source: PropertyExportSource) {
  return source.documents
    .filter((item) => (
      Boolean(item.mediaAssetId) &&
      exportableVisibilities.has(normalizeKey(item.visibility)) &&
      exportableAssetStatuses.has(normalizeKey(item.status))
    ))
    .sort((left, right) => left.category.localeCompare(right.category) || left.id.localeCompare(right.id));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return null;
}

export function stableStringify(value: unknown) {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function hashPropertyExportSnapshot(snapshot: PropertyExportSnapshot) {
  return sha256Hex(stableStringify(snapshot));
}

export function buildPropertyExportSnapshot(source: PropertyExportSource): PropertyExportSnapshot {
  const visibility = priceVisibility(source);
  const mayPublishPrice = visibility === "publish_price";
  const texts = exportableTexts(source);
  const costs = exportableCosts(source);
  const media = exportableMedia(source);
  const documents = exportableDocuments(source);

  return canonicalize({
    channel: PROPERTY_EXPORT_CHANNEL,
    costs: costs.map((item) => ({
      costKey: item.costKey,
      groupKey: item.groupKey,
      label: item.label,
      monthlyGrossCents: finiteInteger(item.monthlyGrossCents),
      monthlyNetCents: finiteInteger(item.monthlyNetCents),
      monthlyVatCents: finiteInteger(item.monthlyVatCents),
      oneTimeGrossCents: finiteInteger(item.oneTimeGrossCents),
      oneTimeNetCents: finiteInteger(item.oneTimeNetCents),
      oneTimeVatCents: finiteInteger(item.oneTimeVatCents),
      optional: item.optional,
      position: item.position,
      vatPercent: finiteNumber(item.vatPercent),
    })),
    documents: documents.map((item) => ({
      assetName: nullableText(item.assetName),
      category: item.category,
      id: item.id,
      mediaReference: item.mediaAssetId ? `/api/media/files/${item.mediaAssetId}` : null,
      mimeType: nullableText(item.mimeType),
      requiredForPublication: item.requiredForPublication,
      title: item.title,
    })),
    format: PROPERTY_EXPORT_FORMAT,
    media: media.map((item) => ({
      altText: nullableText(item.altText),
      assetName: nullableText(item.assetName),
      category: item.category,
      id: item.id,
      isCover: item.isCover,
      mediaReference: item.mediaAssetId ? `/api/media/files/${item.mediaAssetId}` : null,
      mediaType: item.mediaType,
      mimeType: nullableText(item.mimeType),
      position: item.position,
      title: item.title,
    })),
    property: {
      address: {
        city: nullableText(source.listing.city),
        country: nullableText(source.listing.country) ?? "AT",
        federalState: nullableText(source.listing.federalState),
        houseNumber: nullableText(source.listing.houseNumber),
        postalCode: nullableText(source.listing.postalCode),
        street: nullableText(source.listing.street),
        unstructured: source.listing.address,
      },
      areaSqm: finiteNumber(source.listing.areaSqm),
      availability: {
        availableFrom: dateOnly(source.listing.availableFrom),
        availableFromText: nullableText(source.listing.availableFromText),
      },
      contact: {
        email: nullableText(source.listing.contactEmail),
        name: nullableText(source.listing.contactName),
        phone: nullableText(source.listing.contactPhone),
      },
      id: source.listing.id,
      identifiers: {
        internalReference: nullableText(source.listing.internalReference),
        objectNumber: nullableText(source.listing.objectNumber),
        openimmoObjectId: nullableText(source.listing.openimmoObjectId),
      },
      marketingType: nullableText(source.listing.marketingType),
      objectType: source.listing.objectType,
      pricing: {
        monthlyCostsGrossCents: mayPublishPrice ? finiteInteger(source.listing.monthlyCostsGrossCents) : null,
        priceVisibility: visibility,
        publicPriceCents: mayPublishPrice ? finiteInteger(source.listing.publicPriceCents) : null,
        purchaseAncillaryCostsCents: mayPublishPrice ? finiteInteger(source.listing.purchaseAncillaryCostsCents) : null,
        rentNetCents: mayPublishPrice ? finiteInteger(source.listing.rentNetCents) : null,
        rentPriceCents: mayPublishPrice ? finiteInteger(source.listing.rentPriceCents) : null,
      },
      project: source.project ? { id: source.project.id, name: source.project.name } : null,
      region: nullableText(source.listing.region),
      rooms: finiteNumber(source.listing.rooms),
      subObjectType: nullableText(source.listing.subObjectType),
      title: source.listing.title,
      units: [...source.units]
        .sort((left, right) => left.unitNumber.localeCompare(right.unitNumber) || left.id.localeCompare(right.id))
        .map((unit) => ({
          areaSqm: finiteNumber(unit.areaSqm),
          floor: unit.floor,
          id: unit.id,
          priceCents: mayPublishPrice ? finiteInteger(unit.priceCents) : null,
          rooms: finiteNumber(unit.rooms),
          status: unit.status,
          unitNumber: unit.unitNumber,
        })),
      updatedAt: isoTimestamp(source.listing.updatedAt),
      usageType: nullableText(source.listing.usageType),
      yearBuilt: finiteInteger(source.listing.yearBuilt),
    },
    schema: "novalure.property-export-snapshot.v1",
    texts: texts.map((item) => ({
      content: item.content,
      position: item.position,
      seoDescription: nullableText(item.seoDescription),
      seoTitle: nullableText(item.seoTitle),
      textKey: item.textKey,
      title: item.title,
    })),
  }) as PropertyExportSnapshot;
}

export function buildPropertyExportPreflightAsset(source: PropertyExportSource): PropertyAssetSummary {
  const texts = exportableTexts(source);
  const costs = exportableCosts(source);
  const media = exportableMedia(source);
  const documents = exportableDocuments(source);
  const visibility = priceVisibility(source);
  const unitArea = source.units.reduce((sum, unit) => sum + Math.max(0, finiteNumber(unit.areaSqm) ?? 0), 0);
  const unitPriceCents = source.units.reduce((sum, unit) => sum + Math.max(0, finiteNumber(unit.priceCents) ?? 0), 0);
  const targetPriceCents = finiteNumber(source.listing.targetPriceCents) ?? 0;
  const marketValueCents = finiteNumber(source.listing.marketValueCents) ?? 0;
  const internalPriceCents = unitPriceCents > 0
    ? unitPriceCents
    : targetPriceCents > 0
      ? targetPriceCents
      : marketValueCents > 0
        ? marketValueCents
        : null;
  const publicPriceCents = finiteNumber(source.listing.publicPriceCents);
  const status = propertyStatuses.has(source.listing.propertyStatus as PropertyAssetStatus)
    ? source.listing.propertyStatus as PropertyAssetStatus
    : "needs_review";
  const publicImages = media.filter((item) => normalizeKey(item.mediaType) === "image");
  const floorplans = [
    ...documents.filter((item) => /floor|grundriss/i.test(item.category)),
    ...media.filter((item) => normalizeKey(item.mediaType) === "floorplan" || /floor|grundriss/i.test(item.category)),
  ];

  return {
    activeReservations: source.unitCounts.activeReservations,
    address: source.listing.address,
    approvedDocumentCount: documents.length,
    areaSqm: unitArea > 0 ? unitArea : finiteNumber(source.listing.areaSqm) ?? undefined,
    availableFrom: dateOnly(source.listing.availableFrom) ?? undefined,
    availableFromText: nullableText(source.listing.availableFromText) ?? undefined,
    availableUnits: source.unitCounts.available,
    buildingCount: source.buildingCount,
    channelPriceVisibility: source.listing.channelPriceVisibility as Record<string, "hide_price" | "price_on_request" | "publish_price"> | undefined,
    contactId: source.listing.ownerContactId ?? undefined,
    contactLabel: nullableText(source.listing.contactName) ??
      nullableText(source.listing.contactEmail) ??
      nullableText(source.listing.contactPhone) ??
      undefined,
    costItemCount: costs.length,
    coverImageCount: publicImages.filter((item) => item.isCover).length,
    documentCount: source.documents.length,
    energyDocumentCount: documents.filter((item) => /energy|energie/i.test(item.category)).length,
    expectedGrossYield: finiteNumber(source.listing.expectedGrossYield) ?? undefined,
    floorplanDocumentCount: floorplans.length,
    gdprStatus: nullableText(source.listing.gdprStatus) ?? undefined,
    id: `listing:${source.listing.id}`,
    imageCount: source.media.filter((item) => normalizeKey(item.mediaType) === "image").length,
    internalReference: nullableText(source.listing.internalReference) ?? undefined,
    kind: "property",
    location: source.listing.address,
    marketingType: nullableText(source.listing.marketingType) ?? undefined,
    monthlyCostsGross: (finiteNumber(source.listing.monthlyCostsGrossCents) ?? 0) / 100 || undefined,
    objectNumber: nullableText(source.listing.objectNumber) ?? undefined,
    objectType: source.listing.objectType,
    portalMappingStatus: nullableText(source.listing.portalMappingStatus) ?? undefined,
    price: internalPriceCents === null ? undefined : internalPriceCents / 100,
    priceVisibility: visibility,
    projectId: source.listing.projectId ?? undefined,
    projectName: source.project?.name ?? "Maklerbestand",
    publicDocumentCount: documents.length,
    publicImageCount: publicImages.length,
    publicPrice: publicPriceCents === null ? undefined : publicPriceCents / 100,
    purchaseAncillaryCosts: (finiteNumber(source.listing.purchaseAncillaryCostsCents) ?? 0) / 100 || undefined,
    region: nullableText(source.listing.region) ?? undefined,
    reservedUnits: source.unitCounts.reserved,
    rooms: finiteNumber(source.listing.rooms) ?? undefined,
    sellerLeadId: source.listing.sellerLeadId ?? undefined,
    sellerListingId: source.listing.id,
    soldUnits: source.unitCounts.sold,
    status,
    subObjectType: nullableText(source.listing.subObjectType) ?? undefined,
    textBlockCount: texts.length,
    title: source.listing.title,
    unitCount: source.unitCounts.total,
    unitIds: source.units.map((unit) => unit.id),
    updatedAt: isoTimestamp(source.listing.updatedAt),
    usageType: nullableText(source.listing.usageType) ?? undefined,
    workspaceId: source.listing.workspaceId,
    yearBuilt: finiteInteger(source.listing.yearBuilt) ?? undefined,
  };
}

export function runServerPropertyExportPreflight(
  source: PropertyExportSource,
  language: LanguageCode = "de",
): PropertyPreflightResult {
  const base = runPropertyChannelPreflight(
    buildPropertyExportPreflightAsset(source),
    PROPERTY_EXPORT_CHANNEL,
    language,
  );
  const visibility = priceVisibility(source);
  const publicPrice = finiteNumber(source.listing.publicPriceCents);
  const hasExplicitPublicPrice = visibility !== "publish_price" || Boolean(publicPrice && publicPrice > 0);
  const hasResolvedContact = Boolean(
    source.listing.ownerContactId &&
    (
      normalizeText(source.listing.contactName) ||
      normalizeText(source.listing.contactEmail) ||
      normalizeText(source.listing.contactPhone)
    ),
  );
  const hasExplicitLegalBasis = normalizeKey(source.listing.gdprStatus) === "ready";
  const documents = exportableDocuments(source);
  const exportableDocumentIds = new Set(documents.map((document) => document.id));
  const requiredDocuments = source.documents.filter((document) => document.requiredForPublication);
  const requiredDocumentsReady = documents.length > 0 &&
    requiredDocuments.every((document) => exportableDocumentIds.has(document.id));
  const strictCopy = language === "de"
    ? {
      contactBlocked: "Ein tenant-gebundener CRM-Kontakt mit Name, E-Mail oder Telefon ist erforderlich.",
      contactPass: "Tenant-gebundener CRM-Kontakt ist aufgelöst.",
      documentsBlocked: "Mindestens ein freigegebenes Dokument und alle als Pflicht markierten Dokumente müssen publizierbar und mit einer Datei verknüpft sein.",
      documentsPass: "Publizierbare Dokumente einschließlich aller Pflichtdokumente sind vorhanden.",
      gdprBlocked: "Die Rechtsgrundlage muss ausdrücklich mit DSGVO-Status „bereit“ freigegeben sein.",
      gdprPass: "Die Rechtsgrundlage ist ausdrücklich freigegeben.",
      publicPriceBlocked: "Für die Preisveröffentlichung ist ein ausdrücklich gepflegter öffentlicher Preis erforderlich; interne Preise werden nicht verwendet.",
      publicPricePass: "Der öffentliche Preis ist für die gewählte Sichtbarkeit freigegeben.",
    }
    : {
      contactBlocked: "A tenant-bound CRM contact with a name, email address or phone number is required.",
      contactPass: "A tenant-bound CRM contact has been resolved.",
      documentsBlocked: "At least one approved document and every document marked as required must be publishable and linked to a file.",
      documentsPass: "Publishable documents, including every required document, are available.",
      gdprBlocked: "The legal basis must be explicitly approved with GDPR status ready.",
      gdprPass: "The legal basis is explicitly approved.",
      publicPriceBlocked: "Publishing a price requires an explicit public price; internal prices are never substituted.",
      publicPricePass: "The public price is approved for the selected visibility.",
    };
  const strictChecks = new Map<string, PropertyPreflightCheck>([
    ["contact", {
      id: "contact",
      label: base.checks.find((check) => check.id === "contact")?.label ?? "Contact",
      message: hasResolvedContact ? strictCopy.contactPass : strictCopy.contactBlocked,
      required: true,
      status: hasResolvedContact ? "pass" : "blocked",
    }],
    ["documents", {
      id: "documents",
      label: base.checks.find((check) => check.id === "documents")?.label ?? "Documents",
      message: requiredDocumentsReady ? strictCopy.documentsPass : strictCopy.documentsBlocked,
      required: true,
      status: requiredDocumentsReady ? "pass" : "blocked",
    }],
    ["gdpr", {
      id: "gdpr",
      label: base.checks.find((check) => check.id === "gdpr")?.label ?? "Legal basis",
      message: hasExplicitLegalBasis ? strictCopy.gdprPass : strictCopy.gdprBlocked,
      required: true,
      status: hasExplicitLegalBasis ? "pass" : "blocked",
    }],
    ["public_price", {
      id: "public_price",
      label: base.checks.find((check) => check.id === "public_price")?.label ?? "Public price",
      message: hasExplicitPublicPrice ? strictCopy.publicPricePass : strictCopy.publicPriceBlocked,
      required: visibility === "publish_price",
      status: hasExplicitPublicPrice ? "pass" : "blocked",
    }],
  ]);
  const checks = base.checks.map((check) => strictChecks.get(check.id) ?? check);
  const blockers = checks.filter((check) => check.status === "blocked").map((check) => check.label);
  const warnings = checks.filter((check) => check.status === "warning").map((check) => check.label);

  return {
    blockers,
    channel: base.channel,
    checks,
    status: blockers.length ? "blocked" : warnings.length ? "warning" : "pass",
    warnings,
  };
}
