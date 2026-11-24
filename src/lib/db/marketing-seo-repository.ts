import "server-only";
import { createHash } from "node:crypto";
import type { AppSession } from "@/lib/auth/session";
import { assertCrmFields, assertCrmUuid, assertExpectedVersion, assertProjectGrant, CrmCommandError, executeCrmCommand, withCrmRead, type TenantTransaction, type TenantTransactionOptions } from "@/lib/crm-command";
import { getWorkspaceEnabledModules, hasProductCapability, isWorkspaceModuleEnabled } from "@/lib/product-model";
import { parseSeoReport, seoSiteOrigin, type SavedSeoAction, type SeoActionStatus, type SeoReport, type SeoSite, type SeoWorkspace } from "@/lib/marketing-seo";

type Metadata = { idempotencyKey: string; correlationId: string };
async function access(tx: TenantTransaction, session: AppSession) {
  if (session.serviceIdentity) throw new CrmCommandError("FORBIDDEN", "Personal workspace sign-in required.", 403);
  const workspace = await tx.queryOne<{ name: string; setup: Record<string, unknown> }>("select name,setup_state as setup from workspaces where id=$1::uuid", [session.workspaceId]);
  const modules = getWorkspaceEnabledModules({ workspaceId: session.workspaceId, workspaceName: workspace?.name ?? session.workspaceName, setupState: workspace?.setup });
  if (!isWorkspaceModuleEnabled(modules, "analytics") || !hasProductCapability(session.productRole, "analytics:read")) throw new CrmCommandError("MODULE_DISABLED", "SEO reporting is unavailable for this workspace or role.", 403);
}
async function installed(tx: TenantTransaction) { return Boolean((await tx.queryOne<{ ready: boolean }>("select to_regclass('public.crm_seo_sites') is not null and to_regclass('public.crm_seo_reports') is not null and to_regclass('public.crm_seo_actions') is not null as ready"))?.ready); }
function invalid(message: string): never { throw new CrmCommandError("INVALID_SEO_IMPORT", message); }

