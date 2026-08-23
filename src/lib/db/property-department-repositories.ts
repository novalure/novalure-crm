import type { AppSession } from "@/lib/auth/session";
import type { PropertyPriceVisibility, SellerListing } from "@/lib/crm-types";
import type {
  PropertyInquiryRouteInput,
  PropertyInquiryRouteResult,
  PropertyPreflightResult,
} from "@/lib/property-department";
import { executeQuery, queryOne } from "@/lib/db/client";
import { canPersist, isUuid, writeAuditLog } from "@/lib/db/runtime-repositories";
import { withTenantTransaction, type TenantTransaction } from "@/lib/db/tenant-client";
import { evaluateLaunchScope } from "@/lib/launch-scope";
import { findWorkspaceMediaAsset } from "@/lib/media-store";

type RepositoryWriteResult<T> =
  | { data: T; persisted: true }
  | { persisted: false; reason: string };

type SellerListingRow = {
  address: string;
  areaSqm: number | string;
  availableFrom: string | Date | null;
  availableFromText: string | null;
  availabilityNote: string | null;
  canonicalPayload: Record<string, unknown> | null;
  city: string | null;
  channelPriceVisibility: Record<string, unknown> | null;
  contactEmail: string | null;
  contactName: string | null;
  contactPhone: string | null;
  contactUserId: string | null;
  costsSummary: Record<string, unknown> | null;
  createdAt: string | Date;
  documentStatus: string | null;
  documentSummary: Record<string, unknown> | null;
  energyClass: string | null;
  energyValidUntil: string | Date | null;
  expectedGrossYield: number | string | null;
  externalPortalId: string | null;
  federalState: string | null;
  gdprStatus: string | null;
  id: string;
  internalReference: string | null;
  internalNotes: string | null;
  mandateId: string | null;
  mandateEndsAt: string | Date | null;
  marketValueCents: number | string;
  marketingType: string | null;
  mediaSummary: Record<string, unknown> | null;
  monthlyCostsGrossCents: number | string | null;
  objectType: SellerListing["objectType"];
  objectNumber: string | null;
  openimmoObjectId: string | null;
  ownerContactId: string | null;
  ownerUserId: string | null;
  portalMappingStatus: string | null;
  postalCode: string | null;
  priceVisibility: string | null;
  projectId: string | null;
  propertyStatus: string | null;
  publicPriceCents: number | string | null;
  purchaseAncillaryCostsCents: number | string | null;
  region: SellerListing["region"];
  rentNetCents: number | string | null;
  rentPriceCents: number | string | null;
  rooms: number | string | null;
  sellerLeadId: string | null;
  street: string | null;
  subObjectType: string | null;
  subObjectTypeCustom: string | null;
  targetPriceCents: number | string;
  textSummary: Record<string, unknown> | null;
  title: string;
  unitId: string | null;
  usageType: string | null;
  workspaceId: string;
  yearBuilt: number | string | null;
};

type IdRow = { id: string };
type ListingProjectRow = { projectId: string | null };
type CountRow = { count: number | string };
type ProjectScopedEntityRow = { id: string; projectId: string | null };
type LeadScopedEntityRow = ProjectScopedEntityRow & { contactId: string | null };
type FormScopedEntityRow = ProjectScopedEntityRow & { funnelId: string | null };

type ResolvedPropertyInquiryIds = {
  contactId: string | null;
  formId: string | null;
  funnelId: string | null;
  leadId: string | null;
  ownerUserId: string | null;
  projectId: string | null;
  propertyId: string | null;
  unitId: string | null;
};

class PropertyInquiryValidationError extends Error {}

const allowedRegions = new Set([
  "Wien",
  "Steiermark",
  "Tirol",
  "Salzburg",
  "Oberoesterreich",
  "Niederoesterreich",
  "Kaernten",
  "Burgenland",
  "Vorarlberg",
]);

const sellerListingReturningSql = `
  id,
  workspace_id as "workspaceId",
  project_id as "projectId",
  seller_lead_id as "sellerLeadId",
  title,
  address,
  region,
  object_type as "objectType",
  area_sqm as "areaSqm",
  rooms,
  year_built as "yearBuilt",
  market_value_cents as "marketValueCents",
  target_price_cents as "targetPriceCents",
  expected_gross_yield as "expectedGrossYield",
  mandate_ends_at as "mandateEndsAt",
  created_at as "createdAt",
  object_number as "objectNumber",
  internal_reference as "internalReference",
  external_portal_id as "externalPortalId",
  openimmo_object_id as "openimmoObjectId",
  unit_id as "unitId",
  mandate_id as "mandateId",
  owner_contact_id as "ownerContactId",
  owner_user_id as "ownerUserId",
  contact_user_id as "contactUserId",
  contact_name as "contactName",
  contact_phone as "contactPhone",
  contact_email as "contactEmail",
  marketing_type as "marketingType",
  usage_type as "usageType",
  sub_object_type as "subObjectType",
  sub_object_type_custom as "subObjectTypeCustom",
  available_from as "availableFrom",
  available_from_text as "availableFromText",
  availability_note as "availabilityNote",
  price_visibility as "priceVisibility",
  channel_price_visibility as "channelPriceVisibility",
  public_price_cents as "publicPriceCents",
  rent_price_cents as "rentPriceCents",
  rent_net_cents as "rentNetCents",
  monthly_costs_gross_cents as "monthlyCostsGrossCents",
  purchase_ancillary_costs_cents as "purchaseAncillaryCostsCents",
  costs_summary as "costsSummary",
  gdpr_status as "gdprStatus",
  portal_mapping_status as "portalMappingStatus",
  media_summary as "mediaSummary",
  document_summary as "documentSummary",
  text_summary as "textSummary",
  postal_code as "postalCode",
  city,
  federal_state as "federalState",
  street,
  property_status as "propertyStatus",
  document_status as "documentStatus",
  energy_certificate_valid_until as "energyValidUntil",
  hwb_class as "energyClass",
  internal_notes as "internalNotes",
  canonical_payload as "canonicalPayload"
`;

