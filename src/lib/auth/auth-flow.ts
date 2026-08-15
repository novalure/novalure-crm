import type { AppRole } from "@/lib/auth/permissions";
import {
  createChallengeToken,
  createMfaEnrollmentPayload,
  decryptMfaEnrollmentPayload,
  decryptMfaSecret,
  encryptMfaEnrollmentPayload,
  encryptMfaSecret,
  hashRecoveryCode,
  isPrivilegedMembership,
  buildTotpProvisioningUri,
  verifyTotpCode,
} from "@/lib/auth/mfa";
import {
  hashOpaqueToken,
  normalizeAuthEmail,
  readCookieValue,
} from "@/lib/auth/auth-security";
import { verifyPassword } from "@/lib/auth/passwords";
import { clearSuccessfulLoginRateLimit, reserveAuthRateLimitAttempt } from "@/lib/auth/rate-limit";
import { writeAuthAuditEvent } from "@/lib/auth/auth-audit";
import { queryOne, queryRows } from "@/lib/db/client";
import {
  isProductRole,
  resolveProductRole,
  type CalendarProviderChoice,
  type ProductRole,
  type WorkspaceCustomerType,
  type WorkspaceOperatingModel,
  type WorkspaceTeamStructure,
} from "@/lib/product-model";

export const loginChallengeCookieName = "novalure_login_challenge";

const dummyPasswordHash = "scrypt:NovalureDummySaltV1:M2Nm_ukB00abr_bpRFZbT3ZuwXOEVlAJ0j4iluGiQiDadPdIujlwFLv-1ma3qlJhRq10vIPxcP8moO0NUvXP_w";
const challengeLifetimeMinutes = 10;

export type AuthenticatedMembership = {
  authIdentityId: string;
  email: string;
  id: string;
  mfaEnabledAt: string | Date | null;
  name: string;
  productRole: ProductRole | null;
  role: AppRole;
  workspaceActiveCalendarProvider?: CalendarProviderChoice | null;
  workspaceCustomerType?: WorkspaceCustomerType | null;
  workspaceId: string;
  workspaceName: string;
  workspaceOperatingModel?: WorkspaceOperatingModel | null;
  workspacePublicKey?: string | null;
  workspaceSetupState?: Record<string, unknown> | null;
  workspaceTeamStructure?: WorkspaceTeamStructure | null;
};

type IdentityMembershipRow = AuthenticatedMembership & {
  credentialState: "active" | "disabled" | "reset_required";
  mfaSecretCiphertext: string | null;
  passwordHash: string | null;
};

type LoginChallengeRow = {
  attempts: number | string;
  authIdentityId: string;
  email: string;
  kind: "mfa_enrollment" | "mfa_verification" | "workspace_selection";
  maxAttempts: number | string;
  mfaEnabledAt: string | Date | null;
  mfaSecretCiphertext: string | null;
  payloadCiphertext: string | null;
  workspaceUserId: string | null;
};

export type LoginChallengeView =
  | {
      kind: "workspace_selection";
      workspaces: Array<{ id: string; name: string; userName: string }>;
    }
  | {
      kind: "mfa_verification";
      workspaceName: string;
    }
  | {
      kind: "mfa_enrollment";
      provisioningUri: string;
      recoveryCodes: string[];
      secret: string;
      workspaceName: string;
    };

export type AuthFlowResult =
  | {
      kind: "authenticated";
      membership: AuthenticatedMembership;
      mfaVerifiedAt: Date | null;
    }
  | {
      challengeCookie: string;
      challengeKind: LoginChallengeView["kind"];
      kind: "challenge";
    }
  | {
      error: "database_unavailable" | "invalid_credentials" | "invalid_mfa" | "login_not_configured";
      kind: "error";
    };

function isProductionDeployment() {
  const vercelEnvironment = process.env.VERCEL_ENV?.trim();
  if (vercelEnvironment) return vercelEnvironment === "production";
  return process.env.NODE_ENV === "production";
}

export function getLoginChallengeCookieOptions(maxAge = challengeLifetimeMinutes * 60) {
  return {
    expires: maxAge <= 0 ? new Date(0) : undefined,
    httpOnly: true,
    maxAge,
    path: "/",
    sameSite: "lax" as const,
    secure: isProductionDeployment(),
  };
}

function isUuid(value: string | null | undefined) {
  return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
}

function getProductRole(membership: AuthenticatedMembership) {
  return resolveProductRole({
    productRole: isProductRole(membership.productRole) ? membership.productRole : null,
    technicalRole: membership.role,
    workspaceName: membership.workspaceName,
  });
}

