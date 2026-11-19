import "server-only";
import type { AppSession } from "../auth/session";
import { assertCrmUuid, assertProjectGrant, crmPayloadDigest, CrmCommandError, executeCrmCommand, withCrmRead, type TenantTransaction, type TenantTransactionOptions } from "../crm-command";
import { hasProductCapability } from "../product-model";
import { writeAuditLog } from "./runtime-repositories";
import { writeCrmAnalyticsEvent } from "./analytics-event-repositories";
import type { CustomerAccessProjectGrant } from "./customer-access-repositories";

type Scope = { accessId: string; projectId: string; userId: string };
type Values = {
  accessLevel: "viewer" | "editor" | "admin";
  projectRole: "owner" | "admin" | "agent" | "assistant";
  status: "active" | "invited" | "suspended";
  canViewProject: boolean; canEditProject: boolean; canViewContacts: boolean; canExportData: boolean;
};
type GrantRow = Values & { id: string; customerAccessId: string; fingerprint: string };
type Pipeline = {
  id: string; fingerprint: string; canRead: boolean; canEdit: boolean; canMove: boolean; canClose: boolean; canReopen: boolean;
  metadata: Record<string, unknown>;
};
export type CustomerProjectGrantState = Scope & {
  version: "customer-project-grant-state-v1";
  digest: string;
  current: Values | null;
  projectionOwnership: "missing" | "customer_access" | "independent";
  activeOtherGrantCount: number;
};
type State = { public: CustomerProjectGrantState; grants: GrantRow[]; pipeline: Pipeline | null; current: GrantRow | null };
function failure(code: string, message: string, status = 409): never { throw new CrmCommandError(code, message, status); }
const budget = (options: TenantTransactionOptions) => ({ ...options, statementTimeoutMs: 15_000, poolAcquireTimeoutMs: 5_000 });
const fingerprint = (alias: string) => `encode(sha256(convert_to(to_jsonb(${alias})::text,'UTF8')),'hex')`;
const metadataKeys = new Set(["source", "customerAccessId", "grantStatus", "customerAccessProjectionVersion", "contributorGrantIds"]);

function scopeOf(input: Scope): Scope {
  return { accessId: assertCrmUuid(input.accessId, "accessId"), projectId: assertCrmUuid(input.projectId, "projectId"), userId: assertCrmUuid(input.userId, "userId") };
}

function authority(session: AppSession) {
  if (!session.authenticated || session.serviceIdentity || !["cookie", "database"].includes(session.source) || !session.authIdentityId || !session.authSessionId || !session.permissions.includes("crm:write") || !hasProductCapability(session.productRole, "customer-access:manage")) failure("GRANT_FORBIDDEN", "Current persisted customer-access administration is required", 403);
}

async function lockAuthority(tx: TenantTransaction, session: AppSession, scope: Scope) {
  authority(session);
  if (!(await tx.queryOne<{ allowed: boolean }>("select crm_workspace_manager($1::uuid) as allowed", [session.workspaceId]))?.allowed) failure("GRANT_FORBIDDEN", "Current workspace administration is required", 403);
  await assertProjectGrant(tx, session, scope.projectId, true);
  // Every writer for this projection uses the same key, including creation of
  // a previously absent business grant or pipeline row.
  await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`customer-project-grant:${session.workspaceId}:${scope.projectId}:${scope.userId}`]);
}

