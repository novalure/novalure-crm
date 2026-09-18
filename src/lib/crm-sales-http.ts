import type { AppSession } from "@/lib/auth/session";
import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { assertCrmUuid, assertProjectGrant, CrmCommandError, crmCommandErrorResponse, crmRequestMetadata, executeCrmCommand, reconcileCrmCommand, withCrmRead, type CrmCommandInput, type TenantTransactionOptions } from "@/lib/crm-command";
import type { ProductCapability } from "@/lib/product-model";

export type SalesHttpRequest = { target: string; method: string; body: Record<string, unknown>; idempotencyKey: string; correlationId: string };
const scopes: Record<string, { table: string; entity: string; capability: ProductCapability }> = {
  contacts: { table: "contacts", entity: "contact", capability: "workspace:operate" },
  tasks: { table: "tasks", entity: "task", capability: "workspace:operate" },
  projects: { table: "projects", entity: "project", capability: "settings:manage" },
  leads: { table: "leads", entity: "lead", capability: "pipeline:write" },
  deals: { table: "deals", entity: "deal", capability: "pipeline:write" },
};
class RejectedWrite extends Error { constructor(readonly response: { status: number; body: unknown }) { super("CRM write rejected"); } }
/** Exact original HTTP request, including query selectors, is part of the effect digest. */
export async function salesHttpCommand(session: AppSession, input: SalesHttpRequest, options: TenantTransactionOptions = {}): Promise<CrmCommandInput> {
  const url = new URL(input.target, "https://crm.invalid");
  const match = /^\/api\/crm\/(contacts|tasks|projects|leads|deals)(?:\/([0-9a-f-]+)\/stage)?$/.exec(url.pathname);
  if (!input.target.startsWith("/") || input.target.startsWith("//") || !match || !["POST", "PATCH", "DELETE"].includes(input.method) || (match[2] && match[1] !== "deals") || (input.method === "DELETE" && match[1] !== "contacts")) throw new CrmCommandError("UNSUPPORTED_OPERATION", "Unsupported CRM write target");
  if (!input.body || typeof input.body !== "object" || Array.isArray(input.body)) throw new CrmCommandError("INVALID_REQUEST", "JSON object required");
  const rule = scopes[match[1]];
  const candidate = input.body[rule.entity];
  const entity = candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate as Record<string, unknown> : input.body;
  const id = match[2] ?? entity.id ?? input.body.contactId ?? url.searchParams.get("id") ?? url.searchParams.get(rule.entity + "Id");
  const resourceId = typeof id === "string" && id ? assertCrmUuid(id, "resourceId") : undefined;
  const expected = input.body.expectedVersion ?? entity.version;
  const expectedVersion = expected === undefined ? undefined : Number.isSafeInteger(expected) && typeof expected === "number" ? expected : (() => { throw new CrmCommandError("VERSION_REQUIRED", "Invalid expectedVersion"); })();
  const requestedProject = typeof entity.projectId === "string" && entity.projectId ? assertCrmUuid(entity.projectId, "projectId") : undefined;
  return withCrmRead(session, async (tx, fresh) => {
    let projectId = requestedProject;
    if (resourceId) {
      const row = await tx.queryOne<{ projectId: string | null }>(`select ${rule.table === "projects" ? "id" : "project_id"} as "projectId" from ${rule.table} where workspace_id=$1::uuid and id=$2::uuid`, [fresh.workspaceId, resourceId]);
      if (!row) throw new CrmCommandError("CRM_NOT_ACCESSIBLE", "Record is unavailable", 404);
      if (row.projectId) await assertProjectGrant(tx, fresh, row.projectId, true);
      projectId = requestedProject ?? row.projectId ?? undefined;
    }
    if (projectId) await assertProjectGrant(tx, fresh, projectId, true);
    if (!projectId && rule.table !== "projects") {
      const manager = await tx.queryOne<{ allowed: boolean }>("select crm_workspace_manager($1::uuid) as allowed", [fresh.workspaceId]);
      if (!manager?.allowed) throw new CrmCommandError("PROJECT_REQUIRED", "An explicit authorized project is required", 403);
    }
    return { operation: `legacy_http.${match[1]}.${match[2] ? "stage." : ""}${input.method.toLowerCase()}`, resourceId, projectId, expectedVersion, idempotencyKey: input.idempotencyKey, correlationId: input.correlationId, capability: match[1] === "contacts" && (input.method === "DELETE" || input.body.action === "archive") ? "settings:manage" : rule.capability, payload: { target: input.target, method: input.method, body: input.body, correlationId: input.correlationId } };
  }, options);
}
export async function executeSalesHttp(session: AppSession, input: SalesHttpRequest, callback: (freshSession: AppSession) => Promise<Response>, options: TenantTransactionOptions = {}): Promise<Response> {
  try {
    return await withCrmRead(session, async () => {
      const command = await salesHttpCommand(session, input, options);
      const receipt = await executeCrmCommand(session, command, async (_tx, context) => {
        const response = await callback(context.session);
        const body: unknown = await response.json();
        if (!response.ok) throw new RejectedWrite({ status: response.status, body });
        return { status: response.status, body };
      }, options);
      return Response.json({ ...(receipt.data.body as object), replayed: receipt.replayed, auditReference: receipt.auditReference, commandId: receipt.commandId }, { status: receipt.data.status });
    }, options);
  } catch (error) {
    if (error instanceof RejectedWrite) return Response.json(error.response.body, { status: error.response.status });
    return crmCommandErrorResponse(error, input.correlationId);
  }
}
export async function reconcileSalesHttp(session: AppSession, input: SalesHttpRequest, options: TenantTransactionOptions = {}) {
  return withCrmRead(session, async () => reconcileCrmCommand(session, await salesHttpCommand(session, input, options), options), options);
}
export function withCrmSalesWrite<T extends unknown[]>(handler: (request: Request, freshSession: AppSession, ...args: T) => Promise<Response>) {
  return async (request: Request, ...args: T): Promise<Response> => {
    let correlationId: string | undefined;
    try {
      const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write" });
      if (!auth.ok) return auth.response;
      const body = await request.clone().json() as Record<string, unknown>;
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new CrmCommandError("INVALID_REQUEST", "JSON object required");
      const metadata = crmRequestMetadata(request, body);
      correlationId = metadata.correlationId;
      const url = new URL(request.url);
      return executeSalesHttp(auth.session, { target: url.pathname + url.search, method: request.method, body, ...metadata }, (freshSession) => handler(request, freshSession, ...args));
    } catch (error) { return crmCommandErrorResponse(error instanceof SyntaxError ? new CrmCommandError("INVALID_JSON", "Invalid JSON") : error, correlationId); }
  };
}
