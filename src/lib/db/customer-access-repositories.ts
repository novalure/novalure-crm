import { createHash, randomBytes } from "crypto";
import type { AppSession } from "@/lib/auth/session";
import type {
  CustomerWorkspaceAccess,
  CustomerWorkspaceAccessStatus,
  Project,
  WorkspaceRole,
  WorkspaceUser,
} from "@/lib/crm-types";
import {
  customerWorkspaceAccess as mockCustomerWorkspaceAccess,
  projects as mockProjects,
  users as mockUsers,
} from "@/lib/crm-data";
import { writeCrmAnalyticsEvent } from "@/lib/db/analytics-event-repositories";
import { queryOne, queryRows } from "@/lib/db/client";
import { canPersist, isUuid, writeAuditLog } from "@/lib/db/runtime-repositories";
import { getNewsletterProviderStatus, sendNewsletterEmail } from "@/lib/integrations/resend";
import { isProductRole, mapProductRoleToTechnicalRole, type ProductRole } from "@/lib/product-model";

export type CustomerAccessHealth = CustomerWorkspaceAccess["health"];
export type CustomerAccessProjectRole = WorkspaceRole;
export type CustomerAccessLevel = "viewer" | "editor" | "admin";
export type CustomerAccessGrantStatus = "active" | "invited" | "suspended";

export type CustomerAccessProjectGrant = {
  accessLevel: CustomerAccessLevel;
  canEditProject: boolean;
  canExportData: boolean;
  canViewContacts: boolean;
  canViewProject: boolean;
  customerAccessId: string;
  customerName: string;
  id: string;
  projectId: string;
  projectName: string;
  projectRole: CustomerAccessProjectRole;
  status: CustomerAccessGrantStatus;
  updatedAt: string;
  userEmail: string;
  userId: string;
  userName: string;
  workspaceId: string;
};

export type CustomerAccessAuditEntry = {
  action: string;
  actorName?: string;
  createdAt: string;
  entityId?: string;
  entityType: string;
  id: string;
  projectId?: string;
  summary: string;
  workspaceId: string;
};

export type CustomerAccessCockpitPayload = {
  audits: CustomerAccessAuditEntry[];
  customerAccess: CustomerWorkspaceAccess[];
  grants: CustomerAccessProjectGrant[];
  projects: Project[];
  source: "database" | "fallback";
  users: WorkspaceUser[];
};

export type WorkspaceUserInviteResult = {
  deliveryConfigured: boolean;
  deliveryProvider: string;
  deliveryStatus: string;
  setupUrl: string;
  user: WorkspaceUser;
};

type CustomerAccessRow = {
  activationScore: number | string;
  activeUsers: number | string;
  customerName: string;
  health: CustomerAccessHealth;
  id: string;
  invitedUsers: number | string;
  lastCustomerActivityAt: string | Date | null;
  nextOnboardingAction: string;
  organizationId: string;
  ownerUserId: string | null;
  plan: string;
  projectId: string | null;
  risks: unknown;
  status: CustomerWorkspaceAccessStatus;
  workspaceId: string;
};

type CustomerAccessGrantRow = {
  accessLevel: CustomerAccessLevel;
  canEditProject: boolean;
  canExportData: boolean;
  canViewContacts: boolean;
  canViewProject: boolean;
  customerAccessId: string;
  customerName: string | null;
  id: string;
  projectId: string;
  projectName: string | null;
  projectRole: CustomerAccessProjectRole;
  status: CustomerAccessGrantStatus;
  updatedAt: string | Date;
  userEmail: string | null;
  userId: string;
  userName: string | null;
  workspaceId: string;
};

type WorkspaceUserRow = {
  email: string;
  id: string;
  name: string;
  productRole: ProductRole | null;
  role: WorkspaceRole;
  status: WorkspaceUser["status"];
  workspaceId: string;
};

type RoleGrantValidation =
  | { ok: true }
  | { ok: false; reason: string; status: 403 };

const platformAssignableProductRoles = new Set<ProductRole>(["platform_admin"]);
const novalureInternalAssignableProductRoles = new Set<ProductRole>([
  "novalureGrowth",
  "novalureServiceOps",
  "novalureAdmin",
  "novalure_sales",
  "novalure_onboarding",
  "novalure_customer_success",
  "novalure_operator",
]);
const customerAssignableProductRoles = new Set<ProductRole>([
  "customer_owner",
  "workspace_admin",
  "team_member",
  "broker_agent",
  "developer_sales",
  "project_sales_member",
  "assistant_backoffice",
  "external_partner",
  "viewer",
]);

type ProjectRow = {
  customerType: Project["customerType"] | null;
  defaultOperatingModel: Project["defaultOperatingModel"] | null;
  defaultPipelineId: string | null;
  id: string;
  leads: number | string;
  name: string;
  revenueCents: number | string | null;
  setupDefaults: Project["setupDefaults"] | null;
  status: Project["status"];
  type: string;
  workspaceId: string;
};

