import "server-only";

import { queryOne, withDatabaseTransaction } from "@/lib/db/client";
import {
  createPublicSubmissionOpaqueHash,
  parsePublicSubmissionResponseSnapshot,
  publicSubmissionActions,
  type PublicSubmissionResponseSnapshot,
} from "@/lib/security/public-submission-abuse";

type IdempotencyClaimRow = {
  claimState: "claimed" | "conflict" | "processing" | "replay";
  leaseVersion: number | string;
  responsePayload: unknown;
};

type IdempotencyReadRow = {
  readState: "conflict" | "expired" | "processing" | "replay";
  leaseVersion: number | string;
  responsePayload: unknown;
};

type RateLimitRow = {
  allowed: boolean;
  capacityAllowed: boolean;
  consumedCount: number | string;
};

const sha256Pattern = /^[a-f0-9]{64}$/u;
const signedBigIntUpperBound = BigInt(1) << BigInt(63);
const unsignedBigIntModulus = BigInt(1) << BigInt(64);

function toPublicRateLimitAdvisoryLockKey(keyHash: string) {
  const unsigned = BigInt(`0x${keyHash.slice(0, 16)}`);
  return (unsigned >= signedBigIntUpperBound
    ? unsigned - unsignedBigIntModulus
    : unsigned).toString();
}

export type PublicSubmissionIdempotencyClaim =
  | { leaseVersion: number; state: "claimed" }
  | { state: "conflict" }
  | { leaseVersion: number; state: "processing" }
  | { response: PublicSubmissionResponseSnapshot; state: "replay" };

export type PublicSubmissionIdempotencyRead =
  | { state: "missing" }
  | { state: "conflict" }
  | { leaseVersion: number; state: "processing" }
  | { response: PublicSubmissionResponseSnapshot; state: "replay" };

/**
 * Read-only replay/processing check used before anonymous rate limiting.
 *
 * A new idempotency row is deliberately not created here: otherwise an
 * attacker could bypass the rate limiter's storage bound by presenting fresh
 * signed proofs. Expired processing leases are reported as missing so the
 * caller may pass the abuse controls before attempting an atomic reclaim.
 */
export async function readPublicSubmissionIdempotency(input: {
  actionHash: string;
  idempotencyHash: string;
  requestHash: string;
  scopeHash: string;
}): Promise<PublicSubmissionIdempotencyRead> {
  assertSha256Hashes(input);

  const row = await queryOne<IdempotencyReadRow>(
    `
      select
        case
          when existing.action_hash <> $2
            or existing.scope_hash <> $3
            or existing.request_hash <> $4
            then 'conflict'
          when existing.state = 'completed' and existing.response_payload is not null
            then 'replay'
          when existing.state = 'processing' and existing.expires_at <= now()
            then 'expired'
          else 'processing'
        end as "readState",
        existing.lease_version as "leaseVersion",
        existing.response_payload as "responsePayload"
      from public_submission_idempotency existing
      where existing.idempotency_hash = $1
      limit 1
    `,
    [input.idempotencyHash, input.actionHash, input.scopeHash, input.requestHash],
  );

  if (!row || row.readState === "expired") return { state: "missing" };
  if (row.readState === "conflict") return { state: "conflict" };
  if (row.readState === "replay") {
    const response = parsePublicSubmissionResponseSnapshot(row.responsePayload);
    if (!response) throw new Error("Public submission replay payload is invalid");
    return { response, state: "replay" };
  }
  const leaseVersion = Number(row.leaseVersion);
  if (!Number.isSafeInteger(leaseVersion) || leaseVersion < 1) {
    throw new Error("Public submission idempotency lease is invalid");
  }
  return { leaseVersion, state: "processing" };
}

