import type { AppSession } from "@/lib/auth/session";
import { isAppRole } from "@/lib/auth/permissions";
import {
  hasDatabaseUrl,
  queryRows,
} from "@/lib/db/client";
import {
  withTenantTransaction,
  type TenantTransaction,
} from "@/lib/db/tenant-client";
import { isUuid } from "@/lib/db/runtime-repositories";
import {
  buildPropertyExportSnapshot,
  hashPropertyExportSnapshot,
  runServerPropertyExportPreflight,
} from "@/lib/property-export/canonical-payload";
import {
  isPropertyPublicationStatus,
  parsePropertyExportChannelAction,
  parsePropertyExportSchedule,
  resolvePropertyExportChannelTransition,
} from "@/lib/property-export/lifecycle";
import {
  PROPERTY_EXPORT_FORMAT,
  PROPERTY_EXPORT_OPERATION,
  PROPERTY_EXPORT_QA_PROVIDER,
  type ClaimedPropertyExportJob,
  type EnqueuePropertyExportResult,
  type PropertyExportArtifact,
  type PropertyExportEventView,
  type PropertyExportJobStatus,
  type PropertyExportJobView,
  type PropertyPublicationStatus,
  type PropertyExportSource,
} from "@/lib/property-export/types";
import type { LanguageCode } from "@/lib/i18n";
import { evaluateLaunchScope } from "@/lib/launch-scope";
import { isProductRole } from "@/lib/product-model";
import {
  canAccessPropertyExports,
  canProcessPropertyExports,
  hasProjectPropertyRecordScope,
  hasWorkspacePropertyRecordScope,
} from "@/lib/property-export/access";

const idempotencyKeyPattern = /^[A-Za-z0-9._:-]{16,160}$/;
const channelVersionPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

type DateValue = Date | string;

type PropertyExportJobRow = {
  artifactContentType: string | null;
  artifactFilename: string | null;
  artifactSha256: string | null;
  attemptCount: number | string;
  availableAt: DateValue;
  channelStatus: PropertyPublicationStatus;
  channelUpdatedAt: string;
  createdAt: DateValue;
  deadLetteredAt: DateValue | null;
  finishedAt: DateValue | null;
  id: string;
  lastErrorCategory: string | null;
  lastErrorMessage: string | null;
  maxAttempts: number | string;
  operation: string | null;
  payloadSha256: string | null;
  preflightStatus: string;
  projectId: string | null;
  propertyId: string | null;
  providerAcknowledgedAt: DateValue | null;
  providerKey: string | null;
  providerRequestId: string | null;
  scheduledAt: DateValue | null;
  snapshotCapturedAt: DateValue | null;
  startedAt: DateValue | null;
  status: PropertyExportJobStatus;
  updatedAt: DateValue;
};

type PropertyExportEventRow = {
  attemptCount: number | string;
  eventType: string;
  fromStatus: string | null;
  id: string;
  jobId: string;
  message: string | null;
  occurredAt: DateValue;
  toStatus: string;
};

type ListingRow = PropertyExportSource["listing"] & {
  projectName: string | null;
};

type UnitRow = PropertyExportSource["units"][number];
type CostRow = PropertyExportSource["costs"][number];
type DocumentRow = PropertyExportSource["documents"][number];
type MediaRow = PropertyExportSource["media"][number];
type TextRow = PropertyExportSource["texts"][number];

type ClaimedRow = ClaimedPropertyExportJob;

const jobSelectColumns = `
  j.id,
  j.project_id as "projectId",
  j.property_id as "propertyId",
  j.operation,
  j.provider_key as "providerKey",
  j.status,
  j.preflight_status as "preflightStatus",
  j.payload_sha256 as "payloadSha256",
  j.snapshot_captured_at as "snapshotCapturedAt",
  j.artifact_sha256 as "artifactSha256",
  j.artifact_content_type as "artifactContentType",
  j.artifact_filename as "artifactFilename",
  j.provider_request_id as "providerRequestId",
  j.provider_acknowledged_at as "providerAcknowledgedAt",
  j.available_at as "availableAt",
  c.status as "channelStatus",
  to_char(c.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "channelUpdatedAt",
  j.attempt_count as "attemptCount",
  j.max_attempts as "maxAttempts",
  j.last_error_category as "lastErrorCategory",
  j.last_error_message as "lastErrorMessage",
  nullif(j.metadata ->> 'requestedScheduledAt', '') as "scheduledAt",
  j.dead_lettered_at as "deadLetteredAt",
  j.started_at as "startedAt",
  j.finished_at as "finishedAt",
  j.created_at as "createdAt",
  j.updated_at as "updatedAt"
`;

export class PropertyExportRuntimeError extends Error {
  readonly code:
    | "database_unavailable"
    | "external_portal_launch_off"
    | "forbidden"
    | "idempotency_conflict"
    | "invalid_request"
    | "invalid_transition"
    | "job_not_retryable"
    | "not_found"
    | "preflight_blocked"
    | "stale_write";
  readonly preflight?: EnqueuePropertyExportResult["preflight"];

  constructor(input: {
    code: PropertyExportRuntimeError["code"];
    message: string;
    preflight?: EnqueuePropertyExportResult["preflight"];
  }) {
    super(input.message);
    this.name = "PropertyExportRuntimeError";
    this.code = input.code;
    this.preflight = input.preflight;
  }
}

function requirePropertyExportAccess(session: AppSession) {
  if (!canAccessPropertyExports(session)) {
    throw new PropertyExportRuntimeError({
      code: "forbidden",
      message: "Property export requires the server-side publish and administration policy.",
    });
  }
}

const propertyRecordAccessPredicate = (listingAlias: string, workspaceParameter: string, actorParameter: string, workspaceScopeParameter: string, projectScopeParameter: string) => `
  (
    ${workspaceScopeParameter}::boolean
    or ${listingAlias}.owner_user_id = ${actorParameter}::uuid
    or (
      ${projectScopeParameter}::boolean
      and ${listingAlias}.project_id is not null
      and exists (
        select 1
        from project_pipeline_permissions export_permission
        where export_permission.workspace_id = ${workspaceParameter}::uuid
          and export_permission.project_id = ${listingAlias}.project_id
          and export_permission.user_id = ${actorParameter}::uuid
          and export_permission.can_edit_deals = true
      )
    )
  )
`;

export function isPropertyExportIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && idempotencyKeyPattern.test(value.trim());
}

function requirePersistence() {
  if (!hasDatabaseUrl()) {
    throw new PropertyExportRuntimeError({
      code: "database_unavailable",
      message: "Database persistence is not configured.",
    });
  }
}

function requireUuid(value: unknown, label: string) {
  if (typeof value !== "string" || !isUuid(value)) {
    throw new PropertyExportRuntimeError({
      code: "invalid_request",
      message: `${label} must be a valid UUID.`,
    });
  }
  return value;
}

function toIso(value: DateValue) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("Property export timestamp is invalid");
  return parsed.toISOString();
}

function optionalIso(value: DateValue | null) {
  return value ? toIso(value) : null;
}

function mapEvent(row: PropertyExportEventRow): PropertyExportEventView {
  return {
    attemptCount: Number(row.attemptCount ?? 0),
    eventType: row.eventType,
    fromStatus: row.fromStatus,
    id: row.id,
    message: row.message,
    occurredAt: toIso(row.occurredAt),
    toStatus: row.toStatus,
  };
}