export async function createSellerListingRecord(input: {
  property: Record<string, unknown>;
  session: AppSession;
}): Promise<RepositoryWriteResult<SellerListing>> {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return { persisted: false, reason: "Database persistence is not configured" };
  }

  const fields = asPlainObject(input.property.fieldValues);
  const title = cleanString(input.property.title);
  const city = cleanString(input.property.city) || cleanString(fields["location.ort"]);
  const postalCode = cleanString(input.property.postalCode) || cleanString(fields["location.plz"]);
  const street = cleanString(input.property.street) || cleanString(fields["location.strasse"]);
  const houseNumber = cleanString(fields["location.hausnummer"]);
  const address = cleanString(input.property.address) || [street, houseNumber, postalCode, city].filter(Boolean).join(" ");
  const federalState = cleanString(input.property.region) || cleanString(fields["location.bundesland"]);
  const region = normalizeRegion(federalState);
  const objectType = cleanString(input.property.objectType) || cleanString(fields["classification.objektart"]) || "Wohnung";
  const areaSqm = toNumber(
    input.property.areaSqm ??
      fields["areas.wohnflaeche"] ??
      fields["areas.nutzflaeche"] ??
      fields["areas.gesamtflaeche"],
    0,
  );
  const priceCents = toPriceCents(input.property.price ?? fields["costs.kaufpreis"]);
  const projectId = nullableUuid(input.property.projectId);
  const sellerLeadId = nullableUuid(input.property.sellerLeadId);
  const unitId = nullableUuid(input.property.unitId);
  const mandateId = nullableUuid(input.property.mandateId);
  const ownerContactId = nullableUuid(input.property.ownerContactId);
  const ownerUserId = nullableUuid(input.property.ownerUserId);
  const contactUserId = nullableUuid(input.property.contactUserId);
  const rooms = optionalNumber(input.property.rooms ?? fields["rooms.zimmer"]);
  const yearBuilt = optionalInteger(input.property.yearBuilt ?? fields["construction.baujahr"]);
  const expectedGrossYield = optionalNumber(input.property.expectedGrossYield ?? fields["investment.rendite"]);
  const internalNotes = cleanString(input.property.internalNotes) || cleanString(fields["notes.interne_notizen"]);
  const objectNumber = cleanString(input.property.objectNumber);
  const internalReference = cleanString(input.property.internalReference);
  const externalPortalId = cleanString(input.property.externalPortalId);
  const openimmoObjectId = cleanString(input.property.openimmoObjectId);
  const contactName = cleanString(input.property.contactName);
  const contactPhone = cleanString(input.property.contactPhone);
  const contactEmail = cleanString(input.property.contactEmail);
  const marketingType = cleanString(input.property.marketingType) || "sale";
  const usageType = cleanString(input.property.usageType);
  const subObjectType = cleanString(input.property.subObjectType) || cleanString(fields["classification.unterobjektart"]);
  const subObjectTypeCustom = cleanString(input.property.subObjectTypeCustom);
  const availableFrom = dateOnly(input.property.availableFrom ?? fields["construction.beziehbar_ab"]);
  const availableFromText = cleanString(input.property.availableFromText);
  const availabilityNote = cleanString(input.property.availabilityNote);
  const priceVisibility = normalizePriceVisibility(input.property.priceVisibility);
  const channelPriceVisibility = normalizePriceVisibilityMap(asPlainObject(input.property.channelPriceVisibility));
  const publicPriceCents = toNullablePriceCents(input.property.publicPrice ?? input.property.price ?? fields["costs.kaufpreis"]);
  const rentPriceCents = toNullablePriceCents(input.property.rentPrice ?? fields["costs.mietpreis_brutto"]);
  const rentNetCents = toNullablePriceCents(input.property.rentNet);
  const monthlyCostsGrossCents = toNullablePriceCents(input.property.monthlyCostsGross);
  const purchaseAncillaryCostsCents = toNullablePriceCents(input.property.purchaseAncillaryCosts);
  const gdprStatus = cleanString(input.property.gdprStatus) || "needs_review";
  const portalMappingStatus = cleanString(input.property.portalMappingStatus) || "needs_review";
  const canonicalPayload = {
    source: "property_department",
    submittedByUserId: input.session.userId,
    base: {
      address,
      areaSqm,
      city,
      federalState,
      objectType,
      postalCode,
      priceCents,
      priceVisibility,
      projectId,
      rooms,
      street,
      title,
      yearBuilt,
    },
    channelPriceVisibility,
    fieldValues: fields,
  };

  if (!title || !address) {
    return { persisted: false, reason: "Title and address are required" };
  }

  const row = await queryOne<SellerListingRow>(
    `
      insert into seller_listings (
        workspace_id,
        project_id,
        seller_lead_id,
        unit_id,
        mandate_id,
        owner_contact_id,
        owner_user_id,
        contact_user_id,
        title,
        address,
        region,
        object_type,
        area_sqm,
        rooms,
        year_built,
        market_value_cents,
        target_price_cents,
        expected_gross_yield,
        postal_code,
        city,
        federal_state,
        street,
        object_number,
        internal_reference,
        external_portal_id,
        openimmo_object_id,
        contact_name,
        contact_phone,
        contact_email,
        marketing_type,
        usage_type,
        sub_object_type,
        sub_object_type_custom,
        available_from,
        available_from_text,
        availability_note,
        price_visibility,
        channel_price_visibility,
        public_price_cents,
        rent_price_cents,
        rent_net_cents,
        monthly_costs_gross_cents,
        purchase_ancillary_costs_cents,
        costs_summary,
        gdpr_status,
        portal_mapping_status,
        property_status,
        document_status,
        internal_notes,
        canonical_payload,
        seller_data,
        equipment,
        expose_content,
        confirmation_audit,
        channel_summary
      )
      values (
        $1,
        $2::uuid,
        $3::uuid,
        $4::uuid,
        $5::uuid,
        $6::uuid,
        $7::uuid,
        $8::uuid,
        $9,
        $10,
        $11,
        $12,
        $13::numeric,
        $14::numeric,
        $15::integer,
        $16::bigint,
        $17::bigint,
        $18::numeric,
        nullif($19, ''),
        nullif($20, ''),
        nullif($21, ''),
        nullif($22, ''),
        nullif($23, ''),
        nullif($24, ''),
        nullif($25, ''),
        nullif($26, ''),
        nullif($27, ''),
        nullif($28, ''),
        nullif($29, ''),
        nullif($30, ''),
        nullif($31, ''),
        nullif($32, ''),
        nullif($33, ''),
        $34::date,
        nullif($35, ''),
        nullif($36, ''),
        $37,
        $38::jsonb,
        $39::bigint,
        $40::bigint,
        $41::bigint,
        $42::bigint,
        $43::bigint,
        $44::jsonb,
        $45,
        $46,
        'draft',
        'draft',
        nullif($47, ''),
        $48::jsonb,
        $49::jsonb,
        $50::jsonb,
        $51::jsonb,
        $52::jsonb,
        $53::jsonb
      )
      returning ${sellerListingReturningSql}
    `,
    [
      input.session.workspaceId,
      projectId,
      sellerLeadId,
      unitId,
      mandateId,
      ownerContactId,
      ownerUserId,
      contactUserId,
      title,
      address,
      region,
      objectType,
      areaSqm,
      rooms,
      yearBuilt,
      priceCents,
      priceCents,
      expectedGrossYield,
      postalCode,
      city,
      federalState,
      street,
      objectNumber,
      internalReference,
      externalPortalId,
      openimmoObjectId,
      contactName,
      contactPhone,
      contactEmail,
      marketingType,
      usageType,
      subObjectType,
      subObjectTypeCustom,
      availableFrom,
      availableFromText,
      availabilityNote,
      priceVisibility,
      JSON.stringify(channelPriceVisibility),
      publicPriceCents,
      rentPriceCents,
      rentNetCents,
      monthlyCostsGrossCents,
      purchaseAncillaryCostsCents,
      JSON.stringify(buildCostsSummary(input.property)),
      gdprStatus,
      portalMappingStatus,
      internalNotes,
      JSON.stringify(canonicalPayload),
      JSON.stringify(extractSection(fields, "seller")),
      JSON.stringify(extractSection(fields, "equipment")),
      JSON.stringify(extractExposeContent(fields)),
      JSON.stringify({ createdByUserId: input.session.userId, createdAt: new Date().toISOString() }),
      JSON.stringify({ channels: [], lastPreflightAt: null }),
    ],
  );

  if (!row) return { persisted: false, reason: "Property could not be saved" };

  const listingRow = await ensureDefaultUnitForListing(row, input.session);
  const listing = toSellerListing(listingRow);
  await savePropertyFragments({
    property: input.property,
    projectId: listing.projectId,
    propertyId: listing.id,
    session: input.session,
  });
  await writeAuditLog({
    action: "property.created",
    after: listing,
    entityId: listing.id,
    entityType: "seller_listing",
    projectId: listing.projectId,
    session: input.session,
  });
  await writePropertyActivityEvent({
    detail: address,
    eventType: "property.created",
    projectId: listing.projectId,
    propertyId: listing.id,
    session: input.session,
    title: `Objekt angelegt: ${title}`,
  });

  return { data: listing, persisted: true };
}

