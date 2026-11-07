import "server-only";

import type { AppPermission } from "@/lib/auth/permissions";
import { CrmCommandError, crmCommandErrorResponse } from "@/lib/crm-command";
import { requireKnowledgeBotSession } from "@/lib/knowledge-center/http";
import { WEBSITE_SERVICE_CATALOG, type WebsiteService } from "./catalog";
import type { AiBookingInput } from "./repository";

const privateHeaders = {
  "cache-control": "private, no-store",
  vary: "Cookie",
  "x-content-type-options": "nosniff",
};

export function aiBillingJson(data: unknown, status = 200) {
  return Response.json({ data, persisted: true }, { status, headers: privateHeaders });
}

function privateResponse(response: Response) {
  for (const [name, value] of Object.entries(privateHeaders)) response.headers.set(name, value);
  return response;
}

export function aiBillingErrorResponse(error: unknown) {
  return privateResponse(crmCommandErrorResponse(error));
}

/** Billing accepts durable browser sessions, never demo or caller identity headers. */
export async function requireAiBillingSession(request: Request, permission: AppPermission) {
  const auth = await requireKnowledgeBotSession(request, permission);
  if (!auth.ok) return { ok: false as const, response: privateResponse(auth.response) };
  for (const [key] of new URL(request.url).searchParams) {
    if (key !== "workspaceId") throw new CrmCommandError("UNKNOWN_FIELD", "Unknown billing query parameter");
  }
  return auth;
}

export async function readAiBookingRequest(request: Request): Promise<AiBookingInput> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new CrmCommandError("JSON_REQUIRED", "Content-Type application/json is required", 415);
  }
  const requestId = request.headers.get("idempotency-key");
  if (!requestId || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(requestId)) {
    throw new CrmCommandError("IDEMPOTENCY_REQUIRED", "A UUID v4 Idempotency-Key is required");
  }
  const maxBytes = 8_192;
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maxBytes)) {
    throw new CrmCommandError("PAYLOAD_TOO_LARGE", "Billing request exceeds the size limit", 413);
  }
  if (!request.body) throw new CrmCommandError("INVALID_JSON", "A JSON object is required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new CrmCommandError("PAYLOAD_TOO_LARGE", "Billing request exceeds the size limit", 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let body: unknown;
  try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new CrmCommandError("INVALID_JSON", "A valid JSON object is required"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new CrmCommandError("INVALID_JSON", "A JSON object is required");
  }
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["kind", "itemId", "catalogVersion", "notes", "requestedServices"].includes(key))) {
    throw new CrmCommandError("UNKNOWN_FIELD", "Unknown billing request field");
  }
  if ((input.kind !== "plan" && input.kind !== "topup" && input.kind !== "website") || typeof input.itemId !== "string" || !/^[a-z0-9_]{1,64}$/u.test(input.itemId) ||
    typeof input.catalogVersion !== "string" || !input.catalogVersion || input.catalogVersion.length > 120) {
    throw new CrmCommandError("VALIDATION_ERROR", "Choose a current AI package or credit bundle");
  }
  const services: readonly string[] = WEBSITE_SERVICE_CATALOG.services;
  if (input.kind !== "website" && ("notes" in input || "requestedServices" in input)) {
    throw new CrmCommandError("UNKNOWN_FIELD", "Website details are only accepted for website enquiries");
  }
  if (input.kind === "website" && (input.itemId !== "real_estate_website" ||
    (input.notes !== undefined && (typeof input.notes !== "string" || input.notes.length > 2_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(input.notes))) ||
    (input.requestedServices !== undefined && (!Array.isArray(input.requestedServices) || input.requestedServices.length > 4 ||
      input.requestedServices.some((service) => typeof service !== "string" || !services.includes(service)) ||
      new Set(input.requestedServices).size !== input.requestedServices.length)))) {
    throw new CrmCommandError("VALIDATION_ERROR", "Check the website enquiry details");
  }
  return { requestId, kind: input.kind, itemId: input.itemId, expectedCatalogVersion: input.catalogVersion,
    ...(typeof input.notes === "string" ? { notes: input.notes.trim() } : {}),
    ...(Array.isArray(input.requestedServices) ? { requestedServices: input.requestedServices as WebsiteService[] } : {}) };
}
