import type { AppSession } from "../auth/session";
import { hasProductCapability } from "../product-model";
import type { KnowledgePermissions } from "./types";

export class KnowledgeCenterError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) { super(message); this.name = "KnowledgeCenterError"; }
}
export function knowledgePermissions(session: AppSession): KnowledgePermissions {
  const admin = session.role === "owner" || session.role === "admin";
  const write = session.permissions.includes("crm:write");
  return { canWrite: write, canPublish: admin && hasProductCapability(session.productRole, "knowledge:write"), canAssign: admin && hasProductCapability(session.productRole, "knowledge:write") };
}
export function requireKnowledgePermission(session: AppSession, permission: keyof KnowledgePermissions) {
  if (!knowledgePermissions(session)[permission]) throw new KnowledgeCenterError("FORBIDDEN", "Knowledge permission is required", 403);
}
export function knowledgeId(value: unknown, label = "id"): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new KnowledgeCenterError("VALIDATION_ERROR", `Invalid ${label}`);
  return value;
}
export function knowledgeText(value: unknown, label: string, max: number, required = true): string {
  if (typeof value !== "string" || value.length > max || (required && !value.trim()) || value.includes("\u0000")) throw new KnowledgeCenterError("VALIDATION_ERROR", `Invalid ${label}`);
  return value.trim();
}
export function knowledgeRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new KnowledgeCenterError("VERSION_REQUIRED", "A current expectedVersion is required", 409);
  return Number(value);
}
export function knowledgeUrl(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const text = knowledgeText(value, "url", 2048);
  let url: URL;
  try { url = new URL(text); } catch { throw new KnowledgeCenterError("VALIDATION_ERROR", "Invalid URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new KnowledgeCenterError("VALIDATION_ERROR", "An HTTP(S) URL without credentials is required");
  return url.toString();
}
export function knowledgeStructured(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new KnowledgeCenterError("VALIDATION_ERROR", "structuredData must be a JSON object");
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { throw new KnowledgeCenterError("VALIDATION_ERROR", "Invalid structuredData"); }
  if (encoded.length > 100_000 || encoded.includes("\\u0000")) throw new KnowledgeCenterError("VALIDATION_ERROR", "structuredData is too large or invalid");
  return JSON.parse(encoded) as Record<string, unknown>;
}
