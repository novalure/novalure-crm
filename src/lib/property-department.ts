import type {
  BrokerMandate,
  BuyerSearchProfile,
  Contact,
  Lead,
  Project,
  PropertyCostItem,
  PropertyDocumentItem,
  PropertyMediaItem,
  PropertyPriceVisibility,
  PropertyBuilding,
  PropertyReservation,
  PropertyTextBlock,
  PropertyUnit,
  SellerListing,
  WorkspaceRole,
} from "@/lib/crm-types";
import { hasProductCapability, type ProductRole } from "@/lib/product-model";

export type PropertyDepartmentTabId =
  | "overview"
  | "create"
  | "projectUnits"
  | "reservations"
  | "inquiries"
  | "channels"
  | "documents"
  | "matching"
  | "quality"
  | "activity";

export const PROPERTY_DEPARTMENT_TABS: Array<{ id: PropertyDepartmentTabId; label: string }> = [
  { id: "overview", label: "Übersicht" },
  { id: "create", label: "Objekt anlegen" },
  { id: "projectUnits", label: "Projekt / Gebäude / Einheiten" },
  { id: "reservations", label: "Reservierungen" },
  { id: "inquiries", label: "Anfragen" },
  { id: "channels", label: "Vermarktung / Kanäle" },
  { id: "documents", label: "Dokumente / Exposé" },
  { id: "matching", label: "Käufer- und Investorenmatching" },
  { id: "quality", label: "Datenqualität" },
  { id: "activity", label: "Aktivitäten / Historie" },
];

export const PROPERTY_FIELD_SECTIONS = [
  {
    id: "location",
    title: "Lage",
    fields: ["Land", "Bundesland", "PLZ", "Ort", "Straße", "Hausnummer", "Stiege", "Tür/Top", "Ausrichtung", "Schlüsselinfo"],
  },
  {
    id: "areas",
    title: "Flächen",
    fields: [
      "Grundfläche",
      "Wohnfläche",
      "Nutzfläche",
      "Verbaute Fläche",
      "Bürofläche",
      "Lagerfläche",
      "Freie Fläche",
      "Befristete Fläche",
      "Rohdachbodenfläche",
      "Gesamtfläche",
    ],
  },
  {
    id: "rooms",
    title: "Räume",
    fields: [
      "Zimmer",
      "Halbe Zimmer",
      "Gärten",
      "Keller",
      "Balkone",
      "Terrassen",
      "Loggien",
      "WCs",
      "Bäder",
      "Garagen",
      "Abstellräume",
      "Raumhöhe",
    ],
  },
  {
    id: "classification",
    title: "Objektklassifizierung",
    fields: [
      "Objektart",
      "Unterobjektart",
      "Wohnen",
      "Gewerbe",
      "Anlage",
      "Barrierefrei",
      "Zentral begehbar",
      "Baugrund",
      "Ferienimmobilie",
    ],
  },
  {
    id: "cadastre",
    title: "Grundbuch / Kataster",
    fields: ["Einlagezahl", "Katastralgemeinde", "Grundstuecksnummer"],
  },
  {
    id: "construction",
    title: "Bau / Status",
    fields: [
      "Bauart",
      "Beziehbar ab",
      "Baujahr",
      "Maximale Mietdauer",
      "Kuendigungsverzicht",
      "Etagen",
      "Dachgeschosse",
      "Mezzanin",
      "Etage",
      "Moeblierung",
      "Laermpegel",
      "Zustand",
      "Erschliessung",
      "Hauszustand",
      "Schluesselfertig",
      "Belagsfertig",
      "Letzte Sanierung",
    ],
  },
  {
    id: "energy",
    title: "Energie",
    fields: ["Energieausweis gültig bis", "HWB", "HWB-Klasse", "fGEE", "fGEE-Klasse", "Automatischer Disclaimer"],
  },
  {
    id: "costs",
    title: "Preise / Kosten",
    fields: [
      "Kaufpreis",
      "Mietpreis brutto",
      "Betriebskosten",
      "Heizkosten",
      "Sonstige Kosten",
      "Kaution",
      "Provision Miete",
      "Provision Kauf",
      "Abgeberprovision",
      "Grunderwerbsteuer",
      "Grundbucheintragung",
      "Vertragserrichtung",
      "Vergebührung",
      "Ablöse",
      "Erschließungskosten",
      "Wohnbauförderung",
    ],
  },
  {
    id: "investment",
    title: "Investment",
    fields: ["Reparaturrücklage", "Nettoertrag Monat", "Nettoertrag Jahr", "Rendite", "Aufschließungskosten", "Altbausanierung"],
  },
  {
    id: "seller",
    title: "Abgeber",
    fields: ["Name", "Adresse", "Telefon privat", "Telefon geschäftlich", "Fax", "E-Mail", "Geburtsdatum", "Website"],
  },
  {
    id: "equipment",
    title: "Ausstattung",
    fields: [
      "Boden",
      "Küche",
      "Stellplatzart",
      "Befeuerung",
      "Heizungsart",
      "Bad",
      "Balkon-/Terrassenausrichtung",
      "Fahrstuhl",
      "TV/EDV",
      "Gastronomie",
      "Rampe",
      "Sauna",
      "Sicherheitskamera",
      "Sport",
      "Wasch-/Trockenraum",
      "Serviceleistungen",
      "Extras",
      "Alarmanlage",
      "Bus/Bahn-Naehe",
      "WG-geeignet",
      "Wintergarten",
      "Fahrradraum",
      "Abstellraum",
      "Seniorengerecht",
    ],
  },
  {
    id: "notes",
    title: "Notizen / Audit",
    fields: ["Anmerkungen", "Interne Notizen", "Dokumentenstatus", "Bestätigung / Audit"],
  },
] as const;