function isMembershipPrivileged(membership: AuthenticatedMembership) {
  return isPrivilegedMembership(membership.role, getProductRole(membership));
}

async function findIdentityMemberships(email: string) {
  return queryRows<IdentityMembershipRow>(
    `
      select
        identity.id as "authIdentityId",
        identity.password_hash as "passwordHash",
        identity.credential_state as "credentialState",
        identity.mfa_secret_ciphertext as "mfaSecretCiphertext",
        identity.mfa_enabled_at as "mfaEnabledAt",
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
        wu.role
      from auth_identities identity
      left join workspace_users wu
        on wu.auth_identity_id = identity.id
       and wu.status = 'active'
      left join workspaces w on w.id = wu.workspace_id
      where identity.normalized_email = $1
      order by w.name asc nulls last, wu.id asc nulls last
    `,
    [email],
  );
}

async function findMembership(authIdentityId: string, workspaceUserId: string) {
  return queryOne<IdentityMembershipRow>(
    `
      select
        identity.id as "authIdentityId",
        identity.password_hash as "passwordHash",
        identity.credential_state as "credentialState",
        identity.mfa_secret_ciphertext as "mfaSecretCiphertext",
        identity.mfa_enabled_at as "mfaEnabledAt",
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
        wu.role
      from auth_identities identity
      join workspace_users wu on wu.auth_identity_id = identity.id
      join workspaces w on w.id = wu.workspace_id
      where identity.id = $1
        and identity.credential_state = 'active'
        and wu.id = $2
        and wu.status = 'active'
      limit 1
    `,
    [authIdentityId, workspaceUserId],
  );
}

async function issueChallenge(input: {
  authIdentityId: string;
  kind: LoginChallengeRow["kind"];
  payloadCiphertext?: string | null;
  request: Request;
  workspaceUserId?: string | null;
}) {
  const token = createChallengeToken();
  const row = await queryOne<{ id: string }>(
    `
      with expired_enrollments as (
        update auth_login_challenges
        set payload_ciphertext = null,
            used_at = coalesce(used_at, now())
        where kind = 'mfa_enrollment'
          and expires_at <= now()
          and payload_ciphertext is not null
      ), created as (
        insert into auth_login_challenges (
          token_hash,
          kind,
          auth_identity_id,
          workspace_user_id,
          payload_ciphertext,
          expires_at
        )
        values ($1, $2, $3, $4::uuid, $5, now() + ($6::int * interval '1 minute'))
        returning id
      )
      select id from created
    `,
    [
      hashOpaqueToken(token),
      input.kind,
      input.authIdentityId,
      input.workspaceUserId ?? null,
      input.payloadCiphertext ?? null,
      challengeLifetimeMinutes,
    ],
  );
  if (!row) throw new Error("Login challenge was not persisted");

  await writeAuthAuditEvent({
    authIdentityId: input.authIdentityId,
    eventType: `auth.login_challenge.${input.kind}.issued`,
    metadata: { challengeId: row.id },
    outcome: "success",
    request: input.request,
    workspaceUserId: input.workspaceUserId,
  });

  return {
    challengeCookie: token,
    challengeKind: input.kind,
    kind: "challenge" as const,
  };
}

async function advanceSelectedMembership(
  membership: IdentityMembershipRow,
  request: Request,
): Promise<AuthFlowResult> {
  if (!isMembershipPrivileged(membership)) {
    return { kind: "authenticated", membership, mfaVerifiedAt: null };
  }

  if (membership.mfaEnabledAt && membership.mfaSecretCiphertext) {
    return issueChallenge({
      authIdentityId: membership.authIdentityId,
      kind: "mfa_verification",
      request,
      workspaceUserId: membership.id,
    });
  }

  const enrollment = createMfaEnrollmentPayload();
  return issueChallenge({
    authIdentityId: membership.authIdentityId,
    kind: "mfa_enrollment",
    payloadCiphertext: encryptMfaEnrollmentPayload(enrollment),
    request,
    workspaceUserId: membership.id,
  });
}

