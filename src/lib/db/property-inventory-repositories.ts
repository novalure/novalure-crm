import { createHash } from "node:crypto";
import type { AppSession } from "@/lib/auth/session";
import type { PropertyBuilding, PropertyUnit } from "@/lib/crm-types";
import { canPersist, isUuid } from "@/lib/db/runtime-repositories";
import { withTenantTransaction } from "@/lib/db/tenant-client";
import {
  getInventoryValidationMessage,
  parseEuroAmountToCents,
  validateInventoryInput,
} from "@/lib/inventory-validation";

type RepositoryWriteResult<T> =
  | { data: T; persisted: true }
  | { conflict?: boolean; persisted: false; reason: string };

type BuildingRow = {
  address: string;
  completionDate: string | Date | null;
  floors: number | string;
  id: string;
  name: string;
  projectId: string;
  workspaceId: string;
  writeApplied?: boolean;
};

type BuildingOperationRow = {
  requestHash: string;
  response: BuildingRow;
  writeApplied: boolean;
};

type UnitRow = {
  areaSqm: number | string;
  buildingId: string | null;
  buyerContactId: string | null;
  dealId: string | null;
  floor: number | string;
  id: string;
  priceCents: number | string;
  projectId: string;
  rooms: number | string;
  status: PropertyUnit["status"];
  unitNumber: string;
  updatedAt: string | Date;
  workspaceId: string;
};

type UnitOperationRow = {
  requestHash: string;
  response: UnitRow;
  writeApplied: boolean;
};

const unitStatuses: PropertyUnit["status"][] = ["available", "reserved", "sold", "blocked"];

export async function createPropertyBuildingRecord(input: {
  address?: unknown;
  completionDate?: unknown;
  floors?: unknown;
  name?: unknown;
  operationId: string;
  projectId?: unknown;
  session: AppSession;
}): Promise<RepositoryWriteResult<PropertyBuilding>> {
  const validation = validateInventoryInput("building", input, { requireUuidIds: true })[0];
  if (validation) {
    return { persisted: false, reason: getInventoryValidationMessage(validation.code, "en") };
  }
  const projectId = cleanString(input.projectId);
  if (
    !canPersist() ||
    !isUuid(input.session.workspaceId) ||
    !isUuid(input.session.userId) ||
    !isUuid(projectId) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.operationId)
  ) {
    return { persisted: false, reason: "Building input is incomplete" };
  }

  const name = cleanString(input.name);
  const address = cleanString(input.address);
  const completionDate = cleanString(input.completionDate) || null;
  const floors = toNumber(input.floors, 0);
  const requestHash = createHash("sha256")
    .update(JSON.stringify({ address, completionDate, floors, name, projectId }))
    .digest("hex");
  const row = await withTenantTransaction(
    { actorId: input.session.userId, workspaceId: input.session.workspaceId },
    async (transaction) => {
      // Acquire the lock in its own statement. PostgreSQL READ COMMITTED takes a
      // fresh snapshot for the following statement after a concurrent holder
      // commits, so an exact replay can see the newly committed ledger row.
      await transaction.execute(
        `select pg_advisory_xact_lock(hashtextextended($1::text || ':property_building:' || $2::text, 0))`,
        [input.session.workspaceId, input.operationId],
      );
      const operation = await transaction.queryOne<BuildingOperationRow>(
        `
      with operation_lock as materialized (
        select pg_advisory_xact_lock(
          hashtextextended($1::text || ':property_building:' || $8::text, 0)
        )
      ),
      existing_operation as materialized (
        select
          operation.request_hash as "requestHash",
          operation.response,
          false as "writeApplied"
        from operation_lock
        cross join property_building_idempotency operation
        where operation.workspace_id = $1::uuid
          and operation.idempotency_key = $8::text
        limit 1
      ),
      inserted as (
        insert into property_buildings (
          workspace_id,
          project_id,
          name,
          address,
          completion_date,
          floors,
          metadata
        )
        select
          $1::uuid,
          p.id,
          $3,
          $4,
          $5::date,
          $6,
          $7::jsonb
        from projects p
        cross join operation_lock
        where p.id = $2::uuid
          and p.workspace_id = $1::uuid
          and not exists (select 1 from existing_operation)
        returning
          id,
          workspace_id as "workspaceId",
          project_id as "projectId",
          name,
          address,
          completion_date as "completionDate",
          floors,
          true as "writeApplied"
      ),
      recorded_operation as (
        insert into property_building_idempotency (
          workspace_id,
          project_id,
          idempotency_key,
          request_hash,
          building_id,
          response
        )
        select
          $1::uuid,
          building."projectId",
          $8::text,
          $9::text,
          building.id,
          jsonb_build_object(
            'address', building.address,
            'completionDate', building."completionDate",
            'floors', building.floors,
            'id', building.id,
            'name', building.name,
            'projectId', building."projectId",
            'workspaceId', building."workspaceId"
          )
        from inserted building
        returning
          request_hash as "requestHash",
          response,
          true as "writeApplied"
      )
      select * from existing_operation
      union all
      select * from recorded_operation
      limit 1
        `,
        [
          input.session.workspaceId,
          projectId,
          name,
          address,
          completionDate,
          floors,
          JSON.stringify({ source: "unit_board", updatedByUserId: input.session.userId }),
          input.operationId,
          requestHash,
        ],
      );
      if (operation?.writeApplied) {
        const auditData = toBuilding(operation.response);
        await transaction.execute(
          `
            insert into audit_logs (
              workspace_id, project_id, actor_user_id, action, entity_type, entity_id, before, after
            )
            values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid, null, $7::jsonb)
          `,
          [
            input.session.workspaceId,
            auditData.projectId,
            input.session.userId,
            "property_building.created",
            "property_building",
            auditData.id,
            JSON.stringify(auditData),
          ],
        );
      }
      return operation;
    },
  );

  if (!row) return { persisted: false, reason: "Project does not belong to this workspace" };

  if (row.requestHash !== requestHash) {
    return {
      conflict: true,
      persisted: false,
      reason: "Idempotency key was already used for a different building request",
    };
  }

  const data = toBuilding(row.response);

  return { data, persisted: true };
}