function mapJob(
  row: PropertyExportJobRow,
  events: PropertyExportEventView[] = [],
): PropertyExportJobView {
  if (!row.propertyId) throw new Error("Runtime property export has no property id");
  if (!isPropertyPublicationStatus(row.channelStatus)) {
    throw new Error("Runtime property export has an invalid channel status");
  }
  return {
    artifactContentType: row.artifactContentType,
    artifactFilename: row.artifactFilename,
    artifactSha256: row.artifactSha256,
    attemptCount: Number(row.attemptCount ?? 0),
    availableAt: toIso(row.availableAt),
    channelStatus: row.channelStatus,
    channelUpdatedAt: row.channelUpdatedAt,
    createdAt: toIso(row.createdAt),
    deadLetteredAt: optionalIso(row.deadLetteredAt),
    events,
    finishedAt: optionalIso(row.finishedAt),
    id: row.id,
    lastErrorCategory: row.lastErrorCategory,
    lastErrorMessage: row.lastErrorMessage,
    maxAttempts: Number(row.maxAttempts ?? 0),
    payloadSha256: row.payloadSha256,
    preflightStatus: row.preflightStatus,
    projectId: row.projectId,
    propertyId: row.propertyId,
    providerAcknowledgedAt: optionalIso(row.providerAcknowledgedAt),
    providerKey: row.providerKey,
    providerRequestId: row.providerRequestId,
    scheduledAt: optionalIso(row.scheduledAt),
    snapshotCapturedAt: optionalIso(row.snapshotCapturedAt),
    startedAt: optionalIso(row.startedAt),
    status: row.status,
    updatedAt: toIso(row.updatedAt),
  };
}

async function loadEventsForTenant(
  transaction: TenantTransaction,
  workspaceId: string,
  jobIds: string[],
) {
  if (!jobIds.length) return new Map<string, PropertyExportEventView[]>();
  const rows = await transaction.query<PropertyExportEventRow>(
    `
      select
        id,
        job_id as "jobId",
        event_type as "eventType",
        from_status as "fromStatus",
        to_status as "toStatus",
        attempt_count as "attemptCount",
        message,
        occurred_at as "occurredAt"
      from property_export_job_events
      where workspace_id = $1::uuid
        and job_id = any($2::uuid[])
      order by occurred_at desc, id desc
    `,
    [workspaceId, jobIds],
  );
  const byJob = new Map<string, PropertyExportEventView[]>();
  for (const row of rows) {
    byJob.set(row.jobId, [...(byJob.get(row.jobId) ?? []), mapEvent(row)]);
  }
  return byJob;
}

async function loadPropertyExportSource(
  transaction: TenantTransaction,
  session: AppSession,
  propertyId: string,
): Promise<PropertyExportSource> {
  const workspaceId = session.workspaceId;
  const actorId = session.userId;
  const listing = await transaction.queryOne<ListingRow>(
    `
      select
        sl.id,
        sl.workspace_id as "workspaceId",
        sl.project_id as "projectId",
        sl.unit_id as "unitId",
        seller_lead.id as "sellerLeadId",
        sl.title,
        sl.address,
        sl.country,
        sl.federal_state as "federalState",
        sl.postal_code as "postalCode",
        sl.city,
        sl.street,
        sl.house_number as "houseNumber",
        sl.region,
        sl.object_type as "objectType",
        sl.sub_object_type as "subObjectType",
        sl.usage_type as "usageType",
        sl.marketing_type as "marketingType",
        sl.area_sqm as "areaSqm",
        sl.rooms,
        sl.year_built as "yearBuilt",
        sl.object_number as "objectNumber",
        sl.internal_reference as "internalReference",
        sl.openimmo_object_id as "openimmoObjectId",
        export_contact.id as "ownerContactId",
        sl.available_from as "availableFrom",
        sl.available_from_text as "availableFromText",
        sl.price_visibility as "priceVisibility",
        sl.channel_price_visibility as "channelPriceVisibility",
        sl.public_price_cents as "publicPriceCents",
        sl.target_price_cents as "targetPriceCents",
        sl.market_value_cents as "marketValueCents",
        sl.rent_price_cents as "rentPriceCents",
        sl.rent_net_cents as "rentNetCents",
        sl.monthly_costs_gross_cents as "monthlyCostsGrossCents",
        sl.purchase_ancillary_costs_cents as "purchaseAncillaryCostsCents",
        sl.expected_gross_yield as "expectedGrossYield",
        coalesce(nullif(sl.contact_name, ''), export_contact.name) as "contactName",
        coalesce(nullif(sl.contact_email, ''), export_contact.email) as "contactEmail",
        coalesce(nullif(sl.contact_phone, ''), export_contact.phone) as "contactPhone",
        sl.gdpr_status as "gdprStatus",
        sl.portal_mapping_status as "portalMappingStatus",
        sl.property_status as "propertyStatus",
        sl.updated_at as "updatedAt",
        p.name as "projectName"
      from seller_listings sl
      left join leads seller_lead
        on seller_lead.workspace_id = sl.workspace_id
       and seller_lead.id = sl.seller_lead_id
      left join contacts export_contact
        on export_contact.workspace_id = sl.workspace_id
       and export_contact.id = coalesce(sl.owner_contact_id, seller_lead.contact_id)
      left join projects p
        on p.workspace_id = sl.workspace_id
       and p.id = sl.project_id
      where sl.workspace_id = $1::uuid
        and sl.id = $2::uuid
        and ${propertyRecordAccessPredicate("sl", "$1", "$3", "$4", "$5")}
      for share of sl
    `,
    [
      workspaceId,
      propertyId,
      actorId,
      hasWorkspacePropertyRecordScope(session),
      hasProjectPropertyRecordScope(session),
    ],
  );
  if (!listing) {
    throw new PropertyExportRuntimeError({
      code: "not_found",
      message: "Property was not found in the permitted record scope.",
    });
  }
  if (listing.projectId && !listing.projectName) {
    throw new PropertyExportRuntimeError({
      code: "invalid_request",
      message: "Property project relation is not tenant-consistent.",
    });
  }

  const units = listing.projectId || listing.unitId
    ? await transaction.query<UnitRow>(
      `
        select
          id,
          unit_number as "unitNumber",
          floor,
          rooms,
          area_sqm as "areaSqm",
          price_cents as "priceCents",
          status
        from property_units
        where workspace_id = $1::uuid
          and (
            ($2::uuid is not null and id = $2::uuid)
            or ($2::uuid is null and $3::uuid is not null and project_id = $3::uuid)
          )
        order by unit_number asc, id asc
      `,
      [workspaceId, listing.unitId, listing.projectId],
    )
    : [];
  if (listing.unitId && !units.some((unit) => unit.id === listing.unitId)) {
    throw new PropertyExportRuntimeError({
      code: "invalid_request",
      message: "Property unit relation is not tenant-consistent.",
    });
  }

  const unitIds = units.map((unit) => unit.id);
  const reservationCount = unitIds.length
    ? await transaction.queryOne<{ count: number | string }>(
      `
        select count(*)::int as count
        from property_reservations
        where workspace_id = $1::uuid
          and unit_id = any($2::uuid[])
          and status in ('hold', 'reserved')
          and expires_at > now()
      `,
      [workspaceId, unitIds],
    )
    : null;
  const buildingCount = listing.projectId
    ? await transaction.queryOne<{ count: number | string }>(
      `
        select count(*)::int as count
        from property_buildings
        where workspace_id = $1::uuid
          and project_id = $2::uuid
      `,
      [workspaceId, listing.projectId],
    )
    : null;

  const texts = await transaction.query<TextRow>(
    `
      select
        id,
        text_key as "textKey",
        channel,
        title,
        content,
        seo_title as "seoTitle",
        seo_description as "seoDescription",
        visibility,
        status,
        position
      from property_text_blocks
      where workspace_id = $1::uuid
        and property_id = $2::uuid
      order by position asc, text_key asc, id asc
    `,
    [workspaceId, propertyId],
  );
  const costs = await transaction.query<CostRow>(
    `
      select
        id,
        cost_key as "costKey",
        group_key as "groupKey",
        label,
        monthly_net_cents as "monthlyNetCents",
        monthly_vat_cents as "monthlyVatCents",
        monthly_gross_cents as "monthlyGrossCents",
        one_time_net_cents as "oneTimeNetCents",
        one_time_vat_cents as "oneTimeVatCents",
        one_time_gross_cents as "oneTimeGrossCents",
        vat_percent as "vatPercent",
        optional,
        expose_visible as "exposeVisible",
        position
      from property_cost_items
      where workspace_id = $1::uuid
        and property_id = $2::uuid
      order by position asc, cost_key asc, id asc
    `,
    [workspaceId, propertyId],
  );
  const media = await transaction.query<MediaRow>(
    `
      select
        pm.id,
        ma.id as "mediaAssetId",
        pm.media_type as "mediaType",
        pm.title,
        pm.alt_text as "altText",
        pm.category,
        pm.visibility,
        pm.is_cover as "isCover",
        pm.position,
        pm.status,
        ma.name as "assetName",
        ma.mime_type as "mimeType"
      from property_media pm
      left join media_assets ma
        on ma.id = pm.media_asset_id
       and ma.workspace_id = pm.workspace_id::text
      where pm.workspace_id = $1::uuid
        and pm.property_id = $2::uuid
      order by pm.is_cover desc, pm.position asc, pm.id asc
    `,
    [workspaceId, propertyId],
  );
  const documents = await transaction.query<DocumentRow>(
    `
      select
        pd.id,
        ma.id as "mediaAssetId",
        pd.title,
        pd.category,
        pd.status,
        pd.visibility,
        pd.required_for_publication as "requiredForPublication",
        ma.name as "assetName",
        ma.mime_type as "mimeType"
      from property_documents pd
      left join media_assets ma
        on ma.id = pd.media_asset_id
       and ma.workspace_id = pd.workspace_id::text
      where pd.workspace_id = $1::uuid
        and pd.property_id = $2::uuid
      order by pd.category asc, pd.id asc
    `,
    [workspaceId, propertyId],
  );

  const normalizedUnits = units.map((unit) => ({
    ...unit,
    floor: Number(unit.floor ?? 0),
  }));
  return {
    buildingCount: Number(buildingCount?.count ?? 0),
    costs: costs.map((item) => ({ ...item, position: Number(item.position ?? 0) })),
    documents,
    listing,
    media: media.map((item) => ({ ...item, position: Number(item.position ?? 0) })),
    project: listing.projectId && listing.projectName
      ? { id: listing.projectId, name: listing.projectName }
      : null,
    texts: texts.map((item) => ({ ...item, position: Number(item.position ?? 0) })),
    unitCounts: {
      activeReservations: Number(reservationCount?.count ?? 0),
      available: normalizedUnits.filter((unit) => unit.status === "available").length,
      reserved: normalizedUnits.filter((unit) => unit.status === "reserved").length,
      sold: normalizedUnits.filter((unit) => unit.status === "sold").length,
      total: normalizedUnits.length,
    },
    units: normalizedUnits,
  };
}