type AuditRow = {
  action: string;
  actorName: string | null;
  after: unknown;
  before: unknown;
  createdAt: string | Date;
  entityId: string | null;
  entityType: string;
  id: string;
  projectId: string | null;
  workspaceId: string;
};

type IdRow = { id: string };

const customerAccessStatuses: CustomerWorkspaceAccessStatus[] = [
  "lead",
  "demo",
  "trial",
  "onboarding",
  "active",
  "risk",
];

const customerAccessHealthValues: CustomerAccessHealth[] = ["healthy", "attention", "risk"];
const workspaceRoles: WorkspaceRole[] = ["owner", "admin", "agent", "assistant"];
const grantAccessLevels: CustomerAccessLevel[] = ["viewer", "editor", "admin"];
const grantStatuses: CustomerAccessGrantStatus[] = ["active", "invited", "suspended"];

export async function listCustomerAccessCockpit(input: {
  projectId?: string | null;
  session: AppSession;
}): Promise<CustomerAccessCockpitPayload> {
  const projectId = normalizeUuid(input.projectId);

  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return getFallbackCustomerAccessCockpit(projectId);
  }

  try {
    const [customerAccess, users, projects, grants, audits] = await Promise.all([
      loadCustomerWorkspaceAccess(input.session.workspaceId, projectId),
      loadWorkspaceUsers(input.session.workspaceId),
      loadCustomerProjects(input.session.workspaceId),
      loadProjectGrants(input.session.workspaceId, projectId),
      loadCustomerAccessAudits(input.session.workspaceId, projectId),
    ]);

    return {
      audits,
      customerAccess,
      grants,
      projects,
      source: "database",
      users,
    };
  } catch {
    return getFallbackCustomerAccessCockpit(projectId);
  }
}

export async function updateCustomerAccessRecord(input: {
  accessId: string;
  activeUsers?: unknown;
  activationScore?: unknown;
  health?: unknown;
  invitedUsers?: unknown;
  nextOnboardingAction?: unknown;
  plan?: unknown;
  risks?: unknown;
  session: AppSession;
  status?: unknown;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId) || !isUuid(input.accessId)) {
    return { ok: false as const, reason: "DATABASE_URL is not configured" };
  }

  const existing = await queryOne<CustomerAccessRow>(
    `${customerAccessSelectSql}
     where ca.workspace_id = $1 and ca.id = $2
     limit 1`,
    [input.session.workspaceId, input.accessId],
  );
  if (!existing) return { ok: false as const, reason: "Customer access record not found" };

  const status = normalizeCustomerAccessStatus(input.status) ?? existing.status;
  const health = normalizeHealth(input.health) ?? existing.health;
  const plan = cleanString(input.plan) || existing.plan;
  const nextOnboardingAction = cleanString(input.nextOnboardingAction) || existing.nextOnboardingAction;
  const risks = normalizeRisks(input.risks, existing.risks);
  const invitedUsers = clampInteger(input.invitedUsers, 0, 500, Number(existing.invitedUsers ?? 0));
  const activeUsers = clampInteger(input.activeUsers, 0, 500, Number(existing.activeUsers ?? 0));
  const activationScore = clampInteger(input.activationScore, 0, 100, Number(existing.activationScore ?? 0));

  const row = await queryOne<CustomerAccessRow>(
    `
      update customer_workspace_access ca
      set
        status = $3,
        plan = $4,
        invited_users = $5,
        active_users = $6,
        activation_score = $7,
        health = $8,
        next_onboarding_action = $9,
        risks = $10::jsonb,
        metadata = metadata || $11::jsonb,
        last_customer_activity_at = now(),
        updated_at = now()
      where ca.workspace_id = $1 and ca.id = $2
      returning
        ca.id,
        ca.workspace_id as "workspaceId",
        ca.organization_id as "organizationId",
        ca.project_id as "projectId",
        (select name from organizations where id = ca.organization_id) as "customerName",
        ca.owner_user_id as "ownerUserId",
        ca.status,
        ca.plan,
        ca.invited_users as "invitedUsers",
        ca.active_users as "activeUsers",
        ca.activation_score as "activationScore",
        ca.health,
        ca.last_customer_activity_at as "lastCustomerActivityAt",
        ca.next_onboarding_action as "nextOnboardingAction",
        ca.risks
    `,
    [
      input.session.workspaceId,
      input.accessId,
      status,
      plan,
      invitedUsers,
      activeUsers,
      activationScore,
      health,
      nextOnboardingAction,
      JSON.stringify(risks),
      JSON.stringify({ updatedByUserId: input.session.userId, source: "customer_access_cockpit" }),
    ],
  );

  if (!row) return { ok: false as const, reason: "Customer access record could not be saved" };

  await Promise.all([
    writeAuditLog({
      action: "customer_access.status_updated",
      after: {
        activationScore,
        activeUsers,
        health,
        invitedUsers,
        nextOnboardingAction,
        plan,
        risks,
        status,
      },
      before: toCustomerWorkspaceAccess(existing),
      entityId: row.id,
      entityType: "customer_workspace_access",
      projectId: row.projectId,
      session: input.session,
    }),
    writeCrmAnalyticsEvent({
      entityId: row.id,
      entityType: "customer_workspace_access",
      eventType: "customer_access_updated",
      metadata: {
        activationScore,
        activeUsers,
        health,
        invitedUsers,
        nextOnboardingAction,
        plan,
        status,
      },
      module: "dashboard",
      projectId: row.projectId,
      source: "customer_access_cockpit",
      userId: input.session.userId,
      workspaceId: input.session.workspaceId,
    }),
  ]);

  return { data: toCustomerWorkspaceAccess(row), ok: true as const };
}

