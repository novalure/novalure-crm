import { NextResponse } from "next/server";
import { requirePermissionAndProductCapability } from "@/lib/auth/session";
import {
  createPropertyBuildingRecord,
  createPropertyUnitRecord,
} from "@/lib/db/property-inventory-repositories";

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
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
