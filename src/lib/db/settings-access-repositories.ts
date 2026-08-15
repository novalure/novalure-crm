import { createHash, randomBytes } from "node:crypto";
import type { AppSession } from "@/lib/auth/session";
import { getPasswordValidationError, hashPassword, verifyPassword } from "@/lib/auth/passwords";
import type { WorkspaceRole, WorkspaceUser } from "@/lib/crm-types";
import { getTrustedAppOrigin } from "@/lib/auth/app-origin";
import { executeQuery, queryOne, queryRows } from "@/lib/db/client";
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

type IdRow = { id: string };

type PasswordUserRow = {
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

function hashToken(value: string) {
  return createHash("sha256").update(value).digest("hex");
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

  const token = randomBytes(32).toString("base64url");
  const resetUrl = new URL("/login/reset-password", getTrustedAppOrigin());
  resetUrl.searchParams.set("token", token);
  resetUrl.searchParams.set("lang", input.language === "de" ? "de" : "en");

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
      values ($1, $2, $3, $4, $5, $6, now() + interval '60 minutes')
      returning id
    `,
    [
      input.session.workspaceId,
      user.id,
      hashToken(token),
      user.email,
      input.requestIp ?? null,
      input.userAgent ?? null,
    ],
  );

  const provider = getNewsletterProviderStatus();
  const language = input.language === "de" ? "de" : "en";
  const subject = language === "de" ? "Passwort für Novalure CRM neu setzen" : "Reset your Novalure CRM password";
  const safeName = escapeHtml(user.name || user.email);
  const safeResetUrl = escapeHtml(resetUrl.toString());
  const html = language === "de"
    ? `<p>Hallo ${safeName},</p><p>Ein Administrator hat einen Passwort-Link für Ihren Novalure CRM Zugang ausgelöst.</p><p><a href="${safeResetUrl}">${safeResetUrl}</a></p><p>Der Link ist 60 Minuten gültig und kann nur einmal verwendet werden.</p>`
    : `<p>Hello ${safeName},</p><p>An administrator requested a password link for your Novalure CRM account.</p><p><a href="${safeResetUrl}">${safeResetUrl}</a></p><p>The link expires after 60 minutes and can only be used once.</p>`;

  const delivery = await sendNewsletterEmail({
    html,
    idempotencyKey: `settings-password-reset:${user.id}:${hashToken(token).slice(0, 16)}`,
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

  return {
    data: {
      deliveryConfigured: provider.configured,
      deliveryProvider: delivery.provider,
      deliveryStatus: delivery.status,
      setupUrl: resetUrl.toString(),
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
      select id, workspace_id as "workspaceId", email, password_hash as "passwordHash"
      from workspace_users
      where id = $1
        and workspace_id = $2
        and status = 'active'
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

  await executeQuery(
    `
      update workspace_users
      set password_hash = $3, updated_at = now()
      where id = $1
        and workspace_id = $2
    `,
    [user.id, user.workspaceId, await hashPassword(password)],
  );

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
