import { getLoginPageCopy, type LanguageCode } from "@/lib/i18n";
import { sendNewsletterEmail } from "@/lib/integrations/resend";
import { getTrustedAppOrigin } from "@/lib/auth/app-origin";
import {
  createOpaqueToken,
  getAuthRequestFingerprint,
  getTrustedAuthClientIp,
  hashOpaqueToken,
  normalizeAuthEmail,
  protectLowEntropyValue,
  readCookieValue,
  safeEqualAuthValue,
} from "@/lib/auth/auth-security";
import { writeAuthAuditEvent } from "@/lib/auth/auth-audit";
import { getPasswordValidationError, hashPassword } from "@/lib/auth/passwords";
import { reserveAuthRateLimitAttempt } from "@/lib/auth/rate-limit";
import { hasDatabaseUrl, queryOne } from "@/lib/db/client";
import { validateCsrfRequestContext } from "@/lib/security/csrf-core";
import { evaluateLaunchScope } from "@/lib/launch-scope";

type ResetIdentityRow = {
  displayEmail: string;
  id: string;
};

type PasswordResetConfirmResult =
  | { status: "ok" }
  | { status: "invalid_token" }
  | { status: "password_mismatch" | "password_required" | "password_too_short" }
  | { status: "unavailable" };

const resetTokenTtlMinutes = 60;
const resetExchangeTtlMinutes = 15;
const resetExchangeFormTtlMs = 10 * 60 * 1_000;
const minimumNeutralResponseMs = 600;

export const passwordResetExchangeCookieName = "novalure_reset_exchange";

export function isPasswordResetEmailToken(value: string) {
  return /^[A-Za-z0-9_-]{43}$/u.test(value);
}

export function createPasswordResetExchangeFormToken(now = Date.now()) {
  const expiresAt = now + resetExchangeFormTtlMs;
  const payload = `v2.${expiresAt}.${createOpaqueToken(18)}`;
  const signature = protectLowEntropyValue("password-reset-exchange-form", payload);
  return `${payload}.${signature}`;
}

export function validatePasswordResetExchangeFormToken(input: {
  formToken: string;
  now?: number;
}) {
  const [version, expiresAtValue, nonce, signature, ...extra] = input.formToken.split(".");
  if (
    version !== "v2" ||
    extra.length ||
    !/^\d{13}$/u.test(expiresAtValue ?? "") ||
    !/^[A-Za-z0-9_-]{24}$/u.test(nonce ?? "") ||
    !/^[a-f0-9]{64}$/u.test(signature ?? "")
  ) return false;

  const now = input.now ?? Date.now();
  const expiresAt = Number(expiresAtValue);
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= now ||
    expiresAt > now + resetExchangeFormTtlMs + 60_000
  ) return false;

  const payload = `${version}.${expiresAtValue}.${nonce}`;
  const expectedSignature = protectLowEntropyValue("password-reset-exchange-form", payload);
  return safeEqualAuthValue(signature ?? "", expectedSignature);
}

function isProductionDeployment() {
  const vercelEnvironment = process.env.VERCEL_ENV?.trim();
  if (vercelEnvironment) return vercelEnvironment === "production";
  return process.env.NODE_ENV === "production";
}

export function getPasswordResetExchangeCookieOptions(maxAge = resetExchangeTtlMinutes * 60) {
  return {
    expires: maxAge <= 0 ? new Date(0) : undefined,
    httpOnly: true,
    maxAge,
    path: "/",
    sameSite: "lax" as const,
    secure: isProductionDeployment(),
  };
}

