import type { AppSession } from "@/lib/auth/session";
import { getPasswordValidationError, hashPassword, verifyPassword } from "@/lib/auth/passwords";
import { createMembershipPasswordResetLink } from "@/lib/auth/password-reset";
import { writeAuthAuditEvent } from "@/lib/auth/auth-audit";
import type { WorkspaceRole, WorkspaceUser } from "@/lib/crm-types";
import { getTrustedAppOrigin } from "@/lib/auth/app-origin";
import { queryOne, queryRows } from "@/lib/db/client";
import { inviteWorkspaceUser, updateWorkspaceUserAccess } from "@/lib/db/customer-access-repositories";
import { canPersist, isUuid, writeAuditLog } from "@/lib/db/runtime-repositories";
import { getNewsletterProviderStatus, sendNewsletterEmail } from "@/lib/integrations/resend";
import { mapProductRoleToTechnicalRole, type ProductRole } from "@/lib/product-model";

export const customerAssignableSettingsProductRoles: ProductRole[] = [
  "customer_owner",
  "workspace_admin",
  "team_member",
  "broker_agent",
  "developer_sales",
  "project_sales_member",
  "assistant_backoffice",
  "external_partner",
  "viewer",
];

export const settingsWorkspaceRoles: WorkspaceRole[] = ["owner", "admin", "agent", "assistant"];

export type WorkspaceAccessSettingsPayload = {
  canManage: boolean;
  customerProductRoles: ProductRole[];
  source: "database" | "fallback";
  users: WorkspaceUser[];
  workspaceRoles: WorkspaceRole[];
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

type PasswordUserRow = {
  authIdentityId: string;
  email: string;
  id: string;
  passwordHash: string | null;
  workspaceId: string;
};

function toWorkspaceUser(row: WorkspaceUserRow): WorkspaceUser {
  return {
    email: row.email,
    id: row.id,
    name: row.name,
    productRole: row.productRole ?? undefined,
    role: row.role,
    status: row.status,
    workspaceId: row.workspaceId,
  };
}

function normalizeEmail(value: unknown) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function canManageAccess(session: AppSession) {
  return session.permissions.includes("settings:manage") || session.productPermissions.includes("workspace:admin");
}

export async function listWorkspaceAccessSettings(session: AppSession): Promise<WorkspaceAccessSettingsPayload> {
  if (!canPersist() || !isUuid(session.workspaceId)) {
    return {
      canManage: canManageAccess(session),
      customerProductRoles: customerAssignableSettingsProductRoles,
      source: "fallback",
      users: [],
      workspaceRoles: settingsWorkspaceRoles,
    };
  }

  const rows = await queryRows<WorkspaceUserRow>(
    `
      select id, workspace_id as "workspaceId", name, email, role, product_role as "productRole", status
      from workspace_users
      where workspace_id = $1
      order by
        case status when 'active' then 0 when 'invited' then 1 else 2 end,
        case role when 'owner' then 0 when 'admin' then 1 when 'agent' then 2 else 3 end,
        name asc
    `,
    [session.workspaceId],
  );

  return {
    canManage: canManageAccess(session),
    customerProductRoles: customerAssignableSettingsProductRoles,
    source: "database",
    users: rows.map(toWorkspaceUser),
    workspaceRoles: settingsWorkspaceRoles,
  };
}

export async function inviteSettingsWorkspaceUser(input: {
  email?: unknown;
  language?: string;
  name?: unknown;
  productRole?: unknown;
  requestIp?: string | null;
  role?: unknown;
  session: AppSession;
  userAgent?: string | null;
}) {
  return inviteWorkspaceUser({
    email: input.email,
    language: input.language,
    name: input.name,
    origin: getTrustedAppOrigin(),
    productRole: input.productRole,
    requestIp: input.requestIp,
    role: input.role,
    session: input.session,
    userAgent: input.userAgent,
  });
}

export async function updateSettingsWorkspaceUser(input: {
  productRole?: unknown;
  role?: unknown;
  session: AppSession;
  status?: unknown;
  userId: string;
}) {
  return updateWorkspaceUserAccess(input);
}

export async function revokeWorkspaceInvitation(input: {
  session: AppSession;
  userId: string;
}) {
  return updateWorkspaceUserAccess({
    session: input.session,
    status: "suspended",
    userId: input.userId,
  });
}

export async function resendWorkspaceInvitation(input: {
  language?: string;
  requestIp?: string | null;
  session: AppSession;
  userAgent?: string | null;
  userId: string;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId) || !isUuid(input.userId)) {
    return { ok: false as const, reason: "User input is incomplete", status: 400 };
  }

  const user = await queryOne<WorkspaceUserRow>(
    `
      select id, workspace_id as "workspaceId", name, email, role, product_role as "productRole", status
      from workspace_users
      where id = $1 and workspace_id = $2
      limit 1
    `,
    [input.userId, input.session.workspaceId],
  );

  if (!user || user.status !== "invited") {
    return { ok: false as const, reason: "Only invited users can receive another invitation", status: 400 };
  }

  return inviteSettingsWorkspaceUser({
    email: user.email,
    language: input.language,
    name: user.name,
    productRole: user.productRole ?? "viewer",
    requestIp: input.requestIp,
    role: user.role,
    session: input.session,
    userAgent: input.userAgent,
  });
}