export async function readSeoWorkspace(session: AppSession, projectId: string | null, reportId?: string, options: TenantTransactionOptions = {}): Promise<SeoWorkspace> {
  if (projectId) assertCrmUuid(projectId, "projectId"); if (reportId) assertCrmUuid(reportId, "reportId");
  return withCrmRead(session, async (tx, fresh) => {
    await access(tx, fresh); if (projectId) await assertProjectGrant(tx, fresh, projectId);
    const writable = projectId ? Boolean((await tx.queryOne<{ allowed: boolean }>("select crm_project_access($1::uuid,$2::uuid,true) as allowed", [fresh.workspaceId, projectId]))?.allowed) : false;
    const result: SeoWorkspace = { workspaceId: fresh.workspaceId, projectId, installed: await installed(tx), canEdit: Boolean(writable && hasProductCapability(fresh.productRole, "workspace:operate") && fresh.permissions.includes("crm:write")), sites: [], reports: [], selected: null };
    if (!result.installed) return result;
    result.sites = await tx.query<SeoSite>('select id,project_id as "projectId",site_url as "siteUrl",created_at::text as "createdAt" from crm_seo_sites where workspace_id=$1::uuid and ($2::uuid is null or project_id=$2::uuid) order by created_at desc limit 200', [fresh.workspaceId, projectId]);
    try { result.sites = result.sites.map(site => ({ ...site, siteUrl: seoSiteOrigin(site.siteUrl) })); } catch { throw new CrmCommandError("SEO_EVIDENCE_INVALID", "Stored site binding failed validation.", 503); }
    result.reports = await tx.query<SeoWorkspace["reports"][number]>(`select id,site_id as "siteId",project_id as "projectId",external_report_id as "reportId",generated_at::text as "generatedAt",imported_at::text as "importedAt",jsonb_array_length(report->'pages') as "pageCount",jsonb_array_length(report->'findings') as "findingCount",(report->'coverage'->>'complete')::boolean as complete,report->'searchData'->>'source' as "searchSource" from crm_seo_reports where workspace_id=$1::uuid and ($2::uuid is null or project_id=$2::uuid) order by generated_at desc,imported_at desc limit 50`, [fresh.workspaceId, projectId]);
    if (reportId) {
      const saved = await tx.queryOne<{ id: string; report: SeoReport; reportHash: string }>('select id,report,report_hash as "reportHash" from crm_seo_reports where workspace_id=$1::uuid and id=$2::uuid and ($3::uuid is null or project_id=$3::uuid)', [fresh.workspaceId, reportId, projectId]);
      if (!saved) throw new CrmCommandError("SEO_REPORT_UNAVAILABLE", "Report unavailable in this project.", 404);
      try { saved.report = parseSeoReport(saved.report); } catch { throw new CrmCommandError("SEO_EVIDENCE_INVALID", "Stored report failed evidence validation.", 503); }
      if (saved.report.actions.some(action => action.status !== "planned") || createHash("sha256").update(JSON.stringify(saved.report)).digest("hex") !== saved.reportHash) throw new CrmCommandError("SEO_EVIDENCE_INVALID", "Stored report failed immutable source validation.", 503);
      const states = await tx.query<{ actionId: string; status: SeoActionStatus; revision: number; note: string; updatedAt: string; updatedBy: string }>('select action_id as "actionId",status,revision,note,updated_at::text as "updatedAt",updated_by::text as "updatedBy" from crm_seo_actions where workspace_id=$1::uuid and report_id=$2::uuid order by action_id', [fresh.workspaceId, reportId]);
      if (states.length !== saved.report.actions.length || saved.report.actions.some(action => !states.some(state => state.actionId === action.id))) throw new CrmCommandError("SEO_EVIDENCE_INCOMPLETE", "Stored report action evidence is incomplete.", 503);
      result.selected = { id: saved.id, report: saved.report, actions: saved.report.actions.map(action => ({ ...action, ...states.find(state => state.actionId === action.id)! })) as SavedSeoAction[] };
    }
    return result;
  }, options);
}