export async function upsertCustomerProjectGrant(input: {
  accessId: string;
  accessLevel?: unknown;
  canEditProject?: unknown;
  canExportData?: unknown;
  canViewContacts?: unknown;
  canViewProject?: unknown;
  projectId: string;
  projectRole?: unknown;
  session: AppSession;
  status?: unknown;
  userId: string;
}) {
  if (
    !canPersist()
    || !isUuid(input.session.workspaceId)
    || !isUuid(input.accessId)
    || !isUuid(input.projectId)
    || !isUuid(input.userId)
  ) {
    return { ok: false as const, reason: "Grant input is incomplete" };
  }

  const existing = await queryOne<IdRow>(
    `
      select ca.id
      from customer_workspace_access ca
      join projects p on p.id = $3 and p.workspace_id = ca.workspace_id
      join workspace_users wu on wu.id = $4 and wu.workspace_id = ca.workspace_id
      where ca.workspace_id = $1 and ca.id = $2
      limit 1
    `,
    [input.session.workspaceId, input.accessId, input.projectId, input.userId],
  );
  if (!existing) return { ok: false as const, reason: "Customer, user or project not found" };

  const accessLevel = normalizeAccessLevel(input.accessLevel) ?? "viewer";
  const projectRole = normalizeWorkspaceRole(input.projectRole) ?? "assistant";
  const grantStatus = normalizeGrantStatus(input.status) ?? "active";
  const defaults = defaultsForAccessLevel(accessLevel);
  const canViewProject = input.canViewProject === undefined ? defaults.canViewProject : Boolean(input.canViewProject);
  const canEditProject = input.canEditProject === undefined ? defaults.canEditProject : Boolean(input.canEditProject);
  const canViewContacts = input.canViewContacts === undefined ? defaults.canViewContacts : Boolean(input.canViewContacts);
  const canExportData = input.canExportData === undefined ? defaults.canExportData : Boolean(input.canExportData);
  const grantIsActive = grantStatus === "active";
  const pipelineCanEdit = grantIsActive && canEditProject;
  const pipelineCanClose = grantIsActive && accessLevel === "admin";

  const row = await queryOne<CustomerAccessGrantRow>(
    `
      insert into customer_project_access (
        workspace_id,
        customer_access_id,
        project_id,
        user_id,
        project_role,
        access_level,
        can_view_project,
        can_edit_project,
        can_view_contacts,
        can_export_data,
        status,
        metadata
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
      on conflict (workspace_id, customer_access_id, project_id, user_id)
      do update set
        project_role = excluded.project_role,
        access_level = excluded.access_level,
        can_view_project = excluded.can_view_project,
        can_edit_project = excluded.can_edit_project,
        can_view_contacts = excluded.can_view_contacts,
        can_export_data = excluded.can_export_data,
        status = excluded.status,
        metadata = customer_project_access.metadata || excluded.metadata,
        updated_at = now()
      returning
        id,
        workspace_id as "workspaceId",
        customer_access_id as "customerAccessId",
        project_id as "projectId",
        user_id as "userId",
        project_role as "projectRole",
        access_level as "accessLevel",
        can_view_project as "canViewProject",
        can_edit_project as "canEditProject",
        can_view_contacts as "canViewContacts",
        can_export_data as "canExportData",
        status,
        updated_at as "updatedAt",
        (select name from organizations where id = (
          select organization_id from customer_workspace_access where id = customer_access_id
        )) as "customerName",
        (select name from projects where id = project_id) as "projectName",
        (select name from workspace_users where id = user_id) as "userName",
        (select email from workspace_users where id = user_id) as "userEmail"
    `,
    [
      input.session.workspaceId,
      input.accessId,
      input.projectId,
      input.userId,
      projectRole,
      accessLevel,
      canViewProject,
      canEditProject,
      canViewContacts,
      canExportData,
      grantStatus,
      JSON.stringify({ updatedByUserId: input.session.userId, source: "customer_access_cockpit" }),
    ],
  );

  await queryOne<IdRow>(
    `
      insert into project_pipeline_permissions (
        workspace_id,
        project_id,
        user_id,
        can_edit_deals,
        can_move_deals,
        can_close_deals,
        can_reopen_deals,
        metadata
      )
      values ($1, $2, $3, $4, $4, $5, $5, $6::jsonb)
      on conflict (workspace_id, project_id, user_id)
      do update set
        can_edit_deals = excluded.can_edit_deals,
        can_move_deals = excluded.can_move_deals,
        can_close_deals = excluded.can_close_deals,
        can_reopen_deals = excluded.can_reopen_deals,
        metadata = project_pipeline_permissions.metadata || excluded.metadata,
        updated_at = now()
      returning id
    `,
    [
      input.session.workspaceId,
      input.projectId,
      input.userId,
      pipelineCanEdit,
      pipelineCanClose,
      JSON.stringify({
        customerAccessId: input.accessId,
        grantStatus,
        source: "customer_access_cockpit",
      }),
    ],
  );

  if (!row) return { ok: false as const, reason: "Project access could not be saved" };

  await Promise.all([
    writeAuditLog({
      action: "customer_access.project_grant_upserted",
      after: {
        ...toProjectGrant(row),
        pipelinePermissions: {
          canCloseDeals: pipelineCanClose,
          canEditDeals: pipelineCanEdit,
          canMoveDeals: pipelineCanEdit,
          canReopenDeals: pipelineCanClose,
        },
      },
      entityId: row.id,
      entityType: "customer_project_access",
      projectId: row.projectId,
      session: input.session,
    }),
    writeCrmAnalyticsEvent({
      entityId: row.id,
      entityType: "customer_project_access",
      eventType: "customer_project_access_updated",
      metadata: {
        accessLevel,
        canEditProject,
        canExportData,
        canViewContacts,
        canViewProject,
        grantStatus,
        pipelineCanClose,
        pipelineCanEdit,
        projectRole,
        userId: input.userId,
      },
      module: "dashboard",
      projectId: row.projectId,
      source: "customer_access_cockpit",
      userId: input.session.userId,
      workspaceId: input.session.workspaceId,
    }),
  ]);

  return { data: toProjectGrant(row), ok: true as const };
}