export async function triggerWorkspacePasswordReset(input: {
  language?: string;
  requestIp?: string | null;
  session: AppSession;
  userAgent?: string | null;
  userId: string;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId) || !isUuid(input.userId)) {
    return { ok: false as const, reason: "User input is incomplete", status: 400 };
  }

  const user = await queryOne<WorkspaceUserRow>(
    `
      select id, workspace_id as "workspaceId", name, email, role, product_role as "productRole", status
      from workspace_users
      where id = $1 and workspace_id = $2
      limit 1
    `,
    [input.userId, input.session.workspaceId],
  );

  if (!user || user.status === "suspended") {
    return { ok: false as const, reason: "Only active or invited users can reset their password", status: 400 };
  }

  const created = await createMembershipPasswordResetLink({
    language: input.language === "de" ? "de" : "en",
    requestIp: input.requestIp,
    userAgent: input.userAgent,
    workspaceId: input.session.workspaceId,
    workspaceUserId: user.id,
  });

  const provider = getNewsletterProviderStatus();
  const language = input.language === "de" ? "de" : "en";
  const subject = language === "de" ? "Passwort für Novalure CRM neu setzen" : "Reset your Novalure CRM password";
  const safeName = escapeHtml(user.name || user.email);
  const safeResetUrl = escapeHtml(created.resetUrl);
  const html = language === "de"
    ? `<p>Hallo ${safeName},</p><p>Ein Administrator hat einen Passwort-Link für Ihren Novalure CRM Zugang ausgelöst.</p><p><a href="${safeResetUrl}">${safeResetUrl}</a></p><p>Der Link ist 60 Minuten gültig und kann nur einmal verwendet werden.</p>`
    : `<p>Hello ${safeName},</p><p>An administrator requested a password link for your Novalure CRM account.</p><p><a href="${safeResetUrl}">${safeResetUrl}</a></p><p>The link expires after 60 minutes and can only be used once.</p>`;

  const delivery = await sendNewsletterEmail({
    html,
    idempotencyKey: `settings-password-reset:${created.tokenId}`,
    purpose: "password_reset",
    subject,
    to: user.email,
  });

  await writeAuditLog({
    action: "settings_access.password_reset_requested",
    after: {
      deliveryConfigured: provider.configured,
      deliveryProvider: delivery.provider,
      deliveryStatus: delivery.status,
      userId: user.id,
    },
    before: null,
    entityId: user.id,
    entityType: "workspace_user",
    session: input.session,
  });
  await writeAuthAuditEvent({
    authIdentityId: created.authIdentityId,
    eventType: "auth.password_reset.admin_requested",
    metadata: {
      actorUserId: input.session.userId,
      deliveryStatus: delivery.status,
    },
    outcome: delivery.status === "failed" ? "failure" : "success",
    workspaceId: input.session.workspaceId,
    workspaceUserId: user.id,
  });

  return {
    data: {
      deliveryConfigured: provider.configured,
      deliveryProvider: delivery.provider,
      deliveryStatus: delivery.status,
      user: toWorkspaceUser(user),
    },
    ok: true as const,
  };
}

