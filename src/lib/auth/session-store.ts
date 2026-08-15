import type { AuthenticatedMembership } from "@/lib/auth/auth-flow";
import {
  createOpaqueToken,
  getAuthRequestFingerprint,
  hashOpaqueToken,
  readCookieValue,
} from "@/lib/auth/auth-security";
import { isPrivilegedMembership } from "@/lib/auth/mfa";
import { queryOne } from "@/lib/db/client";
import { isProductRole, resolveProductRole } from "@/lib/product-model";

export const sessionCookieName = "novalure_session";
export const sessionMaxAgeSeconds = 60 * 60 * 8;

const rotationAgeMinutes = 30;

type StoredSessionRow = AuthenticatedMembership & {
  authSessionId: string;
  createdAt: string | Date;
  expiresAt: string | Date;
  mfaVerifiedAt: string | Date | null;
  rotationDue: boolean;
};

function isValidSessionToken(value: string | null | undefined) {
  return Boolean(value && /^v2\.[A-Za-z0-9_-]{43,128}$/.test(value));
}

function getSessionToken(cookieHeader: string | null | undefined) {
  const value = readCookieValue(cookieHeader, sessionCookieName);
  return isValidSessionToken(value) ? value as string : null;
}

function membershipRequiresMfa(membership: AuthenticatedMembership) {
  const productRole = resolveProductRole({
    productRole: isProductRole(membership.productRole) ? membership.productRole : null,
    technicalRole: membership.role,
    workspaceName: membership.workspaceName,
  });
  return isPrivilegedMembership(membership.role, productRole);
}

export async function createPersistedSession(input: {
  membership: AuthenticatedMembership;
  mfaVerifiedAt: Date | null;
  request: Request;
}) {
  if (membershipRequiresMfa(input.membership) && !input.mfaVerifiedAt) {
    throw new Error("Privileged session creation requires verified MFA");
  }

  const value = `v2.${createOpaqueToken(32)}`;
  const fingerprint = getAuthRequestFingerprint(input.request);
  const row = await queryOne<{ expiresAt: string | Date; id: string }>(
    `
      with created_session as (
        insert into auth_sessions (
          token_hash,
          auth_identity_id,
          workspace_user_id,
          workspace_id,
          mfa_verified_at,
          ip_hash,
          user_agent_hash,
          expires_at
        )
        select
          $1,
          identity.id,
          wu.id,
          wu.workspace_id,
          $4::timestamptz,
          $5,
          $6,
          now() + ($7::int * interval '1 second')
        from auth_identities identity
        join workspace_users wu on wu.auth_identity_id = identity.id
        join workspaces w on w.id = wu.workspace_id
        where identity.id = $2
          and identity.credential_state = 'active'
          and wu.id = $3
          and wu.workspace_id = $8
          and wu.status = 'active'
          and (
            $4::timestamptz is not null
            or not (
              wu.role in ('owner', 'admin')
              or coalesce(wu.product_role, '') = any($9::text[])
              or (
                wu.product_role is null
                and wu.role = 'agent'
                and lower(w.name) similar to '%(novalure|internal|jarvis)%'
              )
            )
          )
        returning id, expires_at
      ), audited as (
        insert into auth_audit_events (
          event_type,
          outcome,
          auth_identity_id,
          workspace_user_id,
          workspace_id,
          session_id,
          ip_hash,
          user_agent_hash,
          metadata
        )
        select
          'auth.session.created',
          'success',
          $2::uuid,
          $3::uuid,
          $8::uuid,
          created_session.id,
          $5,
          $6,
          jsonb_build_object('mfaVerified', $4::timestamptz is not null)
        from created_session
        returning session_id
      )
      select created_session.id, created_session.expires_at as "expiresAt"
      from created_session
      where exists (select 1 from audited)
    `,
    [
      hashOpaqueToken(value),
      input.membership.authIdentityId,
      input.membership.id,
      input.mfaVerifiedAt?.toISOString() ?? null,
      fingerprint.ipHash,
      fingerprint.userAgentHash,
      sessionMaxAgeSeconds,
      input.membership.workspaceId,
      [
        "platform_admin",
        "novalureGrowth",
        "novalureServiceOps",
        "novalureAdmin",
        "novalure_sales",
        "novalure_onboarding",
        "novalure_customer_success",
        "novalure_operator",
        "customer_owner",
        "workspace_admin",
      ],
    ],
  );
  if (!row) throw new Error("Session creation failed closed");

  return {
    maxAge: Math.max(0, Math.floor((new Date(row.expiresAt).getTime() - Date.now()) / 1_000)),
    name: sessionCookieName,
    sessionId: row.id,
    value,
  };
}