export async function updateSellerListingRecord(input: {
  property: Record<string, unknown>;
  propertyId: unknown;
  session: AppSession;
}): Promise<RepositoryWriteResult<SellerListing>> {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return { persisted: false, reason: "Database persistence is not configured" };
  }

  const propertyId = normalizeEntityId(input.propertyId);
  if (!propertyId) return { persisted: false, reason: "Invalid property id" };

  const fields = asPlainObject(input.property.fieldValues);
  const title = cleanString(input.property.title);
  const city = cleanString(input.property.city) || cleanString(fields["location.ort"]);
  const postalCode = cleanString(input.property.postalCode) || cleanString(fields["location.plz"]);
  const street = cleanString(input.property.street) || cleanString(fields["location.strasse"]);
  const houseNumber = cleanString(fields["location.hausnummer"]);
  const address = cleanString(input.property.address) || [street, houseNumber, postalCode, city].filter(Boolean).join(" ");
  const federalState = cleanString(input.property.region) || cleanString(fields["location.bundesland"]);
  const areaSqm = optionalNumber(input.property.areaSqm ?? fields["areas.wohnflaeche"]);
  const priceCents = toNullablePriceCents(input.property.price ?? fields["costs.kaufpreis"]);
  const channelPriceVisibility = normalizePriceVisibilityMap(asPlainObject(input.property.channelPriceVisibility));
  const row = await queryOne<SellerListingRow>(
    `
      update seller_listings
      set
        project_id = coalesce($3::uuid, project_id),
        seller_lead_id = coalesce($4::uuid, seller_lead_id),
        unit_id = coalesce($5::uuid, unit_id),
        mandate_id = coalesce($6::uuid, mandate_id),
        owner_contact_id = coalesce($7::uuid, owner_contact_id),
        owner_user_id = coalesce($8::uuid, owner_user_id),
        contact_user_id = coalesce($9::uuid, contact_user_id),
        title = coalesce(nullif($10, ''), title),
        address = coalesce(nullif($11, ''), address),
        region = coalesce(nullif($12, ''), region),
        object_type = coalesce(nullif($13, ''), object_type),
        area_sqm = coalesce($14::numeric, area_sqm),
        rooms = coalesce($15::numeric, rooms),
        year_built = coalesce($16::integer, year_built),
        market_value_cents = coalesce($17::bigint, market_value_cents),
        target_price_cents = coalesce($18::bigint, target_price_cents),
        expected_gross_yield = coalesce($19::numeric, expected_gross_yield),
        postal_code = coalesce(nullif($20, ''), postal_code),
        city = coalesce(nullif($21, ''), city),
        federal_state = coalesce(nullif($22, ''), federal_state),
        street = coalesce(nullif($23, ''), street),
        object_number = coalesce(nullif($24, ''), object_number),
        internal_reference = coalesce(nullif($25, ''), internal_reference),
        external_portal_id = coalesce(nullif($26, ''), external_portal_id),
        openimmo_object_id = coalesce(nullif($27, ''), openimmo_object_id),
        contact_name = coalesce(nullif($28, ''), contact_name),
        contact_phone = coalesce(nullif($29, ''), contact_phone),
        contact_email = coalesce(nullif($30, ''), contact_email),
        marketing_type = coalesce(nullif($31, ''), marketing_type),
        usage_type = coalesce(nullif($32, ''), usage_type),
        sub_object_type = coalesce(nullif($33, ''), sub_object_type),
        sub_object_type_custom = coalesce(nullif($34, ''), sub_object_type_custom),
        available_from = coalesce($35::date, available_from),
        available_from_text = coalesce(nullif($36, ''), available_from_text),
        availability_note = coalesce(nullif($37, ''), availability_note),
        price_visibility = $38,
        channel_price_visibility = $39::jsonb,
        public_price_cents = coalesce($40::bigint, public_price_cents),
        rent_price_cents = coalesce($41::bigint, rent_price_cents),
        rent_net_cents = coalesce($42::bigint, rent_net_cents),
        monthly_costs_gross_cents = coalesce($43::bigint, monthly_costs_gross_cents),
        purchase_ancillary_costs_cents = coalesce($44::bigint, purchase_ancillary_costs_cents),
        costs_summary = costs_summary || $45::jsonb,
        gdpr_status = coalesce(nullif($46, ''), gdpr_status),
        portal_mapping_status = coalesce(nullif($47, ''), portal_mapping_status),
        internal_notes = coalesce(nullif($48, ''), internal_notes),
        canonical_payload = canonical_payload || $49::jsonb,
        updated_at = now()
      where id = $1::uuid
        and workspace_id = $2
      returning ${sellerListingReturningSql}
    `,
    [
      propertyId,
      input.session.workspaceId,
      nullableUuid(input.property.projectId),
      nullableUuid(input.property.sellerLeadId),
      nullableUuid(input.property.unitId),
      nullableUuid(input.property.mandateId),
      nullableUuid(input.property.ownerContactId),
      nullableUuid(input.property.ownerUserId),
      nullableUuid(input.property.contactUserId),
      title,
      address,
      federalState ? normalizeRegion(federalState) : "",
      cleanString(input.property.objectType) || cleanString(fields["classification.objektart"]),
      areaSqm,
      optionalNumber(input.property.rooms ?? fields["rooms.zimmer"]),
      optionalInteger(input.property.yearBuilt ?? fields["construction.baujahr"]),
      priceCents,
      priceCents,
      optionalNumber(input.property.expectedGrossYield ?? fields["investment.rendite"]),
      postalCode,
      city,
      federalState,
      street,
      cleanString(input.property.objectNumber),
      cleanString(input.property.internalReference),
      cleanString(input.property.externalPortalId),
      cleanString(input.property.openimmoObjectId),
      cleanString(input.property.contactName),
      cleanString(input.property.contactPhone),
      cleanString(input.property.contactEmail),
      cleanString(input.property.marketingType),
      cleanString(input.property.usageType),
      cleanString(input.property.subObjectType) || cleanString(fields["classification.unterobjektart"]),
      cleanString(input.property.subObjectTypeCustom),
      dateOnly(input.property.availableFrom ?? fields["construction.beziehbar_ab"]),
      cleanString(input.property.availableFromText),
      cleanString(input.property.availabilityNote),
      normalizePriceVisibility(input.property.priceVisibility),
      JSON.stringify(channelPriceVisibility),
      toNullablePriceCents(input.property.publicPrice ?? input.property.price ?? fields["costs.kaufpreis"]),
      toNullablePriceCents(input.property.rentPrice ?? fields["costs.mietpreis_brutto"]),
      toNullablePriceCents(input.property.rentNet),
      toNullablePriceCents(input.property.monthlyCostsGross),
      toNullablePriceCents(input.property.purchaseAncillaryCosts),
      JSON.stringify(buildCostsSummary(input.property)),
      cleanString(input.property.gdprStatus),
      cleanString(input.property.portalMappingStatus),
      cleanString(input.property.internalNotes) || cleanString(fields["notes.interne_notizen"]),
      JSON.stringify({
        fieldValues: fields,
        updatedByUserId: input.session.userId,
        updatedFrom: "property_department",
      }),
    ],
  );

  if (!row) return { persisted: false, reason: "Property not found" };

  const listingRow = await ensureDefaultUnitForListing(row, input.session);
  const listing = toSellerListing(listingRow);
  await savePropertyFragments({
    property: input.property,
    projectId: listing.projectId,
    propertyId: listing.id,
    session: input.session,
  });
  await writeAuditLog({
    action: "property.updated",
    after: listing,
    entityId: listing.id,
    entityType: "seller_listing",
    projectId: listing.projectId,
    session: input.session,
  });

  return { data: listing, persisted: true };
}

export async function savePropertyTextBlocks(input: {
  projectId?: unknown;
  propertyId: unknown;
  session: AppSession;
  textBlocks: unknown;
}): Promise<RepositoryWriteResult<{ count: number }>> {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return { persisted: false, reason: "Database persistence is not configured" };
  }

  const propertyId = normalizeEntityId(input.propertyId);
  if (!propertyId) return { persisted: false, reason: "Invalid property id" };

  const projectId = nullableUuid(input.projectId) ?? (await findPropertyProjectId(propertyId, input.session));
  const textBlocks = asObjectArray(input.textBlocks);
  await executeQuery("delete from property_text_blocks where workspace_id = $1 and property_id = $2::uuid", [
    input.session.workspaceId,
    propertyId,
  ]);

  let count = 0;
  for (const [index, block] of textBlocks.entries()) {
    const textKey = cleanString(block.textKey) || cleanString(block.key);
    const content = cleanString(block.content);
    const title = cleanString(block.title);
    if (!textKey || (!content && !title)) continue;

    await queryOne<IdRow>(
      `
        insert into property_text_blocks (
          workspace_id,
          project_id,
          property_id,
          text_key,
          channel,
          title,
          content,
          seo_title,
          seo_description,
          visibility,
          status,
          position,
          metadata
        )
        values ($1, $2::uuid, $3::uuid, $4, $5, $6, $7, nullif($8, ''), nullif($9, ''), $10, $11, $12, $13::jsonb)
        returning id
      `,
      [
        input.session.workspaceId,
        projectId,
        propertyId,
        textKey,
        cleanString(block.channel) || "all",
        title,
        content,
        cleanString(block.seoTitle),
        cleanString(block.seoDescription),
        cleanString(block.visibility) || "public",
        cleanString(block.status) || "draft",
        index,
        JSON.stringify(asPlainObject(block.metadata)),
      ],
    );
    count += 1;
  }

  await writePropertyActivityEvent({
    detail: `${count} Textbloecke gespeichert`,
    eventType: "property.text_blocks.saved",
    projectId,
    propertyId,
    session: input.session,
    title: "Objekttexte gespeichert",
  });

  return { data: { count }, persisted: true };
}