export async function authenticateIdentityLogin(input: {
  email: string;
  password: string;
  request: Request;
}): Promise<AuthFlowResult> {
  const email = normalizeAuthEmail(input.email);
  const password = input.password;
  if (!email || !password) {
    return { error: "invalid_credentials", kind: "error" };
  }

  try {
    const reservation = await reserveAuthRateLimitAttempt({
      email,
      kind: "login",
      request: input.request,
    });
    const rows = await findIdentityMemberships(email);
    const identity = rows[0] ?? null;
    const passwordMatches = await verifyPassword(
      password,
      identity?.credentialState === "active" ? identity.passwordHash : dummyPasswordHash,
    );

    if (reservation.blocked) {
      await writeAuthAuditEvent({
        authIdentityId: identity?.authIdentityId,
        eventType: "auth.login.blocked",
        metadata: { limiter: "progressive_backoff" },
        outcome: "blocked",
        request: input.request,
      });
      return { error: "invalid_credentials", kind: "error" };
    }

    const memberships = rows.filter((row) => isUuid(row.id) && row.credentialState === "active");
    if (!identity || !passwordMatches || memberships.length === 0) {
      await writeAuthAuditEvent({
        authIdentityId: identity?.authIdentityId,
        eventType: "auth.login.password_failed",
        metadata: { hasActiveMembership: memberships.length > 0 },
        outcome: "failure",
        request: input.request,
      });
      return { error: "invalid_credentials", kind: "error" };
    }

    await clearSuccessfulLoginRateLimit({ email, request: input.request });

    if (memberships.length > 1) {
      return issueChallenge({
        authIdentityId: identity.authIdentityId,
        kind: "workspace_selection",
        request: input.request,
      });
    }

    return advanceSelectedMembership(memberships[0], input.request);
  } catch {
    return { error: "database_unavailable", kind: "error" };
  }
}

async function getChallenge(cookieHeader: string | null | undefined) {
  const token = readCookieValue(cookieHeader, loginChallengeCookieName);
  if (!token || !/^v1\.[A-Za-z0-9_-]{43,128}$/.test(token)) return null;

  const challenge = await queryOne<LoginChallengeRow>(
    `
      select
        challenge.kind,
        challenge.auth_identity_id as "authIdentityId",
        challenge.workspace_user_id as "workspaceUserId",
        challenge.payload_ciphertext as "payloadCiphertext",
        challenge.attempts,
        challenge.max_attempts as "maxAttempts",
        identity.display_email as email,
        identity.mfa_secret_ciphertext as "mfaSecretCiphertext",
        identity.mfa_enabled_at as "mfaEnabledAt"
      from auth_login_challenges challenge
      join auth_identities identity on identity.id = challenge.auth_identity_id
      where challenge.token_hash = $1
        and challenge.used_at is null
        and challenge.expires_at > now()
        and challenge.attempts < challenge.max_attempts
        and identity.credential_state = 'active'
      limit 1
    `,
    [hashOpaqueToken(token)],
  );
  return challenge ? { challenge, token, tokenHash: hashOpaqueToken(token) } : null;
}

export async function getLoginChallengeView(
  headers: Pick<Headers, "get">,
): Promise<LoginChallengeView | null> {
  try {
    const active = await getChallenge(headers.get("cookie"));
    if (!active) return null;

    if (active.challenge.kind === "workspace_selection") {
      const memberships = await queryRows<{ id: string; name: string; userName: string }>(
        `
          select wu.id, w.name, wu.name as "userName"
          from workspace_users wu
          join workspaces w on w.id = wu.workspace_id
          where wu.auth_identity_id = $1
            and wu.status = 'active'
          order by w.name asc, wu.id asc
        `,
        [active.challenge.authIdentityId],
      );
      if (memberships.length < 2) return null;
      return { kind: "workspace_selection", workspaces: memberships };
    }

    if (!active.challenge.workspaceUserId) return null;
    const membership = await findMembership(
      active.challenge.authIdentityId,
      active.challenge.workspaceUserId,
    );
    if (!membership || !isMembershipPrivileged(membership)) return null;

    if (active.challenge.kind === "mfa_verification") {
      return { kind: "mfa_verification", workspaceName: membership.workspaceName };
    }

    const enrollment = active.challenge.payloadCiphertext
      ? decryptMfaEnrollmentPayload(active.challenge.payloadCiphertext)
      : null;
    if (!enrollment) return null;
    return {
      kind: "mfa_enrollment",
      provisioningUri: buildTotpProvisioningUri({
        email: active.challenge.email,
        secret: enrollment.secret,
      }),
      recoveryCodes: enrollment.recoveryCodes,
      secret: enrollment.secret,
      workspaceName: membership.workspaceName,
    };
  } catch {
    return null;
  }
}