export async function changeOwnWorkspacePassword(input: {
  confirmation?: unknown;
  currentPassword?: unknown;
  password?: unknown;
  session: AppSession;
}) {
  if (!canPersist() || !isUuid(input.session.workspaceId) || !isUuid(input.session.userId)) {
    return { ok: false as const, reason: "password_change_unavailable", status: 503 };
  }

  const currentPassword = typeof input.currentPassword === "string" ? input.currentPassword : "";
  const password = typeof input.password === "string" ? input.password : "";
  const confirmation = typeof input.confirmation === "string" ? input.confirmation : "";
  const validationError = getPasswordValidationError(password, confirmation);
  if (validationError) return { ok: false as const, reason: validationError, status: 400 };

  const user = await queryOne<PasswordUserRow>(
    `
      select
        wu.id,
        wu.workspace_id as "workspaceId",
        wu.email,
        wu.auth_identity_id as "authIdentityId",
        identity.password_hash as "passwordHash"
      from workspace_users wu
      join auth_identities identity on identity.id = wu.auth_identity_id
      where wu.id = $1
        and wu.workspace_id = $2
        and wu.status = 'active'
        and identity.credential_state = 'active'
      limit 1
    `,
    [input.session.userId, input.session.workspaceId],
  );

  if (!user?.passwordHash) {
    return { ok: false as const, reason: "password_change_unavailable", status: 400 };
  }

  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    return { ok: false as const, reason: "current_password_invalid", status: 400 };
  }

  const passwordHash = await hashPassword(password);
  const updated = await queryOne<{ id: string }>(
    `
      with credential_updated as (
        update auth_identities identity
        set password_hash = $2,
            credential_state = 'active',
            password_changed_at = now(),
            updated_at = now()
        where identity.id = $1
          and identity.credential_state = 'active'
        returning identity.id
      ), password_mirrored as (
        update workspace_users wu
        set password_hash = $2, updated_at = now()
        from credential_updated
        where wu.auth_identity_id = credential_updated.id
        returning wu.id
      ), sessions_revoked as (
        update auth_sessions session
        set revoked_at = now(), revoked_reason = 'password_change'
        from credential_updated
        where session.auth_identity_id = credential_updated.id
          and session.revoked_at is null
          and ($3::uuid is null or session.id <> $3::uuid)
        returning session.id
      ), audited as (
        insert into auth_audit_events (
          event_type,
          outcome,
          auth_identity_id,
          workspace_user_id,
          workspace_id,
          session_id,
          metadata
        )
        select
          'auth.password.changed',
          'success',
          credential_updated.id,
          $4::uuid,
          $5::uuid,
          $3::uuid,
          jsonb_build_object('revokedSessionCount', (select count(*) from sessions_revoked))
        from credential_updated
        returning auth_identity_id as id
      )
      select id from audited
    `,
    [
      user.authIdentityId,
      passwordHash,
      input.session.authSessionId ?? null,
      user.id,
      user.workspaceId,
    ],
  );
  if (!updated) return { ok: false as const, reason: "password_change_unavailable", status: 503 };

  await writeAuditLog({
    action: "settings_access.own_password_changed",
    after: { email: user.email },
    before: null,
    entityId: user.id,
    entityType: "workspace_user",
    session: input.session,
  });

  return { ok: true as const };
}

export function getExpectedWorkspaceRoleForProductRole(productRole: ProductRole) {
  return mapProductRoleToTechnicalRole(productRole);
}

export function isValidInviteEmail(value: unknown) {
  return Boolean(normalizeEmail(value));
}
