import type { AppSession } from "@/lib/auth/session";
import type { BrokerMandate, BuyerSearchProfile, Lead } from "@/lib/crm-types";
import { queryOne } from "@/lib/db/client";
import { canPersist, isUuid, writeAuditLog } from "@/lib/db/runtime-repositories";

type BrokerMandateRow = {
  address: string;
  areaSqm: number | string | null;
  askingPriceCents: number | string | null;
  commissionRate: number | string | null;
  condition: string | null;
  contactId: string | null;
  documentsStatus: string | null;
  expiringBrokerContractAt: string | Date | null;
  id: string;
  location: string | null;
  mandateStatus: string;
  mandateType: string | null;
  marketValueCents: number | string | null;
  marketingStatus: string | null;
  metadata: Record<string, unknown> | null;
  motivation: string | null;
  projectId: string | null;
  propertyType: BrokerMandate["propertyType"] | null;
  rooms: number | string | null;
  sellerLeadId: string | null;
  sellingReason: string | null;
  sellingTimeline: string | null;
  title: string;
  updatedAt: string | Date;
  workspaceId: string;
  yearBuilt: number | string | null;
};

type BuyerSearchProfileRow = {
  areaSqm: number | string | null;
  budgetFromCents: number | string | null;
  budgetToCents: number | string | null;
  buyerLeadId: string | null;
  contactId: string | null;
  desiredLocation: string | null;
  financingStatus: BuyerSearchProfile["financingStatus"] | null;
  id: string;
  matchingStatus: string;
  metadata: Record<string, unknown> | null;
  mustHaveCriteria: string[] | null;
  niceToHaveCriteria: string[] | null;
  projectId: string | null;
  propertyType: BuyerSearchProfile["propertyType"] | null;
  purchaseTimeline: string | null;
  rooms: number | string | null;
  title: string;
  updatedAt: string | Date;
  workspaceId: string;
};

type RepositoryWriteResult<T> =
  | { data: T; persisted: true }
  | { persisted: false; reason: string };

const brokerMandateReturningSql = `
  id,
  workspace_id as "workspaceId",
  project_id as "projectId",
  seller_lead_id as "sellerLeadId",
  contact_id as "contactId",
  title,
  address,
  location,
  property_type as "propertyType",
  condition,
  area_sqm as "areaSqm",
  rooms,
  year_built as "yearBuilt",
  asking_price_cents as "askingPriceCents",
  market_value_cents as "marketValueCents",
  selling_timeline as "sellingTimeline",
  motivation,
  selling_reason as "sellingReason",
  mandate_status as "mandateStatus",
  mandate_type as "mandateType",
  commission_rate as "commissionRate",
  documents_status as "documentsStatus",
  marketing_status as "marketingStatus",
  expiring_broker_contract_at as "expiringBrokerContractAt",
  metadata,
  updated_at as "updatedAt"
`;

const buyerSearchProfileReturningSql = `
  id,
  workspace_id as "workspaceId",
  project_id as "projectId",
  buyer_lead_id as "buyerLeadId",
  contact_id as "contactId",
  title,
  budget_from_cents as "budgetFromCents",
  budget_to_cents as "budgetToCents",
  financing_status as "financingStatus",
  desired_location as "desiredLocation",
  property_type as "propertyType",
  rooms,
  area_sqm as "areaSqm",
  must_have_criteria as "mustHaveCriteria",
  nice_to_have_criteria as "niceToHaveCriteria",
  purchase_timeline as "purchaseTimeline",
  matching_status as "matchingStatus",
  metadata,
  updated_at as "updatedAt"
`;