export async function cancelIdentityLoginChallenge(request: Request) {
  const token = readCookieValue(request.headers.get("cookie"), loginChallengeCookieName);
  if (!token || !/^v1\.[A-Za-z0-9_-]{43,128}$/.test(token)) return false;
  const row = await queryOne<{ id: string }>(
    `
      with cancelled as (
        update auth_login_challenges
        set used_at = coalesce(used_at, now()),
            payload_ciphertext = null
        where token_hash = $1
          and used_at is null
        returning id, auth_identity_id, workspace_user_id, kind
      ), audited as (
        insert into auth_audit_events (
          event_type,
          outcome,
          auth_identity_id,
          workspace_user_id,
          metadata
        )
        select
          'auth.login_challenge.cancelled',
          'success',
          cancelled.auth_identity_id,
          cancelled.workspace_user_id,
          jsonb_build_object('challengeKind', cancelled.kind)
        from cancelled
        returning id
      )
      select id from audited
    `,
    [hashOpaqueToken(token)],
  );
  return Boolean(row);
}

async function consumeWorkspaceChallenge(input: {
  authIdentityId: string;
  tokenHash: string;
  workspaceUserId: string;
}) {
  return queryOne<{ id: string }>(
    `
      with consumed as (
        update auth_login_challenges
        set used_at = now()
        where token_hash = $1
          and kind = 'workspace_selection'
          and auth_identity_id = $2
          and used_at is null
          and expires_at > now()
        returning id
      )
      select consumed.id
      from consumed
      where exists (
        select 1
        from workspace_users wu
        where wu.id = $3
          and wu.auth_identity_id = $2
          and wu.status = 'active'
      )
    `,
    [input.tokenHash, input.authIdentityId, input.workspaceUserId],
  );
}

async function recordInvalidMfaChallenge(tokenHash: string) {
  await queryOne<{ id: string }>(
    `
      update auth_login_challenges
      set attempts = attempts + 1,
          used_at = case when attempts + 1 >= max_attempts then now() else used_at end,
          payload_ciphertext = case
            when kind = 'mfa_enrollment' and attempts + 1 >= max_attempts then null
            else payload_ciphertext
          end
      where token_hash = $1
        and used_at is null
        and expires_at > now()
      returning id
    `,
    [tokenHash],
  );
}

async function consumeMfaVerification(input: {
  challenge: LoginChallengeRow;
  code: string;
  tokenHash: string;
}) {
  const secret = input.challenge.mfaSecretCiphertext
    ? decryptMfaSecret(input.challenge.mfaSecretCiphertext)
    : null;
  if (!secret) return false;

  if (verifyTotpCode(secret, input.code)) {
    const consumed = await queryOne<{ id: string }>(
      `
        update auth_login_challenges
        set used_at = now()
        where token_hash = $1
          and kind = 'mfa_verification'
          and used_at is null
          and expires_at > now()
          and attempts < max_attempts
        returning id
      `,
      [input.tokenHash],
    );
    return Boolean(consumed);
  }

  const recoveryCodeHash = hashRecoveryCode(input.code);
  if (!recoveryCodeHash) return false;
  const consumed = await queryOne<{ id: string }>(
    `
      with locked_challenge as (
        select id
        from auth_login_challenges
        where token_hash = $3
          and kind = 'mfa_verification'
          and used_at is null
          and expires_at > now()
          and attempts < max_attempts
        for update
      ), locked_code as (
        select id
        from auth_mfa_recovery_codes
        where auth_identity_id = $1
          and code_hash = $2
          and used_at is null
        for update
      ), consumed_challenge as (
        update auth_login_challenges challenge
        set used_at = now()
        from locked_challenge
        where challenge.id = locked_challenge.id
          and exists (select 1 from locked_code)
        returning challenge.id
      ), consumed_code as (
        update auth_mfa_recovery_codes code
        set used_at = now()
        from locked_code
        where code.id = locked_code.id
          and exists (select 1 from consumed_challenge)
        returning code.id
      )
      select consumed_challenge.id
      from consumed_challenge
      where exists (select 1 from consumed_code)
    `,
    [input.challenge.authIdentityId, recoveryCodeHash, input.tokenHash],
  );
  return Boolean(consumed);
}

