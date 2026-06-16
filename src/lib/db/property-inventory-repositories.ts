import type { AppSession } from "@/lib/auth/session";
import type { PropertyBuilding, PropertyUnit } from "@/lib/crm-types";
import { queryOne } from "@/lib/db/client";
import { canPersist, isUuid, writeAuditLog } from "@/lib/db/runtime-repositories";

type RepositoryWriteResult<T> =
  | { data: T; persisted: true }
  | { persisted: false; reason: string };

type BuildingRow = {
  address: string;
  completionDate: string | Date | null;
  floors: number | string;
  id: string;
  name: string;
  projectId: string;
  workspaceId: string;
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

const unitStatuses: PropertyUnit["status"][] = ["available", "reserved", "sold", "blocked"];

export async function createPropertyBuildingRecord(input: {
  address?: unknown;
  completionDate?: unknown;
  floors?: unknown;
  name?: unknown;
  projectId?: unknown;
  session: AppSession;
}): Promise<RepositoryWriteResult<PropertyBuilding>> {
  const projectId = cleanString(input.projectId);
  if (!canPersist() || !isUuid(input.session.workspaceId) || !isUuid(projectId)) {
    return { persisted: false, reason: "Building input is incomplete" };
  }

  const name = cleanString(input.name) || "Gebäude";
  const row = await queryOne<BuildingRow>(
    `
      insert into property_buildings (
        workspace_id,
        project_id,
        name,
        address,
        completion_date,
        floors,
        metadata
      )
      values ($1, $2, $3, $4, $5::date, $6, $7::jsonb)
      returning
        id,
        workspace_id as "workspaceId",
        project_id as "projectId",
        name,
        address,
        completion_date as "completionDate",
        floors
    `,
    [
      input.session.workspaceId,
      projectId,
      name,
      cleanString(input.address),
      cleanString(input.completionDate) || null,
      toNumber(input.floors, 0),
      JSON.stringify({ source: "unit_board", updatedByUserId: input.session.userId }),
    ],
  );

  if (!row) return { persisted: false, reason: "Building could not be saved" };

  const data = toBuilding(row);
  await writeAuditLog({
    action: "property_building.created",
    after: data,
    entityId: row.id,
    entityType: "property_building",
    projectId: row.projectId,
    session: input.session,
  });

  return { data, persisted: true };
}

export async function createPropertyUnitRecord(input: {
  areaSqm?: unknown;
  buildingId?: unknown;
  floor?: unknown;
  price?: unknown;
  priceCents?: unknown;
  projectId?: unknown;
  rooms?: unknown;
  session: AppSession;
  status?: unknown;
  unitNumber?: unknown;
}): Promise<RepositoryWriteResult<PropertyUnit>> {
  const projectId = cleanString(input.projectId);
  if (!canPersist() || !isUuid(input.session.workspaceId) || !isUuid(projectId)) {
    return { persisted: false, reason: "Unit input is incomplete" };
  }

  const unitNumber = cleanString(input.unitNumber);
  if (!unitNumber) return { persisted: false, reason: "Unit number is required" };

  const status = unitStatuses.includes(input.status as PropertyUnit["status"])
    ? input.status as PropertyUnit["status"]
    : "available";
  const priceCents = toPriceCents(input.priceCents ?? input.price);
  const rawBuildingId = cleanString(input.buildingId);
  const buildingId = isUuid(rawBuildingId) ? rawBuildingId : null;
  const row = await queryOne<UnitRow>(
    `
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
      values ($1, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10::jsonb)
      on conflict (project_id, unit_number)
      do update set
        building_id = excluded.building_id,
        floor = excluded.floor,
        rooms = excluded.rooms,
        area_sqm = excluded.area_sqm,
        price_cents = excluded.price_cents,
        status = excluded.status,
        metadata = property_units.metadata || excluded.metadata,
        updated_at = now()
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
    `,
    [
      input.session.workspaceId,
      projectId,
      buildingId,
      unitNumber,
      toNumber(input.floor, 0),
      toNumber(input.rooms, 0),
      toNumber(input.areaSqm, 0),
      priceCents,
      status,
      JSON.stringify({ source: "unit_board", updatedByUserId: input.session.userId }),
    ],
  );

  if (!row) return { persisted: false, reason: "Unit could not be saved" };

  const data = toUnit(row);
  await writeAuditLog({
    action: "property_unit.upserted",
    after: data,
    entityId: row.id,
    entityType: "property_unit",
    projectId: row.projectId,
    session: input.session,
  });

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

function toPriceCents(value: unknown) {
  const parsed = toNumber(value, 0);
  return Math.round(parsed > 999_999 ? parsed : parsed * 100);
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
