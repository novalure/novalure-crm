import {
  canSwitchWorkspace,
  requirePermission,
  resolveWorkspaceMembershipAccess,
  resolveWorkspaceScopedSession,
} from "@/lib/auth/session";
import type { AppRole } from "@/lib/auth/permissions";
import { queryRows } from "@/lib/db/client";
import { withTenantTransaction } from "@/lib/db/tenant-client";
import { runWithTenantTransaction } from "@/lib/db/transaction-context";
import { canPersist, isUuid, writeAuditLog } from "@/lib/db/runtime-repositories";
import {
  hasProductCapability,
  isCalendarProviderChoice,
  isWorkspaceCustomerType,
  isWorkspaceOperatingModel,
  isWorkspaceTeamStructure,
  type CalendarProviderChoice,
  type ProductRole,
  type WorkspaceCustomerType,
  type WorkspaceOperatingModel,
  type WorkspaceTeamStructure,
} from "@/lib/product-model";
import { crmCommandErrorResponse, withCrmRead } from "@/lib/crm-command";
import { parseCustomerWorkspaceInput, provisionCustomerWorkspace } from "@/lib/customer-workspace-provisioning";

type WorkspaceRow = {
  id: string;
  membershipId: string;
  name: string;
  plan: string;
  role: AppRole;
  activeUsers: number | string;
  activeProjects: number | string;
  activeCalendarProvider: CalendarProviderChoice | null;
  customerType: WorkspaceCustomerType | null;
  operatingModel: WorkspaceOperatingModel | null;
  productRole: ProductRole | null;
  setupState: Record<string, unknown> | null;
  teamStructure: WorkspaceTeamStructure | null;
};

type WorkspaceSetupRow = Pick<WorkspaceRow, "activeCalendarProvider" | "customerType" | "operatingModel" | "setupState" | "teamStructure">;
const workspaceSetupValidators = {
  activeCalendarProvider: isCalendarProviderChoice,
  customerType: isWorkspaceCustomerType,
  operatingModel: isWorkspaceOperatingModel,
  teamStructure: isWorkspaceTeamStructure,
};
type WorkspaceSetupField = keyof typeof workspaceSetupValidators;

function parseWorkspaceSetupChange(input: Record<string, unknown>) {
  const change = input.workspaceSetupChange;
  if (!change || typeof change !== "object" || !("field" in change) || !("expectedValue" in change) ||
      typeof change.field !== "string" || !Object.hasOwn(workspaceSetupValidators, change.field)) return null;
  const field = change.field as WorkspaceSetupField;
  const valid = workspaceSetupValidators[field];
  if (!valid(change.expectedValue) || !valid(input[field])) return null;
  return { field, expectedValue: change.expectedValue };
}

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  // Provisioning authority always comes from the persisted signed-in membership;
  // the caller cannot supply an actor, role, tenant ID or commercial limits.
  const auth = await requirePermission(request, "crm:write");
  if (!auth.ok) return auth.response;
  if (!canPersist()) return Response.json({ error: "Workspace persistence is not available" }, { status: 503 });
  try {
    const input = parseCustomerWorkspaceInput(await readJson(request));
    const result = await provisionCustomerWorkspace(auth.session, input);
    return Response.json(result, { status: result.replayed ? 200 : 201 });
  } catch (error) {
    return crmCommandErrorResponse(error);
  }
}

