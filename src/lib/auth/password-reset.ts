import { createHash, randomBytes } from "node:crypto";
import { executeQuery, hasDatabaseUrl, queryOne } from "@/lib/db/client";
import { getLoginPageCopy, type LanguageCode } from "@/lib/i18n";
import { sendNewsletterEmail } from "@/lib/integrations/resend";
import { getPasswordValidationError, hashPassword } from "@/lib/auth/passwords";

type ResetUserRow = {
  email: string;
  id: string;
  name: string;
  workspaceId: string;
  workspaceName: string;
};

type RequestCountRow = {
  requestCount: number | string;
};

type ConsumedResetTokenRow = {
  email: string;
  userId: string;
  workspaceId: string;
};

type PasswordResetRequestResult =
  | { status: "ok" }
  | { status: "rate_limited" }
  | { status: "unavailable" };

type PasswordResetConfirmResult =
  | { status: "ok"; email: string }
  | { status: "invalid_token" }
  | { status: "password_mismatch" | "password_required" | "password_too_short" }
  | { status: "unavailable" };

const resetTokenTtlMinutes = 60;
const rateLimitWindowMs = 15 * 60 * 1000;
const maxInMemoryRequestsPerWindow = 5;
const maxDatabaseRequestsPerWindow = 3;
const resetRequestBuckets = new Map<string, { count: number; resetAt: number }>();

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function hashToken(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function getRequestIp(request: Request) {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    request.headers.get("cf-connecting-ip") ||
    "unknown"
  );
}

function isRateLimited(key: string) {
  const now = Date.now();
  const bucket = resetRequestBuckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    resetRequestBuckets.set(key, { count: 1, resetAt: now + rateLimitWindowMs });
    return false;
  }

  bucket.count += 1;
  return bucket.count > maxInMemoryRequestsPerWindow;
}

async function delayNeutralResponse() {
  await new Promise((resolve) => setTimeout(resolve, 250));
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function buildResetUrl(request: Request, token: string, language: LanguageCode) {
  const resetUrl = new URL("/login/reset-password", request.url);
  resetUrl.searchParams.set("token", token);
  resetUrl.searchParams.set("lang", language);
  return resetUrl.toString();
}

function buildResetEmail(input: {
  language: LanguageCode;
  resetUrl: string;
  userName: string;
  workspaceName: string;
}) {
  const copy = getLoginPageCopy(input.language).passwordReset.email;
  const safeResetUrl = escapeHtml(input.resetUrl);

  return {
    subject: copy.subject,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.6;color:#071421">
        <h1 style="font-size:22px">${escapeHtml(copy.heading)}</h1>
        <p>${escapeHtml(copy.greeting(input.userName))}</p>
        <p>${escapeHtml(copy.intro(input.workspaceName))}</p>
        <p>
          <a href="${safeResetUrl}" style="display:inline-block;background:#071421;color:#ffffff;padding:12px 18px;border-radius:6px;text-decoration:none;font-weight:700">
            ${escapeHtml(copy.button)}
          </a>
        </p>
        <p>${escapeHtml(copy.expiry(resetTokenTtlMinutes))}</p>
        <p>${escapeHtml(copy.ignore)}</p>
        <p style="word-break:break-all;color:#476178">${safeResetUrl}</p>
      </div>
    `,
  };
}

async function findActiveUserByEmail(email: string) {
  return queryOne<ResetUserRow>(
    `
      select
        wu.id,
        wu.workspace_id as "workspaceId",
        w.name as "workspaceName",
        wu.name,
        wu.email
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

async function isDatabaseRateLimited(userId: string) {
  const row = await queryOne<RequestCountRow>(
    `
      select count(*)::int as "requestCount"
      from auth_password_reset_tokens
      where user_id = $1
        and created_at > now() - interval '15 minutes'
    `,
    [userId],
  );

  return Number(row?.requestCount ?? 0) >= maxDatabaseRequestsPerWindow;
}

export async function requestPasswordReset(input: {
  email: string;
  language: LanguageCode;
  request: Request;
}): Promise<PasswordResetRequestResult> {
  const email = normalizeEmail(input.email);
  const requestIp = getRequestIp(input.request);
  const rateLimitKey = hashToken(`${requestIp}:${email}`);

  if (!email) return { status: "ok" };
  if (isRateLimited(rateLimitKey)) return { status: "rate_limited" };
  if (!hasDatabaseUrl()) return { status: "unavailable" };

  try {
    const user = await findActiveUserByEmail(email);

    if (!user) {
      await delayNeutralResponse();
      return { status: "ok" };
    }

    if (await isDatabaseRateLimited(user.id)) {
      return { status: "rate_limited" };
    }

    const token = randomBytes(32).toString("base64url");
    const resetUrl = buildResetUrl(input.request, token, input.language);

    await executeQuery(
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
        values ($1, $2, $3, $4, $5, $6, now() + ($7::text || ' minutes')::interval)
      `,
      [
        user.workspaceId,
        user.id,
        hashToken(token),
        email,
        requestIp,
        input.request.headers.get("user-agent") ?? "",
        String(resetTokenTtlMinutes),
      ],
    );

    const emailContent = buildResetEmail({
      language: input.language,
      resetUrl,
      userName: user.name || user.email,
      workspaceName: user.workspaceName,
    });
    const delivery = await sendNewsletterEmail({
      to: user.email,
      subject: emailContent.subject,
      html: emailContent.html,
      idempotencyKey: `password-reset:${user.id}:${hashToken(token).slice(0, 16)}`,
    });

    if (delivery.status === "failed") {
      return { status: "unavailable" };
    }

    return { status: "ok" };
  } catch {
    return { status: "unavailable" };
  }
}

export async function confirmPasswordReset(input: {
  confirmation: string;
  password: string;
  token: string;
}): Promise<PasswordResetConfirmResult> {
  const validationError = getPasswordValidationError(input.password, input.confirmation);
  if (validationError) return { status: validationError };
  if (!input.token || !hasDatabaseUrl()) return { status: "invalid_token" };

  try {
    const passwordHash = await hashPassword(input.password);
    const tokenHash = hashToken(input.token);
    const updatedUser = await queryOne<ConsumedResetTokenRow>(
      `
        with consumed_token as (
          update auth_password_reset_tokens token
          set used_at = now()
          from workspace_users wu
          where token.token_hash = $1
            and token.used_at is null
            and token.expires_at > now()
            and wu.id = token.user_id
            and wu.workspace_id = token.workspace_id
            and wu.status = 'active'
          returning token.user_id as "userId", token.workspace_id as "workspaceId"
        )
        update workspace_users wu
        set password_hash = $2, updated_at = now()
        from consumed_token token
        where wu.id = token."userId"
          and wu.workspace_id = token."workspaceId"
        returning wu.id as "userId", wu.workspace_id as "workspaceId", wu.email
      `,
      [tokenHash, passwordHash],
    );

    if (!updatedUser) return { status: "invalid_token" };

    await executeQuery(
      `
        update auth_password_reset_tokens
        set used_at = coalesce(used_at, now())
        where user_id = $1
          and workspace_id = $2
          and used_at is null
      `,
      [updatedUser.userId, updatedUser.workspaceId],
    );

    return { status: "ok", email: updatedUser.email };
  } catch {
    return { status: "unavailable" };
  }
}
