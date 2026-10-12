import { NextResponse } from "next/server";
import { requirePermissionAndProductCapability } from "@/lib/auth/session";
import {
  createWebsiteIntegration,
  listWebsiteIntegrations,
  updateWebsiteIntegrationStatus,
  type WebsiteIntegrationInput,
} from "@/lib/db/external-integration-repositories";

const maxBodyBytes = 32_768;

export async function GET(request: Request) {
  const auth = await requirePermissionAndProductCapability(request, "crm:read", "settings:manage");
  if (!auth.ok) return auth.response;
  return NextResponse.json({ integrations: await listWebsiteIntegrations(auth.session) });
}

export async function POST(request: Request) {
  const auth = await requirePermissionAndProductCapability(request, "crm:write", "settings:manage");
  if (!auth.ok) return auth.response;
  try {
    const body = await readJson(request) as WebsiteIntegrationInput;
    const integration = await createWebsiteIntegration(auth.session, body);
    return NextResponse.json({ integration, status: "test" }, { status: 201 });
  } catch (error) {
    return safeFailure(error);
  }
}

export async function PATCH(request: Request) {
  const auth = await requirePermissionAndProductCapability(request, "crm:write", "settings:manage");
  if (!auth.ok) return auth.response;
  try {
    const body = await readJson(request) as { integrationId?: string; status?: "test" | "active" | "disabled" | "revoked" };
    if (!body.integrationId || !body.status) throw new Error("Integration and status are required");
    const integration = await updateWebsiteIntegrationStatus(auth.session, {
      integrationId: body.integrationId,
      status: body.status,
    });
    if (!integration) return NextResponse.json({ error: "Integration not found" }, { status: 404 });
    return NextResponse.json({ integration });
  } catch (error) {
    return safeFailure(error);
  }
}

async function readJson(request: Request) {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new Error("JSON body required");
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > maxBodyBytes) throw new Error("Request is too large");
  const raw = await request.text();
  if (!raw || Buffer.byteLength(raw, "utf8") > maxBodyBytes) throw new Error("Invalid request body");
  return JSON.parse(raw) as unknown;
}

function safeFailure(error: unknown) {
  const message = error instanceof Error ? error.message : "Integration request failed";
  const clientMessage = /invalid|required|not found|too large|exceeds/i.test(message)
    ? message
    : "Integration request failed";
  return NextResponse.json({ error: clientMessage }, { status: 400 });
}
