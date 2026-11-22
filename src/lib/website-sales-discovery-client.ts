"use client";
import { z } from "zod";
import { csrfFetch } from "./security/csrf-client";
import { assertSalesWriteBarrier } from "./website-sales-write-barrier";
import { websiteSalesDiscoveryCandidateSchema, websiteSalesDiscoveryContract, websiteSalesDiscoveryRegisterSchema,
  type WebsiteSalesDiscoveryCandidate, type WebsiteSalesDiscoveryMatch, type WebsiteSalesDiscoveryReceipt, type WebsiteSalesDiscoveryRegister } from "./website-sales-discovery";

export class DiscoveryBrowserError extends Error { constructor(readonly outcome: "DENIED" | "UNKNOWN", readonly code: string) { super(code); } }
const path = "/api/crm/website-sales/discovery";
function key(workspaceId: string, actorId: string) { z.uuid().parse(workspaceId); z.uuid().parse(actorId); return `novalure.website-sales-discovery.pending.v1:${actorId}:${workspaceId}`; }
export function discoveryPending(workspaceId: string, actorId: string): WebsiteSalesDiscoveryRegister | null {
  const raw = window.sessionStorage.getItem(key(workspaceId, actorId));
  if (raw === null) return null;
  try { if (raw.length > 65536) throw Error(); return websiteSalesDiscoveryRegisterSchema.parse(JSON.parse(raw)); }
  catch { throw new DiscoveryBrowserError("UNKNOWN", "DISCOVERY_RECOVERY_INVALID"); }
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort((a,b)=>a.localeCompare(b)).filter(key=>record[key]!==undefined).map(key=>`${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}
async function digest(value: unknown): Promise<string> { const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value))); return Array.from(new Uint8Array(bytes), byte=>byte.toString(16).padStart(2,"0")).join(""); }
async function validateReceipt(raw: unknown, workspaceId: string, input: WebsiteSalesDiscoveryRegister): Promise<WebsiteSalesDiscoveryReceipt> {
  const value = raw as Record<string, unknown>, data = value?.data as WebsiteSalesDiscoveryReceipt | undefined;
  if (value.contractVersion !== websiteSalesDiscoveryContract || value.workspaceId !== workspaceId || value.projectId !== input.projectId || value.correlationId !== input.correlationId
    || value.persisted !== true || !data || data.identity?.workspaceId !== workspaceId || data.identity.projectId !== input.projectId
    || !z.uuid().safeParse(data.identity.companyId).success || !z.uuid().safeParse(data.identity.locationId).success || !z.number().int().positive().safeParse(data.locationVersion).success
    || data.contactId !== null && !z.uuid().safeParse(data.contactId).success || data.canContact !== false
    || !z.uuid().safeParse(value.commandId).success || !z.uuid().safeParse(value.auditReference).success || typeof value.replayed !== "boolean"
    || data.candidateDigest !== await digest(input.candidate) || await digest(data.candidate) !== data.candidateDigest || await digest(data.decision) !== await digest(input.decision)
    || input.decision.companyId && data.identity.companyId !== input.decision.companyId || input.decision.locationId && data.identity.locationId !== input.decision.locationId
    || input.decision.contactId && data.contactId !== input.decision.contactId) throw new DiscoveryBrowserError("UNKNOWN", "DISCOVERY_RECEIPT_INVALID");
  return data;
}
async function post(workspaceId: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await csrfFetch(`${path}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  let value: Record<string, unknown>;
  try { value = await response.json() as Record<string, unknown>; } catch { throw new DiscoveryBrowserError("UNKNOWN", "DISCOVERY_RESPONSE_UNKNOWN"); }
  if (!response.ok) throw new DiscoveryBrowserError(response.status >= 500 ? "UNKNOWN" : "DENIED", typeof value.code === "string" ? value.code : "DISCOVERY_UNAVAILABLE");
  return value;
}
export async function matchDiscovery(workspaceId: string, projectId: string, candidate: WebsiteSalesDiscoveryCandidate): Promise<WebsiteSalesDiscoveryMatch> {
  const value = await post(workspaceId, { contractVersion: websiteSalesDiscoveryContract, operation: "match", projectId, candidate });
  if (value.contractVersion !== websiteSalesDiscoveryContract || value.workspaceId !== workspaceId || value.projectId !== projectId
    || !["MATCH", "AMBIGUOUS", "NEW"].includes(String(value.status)) || !z.hash("sha256").safeParse(value.matchDigest).success
    || !Array.isArray(value.companies) || !Array.isArray(value.locations) || !Array.isArray(value.contacts) || !Array.isArray(value.existingLeads) || value.canContact !== false)
    throw new DiscoveryBrowserError("DENIED", "DISCOVERY_MATCH_INVALID");
  return value as unknown as WebsiteSalesDiscoveryMatch;
}
export function parseDiscoveryImport(raw: string, scope?: { workspaceId: string; projectId: string }): WebsiteSalesDiscoveryCandidate[] {
  if (new TextEncoder().encode(raw).byteLength > 65536) throw Error("DISCOVERY_IMPORT_TOO_LARGE");
  const parsed: unknown = JSON.parse(raw), value = parsed as { candidates?: unknown; workspaceId?: unknown; projectId?: unknown };
  if (scope && value?.candidates && (value.workspaceId !== undefined && value.workspaceId !== scope.workspaceId || value.projectId !== undefined && value.projectId !== scope.projectId)) throw Error("DISCOVERY_IMPORT_SCOPE_MISMATCH");
  return z.array(websiteSalesDiscoveryCandidateSchema).min(1).max(25).parse(Array.isArray(parsed) ? parsed : value?.candidates ?? [parsed]);
}
/** Unknown outcomes retain exact original bytes across remount/reload; reconciliation never creates a new operation ID. */
export async function registerDiscovery(workspaceId: string, actorId: string, input?: WebsiteSalesDiscoveryRegister): Promise<WebsiteSalesDiscoveryReceipt> {
  assertSalesWriteBarrier("discovery", workspaceId, actorId);
  const storageKey = key(workspaceId, actorId), pending = discoveryPending(workspaceId, actorId);
  if (input && pending) throw new DiscoveryBrowserError("DENIED", "DISCOVERY_RECONCILIATION_REQUIRED");
  const command = websiteSalesDiscoveryRegisterSchema.parse(input ?? pending);
  if (input) window.sessionStorage.setItem(storageKey, JSON.stringify(command));
  try {
    if (!input) {
      const receipt = await post(workspaceId, { ...command, operation: "reconcile" });
      if (receipt.status === "COMMITTED") {
        const data = await validateReceipt(receipt, workspaceId, command); window.sessionStorage.removeItem(storageKey); window.sessionStorage.removeItem(storageKey+":not-found"); return data;
      }
      if (receipt.status === "NOT_FOUND") { window.sessionStorage.setItem(storageKey+":not-found", JSON.stringify(command)); throw new DiscoveryBrowserError("UNKNOWN", "DISCOVERY_NOT_FOUND"); }
      throw new DiscoveryBrowserError("UNKNOWN", "DISCOVERY_RECONCILIATION_UNKNOWN");
    }
    const value = await post(workspaceId, { ...command, operation: "register" });
    const data = await validateReceipt(value, workspaceId, command); window.sessionStorage.removeItem(storageKey); window.sessionStorage.removeItem(storageKey+":not-found"); return data;
  } catch (error) {
    if (input && error instanceof DiscoveryBrowserError && error.outcome === "DENIED") window.sessionStorage.removeItem(storageKey);
    if (!input && error instanceof DiscoveryBrowserError && error.outcome === "DENIED") throw new DiscoveryBrowserError("UNKNOWN", error.code);
    throw error instanceof DiscoveryBrowserError ? error : new DiscoveryBrowserError("UNKNOWN", "DISCOVERY_RESPONSE_UNKNOWN");
  }
}
/** A separate user action may retry only the exact original after actual NOT_FOUND reconciliation. */
export async function retryDiscoveryOriginal(workspaceId: string, actorId: string): Promise<WebsiteSalesDiscoveryReceipt> {
  assertSalesWriteBarrier("discovery",workspaceId,actorId);
  const storageKey=key(workspaceId,actorId), original=discoveryPending(workspaceId,actorId);
  if(!original||window.sessionStorage.getItem(storageKey+":not-found")!==JSON.stringify(original))throw new DiscoveryBrowserError("UNKNOWN","DISCOVERY_RECONCILIATION_REQUIRED");
  try { const value=await post(workspaceId,original),data=await validateReceipt(value,workspaceId,original);window.sessionStorage.removeItem(storageKey);window.sessionStorage.removeItem(storageKey+":not-found");return data; }
  catch(error){throw error instanceof DiscoveryBrowserError?new DiscoveryBrowserError("UNKNOWN",error.code):new DiscoveryBrowserError("UNKNOWN","DISCOVERY_RESPONSE_UNKNOWN");}
}
