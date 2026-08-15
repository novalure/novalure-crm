import { NextResponse } from "next/server";
import { requirePermissionAndProductCapability } from "@/lib/auth/session";
import { mutateUnitReservation, type ReservationWorkflowAction } from "@/lib/db/reservation-repositories";

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function parseAction(value: unknown): ReservationWorkflowAction | null {
  return value === "create" || value === "extend" || value === "expire" || value === "convert" ? value : null;
}

function parseOptionalString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function parseOptionalNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

export async function POST(request: Request) {
  const auth = await requirePermissionAndProductCapability(request, "crm:write", "reservations:write");
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const action = parseAction(input.action);
  if (!action) {
    return NextResponse.json({ error: "Unsupported reservation action" }, { status: 400 });
  }

  const result = await mutateUnitReservation({
    session: auth.session,
    input: {
      action,
      contactId: parseOptionalString(input.contactId),
      contractMilestone: parseOptionalString(input.contractMilestone),
      createTask: input.createTask === true,
      dealId: parseOptionalString(input.dealId),
      depositCents: parseOptionalNumber(input.depositCents),
      expiresAt: parseOptionalString(input.expiresAt),
      nextAction: parseOptionalString(input.nextAction),
      notifyTeams: input.notifyTeams === true,
      reservationId: parseOptionalString(input.reservationId),
      unitId: parseOptionalString(input.unitId),
    },
  });

  if (!result.persisted) {
    const status = result.reason?.toLowerCase().includes("database_url") ? 503 : 400;
    return NextResponse.json({ error: result.reason }, { status });
  }

  return NextResponse.json(result);
}

export async function PATCH(request: Request) {
  return POST(request);
}