function canInviteWorkspaceUsers(session: AppSession) {
  if (session.role === "owner" || session.role === "admin") return true;
  return (
    session.productRole === "platform_admin" ||
    session.productRole === "novalureAdmin" ||
    session.productRole === "customer_owner" ||
    session.productRole === "workspace_admin" ||
    session.productRole === "novalure_onboarding" ||
    session.productRole === "novalure_customer_success"
  );
}

function canAssignCustomerProductRole(session: AppSession, targetProductRole: ProductRole) {
  if (!customerAssignableProductRoles.has(targetProductRole)) return false;

  if (
    session.productRole === "platform_admin" ||
    session.productRole === "novalureAdmin" ||
    session.productRole === "novalure_onboarding" ||
    session.productRole === "novalure_customer_success" ||
    session.productRole === "customer_owner"
  ) {
    return true;
  }

  if (session.productRole === "workspace_admin") {
    return targetProductRole !== "customer_owner";
  }

  if (session.role === "owner") return true;
  if (session.role === "admin") return targetProductRole !== "customer_owner";

  return false;
}

function validateWorkspaceUserRoleGrant(input: {
  session: AppSession;
  targetProductRole: ProductRole;
  targetRole: WorkspaceRole;
}): RoleGrantValidation {
  const expectedRole = mapProductRoleToTechnicalRole(input.targetProductRole);

  if (input.targetRole !== expectedRole) {
    return {
      ok: false,
      reason: "Target role does not match the selected product role",
      status: 403,
    };
  }

  if (platformAssignableProductRoles.has(input.targetProductRole)) {
    return input.session.productRole === "platform_admin"
      ? { ok: true }
      : {
          ok: false,
          reason: "Only platform admins can grant the platform admin product role",
          status: 403,
        };
  }

  if (novalureInternalAssignableProductRoles.has(input.targetProductRole)) {
    return input.session.productRole === "platform_admin" || input.session.productRole === "novalureAdmin"
      ? { ok: true }
      : {
          ok: false,
          reason: "Only platform or Novalure admins can grant internal product roles",
          status: 403,
        };
  }

  if (canAssignCustomerProductRole(input.session, input.targetProductRole)) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: "Workspace invitation target role is not allowed for this actor",
    status: 403,
  };
}

function normalizeInviteEmail(value: unknown) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function hashInviteToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function getInviteEmailCopy(language: string, setupUrl: string) {
  if (language === "de") {
    return {
      html: `<p>Sie wurden zu Novalure CRM eingeladen.</p><p>Legen Sie Ihr Passwort über diesen sicheren Link selbst fest:</p><p><a href="${setupUrl}">${setupUrl}</a></p><p>Wenn Sie diese Einladung nicht erwartet haben, ignorieren Sie diese Nachricht.</p>`,
      subject: "Einladung zu Novalure CRM",
    };
  }

  return {
    html: `<p>You have been invited to Novalure CRM.</p><p>Set your own password using this secure link:</p><p><a href="${setupUrl}">${setupUrl}</a></p><p>If you did not expect this invitation, ignore this message.</p>`,
    subject: "Invitation to Novalure CRM",
  };
}

