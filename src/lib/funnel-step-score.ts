export const defaultFunnelStepScore = 10;

/**
 * Step scoring is an explicit business input. Visit and conversion analytics
 * must never become an implicit scoring or routing signal.
 */
export function resolveFunnelStepScore(score: number | null | undefined) {
  return score ?? defaultFunnelStepScore;
}