export async function savePropertyCostItems(input: {
  costItems: unknown;
  projectId?: unknown;
  propertyId: unknown;
  session: AppSession;
}): Promise<RepositoryWriteResult<{ count: number }>> {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return { persisted: false, reason: "Database persistence is not configured" };
  }

  const propertyId = normalizeEntityId(input.propertyId);
  if (!propertyId) return { persisted: false, reason: "Invalid property id" };

  const projectId = nullableUuid(input.projectId) ?? (await findPropertyProjectId(propertyId, input.session));
  const costItems = asObjectArray(input.costItems);
  await executeQuery("delete from property_cost_items where workspace_id = $1 and property_id = $2::uuid", [
    input.session.workspaceId,
    propertyId,
  ]);

  let count = 0;
  for (const [index, item] of costItems.entries()) {
    const costKey = cleanString(item.costKey) || cleanString(item.key);
    const label = cleanString(item.label);
    if (!costKey || !label) continue;

    await queryOne<IdRow>(
      `
        insert into property_cost_items (
          workspace_id,
          project_id,
          property_id,
          cost_key,
          group_key,
          label,
          monthly_net_cents,
          monthly_vat_cents,
          monthly_gross_cents,
          one_time_net_cents,
          one_time_vat_cents,
          one_time_gross_cents,
          vat_percent,
          optional,
          commission_relevant,
          expose_visible,
          internal_note,
          position,
          metadata
        )
        values (
          $1,
          $2::uuid,
          $3::uuid,
          $4,
          $5,
          $6,
          $7::bigint,
          $8::bigint,
          $9::bigint,
          $10::bigint,
          $11::bigint,
          $12::bigint,
          $13::numeric,
          $14,
          $15,
          $16,
          nullif($17, ''),
          $18,
          $19::jsonb
        )
        returning id
      `,
      [
        input.session.workspaceId,
        projectId,
        propertyId,
        costKey,
        cleanString(item.groupKey) || "monthly",
        label,
        toCostCents(item.monthlyNet, item.monthlyNetCents),
        toCostCents(item.monthlyVat, item.monthlyVatCents),
        toCostCents(item.monthlyGross, item.monthlyGrossCents),
        toCostCents(item.oneTimeNet, item.oneTimeNetCents),
        toCostCents(item.oneTimeVat, item.oneTimeVatCents),
        toCostCents(item.oneTimeGross, item.oneTimeGrossCents),
        optionalNumber(item.vatPercent),
        Boolean(item.optional),
        Boolean(item.commissionRelevant),
        item.exposeVisible !== false,
        cleanString(item.internalNote),
        index,
        JSON.stringify(asPlainObject(item.metadata)),
      ],
    );
    count += 1;
  }

  await writePropertyActivityEvent({
    detail: `${count} Kostenpositionen gespeichert`,
    eventType: "property.cost_items.saved",
    projectId,
    propertyId,
    session: input.session,
    title: "Kostenmatrix gespeichert",
  });

  return { data: { count }, persisted: true };
}

export async function attachPropertyMedia(input: {
  media: Record<string, unknown>;
  projectId?: unknown;
  propertyId: unknown;
  session: AppSession;
}): Promise<RepositoryWriteResult<{ id: string }>> {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return { persisted: false, reason: "Database persistence is not configured" };
  }

  const propertyId = normalizeEntityId(input.propertyId);
  const mediaAssetId = nullableUuid(input.media.mediaAssetId);
  if (!propertyId || !mediaAssetId) return { persisted: false, reason: "Property and media asset are required" };

  const asset = await findWorkspaceMediaAsset(mediaAssetId, input.session.workspaceId);
  if (!asset) return { persisted: false, reason: "Media asset not found" };

  const projectId = nullableUuid(input.projectId) ?? (await findPropertyProjectId(propertyId, input.session));
  const mediaType = cleanString(input.media.mediaType) ||
    (asset.mimeType.startsWith("image/") ? "image" : "document");
  const isCover = Boolean(input.media.isCover);
  if (isCover) {
    await executeQuery(
      "update property_media set is_cover = false where workspace_id = $1 and property_id = $2::uuid",
      [input.session.workspaceId, propertyId],
    );
  }

  const row = await queryOne<IdRow>(
    `
      insert into property_media (
        workspace_id,
        project_id,
        property_id,
        media_asset_id,
        media_type,
        title,
        alt_text,
        category,
        visibility,
        is_cover,
        position,
        status,
        metadata
      )
      values ($1, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
      returning id
    `,
    [
      input.session.workspaceId,
      projectId,
      propertyId,
      mediaAssetId,
      mediaType,
      cleanString(input.media.title) || asset.name,
      cleanString(input.media.altText) || asset.alt || asset.name,
      cleanString(input.media.category) || (isCover ? "cover" : "gallery"),
      cleanString(input.media.visibility) || "public",
      isCover,
      optionalInteger(input.media.position) ?? 0,
      cleanString(input.media.status) || "draft",
      JSON.stringify(asPlainObject(input.media.metadata)),
    ],
  );

  if (!row) return { persisted: false, reason: "Media could not be attached" };

  await writePropertyActivityEvent({
    detail: asset.name,
    eventType: "property.media.attached",
    projectId,
    propertyId,
    session: input.session,
    title: "Bild/Medium zugeordnet",
  });

  return { data: { id: row.id }, persisted: true };
}

export async function attachPropertyDocument(input: {
  document: Record<string, unknown>;
  projectId?: unknown;
  propertyId: unknown;
  session: AppSession;
}): Promise<RepositoryWriteResult<{ id: string }>> {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return { persisted: false, reason: "Database persistence is not configured" };
  }

  const propertyId = normalizeEntityId(input.propertyId);
  const mediaAssetId = nullableUuid(input.document.mediaAssetId);
  if (!propertyId || !mediaAssetId) return { persisted: false, reason: "Property and document asset are required" };

  const asset = await findWorkspaceMediaAsset(mediaAssetId, input.session.workspaceId);
  if (!asset) return { persisted: false, reason: "Document asset not found" };

  const projectId = nullableUuid(input.projectId) ?? (await findPropertyProjectId(propertyId, input.session));
  const row = await queryOne<IdRow>(
    `
      insert into property_documents (
        workspace_id,
        project_id,
        property_id,
        media_asset_id,
        title,
        category,
        status,
        visibility,
        required_for_publication,
        document_date,
        version_label,
        content,
        metadata
      )
      values ($1, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10::date, nullif($11, ''), $12::jsonb, $13::jsonb)
      returning id
    `,
    [
      input.session.workspaceId,
      projectId,
      propertyId,
      mediaAssetId,
      cleanString(input.document.title) || asset.name,
      cleanString(input.document.category) || "document",
      cleanString(input.document.status) || "draft",
      cleanString(input.document.visibility) || "private",
      Boolean(input.document.requiredForPublication),
      dateOnly(input.document.documentDate),
      cleanString(input.document.versionLabel),
      JSON.stringify(asPlainObject(input.document.content)),
      JSON.stringify(asPlainObject(input.document.metadata)),
    ],
  );

  if (!row) return { persisted: false, reason: "Document could not be attached" };

  await writePropertyActivityEvent({
    detail: asset.name,
    eventType: "property.document.attached",
    projectId,
    propertyId,
    session: input.session,
    title: "Dokument zugeordnet",
  });

  return { data: { id: row.id }, persisted: true };
}

export async function updatePropertyMediaOrder(input: {
  mediaItems: unknown;
  propertyId: unknown;
  session: AppSession;
}): Promise<RepositoryWriteResult<{ count: number }>> {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return { persisted: false, reason: "Database persistence is not configured" };
  }

  const propertyId = normalizeEntityId(input.propertyId);
  if (!propertyId) return { persisted: false, reason: "Invalid property id" };

  let count = 0;
  for (const [index, item] of asObjectArray(input.mediaItems).entries()) {
    const mediaId = nullableUuid(item.id);
    if (!mediaId) continue;
    const isCover = Boolean(item.isCover);
    if (isCover) {
      await executeQuery(
        "update property_media set is_cover = false where workspace_id = $1 and property_id = $2::uuid and id <> $3::uuid",
        [input.session.workspaceId, propertyId, mediaId],
      );
    }
    const row = await queryOne<IdRow>(
      `
        update property_media
        set
          position = $4,
          category = coalesce(nullif($5, ''), category),
          visibility = coalesce(nullif($6, ''), visibility),
          is_cover = $7,
          title = coalesce(nullif($8, ''), title),
          alt_text = coalesce(nullif($9, ''), alt_text),
          status = coalesce(nullif($10, ''), status),
          updated_at = now()
        where id = $1::uuid
          and property_id = $2::uuid
          and workspace_id = $3
        returning id
      `,
      [
        mediaId,
        propertyId,
        input.session.workspaceId,
        optionalInteger(item.position) ?? index,
        cleanString(item.category),
        cleanString(item.visibility),
        isCover,
        cleanString(item.title),
        cleanString(item.altText),
        cleanString(item.status),
      ],
    );
    if (row) count += 1;
  }

  return { data: { count }, persisted: true };
}

