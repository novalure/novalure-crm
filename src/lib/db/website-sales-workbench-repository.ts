import type { AppSession } from "@/lib/auth/session";
import { assertCrmFields, assertCrmUuid, assertProjectGrant, CrmCommandError, withCrmRead, type TenantTransaction, type TenantTransactionOptions } from "@/lib/crm-command";
import { hasProductCapability } from "@/lib/product-model";
import { getWebsiteSalesIrelandWorkflow } from "@/lib/db/website-sales-ireland-repositories";
import { websiteSalesWorkbenchContract, type WebsiteSalesWorkbenchCompany, type WebsiteSalesWorkbenchContact, type WebsiteSalesWorkbenchLocation,
  type WebsiteSalesWorkbenchLocationItem, type WebsiteSalesWorkbenchObservation, type WebsiteSalesWorkbenchProject, type WebsiteSalesWorkbenchQuery,
  type WebsiteSalesWorkbenchResponse, type WebsiteSalesWorkbenchStatus } from "@/lib/website-sales-workbench-types";

function fail(code: string, status = 400): never { throw new CrmCommandError(code, code, status); }
function personal(session: AppSession) {
  if (session.serviceIdentity || !session.authenticated || session.source === "demo") fail("SESSION_REQUIRED", 401);
}
function validate(query: WebsiteSalesWorkbenchQuery) {
  if (!query || typeof query !== "object" || Array.isArray(query)) fail("WORKBENCH_QUERY_INVALID");
  assertCrmFields(query as unknown as Record<string, unknown>, ["view", "projectId", "companyId", "locationId", "cursor", "limit", "q"]);
  if (!["projects", "companies", "contacts", "locations", "detail"].includes(query.view)) fail("WORKBENCH_QUERY_INVALID");
  if (query.view !== "projects") assertCrmUuid(query.projectId, "projectId");
  if (["contacts", "locations", "detail"].includes(query.view)) assertCrmUuid(query.companyId, "companyId");
  if (query.view === "detail") assertCrmUuid(query.locationId, "locationId");
  if ((query.view === "projects" && query.projectId !== undefined) ||
    (["projects", "companies"].includes(query.view) && query.companyId !== undefined) ||
    (query.view !== "detail" && query.locationId !== undefined)) fail("WORKBENCH_QUERY_INVALID");
  if (query.view === "detail" && [query.cursor, query.limit, query.q].some(value => value !== undefined)) fail("WORKBENCH_QUERY_INVALID");
  if (query.cursor !== undefined) assertCrmUuid(query.cursor, "cursor");
  const limit = query.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) fail("WORKBENCH_QUERY_INVALID");
  if (query.q !== undefined && (typeof query.q !== "string" || query.q.length > 120 || /[\p{Cc}\p{Cf}]/u.test(query.q) ||
    !["projects", "companies", "contacts"].includes(query.view))) fail("WORKBENCH_QUERY_INVALID");
  return { ...query, limit, q: query.q?.trim() ?? "" };
}
export function parseWebsiteSalesWorkbenchQuery(params: URLSearchParams): WebsiteSalesWorkbenchQuery {
  const allowed = new Set(["view", "projectId", "companyId", "locationId", "cursor", "limit", "q", "workspaceId"]);
  if ([...params.keys()].some(key => !allowed.has(key) || params.getAll(key).length !== 1)) fail("WORKBENCH_QUERY_INVALID");
  const query: WebsiteSalesWorkbenchQuery = { view: (params.get("view") ?? "projects") as WebsiteSalesWorkbenchQuery["view"] };
  for (const key of ["projectId", "companyId", "locationId", "cursor", "q"] as const) if (params.has(key)) query[key] = params.get(key)!;
  if (params.has("limit")) {
    if (!/^[1-9]\d?$/.test(params.get("limit")!)) fail("WORKBENCH_QUERY_INVALID");
    query.limit = Number(params.get("limit"));
  }
  validate(query);
  return query;
}
function canWriteBase(session: AppSession) {
  return session.permissions.includes("crm:write") && hasProductCapability(session.productRole, "pipeline:write");
}
async function internal(tx: TenantTransaction, session: AppSession) {
  const row = await tx.queryOne<{ allowed: boolean }>("select exists(select 1 from workspaces where id=$1 and operating_model='novalure_internal') as allowed", [session.workspaceId]);
  if (!row?.allowed) fail("WORKBENCH_SCOPE_DENIED", 403);
}
async function project(tx: TenantTransaction, session: AppSession, projectId: string) {
  await assertProjectGrant(tx, session, projectId);
  const row = await tx.queryOne<{ canWrite: boolean }>(`select ($3::boolean and crm_project_access(p.workspace_id,p.id,true)) as "canWrite" from projects p
    where p.workspace_id=$1 and p.id=$2 and p.division='WEB_DESIGN' and p.data_classification='NOVALURE_INTERNAL' and p.data_purpose='crm_sales'`,
  [session.workspaceId, projectId, canWriteBase(session)]);
  if (!row) fail("WORKBENCH_SCOPE_DENIED", 403);
  return row;
}
async function company(tx: TenantTransaction, session: AppSession, projectId: string, companyId: string) {
  const row = await tx.queryOne(`select id from organizations where workspace_id=$1 and project_id=$2 and id=$3 and division='WEB_DESIGN'
    and data_classification='NOVALURE_INTERNAL' and data_purpose='crm_sales'`, [session.workspaceId, projectId, companyId]);
  if (!row) fail("COMPANY_SCOPE_DENIED", 403);
}
function iso(value: string | Date) {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) fail("WORKBENCH_DATA_UNAVAILABLE", 503);
  return date.toISOString();
}
function page<T extends { id: string }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit), hasMore = rows.length > limit;
  return { items, page: { limit, hasMore, nextCursor: hasMore ? items.at(-1)!.id : null } };
}
type LocationRow = Omit<WebsiteSalesWorkbenchLocation, "registeredAt"> & { registeredAt: Date | string };
type LocationSummaryRow = LocationRow & { workflowId: string | null; workflowStatus: WebsiteSalesWorkbenchStatus | null; workflowVersion: number | null;
  contactId: string | null; evidenceDigest: string | null; validUntil: Date | string | null };
