import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { hasDatabaseUrl, queryOne } from "@/lib/db/client";
import { workspace as mockWorkspace, users as mockUsers } from "@/lib/crm-data";
import { can, getRolePermissions, isAppRole, type AppPermission, type AppRole } from "@/lib/auth/permissions";
import { verifyPassword } from "@/lib/auth/passwords";
import {
  getProductRoleCapabilities,
  hasProductCapability,
  isProductRole,
  resolveProductRole,
  type CalendarProviderChoice,
  type ProductCapability,
  type ProductRole,
  type WorkspaceCustomerType,
  type WorkspaceOperatingModel,
  type WorkspaceTeamStructure,
} from "@/lib/product-model";

export type AppSession = {
  authenticated: boolean;
  userId: string;
  workspaceId: string;
  workspaceName: string;
  email: string;
  name: string;
  role: AppRole;
  permissions: AppPermission[];
  productRole: ProductRole;
  productPermissions: ProductCapability[];
  source: "cookie" | "headers" | "database" | "demo";
  workspaceActiveCalendarProvider?: CalendarProviderChoice | null;
  workspaceCustomerType?: WorkspaceCustomerType | null;
  workspaceOperatingModel?: WorkspaceOperatingModel | null;
  workspaceSetupState?: Record<string, unknown> | null;
  workspaceTeamStructure?: WorkspaceTeamStructure | null;
};

type WorkspaceUserRow = {
  id: string;
  workspaceId: string;
  workspaceName: string;
  name: string;
  email: string;
  passwordHash?: string | null;
  productRole?: ProductRole | null;
  role: AppRole;
  workspaceActiveCalendarProvider?: CalendarProviderChoice | null;
  workspaceCustomerType?: WorkspaceCustomerType | null;
  workspaceOperatingModel?: WorkspaceOperatingModel | null;
  workspaceSetupState?: Record<string, unknown> | null;
  workspaceTeamStructure?: WorkspaceTeamStructure | null;
};

type WorkspaceRow = {
  id: string;
  name: string;
  activeCalendarProvider?: CalendarProviderChoice | null;
  customerType?: WorkspaceCustomerType | null;
  operatingModel?: WorkspaceOperatingModel | null;
  setupState?: Record<string, unknown> | null;
  teamStructure?: WorkspaceTeamStructure | null;
};

type SessionCookiePayload = {
  exp: number;
  userId: string;
  workspaceId: string;
};

export const sessionCookieName = "novalure_session";

const sessionMaxAgeSeconds = 60 * 60 * 8;

export async function getRequestSession(request: Request): Promise<AppSession | null> {
  return getSessionFromHeaders(request.headers);
}