async function hydrateJobs(
  transaction: TenantTransaction,
  workspaceId: string,
  rows: PropertyExportJobRow[],
) {
  const eventsByJob = await loadEventsForTenant(transaction, workspaceId, rows.map((row) => row.id));
  return rows.map((row) => mapJob(row, eventsByJob.get(row.id) ?? []));
}

export async function listPropertyExportJobs(input: {
  limit?: number;
  propertyId: string;
  session: AppSession;
}) {
  requirePropertyExportAccess(input.session);
  requirePersistence();
  const propertyId = requireUuid(input.propertyId, "propertyId");
  const workspaceId = requireUuid(input.session.workspaceId, "workspaceId");
  const actorId = requireUuid(input.session.userId, "actorId");
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 25)));

  return withTenantTransaction(
    { actorId, workspaceId },
    async (transaction) => {
      const rows = await transaction.query<PropertyExportJobRow>(
        `
          select ${jobSelectColumns}
          from property_export_jobs j
          join property_channels c
            on c.workspace_id = j.workspace_id
           and c.id = j.property_channel_id
           and c.property_id = j.property_id
          join seller_listings sl
            on sl.workspace_id = j.workspace_id
           and sl.id = j.property_id
          where j.workspace_id = $1::uuid
            and j.property_id = $2::uuid
            and j.operation = 'qa_test_export'
            and j.provider_key = 'novalure_qa_sink'
            and ${propertyRecordAccessPredicate("sl", "$1", "$4", "$5", "$6")}
          order by j.created_at desc, j.id desc
          limit $3::int
        `,
        [
          workspaceId,
          propertyId,
          limit,
          actorId,
          hasWorkspacePropertyRecordScope(input.session),
          hasProjectPropertyRecordScope(input.session),
        ],
      );
      return hydrateJobs(transaction, workspaceId, rows);
    },
  );
}

export async function getPropertyExportJob(input: {
  jobId: string;
  session: AppSession;
}) {
  requirePropertyExportAccess(input.session);
  requirePersistence();
  const jobId = requireUuid(input.jobId, "jobId");
  const workspaceId = requireUuid(input.session.workspaceId, "workspaceId");
  const actorId = requireUuid(input.session.userId, "actorId");
  return withTenantTransaction(
    { actorId, workspaceId },
    async (transaction) => {
      const row = await transaction.queryOne<PropertyExportJobRow>(
        `
          select ${jobSelectColumns}
          from property_export_jobs j
          join property_channels c
            on c.workspace_id = j.workspace_id
           and c.id = j.property_channel_id
           and c.property_id = j.property_id
          join seller_listings sl
            on sl.workspace_id = j.workspace_id
           and sl.id = j.property_id
          where j.workspace_id = $1::uuid
            and j.id = $2::uuid
            and j.operation = 'qa_test_export'
            and j.provider_key = 'novalure_qa_sink'
            and ${propertyRecordAccessPredicate("sl", "$1", "$3", "$4", "$5")}
          limit 1
        `,
        [
          workspaceId,
          jobId,
          actorId,
          hasWorkspacePropertyRecordScope(input.session),
          hasProjectPropertyRecordScope(input.session),
        ],
      );
      if (!row) return null;
      return (await hydrateJobs(transaction, workspaceId, [row]))[0] ?? null;
    },
  );
}

