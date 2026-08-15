import { executeQuery, queryRows } from "@/lib/db/client";
import {
  getTrustedAuthClientIp,
  normalizeAuthEmail,
  protectLowEntropyValue,
} from "@/lib/auth/auth-security";
import {
  authRateLimitPolicy,
  computeProgressiveBackoffSeconds,
  type AuthRateLimitKind,
} from "@/lib/auth/rate-limit-core";

export { computeProgressiveBackoffSeconds };

type RateLimitRow = {
  attemptCount: number | string;
  blocked: boolean;
  blockedUntil: string | Date | null;
  scope: string;
};

function getRateLimitSubjects(kind: AuthRateLimitKind, email: string, request: Request) {
  const normalizedEmail = normalizeAuthEmail(email) || "<empty>";
  const ip = getTrustedAuthClientIp(request.headers) ?? "unavailable";

  return [
    {
      scope: `${kind}_email`,
      subjectHash: protectLowEntropyValue(`${kind}-email`, normalizedEmail),
    },
    {
      scope: `${kind}_ip`,
      subjectHash: protectLowEntropyValue(`${kind}-ip`, ip),
    },
  ];
}

export async function reserveAuthRateLimitAttempt(input: {
  email: string;
  kind: AuthRateLimitKind;
  request: Request;
}) {
  const policy = authRateLimitPolicy[input.kind];
  const subjects = getRateLimitSubjects(input.kind, input.email, input.request);
  const rows = await queryRows<RateLimitRow>(
    `
      with cleanup as (
        delete from auth_rate_limit_buckets
        where last_attempt_at < now() - interval '7 days'
      ), incoming(scope, subject_hash) as (
        values ($1::text, $2::text), ($3::text, $4::text)
      ), reserved as (
        insert into auth_rate_limit_buckets (
          scope,
          subject_hash,
          attempt_count,
          window_started_at,
          last_attempt_at,
          blocked_until
        )
        select
          scope,
          subject_hash,
          1,
          now(),
          now(),
          case
            when 1 >= $5::int
              then now() + make_interval(secs => 1)
            else null
          end
        from incoming
        on conflict (scope, subject_hash) do update
        set attempt_count = case
              when auth_rate_limit_buckets.window_started_at < now() - make_interval(secs => $6::int)
                then 1
              else auth_rate_limit_buckets.attempt_count + 1
            end,
            window_started_at = case
              when auth_rate_limit_buckets.window_started_at < now() - make_interval(secs => $6::int)
                then now()
              else auth_rate_limit_buckets.window_started_at
            end,
            last_attempt_at = now(),
            blocked_until = case
              when (
                case
                  when auth_rate_limit_buckets.window_started_at < now() - make_interval(secs => $6::int)
                    then 1
                  else auth_rate_limit_buckets.attempt_count + 1
                end
              ) < $5::int then null
              else greatest(
                coalesce(auth_rate_limit_buckets.blocked_until, now()),
                now() + make_interval(
                  secs => least(
                    $7::int,
                    power(
                      2,
                      least(
                        20,
                        (
                          case
                            when auth_rate_limit_buckets.window_started_at < now() - make_interval(secs => $6::int)
                              then 1
                            else auth_rate_limit_buckets.attempt_count + 1
                          end
                        ) - $5::int
                      )
                    )::int
                  )
                )
              )
            end
        returning
          scope,
          attempt_count as "attemptCount",
          blocked_until as "blockedUntil",
          blocked_until is not null and blocked_until > now() as blocked
      )
      select scope, "attemptCount", "blockedUntil", blocked
      from reserved
    `,
    [
      subjects[0].scope,
      subjects[0].subjectHash,
      subjects[1].scope,
      subjects[1].subjectHash,
      policy.threshold,
      policy.windowSeconds,
      policy.capSeconds,
    ],
  );

  const blockedRows = rows.filter((row) => row.blocked);
  return {
    blocked: blockedRows.length > 0,
    blockedUntil: blockedRows
      .map((row) => row.blockedUntil ? new Date(row.blockedUntil).getTime() : 0)
      .reduce((latest, value) => Math.max(latest, value), 0),
    attempts: rows.map((row) => ({
      attemptCount: Number(row.attemptCount),
      scope: row.scope,
    })),
    subjects,
  };
}

export async function clearSuccessfulLoginRateLimit(input: {
  email: string;
  request: Request;
}) {
  const subjects = getRateLimitSubjects("login", input.email, input.request);
  await executeQuery(
    `
      delete from auth_rate_limit_buckets
      where (scope, subject_hash) in (($1, $2), ($3, $4))
    `,
    [
      subjects[0].scope,
      subjects[0].subjectHash,
      subjects[1].scope,
      subjects[1].subjectHash,
    ],
  );
}
