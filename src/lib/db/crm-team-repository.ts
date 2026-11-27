import type { AppSession } from "@/lib/auth/session";
import { isAppRole } from "@/lib/auth/permissions";
import { canViewAllWorkspaceContacts } from "@/lib/contact-access";
import { assertProjectGrant, CrmCommandError, withCrmRead, type TenantTransactionOptions } from "@/lib/crm-command";
import type { WorkspaceUser } from "@/lib/crm-types";
import { hasProductCapability, isProductRole } from "@/lib/product-model";

// These are the existing workspace-manager roles used by crm_workspace_manager.
const projectManagerRoles = ["platform_admin", "novalureGrowth", "novalureAdmin", "novalure_sales", "novalure_onboarding", "novalure_customer_success", "novalure_operator", "customer_owner", "workspace_admin"];
type TeamRow = { id: string; workspaceId: string; name: string; email: string; role: string; productRole: string; operatingModel: string; status: string };

/** Assignment options, not a general employee directory or an authority to change the recipient. */
export async function readCrmTeam(session: AppSession, projectId?: string, options: TenantTransactionOptions = {}) {
  return withCrmRead(session, async (tx, fresh) => {
    if (fresh.serviceIdentity) throw new CrmCommandError("FORBIDDEN", "Eine persönliche Anmeldung ist erforderlich.", 403);
    if (projectId) await assertProjectGrant(tx, fresh, projectId);
    const workspaceManager = canViewAllWorkspaceContacts(fresh);
    const rows = await tx.query<TeamRow>(`
      select u.id,u.workspace_id as "workspaceId",u.name,u.email,u.role,u.product_role as "productRole",u.status,w.operating_model as "operatingModel"
      from workspace_users u join workspaces w on w.id=u.workspace_id
      where u.workspace_id=$1::uuid and u.status='active'
        and (($3::uuid is null and ($4::boolean or u.id=$2::uuid))
          or ($3::uuid is not null and (u.role in ('owner','admin') or u.product_role=any($5::text[]) or exists(
            select 1 from project_pipeline_permissions g where g.workspace_id=u.workspace_id and g.user_id=u.id
              and g.project_id=$3::uuid and g.can_read and g.can_edit_deals))))
      order by lower(u.name),u.id limit 1001`, [fresh.workspaceId, fresh.userId, projectId ?? null, workspaceManager, projectManagerRoles]);
    if (rows.length > 1000) throw new CrmCommandError("TEAM_LIMIT", "Bitte die Teamauswahl auf ein Projekt eingrenzen.");
    const members: WorkspaceUser[] = rows.flatMap(row => {
      if (!isAppRole(row.role) || !isProductRole(row.productRole) || !["owner", "admin", "agent"].includes(row.role) || !hasProductCapability(row.productRole, "workspace:operate") || (row.operatingModel === "novalure_internal" && !hasProductCapability(row.productRole, "novalure:internal"))) return [];
      return [{ id: row.id, workspaceId: row.workspaceId, name: row.name, email: row.email, role: row.role, productRole: row.productRole, status: "active" }];
    });
    return { workspaceId: fresh.workspaceId, currentUserId: fresh.userId, projectId: projectId ?? null, members, source: "database" as const, scope: projectId ? "project" as const : workspaceManager ? "workspace" as const : "self" as const };
  }, options);
}
