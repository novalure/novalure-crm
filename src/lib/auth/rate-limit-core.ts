export type AuthRateLimitKind = "login" | "reset";

export const authRateLimitPolicy = {
  login: { capSeconds: 3_600, threshold: 5, windowSeconds: 3_600 },
  reset: { capSeconds: 21_600, threshold: 3, windowSeconds: 21_600 },
} as const;

export function computeProgressiveBackoffSeconds(
  attemptCount: number,
  kind: AuthRateLimitKind,
) {
  const policy = authRateLimitPolicy[kind];
  if (!Number.isFinite(attemptCount) || attemptCount < policy.threshold) return 0;
  return Math.min(policy.capSeconds, 2 ** Math.min(20, attemptCount - policy.threshold));
}