export async function upsertBrokerMandate(input: {
  mandate: Partial<BrokerMandate> & Record<string, unknown>;
  session: AppSession;
}): Promise<RepositoryWriteResult<BrokerMandate>> {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return { persisted: false, reason: "DATABASE_URL is not configured" };
  }

  const existingId = await resolveBrokerMandateId(input.session.workspaceId, input.mandate);
  const row = existingId
    ? await queryOne<BrokerMandateRow>(
        `
          update broker_mandates
          set
            project_id = $3::uuid,
            seller_lead_id = $4::uuid,
            contact_id = $5::uuid,
            title = $6,
            address = $7,
            location = $8,
            property_type = nullif($9, ''),
            condition = nullif($10, ''),
            area_sqm = $11::numeric,
            rooms = $12::numeric,
            year_built = $13::integer,
            asking_price_cents = $14::bigint,
            market_value_cents = $15::bigint,
            selling_timeline = nullif($16, ''),
            motivation = nullif($17, ''),
            selling_reason = nullif($18, ''),
            mandate_status = $19,
            mandate_type = nullif($20, ''),
            commission_rate = $21::numeric,
            documents_status = nullif($22, ''),
            marketing_status = nullif($23, ''),
            expiring_broker_contract_at = $24::date,
            metadata = metadata || $25::jsonb,
            updated_at = now()
          where id = $1 and workspace_id = $2
          returning ${brokerMandateReturningSql}
        `,
        brokerMandateParams(input.session, input.mandate, existingId),
      )
    : await queryOne<BrokerMandateRow>(
        `
          insert into broker_mandates (
            workspace_id,
            project_id,
            seller_lead_id,
            contact_id,
            title,
            address,
            location,
            property_type,
            condition,
            area_sqm,
            rooms,
            year_built,
            asking_price_cents,
            market_value_cents,
            selling_timeline,
            motivation,
            selling_reason,
            mandate_status,
            mandate_type,
            commission_rate,
            documents_status,
            marketing_status,
            expiring_broker_contract_at,
            metadata
          )
          values ($1, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, nullif($8, ''), nullif($9, ''), $10::numeric, $11::numeric, $12::integer, $13::bigint, $14::bigint, nullif($15, ''), nullif($16, ''), nullif($17, ''), $18, nullif($19, ''), $20::numeric, nullif($21, ''), nullif($22, ''), $23::date, $24::jsonb)
          returning ${brokerMandateReturningSql}
        `,
        brokerMandateParams(input.session, input.mandate),
      );

  if (!row) return { persisted: false, reason: "Broker mandate could not be saved" };

  const mandate = toBrokerMandate(row);
  await writeAuditLog({
    action: existingId ? "broker_mandate.updated" : "broker_mandate.created",
    after: mandate,
    entityId: mandate.id,
    entityType: "broker_mandate",
    projectId: mandate.projectId,
    session: input.session,
  });

  return { data: mandate, persisted: true };
}

export async function upsertBuyerSearchProfile(input: {
  profile: Partial<BuyerSearchProfile> & Record<string, unknown>;
  session: AppSession;
}): Promise<RepositoryWriteResult<BuyerSearchProfile>> {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return { persisted: false, reason: "DATABASE_URL is not configured" };
  }

  const existingId = await resolveBuyerSearchProfileId(input.session.workspaceId, input.profile);
  const row = existingId
    ? await queryOne<BuyerSearchProfileRow>(
        `
          update buyer_search_profiles
          set
            project_id = $3::uuid,
            buyer_lead_id = $4::uuid,
            contact_id = $5::uuid,
            title = $6,
            budget_from_cents = $7::bigint,
            budget_to_cents = $8::bigint,
            financing_status = nullif($9, ''),
            desired_location = nullif($10, ''),
            property_type = nullif($11, ''),
            rooms = $12::numeric,
            area_sqm = $13::numeric,
            must_have_criteria = $14::text[],
            nice_to_have_criteria = $15::text[],
            purchase_timeline = nullif($16, ''),
            matching_status = $17,
            metadata = metadata || $18::jsonb,
            updated_at = now()
          where id = $1 and workspace_id = $2
          returning ${buyerSearchProfileReturningSql}
        `,
        buyerSearchProfileParams(input.session, input.profile, existingId),
      )
    : await queryOne<BuyerSearchProfileRow>(
        `
          insert into buyer_search_profiles (
            workspace_id,
            project_id,
            buyer_lead_id,
            contact_id,
            title,
            budget_from_cents,
            budget_to_cents,
            financing_status,
            desired_location,
            property_type,
            rooms,
            area_sqm,
            must_have_criteria,
            nice_to_have_criteria,
            purchase_timeline,
            matching_status,
            metadata
          )
          values ($1, $2::uuid, $3::uuid, $4::uuid, $5, $6::bigint, $7::bigint, nullif($8, ''), nullif($9, ''), nullif($10, ''), $11::numeric, $12::numeric, $13::text[], $14::text[], nullif($15, ''), $16, $17::jsonb)
          returning ${buyerSearchProfileReturningSql}
        `,
        buyerSearchProfileParams(input.session, input.profile),
      );

  if (!row) return { persisted: false, reason: "Buyer search profile could not be saved" };

  const profile = toBuyerSearchProfile(row);
  await writeAuditLog({
    action: existingId ? "buyer_search_profile.updated" : "buyer_search_profile.created",
    after: profile,
    entityId: profile.id,
    entityType: "buyer_search_profile",
    projectId: profile.projectId,
    session: input.session,
  });

  return { data: profile, persisted: true };
}