export const PROPERTY_CHANNEL_TYPES = [
  "Eigene Website",
  "Landingpage/Funnel",
  "Immobilienportal",
  "Social Media",
  "Newsletter",
  "WhatsApp",
  "Off-market",
  "OpenImmo Export",
] as const;

export const PROPERTY_DOCUMENT_SECTIONS = [
  "Objektbeschreibung",
  "Lagebeschreibung",
  "Ausstattungsbeschreibung",
  "Kostenuebersicht",
  "Energiedaten",
  "Medien",
  "Grundrisse",
  "Rechtliche Hinweise",
  "Provisionshinweise",
  "Interne Freigabe",
  "Versandhistorie",
] as const;

export const PROPERTY_TEXT_FIELDS = [
  { key: "expose", label: "Exposé", channel: "all" },
  { key: "website", label: "Website", channel: "Eigene Website" },
  { key: "portal", label: "Portale", channel: "Immobilienportal" },
  { key: "internal", label: "Intern", channel: "internal" },
  { key: "newsletter", label: "Newsletter", channel: "Newsletter" },
] as const;

export const PROPERTY_COST_GROUPS = [
  { key: "monthly", label: "Monatliche Kosten" },
  { key: "purchase", label: "Kaufnebenkosten" },
  { key: "rent", label: "Mietnebenkosten" },
] as const;

export const PROPERTY_COST_TEMPLATES = [
  { groupKey: "monthly", key: "operating_costs", label: "Betriebskosten", monthly: true },
  { groupKey: "monthly", key: "heating_costs", label: "Heizkosten", monthly: true },
  { groupKey: "monthly", key: "repair_reserve", label: "Ruecklage", monthly: true },
  { groupKey: "monthly", key: "other_monthly", label: "Sonstige monatliche Kosten", monthly: true },
  { groupKey: "purchase", key: "transfer_tax", label: "Grunderwerbsteuer", monthly: false },
  { groupKey: "purchase", key: "land_register_fee", label: "Grundbucheintragung", monthly: false },
  { groupKey: "purchase", key: "contract_setup", label: "Vertragserrichtung", monthly: false },
  { groupKey: "purchase", key: "broker_commission_purchase", label: "Provision Kauf", monthly: false },
  { groupKey: "rent", key: "deposit", label: "Kaution", monthly: false },
  { groupKey: "rent", key: "stamp_duty", label: "Vergebuehrung", monthly: false },
  { groupKey: "rent", key: "broker_commission_rent", label: "Provision Miete", monthly: false },
] as const;

export const PROPERTY_MEDIA_CATEGORIES = [
  "cover",
  "exterior",
  "interior",
  "floorplan",
  "surroundings",
  "detail",
  "construction",
] as const;

export const PROPERTY_DOCUMENT_CATEGORIES = [
  "expose",
  "energy_certificate",
  "floorplan",
  "land_register",
  "contract",
  "approval",
  "proof",
  "internal",
] as const;

export const PROPERTY_PRICE_VISIBILITY_OPTIONS: Array<{ label: string; value: PropertyPriceVisibility }> = [
  { label: "Preis veröffentlichen", value: "publish_price" },
  { label: "Preis auf Anfrage", value: "price_on_request" },
  { label: "Preis ausblenden", value: "hide_price" },
];

export const PROPERTY_CHANNEL_PRICE_KEYS = [
  "Eigene Website",
  "Immobilienportal",
  "OpenImmo Export",
  "Newsletter",
  "Off-market",
] as const;

export type PropertyActionKey =
  | "createProperty"
  | "assignInquiry"
  | "reserveUnit"
  | "publishProperty"
  | "exportChannel"
  | "changePrice"
  | "approveDocument"
  | "convertReservation";

export type PropertyActionState = {
  enabled: boolean;
  label: string;
  reason?: string;
};

export type PropertyAssetStatus = "draft" | "ready" | "published" | "reserved" | "sold" | "needs_review";

