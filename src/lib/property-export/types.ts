import type { PropertyPreflightResult } from "@/lib/property-department";

export const PROPERTY_EXPORT_QA_PROVIDER = "novalure_qa_sink" as const;
export const PROPERTY_EXPORT_OPERATION = "qa_test_export" as const;
export const PROPERTY_EXPORT_FORMAT = "openimmo_preview_v1" as const;
export const PROPERTY_EXPORT_CHANNEL = "OpenImmo Export" as const;

export type PropertyPublicationStatus =
  | "draft"
  | "preflight_failed"
  | "ready"
  | "queued"
  | "exporting"
  | "published"
  | "partially_published"
  | "update_required"
  | "failed"
  | "paused"
  | "withdrawn";

export type PropertyExportJobStatus =
  | "cancelled"
  | "completed"
  | "dead_letter"
  | "failed"
  | "queued"
  | "retry"
  | "running";

export type PropertyExportProviderState = "launch_off" | "not_configured" | "ready";

export type PropertyExportAvailability = Readonly<{
  externalPortals: ReadonlyArray<{
    configurationState: "not_configured";
    key: string;
    label: string;
    launchState: "launch_off";
  }>;
  qaSink: {
    key: typeof PROPERTY_EXPORT_QA_PROVIDER;
    label: string;
    state: PropertyExportProviderState;
  };
}>;

export type PropertyExportScalar = number | string | null;

export type PropertyExportSource = Readonly<{
  costs: ReadonlyArray<{
    costKey: string;
    exposeVisible: boolean;
    groupKey: string;
    id: string;
    label: string;
    monthlyGrossCents: PropertyExportScalar;
    monthlyNetCents: PropertyExportScalar;
    monthlyVatCents: PropertyExportScalar;
    oneTimeGrossCents: PropertyExportScalar;
    oneTimeNetCents: PropertyExportScalar;
    oneTimeVatCents: PropertyExportScalar;
    optional: boolean;
    position: number;
    vatPercent: PropertyExportScalar;
  }>;
  documents: ReadonlyArray<{
    assetName: string | null;
    category: string;
    id: string;
    mediaAssetId: string | null;
    mimeType: string | null;
    requiredForPublication: boolean;
    status: string;
    title: string;
    visibility: string;
  }>;
  listing: {
    address: string;
    areaSqm: PropertyExportScalar;
    availableFrom: string | Date | null;
    availableFromText: string | null;
    channelPriceVisibility: Record<string, unknown> | null;
    city: string | null;
    contactEmail: string | null;
    contactName: string | null;
    contactPhone: string | null;
    country: string | null;
    expectedGrossYield: PropertyExportScalar;
    federalState: string | null;
    gdprStatus: string | null;
    houseNumber: string | null;
    id: string;
    internalReference: string | null;
    marketingType: string | null;
    marketValueCents: PropertyExportScalar;
    monthlyCostsGrossCents: PropertyExportScalar;
    objectNumber: string | null;
    objectType: string;
    openimmoObjectId: string | null;
    ownerContactId: string | null;
    portalMappingStatus: string | null;
    postalCode: string | null;
    priceVisibility: string | null;
    projectId: string | null;
    propertyStatus: string | null;
    publicPriceCents: PropertyExportScalar;
    purchaseAncillaryCostsCents: PropertyExportScalar;
    region: string | null;
    rentNetCents: PropertyExportScalar;
    rentPriceCents: PropertyExportScalar;
    rooms: PropertyExportScalar;
    sellerLeadId: string | null;
    street: string | null;
    subObjectType: string | null;
    targetPriceCents: PropertyExportScalar;
    title: string;
    unitId: string | null;
    updatedAt: string | Date;
    usageType: string | null;
    workspaceId: string;
    yearBuilt: PropertyExportScalar;
  };
  media: ReadonlyArray<{
    altText: string | null;
    assetName: string | null;
    category: string;
    id: string;
    isCover: boolean;
    mediaAssetId: string | null;
    mediaType: string;
    mimeType: string | null;
    position: number;
    status: string;
    title: string;
    visibility: string;
  }>;
  project: { id: string; name: string } | null;
  texts: ReadonlyArray<{
    channel: string;
    content: string;
    id: string;
    position: number;
    seoDescription: string | null;
    seoTitle: string | null;
    status: string;
    textKey: string;
    title: string;
    visibility: string;
  }>;
  units: ReadonlyArray<{
    areaSqm: PropertyExportScalar;
    floor: number;
    id: string;
    priceCents: PropertyExportScalar;
    rooms: PropertyExportScalar;
    status: string;
    unitNumber: string;
  }>;
  unitCounts: {
    activeReservations: number;
    available: number;
    reserved: number;
    sold: number;
    total: number;
  };
  buildingCount: number;
}>;