export async function inviteWorkspaceUser(input: {
  email?: unknown;
  language?: string;
  name?: unknown;
  origin: string;
  productRole?: unknown;
  requestIp?: string | null;
  role?: unknown;
  session: AppSession;
  userAgent?: string | null;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId)) {
    return { ok: false as const, reason: "Database persistence is not configured" };
  }

  if (!canInviteWorkspaceUsers(input.session)) {
    return { ok: false as const, reason: "Workspace invitation is not allowed for this role" };
  }

  const email = normalizeInviteEmail(input.email);
  if (!email) return { ok: false as const, reason: "Valid email is required" };

  const role = normalizeWorkspaceRole(input.role) ?? "assistant";
  const productRole = isProductRole(input.productRole) ? input.productRole : "viewer";
  const roleGrant = validateWorkspaceUserRoleGrant({
    session: input.session,
    targetProductRole: productRole,
    targetRole: role,
  });
  if (!roleGrant.ok) return { ok: false as const, reason: roleGrant.reason, status: roleGrant.status };

  if (role === "owner" && input.session.role !== "owner" && input.session.productRole !== "platform_admin") {
    return { ok: false as const, reason: "Only owners can invite another owner" };
  }

  const existing = await queryOne<WorkspaceUserRow>(
    `
      select id, workspace_id as "workspaceId", name, email, role, product_role as "productRole", status
      from workspace_users
      where workspace_id = $1 and lower(email) = $2
      limit 1
    `,
    [input.session.workspaceId, email],
  );

  if (existing?.status === "active") {
    return { ok: false as const, reason: "Workspace user is already active" };
  }

  const displayName = typeof input.name === "string" && input.name.trim()
    ? input.name.trim()
    : email.split("@")[0] || email;

  const row = existing
    ? await queryOne<WorkspaceUserRow>(
        `
          update workspace_users
          set name = $3,
              role = $4,
              product_role = $5,
              status = 'invited',
              password_hash = null,
              updated_at = now()
          where id = $1 and workspace_id = $2
          returning id, workspace_id as "workspaceId", name, email, role, product_role as "productRole", status
        `,
        [existing.id, input.session.workspaceId, displayName, role, productRole],
      )
    : await queryOne<WorkspaceUserRow>(
        `
          insert into workspace_users (
            workspace_id,
            name,
            email,
            role,
            status,
            product_role,
            password_hash
          )
          values ($1, $2, $3, $4, 'invited', $5, null)
          returning id, workspace_id as "workspaceId", name, email, role, product_role as "productRole", status
        `,
        [input.session.workspaceId, displayName, email, role, productRole],
      );

  if (!row) return { ok: false as const, reason: "Workspace invitation could not be saved" };

  const token = randomBytes(32).toString("base64url");
  const setupUrl = new URL("/login/reset-password", input.origin);
  setupUrl.searchParams.set("token", token);
  setupUrl.searchParams.set("lang", input.language === "de" ? "de" : "en");

  await queryOne<IdRow>(
    `
      insert into auth_password_reset_tokens (
        workspace_id,
        user_id,
        token_hash,
        requested_email,
        request_ip,
        user_agent,
        expires_at
      )
      values ($1, $2, $3, $4, $5, $6, now() + ($7::int * interval '1 minute'))
      returning id
    `,
    [
      input.session.workspaceId,
      row.id,
      hashInviteToken(token),
      email,
      input.requestIp ?? null,
      input.userAgent ?? null,
      10080,
    ],
  );

  const provider = getNewsletterProviderStatus();
  const emailCopy = getInviteEmailCopy(input.language ?? "en", setupUrl.toString());
  const delivery = await sendNewsletterEmail({
    html: emailCopy.html,
    subject: emailCopy.subject,
    to: email,
  });

  await queryOne<IdRow>(
    `
      update customer_workspace_access
      set
        active_users = (select count(*) from workspace_users where workspace_id = $1 and status = 'active'),
        invited_users = (select count(*) from workspace_users where workspace_id = $1 and status = 'invited'),
        updated_at = now()
      where workspace_id = $1
      returning id
    `,
    [input.session.workspaceId],
  );

  await Promise.all([
    writeAuditLog({
      action: "customer_access.workspace_user_invited",
      after: {
        deliveryProvider: delivery.provider,
        deliveryStatus: delivery.status,
        email,
        role,
        productRole,
        userId: row.id,
      },
      before: existing,
      entityId: row.id,
      entityType: "workspace_user",
      session: input.session,
    }),
    writeCrmAnalyticsEvent({
      entityId: row.id,
      entityType: "workspace_user",
      eventType: "workspace_user_invited",
      metadata: {
        deliveryConfigured: provider.configured,
        deliveryProvider: delivery.provider,
        deliveryStatus: delivery.status,
        productRole,
        role,
      },
      module: "dashboard",
      source: "customer_access_cockpit",
      userId: input.session.userId,
      workspaceId: input.session.workspaceId,
    }),
  ]);

  return {
    data: {
      deliveryConfigured: provider.configured,
      deliveryProvider: delivery.provider,
      deliveryStatus: delivery.status,
      setupUrl: setupUrl.toString(),
      user: { ...row, productRole: row.productRole ?? undefined },
    } satisfies WorkspaceUserInviteResult,
    ok: true as const,
  };
}