export async function getSessionFromHeaders(headers: Pick<Headers, "get">): Promise<AppSession | null> {
  const demoAuthEnabled = isDemoAuthEnabled();
  const strictAuthEnabled = isStrictAuthEnabled();
  const trustAuthHeaders = shouldTrustAuthHeaders();
  const headerRole = trustAuthHeaders ? headers.get("x-novalure-role") : null;
  const headerProductRole = trustAuthHeaders ? headers.get("x-novalure-product-role") : null;
  const configuredDemoRole = isAppRole(process.env.NOVALURE_DEMO_USER_ROLE)
    ? process.env.NOVALURE_DEMO_USER_ROLE
    : null;
  const role = isAppRole(headerRole) ? headerRole : configuredDemoRole ?? "assistant";
  const trustedProductRole = isProductRole(headerProductRole) ? headerProductRole : null;
  const email =
    (trustAuthHeaders ? headers.get("x-novalure-user-email") : null) ||
    (demoAuthEnabled ? process.env.NOVALURE_DEMO_USER_EMAIL || mockUsers[0]?.email || "franz@novalure.local" : "");
  const name =
    (trustAuthHeaders ? headers.get("x-novalure-user-name") : null) ||
    (demoAuthEnabled ? process.env.NOVALURE_DEMO_USER_NAME || "Franz" : "");
  const headerWorkspaceId = trustAuthHeaders ? headers.get("x-novalure-workspace-id") : null;
  const headerUserId = trustAuthHeaders ? headers.get("x-novalure-user-id") : null;
  const headerWorkspaceUuid = isUuidLike(headerWorkspaceId) ? headerWorkspaceId : null;
  const headerUserUuid = isUuidLike(headerUserId) ? headerUserId : null;

  const cookieSession = await getSessionFromCookieHeader(headers.get("cookie"));
  if (cookieSession) return cookieSession;

  if (!hasDatabaseUrl() && trustAuthHeaders && headerWorkspaceId && headerUserId) {
    const productRole = resolveProductRole({
      productRole: trustedProductRole,
      technicalRole: role,
      workspaceName: mockWorkspace.name,
    });

    return {
      authenticated: true,
      userId: headerUserId,
      workspaceId: headerWorkspaceId,
      workspaceName: mockWorkspace.name,
      email,
      name,
      role,
      permissions: getRolePermissions(role),
      productPermissions: getProductRoleCapabilities(productRole),
      productRole,
      source: "headers",
      workspaceActiveCalendarProvider: mockWorkspace.activeCalendarProvider ?? "none",
      workspaceCustomerType: mockWorkspace.customerType ?? null,
      workspaceOperatingModel: mockWorkspace.operatingModel ?? null,
      workspaceSetupState: mockWorkspace.setupState ?? null,
      workspaceTeamStructure: mockWorkspace.teamStructure ?? null,
    };
  }

  if (hasDatabaseUrl()) {
    try {
      const existingUser =
        trustAuthHeaders || demoAuthEnabled
          ? await queryOne<WorkspaceUserRow>(
              `
                select
                  wu.id,
                  wu.workspace_id as "workspaceId",
                  w.name as "workspaceName",
                  wu.name,
                  wu.email,
                  wu.product_role as "productRole",
                  w.operating_model as "workspaceOperatingModel",
                  w.customer_type as "workspaceCustomerType",
                  w.team_structure as "workspaceTeamStructure",
                  w.active_calendar_provider as "workspaceActiveCalendarProvider",
                  w.setup_state as "workspaceSetupState",
                  wu.role
                from workspace_users wu
                join workspaces w on w.id = wu.workspace_id
                where wu.status = 'active'
                  and (
                    ($1::uuid is not null and wu.id = $1::uuid)
                    or ($1::uuid is null and $2::text <> '' and lower(wu.email) = lower($2))
                  )
                  and ($3::uuid is null or wu.workspace_id = $3::uuid)
                order by wu.created_at asc
                limit 1
              `,
              [headerUserUuid, email, headerWorkspaceUuid],
            )
          : null;

      if (existingUser) {
        const productRole = resolveProductRole({
          productRole: isProductRole(existingUser.productRole) ? existingUser.productRole : trustedProductRole,
          technicalRole: existingUser.role,
          workspaceName: existingUser.workspaceName,
        });

        return {
          authenticated: true,
          userId: existingUser.id,
          workspaceId: existingUser.workspaceId,
          workspaceName: existingUser.workspaceName,
          email: existingUser.email,
          name: existingUser.name,
          role: existingUser.role,
          permissions: getRolePermissions(existingUser.role),
          productPermissions: getProductRoleCapabilities(productRole),
          productRole,
          source: "database",
          workspaceActiveCalendarProvider: existingUser.workspaceActiveCalendarProvider ?? "none",
          workspaceCustomerType: existingUser.workspaceCustomerType ?? null,
          workspaceOperatingModel: existingUser.workspaceOperatingModel ?? null,
          workspaceSetupState: existingUser.workspaceSetupState ?? null,
          workspaceTeamStructure: existingUser.workspaceTeamStructure ?? null,
        };
      }

      const workspace = await queryOne<WorkspaceRow>(
        `
          select
            id,
            name,
            operating_model as "operatingModel",
            customer_type as "customerType",
            team_structure as "teamStructure",
            active_calendar_provider as "activeCalendarProvider",
            setup_state as "setupState"
          from workspaces
          where $1::uuid is null or id = $1::uuid
          order by created_at asc
          limit 1
        `,
        [headerWorkspaceUuid],
      );

      if (workspace && demoAuthEnabled) {
        const productRole = resolveProductRole({
          productRole: trustedProductRole,
          technicalRole: role,
          workspaceName: workspace.name,
        });

        return {
          authenticated: true,
          userId: headerUserUuid || "00000000-0000-0000-0000-000000000000",
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          email,
          name,
          role,
          permissions: getRolePermissions(role),
          productPermissions: getProductRoleCapabilities(productRole),
          productRole,
          source: "demo",
          workspaceActiveCalendarProvider: workspace.activeCalendarProvider ?? "none",
          workspaceCustomerType: workspace.customerType ?? null,
          workspaceOperatingModel: workspace.operatingModel ?? null,
          workspaceSetupState: workspace.setupState ?? null,
          workspaceTeamStructure: workspace.teamStructure ?? null,
        };
      }
    } catch {
      if (strictAuthEnabled) {
        return null;
      }
    }
  }

  if (strictAuthEnabled) {
    return null;
  }

  const productRole = resolveProductRole({
    productRole: trustedProductRole,
    technicalRole: role,
    workspaceName: mockWorkspace.name,
  });

  return {
    authenticated: true,
    userId: headerUserId || "demo-user",
    workspaceId: headerWorkspaceId || process.env.NOVALURE_WORKSPACE_ID || mockWorkspace.id,
    workspaceName: mockWorkspace.name,
    email,
    name,
    role,
    permissions: getRolePermissions(role),
    productPermissions: getProductRoleCapabilities(productRole),
    productRole,
    source: "demo",
    workspaceActiveCalendarProvider: mockWorkspace.activeCalendarProvider ?? "none",
    workspaceCustomerType: mockWorkspace.customerType ?? null,
    workspaceOperatingModel: mockWorkspace.operatingModel ?? null,
    workspaceSetupState: mockWorkspace.setupState ?? null,
    workspaceTeamStructure: mockWorkspace.teamStructure ?? null,
  };
}