function ownership(pipeline: Pipeline | null, grants: GrantRow[]): CustomerProjectGrantState["projectionOwnership"] {
  if (!pipeline) return "missing";
  const metadata = pipeline.metadata;
  // The legacy writer merged and replaced source markers without recording the
  // prior projection. Its tag alone cannot prove that an independent read grant
  // was absent. Only this atomic writer's versioned provenance is unambiguous.
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || Object.keys(metadata).some(key => !metadataKeys.has(key)) || metadata.source !== "customer_access_cockpit" || !grants.some(grant => grant.customerAccessId === metadata.customerAccessId)) return "independent";
  if (metadata.customerAccessProjectionVersion !== 2) return "independent";
  const active=grants.filter(grant=>grant.status==="active"&&grant.canViewProject);
  const contributors=active.map(grant=>grant.id).sort();
  if (!Array.isArray(metadata.contributorGrantIds) || JSON.stringify(metadata.contributorGrantIds)!==JSON.stringify(contributors) || metadata.grantStatus!==grants.find(grant=>grant.customerAccessId===metadata.customerAccessId)?.status || pipeline.canRead!==(active.length>0) || pipeline.canEdit!==active.some(grant=>grant.canEditProject) || pipeline.canMove!==pipeline.canEdit || pipeline.canClose!==active.some(grant=>grant.canEditProject&&grant.accessLevel==="admin") || pipeline.canReopen!==pipeline.canClose) return "independent";
  return "customer_access";
}

async function readState(tx: TenantTransaction, session: AppSession, scope: Scope, write: boolean): Promise<State> {
  const lock = write ? "for update" : "for share";
  const access = await tx.queryOne<{ fingerprint: string }>(`select ${fingerprint("a")} as fingerprint from customer_workspace_access a where a.workspace_id=$1::uuid and a.id=$2::uuid for share`, [session.workspaceId, scope.accessId]);
  const project = await tx.queryOne<{ fingerprint: string }>(`select ${fingerprint("p")} as fingerprint from projects p where p.workspace_id=$1::uuid and p.id=$2::uuid for share`, [session.workspaceId, scope.projectId]);
  // FOR UPDATE also excludes new grant rows through the existing user FK's
  // KEY SHARE check. Absent rows must not become an overwrite race with a
  // separately administered source that does not use this path's advisory key.
  const member = await tx.queryOne<{ fingerprint: string }>(`select ${fingerprint("u")} as fingerprint from workspace_users u where u.workspace_id=$1::uuid and u.id=$2::uuid ${lock}`, [session.workspaceId, scope.userId]);
  if (!access || !project || !member) failure("GRANT_TARGET_NOT_FOUND", "Customer, project and membership must belong to the current workspace", 404);
  const grants = await tx.query<GrantRow>(`select id::text,customer_access_id::text as "customerAccessId",access_level as "accessLevel",project_role as "projectRole",status,
    can_view_project as "canViewProject",can_edit_project as "canEditProject",can_view_contacts as "canViewContacts",can_export_data as "canExportData",${fingerprint("g")} as fingerprint
    from customer_project_access g where workspace_id=$1::uuid and project_id=$2::uuid and user_id=$3::uuid order by id limit 101 ${lock}`, [session.workspaceId, scope.projectId, scope.userId]);
  if (grants.length > 100) failure("GRANT_SCOPE_LIMIT", "Project grant scope must be reviewed before changing it");
  const pipeline = await tx.queryOne<Pipeline>(`select id::text,can_read as "canRead",can_edit_deals as "canEdit",can_move_deals as "canMove",can_close_deals as "canClose",can_reopen_deals as "canReopen",metadata,${fingerprint("p")} as fingerprint
    from project_pipeline_permissions p where workspace_id=$1::uuid and project_id=$2::uuid and user_id=$3::uuid ${lock}`, [session.workspaceId, scope.projectId, scope.userId]);
  const current = grants.find(grant => grant.customerAccessId === scope.accessId) ?? null;
  const { id: _id, customerAccessId: _access, fingerprint: _fingerprint, ...values } = current ?? {};
  void _id; void _access; void _fingerprint;
  const content = { version: "customer-project-grant-state-v1" as const, workspaceId: session.workspaceId, ...scope,
    access: access.fingerprint, project: project.fingerprint, member: member.fingerprint,
    grants: grants.map(grant => ({ id: grant.id, fingerprint: grant.fingerprint })), pipeline: pipeline?.fingerprint ?? null };
  return { grants, pipeline, current, public: { ...scope, version: content.version, digest: crmPayloadDigest(content), current: current ? values as Values : null,
    projectionOwnership: ownership(pipeline, grants), activeOtherGrantCount: grants.filter(grant => grant.customerAccessId !== scope.accessId && grant.status === "active").length } };
}