export async function syncBrokerEntityForLead(input: {
  lead: Lead;
  session: AppSession;
}) {
  try {
    if (isSellerLead(input.lead)) {
      const profile = input.lead.sellerProfile;
      return await upsertBrokerMandate({
        mandate: {
          address: profile?.address ?? "",
          areaSqm: input.lead.areaSqm,
          askingPrice: profile?.askingPrice,
          commissionRate: profile?.commissionRate,
          condition: profile?.objectCondition,
          contactId: input.lead.contactId,
          documentsStatus: profile?.documentStatus,
          expiringBrokerContractAt: profile?.expiringBrokerContractAt,
          mandateStatus: profile?.mandateStatus ?? profile?.brokerContractStatus ?? "open",
          mandateType: profile?.mandateType,
          marketValue: profile?.marketValue,
          marketingStatus: profile?.marketingStatus,
          metadata: { source: "lead_profile_sync" },
          motivation: profile?.motivation,
          projectId: input.lead.projectId,
          propertyType: input.lead.objectType,
          rooms: input.lead.rooms,
          sellerLeadId: input.lead.id,
          sellingReason: profile?.sellingReason,
          sellingTimeline: profile?.sellingTimeline,
          title: input.lead.intent || "Makler-Mandat",
          yearBuilt: profile?.yearBuilt,
        },
        session: input.session,
      });
    }

    if (isBuyerLead(input.lead)) {
      const profile = input.lead.buyerProfile;
      return await upsertBuyerSearchProfile({
        profile: {
          areaSqm: input.lead.areaSqm,
          budgetFrom: profile?.budgetFrom,
          budgetTo: profile?.budgetTo,
          buyerLeadId: input.lead.id,
          contactId: input.lead.contactId,
          desiredLocation: profile?.desiredLocation ?? input.lead.region,
          financingStatus: profile?.financingStatus,
          matchingStatus: "open",
          metadata: { source: "lead_profile_sync" },
          mustHaveCriteria: profile?.mustHaveCriteria ?? [],
          niceToHaveCriteria: profile?.niceToHaveCriteria ?? [],
          projectId: input.lead.projectId,
          propertyType: profile?.propertyType ?? input.lead.objectType,
          purchaseTimeline: profile?.purchaseTimeline,
          rooms: input.lead.rooms,
          title: input.lead.intent || "Käufer-Suchprofil",
        },
        session: input.session,
      });
    }
  } catch {
    return { persisted: false as const, reason: "Broker lead entity sync failed" };
  }

  return { persisted: false as const, reason: "Lead type does not create a broker entity" };
}

function isSellerLead(lead: Lead) {
  const type = String(lead.type).toLowerCase();
  return Boolean(lead.sellerProfile) || type.includes("verk") || type.includes("seller");
}

function isBuyerLead(lead: Lead) {
  const type = String(lead.type).toLowerCase();
  return Boolean(lead.buyerProfile) || type.includes("kaeu") || type.includes("kauf") || type.includes("buyer");
}

async function resolveBrokerMandateId(workspaceId: string, mandate: Record<string, unknown>) {
  const id = typeof mandate.id === "string" && isUuid(mandate.id) ? mandate.id : null;
  const sellerLeadId = typeof mandate.sellerLeadId === "string" && isUuid(mandate.sellerLeadId)
    ? mandate.sellerLeadId
    : null;

  const row = await queryOne<{ id: string }>(
    `
      select id
      from broker_mandates
      where workspace_id = $1
        and (($2::uuid is not null and id = $2::uuid) or ($3::uuid is not null and seller_lead_id = $3::uuid))
      limit 1
    `,
    [workspaceId, id, sellerLeadId],
  );

  return row?.id ?? null;
}