export async function enqueuePropertyExport(input: {
  idempotencyKey: string;
  language?: LanguageCode;
  propertyId: string;
  scheduledAt?: unknown;
  session: AppSession;
}): Promise<EnqueuePropertyExportResult> {
  requirePropertyExportAccess(input.session);
  requirePersistence();
  const propertyId = requireUuid(input.propertyId, "propertyId");
  const workspaceId = requireUuid(input.session.workspaceId, "workspaceId");
  const actorId = requireUuid(input.session.userId, "actorId");
  const idempotencyKey = input.idempotencyKey.trim();
  if (!isPropertyExportIdempotencyKey(idempotencyKey)) {
    throw new PropertyExportRuntimeError({
      code: "invalid_request",
      message: "A valid Idempotency-Key header is required.",
    });
  }
  const parsedSchedule = parsePropertyExportSchedule(input.scheduledAt, new Date(), {
    enforceWindow: false,
  });
  if (!parsedSchedule.ok) {
    throw new PropertyExportRuntimeError({ code: "invalid_request", message: parsedSchedule.message });
  }

  return withTenantTransaction(
    { actorId, workspaceId },
    async (transaction) => {
      const source = await loadPropertyExportSource(transaction, input.session, propertyId);
      const preflight = runServerPropertyExportPreflight(source, input.language ?? "de");
      if (preflight.status === "blocked") {
        throw new PropertyExportRuntimeError({
          code: "preflight_blocked",
          message: "The server-side property export preflight is blocked.",
          preflight,
        });
      }
      const snapshot = buildPropertyExportSnapshot(source);
      const payloadSha256 = hashPropertyExportSnapshot(snapshot);
      type ExistingExport = {
        id: string;
        operation: string | null;
        payloadSha256: string | null;
        propertyId: string | null;
        providerKey: string | null;
        scheduledAt: string | null;
      };
      const loadExisting = () => transaction.queryOne<ExistingExport>(
        `
          select
            id,
            operation,
            payload_sha256 as "payloadSha256",
            property_id as "propertyId",
            provider_key as "providerKey",
            nullif(metadata ->> 'requestedScheduledAt', '') as "scheduledAt"
          from property_export_jobs
          where workspace_id = $1::uuid
            and idempotency_key = $2
          limit 1
        `,
        [workspaceId, idempotencyKey],
      );
      const assertExistingIdentity = (existing: ExistingExport) => {
        if (
          existing.operation !== PROPERTY_EXPORT_OPERATION ||
          existing.providerKey !== PROPERTY_EXPORT_QA_PROVIDER ||
          existing.propertyId !== propertyId ||
          existing.payloadSha256 !== payloadSha256 ||
          existing.scheduledAt !== parsedSchedule.value.scheduledAt
        ) {
          throw new PropertyExportRuntimeError({
            code: "idempotency_conflict",
            message: "Idempotency-Key is already bound to a different property export snapshot or schedule.",
          });
        }
      };
      const hydrateExisting = async (existing: ExistingExport): Promise<EnqueuePropertyExportResult> => {
        assertExistingIdentity(existing);
        const row = await transaction.queryOne<PropertyExportJobRow>(
          `
            select ${jobSelectColumns}
            from property_export_jobs j
            join property_channels c
              on c.workspace_id = j.workspace_id
             and c.id = j.property_channel_id
             and c.property_id = j.property_id
            where j.workspace_id = $1::uuid
              and j.id = $2::uuid
            limit 1
          `,
          [workspaceId, existing.id],
        );
        if (!row) throw new Error("Idempotent property export could not be reloaded");
        const job = (await hydrateJobs(transaction, workspaceId, [row]))[0];
        if (!job) throw new Error("Idempotent property export could not be hydrated");
        return { created: false, job, preflight };
      };

      const earlyReplay = await loadExisting();
      if (earlyReplay) return hydrateExisting(earlyReplay);

      const creationSchedule = parsePropertyExportSchedule(input.scheduledAt);
      if (!creationSchedule.ok) {
        throw new PropertyExportRuntimeError({ code: "invalid_request", message: creationSchedule.message });
      }
      const runtimeKey = `qa-openimmo:${propertyId}`;
      const channel = await transaction.queryOne<{ id: string; status: PropertyPublicationStatus }>(
        `
          insert into property_channels (
            workspace_id,
            project_id,
            property_id,
            unit_id,
            channel_type,
            channel_name,
            status,
            preflight_checks,
            channel_payload,
            runtime_key,
            metadata
          )
          values (
            $1::uuid,
            $2::uuid,
            $3::uuid,
            $4::uuid,
            'openimmo_export',
            'Novalure Preview QA Sink',
            'queued',
            $5::jsonb,
            jsonb_build_object('payloadSha256', $6::text, 'schema', 'novalure.property-export-snapshot.v1'),
            $7,
            jsonb_build_object(
              'deliveryMode', 'preview_qa_sink',
              'networkRequestPerformed', false,
              'productionPublication', false
            )
          )
          on conflict (workspace_id, runtime_key) where runtime_key is not null
          do update set
            project_id = excluded.project_id,
            property_id = excluded.property_id,
            unit_id = excluded.unit_id,
            preflight_checks = excluded.preflight_checks,
            channel_payload = excluded.channel_payload,
            metadata = property_channels.metadata || excluded.metadata,
            updated_at = now()
          where property_channels.workspace_id = excluded.workspace_id
            and property_channels.property_id = excluded.property_id
          returning id, status
        `,
        [
          workspaceId,
          source.listing.projectId,
          propertyId,
          source.listing.unitId,
          JSON.stringify(preflight.checks),
          payloadSha256,
          runtimeKey,
        ],
      );
      if (!channel) {
        throw new PropertyExportRuntimeError({
          code: "idempotency_conflict",
          message: "The QA channel key is already bound to a different property.",
        });
      }

      // The channel upsert serializes enqueues for one property. Recheck the
      // request key after taking that row lock so concurrent replays stay
      // idempotent and cannot be mistaken for a second active export.
      const serializedReplay = await loadExisting();
      if (serializedReplay) return hydrateExisting(serializedReplay);

      const activeJob = await transaction.queryOne<{ id: string; status: PropertyExportJobStatus }>(
        `
          select id, status
          from property_export_jobs
          where workspace_id = $1::uuid
            and property_channel_id = $2::uuid
            and property_id = $3::uuid
            and operation = 'qa_test_export'
            and provider_key = 'novalure_qa_sink'
            and status in ('queued', 'retry', 'running')
          order by created_at desc, id desc
          limit 1
          for update
        `,
        [workspaceId, channel.id, propertyId],
      );
      if (activeJob) {
        throw new PropertyExportRuntimeError({
          code: "invalid_transition",
          message: `Property export ${activeJob.id} is still ${activeJob.status}. Pause/resume or withdraw it before creating another export.`,
        });
      }

      const inserted = await transaction.queryOne<{ id: string }>(
        `
          insert into property_export_jobs (
            workspace_id,
            property_channel_id,
            project_id,
            property_id,
            unit_id,
            portal,
            export_format,
            status,
            preflight_status,
            started_by_user_id,
            export_history,
            metadata,
            available_at,
            attempt_count,
            max_attempts,
            idempotency_key,
            operation,
            provider_key,
            payload_snapshot,
            payload_sha256,
            snapshot_captured_at,
            result_metadata
          )
          values (
            $1::uuid,
            $2::uuid,
            $3::uuid,
            $4::uuid,
            $5::uuid,
            $6,
            $7,
            'queued',
            $8,
            $9::uuid,
            jsonb_build_array(jsonb_build_object(
              'at', now(),
              'availableAt', $15::timestamptz,
              'scheduledAt', $16::text,
              'status', 'queued',
              'source', 'api'
            )),
            jsonb_build_object(
              'certification', 'none',
              'deliveryMode', 'preview_qa_sink',
              'productionPublication', false,
              'requestedScheduledAt', $16::text,
              'scheduleMode', case when $16::text is null then 'immediate' else 'scheduled' end
            ),
            $15::timestamptz,
            0,
            3,
            $10,
            $11,
            $12,
            $13::jsonb,
            $14,
            now(),
            '{}'::jsonb
          )
          on conflict (workspace_id, idempotency_key) do nothing
          returning id
        `,
        [
          workspaceId,
          channel.id,
          source.listing.projectId,
          propertyId,
          source.listing.unitId,
          PROPERTY_EXPORT_QA_PROVIDER,
          PROPERTY_EXPORT_FORMAT,
          preflight.status,
          actorId,
          idempotencyKey,
          PROPERTY_EXPORT_OPERATION,
          PROPERTY_EXPORT_QA_PROVIDER,
          JSON.stringify(snapshot),
          payloadSha256,
          creationSchedule.value.availableAt,
          creationSchedule.value.scheduledAt,
        ],
      );
      const created = Boolean(inserted);
      const existing = inserted ? null : await loadExisting();
      if (!inserted && existing) assertExistingIdentity(existing);
      if (!inserted && !existing) throw new Error("Property export idempotency row could not be resolved");
      const jobId = inserted?.id ?? existing?.id;
      if (!jobId) throw new Error("Property export idempotency row could not be resolved");

      if (created) {
        await transaction.execute(
          `
            insert into property_export_job_events (
              workspace_id,
              job_id,
              actor_user_id,
              event_type,
              from_status,
              to_status,
              attempt_count,
              request_key,
              message,
              metadata
            )
            values (
              $1::uuid,
              $2::uuid,
              $3::uuid,
              'enqueued',
              null,
              'queued',
              0,
              $4,
              case when $6::text is null
                then 'Preview QA test export queued for immediate processing'
                else 'Preview QA test export scheduled'
              end,
              jsonb_build_object(
                'availableAt', $7::timestamptz,
                'payloadSha256', $5::text,
                'provider', 'novalure_qa_sink',
                'scheduledAt', $6::text
              )
            )
          `,
          [
            workspaceId,
            jobId,
            actorId,
            idempotencyKey,
            payloadSha256,
            creationSchedule.value.scheduledAt,
            creationSchedule.value.availableAt,
          ],
        );
        const queuedChannel = await transaction.queryOne<{ id: string }>(
          `
            update property_channels
            set
              status = 'queued',
              last_export_job_id = $3::uuid,
              metadata = metadata || jsonb_build_object(
                'networkRequestPerformed', false,
                'productionPublication', false,
                'qaScheduledAt', $5::text
              ),
              updated_at = clock_timestamp()
            where workspace_id = $1::uuid
              and id = $2::uuid
              and property_id = $4::uuid
            returning id
          `,
          [workspaceId, channel.id, jobId, propertyId, creationSchedule.value.scheduledAt],
        );
        if (!queuedChannel) throw new Error("Queued property export channel could not be updated");
      }

      const row = await transaction.queryOne<PropertyExportJobRow>(
        `
          select ${jobSelectColumns}
          from property_export_jobs j
          join property_channels c
            on c.workspace_id = j.workspace_id
           and c.id = j.property_channel_id
           and c.property_id = j.property_id
          where j.workspace_id = $1::uuid
            and j.id = $2::uuid
          limit 1
        `,
        [workspaceId, jobId],
      );
      if (!row) throw new Error("Queued property export could not be reloaded");
      const jobs = await hydrateJobs(transaction, workspaceId, [row]);
      const job = jobs[0];
      if (!job) throw new Error("Queued property export could not be hydrated");
      return { created, job, preflight };
    },
  );
}