export async function mutateSeoWorkspace(session: AppSession, input: Record<string, unknown>, metadata: Metadata, options: TenantTransactionOptions = {}) {
  const projectId = assertCrmUuid(input.projectId, "projectId"), action = input.action;
  if (!["registerSite", "importReport", "updateAction"].includes(String(action))) invalid("Unknown SEO operation.");
  assertCrmFields(input, ["action", "projectId", ...(action === "registerSite" ? ["siteUrl"] : action === "importReport" ? ["siteId", "report"] : ["reportId", "actionId", "expectedRevision", "status", "note"])]);
  const payload = { ...input };
  let report: SeoReport | undefined;
  if (action === "registerSite") { try { payload.siteUrl = seoSiteOrigin(input.siteUrl); } catch (error) { invalid(error instanceof Error ? error.message : "Invalid site."); } }
  if (action === "importReport") {
    assertCrmUuid(input.siteId, "siteId");
    try { report = parseSeoReport(input.report); } catch (error) { invalid(error instanceof Error ? error.message : "Invalid report."); }
    if (report.tenantId !== session.workspaceId || report.projectId !== projectId) throw new CrmCommandError("SEO_SCOPE_MISMATCH", "Report tenant/project does not match the authenticated workspace and selected project.", 403);
    if (report.actions.some(action => action.status !== "planned")) invalid("Imported actions must start planned; later verification requires an authenticated evidence note.");
    payload.report = report;
  }
  if (action === "updateAction") {
    assertCrmUuid(input.reportId, "reportId"); assertExpectedVersion(input.expectedRevision);
    if (typeof input.actionId !== "string" || input.actionId.length > 128 || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(input.actionId)) invalid("Invalid action id.");
    if (!["planned", "in_progress", "verified", "dismissed"].includes(String(input.status)) || typeof input.note !== "string" || input.note.length > 2000) invalid("Invalid action update.");
    if (["verified", "dismissed"].includes(String(input.status)) && input.note.trim().length < 10) invalid("A verification or dismissal requires an evidence note of at least 10 characters.");
  }
  // Revalidate SEO entitlement before receipt lookup as well as before new effects.
  return withCrmRead(session, async (authorizationTx, fresh) => {
    await access(authorizationTx, fresh);
    return executeCrmCommand(fresh, { operation: `crm.marketing.seo.${action}`, projectId, capability: "workspace:operate", payload, ...metadata }, async (tx, context) => {
    if (!await installed(tx)) throw new CrmCommandError("SEO_SCHEMA_UNAVAILABLE", "SEO storage has not been installed on this environment.", 409);
    if (action === "registerSite") {
      const saved = await tx.queryOne<{ id: string }>('insert into crm_seo_sites(workspace_id,project_id,site_url,created_by,audit_reference) values($1::uuid,$2::uuid,$3,$4::uuid,$5::uuid) on conflict(workspace_id,project_id,site_url) do nothing returning id', [context.workspaceId, projectId, payload.siteUrl, context.actorId, context.auditReference]);
      const existing = saved ?? await tx.queryOne<{ id: string }>('select id from crm_seo_sites where workspace_id=$1::uuid and project_id=$2::uuid and site_url=$3', [context.workspaceId, projectId, payload.siteUrl]);
      return { persisted: true, id: existing!.id, operation: "registerSite" };
    }
    if (action === "importReport") {
      // Site bindings are immutable; no row-update privilege is needed merely to read one.
      const site = await tx.queryOne<{ siteUrl: string }>('select site_url as "siteUrl" from crm_seo_sites where workspace_id=$1::uuid and project_id=$2::uuid and id=$3::uuid', [context.workspaceId, projectId, input.siteId]);
      if (!site || site.siteUrl !== report!.siteUrl) throw new CrmCommandError("SEO_SITE_MISMATCH", "Report origin is not registered for this project/site.", 403);
      const encoded = JSON.stringify(report), hash = createHash("sha256").update(encoded).digest("hex");
      const existing = await tx.queryOne<{ id: string; hash: string }>('select id,report_hash as hash from crm_seo_reports where workspace_id=$1::uuid and site_id=$2::uuid and external_report_id=$3', [context.workspaceId, input.siteId, report!.reportId]);
      if (existing) { if (existing.hash !== hash) throw new CrmCommandError("SEO_REPORT_CONFLICT", "Report ID already belongs to different immutable evidence.", 409); return { persisted: true, id: existing.id, operation: "importReport" }; }
      const saved = await tx.queryOne<{ id: string }>('insert into crm_seo_reports(workspace_id,project_id,site_id,external_report_id,report,report_hash,generated_at,imported_by,audit_reference) values($1::uuid,$2::uuid,$3::uuid,$4,$5::jsonb,$6,$7::timestamptz,$8::uuid,$9::uuid) returning id', [context.workspaceId, projectId, input.siteId, report!.reportId, encoded, hash, report!.generatedAt, context.actorId, context.auditReference]);
      for (const action of report!.actions) await tx.execute('insert into crm_seo_actions(workspace_id,project_id,report_id,action_id,updated_by,audit_reference) values($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,$6::uuid)', [context.workspaceId, projectId, saved!.id, action.id, context.actorId, context.auditReference]);
      return { persisted: true, id: saved!.id, operation: "importReport" };
    }
    const saved = await tx.queryOne<{ id: string; revision: number }>('update crm_seo_actions set status=$6,note=$7,revision=revision+1,updated_by=$8::uuid,audit_reference=$9::uuid where workspace_id=$1::uuid and project_id=$2::uuid and report_id=$3::uuid and action_id=$4 and revision=$5 returning report_id as id,revision', [context.workspaceId, projectId, input.reportId, input.actionId, input.expectedRevision, input.status, input.note, context.actorId, context.auditReference]);
    if (!saved) throw new CrmCommandError("SEO_ACTION_CONFLICT", "Action changed or is unavailable; reload the current report.", 409);
    return { persisted: true, ...saved, operation: "updateAction" };
    }, options);
  }, options);
}