export function serializeSession(session: AppSession) {
  return {
    authenticated: session.authenticated,
    source: session.source,
    user: {
      id: session.userId,
      name: session.name,
      email: session.email,
      role: session.role,
      permissions: session.permissions,
      productPermissions: session.productPermissions,
      productRole: session.productRole,
    },
    workspace: {
      id: session.workspaceId,
      name: session.workspaceName,
      activeCalendarProvider: session.workspaceActiveCalendarProvider,
      customerType: session.workspaceCustomerType,
      operatingModel: session.workspaceOperatingModel,
      setupState: session.workspaceSetupState,
      teamStructure: session.workspaceTeamStructure,
    },
    ...getAuthRuntimeStatus(),
  };
}

export function getAuthRuntimeStatus() {
  const passcodeMode = getLoginPasscodeHash()
    ? "hash"
    : getLoginPasscode()
      ? "plaintext_fallback"
      : "none";

  return {
    demoAuth: isDemoAuthEnabled(),
    loginConfigured: isLoginConfigured(),
    passcodeMode,
    plaintextPasscodeFallback: passcodeMode === "plaintext_fallback",
    sessionConfigured: Boolean(getSessionSecret()),
    strictAuth: isStrictAuthEnabled(),
    trustedAuthHeaders: shouldTrustAuthHeaders(),
  };
}