export async function retryPropertyExportJob(input: {
  idempotencyKey: string;
  jobId: string;
  session: AppSession;
}) {
  requirePropertyExportAccess(input.session);
  requirePersistence();
  const jobId = requireUuid(input.jobId, "jobId");
  const workspaceId = requireUuid(input.session.workspaceId, "workspaceId");
  const actorId = requireUuid(input.session.userId, "actorId");
  const idempotencyKey = input.idempotencyKey.trim();
  if (!isPropertyExportIdempotencyKey(idempotencyKey)) {
    throw new PropertyExportRuntimeError({
      code: "invalid_request",
      message: "A valid Idempotency-Key header is required.",
    });
  }

  return withTenantTransaction(
    { actorId, workspaceId },
    async (transaction) => {
      const current = await transaction.queryOne<{
        channelId: string;
        channelStatus: PropertyPublicationStatus;
        providerKey: string | null;
        status: PropertyExportJobStatus;
      }>(
        `
          select
            c.id as "channelId",
            c.status as "channelStatus",
            j.provider_key as "providerKey",
            j.status
          from property_export_jobs j
          join property_channels c
            on c.workspace_id = j.workspace_id
           and c.id = j.property_channel_id
           and c.property_id = j.property_id
           and c.runtime_key = 'qa-openimmo:' || j.property_id::text
          join seller_listings sl
            on sl.workspace_id = j.workspace_id
           and sl.id = j.property_id
          where j.workspace_id = $1::uuid
            and j.id = $2::uuid
            and j.operation = 'qa_test_export'
            and ${propertyRecordAccessPredicate("sl", "$1", "$3", "$4", "$5")}
          for update of j, c
        `,
        [
          workspaceId,
          jobId,
          actorId,
          hasWorkspacePropertyRecordScope(input.session),
          hasProjectPropertyRecordScope(input.session),
        ],
      );
      if (!current) {
        throw new PropertyExportRuntimeError({ code: "not_found", message: "Property export job was not found." });
      }
      if (current.providerKey !== PROPERTY_EXPORT_QA_PROVIDER) {
        throw new PropertyExportRuntimeError({
          code: "job_not_retryable",
          message: "External portal delivery is launch-off and cannot be retried.",
        });
      }

      const replay = await transaction.queryOne<{ eventType: string; id: string }>(
        `
          select id, event_type as "eventType"
          from property_export_job_events
          where workspace_id = $1::uuid
            and job_id = $2::uuid
            and request_key = $3
          limit 1
        `,
        [workspaceId, jobId, idempotencyKey],
      );
      if (replay && replay.eventType !== "manual_retry_requested") {
        throw new PropertyExportRuntimeError({
          code: "idempotency_conflict",
          message: "Idempotency-Key is already bound to a different property export action.",
        });
      }
      if (!replay) {
        if (current.status !== "failed" && current.status !== "dead_letter") {
          throw new PropertyExportRuntimeError({
            code: "job_not_retryable",
            message: "Only failed or dead-lettered QA exports can be retried.",
          });
        }
        if (current.channelStatus !== "failed") {
          throw new PropertyExportRuntimeError({
            code: "invalid_transition",
            message: "Resume a paused channel, or create a new export for a withdrawn channel, before retrying.",
          });
        }
        const retried = await transaction.queryOne<{ id: string }>(
          `
            update property_export_jobs
            set
              status = 'retry',
              available_at = now(),
              max_attempts = greatest(max_attempts, attempt_count + 1),
              last_error_category = null,
              last_error_message = null,
              error = null,
              dead_lettered_at = null,
              finished_at = null,
              locked_by = null,
              lease_expires_at = null,
              export_history = export_history || jsonb_build_array(
                jsonb_build_object('at', now(), 'status', 'retry', 'source', 'manual')
              ),
              updated_at = now()
            where workspace_id = $1::uuid
              and id = $2::uuid
              and status in ('failed', 'dead_letter')
            returning id
          `,
          [workspaceId, jobId],
        );
        if (!retried) throw new Error("Retry transition was fenced by a concurrent update");
        const queuedChannel = await transaction.queryOne<{ id: string }>(
          `
            update property_channels
            set
              status = 'queued',
              last_export_job_id = $3::uuid,
              metadata = metadata || jsonb_build_object(
                'networkRequestPerformed', false,
                'productionPublication', false,
                'qaRetryRequestedAt', now()
              ),
              updated_at = clock_timestamp()
            where workspace_id = $1::uuid
              and id = $2::uuid
              and property_id = (
                select property_id
                from property_export_jobs
                where workspace_id = $1::uuid and id = $3::uuid
              )
              and status = 'failed'
            returning id
          `,
          [workspaceId, current.channelId, jobId],
        );
        if (!queuedChannel) throw new Error("Retry channel transition was fenced by a concurrent update");
        await transaction.execute(
          `
            insert into property_export_job_events (
              workspace_id,
              job_id,
              actor_user_id,
              event_type,
              from_status,
              to_status,
              attempt_count,
              request_key,
              message
            )
            select
              workspace_id,
              id,
              $3::uuid,
              'manual_retry_requested',
              $4,
              'retry',
              attempt_count,
              $5,
              'Manual Preview QA retry requested'
            from property_export_jobs
            where workspace_id = $1::uuid and id = $2::uuid
          `,
          [workspaceId, jobId, actorId, current.status, idempotencyKey],
        );
      }

      const row = await transaction.queryOne<PropertyExportJobRow>(
        `
          select ${jobSelectColumns}
          from property_export_jobs j
          join property_channels c
            on c.workspace_id = j.workspace_id
           and c.id = j.property_channel_id
           and c.property_id = j.property_id
          where j.workspace_id = $1::uuid and j.id = $2::uuid
          limit 1
        `,
        [workspaceId, jobId],
      );
      if (!row) throw new Error("Retried property export could not be reloaded");
      return {
        job: (await hydrateJobs(transaction, workspaceId, [row]))[0],
        replayed: Boolean(replay),
      };
    },
  );
}