export type PropertyAssetSummary = {
  activeReservations: number;
  address: string;
  areaSqm?: number;
  approvedDocumentCount: number;
  availableFrom?: string;
  availableFromText?: string;
  availableUnits: number;
  buildingCount: number;
  channelPriceVisibility?: Record<string, PropertyPriceVisibility>;
  contactId?: string;
  contactLabel?: string;
  costItemCount: number;
  coverImageCount: number;
  documentCount: number;
  energyDocumentCount: number;
  expectedGrossYield?: number;
  floorplanDocumentCount: number;
  gdprStatus?: string;
  id: string;
  imageCount: number;
  internalReference?: string;
  kind: "property" | "project" | "mandate";
  location: string;
  mandateId?: string;
  marketingType?: string;
  monthlyCostsGross?: number;
  objectType: string;
  objectNumber?: string;
  portalMappingStatus?: string;
  price?: number;
  priceVisibility: PropertyPriceVisibility;
  projectId?: string;
  projectName: string;
  publicDocumentCount: number;
  publicImageCount: number;
  publicPrice?: number;
  purchaseAncillaryCosts?: number;
  region?: string;
  reservedUnits: number;
  rooms?: number;
  sellerLeadId?: string;
  sellerListingId?: string;
  soldUnits: number;
  status: PropertyAssetStatus;
  subObjectType?: string;
  title: string;
  textBlockCount: number;
  usageType?: string;
  unitCount: number;
  updatedAt?: string;
  workspaceId: string;
  yearBuilt?: number;
};

export type PropertyInquiryRouteInput = {
  areaSqm?: number;
  budgetFrom?: number;
  budgetTo?: number;
  campaign?: string;
  contactEmail?: string;
  contactId?: string;
  contactPhone?: string;
  formId?: string;
  funnelId?: string;
  leadId?: string;
  leadType?: Lead["type"] | string;
  location?: string;
  ownerUserId?: string;
  projectId?: string;
  propertyId?: string;
  rooms?: number;
  sourceChannel: string;
  unitId?: string;
  useCase?: string;
  workspaceId: string;
};

export type PropertyInquiryRouteResult = {
  campaign?: string;
  confidenceScore: number;
  contactId?: string;
  duplicateKey: string;
  formId?: string;
  funnelId?: string;
  leadId?: string;
  ownerUserId?: string;
  projectId?: string;
  propertyId?: string;
  routingReason: string;
  sourceChannel: string;
  unitId?: string;
  warnings: string[];
  workspaceId: string;
};

export type PropertyPreflightCheck = {
  id: string;
  label: string;
  message: string;
  required: boolean;
  status: "pass" | "warning" | "blocked";
};

export type PropertyPreflightResult = {
  blockers: string[];
  checks: PropertyPreflightCheck[];
  channel: string;
  status: "pass" | "warning" | "blocked";
  warnings: string[];
};

export type PropertyDataQualityIssue = {
  assetId?: string;
  message: string;
  severity: "info" | "warning" | "critical";
  title: string;
};

export type PropertyMatch = {
  asset: PropertyAssetSummary;
  contact?: Contact;
  lead?: Lead;
  profile?: BuyerSearchProfile;
  reasons: string[];
  score: number;
};

export function getPropertyActionStates(input: {
  productRole: ProductRole;
  technicalRole: WorkspaceRole;
}): Record<PropertyActionKey, PropertyActionState> {
  const canOperate = hasProductCapability(input.productRole, "workspace:operate");
  const canWritePipeline = hasProductCapability(input.productRole, "pipeline:write");
  const canReserve = hasProductCapability(input.productRole, "reservations:write");
  const canPublish = hasProductCapability(input.productRole, "funnels:publish") || hasProductCapability(input.productRole, "newsletter:send");
  const canAdmin = input.technicalRole === "owner" ||
    input.technicalRole === "admin" ||
    hasProductCapability(input.productRole, "settings:manage") ||
    hasProductCapability(input.productRole, "workspace:admin");
  const writeReason = "Schreibrechte für CRM/Pipeline erforderlich.";
  const adminReason = "Admin-, Owner- oder passende Freigaberechte erforderlich.";

  return {
    approveDocument: {
      enabled: canAdmin,
      label: "Dokument freigeben",
      reason: canAdmin ? undefined : adminReason,
    },
    assignInquiry: {
      enabled: true,
      label: "Anfrage zuordnen",
    },
    changePrice: {
      enabled: canAdmin,
      label: "Preis ändern",
      reason: canAdmin ? undefined : adminReason,
    },
    convertReservation: {
      enabled: canReserve && canAdmin,
      label: "Reservierung konvertieren",
      reason: canReserve && canAdmin ? undefined : "Reservierungs- und Abschlussrechte erforderlich.",
    },
    createProperty: {
      enabled: canOperate || canWritePipeline,
      label: "Objekt speichern",
      reason: canOperate || canWritePipeline ? undefined : writeReason,
    },
    exportChannel: {
      enabled: canPublish && canAdmin,
      label: "Export starten",
      reason: canPublish && canAdmin ? undefined : "Publikations- und Freigaberechte erforderlich.",
    },
    publishProperty: {
      enabled: canPublish && canAdmin,
      label: "Objekt veröffentlichen",
      reason: canPublish && canAdmin ? undefined : "Publikations- und Freigaberechte erforderlich.",
    },
    reserveUnit: {
      enabled: canReserve,
      label: "Einheit reservieren",
      reason: canReserve ? undefined : "Reservierungsrechte erforderlich.",
    },
  };
}

