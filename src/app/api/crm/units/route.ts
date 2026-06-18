import { NextResponse } from "next/server";
import { requirePermissionAndProductCapability, resolveWorkspaceScopedSession } from "@/lib/auth/session";
import type { PropertyUnitStatus } from "@/lib/crm-types";
import { loadPaginatedPropertyUnits } from "@/lib/db/crm-loaders";
import {
  createPropertyBuildingRecord,
  createPropertyUnitRecord,
} from "@/lib/db/property-inventory-repositories";

const propertyUnitStatuses: PropertyUnitStatus[] = ["available", "reserved", "sold", "blocked"];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function parseIntegerParam(value: string | null, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function parseProjectId(value: string | null) {
  if (!value) return null;
  return uuidPattern.test(value) ? value : undefined;
}

function parseStatus(value: string | null) {
  if (!value) return null;
  return propertyUnitStatuses.includes(value as PropertyUnitStatus) ? (value as PropertyUnitStatus) : undefined;
}

export async function GET(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" });
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const projectId = parseProjectId(url.searchParams.get("projectId"));
  if (projectId === undefined) {
    return NextResponse.json({ error: "Invalid projectId" }, { status: 400 });
  }

  const status = parseStatus(url.searchParams.get("status"));
  if (status === undefined) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  const result = await loadPaginatedPropertyUnits(auth.session.workspaceId, {
    limit: parseIntegerParam(url.searchParams.get("limit"), 50, 1, 200),
    offset: parseIntegerParam(url.searchParams.get("offset"), 0, 0, 100_000),
    projectId,
    q: url.searchParams.get("q")?.trim().slice(0, 100) || null,
    status,
  });

  return NextResponse.json({
    data: { units: result.units },
    filters: {
      projectId,
      q: url.searchParams.get("q")?.trim().slice(0, 100) || null,
      status,
    },
    pagination: result.pagination,
    persisted: true,
    source: "database",
    summary: result.summary,
  });
}

export async function POST(request: Request) {
  const auth = await requirePermissionAndProductCapability(request, "crm:write", "reservations:write");
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const operation = typeof input.operation === "string" ? input.operation : "unit";
  const result =
    operation === "building"
      ? await createPropertyBuildingRecord({
          address: input.address,
          completionDate: input.completionDate,
          floors: input.floors,
          name: input.name,
          projectId: input.projectId,
          session: auth.session,
        })
      : await createPropertyUnitRecord({
          areaSqm: input.areaSqm,
          buildingId: input.buildingId,
          floor: input.floor,
          price: input.price,
          priceCents: input.priceCents,
          projectId: input.projectId,
          rooms: input.rooms,
          session: auth.session,
          status: input.status,
          unitNumber: input.unitNumber,
        });

  if (!result.persisted) {
    return NextResponse.json({ error: result.reason }, { status: 400 });
  }

  return NextResponse.json({ data: result.data, persisted: true });
}