export async function transitionPropertyExportChannel(input: {
  action: unknown;
  expectedChannelStatus: unknown;
  expectedChannelUpdatedAt: unknown;
  idempotencyKey: string;
  jobId: string;
  session: AppSession;
}) {
  requirePropertyExportAccess(input.session);
  requirePersistence();
  const jobId = requireUuid(input.jobId, "jobId");
  const workspaceId = requireUuid(input.session.workspaceId, "workspaceId");
  const actorId = requireUuid(input.session.userId, "actorId");
  const idempotencyKey = input.idempotencyKey.trim();
  const action = parsePropertyExportChannelAction(input.action);
  if (!action) {
    throw new PropertyExportRuntimeError({
      code: "invalid_request",
      message: "A valid property export channel action is required.",
    });
  }
  if (!isPropertyExportIdempotencyKey(idempotencyKey)) {
    throw new PropertyExportRuntimeError({
      code: "invalid_request",
      message: "A valid Idempotency-Key header is required.",
    });
  }
  if (!isPropertyPublicationStatus(input.expectedChannelStatus)) {
    throw new PropertyExportRuntimeError({
      code: "invalid_request",
      message: "expectedChannelStatus is required.",
    });
  }
  if (
    typeof input.expectedChannelUpdatedAt !== "string" ||
    !channelVersionPattern.test(input.expectedChannelUpdatedAt)
  ) {
    throw new PropertyExportRuntimeError({
      code: "invalid_request",
      message: "expectedChannelUpdatedAt must be the exact server-issued channel version.",
    });
  }
  const expectedChannelStatus = input.expectedChannelStatus;
  const expectedChannelUpdatedAt = input.expectedChannelUpdatedAt;

  return withTenantTransaction(
    { actorId, workspaceId },
    async (transaction) => {
      const current = await transaction.queryOne<{
        attemptCount: number | string;
        channelId: string;
        channelStatus: PropertyPublicationStatus;
        channelUpdatedAt: string;
        propertyId: string;
        providerKey: string | null;
        status: PropertyExportJobStatus;
      }>(
        `
          select
            j.attempt_count as "attemptCount",
            c.id as "channelId",
            c.status as "channelStatus",
            to_char(c.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "channelUpdatedAt",
            j.property_id as "propertyId",
            j.provider_key as "providerKey",
            j.status
          from property_export_jobs j
          join property_channels c
            on c.workspace_id = j.workspace_id
           and c.id = j.property_channel_id
           and c.property_id = j.property_id
          join seller_listings sl
            on sl.workspace_id = j.workspace_id
           and sl.id = j.property_id
          where j.workspace_id = $1::uuid
            and j.id = $2::uuid
            and j.operation = 'qa_test_export'
            and ${propertyRecordAccessPredicate("sl", "$1", "$3", "$4", "$5")}
          for update of j, c
        `,
        [
          workspaceId,
          jobId,
          actorId,
          hasWorkspacePropertyRecordScope(input.session),
          hasProjectPropertyRecordScope(input.session),
        ],
      );
      if (!current) {
        throw new PropertyExportRuntimeError({ code: "not_found", message: "Property export job was not found." });
      }
      if (current.providerKey !== PROPERTY_EXPORT_QA_PROVIDER) {
        throw new PropertyExportRuntimeError({
          code: "external_portal_launch_off",
          message: "External portal channels are not configured and remain launch-off.",
        });
      }
      if (!isPropertyPublicationStatus(current.channelStatus)) {
        throw new PropertyExportRuntimeError({
          code: "invalid_transition",
          message: "The stored channel status is not supported by the local QA lifecycle.",
        });
      }

      const replay = await transaction.queryOne<{
        action: string | null;
        eventType: string;
        id: string;
      }>(
        `
          select
            id,
            event_type as "eventType",
            metadata ->> 'action' as action
          from property_export_job_events
          where workspace_id = $1::uuid
            and job_id = $2::uuid
            and request_key = $3
          limit 1
        `,
        [workspaceId, jobId, idempotencyKey],
      );
      if (replay && (replay.eventType !== `channel_${action}` || replay.action !== action)) {
        throw new PropertyExportRuntimeError({
          code: "idempotency_conflict",
          message: "Idempotency-Key is already bound to a different property export action.",
        });
      }

      if (!replay) {
        if (
          current.channelStatus !== expectedChannelStatus ||
          current.channelUpdatedAt !== expectedChannelUpdatedAt
        ) {
          throw new PropertyExportRuntimeError({
            code: "stale_write",
            message: "The channel changed after it was loaded. Reload before applying this action.",
          });
        }
        const transition = resolvePropertyExportChannelTransition({
          action,
          channelStatus: current.channelStatus,
          jobStatus: current.status,
        });
        if (!transition.ok) {
          throw new PropertyExportRuntimeError({
            code: "invalid_transition",
            message: transition.message,
          });
        }
        const nextChannelStatus = transition.value;
        const eventMessage = action === "withdraw"
          ? "Local Preview QA channel withdrawn; no external portal request was made"
          : `Local Preview QA channel action applied: ${action}`;
        const updatedChannel = await transaction.queryOne<{ id: string }>(
          `
            update property_channels
            set
              status = $6,
              metadata = metadata || jsonb_build_object(
                'externalWithdrawalPerformed', false,
                'lastLocalLifecycleAction', $7::text,
                'lastLocalLifecycleActorId', $3::text,
                'lastLocalLifecycleAt', clock_timestamp(),
                'networkRequestPerformed', false,
                'productionPublication', false
              ),
              updated_at = clock_timestamp()
            where workspace_id = $1::uuid
              and id = $2::uuid
              and property_id = $4::uuid
              and status = $5
              and to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') = $8
            returning id
          `,
          [
            workspaceId,
            current.channelId,
            actorId,
            current.propertyId,
            current.channelStatus,
            nextChannelStatus,
            action,
            expectedChannelUpdatedAt,
          ],
        );
        if (!updatedChannel) {
          throw new PropertyExportRuntimeError({
            code: "stale_write",
            message: "The channel changed during the update. Reload before applying this action.",
          });
        }

        const updatedJob = await transaction.queryOne<{
          nextStatus: PropertyExportJobStatus;
        }>(
          `
            update property_export_jobs
            set
              status = case
                when $3 = 'withdraw' and status in ('queued', 'retry') then 'cancelled'
                else status
              end,
              finished_at = case
                when $3 = 'withdraw' and status in ('queued', 'retry') then clock_timestamp()
                else finished_at
              end,
              locked_by = case
                when $3 = 'withdraw' and status in ('queued', 'retry') then null
                else locked_by
              end,
              lease_expires_at = case
                when $3 = 'withdraw' and status in ('queued', 'retry') then null
                else lease_expires_at
              end,
              export_history = export_history || jsonb_build_array(jsonb_build_object(
                'action', $3::text,
                'at', clock_timestamp(),
                'channelStatus', $4::text,
                'source', 'manual_channel_action',
                'status', case
                  when $3 = 'withdraw' and status in ('queued', 'retry') then 'cancelled'
                  else status
                end
              )),
              metadata = metadata || jsonb_build_object(
                'externalWithdrawalPerformed', false,
                'lastLocalLifecycleAction', $3::text,
                'networkRequestPerformed', false,
                'productionPublication', false
              ),
              updated_at = clock_timestamp()
            where workspace_id = $1::uuid
              and id = $2::uuid
              and provider_key = 'novalure_qa_sink'
            returning status as "nextStatus"
          `,
          [workspaceId, jobId, action, nextChannelStatus],
        );
        if (!updatedJob) throw new Error("Property export lifecycle job update was fenced");

        await transaction.execute(
          `
            insert into property_export_job_events (
              workspace_id,
              job_id,
              actor_user_id,
              event_type,
              from_status,
              to_status,
              attempt_count,
              request_key,
              message,
              metadata
            )
            values (
              $1::uuid,
              $2::uuid,
              $3::uuid,
              $4,
              $5,
              $6,
              $7::int,
              $8,
              $9,
              jsonb_build_object(
                'action', $10::text,
                'externalWithdrawalPerformed', false,
                'jobStatusAfter', $11::text,
                'networkRequestPerformed', false,
                'productionPublication', false
              )
            )
          `,
          [
            workspaceId,
            jobId,
            actorId,
            `channel_${action}`,
            current.channelStatus,
            nextChannelStatus,
            Number(current.attemptCount ?? 0),
            idempotencyKey,
            eventMessage,
            action,
            updatedJob.nextStatus,
          ],
        );
      }

      const row = await transaction.queryOne<PropertyExportJobRow>(
        `
          select ${jobSelectColumns}
          from property_export_jobs j
          join property_channels c
            on c.workspace_id = j.workspace_id
           and c.id = j.property_channel_id
           and c.property_id = j.property_id
          where j.workspace_id = $1::uuid
            and j.id = $2::uuid
          limit 1
        `,
        [workspaceId, jobId],
      );
      if (!row) throw new Error("Updated property export could not be reloaded");
      const job = (await hydrateJobs(transaction, workspaceId, [row]))[0];
      if (!job) throw new Error("Updated property export could not be hydrated");
      return { job, replayed: Boolean(replay) };
    },
  );
}

