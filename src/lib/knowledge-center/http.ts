import { getRequestSession, resolveWorkspaceScopedSession, type AppSession } from "@/lib/auth/session";
import { CrmCommandError } from "@/lib/crm-command";
import { KnowledgeCenterError, knowledgeId, knowledgeRevision, knowledgeStructured, knowledgeText, knowledgeUrl } from "./policy";
import type { AssignKnowledgeAreasInput, CreateKnowledgeAreaInput, CreateKnowledgeSourceInput, KnowledgeChannel, KnowledgeContentInput, KnowledgeSourceType, QueryKnowledgeCenterInput, UpdateKnowledgeSourceInput } from "./types";

export const knowledgePrivateHeaders = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};
export const maxKnowledgeJsonBytes = 256 * 1024;

export function knowledgeJson(value: unknown, status = 200) {
  return Response.json(value, { headers: knowledgePrivateHeaders, status });
}

export function knowledgeErrorResponse(error: unknown): Response {
  if (error instanceof KnowledgeCenterError || error instanceof CrmCommandError) {
    return knowledgeJson({ error: error.message, code: error.code }, error.status);
  }
  const sqlCode = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (["23505", "40001", "40P01"].includes(sqlCode)) return knowledgeJson({ error: "The record changed. Reload and retry.", code: "CONFLICT" }, 409);
  if (["23503", "23514", "22P02"].includes(sqlCode)) return knowledgeJson({ error: "Invalid knowledge value or relationship.", code: "VALIDATION_ERROR" }, 400);
  if (sqlCode === "42501") return knowledgeJson({ error: "Knowledge access is not granted.", code: "FORBIDDEN" }, 403);
  return knowledgeJson({ error: "Knowledge Center is temporarily unavailable.", code: "KNOWLEDGE_UNAVAILABLE" }, 503);
}

export function assertKnowledgeFields(body: Record<string, unknown>, fields: readonly string[]) {
  if (Object.keys(body).some((key) => !fields.includes(key))) {
    throw new KnowledgeCenterError("UNKNOWN_FIELD", "Unknown knowledge request field.");
  }
}

export function knowledgeQueryParams(request: Request, allowed: readonly string[]) {
  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) {
    if ((!allowed.includes(key) && key !== "workspaceId") || params.getAll(key).length !== 1) throw new KnowledgeCenterError("UNKNOWN_FIELD", "Unknown or duplicate knowledge query parameter.");
  }
  return params;
}