export async function readPersistedSession(cookieHeader: string | null | undefined) {
  const value = getSessionToken(cookieHeader);
  if (!value) return null;

  const row = await queryOne<StoredSessionRow>(
    `
      with valid_session as (
        select session.*
        from auth_sessions session
        join auth_identities identity on identity.id = session.auth_identity_id
        join workspace_users wu on wu.id = session.workspace_user_id
        join workspaces w on w.id = session.workspace_id
        where session.token_hash = $1
          and session.revoked_at is null
          and session.expires_at > now()
          and identity.credential_state = 'active'
          and wu.auth_identity_id = identity.id
          and wu.workspace_id = session.workspace_id
          and wu.status = 'active'
          and (
            session.mfa_verified_at is not null
            or not (
              wu.role in ('owner', 'admin')
              or coalesce(wu.product_role, '') = any($2::text[])
              or (
                wu.product_role is null
                and wu.role = 'agent'
                and lower(w.name) similar to '%(novalure|internal|jarvis)%'
              )
            )
          )
        limit 1
      )
      select
        valid_session.id as "authSessionId",
        valid_session.auth_identity_id as "authIdentityId",
        valid_session.created_at as "createdAt",
        valid_session.expires_at as "expiresAt",
        valid_session.mfa_verified_at as "mfaVerifiedAt",
        valid_session.created_at < now() - ($3::int * interval '1 minute') as "rotationDue",
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
        w.public_key as "workspacePublicKey",
        w.setup_state as "workspaceSetupState",
        wu.role,
        identity.mfa_enabled_at as "mfaEnabledAt"
      from valid_session
      join auth_identities identity on identity.id = valid_session.auth_identity_id
      join workspace_users wu on wu.id = valid_session.workspace_user_id
      join workspaces w on w.id = valid_session.workspace_id
    `,
    [
      hashOpaqueToken(value),
      [
        "platform_admin",
        "novalureGrowth",
        "novalureServiceOps",
        "novalureAdmin",
        "novalure_sales",
        "novalure_onboarding",
        "novalure_customer_success",
        "novalure_operator",
        "customer_owner",
        "workspace_admin",
      ],
      rotationAgeMinutes,
    ],
  );

  return row ? { ...row, cookieValue: value } : null;
}

export async function touchPersistedRequestSession(cookieHeader: string | null | undefined) {
  const value = getSessionToken(cookieHeader);
  if (!value) return false;

  const row = await queryOne<{ id: string }>(
    `
      update auth_sessions session
      set last_seen_at = now()
      from auth_identities identity, workspace_users membership
      where session.token_hash = $1
        and session.revoked_at is null
        and session.expires_at > now()
        and identity.id = session.auth_identity_id
        and identity.credential_state = 'active'
        and membership.id = session.workspace_user_id
        and membership.auth_identity_id = identity.id
        and membership.workspace_id = session.workspace_id
        and membership.status = 'active'
      returning session.id
    `,
    [hashOpaqueToken(value)],
  );
  return Boolean(row);
}

export async function revokePersistedRequestSession(
  cookieHeader: string | null | undefined,
  reason: string,
) {
  const value = getSessionToken(cookieHeader);
  if (!value) return false;
  const row = await queryOne<{ id: string }>(
    `
      with revoked as (
        update auth_sessions
        set revoked_at = now(), revoked_reason = $2
        where token_hash = $1
          and revoked_at is null
        returning *
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
          'auth.session.revoked',
          'success',
          revoked.auth_identity_id,
          revoked.workspace_user_id,
          revoked.workspace_id,
          revoked.id,
          jsonb_build_object('reason', $2::text)
        from revoked
        returning session_id as id
      )
      select id from audited
    `,
    [hashOpaqueToken(value), reason.slice(0, 100)],
  );
  return Boolean(row);
}