export async function createPropertyUnitRecord(input: {
  areaSqm?: unknown;
  buildingId?: unknown;
  floor?: unknown;
  operationId: string;
  priceEuros?: unknown;
  projectId?: unknown;
  rooms?: unknown;
  session: AppSession;
  status?: unknown;
  unitNumber?: unknown;
}): Promise<RepositoryWriteResult<PropertyUnit>> {
  const validation = validateInventoryInput("unit", input, { requireUuidIds: true })[0];
  if (validation) {
    return { persisted: false, reason: getInventoryValidationMessage(validation.code, "en") };
  }
  const projectId = cleanString(input.projectId);
  if (
    !canPersist() ||
    !isUuid(input.session.workspaceId) ||
    !isUuid(input.session.userId) ||
    !isUuid(projectId) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.operationId)
  ) {
    return { persisted: false, reason: "Unit input is incomplete" };
  }

  const unitNumber = cleanString(input.unitNumber);

  const status = unitStatuses.includes(input.status as PropertyUnit["status"])
    ? input.status as PropertyUnit["status"]
    : "available";
  const floor = toNumber(input.floor, 0);
  const rooms = toNumber(input.rooms, 0);
  const areaSqm = toNumber(input.areaSqm, 0);
  const priceCents = parseEuroAmountToCents(input.priceEuros) ?? 0;
  const rawBuildingId = cleanString(input.buildingId);
  const buildingId = isUuid(rawBuildingId) ? rawBuildingId : null;
  const requestHash = createHash("sha256")
    .update(JSON.stringify({
      areaSqm,
      buildingId,
      floor,
      priceCents,
      projectId,
      rooms,
      status,
      unitNumber,
    }))
    .digest("hex");
  const row = await withTenantTransaction(
    { actorId: input.session.userId, workspaceId: input.session.workspaceId },
    async (transaction) => {
      await transaction.execute(
        `select pg_advisory_xact_lock(hashtextextended($1::text || ':property_unit:' || $2::text, 0))`,
        [input.session.workspaceId, input.operationId],
      );
      const operation = await transaction.queryOne<UnitOperationRow>(
        `
      with operation_lock as materialized (
        select pg_advisory_xact_lock(
          hashtextextended($1::text || ':property_unit:' || $11::text, 0)
        )
      ),
      existing_operation as materialized (
        select
          operation.request_hash as "requestHash",
          operation.response,
          false as "writeApplied"
        from operation_lock
        cross join property_unit_idempotency operation
        where operation.workspace_id = $1::uuid
          and operation.idempotency_key = $11::text
        limit 1
      ),
      upserted as (
        insert into property_units (
          workspace_id,
          project_id,
          building_id,
          unit_number,
          floor,
          rooms,
          area_sqm,
          price_cents,
          status,
          metadata
        )
        select
          $1::uuid,
          p.id,
          b.id,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10::jsonb
        from projects p
        cross join operation_lock
        left join property_buildings b
          on b.id = $3::uuid
          and b.workspace_id = p.workspace_id
          and b.project_id = p.id
        where p.id = $2::uuid
          and p.workspace_id = $1::uuid
          and ($3::uuid is null or b.id is not null)
          and not exists (select 1 from existing_operation)
        on conflict (workspace_id, project_id, unit_number)
        do update set
          building_id = excluded.building_id,
          floor = excluded.floor,
          rooms = excluded.rooms,
          area_sqm = excluded.area_sqm,
          price_cents = excluded.price_cents,
          status = excluded.status,
          metadata = property_units.metadata || excluded.metadata,
          updated_at = now()
        where property_units.workspace_id = excluded.workspace_id
          and property_units.project_id = excluded.project_id
        returning
          id,
          workspace_id as "workspaceId",
          project_id as "projectId",
          building_id as "buildingId",
          unit_number as "unitNumber",
          floor,
          rooms,
          area_sqm as "areaSqm",
          price_cents as "priceCents",
          status,
          buyer_contact_id as "buyerContactId",
          deal_id as "dealId",
          updated_at as "updatedAt"
      ),
      recorded_operation as (
        insert into property_unit_idempotency (
          workspace_id,
          project_id,
          idempotency_key,
          request_hash,
          unit_id,
          response
        )
        select
          $1::uuid,
          unit."projectId",
          $11::text,
          $12::text,
          unit.id,
          jsonb_build_object(
            'areaSqm', unit."areaSqm",
            'buildingId', unit."buildingId",
            'buyerContactId', unit."buyerContactId",
            'dealId', unit."dealId",
            'floor', unit.floor,
            'id', unit.id,
            'priceCents', unit."priceCents",
            'projectId', unit."projectId",
            'rooms', unit.rooms,
            'status', unit.status,
            'unitNumber', unit."unitNumber",
            'updatedAt', unit."updatedAt",
            'workspaceId', unit."workspaceId"
          )
        from upserted unit
        returning
          request_hash as "requestHash",
          response,
          true as "writeApplied"
      )
      select * from existing_operation
      union all
      select * from recorded_operation
      limit 1
        `,
        [
          input.session.workspaceId,
          projectId,
          buildingId,
          unitNumber,
          floor,
          rooms,
          areaSqm,
          priceCents,
          status,
          JSON.stringify({ source: "unit_board", updatedByUserId: input.session.userId }),
          input.operationId,
          requestHash,
        ],
      );
      if (operation?.writeApplied) {
        const auditData = toUnit(operation.response);
        await transaction.execute(
          `
            insert into audit_logs (
              workspace_id, project_id, actor_user_id, action, entity_type, entity_id, before, after
            )
            values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid, null, $7::jsonb)
          `,
          [
            input.session.workspaceId,
            auditData.projectId,
            input.session.userId,
            "property_unit.upserted",
            "property_unit",
            auditData.id,
            JSON.stringify(auditData),
          ],
        );
      }
      return operation;
    },
  );

  if (!row) return { persisted: false, reason: "Unit project or building is outside this workspace" };

  if (row.requestHash !== requestHash) {
    return {
      conflict: true,
      persisted: false,
      reason: "Idempotency key was already used for a different unit request",
    };
  }

  const data = toUnit(row.response);

  return { data, persisted: true };
}

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function toNumber(value: unknown, fallback: number) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(",", "."));
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function toBuilding(row: BuildingRow): PropertyBuilding {
  return {
    address: row.address,
    completionDate: normalizeDate(row.completionDate),
    floors: Number(row.floors ?? 0),
    id: row.id,
    name: row.name,
    projectId: row.projectId,
    workspaceId: row.workspaceId,
  };
}

function toUnit(row: UnitRow): PropertyUnit {
  return {
    areaSqm: Number(row.areaSqm ?? 0),
    buildingId: row.buildingId ?? "",
    buyerContactId: row.buyerContactId ?? undefined,
    dealId: row.dealId ?? undefined,
    floor: Number(row.floor ?? 0),
    id: row.id,
    priceCents: Number(row.priceCents ?? 0),
    projectId: row.projectId,
    rooms: Number(row.rooms ?? 0),
    status: row.status,
    unitNumber: row.unitNumber,
    updatedAt: normalizeDate(row.updatedAt),
    workspaceId: row.workspaceId,
  };
}

function normalizeDate(value: string | Date | null) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}