export async function updatePropertyPriceVisibility(input: {
  channelPriceVisibility?: unknown;
  priceVisibility?: unknown;
  projectId?: unknown;
  propertyId: unknown;
  publicPrice?: unknown;
  session: AppSession;
}): Promise<RepositoryWriteResult<{ id: string }>> {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return { persisted: false, reason: "Database persistence is not configured" };
  }

  const propertyId = normalizeEntityId(input.propertyId);
  if (!propertyId) return { persisted: false, reason: "Invalid property id" };

  const projectId = nullableUuid(input.projectId) ?? (await findPropertyProjectId(propertyId, input.session));
  const channelPriceVisibility = normalizePriceVisibilityMap(asPlainObject(input.channelPriceVisibility));
  const priceVisibility = normalizePriceVisibility(input.priceVisibility);
  const row = await queryOne<IdRow>(
    `
      update seller_listings
      set
        price_visibility = $3,
        channel_price_visibility = $4::jsonb,
        public_price_cents = coalesce($5::bigint, public_price_cents),
        updated_at = now()
      where id = $1::uuid
        and workspace_id = $2
      returning id
    `,
    [
      propertyId,
      input.session.workspaceId,
      priceVisibility,
      JSON.stringify(channelPriceVisibility),
      toNullablePriceCents(input.publicPrice),
    ],
  );

  if (!row) return { persisted: false, reason: "Property not found" };

  await persistChannelPriceOverrides({
    channelPriceVisibility,
    projectId,
    propertyId,
    session: input.session,
  });

  return { data: { id: row.id }, persisted: true };
}

function strictOptionalInquiryId(value: unknown, label: string, allowListingPrefix = false) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new PropertyInquiryValidationError(`Invalid or unavailable ${label} id`);
  }
  const candidate = value.trim();
  const normalized = allowListingPrefix ? candidate.replace(/^listing:/, "") : candidate;
  if (!isUuid(normalized)) {
    throw new PropertyInquiryValidationError(`Invalid or unavailable ${label} id`);
  }
  return normalized;
}

function resolveRequestedInquiryId(input: {
  allowListingPrefix?: boolean;
  inquiryValue: unknown;
  label: string;
  routeValue: unknown;
}) {
  const inquiryId = strictOptionalInquiryId(input.inquiryValue, input.label, input.allowListingPrefix);
  const routeId = strictOptionalInquiryId(input.routeValue, input.label, input.allowListingPrefix);
  if (inquiryId && routeId && inquiryId !== routeId) {
    throw new PropertyInquiryValidationError(`Invalid or inconsistent ${input.label} relationship`);
  }
  return routeId ?? inquiryId;
}

async function requireTenantEntity<Row extends IdRow>(input: {
  id: string | null;
  label: string;
  params: readonly unknown[];
  query: string;
  transaction: TenantTransaction;
}) {
  if (!input.id) return null;
  const row = await input.transaction.queryOne<Row>(input.query, input.params);
  if (!row) {
    throw new PropertyInquiryValidationError(`Invalid or unavailable ${input.label} id`);
  }
  return row;
}

async function resolvePropertyInquiryIds(input: {
  inquiry: PropertyInquiryRouteInput;
  route: PropertyInquiryRouteResult;
  transaction: TenantTransaction;
  workspaceId: string;
}): Promise<ResolvedPropertyInquiryIds> {
  const requested = {
    contactId: resolveRequestedInquiryId({
      inquiryValue: input.inquiry.contactId,
      label: "contact",
      routeValue: input.route.contactId,
    }),
    formId: resolveRequestedInquiryId({
      inquiryValue: input.inquiry.formId,
      label: "form",
      routeValue: input.route.formId,
    }),
    funnelId: resolveRequestedInquiryId({
      inquiryValue: input.inquiry.funnelId,
      label: "funnel",
      routeValue: input.route.funnelId,
    }),
    leadId: resolveRequestedInquiryId({
      inquiryValue: input.inquiry.leadId,
      label: "lead",
      routeValue: input.route.leadId,
    }),
    ownerUserId: resolveRequestedInquiryId({
      inquiryValue: input.inquiry.ownerUserId,
      label: "owner",
      routeValue: input.route.ownerUserId,
    }),
    projectId: resolveRequestedInquiryId({
      inquiryValue: input.inquiry.projectId,
      label: "project",
      routeValue: input.route.projectId,
    }),
    propertyId: resolveRequestedInquiryId({
      allowListingPrefix: true,
      inquiryValue: input.inquiry.propertyId,
      label: "property",
      routeValue: input.route.propertyId,
    }),
    unitId: resolveRequestedInquiryId({
      inquiryValue: input.inquiry.unitId,
      label: "unit",
      routeValue: input.route.unitId,
    }),
  };

  const project = await requireTenantEntity<IdRow>({
    id: requested.projectId,
    label: "project",
    params: [input.workspaceId, requested.projectId],
    query: `
      select id
      from projects
      where workspace_id = $1::uuid
        and id = $2::uuid
      limit 1
    `,
    transaction: input.transaction,
  });
  const property = await requireTenantEntity<ProjectScopedEntityRow>({
    id: requested.propertyId,
    label: "property",
    params: [input.workspaceId, requested.propertyId],
    query: `
      select id, project_id as "projectId"
      from seller_listings
      where workspace_id = $1::uuid
        and id = $2::uuid
      limit 1
    `,
    transaction: input.transaction,
  });
  const unit = await requireTenantEntity<ProjectScopedEntityRow>({
    id: requested.unitId,
    label: "unit",
    params: [input.workspaceId, requested.unitId],
    query: `
      select id, project_id as "projectId"
      from property_units
      where workspace_id = $1::uuid
        and id = $2::uuid
      limit 1
    `,
    transaction: input.transaction,
  });
  const contact = await requireTenantEntity<ProjectScopedEntityRow>({
    id: requested.contactId,
    label: "contact",
    params: [input.workspaceId, requested.contactId],
    query: `
      select id, project_id as "projectId"
      from contacts
      where workspace_id = $1::uuid
        and id = $2::uuid
      limit 1
    `,
    transaction: input.transaction,
  });
  const lead = await requireTenantEntity<LeadScopedEntityRow>({
    id: requested.leadId,
    label: "lead",
    params: [input.workspaceId, requested.leadId],
    query: `
      select id, project_id as "projectId", contact_id as "contactId"
      from leads
      where workspace_id = $1::uuid
        and id = $2::uuid
      limit 1
    `,
    transaction: input.transaction,
  });
  const owner = await requireTenantEntity<IdRow>({
    id: requested.ownerUserId,
    label: "owner",
    params: [input.workspaceId, requested.ownerUserId],
    query: `
      select id
      from workspace_users
      where workspace_id = $1::uuid
        and id = $2::uuid
        and status = 'active'
      limit 1
    `,
    transaction: input.transaction,
  });
  const funnel = await requireTenantEntity<ProjectScopedEntityRow>({
    id: requested.funnelId,
    label: "funnel",
    params: [input.workspaceId, requested.funnelId],
    query: `
      select id, project_id as "projectId"
      from funnels
      where workspace_id = $1::uuid
        and id = $2::uuid
      limit 1
    `,
    transaction: input.transaction,
  });
  const form = await requireTenantEntity<FormScopedEntityRow>({
    id: requested.formId,
    label: "form",
    params: [input.workspaceId, requested.formId],
    query: `
      select id, project_id as "projectId", funnel_id as "funnelId"
      from forms
      where workspace_id = $1::uuid
        and id = $2::uuid
      limit 1
    `,
    transaction: input.transaction,
  });

  if (lead?.contactId && requested.contactId && lead.contactId !== requested.contactId) {
    throw new PropertyInquiryValidationError("Invalid or inconsistent lead contact relationship");
  }
  if (form?.funnelId && requested.funnelId && form.funnelId !== requested.funnelId) {
    throw new PropertyInquiryValidationError("Invalid or inconsistent form funnel relationship");
  }

  const relatedProjectIds = [...new Set([
    requested.projectId,
    property?.projectId,
    unit?.projectId,
    contact?.projectId,
    lead?.projectId,
    funnel?.projectId,
    form?.projectId,
  ].filter((value): value is string => Boolean(value)))];
  if (relatedProjectIds.length > 1) {
    throw new PropertyInquiryValidationError("Invalid or inconsistent inquiry project relationship");
  }
  const projectId = relatedProjectIds[0] ?? null;
  if (projectId && (!project || project.id !== projectId)) {
    await requireTenantEntity<IdRow>({
      id: projectId,
      label: "project",
      params: [input.workspaceId, projectId],
      query: `
        select id
        from projects
        where workspace_id = $1::uuid
          and id = $2::uuid
        limit 1
      `,
      transaction: input.transaction,
    });
  }

  return {
    contactId: contact?.id ?? null,
    formId: form?.id ?? null,
    funnelId: funnel?.id ?? null,
    leadId: lead?.id ?? null,
    ownerUserId: owner?.id ?? null,
    projectId,
    propertyId: property?.id ?? null,
    unitId: unit?.id ?? null,
  };
}