const locationColumns = `l.id,l.workspace_id as "workspaceId",l.project_id as "projectId",l.company_id as "companyId",l.location_key as "locationKey",
  l.country_code as "countryCode",l.address,l.source_url as "sourceUrl",l.version,l.source_reference as "sourceReference",
  l.registration_basis as "registrationBasis",l.created_at as "registeredAt"`;
function normalizeLocation(row: LocationRow): WebsiteSalesWorkbenchLocation {
  return { id: row.id, workspaceId: row.workspaceId, projectId: row.projectId, companyId: row.companyId, locationKey: row.locationKey,
    countryCode: row.countryCode, address: row.address, sourceUrl: row.sourceUrl, sourceReference: row.sourceReference,
    registrationBasis: row.registrationBasis, version: Number(row.version), registeredAt: iso(row.registeredAt) };
}

/** Scoped catalog/detail reads only; no core loader, repair, default provisioning or command execution. */
export async function readWebsiteSalesWorkbench(session: AppSession, input: WebsiteSalesWorkbenchQuery, options: TenantTransactionOptions = {}): Promise<WebsiteSalesWorkbenchResponse> {
  personal(session);
  const query = validate(input);
  return withCrmRead(session, async (tx, fresh) => {
    personal(fresh);
    await internal(tx, fresh);
    const scope = { contractVersion: websiteSalesWorkbenchContract as typeof websiteSalesWorkbenchContract, source: "database" as const, workspaceId: fresh.workspaceId,
      projectId: query.projectId ?? null, companyId: query.companyId ?? null, canWrite: false, canContact: false as const };
    if (query.view === "projects") {
      const rows = await tx.query<WebsiteSalesWorkbenchProject>(`select p.id,p.name,($5::boolean and crm_project_access(p.workspace_id,p.id,true)) as "canWrite",
        exists(select 1 from crm_pipelines cp join crm_pipeline_stages s on s.workspace_id=cp.workspace_id and s.project_id=p.id and s.pipeline_id=cp.id
          where cp.workspace_id=p.workspace_id and cp.project_id=p.id and cp.id=p.default_pipeline_id and cp.division='WEB_DESIGN'
          and s.category not in('won','lost','disqualified')) as "pipelineConfigured"
        from projects p where p.workspace_id=$1 and p.division='WEB_DESIGN' and p.data_classification='NOVALURE_INTERNAL' and p.data_purpose='crm_sales'
          and crm_project_access(p.workspace_id,p.id,false) and ($2::uuid is null or p.id>$2::uuid) and ($3='' or position(lower($3) in lower(p.name))>0)
        order by p.id limit $4`, [fresh.workspaceId, query.cursor ?? null, query.q, query.limit + 1, canWriteBase(fresh)]);
      return { ...scope, view: "projects", ...page(rows, query.limit) };
    }
    const access = await project(tx, fresh, query.projectId!);
    scope.canWrite = access.canWrite;
    if (query.view === "companies") {
      const rows = await tx.query<WebsiteSalesWorkbenchCompany>(`select id,name,city,domain,version from organizations where workspace_id=$1 and project_id=$2 and division='WEB_DESIGN'
        and data_classification='NOVALURE_INTERNAL' and data_purpose='crm_sales' and ($3::uuid is null or id>$3::uuid)
        and ($4='' or position(lower($4) in lower(name))>0) order by id limit $5`, [fresh.workspaceId, query.projectId, query.cursor ?? null, query.q, query.limit + 1]);
      return { ...scope, view: "companies", ...page(rows.map(row => ({ ...row, version: Number(row.version) })), query.limit) };
    }
    await company(tx, fresh, query.projectId!, query.companyId!);
    if (query.view === "contacts") {
      const rows = await tx.query<WebsiteSalesWorkbenchContact>(`select id,name,email,version from contacts where workspace_id=$1 and project_id=$2 and organization_id=$3 and archived_at is null
        and data_classification='NOVALURE_INTERNAL' and data_purpose='crm_sales' and ($4::uuid is null or id>$4::uuid)
        and ($5='' or position(lower($5) in lower(name))>0) order by id limit $6`, [fresh.workspaceId, query.projectId, query.companyId, query.cursor ?? null, query.q, query.limit + 1]);
      return { ...scope, view: "contacts", ...page(rows.map(row => ({ ...row, version: Number(row.version) })), query.limit) };
    }
    if (query.view === "locations") {
      const rows = await tx.query<LocationSummaryRow>(`select ${locationColumns},w.id as "workflowId",w.status as "workflowStatus",w.version as "workflowVersion",w.contact_id as "contactId",
        o.evidence_digest as "evidenceDigest",o.valid_until as "validUntil" from crm_company_locations l
        left join crm_website_sales_workflows w on w.workspace_id=l.workspace_id and w.project_id=l.project_id and w.company_id=l.company_id and w.location_id=l.id
          and w.data_classification='NOVALURE_INTERNAL' and w.data_purpose='crm_sales'
        left join crm_website_sales_observations o on o.workspace_id=w.workspace_id and o.project_id=w.project_id and o.company_id=w.company_id and o.location_id=w.location_id and o.id=w.observation_id
          and o.data_classification='NOVALURE_INTERNAL' and o.data_purpose='crm_sales'
        where l.workspace_id=$1 and l.project_id=$2 and l.company_id=$3 and l.country_code='IE'
          and l.data_classification='NOVALURE_INTERNAL' and l.data_purpose='crm_sales' and ($4::uuid is null or l.id>$4::uuid) order by l.id limit $5`,
      [fresh.workspaceId, query.projectId, query.companyId, query.cursor ?? null, query.limit + 1]);
      const items: WebsiteSalesWorkbenchLocationItem[] = rows.map(row => {
        if (row.workflowId && (!row.workflowStatus || !row.workflowVersion || !row.evidenceDigest || !row.validUntil)) fail("WORKBENCH_DATA_UNAVAILABLE", 503);
        return { ...normalizeLocation(row), workflow: row.workflowId ? { id: row.workflowId, status: row.workflowStatus!, version: Number(row.workflowVersion), contactId: row.contactId,
          evidenceDigest: row.evidenceDigest!, validUntil: iso(row.validUntil!), statusKind: "stored", canContact: false } : null };
      });
      return { ...scope, view: "locations", ...page(items, query.limit) };
    }
    const selected = { projectId: query.projectId!, companyId: query.companyId!, locationId: query.locationId! };
    const current = await getWebsiteSalesIrelandWorkflow(fresh, selected, options);
    const registered = await tx.queryOne<LocationRow>(`select ${locationColumns} from crm_company_locations l where l.workspace_id=$1 and l.project_id=$2 and l.company_id=$3 and l.id=$4
      and l.country_code='IE' and l.data_classification='NOVALURE_INTERNAL' and l.data_purpose='crm_sales'`, [fresh.workspaceId, selected.projectId, selected.companyId, selected.locationId]);
    if (!registered) fail("LOCATION_SCOPE_DENIED", 403);
    let observation: WebsiteSalesWorkbenchObservation | null = null;
    let contact: WebsiteSalesWorkbenchContact | null = null;
    if (current.workflow) {
      const saved = await tx.queryOne<Omit<WebsiteSalesWorkbenchObservation, "observedAt" | "validUntil"> & { observedAt: Date | string; validUntil: Date | string }>(`select o.prospect,o.investment_plan as "investmentPlan",
        o.evidence_digest as "evidenceDigest",o.observed_at as "observedAt",o.valid_until as "validUntil"
        from crm_website_sales_workflows w join crm_website_sales_observations o on o.workspace_id=w.workspace_id and o.project_id=w.project_id and o.company_id=w.company_id and o.location_id=w.location_id and o.id=w.observation_id
        where w.workspace_id=$1 and w.project_id=$2 and w.company_id=$3 and w.location_id=$4 and w.id=$5 and w.version=$6
          and o.evidence_digest=$7 and o.data_classification='NOVALURE_INTERNAL' and o.data_purpose='crm_sales'`,
      [fresh.workspaceId, selected.projectId, selected.companyId, selected.locationId, current.workflow.id, current.workflow.version, current.workflow.evidenceDigest]);
      if (!saved) fail("WORKBENCH_READ_CHANGED", 409);
      observation = { ...saved, observedAt: iso(saved.observedAt), validUntil: iso(saved.validUntil) };
      if (current.workflow.contactId) {
        const row = await tx.queryOne<WebsiteSalesWorkbenchContact>(`select id,name,email,version from contacts where workspace_id=$1 and project_id=$2 and organization_id=$3 and id=$4
          and archived_at is null and data_classification='NOVALURE_INTERNAL' and data_purpose='crm_sales'`, [fresh.workspaceId, selected.projectId, selected.companyId, current.workflow.contactId]);
        if (row) contact = { ...row, version: Number(row.version) };
      }
    }
    return { ...scope, view: "detail", location: normalizeLocation(registered), workflow: current.workflow, observation, contact };
  }, options);
}