async function consumeMfaEnrollment(input: {
  challenge: LoginChallengeRow;
  code: string;
  recoveryCodesSaved: boolean;
  tokenHash: string;
}) {
  if (!input.recoveryCodesSaved) return false;
  const enrollment = input.challenge.payloadCiphertext
    ? decryptMfaEnrollmentPayload(input.challenge.payloadCiphertext)
    : null;
  if (!enrollment || !verifyTotpCode(enrollment.secret, input.code)) return false;

  const codeHashes = enrollment.recoveryCodes
    .map(hashRecoveryCode)
    .filter((value): value is string => Boolean(value));
  if (codeHashes.length !== enrollment.recoveryCodes.length) return false;

  const enabled = await queryOne<{ id: string }>(
    `
      with consumed as (
        update auth_login_challenges
        set used_at = now(), payload_ciphertext = null
        where token_hash = $1
          and kind = 'mfa_enrollment'
          and used_at is null
          and expires_at > now()
          and attempts < max_attempts
        returning auth_identity_id
      ), enabled as (
        update auth_identities identity
        set mfa_secret_ciphertext = $2,
            mfa_enabled_at = now(),
            updated_at = now()
        from consumed
        where identity.id = consumed.auth_identity_id
          and identity.mfa_enabled_at is null
        returning identity.id
      ), cleared as (
        delete from auth_mfa_recovery_codes codes
        using enabled
        where codes.auth_identity_id = enabled.id
      ), inserted_codes as (
        insert into auth_mfa_recovery_codes (auth_identity_id, code_hash)
        select enabled.id, code.value
        from enabled
        cross join unnest($3::text[]) as code(value)
        returning auth_identity_id
      ), audited as (
        insert into auth_audit_events (
          event_type,
          outcome,
          auth_identity_id,
          workspace_user_id,
          metadata
        )
        select
          'auth.mfa.enrolled',
          'success',
          enabled.id,
          $4::uuid,
          jsonb_build_object('recoveryCodeCount', $5::int)
        from enabled
        returning auth_identity_id
      )
      select enabled.id
      from enabled
      where (select count(*) from inserted_codes) = $5::int
        and exists (select 1 from audited)
    `,
    [
      input.tokenHash,
      encryptMfaSecret(enrollment.secret),
      codeHashes,
      input.challenge.workspaceUserId,
      codeHashes.length,
    ],
  );
  return Boolean(enabled);
}

export async function continueIdentityLogin(input: {
  code?: string;
  recoveryCodesSaved?: boolean;
  request: Request;
  workspaceUserId?: string;
}): Promise<AuthFlowResult> {
  try {
    const active = await getChallenge(input.request.headers.get("cookie"));
    if (!active) return { error: "invalid_credentials", kind: "error" };

    if (active.challenge.kind === "workspace_selection") {
      if (!isUuid(input.workspaceUserId)) {
        return { error: "invalid_credentials", kind: "error" };
      }
      const membership = await findMembership(
        active.challenge.authIdentityId,
        input.workspaceUserId as string,
      );
      if (!membership) return { error: "invalid_credentials", kind: "error" };
      const consumed = await consumeWorkspaceChallenge({
        authIdentityId: active.challenge.authIdentityId,
        tokenHash: active.tokenHash,
        workspaceUserId: membership.id,
      });
      if (!consumed) return { error: "invalid_credentials", kind: "error" };
      return advanceSelectedMembership(membership, input.request);
    }

    if (!active.challenge.workspaceUserId) {
      return { error: "invalid_credentials", kind: "error" };
    }
    const membership = await findMembership(
      active.challenge.authIdentityId,
      active.challenge.workspaceUserId,
    );
    if (!membership || !isMembershipPrivileged(membership)) {
      return { error: "invalid_credentials", kind: "error" };
    }

    const code = input.code?.trim() ?? "";
    const consumed = active.challenge.kind === "mfa_verification"
      ? await consumeMfaVerification({ challenge: active.challenge, code, tokenHash: active.tokenHash })
      : await consumeMfaEnrollment({
          challenge: active.challenge,
          code,
          recoveryCodesSaved: input.recoveryCodesSaved === true,
          tokenHash: active.tokenHash,
        });

    if (!consumed) {
      await recordInvalidMfaChallenge(active.tokenHash);
      await writeAuthAuditEvent({
        authIdentityId: active.challenge.authIdentityId,
        eventType: "auth.mfa.verification_failed",
        metadata: { challengeKind: active.challenge.kind },
        outcome: "failure",
        request: input.request,
        workspaceUserId: membership.id,
      });
      return { error: "invalid_mfa", kind: "error" };
    }

    await writeAuthAuditEvent({
      authIdentityId: active.challenge.authIdentityId,
      eventType: "auth.mfa.verified",
      metadata: { challengeKind: active.challenge.kind },
      outcome: "success",
      request: input.request,
      workspaceId: membership.workspaceId,
      workspaceUserId: membership.id,
    });
    return { kind: "authenticated", membership, mfaVerifiedAt: new Date() };
  } catch {
    return { error: "database_unavailable", kind: "error" };
  }
}