export function buildPropertyAssets(input: {
  brokerMandates: BrokerMandate[];
  buildings: PropertyBuilding[];
  propertyCostItems?: PropertyCostItem[];
  propertyDocuments?: PropertyDocumentItem[];
  propertyMedia?: PropertyMediaItem[];
  propertyTextBlocks?: PropertyTextBlock[];
  projects: Project[];
  reservations: PropertyReservation[];
  sellerListings: SellerListing[];
  units: PropertyUnit[];
}): PropertyAssetSummary[] {
  const projectById = new Map(input.projects.map((project) => [project.id, project]));
  const unitsByProject = groupBy(input.units, (unit) => unit.projectId);
  const buildingsByProject = groupBy(input.buildings, (building) => building.projectId);
  const reservationsByProject = groupBy(input.reservations, (reservation) => reservation.projectId);
  const costItemsByProperty = groupBy(input.propertyCostItems ?? [], (item) => item.propertyId);
  const documentsByProperty = groupBy(input.propertyDocuments ?? [], (item) => item.propertyId);
  const mediaByProperty = groupBy(input.propertyMedia ?? [], (item) => item.propertyId);
  const textBlocksByProperty = groupBy(input.propertyTextBlocks ?? [], (item) => item.propertyId);
  const assets: PropertyAssetSummary[] = [];

  for (const listing of input.sellerListings) {
    const projectUnits = listing.projectId ? unitsByProject.get(listing.projectId) ?? [] : [];
    const projectReservations = listing.projectId ? reservationsByProject.get(listing.projectId) ?? [] : [];
    const listingCostItems = costItemsByProperty.get(listing.id) ?? [];
    const listingDocuments = documentsByProperty.get(listing.id) ?? [];
    const listingMedia = mediaByProperty.get(listing.id) ?? [];
    const listingTextBlocks = textBlocksByProperty.get(listing.id) ?? [];
    const imageItems = listingMedia.filter((item) => item.mediaType === "image" || item.mimeType?.startsWith("image/"));
    const coverImageCount = imageItems.filter((item) => item.isCover || item.category === "cover").length;
    const approvedDocuments = listingDocuments.filter((item) => item.status === "approved" || item.status === "sent");
    const energyDocumentCount = listingDocuments.filter((item) => item.category === "energy_certificate").length;
    const floorplanDocumentCount = listingDocuments.filter((item) => item.category === "floorplan").length;
    const priceVisibility = listing.priceVisibility ?? "publish_price";
    const internalPrice = listing.targetPrice || listing.marketValue || listing.publicPrice || listing.rentPrice;
    assets.push({
      activeReservations: countActiveReservations(projectReservations),
      address: listing.address,
      areaSqm: listing.areaSqm,
      approvedDocumentCount: approvedDocuments.length,
      availableFrom: listing.availableFrom,
      availableFromText: listing.availableFromText,
      availableUnits: projectUnits.filter((unit) => unit.status === "available").length,
      buildingCount: listing.projectId ? buildingsByProject.get(listing.projectId)?.length ?? 0 : 0,
      channelPriceVisibility: listing.channelPriceVisibility,
      contactLabel: listing.contactName || listing.contactEmail || listing.contactPhone || listing.ownerContactId || listing.sellerLeadId,
      costItemCount: listingCostItems.length,
      coverImageCount,
      documentCount: listingDocuments.length,
      energyDocumentCount,
      expectedGrossYield: listing.expectedGrossYield,
      floorplanDocumentCount,
      gdprStatus: listing.gdprStatus,
      id: `listing:${listing.id}`,
      imageCount: imageItems.length,
      internalReference: listing.internalReference,
      kind: "property",
      location: listing.address,
      objectType: listing.objectType,
      objectNumber: listing.objectNumber,
      marketingType: listing.marketingType,
      mandateId: listing.mandateId,
      monthlyCostsGross: listing.monthlyCostsGross,
      portalMappingStatus: listing.portalMappingStatus,
      price: internalPrice,
      priceVisibility,
      projectId: listing.projectId,
      projectName: projectById.get(listing.projectId)?.name ?? "Ohne Projekt",
      publicDocumentCount: listingDocuments.filter((item) => item.visibility === "public").length,
      publicImageCount: imageItems.filter((item) => item.visibility === "public").length,
      publicPrice: listing.publicPrice,
      purchaseAncillaryCosts: listing.purchaseAncillaryCosts,
      region: listing.region,
      reservedUnits: projectUnits.filter((unit) => unit.status === "reserved").length,
      rooms: listing.rooms,
      sellerLeadId: listing.sellerLeadId,
      sellerListingId: listing.id,
      soldUnits: projectUnits.filter((unit) => unit.status === "sold").length,
      status: resolveAssetStatus({
        hasAddress: Boolean(listing.address),
        hasEnergy: Boolean(listing.energyValidUntil || listing.energyClass || energyDocumentCount),
        hasMedia: imageItems.length > 0,
        hasPrice: Boolean(internalPrice),
        hasReservation: countActiveReservations(projectReservations) > 0,
        soldUnits: projectUnits.filter((unit) => unit.status === "sold").length,
        unitCount: projectUnits.length,
      }),
      subObjectType: listing.subObjectType || listing.subObjectTypeCustom,
      textBlockCount: listingTextBlocks.filter((item) => item.content.trim()).length,
      title: listing.title,
      usageType: listing.usageType,
      unitCount: projectUnits.length,
      updatedAt: listing.createdAt,
      workspaceId: listing.workspaceId,
      yearBuilt: listing.yearBuilt,
    });
  }

  const projectIdsWithListing = new Set(input.sellerListings.map((listing) => listing.projectId).filter(Boolean));
  for (const project of input.projects) {
    const projectUnits = unitsByProject.get(project.id) ?? [];
    if (projectIdsWithListing.has(project.id) && projectUnits.length === 0) continue;
    const projectReservations = reservationsByProject.get(project.id) ?? [];
    const projectBuildings = buildingsByProject.get(project.id) ?? [];
    const value = projectUnits.reduce((sum, unit) => sum + unit.priceCents / 100, 0);
    const area = projectUnits.reduce((sum, unit) => sum + unit.areaSqm, 0);

    assets.push({
      activeReservations: countActiveReservations(projectReservations),
      address: projectBuildings[0]?.address ?? "",
      areaSqm: area || undefined,
      approvedDocumentCount: 0,
      availableUnits: projectUnits.filter((unit) => unit.status === "available").length,
      buildingCount: projectBuildings.length,
      costItemCount: 0,
      coverImageCount: 0,
      documentCount: 0,
      energyDocumentCount: 0,
      floorplanDocumentCount: 0,
      id: `project:${project.id}`,
      imageCount: 0,
      kind: "project",
      location: projectBuildings[0]?.address ?? project.name,
      objectType: project.type,
      price: value || parseEuroText(project.revenue),
      priceVisibility: "publish_price",
      projectId: project.id,
      projectName: project.name,
      publicDocumentCount: 0,
      publicImageCount: 0,
      reservedUnits: projectUnits.filter((unit) => unit.status === "reserved").length,
      soldUnits: projectUnits.filter((unit) => unit.status === "sold").length,
      status: resolveAssetStatus({
        hasAddress: Boolean(projectBuildings[0]?.address),
        hasEnergy: false,
        hasMedia: false,
        hasPrice: value > 0,
        hasReservation: countActiveReservations(projectReservations) > 0,
        soldUnits: projectUnits.filter((unit) => unit.status === "sold").length,
        unitCount: projectUnits.length,
      }),
      textBlockCount: 0,
      title: project.name,
      unitCount: projectUnits.length,
      workspaceId: project.workspaceId,
    });
  }

  const listingTitles = new Set(input.sellerListings.map((listing) => normalizeText(listing.title)));
  for (const mandate of input.brokerMandates) {
    if (listingTitles.has(normalizeText(mandate.title))) continue;
    assets.push({
      activeReservations: 0,
      address: mandate.address,
      areaSqm: mandate.areaSqm,
      approvedDocumentCount: 0,
      availableUnits: 0,
      buildingCount: 0,
      contactId: mandate.contactId,
      contactLabel: mandate.contactId,
      costItemCount: 0,
      coverImageCount: 0,
      documentCount: 0,
      energyDocumentCount: 0,
      floorplanDocumentCount: 0,
      id: `mandate:${mandate.id}`,
      imageCount: 0,
      kind: "mandate",
      location: mandate.location ?? mandate.address,
      mandateId: mandate.id,
      objectType: mandate.propertyType ?? "Objekt",
      price: mandate.askingPrice ?? mandate.marketValue,
      priceVisibility: "publish_price",
      projectId: mandate.projectId,
      projectName: projectById.get(mandate.projectId ?? "")?.name ?? "Maklerbestand",
      publicDocumentCount: 0,
      publicImageCount: 0,
      reservedUnits: 0,
      rooms: mandate.rooms,
      sellerLeadId: mandate.sellerLeadId,
      soldUnits: 0,
      status: mandate.marketingStatus?.toLowerCase().includes("ready") ? "ready" : "needs_review",
      textBlockCount: 0,
      title: mandate.title,
      unitCount: 0,
      updatedAt: mandate.updatedAt,
      workspaceId: mandate.workspaceId,
      yearBuilt: mandate.yearBuilt,
    });
  }

  return assets.sort((left, right) => {
    const leftScore = statusSort(left.status);
    const rightScore = statusSort(right.status);
    if (leftScore !== rightScore) return leftScore - rightScore;
    return left.title.localeCompare(right.title);
  });
}