export async function getPropertyExportArtifact(input: {
  jobId: string;
  session: AppSession;
}): Promise<PropertyExportArtifact | null> {
  requirePropertyExportAccess(input.session);
  requirePersistence();
  const jobId = requireUuid(input.jobId, "jobId");
  const workspaceId = requireUuid(input.session.workspaceId, "workspaceId");
  const actorId = requireUuid(input.session.userId, "actorId");
  return withTenantTransaction(
    { actorId, workspaceId },
    async (transaction) => transaction.queryOne<PropertyExportArtifact>(
      `
        select
          artifact_payload as content,
          artifact_content_type as "contentType",
          artifact_filename as filename,
          artifact_sha256 as sha256
        from property_export_jobs j
        join seller_listings sl
          on sl.workspace_id = j.workspace_id
         and sl.id = j.property_id
        where j.workspace_id = $1::uuid
          and j.id = $2::uuid
          and j.operation = 'qa_test_export'
          and j.provider_key = 'novalure_qa_sink'
          and j.status = 'completed'
          and j.artifact_payload is not null
          and j.artifact_content_type is not null
          and j.artifact_filename is not null
          and j.artifact_sha256 is not null
          and ${propertyRecordAccessPredicate("sl", "$1", "$3", "$4", "$5")}
        limit 1
      `,
      [
        workspaceId,
        jobId,
        actorId,
        hasWorkspacePropertyRecordScope(input.session),
        hasProjectPropertyRecordScope(input.session),
      ],
    ),
  );
}

export async function listDuePropertyExportJobIds(input: {
  jobIds?: string[];
  limit?: number;
  workspaceId?: string | null;
} = {}) {
  requirePersistence();
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 25)));
  const workspaceId = input.workspaceId ? requireUuid(input.workspaceId, "workspaceId") : null;
  const jobIds = input.jobIds === undefined
    ? null
    : [...new Set(input.jobIds.map((id) => requireUuid(id, "jobId")))];
  if (jobIds?.length === 0) return [];

  return queryRows<{ actorId: string; id: string; workspaceId: string }>(
    `
      select
        j.id,
        j.workspace_id as "workspaceId",
        j.started_by_user_id as "actorId"
      from property_export_jobs j
      join property_channels c
        on c.workspace_id = j.workspace_id
       and c.id = j.property_channel_id
       and c.property_id = j.property_id
       and c.runtime_key is not null
      join seller_listings sl
        on sl.workspace_id = j.workspace_id
       and sl.id = j.property_id
      join workspace_users wu
        on wu.workspace_id = j.workspace_id
       and wu.id = j.started_by_user_id
       and wu.status = 'active'
      where j.operation = 'qa_test_export'
        and j.provider_key = 'novalure_qa_sink'
        and j.payload_snapshot is not null
        and j.payload_sha256 is not null
        and j.payload_snapshot #>> '{property,id}' = j.property_id::text
        and ($2::uuid is null or j.workspace_id = $2::uuid)
        and ($3::uuid[] is null or j.id = any($3::uuid[]))
        and j.attempt_count < j.max_attempts
        and (
          (j.status in ('queued', 'retry') and c.status = 'queued' and j.available_at <= now())
          or (j.status = 'running' and c.status = 'exporting' and j.lease_expires_at <= now())
        )
      order by j.available_at asc, j.created_at asc, j.id asc
      limit $1::int
    `,
    [limit, workspaceId, jobIds],
  );
}

export async function claimPropertyExportJob(input: {
  actorId: string;
  jobId: string;
  leaseOwner: string;
  workspaceId: string;
}): Promise<ClaimedPropertyExportJob | null> {
  if (!evaluateLaunchScope("propertyExportQueue").allowed) return null;
  requirePersistence();
  const jobId = requireUuid(input.jobId, "jobId");
  const workspaceId = requireUuid(input.workspaceId, "workspaceId");
  const actorId = requireUuid(input.actorId, "actorId");
  if (!input.leaseOwner.trim()) {
    throw new PropertyExportRuntimeError({ code: "invalid_request", message: "leaseOwner is required." });
  }

  return withTenantTransaction(
    { actorId, workspaceId },
    async (transaction) => {
      const membership = await transaction.queryOne<{
        productRole: unknown;
        role: unknown;
      }>(
        `
          select role, product_role as "productRole"
          from workspace_users
          where workspace_id = $1::uuid
            and id = $2::uuid
            and status = 'active'
          limit 1
          for share
        `,
        [workspaceId, actorId],
      );
      if (
        !membership ||
        !isAppRole(membership.role) ||
        !isProductRole(membership.productRole) ||
        !canProcessPropertyExports({
          productRole: membership.productRole,
          role: membership.role,
        })
      ) {
        return null;
      }

      return transaction.queryOne<ClaimedRow>(`
      with candidate as (
        select
          j.id,
          j.status as previous_status,
          c.status as previous_channel_status
        from property_export_jobs j
        join property_channels c
          on c.workspace_id = j.workspace_id
         and c.id = j.property_channel_id
         and c.property_id = j.property_id
         and c.runtime_key is not null
        join seller_listings sl
          on sl.workspace_id = j.workspace_id
         and sl.id = j.property_id
        join workspace_users wu
          on wu.workspace_id = j.workspace_id
         and wu.id = j.started_by_user_id
         and wu.status = 'active'
        where j.id = $1::uuid
          and j.workspace_id = $2::uuid
          and j.started_by_user_id = $4::uuid
          and j.operation = 'qa_test_export'
          and j.provider_key = 'novalure_qa_sink'
          and j.payload_snapshot is not null
          and j.payload_sha256 is not null
          and j.payload_snapshot #>> '{property,id}' = j.property_id::text
          and j.attempt_count < j.max_attempts
          and (
            (j.status in ('queued', 'retry') and c.status = 'queued' and j.available_at <= now())
            or (j.status = 'running' and c.status = 'exporting' and j.lease_expires_at <= now())
          )
        for update of j, c skip locked
      ), claimed as (
        update property_export_jobs j
        set
          status = 'running',
          attempt_count = j.attempt_count + 1,
          locked_by = $3,
          lease_expires_at = now() + interval '45 seconds',
          last_attempt_at = now(),
          started_at = coalesce(j.started_at, now()),
          export_history = j.export_history || jsonb_build_array(
            jsonb_build_object('at', now(), 'status', 'running', 'source', 'worker', 'attempt', j.attempt_count + 1)
          ),
          updated_at = now()
        from candidate
        where j.id = candidate.id
        returning j.*, candidate.previous_status, candidate.previous_channel_status
      ), channel_updated as (
        update property_channels c
        set
          status = 'exporting',
          last_export_job_id = claimed.id,
          metadata = c.metadata || jsonb_build_object(
            'networkRequestPerformed', false,
            'productionPublication', false,
            'qaLastRunStartedAt', now()
          ),
          updated_at = clock_timestamp()
        from claimed
        where c.workspace_id = claimed.workspace_id
          and c.id = claimed.property_channel_id
          and c.property_id = claimed.property_id
          and c.status = claimed.previous_channel_status
        returning c.id
      ), recorded as (
        insert into property_export_job_events (
          workspace_id,
          job_id,
          actor_user_id,
          event_type,
          from_status,
          to_status,
          attempt_count,
          message,
          metadata
        )
        select
          workspace_id,
          id,
          started_by_user_id,
          'worker_claimed',
          previous_status,
          'running',
          attempt_count,
          'Preview QA worker lease claimed',
          jsonb_build_object('leaseOwner', $3::text)
        from claimed
        join channel_updated on channel_updated.id = claimed.property_channel_id
        returning job_id
      )
      select
        c.id,
        c.workspace_id as "workspaceId",
        c.project_id as "projectId",
        c.property_id as "propertyId",
        c.property_channel_id as "propertyChannelId",
        c.started_by_user_id as "startedByUserId",
        c.provider_key as "providerKey",
        c.payload_snapshot as "payloadSnapshot",
        c.payload_sha256 as "payloadSha256",
        c.attempt_count as "attemptCount",
        c.max_attempts as "maxAttempts",
        c.locked_by as "leaseOwner"
      from claimed c
      join recorded r on r.job_id = c.id
      join channel_updated cu on cu.id = c.property_channel_id
      limit 1
    `, [jobId, workspaceId, input.leaseOwner, actorId]);
    },
  );
}