export async function rotatePersistedRequestSession(input: {
  cookieHeader: string | null | undefined;
  request: Request;
}) {
  const previousValue = getSessionToken(input.cookieHeader);
  if (!previousValue) return null;
  const nextValue = `v2.${createOpaqueToken(32)}`;
  const fingerprint = getAuthRequestFingerprint(input.request);
  const row = await queryOne<{ expiresAt: string | Date; id: string }>(
    `
      with revoked as (
        update auth_sessions session
        set revoked_at = now(), revoked_reason = 'rotation'
        from auth_identities identity, workspace_users wu
        where session.token_hash = $1
          and session.revoked_at is null
          and session.expires_at > now()
          and identity.id = session.auth_identity_id
          and identity.credential_state = 'active'
          and wu.id = session.workspace_user_id
          and wu.auth_identity_id = identity.id
          and wu.workspace_id = session.workspace_id
          and wu.status = 'active'
        returning session.*
      ), created as (
        insert into auth_sessions (
          token_hash,
          auth_identity_id,
          workspace_user_id,
          workspace_id,
          mfa_verified_at,
          ip_hash,
          user_agent_hash,
          expires_at,
          rotated_from_session_id
        )
        select
          $2,
          revoked.auth_identity_id,
          revoked.workspace_user_id,
          revoked.workspace_id,
          revoked.mfa_verified_at,
          $3,
          $4,
          revoked.expires_at,
          revoked.id
        from revoked
        returning *
      ), audited as (
        insert into auth_audit_events (
          event_type,
          outcome,
          auth_identity_id,
          workspace_user_id,
          workspace_id,
          session_id,
          ip_hash,
          user_agent_hash,
          metadata
        )
        select
          'auth.session.rotated',
          'success',
          created.auth_identity_id,
          created.workspace_user_id,
          created.workspace_id,
          created.id,
          $3,
          $4,
          jsonb_build_object('rotatedFromSessionId', created.rotated_from_session_id)
        from created
        returning session_id
      )
      select created.id, created.expires_at as "expiresAt"
      from created
      where exists (select 1 from audited)
    `,
    [
      hashOpaqueToken(previousValue),
      hashOpaqueToken(nextValue),
      fingerprint.ipHash,
      fingerprint.userAgentHash,
    ],
  );
  if (!row) return null;

  return {
    maxAge: Math.max(0, Math.floor((new Date(row.expiresAt).getTime() - Date.now()) / 1_000)),
    name: sessionCookieName,
    sessionId: row.id,
    value: nextValue,
  };
}

export async function revokeIdentitySessions(authIdentityId: string, reason: string) {
  const row = await queryOne<{ count: number | string }>(
    `
      with revoked as (
        update auth_sessions
        set revoked_at = now(), revoked_reason = $2
        where auth_identity_id = $1
          and revoked_at is null
        returning id, auth_identity_id, workspace_user_id, workspace_id
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
          'auth.session.revoked',
          'success',
          revoked.auth_identity_id,
          revoked.workspace_user_id,
          revoked.workspace_id,
          revoked.id,
          jsonb_build_object('reason', $2::text)
        from revoked
        returning id
      )
      select count(*)::int as count from audited
    `,
    [authIdentityId, reason.slice(0, 100)],
  );
  return Number(row?.count ?? 0);
}

export async function revokeMembershipSessions(workspaceUserId: string, reason: string) {
  const row = await queryOne<{ count: number | string }>(
    `
      with revoked as (
        update auth_sessions
        set revoked_at = now(), revoked_reason = $2
        where workspace_user_id = $1
          and revoked_at is null
        returning id, auth_identity_id, workspace_user_id, workspace_id
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
          'auth.session.revoked',
          'success',
          revoked.auth_identity_id,
          revoked.workspace_user_id,
          revoked.workspace_id,
          revoked.id,
          jsonb_build_object('reason', $2::text)
        from revoked
        returning id
      )
      select count(*)::int as count from audited
    `,
    [workspaceUserId, reason.slice(0, 100)],
  );
  return Number(row?.count ?? 0);
}