export function routePropertyInquiry(input: PropertyInquiryRouteInput, candidates: {
  assets: PropertyAssetSummary[];
  reservations: PropertyReservation[];
  units: PropertyUnit[];
}): PropertyInquiryRouteResult {
  const warnings: string[] = [];
  const directUnit = input.unitId ? candidates.units.find((unit) => unit.id === input.unitId) : undefined;
  if (directUnit) {
    appendReservationWarning(warnings, directUnit.id, candidates.reservations);
    return buildRouteResult(input, {
      confidenceScore: 0.97,
      projectId: directUnit.projectId,
      propertyId: input.propertyId,
      routingReason: "Direkte Einheit erkannt.",
      unitId: directUnit.id,
      warnings,
    });
  }

  const directAsset = input.propertyId ? candidates.assets.find((asset) => asset.id === input.propertyId) : undefined;
  if (directAsset) {
    return buildRouteResult(input, {
      confidenceScore: 0.9,
      projectId: directAsset.projectId,
      propertyId: directAsset.id,
      routingReason: "Direktes Objekt erkannt.",
      warnings,
    });
  }

  const projectAssets = candidates.assets.filter((asset) => !input.projectId || asset.projectId === input.projectId);
  const ranked = projectAssets
    .map((asset) => ({ asset, score: scoreInquiryAsset(input, asset) }))
    .sort((left, right) => right.score - left.score);
  const best = ranked[0];

  if (best && best.score >= 35) {
    return buildRouteResult(input, {
      confidenceScore: Math.min(0.86, 0.45 + best.score / 100),
      projectId: best.asset.projectId ?? input.projectId,
      propertyId: best.asset.id,
      routingReason: "Matching nach Budget, Lage, Zimmer, Fläche, Nutzung und Lead-Typ.",
      warnings,
    });
  }

  return buildRouteResult(input, {
    confidenceScore: input.projectId ? 0.45 : 0.25,
    projectId: input.projectId,
    routingReason: input.projectId ? "Nur Projekt erkannt; manuelle Zuordnung erforderlich." : "Keine belastbare Objektzuordnung.",
    warnings: [...warnings, "Manuelle Pruefung erforderlich."],
  });
}

