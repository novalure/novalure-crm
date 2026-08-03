import { createHmac } from "node:crypto";
import { executeQuery, hasDatabaseUrl, queryOne } from "@/lib/db/client";

type RateLimitPolicy = { blockSeconds: number; maxAttempts: number; windowSeconds: number };

const policies: Record<"login_account" | "login_ip" | "password_reset_account" | "password_reset_ip", RateLimitPolicy> = {
  login_account: { blockSeconds: 15 * 60, maxAttempts: 8, windowSeconds: 15 * 60 },
  login_ip: { blockSeconds: 15 * 60, maxAttempts: 30, windowSeconds: 15 * 60 },
  password_reset_account: { blockSeconds: 30 * 60, maxAttempts: 3, windowSeconds: 30 * 60 },
  password_reset_ip: { blockSeconds: 30 * 60, maxAttempts: 10, windowSeconds: 30 * 60 },
};

export type AuthRateLimitAction = keyof typeof policies;

function getFingerprintSecret() {
  return process.env.NOVALURE_RATE_LIMIT_SECRET?.trim() || process.env.NOVALURE_SESSION_SECRET?.trim() || null;
}

function fingerprint(value: string, secret: string) {
  return createHmac("sha256", secret).update(value.trim().toLowerCase()).digest("hex");
}

export function getTrustedRequestIp(request: Request) {
  return request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "unknown";
}

export async function consumeAuthRateLimit(action: AuthRateLimitAction, value: string) {
  if (!hasDatabaseUrl()) return { allowed: process.env.VERCEL_ENV !== "production", retryAfter: 60 };
  const policy = policies[action];
  const secret = getFingerprintSecret();
  if (!secret) {
    return { allowed: process.env.VERCEL_ENV !== "production", retryAfter: policy.blockSeconds };
  }
  const row = await queryOne<{ allowed: boolean; retryAfter: number | string }>(
    `
      insert into auth_rate_limits (action, key_hash, bucket_started_at, attempt_count, blocked_until, updated_at)
      values ($1, $2, now(), 1, null, now())
      on conflict (action, key_hash) do update set
        attempt_count = case
          when auth_rate_limits.bucket_started_at <= now() - ($3::int * interval '1 second') then 1
          else auth_rate_limits.attempt_count + 1
        end,
        bucket_started_at = case
          when auth_rate_limits.bucket_started_at <= now() - ($3::int * interval '1 second') then now()
          else auth_rate_limits.bucket_started_at
        end,
        blocked_until = case
          when auth_rate_limits.blocked_until > now() then auth_rate_limits.blocked_until
          when auth_rate_limits.bucket_started_at > now() - ($3::int * interval '1 second')
            and auth_rate_limits.attempt_count + 1 > $4::int
            then now() + ($5::int * interval '1 second')
          else null
        end,
        updated_at = now()
      returning
        coalesce(blocked_until <= now(), true) as allowed,
        greatest(1, ceil(extract(epoch from (coalesce(blocked_until, now()) - now())))::int) as "retryAfter"
    `,
    [action, fingerprint(value || "unknown", secret), policy.windowSeconds, policy.maxAttempts, policy.blockSeconds],
  );
  return { allowed: row?.allowed !== false, retryAfter: Number(row?.retryAfter ?? policy.blockSeconds) };
}

export async function checkRequestAuthLimits(input: {
  account: string;
  accountAction: "login_account" | "password_reset_account";
  ipAction: "login_ip" | "password_reset_ip";
  request: Request;
}) {
  const [account, ip] = await Promise.all([
    consumeAuthRateLimit(input.accountAction, input.account || "empty"),
    consumeAuthRateLimit(input.ipAction, getTrustedRequestIp(input.request)),
  ]);
  return {
    allowed: account.allowed && ip.allowed,
    retryAfter: Math.max(account.retryAfter, ip.retryAfter),
  };
}

export async function clearLoginAuthLimits(input: { account: string; request: Request }) {
  if (!hasDatabaseUrl()) return;
  const secret = getFingerprintSecret();
  if (!secret) return;
  await executeQuery(
    `delete from auth_rate_limits
     where (action = 'login_account' and key_hash = $1)
        or (action = 'login_ip' and key_hash = $2)`,
    [
      fingerprint(input.account || "empty", secret),
      fingerprint(getTrustedRequestIp(input.request), secret),
    ],
  );
}