async function resolveBuyerSearchProfileId(workspaceId: string, profile: Record<string, unknown>) {
  const id = typeof profile.id === "string" && isUuid(profile.id) ? profile.id : null;
  const buyerLeadId = typeof profile.buyerLeadId === "string" && isUuid(profile.buyerLeadId)
    ? profile.buyerLeadId
    : null;

  const row = await queryOne<{ id: string }>(
    `
      select id
      from buyer_search_profiles
      where workspace_id = $1
        and (($2::uuid is not null and id = $2::uuid) or ($3::uuid is not null and buyer_lead_id = $3::uuid))
      limit 1
    `,
    [workspaceId, id, buyerLeadId],
  );

  return row?.id ?? null;
}

function brokerMandateParams(
  session: AppSession,
  mandate: Partial<BrokerMandate> & Record<string, unknown>,
  existingId?: string | null,
) {
  const params = [
    existingId ?? session.workspaceId,
    existingId ? session.workspaceId : normalizeUuid(mandate.projectId),
    existingId ? normalizeUuid(mandate.projectId) : normalizeUuid(mandate.sellerLeadId),
    existingId ? normalizeUuid(mandate.sellerLeadId) : normalizeUuid(mandate.contactId),
    existingId ? normalizeUuid(mandate.contactId) : cleanString(mandate.title) || "Makler-Mandat",
    existingId ? cleanString(mandate.title) || "Makler-Mandat" : cleanString(mandate.address),
    existingId ? cleanString(mandate.address) : cleanString(mandate.location),
    existingId ? cleanString(mandate.location) : cleanString(mandate.propertyType),
    existingId ? cleanString(mandate.propertyType) : cleanString(mandate.condition),
    existingId ? cleanString(mandate.condition) : numberOrNull(mandate.areaSqm),
    existingId ? numberOrNull(mandate.areaSqm) : numberOrNull(mandate.rooms),
    existingId ? numberOrNull(mandate.rooms) : numberOrNull(mandate.yearBuilt),
    existingId ? numberOrNull(mandate.yearBuilt) : moneyToCents(mandate.askingPrice),
    existingId ? moneyToCents(mandate.askingPrice) : moneyToCents(mandate.marketValue),
    existingId ? moneyToCents(mandate.marketValue) : cleanString(mandate.sellingTimeline),
    existingId ? cleanString(mandate.sellingTimeline) : cleanString(mandate.motivation),
    existingId ? cleanString(mandate.motivation) : cleanString(mandate.sellingReason),
    existingId ? cleanString(mandate.sellingReason) : cleanString(mandate.mandateStatus) || "open",
    existingId ? cleanString(mandate.mandateStatus) || "open" : cleanString(mandate.mandateType),
    existingId ? cleanString(mandate.mandateType) : numberOrNull(mandate.commissionRate),
    existingId ? numberOrNull(mandate.commissionRate) : cleanString(mandate.documentsStatus),
    existingId ? cleanString(mandate.documentsStatus) : cleanString(mandate.marketingStatus),
    existingId ? cleanString(mandate.marketingStatus) : cleanDate(mandate.expiringBrokerContractAt),
    existingId ? cleanDate(mandate.expiringBrokerContractAt) : JSON.stringify(asObject(mandate.metadata)),
  ];

  if (existingId) {
    params.push(JSON.stringify(asObject(mandate.metadata)));
  }

  return params;
}

function buyerSearchProfileParams(
  session: AppSession,
  profile: Partial<BuyerSearchProfile> & Record<string, unknown>,
  existingId?: string | null,
) {
  const params = [
    existingId ?? session.workspaceId,
    existingId ? session.workspaceId : normalizeUuid(profile.projectId),
    existingId ? normalizeUuid(profile.projectId) : normalizeUuid(profile.buyerLeadId),
    existingId ? normalizeUuid(profile.buyerLeadId) : normalizeUuid(profile.contactId),
    existingId ? normalizeUuid(profile.contactId) : cleanString(profile.title) || "Käufer-Suchprofil",
    existingId ? cleanString(profile.title) || "Käufer-Suchprofil" : moneyToCents(profile.budgetFrom),
    existingId ? moneyToCents(profile.budgetFrom) : moneyToCents(profile.budgetTo),
    existingId ? moneyToCents(profile.budgetTo) : cleanString(profile.financingStatus),
    existingId ? cleanString(profile.financingStatus) : cleanString(profile.desiredLocation),
    existingId ? cleanString(profile.desiredLocation) : cleanString(profile.propertyType),
    existingId ? cleanString(profile.propertyType) : numberOrNull(profile.rooms),
    existingId ? numberOrNull(profile.rooms) : numberOrNull(profile.areaSqm),
    existingId ? numberOrNull(profile.areaSqm) : stringArray(profile.mustHaveCriteria),
    existingId ? stringArray(profile.mustHaveCriteria) : stringArray(profile.niceToHaveCriteria),
    existingId ? stringArray(profile.niceToHaveCriteria) : cleanString(profile.purchaseTimeline),
    existingId ? cleanString(profile.purchaseTimeline) : cleanString(profile.matchingStatus) || "open",
    existingId ? cleanString(profile.matchingStatus) || "open" : JSON.stringify(asObject(profile.metadata)),
  ];

  if (existingId) {
    params.push(JSON.stringify(asObject(profile.metadata)));
  }

  return params;
}