export function runPropertyChannelPreflight(asset: PropertyAssetSummary, channel: string): PropertyPreflightResult {
  const priceVisibility = resolveChannelPriceVisibility(asset, channel);
  const requiresPublicAssets = channel !== "Off-market";
  const requiresPortalMapping = channel === "OpenImmo Export" || channel === "Immobilienportal";
  const hasPublicPrice = priceVisibility !== "publish_price" || Boolean((asset.publicPrice ?? asset.price ?? 0) > 0);
  const mappingReady = asset.kind !== "property" ||
    !requiresPortalMapping ||
    ["ready", "mapped", "published"].includes(normalizeText(asset.portalMappingStatus));
  const checks: PropertyPreflightCheck[] = [
    check("object_identity", "Objektnummer / Objektart", Boolean(asset.objectNumber || asset.internalReference) && Boolean(asset.objectType), true),
    check("address", "Adresse / Lage", Boolean(asset.address || asset.location), true),
    check("area", "Flächen", Boolean(asset.areaSqm && asset.areaSqm > 0), true),
    check("internal_price", "Interner Preis", Boolean(asset.price && asset.price > 0), true, "Interner Preis ist gespeichert."),
    check(
      "public_price",
      "Öffentlicher Preis",
      hasPublicPrice,
      priceVisibility === "publish_price",
      priceVisibility === "price_on_request"
        ? "Preis auf Anfrage ist für diesen Kanal erlaubt."
        : priceVisibility === "hide_price"
          ? "Preis wird öffentlich ausgeblendet, intern bleibt er gespeichert."
          : undefined,
    ),
    check("text", "Vermarktungstexte", asset.textBlockCount > 0, requiresPublicAssets),
    check("costs", "Kostenmatrix", asset.costItemCount > 0 || Boolean(asset.monthlyCostsGross || asset.purchaseAncillaryCosts), true),
    check("energy", "Energieausweis", asset.energyDocumentCount > 0, channel === "OpenImmo Export" || channel === "Immobilienportal"),
    check("media", "Titelbild / Bilder", !requiresPublicAssets || asset.coverImageCount > 0 || asset.publicImageCount > 0, requiresPublicAssets),
    check("documents", "Dokumente", asset.approvedDocumentCount > 0 || asset.publicDocumentCount > 0, requiresPublicAssets),
    check("floorplan", "Grundriss", asset.floorplanDocumentCount > 0, channel === "OpenImmo Export" || channel === "Immobilienportal"),
    check("availability", "Verfügbarkeit", Boolean(asset.availableFrom || asset.availableFromText) || asset.unitCount === 0 || asset.availableUnits > 0 || asset.reservedUnits > 0, true),
    check("contact", "Ansprechpartner", Boolean(asset.contactId || asset.contactLabel || asset.sellerLeadId || asset.projectId), true),
    check("gdpr", "DSGVO / Widerruf", !["blocked", "missing"].includes(normalizeText(asset.gdprStatus)), true),
    check("mapping", "Portal-/Kanal-Mapping", mappingReady, requiresPortalMapping),
  ];
  const blockers = checks.filter((item) => item.status === "blocked").map((item) => item.label);
  const warnings = checks.filter((item) => item.status === "warning").map((item) => item.label);

  return {
    blockers,
    channel,
    checks,
    status: blockers.length ? "blocked" : warnings.length ? "warning" : "pass",
    warnings,
  };
}

