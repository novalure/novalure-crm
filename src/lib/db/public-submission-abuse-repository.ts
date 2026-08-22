import "server-only";

import { queryOne } from "@/lib/db/client";
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

type RateLimitRow = {
  allowed: boolean;
};

const sha256Pattern = /^[a-f0-9]{64}$/u;

export type PublicSubmissionIdempotencyClaim =
  | { leaseVersion: number; state: "claimed" }
  | { state: "conflict" }
  | { leaseVersion: number; state: "processing" }
  | { response: PublicSubmissionResponseSnapshot; state: "replay" };

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

  const row = await queryOne<RateLimitRow>(
    `
      with policies as (
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
        from bucketed
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
        (select count(*) from consumed) = cardinality($1::text[]) as allowed
    `,
    [
      input.policies.map((policy) => policy.keyHash),
      input.policies.map((policy) => policy.limit),
      input.policies.map((policy) => policy.windowSeconds),
    ],
  );

  if (!row) throw new Error("Public submission rate limiter failed closed");
  return { allowed: row.allowed };
}

function assertSha256Hashes(value: Record<string, string>) {
  if (Object.values(value).some((hash) => !sha256Pattern.test(hash))) {
    throw new Error("Invalid public submission hash");
  }
}