export type PropertyExportSnapshot = Readonly<{
  channel: typeof PROPERTY_EXPORT_CHANNEL;
  costs: ReadonlyArray<Record<string, boolean | number | string | null>>;
  documents: ReadonlyArray<Record<string, boolean | number | string | null>>;
  format: typeof PROPERTY_EXPORT_FORMAT;
  media: ReadonlyArray<Record<string, boolean | number | string | null>>;
  property: Readonly<{
    address: Readonly<{
      city: string | null;
      country: string;
      federalState: string | null;
      houseNumber: string | null;
      postalCode: string | null;
      street: string | null;
      unstructured: string;
    }>;
    areaSqm: number | null;
    availability: Readonly<{
      availableFrom: string | null;
      availableFromText: string | null;
    }>;
    contact: Readonly<{
      email: string | null;
      name: string | null;
      phone: string | null;
    }>;
    id: string;
    identifiers: Readonly<{
      internalReference: string | null;
      objectNumber: string | null;
      openimmoObjectId: string | null;
    }>;
    marketingType: string | null;
    objectType: string;
    pricing: Readonly<{
      monthlyCostsGrossCents: number | null;
      priceVisibility: "hide_price" | "price_on_request" | "publish_price";
      publicPriceCents: number | null;
      purchaseAncillaryCostsCents: number | null;
      rentNetCents: number | null;
      rentPriceCents: number | null;
    }>;
    project: { id: string; name: string } | null;
    region: string | null;
    rooms: number | null;
    subObjectType: string | null;
    title: string;
    units: ReadonlyArray<{
      areaSqm: number | null;
      floor: number;
      id: string;
      priceCents: number | null;
      rooms: number | null;
      status: string;
      unitNumber: string;
    }>;
    updatedAt: string;
    usageType: string | null;
    yearBuilt: number | null;
  }>;
  schema: "novalure.property-export-snapshot.v1";
  texts: ReadonlyArray<Record<string, number | string | null>>;
}>;

export type PropertyExportEventView = Readonly<{
  attemptCount: number;
  eventType: string;
  fromStatus: string | null;
  id: string;
  message: string | null;
  occurredAt: string;
  toStatus: string;
}>;

export type PropertyExportJobView = Readonly<{
  artifactContentType: string | null;
  artifactFilename: string | null;
  artifactSha256: string | null;
  attemptCount: number;
  availableAt: string;
  channelStatus: PropertyPublicationStatus;
  channelUpdatedAt: string;
  createdAt: string;
  deadLetteredAt: string | null;
  events: PropertyExportEventView[];
  finishedAt: string | null;
  id: string;
  lastErrorCategory: string | null;
  lastErrorMessage: string | null;
  maxAttempts: number;
  payloadSha256: string | null;
  preflightStatus: string;
  projectId: string | null;
  propertyId: string;
  providerAcknowledgedAt: string | null;
  providerKey: string | null;
  providerRequestId: string | null;
  snapshotCapturedAt: string | null;
  scheduledAt: string | null;
  startedAt: string | null;
  status: PropertyExportJobStatus;
  updatedAt: string;
}>;

export type ClaimedPropertyExportJob = Readonly<{
  attemptCount: number;
  id: string;
  leaseOwner: string;
  maxAttempts: number;
  payloadSha256: string;
  payloadSnapshot: PropertyExportSnapshot;
  projectId: string | null;
  propertyChannelId: string;
  propertyId: string;
  providerKey: string;
  startedByUserId: string;
  workspaceId: string;
}>;

export type EnqueuePropertyExportResult = Readonly<{
  created: boolean;
  job: PropertyExportJobView;
  preflight: PropertyPreflightResult;
}>;

export type PropertyExportArtifact = Readonly<{
  content: string;
  contentType: string;
  filename: string;
  sha256: string;
}>;