export async function updateWorkspaceUserAccess(input: {
  productRole?: unknown;
  role?: unknown;
  session: AppSession;
  status?: unknown;
  userId: string;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId) || !isUuid(input.userId)) {
    return { ok: false as const, reason: "User input is incomplete" };
  }

  const existing = await queryOne<WorkspaceUserRow>(
    `
      select id, workspace_id as "workspaceId", name, email, role, product_role as "productRole", status
      from workspace_users
      where id = $1 and workspace_id = $2
      limit 1
    `,
    [input.userId, input.session.workspaceId],
  );
  if (!existing) return { ok: false as const, reason: "Workspace user not found" };

  const role = normalizeWorkspaceRole(input.role) ?? existing.role;
  const productRole = isProductRole(input.productRole) ? input.productRole : existing.productRole;
  const status = input.status === "active" || input.status === "invited" || input.status === "suspended"
    ? input.status
    : existing.status;
  if (!productRole) return { ok: false as const, reason: "Product role is required" };

  const roleGrant = validateWorkspaceUserRoleGrant({
    session: input.session,
    targetProductRole: productRole,
    targetRole: role,
  });
  if (!roleGrant.ok) return { ok: false as const, reason: roleGrant.reason, status: roleGrant.status };

  if (existing.role === "owner" && existing.status === "active" && (role !== "owner" || status !== "active")) {
    const owners = await queryRows<IdRow>(
      "select id from workspace_users where workspace_id = $1 and role = 'owner' and status = 'active' limit 2",
      [input.session.workspaceId],
    );
    if (owners.length < 2) return { ok: false as const, reason: "At least one active owner is required" };
  }

  if (input.userId === input.session.userId && status !== "active") {
    return { ok: false as const, reason: "Current user cannot be deactivated" };
  }

  const row = await queryOne<WorkspaceUserRow>(
    `
      update workspace_users
      set role = $3,
          status = $4,
          product_role = $5,
          updated_at = now()
      where id = $1 and workspace_id = $2
      returning id, workspace_id as "workspaceId", name, email, role, product_role as "productRole", status
    `,
    [input.userId, input.session.workspaceId, role, status, productRole],
  );

  if (!row) return { ok: false as const, reason: "Workspace user could not be saved" };

  await Promise.all([
    writeAuditLog({
      action: "customer_access.workspace_user_updated",
      after: row,
      before: existing,
      entityId: row.id,
      entityType: "workspace_user",
      session: input.session,
    }),
    writeCrmAnalyticsEvent({
      entityId: row.id,
      entityType: "workspace_user",
      eventType: "workspace_user_access_updated",
      metadata: {
        role,
        productRole,
        status,
        targetUserId: row.id,
      },
      module: "dashboard",
      source: "customer_access_cockpit",
      userId: input.session.userId,
      workspaceId: input.session.workspaceId,
    }),
  ]);

  return { data: row, ok: true as const };
}

const customerAccessSelectSql = `
  select
    ca.id,
    ca.workspace_id as "workspaceId",
    ca.organization_id as "organizationId",
    ca.project_id as "projectId",
    coalesce(o.name, ca.metadata->>'customerName', 'Customer') as "customerName",
    ca.owner_user_id as "ownerUserId",
    ca.status,
    ca.plan,
    ca.invited_users as "invitedUsers",
    ca.active_users as "activeUsers",
    ca.activation_score as "activationScore",
    ca.health,
    ca.last_customer_activity_at as "lastCustomerActivityAt",
    ca.next_onboarding_action as "nextOnboardingAction",
    ca.risks
  from customer_workspace_access ca
  left join organizations o on o.id = ca.organization_id and o.workspace_id = ca.workspace_id
`;

async function loadCustomerWorkspaceAccess(workspaceId: string, projectId: string | null) {
  const rows = await queryRows<CustomerAccessRow>(
    `${customerAccessSelectSql}
     where ca.workspace_id = $1
       and ($2::uuid is null or ca.project_id is null or ca.project_id = $2::uuid)
     order by
       case ca.health when 'risk' then 0 when 'attention' then 1 else 2 end,
       ca.activation_score asc,
       ca.updated_at desc`,
    [workspaceId, projectId],
  );

  return rows.map(toCustomerWorkspaceAccess);
}

async function loadWorkspaceUsers(workspaceId: string) {
  const rows = await queryRows<WorkspaceUserRow>(
    `
      select id, workspace_id as "workspaceId", name, email, role, product_role as "productRole", status
      from workspace_users
      where workspace_id = $1
      order by case status when 'active' then 0 else 1 end, name asc
    `,
    [workspaceId],
  );

  return rows.map((row) => ({
    ...row,
    productRole: row.productRole ?? undefined,
  }));
}