export function buildPropertyDataQualityIssues(input: {
  assets: PropertyAssetSummary[];
  leads: Lead[];
  reservations: PropertyReservation[];
}): PropertyDataQualityIssue[] {
  const issues: PropertyDataQualityIssue[] = [];
  for (const asset of input.assets) {
    if (!asset.address) {
      issues.push({ assetId: asset.id, message: asset.title, severity: "critical", title: "Adresse fehlt" });
    }
    if (!asset.price) {
      issues.push({ assetId: asset.id, message: asset.title, severity: "warning", title: "Preis fehlt" });
    }
    if (asset.priceVisibility === "publish_price" && !asset.publicPrice && !asset.price) {
      issues.push({ assetId: asset.id, message: asset.title, severity: "critical", title: "Öffentlicher Preis fehlt" });
    }
    if (!asset.areaSqm) {
      issues.push({ assetId: asset.id, message: asset.title, severity: "warning", title: "Flächen fehlen" });
    }
    if (!asset.objectNumber && asset.kind === "property") {
      issues.push({ assetId: asset.id, message: asset.title, severity: "warning", title: "Objektnummer fehlt" });
    }
    if (!asset.subObjectType && asset.kind === "property") {
      issues.push({ assetId: asset.id, message: asset.title, severity: "info", title: "Unterobjektart fehlt" });
    }
    if (asset.textBlockCount === 0 && asset.kind === "property") {
      issues.push({ assetId: asset.id, message: asset.title, severity: "warning", title: "Vermarktungstext fehlt" });
    }
    if (asset.costItemCount === 0 && !asset.monthlyCostsGross && !asset.purchaseAncillaryCosts) {
      issues.push({ assetId: asset.id, message: asset.title, severity: "warning", title: "Kostenmatrix fehlt" });
    }
    if (asset.imageCount === 0 && asset.kind === "property") {
      issues.push({ assetId: asset.id, message: asset.title, severity: "critical", title: "Bilder fehlen" });
    } else if (asset.coverImageCount === 0 && asset.kind === "property") {
      issues.push({ assetId: asset.id, message: asset.title, severity: "warning", title: "Titelbild fehlt" });
    }
    if (asset.documentCount === 0 && asset.kind === "property") {
      issues.push({ assetId: asset.id, message: asset.title, severity: "warning", title: "Dokumente fehlen" });
    }
    if (asset.energyDocumentCount === 0 && asset.kind === "property") {
      issues.push({ assetId: asset.id, message: asset.title, severity: "warning", title: "Energiedokument fehlt" });
    }
    if (!["ready", "mapped", "published"].includes(normalizeText(asset.portalMappingStatus)) && asset.kind === "property") {
      issues.push({ assetId: asset.id, message: asset.title, severity: "info", title: "Portal-Mapping offen" });
    }
    if (asset.status === "needs_review") {
      issues.push({ assetId: asset.id, message: asset.title, severity: "info", title: "Vermarktung pruefen" });
    }
  }

  const now = Date.now();
  for (const reservation of input.reservations) {
    const expiresAt = new Date(reservation.expiresAt).getTime();
    if ((reservation.status === "hold" || reservation.status === "reserved") && Number.isFinite(expiresAt) && expiresAt < now) {
      issues.push({
        message: reservation.nextAction || reservation.unitId,
        severity: "critical",
        title: "Reservierungsfrist abgelaufen",
      });
    }
  }

  for (const lead of input.leads) {
    if (!lead.projectId && !lead.objectType) {
      issues.push({
        message: lead.intent,
        severity: "warning",
        title: "Anfrage nicht zugeordnet",
      });
    }
  }

  return issues;
}

export function buildPropertyMatches(input: {
  assets: PropertyAssetSummary[];
  buyerSearchProfiles: BuyerSearchProfile[];
  contacts: Contact[];
  leads: Lead[];
}): PropertyMatch[] {
  const contactById = new Map(input.contacts.map((contact) => [contact.id, contact]));
  const leadById = new Map(input.leads.map((lead) => [lead.id, lead]));
  const matches: PropertyMatch[] = [];

  for (const asset of input.assets) {
    for (const profile of input.buyerSearchProfiles) {
      const reasons: string[] = [];
      let score = 0;
      if (profile.projectId && asset.projectId && profile.projectId === asset.projectId) {
        score += 20;
        reasons.push("Projekt");
      }
      if (profile.budgetTo && asset.price && profile.budgetTo >= asset.price && (!profile.budgetFrom || profile.budgetFrom <= asset.price)) {
        score += 35;
        reasons.push("Budget");
      }
      if (profile.desiredLocation && normalizeText(asset.location).includes(normalizeText(profile.desiredLocation))) {
        score += 20;
        reasons.push("Lage");
      }
      if (profile.rooms && asset.rooms && Math.abs(profile.rooms - asset.rooms) <= 1) {
        score += 15;
        reasons.push("Zimmer");
      }
      if (profile.areaSqm && asset.areaSqm && Math.abs(profile.areaSqm - asset.areaSqm) <= Math.max(10, asset.areaSqm * 0.15)) {
        score += 10;
        reasons.push("Fläche");
      }
      if (score >= 35) {
        matches.push({
          asset,
          contact: profile.contactId ? contactById.get(profile.contactId) : undefined,
          lead: profile.buyerLeadId ? leadById.get(profile.buyerLeadId) : undefined,
          profile,
          reasons,
          score: Math.min(100, score),
        });
      }
    }

    for (const lead of input.leads.filter((item) => {
      const leadType = normalizeText(item.type);
      return leadType.includes("kaufer") || leadType.includes("kaeufer") || item.type === "Investor";
    })) {
      const score = scoreInquiryAsset({
        areaSqm: lead.areaSqm,
        budgetFrom: lead.buyerProfile?.budgetFrom ?? lead.investorProfile?.investmentVolumeFrom,
        budgetTo: lead.buyerProfile?.budgetTo ?? lead.investorProfile?.investmentVolumeTo,
        leadType: lead.type,
        location: lead.region,
        projectId: lead.projectId,
        rooms: lead.rooms,
        sourceChannel: lead.source,
        workspaceId: lead.workspaceId,
      }, asset);
      if (score >= 45) {
        matches.push({
          asset,
          contact: contactById.get(lead.contactId),
          lead,
          reasons: ["Lead-Score", "Suchkriterien"],
          score: Math.min(100, score),
        });
      }
    }
  }

  return matches
    .sort((left, right) => right.score - left.score)
    .slice(0, 20);
}