function buildPropertyInquiryMetadata(inquiry: PropertyInquiryRouteInput, warnings: string[]) {
  const safeInquiry: Record<string, string | number> = {};
  for (const field of ["campaign", "contactEmail", "contactPhone", "leadType", "location", "sourceChannel", "useCase"] as const) {
    const value = inquiry[field];
    if (typeof value === "string" && value.trim()) safeInquiry[field] = value.trim().slice(0, 500);
  }
  for (const field of ["areaSqm", "budgetFrom", "budgetTo", "rooms"] as const) {
    const value = inquiry[field];
    if (typeof value === "number" && Number.isFinite(value)) safeInquiry[field] = value;
  }
  return {
    inquiry: safeInquiry,
    warnings: warnings.filter((warning) => typeof warning === "string").map((warning) => warning.slice(0, 500)).slice(0, 20),
  };
}

export async function persistPropertyInquiryRoute(input: {
  inquiry: PropertyInquiryRouteInput;
  route: PropertyInquiryRouteResult;
  session: AppSession;
}): Promise<RepositoryWriteResult<{ id: string; route: PropertyInquiryRouteResult; status: string }>> {
  if (!canPersist() || !isUuid(input.session.workspaceId) || !isUuid(input.session.userId)) {
    return { persisted: false, reason: "Database persistence is not configured" };
  }

  let persisted: { id: string; projectId: string | null; route: PropertyInquiryRouteResult; status: string };
  try {
    persisted = await withTenantTransaction(
      { actorId: input.session.userId, workspaceId: input.session.workspaceId },
      async (transaction) => {
        const ids = await resolvePropertyInquiryIds({
          inquiry: input.inquiry,
          route: input.route,
          transaction,
          workspaceId: input.session.workspaceId,
        });
        const canonicalRoute: PropertyInquiryRouteResult = {
          ...input.route,
          contactId: ids.contactId ?? undefined,
          formId: ids.formId ?? undefined,
          funnelId: ids.funnelId ?? undefined,
          leadId: ids.leadId ?? undefined,
          ownerUserId: ids.ownerUserId ?? undefined,
          projectId: ids.projectId ?? undefined,
          propertyId: ids.propertyId ? `listing:${ids.propertyId}` : undefined,
          unitId: ids.unitId ?? undefined,
          workspaceId: input.session.workspaceId,
        };
        const duplicateKey = cleanString(canonicalRoute.duplicateKey).slice(0, 512);
        if (duplicateKey) {
          await transaction.execute(
            `select pg_advisory_xact_lock(hashtextextended($1::text || ':property_inquiry:' || $2::text, 0))`,
            [input.session.workspaceId, duplicateKey],
          );
        }
        const existing = duplicateKey
          ? await transaction.queryOne<IdRow>(
              `
                select id
                from property_inquiries
                where workspace_id = $1::uuid
                  and duplicate_group_key = $2
                limit 1
              `,
              [input.session.workspaceId, duplicateKey],
            )
          : null;
        const status = existing ? "duplicate" : "routed";
        const row = await transaction.queryOne<IdRow>(
          `
            insert into property_inquiries (
              workspace_id,
              project_id,
              property_id,
              unit_id,
              contact_id,
              lead_id,
              source_channel,
              campaign,
              funnel_id,
              form_id,
              owner_user_id,
              routing_reason,
              confidence_score,
              duplicate_group_key,
              status,
              metadata
            )
            values (
              $1,
              $2::uuid,
              $3::uuid,
              $4::uuid,
              $5::uuid,
              $6::uuid,
              $7,
              nullif($8, ''),
              $9::uuid,
              $10::uuid,
              $11::uuid,
              $12,
              $13::numeric,
              $14,
              $15,
              $16::jsonb
            )
            returning id
          `,
          [
            input.session.workspaceId,
            ids.projectId,
            ids.propertyId,
            ids.unitId,
            ids.contactId,
            ids.leadId,
            cleanString(canonicalRoute.sourceChannel) || "Manual",
            cleanString(canonicalRoute.campaign),
            ids.funnelId,
            ids.formId,
            ids.ownerUserId,
            cleanString(canonicalRoute.routingReason),
            Number.isFinite(canonicalRoute.confidenceScore) ? canonicalRoute.confidenceScore : 0,
            duplicateKey,
            status,
            JSON.stringify(buildPropertyInquiryMetadata(input.inquiry, canonicalRoute.warnings)),
          ],
        );
        if (!row) throw new Error("Inquiry route could not be saved");

        const activityPersisted = await writePropertyActivityEvent({
          contactId: ids.contactId,
          detail: canonicalRoute.routingReason,
          eventType: "property_inquiry.routed",
          leadId: ids.leadId,
          projectId: ids.projectId,
          propertyId: ids.propertyId,
          session: input.session,
          title: status === "duplicate" ? "Anfrage als Duplikat erkannt" : "Anfrage zugeordnet",
          transaction,
          unitId: ids.unitId,
        });
        if (!activityPersisted) throw new Error("Inquiry activity could not be saved");

        const audit = await transaction.queryOne<IdRow>(
          `
            insert into audit_logs (
              workspace_id,
              project_id,
              actor_user_id,
              action,
              entity_type,
              entity_id,
              before,
              after
            )
            values ($1, $2::uuid, $3::uuid, $4, $5, $6::uuid, null, $7::jsonb)
            returning id
          `,
          [
            input.session.workspaceId,
            ids.projectId,
            input.session.userId,
            "property_inquiry.routed",
            "property_inquiry",
            row.id,
            JSON.stringify({ inquiryId: row.id, route: canonicalRoute, status }),
          ],
        );
        if (!audit) throw new Error("Inquiry audit could not be saved");

        return { id: row.id, projectId: ids.projectId, route: canonicalRoute, status };
      },
    );
  } catch (error) {
    return {
      persisted: false,
      reason: error instanceof PropertyInquiryValidationError
        ? error.message
        : "Inquiry route could not be saved",
    };
  }

  return {
    data: { id: persisted.id, route: persisted.route, status: persisted.status },
    persisted: true,
  };
}