async function loadCustomerProjects(workspaceId: string) {
  const rows = await queryRows<ProjectRow>(
    `
      select
        p.id,
        p.workspace_id as "workspaceId",
        p.name,
        p.type,
        p.status,
        p.customer_type as "customerType",
        p.default_operating_model as "defaultOperatingModel",
        p.default_pipeline_id as "defaultPipelineId",
        p.setup_defaults as "setupDefaults",
        count(distinct l.id) as leads,
        coalesce(sum(d.value_cents), 0) as "revenueCents"
      from projects p
      left join leads l on l.project_id = p.id and l.workspace_id = p.workspace_id
      left join deals d on d.project_id = p.id and d.workspace_id = p.workspace_id
      where p.workspace_id = $1
      group by p.id
      order by p.updated_at desc
    `,
    [workspaceId],
  );

  return rows.map(toProject);
}

async function loadProjectGrants(workspaceId: string, projectId: string | null) {
  try {
    const rows = await queryRows<CustomerAccessGrantRow>(
      `
        select
          cpa.id,
          cpa.workspace_id as "workspaceId",
          cpa.customer_access_id as "customerAccessId",
          cpa.project_id as "projectId",
          cpa.user_id as "userId",
          cpa.project_role as "projectRole",
          cpa.access_level as "accessLevel",
          cpa.can_view_project as "canViewProject",
          cpa.can_edit_project as "canEditProject",
          cpa.can_view_contacts as "canViewContacts",
          cpa.can_export_data as "canExportData",
          cpa.status,
          cpa.updated_at as "updatedAt",
          o.name as "customerName",
          p.name as "projectName",
          wu.name as "userName",
          wu.email as "userEmail"
        from customer_project_access cpa
        join customer_workspace_access ca on ca.id = cpa.customer_access_id and ca.workspace_id = cpa.workspace_id
        left join organizations o on o.id = ca.organization_id and o.workspace_id = ca.workspace_id
        join projects p on p.id = cpa.project_id and p.workspace_id = cpa.workspace_id
        join workspace_users wu on wu.id = cpa.user_id and wu.workspace_id = cpa.workspace_id
        where cpa.workspace_id = $1
          and ($2::uuid is null or cpa.project_id = $2::uuid)
        order by o.name asc, p.name asc, wu.name asc
      `,
      [workspaceId, projectId],
    );

    return rows.map(toProjectGrant);
  } catch {
    return [];
  }
}

async function loadCustomerAccessAudits(workspaceId: string, projectId: string | null) {
  const rows = await queryRows<AuditRow>(
    `
      select
        al.id,
        al.workspace_id as "workspaceId",
        al.project_id as "projectId",
        al.action,
        al.entity_type as "entityType",
        al.entity_id as "entityId",
        al.before,
        al.after,
        al.created_at as "createdAt",
        wu.name as "actorName"
      from audit_logs al
      left join workspace_users wu on wu.id = al.actor_user_id and wu.workspace_id = al.workspace_id
      where al.workspace_id = $1
        and (
          al.entity_type in ('customer_workspace_access', 'customer_project_access', 'workspace_user')
          or al.action like 'customer_access.%'
        )
        and ($2::uuid is null or al.project_id is null or al.project_id = $2::uuid)
      order by al.created_at desc
      limit 50
    `,
    [workspaceId, projectId],
  );

  return rows.map(toAuditEntry);
}

function getFallbackCustomerAccessCockpit(projectId: string | null): CustomerAccessCockpitPayload {
  const customerAccess = mockCustomerWorkspaceAccess.filter(
    (item) => !projectId || !item.projectId || item.projectId === projectId,
  );
  const grants = customerAccess
    .filter((item) => item.projectId)
    .map((item): CustomerAccessProjectGrant => {
      const user = mockUsers.find((candidate) => candidate.id === item.ownerUserId) ?? mockUsers[0];
      const project = mockProjects.find((candidate) => candidate.id === item.projectId) ?? mockProjects[0];

      return {
        accessLevel: item.health === "risk" ? "viewer" : "editor",
        canEditProject: item.health !== "risk",
        canExportData: false,
        canViewContacts: true,
        canViewProject: true,
        customerAccessId: item.id,
        customerName: item.customerName,
        id: `fallback_${item.id}_${project.id}_${user.id}`,
        projectId: project.id,
        projectName: project.name,
        projectRole: user.role,
        status: item.status === "risk" ? "suspended" : item.status === "trial" ? "invited" : "active",
        updatedAt: item.lastCustomerActivityAt,
        userEmail: user.email,
        userId: user.id,
        userName: user.name,
        workspaceId: item.workspaceId,
      };
    });

  return {
    audits: [],
    customerAccess,
    grants,
    projects: mockProjects,
    source: "fallback",
    users: mockUsers,
  };
}