/** Limits the actual streamed bytes, including chunked requests and false Content-Length values. */
export async function readKnowledgeBytes(request: Request, maxBytes: number) {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBytes)) {
    throw new KnowledgeCenterError("PAYLOAD_TOO_LARGE", "Knowledge request exceeds the size limit.", 413);
  }
  if (!request.body) throw new KnowledgeCenterError("INVALID_JSON", "A JSON object is required.");
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
        throw new KnowledgeCenterError("PAYLOAD_TOO_LARGE", "Knowledge request exceeds the size limit.", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function readKnowledgeJson(request: Request, fields: readonly string[], maxBytes = maxKnowledgeJsonBytes) {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new KnowledgeCenterError("JSON_REQUIRED", "Content-Type application/json is required.", 415);
  }
  const bytes = await readKnowledgeBytes(request, maxBytes);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new KnowledgeCenterError("INVALID_JSON", "A valid JSON object is required."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new KnowledgeCenterError("INVALID_JSON", "A JSON object is required.");
  const body = value as Record<string, unknown>;
  assertKnowledgeFields(body, fields);
  return body;
}

export async function withKnowledgeRequest(request: Request, callback: (session: AppSession) => Promise<Response>) {
  try {
    const cookies = (request.headers.get("cookie") ?? "").split(";").map((part) => part.trim().split("=", 1)[0]);
    if (cookies.filter((name) => name === "novalure_session").length > 1) return knowledgeJson({ error: "An unambiguous workspace session is required.", code: "UNAUTHENTICATED" }, 401);
    const originSession = await getRequestSession(request);
    // Knowledge never accepts preview identities or caller-selected identity headers.
    if (!originSession?.authenticated || originSession.source !== "cookie" || !originSession.authSessionId || !originSession.authIdentityId) {
      return knowledgeJson({ error: "An authenticated workspace session is required.", code: "UNAUTHENTICATED" }, 401);
    }
    const params = new URL(request.url).searchParams;
    if (params.getAll("workspaceId").length > 1) throw new KnowledgeCenterError("INVALID_TENANT", "A single workspace selector is required.");
    // The selector is only a request: the resolver rechecks explicit membership,
    // target role, MFA and durable audit before returning target authority.
    const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:read" });
    if (!auth.ok) {
      const response = auth.response;
      for (const [key, value] of Object.entries(knowledgePrivateHeaders)) response.headers.set(key, value);
      return response;
    }
    knowledgeId(auth.session.workspaceId, "workspace");
    knowledgeId(auth.session.userId, "user");
    return await callback(auth.session);
  } catch (error) { return knowledgeErrorResponse(error); }
}

export const knowledgeContentFields = ["name", "content", "structuredData", "url", "mediaAssetId"] as const;

function optionalId(value: unknown, label: string) {
  return value === undefined || value === null ? null : knowledgeId(value, label);
}
function oneOf<Value extends string>(value: unknown, values: readonly Value[], label: string): Value {
  if (typeof value !== "string" || !values.includes(value as Value)) throw new KnowledgeCenterError("VALIDATION_ERROR", `Invalid ${label}.`);
  return value as Value;
}
function ids(value: unknown, label: string) {
  if (!Array.isArray(value) || value.length > 100) throw new KnowledgeCenterError("VALIDATION_ERROR", `Invalid ${label}.`);
  const values = value.map((item) => knowledgeId(item, label));
  if (new Set(values).size !== values.length) throw new KnowledgeCenterError("VALIDATION_ERROR", `Duplicate ${label}.`);
  return values;
}
export function knowledgeChannel(value: unknown) {
  return oneOf<KnowledgeChannel>(value, ["webchat", "whatsapp", "instagram", "messenger", "email", "internal", "voice", "telephone"], "channel");
}
export function parseKnowledgeArea(body: Record<string, unknown>): CreateKnowledgeAreaInput {
  return { name: knowledgeText(body.name, "name", 160), kind: oneOf(body.kind, ["company", "business", "project"] as const, "kind"), projectId: optionalId(body.projectId, "projectId"), ...(body.description === undefined ? {} : { description: knowledgeText(body.description, "description", 2000, false) }) };
}
function parseKnowledgeContent(body: Record<string, unknown>): Partial<KnowledgeContentInput> {
  return {
    ...(body.name === undefined ? {} : { name: knowledgeText(body.name, "name", 200) }),
    ...(body.content === undefined ? {} : { content: knowledgeText(body.content, "content", 100_000, false) }),
    ...(body.structuredData === undefined ? {} : { structuredData: knowledgeStructured(body.structuredData) }),
    ...(body.url === undefined ? {} : { url: knowledgeUrl(body.url) }),
    ...(body.mediaAssetId === undefined ? {} : { mediaAssetId: optionalId(body.mediaAssetId, "mediaAssetId") }),
  };
}
export function parseKnowledgeSource(body: Record<string, unknown>): CreateKnowledgeSourceInput {
  return { ...parseKnowledgeContent(body), name: knowledgeText(body.name, "name", 200), areaId: knowledgeId(body.areaId, "areaId"), type: oneOf<KnowledgeSourceType>(body.type, ["manual", "faq", "structured", "url", "file"], "type") };
}
export function parseKnowledgeVersion(body: Record<string, unknown>): UpdateKnowledgeSourceInput {
  if (!knowledgeContentFields.some((field) => body[field] !== undefined)) throw new KnowledgeCenterError("VALIDATION_ERROR", "A knowledge content change is required.");
  return { ...parseKnowledgeContent(body), sourceId: knowledgeId(body.sourceId, "sourceId"), expectedVersion: knowledgeRevision(body.expectedVersion) };
}
export function parseKnowledgeAssignment(body: Record<string, unknown>): AssignKnowledgeAreasInput {
  return { botId: knowledgeId(body.botId, "botId"), channel: knowledgeChannel(body.channel), areaIds: ids(body.areaIds, "areaIds") };
}
export function parseKnowledgeQuery(body: Record<string, unknown>): QueryKnowledgeCenterInput {
  const limit = body.limit;
  if (limit !== undefined && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 20)) throw new KnowledgeCenterError("VALIDATION_ERROR", "limit must be an integer from 1 to 20.");
  return { query: knowledgeText(body.query, "query", 2000), ...(body.botId === undefined ? {} : { botId: knowledgeId(body.botId, "botId") }), ...(body.channel === undefined ? {} : { channel: knowledgeChannel(body.channel) }), ...(body.areaIds === undefined ? {} : { areaIds: ids(body.areaIds, "areaIds") }), ...(limit === undefined ? {} : { limit: limit as number }) };
}