export async function claimPublicSubmissionIdempotency(input: {
  actionHash: string;
  allowLeaseReclaim?: boolean;
  idempotencyHash: string;
  requestHash: string;
  scopeHash: string;
}): Promise<PublicSubmissionIdempotencyClaim> {
  assertSha256Hashes({
    actionHash: input.actionHash,
    idempotencyHash: input.idempotencyHash,
    requestHash: input.requestHash,
    scopeHash: input.scopeHash,
  });
  const allowLeaseReclaim = input.allowLeaseReclaim === true;
  const reclaimActionHashes = new Set([
    createPublicSubmissionOpaqueHash({
      label: "idempotency-action",
      value: publicSubmissionActions.form,
    }),
    createPublicSubmissionOpaqueHash({
      label: "idempotency-action",
      value: publicSubmissionActions.funnel,
    }),
  ]);
  if (allowLeaseReclaim && !reclaimActionHashes.has(input.actionHash)) {
    throw new Error("Public submission lease reclaim is not enabled for this action");
  }

  const row = await queryOne<IdempotencyClaimRow>(
    `
      with inserted as (
        insert into public_submission_idempotency (
          idempotency_hash,
          action_hash,
          scope_hash,
          request_hash,
          state,
          expires_at
        )
        values (
          $1,
          $2,
          $3,
          $4,
          'processing',
          now() + case
            when $5::boolean then interval '2 minutes'
            else interval '24 hours'
          end
        )
        on conflict (idempotency_hash) do nothing
        returning idempotency_hash, lease_version
      ), reclaimed as (
        update public_submission_idempotency existing
        set
          expires_at = now() + interval '2 minutes',
          lease_version = existing.lease_version + 1
        where existing.idempotency_hash = $1
          and $5::boolean
          and existing.action_hash = $2
          and existing.scope_hash = $3
          and existing.request_hash = $4
          and existing.state = 'processing'
          and existing.expires_at <= now()
          and not exists (select 1 from inserted)
        returning existing.idempotency_hash, existing.lease_version
      )
      select
        'claimed'::text as "claimState",
        inserted.lease_version as "leaseVersion",
        null::jsonb as "responsePayload"
      from inserted
      union all
      select
        'claimed'::text as "claimState",
        reclaimed.lease_version as "leaseVersion",
        null::jsonb as "responsePayload"
      from reclaimed
      union all
      select
        case
          when existing.action_hash <> $2
            or existing.scope_hash <> $3
            or existing.request_hash <> $4
            then 'conflict'
          when existing.state = 'completed' and existing.response_payload is not null
            then 'replay'
          else 'processing'
        end as "claimState",
        existing.lease_version as "leaseVersion",
        existing.response_payload as "responsePayload"
      from public_submission_idempotency existing
      where existing.idempotency_hash = $1
        and not exists (select 1 from inserted)
        and not exists (select 1 from reclaimed)
      limit 1
    `,
    [input.idempotencyHash, input.actionHash, input.scopeHash, input.requestHash, allowLeaseReclaim],
  );

  if (!row) throw new Error("Public submission idempotency claim failed closed");
  if (row.claimState === "replay") {
    const response = parsePublicSubmissionResponseSnapshot(row.responsePayload);
    if (!response) throw new Error("Public submission replay payload is invalid");
    return { response, state: "replay" };
  }
  if (row.claimState === "conflict") return { state: "conflict" };
  const leaseVersion = Number(row.leaseVersion);
  if (!Number.isSafeInteger(leaseVersion) || leaseVersion < 1) {
    throw new Error("Public submission idempotency lease is invalid");
  }
  if (row.claimState === "processing") return { leaseVersion, state: "processing" };
  return { leaseVersion, state: "claimed" };
}

export async function completePublicSubmissionIdempotency(input: {
  idempotencyHash: string;
  leaseVersion: number;
  requestHash: string;
  response: PublicSubmissionResponseSnapshot;
}) {
  assertSha256Hashes({
    idempotencyHash: input.idempotencyHash,
    requestHash: input.requestHash,
  });
  const response = parsePublicSubmissionResponseSnapshot(input.response);
  if (!response) throw new Error("Public submission response cannot be persisted");
  if (!Number.isSafeInteger(input.leaseVersion) || input.leaseVersion < 1) {
    throw new Error("Public submission idempotency lease is invalid");
  }

  const row = await queryOne<{ idempotencyHash: string }>(
    `
      update public_submission_idempotency
      set
        state = 'completed',
        response_payload = $3::jsonb,
        completed_at = now(),
        expires_at = greatest(expires_at, now() + interval '24 hours')
      where idempotency_hash = $1
        and request_hash = $2
        and state = 'processing'
        and lease_version = $4::bigint
      returning idempotency_hash as "idempotencyHash"
    `,
    [input.idempotencyHash, input.requestHash, JSON.stringify(response), input.leaseVersion],
  );

  if (!row) throw new Error("Public submission idempotency completion failed closed");
}