function cleanString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function clampInteger(value: unknown, min: number, max: number, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;

  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function defaultsForAccessLevel(accessLevel: CustomerAccessLevel) {
  if (accessLevel === "admin") {
    return { canEditProject: true, canExportData: true, canViewContacts: true, canViewProject: true };
  }
  if (accessLevel === "editor") {
    return { canEditProject: true, canExportData: false, canViewContacts: true, canViewProject: true };
  }

  return { canEditProject: false, canExportData: false, canViewContacts: false, canViewProject: true };
}

function normalizeAccessLevel(value: unknown) {
  return typeof value === "string" && grantAccessLevels.includes(value as CustomerAccessLevel)
    ? value as CustomerAccessLevel
    : null;
}

function normalizeCustomerAccessStatus(value: unknown) {
  return typeof value === "string" && customerAccessStatuses.includes(value as CustomerWorkspaceAccessStatus)
    ? value as CustomerWorkspaceAccessStatus
    : null;
}

function normalizeGrantStatus(value: unknown) {
  return typeof value === "string" && grantStatuses.includes(value as CustomerAccessGrantStatus)
    ? value as CustomerAccessGrantStatus
    : null;
}

function normalizeHealth(value: unknown) {
  return typeof value === "string" && customerAccessHealthValues.includes(value as CustomerAccessHealth)
    ? value as CustomerAccessHealth
    : null;
}

function normalizeRisks(value: unknown, fallback: unknown) {
  if (Array.isArray(value)) {
    return value.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 12);
  }

  if (typeof value === "string") {
    return value.split(/\n|,/).map((item) => item.trim()).filter(Boolean).slice(0, 12);
  }

  return Array.isArray(fallback) ? fallback.map(String).filter(Boolean) : [];
}

function normalizeUuid(value: unknown) {
  return isUuid(typeof value === "string" ? value : null) ? value as string : null;
}

function normalizeWorkspaceRole(value: unknown) {
  return typeof value === "string" && workspaceRoles.includes(value as WorkspaceRole)
    ? value as WorkspaceRole
    : null;
}

function toAuditEntry(row: AuditRow): CustomerAccessAuditEntry {
  return {
    action: row.action,
    actorName: row.actorName ?? undefined,
    createdAt: toIso(row.createdAt),
    entityId: row.entityId ?? undefined,
    entityType: row.entityType,
    id: row.id,
    projectId: row.projectId ?? undefined,
    summary: summarizeAudit(row),
    workspaceId: row.workspaceId,
  };
}

function toCustomerWorkspaceAccess(row: CustomerAccessRow): CustomerWorkspaceAccess {
  return {
    activationScore: Number(row.activationScore ?? 0),
    activeUsers: Number(row.activeUsers ?? 0),
    customerName: row.customerName,
    health: row.health,
    id: row.id,
    invitedUsers: Number(row.invitedUsers ?? 0),
    lastCustomerActivityAt: toIso(row.lastCustomerActivityAt),
    nextOnboardingAction: row.nextOnboardingAction,
    organizationId: row.organizationId,
    ownerUserId: row.ownerUserId ?? "",
    plan: row.plan,
    projectId: row.projectId ?? undefined,
    risks: normalizeRisks(null, row.risks),
    status: row.status,
    workspaceId: row.workspaceId,
  };
}

function toProject(row: ProjectRow): Project {
  const revenueCents = Number(row.revenueCents ?? 0);

  return {
    customerType: row.customerType ?? undefined,
    defaultOperatingModel: row.defaultOperatingModel ?? undefined,
    defaultPipelineId: row.defaultPipelineId ?? "",
    id: row.id,
    leads: Number(row.leads ?? 0),
    name: row.name,
    revenue: new Intl.NumberFormat("de-AT", {
      currency: "EUR",
      maximumFractionDigits: 0,
      style: "currency",
    }).format(revenueCents / 100),
    setupDefaults: row.setupDefaults ?? undefined,
    status: row.status,
    type: row.type,
    workspaceId: row.workspaceId,
  };
}

function toProjectGrant(row: CustomerAccessGrantRow): CustomerAccessProjectGrant {
  return {
    accessLevel: row.accessLevel,
    canEditProject: Boolean(row.canEditProject),
    canExportData: Boolean(row.canExportData),
    canViewContacts: Boolean(row.canViewContacts),
    canViewProject: Boolean(row.canViewProject),
    customerAccessId: row.customerAccessId,
    customerName: row.customerName ?? "Customer",
    id: row.id,
    projectId: row.projectId,
    projectName: row.projectName ?? "Project",
    projectRole: row.projectRole,
    status: row.status,
    updatedAt: toIso(row.updatedAt),
    userEmail: row.userEmail ?? "",
    userId: row.userId,
    userName: row.userName ?? "User",
    workspaceId: row.workspaceId,
  };
}

function summarizeAudit(row: AuditRow) {
  const after = row.after && typeof row.after === "object" ? row.after as Record<string, unknown> : {};
  const status = cleanString(after.status);
  const health = cleanString(after.health);
  const accessLevel = cleanString(after.accessLevel);
  const role = cleanString(after.role) || cleanString(after.projectRole);

  return [status, health, accessLevel, role].filter(Boolean).join(" / ") || row.action;
}

function toIso(value: string | Date | null) {
  if (!value) return "";
  return value instanceof Date ? value.toISOString() : String(value);
}