export async function requirePermission(request: Request, permission: AppPermission) {
  const session = await getRequestSession(request);

  if (!session) {
    return {
      ok: false as const,
      response: Response.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  if (!can(session.role, permission)) {
    return {
      ok: false as const,
      response: Response.json({ error: "Forbidden" }, { status: 403 }),
    };
  }

  return { ok: true as const, session };
}

export async function requireProductCapability(request: Request, capability: ProductCapability) {
  const session = await getRequestSession(request);

  if (!session) {
    return {
      ok: false as const,
      response: Response.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  if (!hasProductCapability(session.productRole, capability)) {
    return {
      ok: false as const,
      response: Response.json({ error: "Forbidden" }, { status: 403 }),
    };
  }

  return { ok: true as const, session };
}

export async function requirePermissionAndProductCapability(
  request: Request,
  permission: AppPermission,
  capability: ProductCapability,
) {
  const auth = await requirePermission(request, permission);
  if (!auth.ok) return auth;

  if (!hasProductCapability(auth.session.productRole, capability)) {
    return {
      ok: false as const,
      response: Response.json({ error: "Forbidden" }, { status: 403 }),
    };
  }

  return auth;
}

export function canSwitchWorkspace(session: AppSession) {
  return (
    hasProductCapability(session.productRole, "managed-service:operate") &&
    hasProductCapability(session.productRole, "novalure:internal")
  );
}

export async function resolveWorkspaceScopedSession(
  request: Request,
  input:
    | { permission: AppPermission; capability?: ProductCapability }
    | { permission?: never; capability: ProductCapability },
) {
  const auth = input.permission
    ? input.capability
      ? await requirePermissionAndProductCapability(request, input.permission, input.capability)
      : await requirePermission(request, input.permission)
    : await requireProductCapability(request, input.capability);

  if (!auth.ok) return auth;

  const url = new URL(request.url);
  const requestedWorkspaceId = isUuidLike(url.searchParams.get("workspaceId"))
    ? url.searchParams.get("workspaceId")
    : null;

  if (!requestedWorkspaceId || requestedWorkspaceId === auth.session.workspaceId) {
    return { ok: true as const, session: auth.session };
  }

  if (!canSwitchWorkspace(auth.session)) {
    return {
      ok: false as const,
      response: Response.json({ error: "Managed-service workspace switch is forbidden" }, { status: 403 }),
    };
  }

  if (!hasDatabaseUrl()) {
    return {
      ok: false as const,
      response: Response.json({ error: "Workspace switch requires database persistence" }, { status: 503 }),
    };
  }

  const workspace = await queryOne<WorkspaceRow>(
    `
      select
        id,
        name,
        operating_model as "operatingModel",
        customer_type as "customerType",
        team_structure as "teamStructure",
        active_calendar_provider as "activeCalendarProvider",
        setup_state as "setupState"
      from workspaces
      where id = $1
      limit 1
    `,
    [requestedWorkspaceId],
  );

  if (!workspace) {
    return {
      ok: false as const,
      response: Response.json({ error: "Workspace not found" }, { status: 404 }),
    };
  }

  return {
    ok: true as const,
    session: {
      ...auth.session,
      workspaceActiveCalendarProvider: workspace.activeCalendarProvider ?? "none",
      workspaceCustomerType: workspace.customerType ?? null,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspaceOperatingModel: workspace.operatingModel ?? null,
      workspaceSetupState: workspace.setupState ?? null,
      workspaceTeamStructure: workspace.teamStructure ?? null,
    },
  };
}

function isUuidLike(value: string | null | undefined) {
  return Boolean(
    value &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
  );
}

function isProductionDeployment() {
  return process.env.VERCEL_ENV === "production";
}

function envValue(name: string) {
  const value = process.env[name]?.trim() ?? "";
  return value.replace(/^['"]|['"]$/g, "");
}

function isDemoAuthEnabled() {
  return process.env.NOVALURE_DEMO_AUTH_ENABLED === "1" && !isProductionDeployment();
}

function shouldTrustAuthHeaders() {
  return process.env.NOVALURE_TRUST_AUTH_HEADERS === "1";
}

function isStrictAuthEnabled() {
  return process.env.NOVALURE_AUTH_STRICT === "1" || isProductionDeployment() || !isDemoAuthEnabled();
}

function getSessionSecret() {
  return envValue("NOVALURE_SESSION_SECRET");
}

function getLoginPasscodeHash() {
  return envValue("NOVALURE_LOGIN_PASSCODE_HASH");
}

function getLoginPasscode() {
  return envValue("NOVALURE_LOGIN_PASSCODE");
}

export function isLoginConfigured() {
  return Boolean(getSessionSecret() && hasDatabaseUrl());
}

function base64UrlEncode(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signSessionPayload(payload: string) {
  const secret = getSessionSecret();
  if (!secret) return null;
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function parseCookieHeader(cookieHeader: string | null | undefined) {
  return Object.fromEntries(
    (cookieHeader ?? "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf("=");
        if (separator === -1) return [part, ""];
        return [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))];
      }),
  );
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function hashLoginPasscode(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function findWorkspaceUserForLogin(email: string) {
  try {
    return await queryOne<WorkspaceUserRow>(
      `
        select
          wu.id,
          wu.workspace_id as "workspaceId",
          w.name as "workspaceName",
          wu.name,
          wu.email,
          wu.password_hash as "passwordHash",
          wu.product_role as "productRole",
          w.operating_model as "workspaceOperatingModel",
          w.customer_type as "workspaceCustomerType",
          w.team_structure as "workspaceTeamStructure",
          w.active_calendar_provider as "workspaceActiveCalendarProvider",
          w.setup_state as "workspaceSetupState",
          wu.role
        from workspace_users wu
        join workspaces w on w.id = wu.workspace_id
        where wu.status = 'active'
          and lower(wu.email) = lower($1)
        order by wu.created_at asc
        limit 1
      `,
      [email],
    );
  } catch {
    return queryOne<WorkspaceUserRow>(
      `
        select
          wu.id,
          wu.workspace_id as "workspaceId",
          w.name as "workspaceName",
          wu.name,
          wu.email,
          null::text as "productRole",
          null::text as "workspaceOperatingModel",
          null::text as "workspaceCustomerType",
          null::text as "workspaceTeamStructure",
          null::text as "workspaceActiveCalendarProvider",
          null::jsonb as "workspaceSetupState",
          wu.role
        from workspace_users wu
        join workspaces w on w.id = wu.workspace_id
        where wu.status = 'active'
          and lower(wu.email) = lower($1)
        order by wu.created_at asc
        limit 1
      `,
      [email],
    );
  }
}

function verifySessionCookie(value: string | null | undefined): SessionCookiePayload | null {
  if (!value) return null;

  const [payload, signature] = value.split(".");
  if (!payload || !signature) return null;

  const expectedSignature = signSessionPayload(payload);
  if (!expectedSignature || !safeEqual(signature, expectedSignature)) return null;

  try {
    const parsed = JSON.parse(base64UrlDecode(payload)) as Partial<SessionCookiePayload>;
    if (!parsed.userId || !parsed.workspaceId || !parsed.exp) return null;
    if (!isUuidLike(parsed.userId) || !isUuidLike(parsed.workspaceId)) return null;
    if (parsed.exp < Date.now()) return null;
    return {
      exp: parsed.exp,
      userId: parsed.userId,
      workspaceId: parsed.workspaceId,
    };
  } catch {
    return null;
  }
}

async function getSessionFromCookieHeader(cookieHeader: string | null | undefined) {
  if (!hasDatabaseUrl()) return null;

  const cookies = parseCookieHeader(cookieHeader);
  const payload = verifySessionCookie(cookies[sessionCookieName]);
  if (!payload) return null;

  const user = await queryOne<WorkspaceUserRow>(
    `
      select
        wu.id,
        wu.workspace_id as "workspaceId",
        w.name as "workspaceName",
        wu.name,
        wu.email,
        wu.product_role as "productRole",
        w.operating_model as "workspaceOperatingModel",
        w.customer_type as "workspaceCustomerType",
        w.team_structure as "workspaceTeamStructure",
        w.active_calendar_provider as "workspaceActiveCalendarProvider",
        w.setup_state as "workspaceSetupState",
        wu.role
      from workspace_users wu
      join workspaces w on w.id = wu.workspace_id
      where wu.status = 'active'
        and wu.id = $1
        and wu.workspace_id = $2
      limit 1
    `,
    [payload.userId, payload.workspaceId],
  );

  if (!user) return null;

  const productRole = resolveProductRole({
    productRole: isProductRole(user.productRole) ? user.productRole : null,
    technicalRole: user.role,
    workspaceName: user.workspaceName,
  });

  return {
    authenticated: true,
    userId: user.id,
    workspaceId: user.workspaceId,
    workspaceName: user.workspaceName,
    email: user.email,
    name: user.name,
    role: user.role,
    permissions: getRolePermissions(user.role),
    productPermissions: getProductRoleCapabilities(productRole),
    productRole,
    source: "cookie" as const,
    workspaceActiveCalendarProvider: user.workspaceActiveCalendarProvider ?? "none",
    workspaceCustomerType: user.workspaceCustomerType ?? null,
    workspaceOperatingModel: user.workspaceOperatingModel ?? null,
    workspaceSetupState: user.workspaceSetupState ?? null,
    workspaceTeamStructure: user.workspaceTeamStructure ?? null,
  };
}

export async function authenticateLogin(input: { email: string; password: string }) {
  if (!hasDatabaseUrl()) {
    return { error: "database_unavailable" as const, session: null };
  }

  if (!isLoginConfigured()) {
    return { error: "login_not_configured" as const, session: null };
  }

  const email = input.email.trim().toLowerCase();
  const password = input.password.trim();

  if (!email || !password) {
    return { error: "invalid_credentials" as const, session: null };
  }

  const user = await findWorkspaceUserForLogin(email);

  if (!user) {
    return { error: "invalid_credentials" as const, session: null };
  }

  const passcodeHash = getLoginPasscodeHash();
  const passcodePlain = getLoginPasscode();
  const passcodeMatches = passcodeHash
    ? safeEqual(hashLoginPasscode(password), passcodeHash)
    : Boolean(passcodePlain && safeEqual(password, passcodePlain));
  const passwordMatches = user.passwordHash
    ? await verifyPassword(password, user.passwordHash)
    : passcodeMatches;

  if (!passwordMatches) {
    return { error: "invalid_credentials" as const, session: null };
  }

  const productRole = resolveProductRole({
    productRole: isProductRole(user.productRole) ? user.productRole : null,
    technicalRole: user.role,
    workspaceName: user.workspaceName,
  });

  return {
    error: null,
    session: {
      authenticated: true,
      userId: user.id,
      workspaceId: user.workspaceId,
      workspaceName: user.workspaceName,
      email: user.email,
      name: user.name,
      role: user.role,
      permissions: getRolePermissions(user.role),
      productPermissions: getProductRoleCapabilities(productRole),
      productRole,
      source: "database" as const,
      workspaceActiveCalendarProvider: user.workspaceActiveCalendarProvider ?? "none",
      workspaceCustomerType: user.workspaceCustomerType ?? null,
      workspaceOperatingModel: user.workspaceOperatingModel ?? null,
      workspaceSetupState: user.workspaceSetupState ?? null,
      workspaceTeamStructure: user.workspaceTeamStructure ?? null,
    } satisfies AppSession,
  };
}

export function createSessionCookie(session: AppSession) {
  const payload = base64UrlEncode(
    JSON.stringify({
      exp: Date.now() + sessionMaxAgeSeconds * 1000,
      userId: session.userId,
      workspaceId: session.workspaceId,
    } satisfies SessionCookiePayload),
  );
  const signature = signSessionPayload(payload);
  if (!signature) throw new Error("NOVALURE_SESSION_SECRET is not configured");

  return {
    maxAge: sessionMaxAgeSeconds,
    name: sessionCookieName,
    value: `${payload}.${signature}`,
  };
}

export function getSessionCookieOptions(maxAge = sessionMaxAgeSeconds) {
  return {
    expires: maxAge <= 0 ? new Date(0) : undefined,
    httpOnly: true,
    maxAge,
    path: "/",
    sameSite: "lax" as const,
    secure: isProductionDeployment(),
  };
}