export async function consumePublicSubmissionRateLimits(input: {
  policies: Array<{ keyHash: string; limit: number; windowSeconds: number }>;
}) {
  if (!input.policies.length || input.policies.length > 8) {
    throw new Error("Invalid public submission rate-limit policy count");
  }
  for (const policy of input.policies) {
    if (
      !sha256Pattern.test(policy.keyHash) ||
      !Number.isSafeInteger(policy.limit) ||
      policy.limit < 1 ||
      policy.limit > 10_000 ||
      !Number.isSafeInteger(policy.windowSeconds) ||
      policy.windowSeconds < 60 ||
      policy.windowSeconds > 86_400
    ) {
      throw new Error("Invalid public submission rate-limit policy");
    }
  }

  const uniquePolicyKeys = new Set(input.policies.map((policy) => policy.keyHash));
  if (uniquePolicyKeys.size !== input.policies.length) {
    throw new Error("Duplicate public submission rate-limit policy");
  }

  const policies = [...input.policies].sort((left, right) =>
    left.keyHash.localeCompare(right.keyHash),
  );

  const lockKeys = policies
    .map((policy) => toPublicRateLimitAdvisoryLockKey(policy.keyHash))
    .sort((left, right) => {
      const leftKey = BigInt(left);
      const rightKey = BigInt(right);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });

  return withDatabaseTransaction(async (transaction) => {
    // Acquire every overlapping policy lock in one global order. Capacity is
    // read only by the following statement, whose READ COMMITTED snapshot is
    // created after any lock wait has completed.
    for (const lockKey of lockKeys) {
      await transaction.execute(
        "select pg_advisory_xact_lock($1::bigint)",
        [lockKey],
      );
    }

    const row = await transaction.queryOne<RateLimitRow>(
      `
        with expired_idempotency as (
        select idempotency_hash
        from public_submission_idempotency
        where expires_at <= now()
        order by expires_at, idempotency_hash
        limit 64
        for update skip locked
      ), pruned_idempotency as (
        delete from public_submission_idempotency expired
        using expired_idempotency targets
        where expired.idempotency_hash = targets.idempotency_hash
        returning expired.idempotency_hash
      ), expired_rate_limits as (
        select key_hash, bucket_started_at
        from public_submission_rate_limits
        where expires_at <= now()
        order by expires_at, key_hash, bucket_started_at
        limit 64
        for update skip locked
      ), pruned_rate_limits as (
        delete from public_submission_rate_limits expired
        using expired_rate_limits targets
        where expired.key_hash = targets.key_hash
          and expired.bucket_started_at = targets.bucket_started_at
        returning expired.key_hash
      ), policies as (
        select *
        from unnest($1::text[], $2::integer[], $3::integer[])
          as requested(key_hash, limit_count, window_seconds)
      ), bucketed as (
        select
          key_hash,
          limit_count,
          window_seconds,
          to_timestamp(
            floor(extract(epoch from now()) / window_seconds) * window_seconds
          ) as bucket_started_at
        from policies
      ), current_capacity as materialized (
        select
          bucketed.key_hash,
          bucketed.limit_count,
          bucketed.window_seconds,
          bucketed.bucket_started_at,
          existing.limit_count as existing_limit_count,
          existing.request_count as existing_request_count,
          existing.expires_at as existing_expires_at
        from bucketed
        left join public_submission_rate_limits existing
          on existing.key_hash = bucketed.key_hash
          and existing.bucket_started_at = bucketed.bucket_started_at
      ), capacity as materialized (
        select
          count(*) = cardinality($1::text[])
          and bool_and(
            coalesce(existing_request_count, 0)
              < least(coalesce(existing_limit_count, limit_count), limit_count)
          ) as allowed
        from current_capacity
      ), consumed as (
        insert into public_submission_rate_limits (
          key_hash,
          bucket_started_at,
          window_seconds,
          limit_count,
          request_count,
          expires_at
        )
        select
          key_hash,
          bucket_started_at,
          window_seconds,
          limit_count,
          1,
          bucket_started_at + make_interval(secs => window_seconds * 2)
        from current_capacity
        cross join capacity
        where capacity.allowed
        on conflict (key_hash, bucket_started_at) do update
        set
          request_count = public_submission_rate_limits.request_count + 1,
          limit_count = least(public_submission_rate_limits.limit_count, excluded.limit_count),
          expires_at = greatest(public_submission_rate_limits.expires_at, excluded.expires_at)
        where public_submission_rate_limits.request_count
          < least(public_submission_rate_limits.limit_count, excluded.limit_count)
        returning key_hash
      )
      select
        coalesce((select allowed from capacity), false) as "capacityAllowed",
        (select count(*) from consumed) as "consumedCount",
        coalesce((select allowed from capacity), false)
          and (select count(*) from consumed) = cardinality($1::text[]) as allowed,
        (select count(*) from pruned_idempotency) as "prunedIdempotencyCount",
        (select count(*) from pruned_rate_limits) as "prunedRateLimitCount"
      `,
      [
        policies.map((policy) => policy.keyHash),
        policies.map((policy) => policy.limit),
        policies.map((policy) => policy.windowSeconds),
      ],
    );

    if (!row) throw new Error("Public submission rate limiter failed closed");
    const consumedCount = Number(row.consumedCount);
    if (!Number.isSafeInteger(consumedCount) || consumedCount < 0) {
      throw new Error("Public submission rate limiter returned an invalid write count");
    }
    if (
      (row.capacityAllowed && consumedCount !== policies.length) ||
      (!row.capacityAllowed && consumedCount !== 0)
    ) {
      // An unexpected non-cooperating writer must not turn a denied request
      // into partial counter consumption. Throwing rolls back this transaction.
      throw new Error("Public submission rate limiter atomicity conflict");
    }
    return { allowed: row.allowed === true };
  });
}

function assertSha256Hashes(value: Record<string, string>) {
  if (Object.values(value).some((hash) => !sha256Pattern.test(hash))) {
    throw new Error("Invalid public submission hash");
  }
}