export async function recordPropertyPreflightRun(input: {
  assetId?: string;
  channel: string;
  idempotencyKey: string;
  preflight: PropertyPreflightResult;
  projectId?: string | null;
  session: AppSession;
}): Promise<RepositoryWriteResult<{ id: string }>> {
  if (!evaluateLaunchScope("propertyExportQueue").allowed) {
    return { persisted: false, reason: "property_export_queue_launch_off" };
  }

  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return { persisted: false, reason: "Database persistence is not configured" };
  }

  const propertyId = normalizeEntityId(input.assetId);
  const projectId = nullableUuid(input.projectId);
  const row = await queryOne<IdRow>(
    `
      insert into property_export_jobs (
        workspace_id,
        project_id,
        property_id,
        portal,
        export_format,
        status,
        preflight_status,
        started_by_user_id,
        export_history,
        metadata,
        idempotency_key
      )
      values (
        $1,
        $2::uuid,
        $3::uuid,
        $4,
        $5,
        'queued',
        $6,
        $7::uuid,
        $8::jsonb,
        $9::jsonb,
        $10
      )
      on conflict (workspace_id, idempotency_key) do update
      set updated_at = property_export_jobs.updated_at
      returning id
    `,
    [
      input.session.workspaceId,
      projectId,
      propertyId,
      input.channel,
      input.channel === "OpenImmo Export" ? "openimmo_1_2_7c" : "canonical_channel_payload",
      input.preflight.status,
      nullableUuid(input.session.userId),
      JSON.stringify([{ at: new Date().toISOString(), preflight: input.preflight }]),
      JSON.stringify({ assetId: input.assetId ?? null, channel: input.channel }),
      input.idempotencyKey,
    ],
  );

  if (!row) return { persisted: false, reason: "Preflight could not be recorded" };

  await writeAuditLog({
    action: "property_preflight.recorded",
    after: { channel: input.channel, exportJobId: row.id, preflight: input.preflight },
    entityId: row.id,
    entityType: "property_export_job",
    projectId,
    session: input.session,
  });

  return { data: { id: row.id }, persisted: true };
}

async function savePropertyFragments(input: {
  property: Record<string, unknown>;
  projectId?: string;
  propertyId: string;
  session: AppSession;
}) {
  const textBlocks = asObjectArray(input.property.textBlocks);
  if (textBlocks.length) {
    await savePropertyTextBlocks({
      projectId: input.projectId,
      propertyId: input.propertyId,
      session: input.session,
      textBlocks,
    });
  }

  const costItems = asObjectArray(input.property.costItems);
  if (costItems.length) {
    await savePropertyCostItems({
      costItems,
      projectId: input.projectId,
      propertyId: input.propertyId,
      session: input.session,
    });
  }

  const mediaItems = asObjectArray(input.property.mediaItems);
  for (const media of mediaItems) {
    if (nullableUuid(media.mediaAssetId)) {
      await attachPropertyMedia({
        media,
        projectId: input.projectId,
        propertyId: input.propertyId,
        session: input.session,
      });
    }
  }

  const documentItems = asObjectArray(input.property.documentItems);
  for (const document of documentItems) {
    if (nullableUuid(document.mediaAssetId)) {
      await attachPropertyDocument({
        document,
        projectId: input.projectId,
        propertyId: input.propertyId,
        session: input.session,
      });
    }
  }

  const channelPriceVisibility = normalizePriceVisibilityMap(asPlainObject(input.property.channelPriceVisibility));
  if (Object.keys(channelPriceVisibility).length) {
    await persistChannelPriceOverrides({
      channelPriceVisibility,
      projectId: input.projectId,
      propertyId: input.propertyId,
      session: input.session,
    });
  }
}

async function persistChannelPriceOverrides(input: {
  channelPriceVisibility: Record<string, PropertyPriceVisibility>;
  projectId?: string | null;
  propertyId: string;
  session: AppSession;
}) {
  for (const [channel, priceVisibility] of Object.entries(input.channelPriceVisibility)) {
    const existing = await queryOne<IdRow>(
      `
        select id
        from property_channels
        where workspace_id = $1
          and property_id = $2::uuid
          and channel_type = $3
        limit 1
      `,
      [input.session.workspaceId, input.propertyId, channel],
    );

    if (existing) {
      await queryOne<IdRow>(
        `
          update property_channels
          set
            price_visibility_override = $4,
            channel_name = coalesce(nullif(channel_name, ''), $3),
            updated_at = now()
          where id = $1::uuid
            and workspace_id = $2
          returning id
        `,
        [existing.id, input.session.workspaceId, channel, priceVisibility],
      );
      continue;
    }

    await queryOne<IdRow>(
      `
        insert into property_channels (
          workspace_id,
          project_id,
          property_id,
          channel_type,
          channel_name,
          price_visibility_override,
          status,
          metadata
        )
        values ($1, $2::uuid, $3::uuid, $4, $4, $5, 'draft', $6::jsonb)
        returning id
      `,
      [
        input.session.workspaceId,
        nullableUuid(input.projectId),
        input.propertyId,
        channel,
        priceVisibility,
        JSON.stringify({ source: "property_department_price_visibility" }),
      ],
    );
  }
}

async function findPropertyProjectId(propertyId: string, session: AppSession) {
  const row = await queryOne<ListingProjectRow>(
    `
      select project_id as "projectId"
      from seller_listings
      where id = $1::uuid
        and workspace_id = $2
      limit 1
    `,
    [propertyId, session.workspaceId],
  );

  return row?.projectId ?? null;
}

async function writePropertyActivityEvent(input: {
  contactId?: string | null;
  detail: string;
  eventType: string;
  leadId?: string | null;
  projectId?: string | null;
  propertyId?: string | null;
  session: AppSession;
  title: string;
  transaction?: TenantTransaction;
  unitId?: string | null;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId)) return false;

  const query = `
    insert into property_activity_events (
      workspace_id,
      project_id,
      property_id,
      unit_id,
      contact_id,
      lead_id,
      actor_user_id,
      event_type,
      title,
      detail,
      metadata
    )
    values ($1, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8, $9, $10, $11::jsonb)
    returning id
  `;
  const params = [
    input.session.workspaceId,
    nullableUuid(input.projectId),
    nullableUuid(input.propertyId),
    nullableUuid(input.unitId),
    nullableUuid(input.contactId),
    nullableUuid(input.leadId),
    nullableUuid(input.session.userId),
    input.eventType,
    input.title,
    input.detail,
    JSON.stringify({ source: "property_department" }),
  ];
  const row = input.transaction
    ? await input.transaction.queryOne<IdRow>(query, params)
    : await queryOne<IdRow>(query, params);

  return Boolean(row);
}

function listingDefaultUnitNumber(listingId: string) {
  return `DEFAULT-${listingId.replace(/-/g, "").slice(0, 12).toUpperCase()}`;
}

function listingDefaultUnitPriceCents(row: SellerListingRow) {
  for (const value of [row.targetPriceCents, row.marketValueCents, row.publicPriceCents, row.rentPriceCents]) {
    const parsed = Number(value ?? 0);
    if (Number.isFinite(parsed) && parsed > 0) return Math.round(parsed);
  }
  return 0;
}

async function ensureDefaultUnitForListing(row: SellerListingRow, session: AppSession): Promise<SellerListingRow> {
  if (!row.projectId || !isUuid(row.projectId) || !isUuid(session.workspaceId)) return row;

  const unitMetadata = {
    defaultUnit: true,
    hidden: true,
    sellerListingId: row.id,
    source: "seller_listing",
    updatedByUserId: session.userId,
  };
  const unitPayload: unknown[] = [
    session.workspaceId,
    row.projectId,
    row.unitId,
    listingDefaultUnitNumber(row.id),
    toNumber(row.rooms, 0),
    toNumber(row.areaSqm, 0),
    listingDefaultUnitPriceCents(row),
    JSON.stringify(unitMetadata),
  ];

  if (row.unitId) {
    await queryOne<IdRow>(
      `
        update property_units
        set
          unit_number = coalesce(nullif($4, ''), unit_number),
          rooms = $5,
          area_sqm = $6,
          price_cents = $7,
          metadata = metadata || $8::jsonb,
          updated_at = now()
        where workspace_id = $1
          and project_id = $2::uuid
          and id = $3::uuid
          and metadata @> '{"defaultUnit": true}'::jsonb
        returning id
      `,
      unitPayload,
    );
    return row;
  }

  const explicitUnitCount = await queryOne<CountRow>(
    `
      select count(*)::int as count
      from property_units
      where workspace_id = $1
        and project_id = $2::uuid
        and not (metadata @> '{"defaultUnit": true}'::jsonb)
    `,
    [session.workspaceId, row.projectId],
  );
  if (Number(explicitUnitCount?.count ?? 0) > 0) return row;

  const unit = await queryOne<IdRow>(
    `
      insert into property_units (
        workspace_id,
        project_id,
        unit_number,
        floor,
        rooms,
        area_sqm,
        price_cents,
        status,
        metadata
      )
      values ($1, $2::uuid, $3, 0, $4, $5, $6, 'available', $7::jsonb)
      on conflict (project_id, unit_number)
      do update set
        rooms = excluded.rooms,
        area_sqm = excluded.area_sqm,
        price_cents = excluded.price_cents,
        metadata = property_units.metadata || excluded.metadata,
        updated_at = now()
      returning id
    `,
    [
      session.workspaceId,
      row.projectId,
      listingDefaultUnitNumber(row.id),
      toNumber(row.rooms, 0),
      toNumber(row.areaSqm, 0),
      listingDefaultUnitPriceCents(row),
      JSON.stringify(unitMetadata),
    ],
  );
  if (!unit?.id) return row;

  const refreshed = await queryOne<SellerListingRow>(
    `
      update seller_listings
      set
        unit_id = $3::uuid,
        canonical_payload = canonical_payload || jsonb_build_object(
          'defaultUnitId',
          $3::text,
          'defaultUnitSource',
          'seller_listing'
        ),
        updated_at = now()
      where workspace_id = $1
        and id = $2::uuid
        and unit_id is null
      returning ${sellerListingReturningSql}
    `,
    [session.workspaceId, row.id, unit.id],
  );

  await writePropertyActivityEvent({
    detail: "Automatische Default-Unit für Listing-only-Objekt erstellt",
    eventType: "property.default_unit.created",
    projectId: row.projectId,
    propertyId: row.id,
    session,
    title: "Default-Unit erstellt",
    unitId: unit.id,
  });

  return refreshed ?? { ...row, unitId: unit.id };
}