function toBrokerMandate(row: BrokerMandateRow): BrokerMandate {
  return {
    address: row.address,
    areaSqm: optionalNumber(row.areaSqm),
    askingPrice: centsToMoney(row.askingPriceCents),
    commissionRate: optionalNumber(row.commissionRate),
    condition: row.condition ?? undefined,
    contactId: row.contactId ?? undefined,
    documentsStatus: row.documentsStatus ?? undefined,
    expiringBrokerContractAt: optionalIso(row.expiringBrokerContractAt),
    id: row.id,
    location: row.location ?? undefined,
    mandateStatus: row.mandateStatus,
    mandateType: row.mandateType ?? undefined,
    marketValue: centsToMoney(row.marketValueCents),
    marketingStatus: row.marketingStatus ?? undefined,
    metadata: row.metadata ?? undefined,
    motivation: row.motivation ?? undefined,
    projectId: row.projectId ?? undefined,
    propertyType: row.propertyType ?? undefined,
    rooms: optionalNumber(row.rooms),
    sellerLeadId: row.sellerLeadId ?? undefined,
    sellingReason: row.sellingReason ?? undefined,
    sellingTimeline: row.sellingTimeline ?? undefined,
    title: row.title,
    updatedAt: iso(row.updatedAt),
    workspaceId: row.workspaceId,
    yearBuilt: optionalNumber(row.yearBuilt),
  };
}

function toBuyerSearchProfile(row: BuyerSearchProfileRow): BuyerSearchProfile {
  return {
    areaSqm: optionalNumber(row.areaSqm),
    budgetFrom: centsToMoney(row.budgetFromCents),
    budgetTo: centsToMoney(row.budgetToCents),
    buyerLeadId: row.buyerLeadId ?? undefined,
    contactId: row.contactId ?? undefined,
    desiredLocation: row.desiredLocation ?? undefined,
    financingStatus: row.financingStatus ?? undefined,
    id: row.id,
    matchingStatus: row.matchingStatus,
    metadata: row.metadata ?? undefined,
    mustHaveCriteria: row.mustHaveCriteria ?? [],
    niceToHaveCriteria: row.niceToHaveCriteria ?? [],
    projectId: row.projectId ?? undefined,
    propertyType: row.propertyType ?? undefined,
    purchaseTimeline: row.purchaseTimeline ?? undefined,
    rooms: optionalNumber(row.rooms),
    title: row.title,
    updatedAt: iso(row.updatedAt),
    workspaceId: row.workspaceId,
  };
}

function normalizeUuid(value: unknown) {
  return typeof value === "string" && isUuid(value) ? value : null;
}

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanDate(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 10) : null;
}

function numberOrNull(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function moneyToCents(value: unknown) {
  const number = numberOrNull(value);
  return number === null ? null : Math.round(number * 100);
}

function optionalNumber(value: number | string | null) {
  if (value === null || value === undefined || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function centsToMoney(value: number | string | null) {
  const number = optionalNumber(value);
  return number === undefined ? undefined : number / 100;
}

function iso(value: string | Date | null) {
  if (!value) return "";
  return value instanceof Date ? value.toISOString() : String(value);
}

function optionalIso(value: string | Date | null) {
  const result = iso(value);
  return result || undefined;
}

function stringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map(String).map((item) => item.trim()).filter(Boolean);
}

function asObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