async function waitForNeutralResponse(startedAt: number) {
  const remaining = minimumNeutralResponseMs - (Date.now() - startedAt);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function buildResetEmail(input: {
  language: LanguageCode;
  resetUrl: string;
  userName: string;
}) {
  const copy = getLoginPageCopy(input.language).passwordReset.email;
  const safeResetUrl = escapeHtml(input.resetUrl);

  return {
    subject: copy.subject,
    html: `
      <div style="font-family:Inter,Arial,sans-serif;line-height:1.6;color:#07080b">
        <h1 style="font-size:22px">${escapeHtml(copy.heading)}</h1>
        <p>${escapeHtml(copy.greeting(input.userName))}</p>
        <p>${escapeHtml(copy.intro("Novalure CRM"))}</p>
        <p>
          <a href="${safeResetUrl}" style="display:inline-block;background:#ffd43b;color:#211800;padding:12px 18px;border:1px solid #e4b900;border-radius:999px;text-decoration:none;font-weight:800">
            ${escapeHtml(copy.button)}
          </a>
        </p>
        <p>${escapeHtml(copy.expiry(resetTokenTtlMinutes))}</p>
        <p>${escapeHtml(copy.ignore)}</p>
      </div>
    `,
  };
}

function buildResetExchangeUrl(token: string, language: LanguageCode) {
  const url = new URL("/api/auth/password-reset/exchange", getTrustedAppOrigin());
  url.searchParams.set("lang", language);
  url.hash = new URLSearchParams({ token }).toString();
  return url.toString();
}

async function findResetIdentity(email: string) {
  return queryOne<ResetIdentityRow>(
    `
      select identity.id, identity.display_email as "displayEmail"
      from auth_identities identity
      where identity.normalized_email = $1
        and identity.credential_state <> 'disabled'
        and exists (
          select 1
          from workspace_users wu
          where wu.auth_identity_id = identity.id
            and wu.status = 'active'
        )
      limit 1
    `,
    [email],
  );
}

async function insertPasswordResetToken(input: {
  authIdentityId: string;
  email: string;
  requestIp?: string | null;
  ttlMinutes: number;
  userAgent?: string | null;
  workspaceId?: string | null;
  workspaceUserId?: string | null;
}) {
  const token = createOpaqueToken(32);
  const row = await queryOne<{ id: string }>(
    `
      insert into auth_password_reset_tokens (
        workspace_id,
        user_id,
        auth_identity_id,
        token_hash,
        requested_email,
        request_ip,
        user_agent,
        expires_at
      )
      values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, now() + ($8::int * interval '1 minute'))
      returning id
    `,
    [
      input.workspaceId ?? null,
      input.workspaceUserId ?? null,
      input.authIdentityId,
      hashOpaqueToken(token),
      input.email,
      input.requestIp ?? null,
      input.userAgent ?? null,
      input.ttlMinutes,
    ],
  );
  if (!row) throw new Error("Password reset token was not persisted");
  return { id: row.id, token };
}

export async function createMembershipPasswordResetLink(input: {
  language: LanguageCode;
  purpose: "password_reset" | "workspace_invitation";
  requestIp?: string | null;
  ttlMinutes?: number;
  userAgent?: string | null;
  workspaceId: string;
  workspaceUserId: string;
}) {
  const launchSurface = input.purpose === "workspace_invitation"
    ? "accountAccessInvitationEmail"
    : "accountAccessPasswordResetEmail";
  const launchScope = evaluateLaunchScope(launchSurface);
  if (!launchScope.allowed) throw new Error(launchScope.code);

  const membership = await queryOne<{
    authIdentityId: string;
    email: string;
    name: string;
  }>(
    `
      select
        wu.auth_identity_id as "authIdentityId",
        identity.display_email as email,
        wu.name
      from workspace_users wu
      join auth_identities identity on identity.id = wu.auth_identity_id
      where wu.id = $1
        and wu.workspace_id = $2
        and wu.status in ('active', 'invited')
        and identity.credential_state <> 'disabled'
      limit 1
    `,
    [input.workspaceUserId, input.workspaceId],
  );
  if (!membership) throw new Error("Password reset membership is unavailable");

  const created = await insertPasswordResetToken({
    authIdentityId: membership.authIdentityId,
    email: membership.email,
    requestIp: input.requestIp,
    ttlMinutes: input.ttlMinutes ?? resetTokenTtlMinutes,
    userAgent: input.userAgent,
    workspaceId: input.workspaceId,
    workspaceUserId: input.workspaceUserId,
  });
  return {
    authIdentityId: membership.authIdentityId,
    email: membership.email,
    name: membership.name,
    resetUrl: buildResetExchangeUrl(created.token, input.language),
    tokenId: created.id,
  };
}

export async function requestPasswordReset(input: {
  email: string;
  language: LanguageCode;
  request: Request;
}) {
  if (!evaluateLaunchScope("accountAccessPasswordResetEmail").allowed) {
    return { status: "unavailable" as const };
  }
  const startedAt = Date.now();
  const email = normalizeAuthEmail(input.email);

  try {
    if (!email || !hasDatabaseUrl()) return { status: "ok" as const };
    const [reservation, identity] = await Promise.all([
      reserveAuthRateLimitAttempt({ email, kind: "reset", request: input.request }),
      findResetIdentity(email),
    ]);

    if (!reservation.blocked && identity) {
      const created = await insertPasswordResetToken({
        authIdentityId: identity.id,
        email: identity.displayEmail,
        requestIp: getTrustedAuthClientIp(input.request.headers),
        ttlMinutes: resetTokenTtlMinutes,
        userAgent: input.request.headers.get("user-agent"),
      });
      const resetUrl = buildResetExchangeUrl(created.token, input.language);
      const emailContent = buildResetEmail({
        language: input.language,
        resetUrl,
        userName: identity.displayEmail,
      });
      const delivery = await sendNewsletterEmail({
        to: identity.displayEmail,
        subject: emailContent.subject,
        html: emailContent.html,
        purpose: "password_reset",
        idempotencyKey: `password-reset:${created.id}`,
      });
      await writeAuthAuditEvent({
        authIdentityId: identity.id,
        eventType: "auth.password_reset.requested",
        metadata: { deliveryStatus: delivery.status },
        outcome: delivery.status === "failed" ? "failure" : "success",
        request: input.request,
      });
    } else {
      await writeAuthAuditEvent({
        authIdentityId: identity?.id,
        eventType: reservation.blocked
          ? "auth.password_reset.blocked"
          : "auth.password_reset.unknown_identity",
        metadata: { limiter: reservation.blocked ? "progressive_backoff" : "none" },
        outcome: reservation.blocked ? "blocked" : "failure",
        request: input.request,
      });
    }
  } catch {
    // Public reset requests remain deliberately neutral. Operational failures
    // are observable through provider/runtime logs without identity disclosure.
  } finally {
    await waitForNeutralResponse(startedAt);
  }

  return { status: "ok" as const };
}

export async function exchangePasswordResetToken(token: string, request: Request) {
  if (!token || !hasDatabaseUrl()) return null;
  const exchangeValue = `v1.${createOpaqueToken(32)}`;
  const fingerprint = getAuthRequestFingerprint(request);
  const row = await queryOne<{ authIdentityId: string; id: string }>(
    `
      with consumed_token as (
        update auth_password_reset_tokens token
        set exchanged_at = now()
        from auth_identities identity
        where token.token_hash = $1
          and token.auth_identity_id = identity.id
          and identity.credential_state <> 'disabled'
          and token.exchanged_at is null
          and token.used_at is null
          and token.expires_at > now()
          and (
            token.user_id is null
            or exists (
              select 1 from workspace_users wu
              where wu.id = token.user_id
                and wu.workspace_id = token.workspace_id
                and wu.auth_identity_id = identity.id
                and wu.status in ('active', 'invited')
            )
          )
        returning token.id, token.auth_identity_id, token.user_id
      ), created_exchange as (
        insert into auth_password_reset_exchanges (
          reset_token_id,
          auth_identity_id,
          workspace_user_id,
          exchange_hash,
          expires_at
        )
        select
          consumed_token.id,
          consumed_token.auth_identity_id,
          consumed_token.user_id,
          $2,
          now() + ($3::int * interval '1 minute')
        from consumed_token
        returning id, auth_identity_id
      ), audited as (
        insert into auth_audit_events (
          event_type,
          outcome,
          auth_identity_id,
          ip_hash,
          user_agent_hash,
          metadata
        )
        select
          'auth.password_reset.exchanged',
          'success',
          created_exchange.auth_identity_id,
          $4,
          $5,
          jsonb_build_object('exchangeId', created_exchange.id)
        from created_exchange
        returning auth_identity_id
      )
      select
        created_exchange.id,
        created_exchange.auth_identity_id as "authIdentityId"
      from created_exchange
      where exists (select 1 from audited)
    `,
    [
      hashOpaqueToken(token),
      hashOpaqueToken(exchangeValue),
      resetExchangeTtlMinutes,
      fingerprint.ipHash,
      fingerprint.userAgentHash,
    ],
  );
  return row ? { cookieValue: exchangeValue, exchangeId: row.id } : null;
}

function readResetExchangeCookie(cookieHeader: string | null | undefined) {
  const value = readCookieValue(cookieHeader, passwordResetExchangeCookieName);
  return value && /^v1\.[A-Za-z0-9_-]{43,128}$/.test(value) ? value : null;
}

export function createPasswordResetFormToken(headers: Pick<Headers, "get">) {
  const exchangeValue = readResetExchangeCookie(headers.get("cookie"));
  return exchangeValue
    ? protectLowEntropyValue("password-reset-form", exchangeValue)
    : null;
}

export async function hasValidPasswordResetExchange(headers: Pick<Headers, "get">) {
  const value = readResetExchangeCookie(headers.get("cookie"));
  if (!value || !hasDatabaseUrl()) return false;
  try {
    const row = await queryOne<{ id: string }>(
      `
        select exchange.id
        from auth_password_reset_exchanges exchange
        join auth_identities identity on identity.id = exchange.auth_identity_id
        where exchange.exchange_hash = $1
          and exchange.used_at is null
          and exchange.expires_at > now()
          and identity.credential_state <> 'disabled'
        limit 1
      `,
      [hashOpaqueToken(value)],
    );
    return Boolean(row);
  } catch {
    return false;
  }
}

export async function confirmPasswordReset(input: {
  confirmation: string;
  formToken: string;
  password: string;
  request: Request;
}): Promise<PasswordResetConfirmResult> {
  const validationError = getPasswordValidationError(input.password, input.confirmation);
  if (validationError) return { status: validationError };
  const exchangeValue = readResetExchangeCookie(input.request.headers.get("cookie"));
  if (!exchangeValue || !hasDatabaseUrl()) return { status: "invalid_token" };
  const context = validateCsrfRequestContext(input.request.headers, getTrustedAppOrigin());
  const expectedFormToken = protectLowEntropyValue("password-reset-form", exchangeValue);
  if (!context.ok || !safeEqualAuthValue(input.formToken, expectedFormToken)) {
    return { status: "invalid_token" };
  }

  try {
    const passwordHash = await hashPassword(input.password);
    const fingerprint = getAuthRequestFingerprint(input.request);
    const updated = await queryOne<{ id: string }>(
      `
        with consumed_exchange as (
          update auth_password_reset_exchanges exchange
          set used_at = now()
          from auth_identities identity
          where exchange.exchange_hash = $1
            and exchange.auth_identity_id = identity.id
            and exchange.used_at is null
            and exchange.expires_at > now()
            and identity.credential_state <> 'disabled'
          returning
            exchange.id,
            exchange.reset_token_id,
            exchange.auth_identity_id,
            exchange.workspace_user_id
        ), credential_updated as (
          update auth_identities identity
          set password_hash = $2,
              credential_state = 'active',
              disabled_at = null,
              password_changed_at = now(),
              updated_at = now()
          from consumed_exchange
          where identity.id = consumed_exchange.auth_identity_id
          returning identity.id
        ), membership_activated as (
          update workspace_users wu
          set status = 'active', updated_at = now()
          from consumed_exchange
          where consumed_exchange.workspace_user_id is not null
            and wu.id = consumed_exchange.workspace_user_id
            and wu.auth_identity_id = consumed_exchange.auth_identity_id
            and wu.status = 'invited'
          returning wu.id
        ), password_mirrored as (
          update workspace_users wu
          set password_hash = $2, updated_at = now()
          from credential_updated
          where wu.auth_identity_id = credential_updated.id
          returning wu.id
        ), reset_tokens_invalidated as (
          update auth_password_reset_tokens token
          set used_at = coalesce(token.used_at, now())
          from credential_updated
          where token.auth_identity_id = credential_updated.id
            and token.used_at is null
          returning token.id
        ), exchanges_invalidated as (
          update auth_password_reset_exchanges exchange
          set used_at = coalesce(exchange.used_at, now())
          from credential_updated
          where exchange.auth_identity_id = credential_updated.id
            and exchange.used_at is null
          returning exchange.id
        ), sessions_revoked as (
          update auth_sessions session
          set revoked_at = now(), revoked_reason = 'password_reset'
          from credential_updated
          where session.auth_identity_id = credential_updated.id
            and session.revoked_at is null
          returning session.id
        ), audited as (
          insert into auth_audit_events (
            event_type,
            outcome,
            auth_identity_id,
            ip_hash,
            user_agent_hash,
            metadata
          )
          select
            'auth.password_reset.completed',
            'success',
            credential_updated.id,
            $3,
            $4,
            jsonb_build_object(
              'revokedSessionCount', (select count(*) from sessions_revoked),
              'updatedMembershipCount', (select count(*) from password_mirrored)
            )
          from credential_updated
          returning auth_identity_id as id
        )
        select id from audited
      `,
      [
        hashOpaqueToken(exchangeValue),
        passwordHash,
        fingerprint.ipHash,
        fingerprint.userAgentHash,
      ],
    );
    return updated ? { status: "ok" } : { status: "invalid_token" };
  } catch {
    return { status: "unavailable" };
  }
}