function buildRouteResult(
  input: PropertyInquiryRouteInput,
  route: {
    confidenceScore: number;
    projectId?: string;
    propertyId?: string;
    routingReason: string;
    unitId?: string;
    warnings: string[];
  },
): PropertyInquiryRouteResult {
  const objectKey = route.unitId ?? route.propertyId ?? route.projectId ?? "unassigned";
  const contactKey = normalizeText(input.contactEmail || input.contactPhone || input.contactId || input.leadId || "unknown");

  return {
    campaign: input.campaign,
    confidenceScore: Math.round(route.confidenceScore * 100) / 100,
    contactId: input.contactId,
    duplicateKey: `${contactKey}:${objectKey}`,
    formId: input.formId,
    funnelId: input.funnelId,
    leadId: input.leadId,
    ownerUserId: input.ownerUserId,
    projectId: route.projectId,
    propertyId: route.propertyId,
    routingReason: route.routingReason,
    sourceChannel: input.sourceChannel,
    unitId: route.unitId,
    warnings: route.warnings,
    workspaceId: input.workspaceId,
  };
}

function appendReservationWarning(warnings: string[], unitId: string, reservations: PropertyReservation[]) {
  const hasActiveReservation = reservations.some(
    (reservation) => reservation.unitId === unitId && (reservation.status === "hold" || reservation.status === "reserved"),
  );
  if (hasActiveReservation) {
    warnings.push("Aktive Reservierung erkannt; keine neue Reservierung erstellen.");
  }
}

function check(
  id: string,
  label: string,
  passed: boolean,
  required: boolean,
  passMessage = "OK",
): PropertyPreflightCheck {
  return {
    id,
    label,
    message: passed ? passMessage : required ? "Pflichtfeld fehlt oder Mapping offen." : "Empfohlen vor Veröffentlichung.",
    required,
    status: passed ? "pass" : required ? "blocked" : "warning",
  };
}

function resolveChannelPriceVisibility(asset: PropertyAssetSummary, channel: string): PropertyPriceVisibility {
  const override = asset.channelPriceVisibility?.[channel];
  if (override === "price_on_request" || override === "hide_price" || override === "publish_price") {
    return override;
  }
  return asset.priceVisibility;
}

function resolveAssetStatus(input: {
  hasAddress: boolean;
  hasEnergy: boolean;
  hasMedia: boolean;
  hasPrice: boolean;
  hasReservation: boolean;
  soldUnits: number;
  unitCount: number;
}): PropertyAssetStatus {
  if (input.unitCount > 0 && input.soldUnits === input.unitCount) return "sold";
  if (input.hasReservation) return "reserved";
  if (!input.hasAddress || !input.hasPrice) return "draft";
  if (!input.hasEnergy || !input.hasMedia) return "needs_review";
  return "ready";
}

function statusSort(status: PropertyAssetStatus) {
  if (status === "needs_review") return 0;
  if (status === "draft") return 1;
  if (status === "reserved") return 2;
  if (status === "ready") return 3;
  if (status === "published") return 4;
  return 5;
}

function scoreInquiryAsset(input: PropertyInquiryRouteInput, asset: PropertyAssetSummary) {
  let score = 0;
  if (input.projectId && asset.projectId === input.projectId) score += 25;
  if (input.location && normalizeText(asset.location).includes(normalizeText(input.location))) score += 20;
  if (input.budgetTo && asset.price && input.budgetTo >= asset.price && (!input.budgetFrom || input.budgetFrom <= asset.price)) score += 30;
  if (input.rooms && asset.rooms && Math.abs(input.rooms - asset.rooms) <= 1) score += 12;
  if (input.areaSqm && asset.areaSqm && Math.abs(input.areaSqm - asset.areaSqm) <= Math.max(10, asset.areaSqm * 0.15)) score += 10;
  if (input.leadType === "Investor" && asset.expectedGrossYield) score += 12;
  if (input.useCase?.toLowerCase().includes("anlage") && asset.expectedGrossYield) score += 8;
  return score;
}

function countActiveReservations(reservations: PropertyReservation[]) {
  return reservations.filter((reservation) => reservation.status === "hold" || reservation.status === "reserved").length;
}

function parseEuroText(value: string | undefined) {
  if (!value) return undefined;
  const multiplier = value.toLowerCase().includes("mio") ? 1_000_000 : 1;
  const parsed = Number(value.replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed * multiplier : undefined;
}

function normalizeText(value: string | undefined) {
  return (value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function groupBy<Item>(items: Item[], getKey: (item: Item) => string | undefined) {
  const groups = new Map<string, Item[]>();
  for (const item of items) {
    const key = getKey(item);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return groups;
}
