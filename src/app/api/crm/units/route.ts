import { NextResponse } from "next/server";
import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import type { PropertyUnitStatus } from "@/lib/crm-types";
import { loadPaginatedPropertyUnits } from "@/lib/db/crm-loaders";
import {
  createPropertyBuildingRecord,
  createPropertyUnitRecord,
} from "@/lib/db/property-inventory-repositories";
import { assertCrmFields, assertProjectGrant, crmCommandErrorResponse, crmRequestMetadata, withCrmRead } from "@/lib/crm-command";

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
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const integer = Math.trunc(parsed);
  if (integer < min) return fallback;
  return Math.min(max, integer);
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

  try {
  const result = await withCrmRead(auth.session, async (tx, session) => {
    if (projectId) await assertProjectGrant(tx, session, projectId);
    return loadPaginatedPropertyUnits(session.workspaceId, {
    limit: parseIntegerParam(url.searchParams.get("limit"), 50, 1, 200),
    offset: parseIntegerParam(url.searchParams.get("offset"), 0, 0, 100_000),
    projectId,
    q: url.searchParams.get("q")?.trim().slice(0, 100) || null,
    status,
    });
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
  } catch (error) { return crmCommandErrorResponse(error); }
}

export async function POST(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, {
    permission: "crm:write",
    capability: "reservations:write",
  });
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  try {
  assertCrmFields(input, ["operation","address","completionDate","floors","name","projectId","areaSqm","buildingId","floor","price","priceCents","rooms","status","unitNumber","unitId","expectedVersion","idempotencyKey","correlationId"]);
  const meta = crmRequestMetadata(request, input);
  const operation = typeof input.operation === "string" ? input.operation : "unit";
  if (operation !== "unit" && operation !== "building") return NextResponse.json({ error: "Invalid operation", code: "INVALID_OPERATION" }, { status: 400 });
  const result =
    operation === "building"
      ? await createPropertyBuildingRecord({
          ...meta,
          address: input.address,
          completionDate: input.completionDate,
          floors: input.floors,
          name: input.name,
          projectId: input.projectId,
          session: auth.session,
        })
      : await createPropertyUnitRecord({
          ...meta,
          unitId: input.unitId,
          expectedVersion: input.expectedVersion,
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

  return NextResponse.json({ ...result, contractVersion: "1", correlationId: meta.correlationId });
  } catch (error) { return crmCommandErrorResponse(error, request.headers.get("x-correlation-id") ?? undefined); }
}