export async function GET(request: Request) {
  const auth = await requirePermission(request, "crm:read");

  if (!auth.ok) return auth.response;

  if (!canPersist() || !isUuid(auth.session.userId)) {
    return Response.json({
      source: "demo",
      workspaces: [
        {
          id: auth.session.workspaceId,
          name: auth.session.workspaceName,
          role: auth.session.role,
          permissions: auth.session.permissions,
          activeCalendarProvider: auth.session.workspaceActiveCalendarProvider ?? "none",
          customerType: auth.session.workspaceCustomerType ?? null,
          operatingModel: auth.session.workspaceOperatingModel ?? null,
          productPermissions: auth.session.productPermissions,
          productRole: auth.session.productRole,
          setupState: auth.session.workspaceSetupState ?? null,
          teamStructure: auth.session.workspaceTeamStructure ?? null,
        },
      ],
    });
  }

  try {
    const listManagedWorkspaces = canSwitchWorkspace(auth.session);
    const workspaces = await queryRows<WorkspaceRow>(
      `
        select
          w.id,
          wu.id as "membershipId",
          w.name,
          w.plan,
          wu.role,
          wu.product_role as "productRole",
          w.operating_model as "operatingModel",
          w.customer_type as "customerType",
          w.team_structure as "teamStructure",
          w.active_calendar_provider as "activeCalendarProvider",
          w.setup_state as "setupState",
          count(distinct active_users.id) as "activeUsers"
        from workspace_users wu
        join workspaces w on w.id = wu.workspace_id
        left join workspace_users active_users on active_users.workspace_id = w.id and active_users.status = 'active'
        where wu.status = 'active'
          and (
            wu.id = $1::uuid
            or ($2::boolean and lower(wu.email) = lower($3))
          )
        group by w.id, w.name, w.plan, wu.id, wu.role, wu.product_role, w.operating_model, w.customer_type, w.team_structure, w.active_calendar_provider, w.setup_state, w.created_at
        order by
          case when w.id = $4::uuid then 0 else 1 end,
          w.customer_type asc,
          w.created_at asc
      `,
      [auth.session.userId, listManagedWorkspaces, auth.session.email, auth.session.workspaceId],
    );

    return Response.json({
      source: "database",
      activeWorkspaceId: auth.session.workspaceId,
      workspaces: await Promise.all(workspaces.map(async (workspace) => {
        const { membershipId, ...summary } = workspace;
        const access = resolveWorkspaceMembershipAccess({
          productRole: workspace.productRole,
          role: workspace.role,
          workspaceName: workspace.name,
        });

        // Each summary must use its own persisted membership/tenant context.
        // A bootstrap query without that context silently sees zero RLS rows.
        const activeProjects = await withTenantTransaction(
          { actorId: membershipId, workspaceId: workspace.id },
          async tx => Number((await tx.queryOne<{ count: string }>(
            "select count(*) as count from projects where workspace_id=$1::uuid and status <> 'Archiviert'",
            [workspace.id],
          ))?.count ?? 0),
        );

        return {
          ...summary,
          activeUsers: Number(workspace.activeUsers),
          activeProjects,
          permissions: access.permissions,
          productPermissions: access.productPermissions,
          productRole: access.productRole,
          role: access.role,
        };
      })),
    });
  } catch (error) {
    return crmCommandErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  const auth = await resolveWorkspaceScopedSession(request, { permission: "crm:write", capability: "settings:manage" });
  if (!auth.ok) return auth.response;

  if (!canPersist() || !isUuid(auth.session.workspaceId)) {
    return Response.json({ error: "Workspace persistence is not available" }, { status: 503 });
  }

  const body = await readJson(request);
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const change = parseWorkspaceSetupChange(input);
  if (Object.hasOwn(input, "workspaceSetupChange") && !change) {
    return Response.json({ error: "Invalid workspace settings change" }, { status: 400 });
  }
  const requested = change ? { [change.field]: input[change.field] } : input;
  const setupState =
    !change && input.setupState && typeof input.setupState === "object" && !Array.isArray(input.setupState)
      ? input.setupState
      : {};

  const scope = { actorId: auth.session.userId, workspaceId: auth.session.workspaceId };
  try {
    return await withTenantTransaction(scope, async (transaction) => {
      // Lock the workspace before withCrmRead shares that row for its membership
      // check. Taking the write lock second would deadlock concurrent settings saves.
      const before = await transaction.queryOne<WorkspaceSetupRow>(`
        select active_calendar_provider as "activeCalendarProvider",
          customer_type as "customerType", operating_model as "operatingModel",
          setup_state as "setupState", team_structure as "teamStructure"
        from workspaces where id = $1 for no key update
      `, [scope.workspaceId]);

      return runWithTenantTransaction(scope, transaction, () => withCrmRead(auth.session, async (tx, session) => {
        if (!session.permissions.includes("crm:write") || !hasProductCapability(session.productRole, "settings:manage")) {
          return Response.json({ error: "Forbidden" }, { status: 403 });
        }
        if (!before) return Response.json({ error: "Workspace could not be updated" }, { status: 404 });
        if (change && before[change.field] !== change.expectedValue) {
          return Response.json({ error: "Workspace settings changed", code: "WORKSPACE_SETUP_CONFLICT" }, { status: 409 });
        }

        const operatingModel = isWorkspaceOperatingModel(requested.operatingModel)
          ? requested.operatingModel : before.operatingModel ?? "self_service_customer";
        const customerType = isWorkspaceCustomerType(requested.customerType)
          ? requested.customerType : before.customerType ?? "real_estate_broker";
        const teamStructure = isWorkspaceTeamStructure(requested.teamStructure)
          ? requested.teamStructure : before.teamStructure ?? "small_team";
        const activeCalendarProvider = isCalendarProviderChoice(requested.activeCalendarProvider)
          ? requested.activeCalendarProvider : before.activeCalendarProvider ?? "none";
        if ((operatingModel === "novalure_internal" || customerType === "novalure_internal") &&
            !hasProductCapability(session.productRole, "novalure:internal")) {
          return Response.json({ error: "Novalure internal setup requires an internal product role" }, { status: 403 });
        }

        const row = await tx.queryOne<WorkspaceSetupRow & { id: string; name: string }>(
          `
            update workspaces
            set
              operating_model = $2,
              customer_type = $3,
              team_structure = $4,
              active_calendar_provider = $5,
              setup_state = coalesce(setup_state, '{}'::jsonb) || $6::jsonb,
              updated_at = now()
            where id = $1
            returning id, name,
              active_calendar_provider as "activeCalendarProvider",
              customer_type as "customerType", operating_model as "operatingModel",
              setup_state as "setupState", team_structure as "teamStructure"
          `,
          [
            session.workspaceId,
            operatingModel,
            customerType,
            teamStructure,
            activeCalendarProvider,
            JSON.stringify({
              ...setupState,
              lastConfiguredAt: new Date().toISOString(),
              updatedByUserId: session.userId,
            }),
          ],
        );

        if (!row) return Response.json({ error: "Workspace could not be updated" }, { status: 404 });

        await writeAuditLog({
          action: "workspace.setup_updated",
          before,
          after: {
            activeCalendarProvider: row.activeCalendarProvider,
            customerType: row.customerType,
            operatingModel: row.operatingModel,
            setupState: row.setupState,
            teamStructure: row.teamStructure,
          },
          entityId: row.id,
          entityType: "workspace",
          session,
        });

        return Response.json({
          persisted: true,
          workspace: {
            activeCalendarProvider: row.activeCalendarProvider,
            customerType: row.customerType,
            id: row.id,
            name: row.name,
            operatingModel: row.operatingModel,
            setupState: row.setupState,
            teamStructure: row.teamStructure,
          },
        });
      }));
    });
  } catch (error) {
    return crmCommandErrorResponse(error);
  }
}
