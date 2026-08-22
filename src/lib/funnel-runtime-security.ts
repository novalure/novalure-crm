import "server-only";

import { createPublicSubmissionOpaqueHash } from "@/lib/security/public-submission-abuse";

export function createPublicFunnelVisitIdHash(input: {
  scope: string;
  visitId: string;
}) {
  return createPublicSubmissionOpaqueHash({
    label: "public-funnel-visit-id",
    value: `${input.scope}\n${input.visitId}`,
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

export function createPublicFunnelVisitRateLimitPolicies(input: {
  clientIp: string;
  scope: string;
  visitId: string;
}) {
  const hash = (label: string, value: string) =>
    createPublicSubmissionOpaqueHash({
      label: `public-funnel-visit-rate-${label}`,
      value: `${input.scope}\n${value}`,
    });

  return [
    {
      keyHash: hash("ip", input.clientIp),
      limit: 90,
      windowSeconds: 10 * 60,
    },
    {
      keyHash: hash("visit", input.visitId),
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
