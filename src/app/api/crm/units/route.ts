import { NextResponse } from "next/server";
import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import type { PropertyUnitStatus } from "@/lib/crm-types";
import { loadPaginatedPropertyUnits } from "@/lib/db/crm-loaders";
import {
  createPropertyBuildingRecord,
  createPropertyUnitRecord,
} from "@/lib/db/property-inventory-repositories";
import {
  getInventoryValidationMessage,
  validateInventoryInput,
  type InventoryOperation,
} from "@/lib/inventory-validation";
import { evaluateLaunchScope } from "@/lib/launch-scope";

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
  const operationValue = typeof input.operation === "string" ? input.operation : "unit";
  if (operationValue !== "building" && operationValue !== "unit") {
    return NextResponse.json({ error: "Invalid inventory operation" }, { status: 400 });
  }
  const operation: InventoryOperation = operationValue;
  const requestedStatus = typeof input.status === "string" ? input.status.trim() : "";
  if (operation === "unit" && requestedStatus && requestedStatus !== "available") {
    const launchScope = evaluateLaunchScope("propertyReservationRelationshipSync");
    if (!launchScope.allowed) {
      return NextResponse.json(
        { code: launchScope.code, error: "property_relationship_mutation_launch_off", persisted: false },
        { headers: { "Cache-Control": "private, no-store" }, status: 503 },
      );
    }
  }
  if (operation === "unit" && ("price" in input || "priceCents" in input)) {
    return NextResponse.json(
      { error: "Unit prices must be sent as priceEuros; price and priceCents are not accepted" },
      { status: 400 },
    );
  }
  const operationId = request.headers.get("idempotency-key")?.trim() ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) {
    return NextResponse.json({ error: "A valid idempotency key is required" }, { status: 400 });
  }
  const validationErrors = validateInventoryInput(operation, input, { requireUuidIds: true });
  if (validationErrors.length > 0) {
    const validation = validationErrors[0];
    return NextResponse.json(
      {
        error: getInventoryValidationMessage(validation.code, "en"),
        validation,
      },
      { status: 400 },
    );
  }
  const result =
    operation === "building"
      ? await createPropertyBuildingRecord({
          address: input.address,
          completionDate: input.completionDate,
          floors: input.floors,
          name: input.name,
          operationId,
          projectId: input.projectId,
          session: auth.session,
        })
      : await createPropertyUnitRecord({
          areaSqm: input.areaSqm,
          buildingId: input.buildingId,
          floor: input.floor,
          operationId,
          priceEuros: input.priceEuros,
          projectId: input.projectId,
          rooms: input.rooms,
          session: auth.session,
          status: input.status,
          unitNumber: input.unitNumber,
        });

  if (!result.persisted) {
    return NextResponse.json(
      { error: result.reason },
      { status: result.conflict ? 409 : 400 },
    );
  }

  return NextResponse.json({ data: result.data, persisted: true });
}
