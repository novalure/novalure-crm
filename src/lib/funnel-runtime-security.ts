import "server-only";

import { createPublicSubmissionOpaqueHash } from "@/lib/security/public-submission-abuse";

export function createPublicFunnelVisitProofIdentityHash(input: {
  idempotencyKey: string;
  scope: string;
}) {
  return createPublicSubmissionOpaqueHash({
    label: "public-funnel-visit-proof-identity",
    value: `${input.scope}\n${input.idempotencyKey}`,
  });
}

export function createPublicFunnelProofRefreshRateLimitPolicies(input: {
  clientIp: string;
  idempotencyKey: string;
}) {
  const hash = (label: string, value: string) =>
    createPublicSubmissionOpaqueHash({
      label: `public-funnel-proof-refresh-rate-${label}`,
      value,
    });

  return [
    {
      keyHash: hash("ip", input.clientIp),
      limit: 600,
      windowSeconds: 10 * 60,
    },
    {
      keyHash: hash("proof", input.idempotencyKey),
      limit: 4,
      windowSeconds: 15 * 60,
    },
  ];
}

export function createPublicFunnelVisitIngressRateLimitPolicies(input: {
  clientIp: string;
}) {
  return [{
    keyHash: createPublicSubmissionOpaqueHash({
      label: "public-funnel-visit-ingress-rate-ip",
      value: input.clientIp,
    }),
    limit: 90,
    windowSeconds: 10 * 60,
  }];
}

export function createPublicFunnelVisitRateLimitPolicies(input: {
  idempotencyKey: string;
  scope: string;
}) {
  const hash = (label: string, value: string) =>
    createPublicSubmissionOpaqueHash({
      label: `public-funnel-visit-rate-${label}`,
      value: `${input.scope}\n${value}`,
    });

  return [
    {
      keyHash: hash("proof", input.idempotencyKey),
      limit: 8,
      windowSeconds: 15 * 60,
    },
    {
      keyHash: hash("scope", "all"),
      limit: 2_000,
      windowSeconds: 10 * 60,
    },
  ];
}