export async function readCustomerProjectGrantState(session: AppSession, input: Scope, options: TenantTransactionOptions = {}) {
  const scope = scopeOf(input);
  return withCrmRead(session, async (tx, fresh) => {
    await lockAuthority(tx, fresh, scope);
    return (await readState(tx, fresh, scope, false)).public;
  }, budget(options));
}

function valuesOf(input: Record<string, unknown>): Values {
  if (!["viewer", "editor", "admin"].includes(String(input.accessLevel)) || !["owner", "admin", "agent", "assistant"].includes(String(input.projectRole)) || !["active", "invited", "suspended"].includes(String(input.status)) || ["canViewProject", "canEditProject", "canViewContacts", "canExportData"].some(key => typeof input[key] !== "boolean")) failure("INVALID_GRANT", "Exact supported project permissions are required", 400);
  return { accessLevel: input.accessLevel as Values["accessLevel"], projectRole: input.projectRole as Values["projectRole"], status: input.status as Values["status"], canViewProject: input.canViewProject as boolean, canEditProject: input.canEditProject as boolean, canViewContacts: input.canViewContacts as boolean, canExportData: input.canExportData as boolean };
}

export async function changeCustomerProjectGrant(session: AppSession, input: Scope & Record<string, unknown>, metadata: { idempotencyKey: string; correlationId: string }, options: TenantTransactionOptions = {}) {
  const scope = scopeOf(input), values = valuesOf(input);
  if (typeof input.expectedStateDigest !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedStateDigest)) failure("GRANT_STATE_REQUIRED", "Reload and review the current project permissions", 409);
  const payload = { ...scope, ...values, expectedStateDigest: input.expectedStateDigest };
  return withCrmRead(session, async (tx, fresh) => {
    await lockAuthority(tx, fresh, scope);
    // Authority is revalidated outside durable replay. The state CAS belongs
    // inside the command callback so a lost committed response remains recoverable.
    return executeCrmCommand(fresh, { ...metadata, operation: "customer.project_grant.change", projectId: scope.projectId, resourceId: scope.accessId, capability: "customer-access:manage", payload }, async () => {
      const before = await readState(tx, fresh, scope, true);
      if (before.public.digest !== input.expectedStateDigest) failure("GRANT_STATE_CHANGED", "Project permissions changed; reload and review them");
      if (before.public.projectionOwnership === "independent") failure("GRANT_PROJECTION_INDEPENDENT", "An independent project permission must be reviewed separately");
      const row = await tx.queryOne<{ id: string }>(`insert into customer_project_access(workspace_id,customer_access_id,project_id,user_id,project_role,access_level,can_view_project,can_edit_project,can_view_contacts,can_export_data,status,metadata)
        values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
        on conflict(workspace_id,customer_access_id,project_id,user_id) do update set project_role=excluded.project_role,access_level=excluded.access_level,can_view_project=excluded.can_view_project,can_edit_project=excluded.can_edit_project,can_view_contacts=excluded.can_view_contacts,can_export_data=excluded.can_export_data,status=excluded.status,metadata=customer_project_access.metadata||excluded.metadata,updated_at=now()
        where ${fingerprint("customer_project_access")}=$13 returning id::text`,
        [fresh.workspaceId,scope.accessId,scope.projectId,scope.userId,values.projectRole,values.accessLevel,values.canViewProject,values.canEditProject,values.canViewContacts,values.canExportData,values.status,JSON.stringify({source:"customer_access_cockpit",updatedByUserId:fresh.userId}),before.current?.fingerprint??null]);
      if (!row) failure("GRANT_UNCONFIRMED", "Project permission was not confirmed", 503);
      const all = (await readState(tx, fresh, scope, true)).grants;
      const active = all.filter(grant => grant.status === "active" && grant.canViewProject);
      const canRead = active.length > 0;
      const canEdit = active.some(grant => grant.canEditProject);
      const canClose = active.some(grant => grant.canEditProject && grant.accessLevel === "admin");
      const projection = { canRead, canEdit, canMove: canEdit, canClose, canReopen: canClose };
      if (before.pipeline || active.length) {
        const written = await tx.queryOne<{ id:string }>(`insert into project_pipeline_permissions(workspace_id,project_id,user_id,can_read,can_edit_deals,can_move_deals,can_close_deals,can_reopen_deals,metadata)
        values($1::uuid,$2::uuid,$3::uuid,$4,$5,$5,$6,$6,$7::jsonb)
        on conflict(workspace_id,project_id,user_id) do update set can_read=excluded.can_read,can_edit_deals=excluded.can_edit_deals,can_move_deals=excluded.can_move_deals,can_close_deals=excluded.can_close_deals,can_reopen_deals=excluded.can_reopen_deals,metadata=excluded.metadata,updated_at=now()
        where ${fingerprint("project_pipeline_permissions")}=$8 returning id::text`,
        [fresh.workspaceId,scope.projectId,scope.userId,canRead,canEdit,canClose,JSON.stringify({source:"customer_access_cockpit",customerAccessId:scope.accessId,grantStatus:values.status,customerAccessProjectionVersion:2,contributorGrantIds:active.map(grant=>grant.id).sort()}),before.pipeline?.fingerprint??null]);
        if (!written) failure("GRANT_STATE_CHANGED", "Project permissions changed; reload and review them");
      }
      const after = await readState(tx, fresh, scope, true);
      const view = await tx.queryOne<CustomerAccessProjectGrant & { updatedAt: string | Date }>(`select g.id::text,g.workspace_id::text as "workspaceId",g.customer_access_id::text as "customerAccessId",g.project_id::text as "projectId",g.user_id::text as "userId",g.project_role as "projectRole",g.access_level as "accessLevel",g.can_view_project as "canViewProject",g.can_edit_project as "canEditProject",g.can_view_contacts as "canViewContacts",g.can_export_data as "canExportData",g.status,g.updated_at as "updatedAt",coalesce(o.name,'Customer') as "customerName",p.name as "projectName",u.name as "userName",u.email as "userEmail"
        from customer_project_access g join projects p on p.id=g.project_id and p.workspace_id=g.workspace_id join workspace_users u on u.id=g.user_id and u.workspace_id=g.workspace_id join customer_workspace_access a on a.id=g.customer_access_id and a.workspace_id=g.workspace_id left join organizations o on o.id=a.organization_id and o.workspace_id=a.workspace_id where g.id=$1::uuid and g.workspace_id=$2::uuid`,[row.id,fresh.workspaceId]);
      if (!view) failure("GRANT_UNCONFIRMED", "Project permission view was not confirmed", 503);
      const grant: CustomerAccessProjectGrant = { ...view, updatedAt:new Date(view.updatedAt).toISOString() };
      await writeAuditLog({ session:fresh,action:"customer_access.project_grant_upserted",entityId:row.id,entityType:"customer_project_access",projectId:scope.projectId,before:{stateDigest:before.public.digest,current:before.public.current},after:{...scope,...values,pipelinePermissions:projection,stateDigest:after.public.digest} });
      await writeCrmAnalyticsEvent({eventType:"customer_project_access_updated",entityId:row.id,entityType:"customer_project_access",module:"dashboard",projectId:scope.projectId,source:"customer_access_cockpit",userId:fresh.userId,workspaceId:fresh.workspaceId,metadata:{...values,...projection,userId:scope.userId}});
      return { persisted:true as const,id:row.id,grant,state:after.public,pipelinePermissions:projection,historicalGrantReceiptOnly:true as const };
    }, budget(options));
  }, budget(options));
}