function toSellerListing(row: SellerListingRow): SellerListing {
  return {
    address: row.address,
    areaSqm: Number(row.areaSqm ?? 0),
    canonicalPayload: row.canonicalPayload ?? undefined,
    city: row.city ?? undefined,
    createdAt: toIso(row.createdAt),
    documentStatus: row.documentStatus ?? undefined,
    energyClass: row.energyClass ?? undefined,
    energyValidUntil: toOptionalIso(row.energyValidUntil),
    availableFrom: toOptionalIso(row.availableFrom),
    availableFromText: row.availableFromText ?? undefined,
    availabilityNote: row.availabilityNote ?? undefined,
    channelPriceVisibility: normalizePriceVisibilityMap(row.channelPriceVisibility ?? {}),
    contactEmail: row.contactEmail ?? undefined,
    contactName: row.contactName ?? undefined,
    contactPhone: row.contactPhone ?? undefined,
    contactUserId: row.contactUserId ?? undefined,
    costsSummary: row.costsSummary ?? undefined,
    documentSummary: row.documentSummary ?? undefined,
    expectedGrossYield: toOptionalNumber(row.expectedGrossYield),
    externalPortalId: row.externalPortalId ?? undefined,
    federalState: row.federalState ?? undefined,
    gdprStatus: row.gdprStatus ?? undefined,
    id: row.id,
    internalReference: row.internalReference ?? undefined,
    internalNotes: row.internalNotes ?? undefined,
    mandateId: row.mandateId ?? undefined,
    mandateEndsAt: toOptionalIso(row.mandateEndsAt),
    marketingType: row.marketingType ?? undefined,
    marketValue: centsToNumber(row.marketValueCents) ?? 0,
    mediaSummary: row.mediaSummary ?? undefined,
    monthlyCostsGross: centsToNumber(row.monthlyCostsGrossCents),
    objectType: row.objectType,
    objectNumber: row.objectNumber ?? undefined,
    openimmoObjectId: row.openimmoObjectId ?? undefined,
    ownerContactId: row.ownerContactId ?? undefined,
    ownerUserId: row.ownerUserId ?? undefined,
    portalMappingStatus: row.portalMappingStatus ?? undefined,
    postalCode: row.postalCode ?? undefined,
    priceVisibility: normalizePriceVisibility(row.priceVisibility),
    projectId: row.projectId ?? "",
    propertyStatus: row.propertyStatus ?? undefined,
    publicPrice: centsToNumber(row.publicPriceCents),
    purchaseAncillaryCosts: centsToNumber(row.purchaseAncillaryCostsCents),
    region: row.region,
    rentNet: centsToNumber(row.rentNetCents),
    rentPrice: centsToNumber(row.rentPriceCents),
    rooms: toOptionalNumber(row.rooms),
    sellerLeadId: row.sellerLeadId ?? "",
    street: row.street ?? undefined,
    subObjectType: row.subObjectType ?? undefined,
    subObjectTypeCustom: row.subObjectTypeCustom ?? undefined,
    targetPrice: centsToNumber(row.targetPriceCents) ?? 0,
    textSummary: row.textSummary ?? undefined,
    title: row.title,
    unitId: row.unitId ?? undefined,
    usageType: row.usageType ?? undefined,
    workspaceId: row.workspaceId,
    yearBuilt: toOptionalNumber(row.yearBuilt) ?? 0,
  };
}

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function asPlainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asObjectArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function toNumber(value: unknown, fallback: number) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const compact = value.replace(/[^\d,.-]/g, "");
    const normalized = compact.includes(",") ? compact.replace(/\./g, "").replace(",", ".") : compact;
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function optionalNumber(value: unknown) {
  const parsed = toNumber(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

function optionalInteger(value: unknown) {
  const parsed = optionalNumber(value);
  return parsed === null ? null : Math.round(parsed);
}

function toPriceCents(value: unknown) {
  const parsed = toNumber(value, 0);
  return Math.round(parsed > 999_999 ? parsed : parsed * 100);
}

function toNullablePriceCents(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = toNumber(value, Number.NaN);
  return Number.isFinite(parsed) ? Math.round(parsed > 999_999 ? parsed : parsed * 100) : null;
}

function toCostCents(euroValue: unknown, centsValue: unknown) {
  if (euroValue !== null && euroValue !== undefined && euroValue !== "") {
    return toPriceCents(euroValue);
  }
  if (centsValue !== null && centsValue !== undefined && centsValue !== "") {
    const parsed = toNumber(centsValue, 0);
    return Math.round(parsed);
  }
  return 0;
}

function normalizePriceVisibility(value: unknown): PropertyPriceVisibility {
  if (value === "price_on_request") return "price_on_request";
  if (value === "hide_price") return "hide_price";
  return "publish_price";
}

function normalizePriceVisibilityMap(value: Record<string, unknown>): Record<string, PropertyPriceVisibility> {
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, item]) => [cleanString(key), normalizePriceVisibility(item)] as const)
      .filter(([key]) => Boolean(key)),
  );
}

function dateOnly(value: unknown) {
  const raw = cleanString(value);
  if (!raw) return null;
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function buildCostsSummary(property: Record<string, unknown>) {
  return {
    monthlyCostsGrossCents: toNullablePriceCents(property.monthlyCostsGross),
    purchaseAncillaryCostsCents: toNullablePriceCents(property.purchaseAncillaryCosts),
    rentNetCents: toNullablePriceCents(property.rentNet),
    rentPriceCents: toNullablePriceCents(property.rentPrice),
    source: "property_department",
  };
}

function normalizeRegion(value: string): SellerListing["region"] {
  const normalized = value.replace("ö", "oe").replace("Ö", "Oe").replace("ä", "ae").replace("Ä", "Ae");
  if (allowedRegions.has(normalized)) {
    return value as SellerListing["region"];
  }
  return "Wien";
}

function nullableUuid(value: unknown) {
  const candidate = cleanString(value);
  return isUuid(candidate) ? candidate : null;
}

function normalizeEntityId(value: unknown) {
  const candidate = cleanString(value).replace(/^listing:/, "");
  return isUuid(candidate) ? candidate : null;
}

function extractSection(fields: Record<string, unknown>, sectionId: string) {
  const section: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key.startsWith(`${sectionId}.`) && cleanString(value)) {
      section[key.slice(sectionId.length + 1)] = value;
    }
  }
  return section;
}

function extractExposeContent(fields: Record<string, unknown>) {
  return {
    construction: extractSection(fields, "construction"),
    costs: extractSection(fields, "costs"),
    energy: extractSection(fields, "energy"),
    notes: extractSection(fields, "notes"),
  };
}

function toOptionalNumber(value: number | string | null) {
  if (value === null || value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function centsToNumber(value: number | string | null) {
  const parsed = toOptionalNumber(value);
  return typeof parsed === "number" ? parsed / 100 : undefined;
}

function toIso(value: string | Date | null) {
  if (!value) return "";
  return value instanceof Date ? value.toISOString() : String(value);
}

function toOptionalIso(value: string | Date | null) {
  return value ? toIso(value) : undefined;
}
