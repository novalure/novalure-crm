import {
  canSwitchWorkspace,
  requirePermission,
  resolveWorkspaceScopedSession,
} from "@/lib/auth/session";
import { queryOne, queryRows } from "@/lib/db/client";
import { canPersist, isUuid, writeAuditLog } from "@/lib/db/runtime-repositories";
import {
  getProductRoleCapabilities,
  hasProductCapability,
  isCalendarProviderChoice,
  isProductRole,
  isWorkspaceCustomerType,
  isWorkspaceOperatingModel,
  isWorkspaceTeamStructure,
  type CalendarProviderChoice,
  type ProductRole,
  type WorkspaceCustomerType,
  type WorkspaceOperatingModel,
  type WorkspaceTeamStructure,
} from "@/lib/product-model";

type WorkspaceRow = {
  id: string;
  name: string;
  plan: string;
  role: string;
  activeUsers: number | string;
  activeProjects: number | string;
  activeCalendarProvider: CalendarProviderChoice | null;
  customerType: WorkspaceCustomerType | null;
  operatingModel: WorkspaceOperatingModel | null;
  productRole: ProductRole | null;
  setupState: Record<string, unknown> | null;
  teamStructure: WorkspaceTeamStructure | null;
};

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
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

  const listManagedWorkspaces = canSwitchWorkspace(auth.session);
  const specializedGrowthRole =
    auth.session.productRole === "novalureGrowth" ||
    auth.session.productRole === "novalureServiceOps" ||
    auth.session.productRole === "novalureAdmin";
  const workspaces = listManagedWorkspaces
    ? await queryRows<WorkspaceRow>(
        `
          select
            w.id,
            w.name,
            w.plan,
            $1::text as role,
            $2::text as "productRole",
            w.operating_model as "operatingModel",
            w.customer_type as "customerType",
            w.team_structure as "teamStructure",
            w.active_calendar_provider as "activeCalendarProvider",
            w.setup_state as "setupState",
            count(distinct active_users.id) as "activeUsers",
            count(distinct p.id) as "activeProjects"
          from workspaces w
          left join workspace_users active_users on active_users.workspace_id = w.id and active_users.status = 'active'
          left join projects p on p.workspace_id = w.id and p.status <> 'Archiviert'
          where (
            (
              w.name <> 'Novalure Growth'
              and coalesce(w.setup_state->>'workspaceKey', '') <> 'novalure-growth'
            )
            or $4::boolean
            or exists (
              select 1
              from workspace_users explicit_growth_member
              where explicit_growth_member.workspace_id = w.id
                and explicit_growth_member.status = 'active'
                and lower(explicit_growth_member.email) = lower($5)
            )
          )
            and (
              $6::text <> 'novalureServiceOps'
              or w.id = $3::uuid
              or exists (
                select 1
                from workspace_users service_ops_member
                where service_ops_member.workspace_id = w.id
                  and service_ops_member.status = 'active'
                  and lower(service_ops_member.email) = lower($5)
              )
            )
          group by w.id, w.name, w.plan, w.operating_model, w.customer_type, w.team_structure, w.active_calendar_provider, w.setup_state, w.created_at
          order by
            case when w.id = $3::uuid then 0 else 1 end,
            w.customer_type asc,
            w.created_at asc
        `,
        [
          auth.session.role,
          auth.session.productRole,
          auth.session.workspaceId,
          specializedGrowthRole,
          auth.session.email,
          auth.session.productRole,
        ],
      )
    : await queryRows<WorkspaceRow>(
        `
          select
            w.id,
            w.name,
            w.plan,
            wu.role,
            wu.product_role as "productRole",
            w.operating_model as "operatingModel",
            w.customer_type as "customerType",
            w.team_structure as "teamStructure",
            w.active_calendar_provider as "activeCalendarProvider",
            w.setup_state as "setupState",
            count(distinct active_users.id) as "activeUsers",
            count(distinct p.id) as "activeProjects"
          from workspace_users wu
          join workspaces w on w.id = wu.workspace_id
          left join workspace_users active_users on active_users.workspace_id = w.id and active_users.status = 'active'
          left join projects p on p.workspace_id = w.id and p.status <> 'Archiviert'
          where wu.id = $1 and wu.status = 'active'
          group by w.id, w.name, w.plan, wu.role, wu.product_role, w.operating_model, w.customer_type, w.team_structure, w.active_calendar_provider, w.setup_state, w.created_at
          order by w.created_at asc
        `,
        [auth.session.userId],
      );

  return Response.json({
    source: "database",
    activeWorkspaceId: auth.session.workspaceId,
    workspaces: workspaces.map((workspace) => ({
      ...workspace,
      activeUsers: Number(workspace.activeUsers),
      activeProjects: Number(workspace.activeProjects),
      permissions: auth.session.permissions,
      productPermissions: getProductRoleCapabilities(
        isProductRole(workspace.productRole) ? workspace.productRole : auth.session.productRole,
      ),
      productRole: isProductRole(workspace.productRole) ? workspace.productRole : auth.session.productRole,
    })),
  });
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
  const operatingModel = isWorkspaceOperatingModel(input.operatingModel)
    ? input.operatingModel
    : auth.session.workspaceOperatingModel ?? "self_service_customer";
  const customerType = isWorkspaceCustomerType(input.customerType)
    ? input.customerType
    : auth.session.workspaceCustomerType ?? "real_estate_broker";
  const teamStructure = isWorkspaceTeamStructure(input.teamStructure)
    ? input.teamStructure
    : auth.session.workspaceTeamStructure ?? "small_team";
  const activeCalendarProvider = isCalendarProviderChoice(input.activeCalendarProvider)
    ? input.activeCalendarProvider
    : auth.session.workspaceActiveCalendarProvider ?? "none";
  const setupState =
    input.setupState && typeof input.setupState === "object" && !Array.isArray(input.setupState)
      ? input.setupState
      : {};

  if (
    (operatingModel === "novalure_internal" || customerType === "novalure_internal")
    && !hasProductCapability(auth.session.productRole, "novalure:internal")
  ) {
    return Response.json({ error: "Novalure internal setup requires an internal product role" }, { status: 403 });
  }

  const row = await queryOne<WorkspaceRow>(
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
      returning
        id,
        name,
        plan,
        $7::text as role,
        0 as "activeUsers",
        0 as "activeProjects",
        active_calendar_provider as "activeCalendarProvider",
        customer_type as "customerType",
        operating_model as "operatingModel",
        $8::text as "productRole",
        setup_state as "setupState",
        team_structure as "teamStructure"
    `,
    [
      auth.session.workspaceId,
      operatingModel,
      customerType,
      teamStructure,
      activeCalendarProvider,
      JSON.stringify({
        ...setupState,
        lastConfiguredAt: new Date().toISOString(),
        updatedByUserId: auth.session.userId,
      }),
      auth.session.role,
      auth.session.productRole,
    ],
  );

  if (!row) {
    return Response.json({ error: "Workspace could not be updated" }, { status: 404 });
  }

  await writeAuditLog({
    action: "workspace.setup_updated",
    after: {
      activeCalendarProvider: row.activeCalendarProvider,
      customerType: row.customerType,
      operatingModel: row.operatingModel,
      setupState: row.setupState,
      teamStructure: row.teamStructure,
    },
    entityId: row.id,
    entityType: "workspace",
    session: auth.session,
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
}