export async function completePropertyExportJob(input: {
  artifact: PropertyExportArtifact;
  job: ClaimedPropertyExportJob;
  providerRequestId: string;
  resultMetadata: Record<string, unknown>;
}) {
  requirePersistence();
  return withTenantTransaction({
    actorId: input.job.startedByUserId,
    workspaceId: input.job.workspaceId,
  }, async (transaction) => {
    const completed = await transaction.queryOne<{
      attemptCount: number | string;
      propertyChannelId: string;
      propertyId: string;
      startedByUserId: string;
      workspaceId: string;
    }>(
      `
        update property_export_jobs
        set
          status = 'completed',
          artifact_payload = $4,
          artifact_sha256 = $5,
          artifact_content_type = $6,
          artifact_filename = $7,
          provider_request_id = $8,
          provider_acknowledged_at = now(),
          payload_reference = 'property-export://qa-sink/' || id::text,
          result_metadata = $9::jsonb,
          error = null,
          last_error_category = null,
          last_error_message = null,
          locked_by = null,
          lease_expires_at = null,
          finished_at = now(),
          export_history = export_history || jsonb_build_array(
            jsonb_build_object('at', now(), 'status', 'completed', 'source', 'worker', 'attempt', attempt_count)
          ),
          updated_at = now()
        where workspace_id = $1::uuid
          and id = $2::uuid
          and status = 'running'
          and locked_by = $3
          and operation = 'qa_test_export'
          and provider_key = 'novalure_qa_sink'
        returning
          workspace_id as "workspaceId",
          property_channel_id as "propertyChannelId",
          property_id as "propertyId",
          started_by_user_id as "startedByUserId",
          attempt_count as "attemptCount"
      `,
      [
        input.job.workspaceId,
        input.job.id,
        input.job.leaseOwner,
        input.artifact.content,
        input.artifact.sha256,
        input.artifact.contentType,
        input.artifact.filename,
        input.providerRequestId,
        JSON.stringify(input.resultMetadata),
      ],
    );
    if (!completed) return false;

    const readyChannel = await transaction.queryOne<{ id: string }>(
      `
        update property_channels
        set
          status = 'ready',
          last_export_job_id = $3::uuid,
          metadata = metadata || jsonb_build_object(
            'qaArtifactSha256', $4::text,
            'qaLastCompletedAt', now(),
            'networkRequestPerformed', false,
            'productionPublication', false
          ),
          updated_at = now()
        where workspace_id = $1::uuid
          and id = $2::uuid
          and property_id = $5::uuid
          and last_export_job_id = $3::uuid
          and status = 'exporting'
        returning id
      `,
      [
        completed.workspaceId,
        completed.propertyChannelId,
        input.job.id,
        input.artifact.sha256,
        completed.propertyId,
      ],
    );
    if (!readyChannel) throw new Error("Completed QA export channel transition was fenced");
    await transaction.execute(
      `
        insert into property_export_job_events (
          workspace_id,
          job_id,
          actor_user_id,
          event_type,
          from_status,
          to_status,
          attempt_count,
          message,
          metadata
        )
        values (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          'qa_artifact_created',
          'running',
          'completed',
          $4::int,
          'Preview QA test export completed; no external portal was contacted',
          jsonb_build_object('artifactSha256', $5::text, 'providerRequestId', $6::text)
        )
      `,
      [
        completed.workspaceId,
        input.job.id,
        completed.startedByUserId,
        completed.attemptCount,
        input.artifact.sha256,
        input.providerRequestId,
      ],
    );
    return true;
  });
}

export async function failPropertyExportJob(input: {
  category: string;
  error: string;
  job: ClaimedPropertyExportJob;
  retryDelaySeconds: number;
}) {
  requirePersistence();
  return withTenantTransaction({
    actorId: input.job.startedByUserId,
    workspaceId: input.job.workspaceId,
  }, async (transaction) => {
    const failed = await transaction.queryOne<{
      attemptCount: number | string;
      nextStatus: PropertyExportJobStatus;
      propertyChannelId: string;
      propertyId: string;
      startedByUserId: string;
      workspaceId: string;
    }>(
      `
        update property_export_jobs
        set
          status = case
            when $4 = 'configuration' then 'failed'
            when attempt_count >= max_attempts then 'dead_letter'
            else 'retry'
          end,
          error = left($5, 500),
          last_error_category = $4,
          last_error_message = left($5, 500),
          available_at = case
            when $4 = 'configuration' or attempt_count >= max_attempts then available_at
            else now() + make_interval(secs => $6::int)
          end,
          dead_lettered_at = case
            when $4 <> 'configuration' and attempt_count >= max_attempts then now()
            else null
          end,
          finished_at = case
            when $4 = 'configuration' or attempt_count >= max_attempts then now()
            else null
          end,
          locked_by = null,
          lease_expires_at = null,
          export_history = export_history || jsonb_build_array(
            jsonb_build_object(
              'at', now(),
              'status', case
                when $4 = 'configuration' then 'failed'
                when attempt_count >= max_attempts then 'dead_letter'
                else 'retry'
              end,
              'source', 'worker',
              'attempt', attempt_count,
              'errorCategory', $4::text
            )
          ),
          updated_at = now()
        where workspace_id = $1::uuid
          and id = $2::uuid
          and status = 'running'
          and locked_by = $3
        returning
          workspace_id as "workspaceId",
          property_channel_id as "propertyChannelId",
          property_id as "propertyId",
          started_by_user_id as "startedByUserId",
          attempt_count as "attemptCount",
          status as "nextStatus"
      `,
      [
        input.job.workspaceId,
        input.job.id,
        input.job.leaseOwner,
        input.category,
        input.error,
        input.retryDelaySeconds,
      ],
    );
    if (!failed) return null;
    const failedChannel = await transaction.queryOne<{ id: string }>(
      `
        update property_channels
        set
          status = case when $4 in ('failed', 'dead_letter') then 'failed' else 'queued' end,
          metadata = metadata || jsonb_build_object(
            'qaLastErrorCategory', $5::text,
            'qaLastFailureAt', now(),
            'networkRequestPerformed', false,
            'productionPublication', false
          ),
          updated_at = clock_timestamp()
        where workspace_id = $1::uuid
          and id = $2::uuid
          and property_id = $3::uuid
          and last_export_job_id = $6::uuid
          and status = 'exporting'
        returning id
      `,
      [
        failed.workspaceId,
        failed.propertyChannelId,
        failed.propertyId,
        failed.nextStatus,
        input.category,
        input.job.id,
      ],
    );
    if (!failedChannel) throw new Error("Failed QA export channel transition was fenced");
    await transaction.execute(
      `
        insert into property_export_job_events (
          workspace_id,
          job_id,
          actor_user_id,
          event_type,
          from_status,
          to_status,
          attempt_count,
          message,
          metadata
        )
        values (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          'worker_failed',
          'running',
          $4,
          $5::int,
          $6,
          jsonb_build_object('errorCategory', $7::text)
        )
      `,
      [
        failed.workspaceId,
        input.job.id,
        failed.startedByUserId,
        failed.nextStatus,
        failed.attemptCount,
        input.error,
        input.category,
      ],
    );
    return failed.nextStatus;
  });
}
