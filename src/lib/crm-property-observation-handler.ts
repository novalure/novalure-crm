import "server-only";
import { getCrmMachineBearer } from "./crm-machine-auth";
import { CrmCommandError } from "./crm-command";
import type { TenantTransactionOptions } from "./db/tenant-client";
import { PROPERTY_OBSERVATION_FIELDS, type PropertyObservationField } from "./crm-property-observation";
import { assertVerifiedPropertyReaderIdentity, verifyPropertyReaderIdentity } from "./crm-property-observation-auth";
import { readPropertyObservationFromAuthorizedContext } from "./crm-property-observation-reader";
import { propertyObservationPool } from "./crm-property-observation-pool";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type RequestBody = { workspaceId: string; projectId: string; unitId: string; fields: PropertyObservationField[] };
type Options = TenantTransactionOptions & { testVerifier?: NonNullable<Parameters<typeof verifyPropertyReaderIdentity>[1]> };

async function boundedJson(request: Request): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 4096)) throw new CrmCommandError("INVALID_CRM_REQUEST", "Invalid request body", 400);
  if (!request.body) throw new CrmCommandError("INVALID_CRM_REQUEST", "Invalid request body", 400);
  const reader = request.body.getReader(); const pieces: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 4096) { await reader.cancel(); throw new CrmCommandError("INVALID_CRM_REQUEST", "Invalid request body", 400); }
      pieces.push(part.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const piece of pieces) { bytes.set(piece, offset); offset += piece.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof CrmCommandError) throw error;
    throw new CrmCommandError("INVALID_CRM_REQUEST", "Invalid request body", 400);
  } finally { reader.releaseLock(); }
}

function requestBody(raw: unknown): RequestBody {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new CrmCommandError("INVALID_CRM_REQUEST", "Invalid request body", 400);
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== "fields,projectId,unitId,workspaceId" ||
      ![value.workspaceId,value.projectId,value.unitId].every(item => typeof item === "string" && uuid.test(item)) ||
      !Array.isArray(value.fields) || value.fields.length < 1 || value.fields.length > PROPERTY_OBSERVATION_FIELDS.length ||
      new Set(value.fields).size !== value.fields.length || value.fields.some(item => typeof item !== "string" || !PROPERTY_OBSERVATION_FIELDS.includes(item as PropertyObservationField))) {
    throw new CrmCommandError("INVALID_CRM_REQUEST", "Invalid request body", 400);
  }
  return { workspaceId: (value.workspaceId as string).toLowerCase(), projectId: (value.projectId as string).toLowerCase(), unitId: (value.unitId as string).toLowerCase(), fields: [...value.fields] as PropertyObservationField[] };
}

/** Default-deny HTTP entry point. No property-reader identity or grant is seeded. */
export async function handlePropertyObservation(request: Request, options: Options = {}): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  try {
    if (request.method !== "POST" || request.headers.has("cookie") || request.headers.has("origin")) throw new CrmCommandError("CRM_NOT_ACCESSIBLE", "Property observation is not accessible", 403);
    const token = getCrmMachineBearer(request.headers);
    if (!token) throw new Error("CRM_PROPERTY_AUTH_DENIED");
    const identity = await verifyPropertyReaderIdentity(token, options.testVerifier);
    const body = requestBody(await boundedJson(request));
    if (options.pool && process.env.NODE_ENV !== "test") throw new Error("CRM_PROPERTY_DB_UNAVAILABLE");
    const database = options.pool ?? await propertyObservationPool();
    const result = await readPropertyObservationFromAuthorizedContext(identity, body, database);
    assertVerifiedPropertyReaderIdentity(identity);
    result.assertCurrent();
    return Response.json(result.observation, { status: 200, headers });
  } catch (error) {
    const status = error instanceof CrmCommandError ? (error.status === 400 ? 400 : error.status === 503 ? 503 : 403)
      : error instanceof Error && error.message === "CRM_PROPERTY_AUTH_DENIED" ? 401 : 503;
    const code = status === 400 ? "INVALID_CRM_REQUEST" : status === 401 ? "CRM_PROPERTY_AUTH_DENIED" : status === 403 ? "CRM_NOT_ACCESSIBLE" : "CRM_PROPERTY_UNAVAILABLE";
    return Response.json({ code }, { status, headers });
  }
}
