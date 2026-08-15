import { randomUUID, timingSafeEqual } from "node:crypto";

const DEFAULT_SOFT_DEADLINE_MS = 45_000;

function constantTimeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function isCronAuthorized(request: Request, env: NodeJS.ProcessEnv = process.env) {
  const secret = env.CRON_SECRET?.trim() ?? "";
  if (!secret) {
    return env.NODE_ENV !== "production" && env.NOVALURE_ALLOW_UNAUTHENTICATED_CRON_LOCAL === "1";
  }

  const authorization = request.headers.get("authorization") ?? "";
  return constantTimeEqual(authorization, `Bearer ${secret}`);
}

export function areQueueWorkersPaused(env: NodeJS.ProcessEnv = process.env) {
  return env.NOVALURE_WORKERS_PAUSED === "1";
}

export function createCronRun(input: { route: string; softDeadlineMs?: number }) {
  const startedAtMs = Date.now();
  const softDeadlineMs = Math.max(5_000, Math.min(55_000, input.softDeadlineMs ?? DEFAULT_SOFT_DEADLINE_MS));

  return {
    durationMs: () => Date.now() - startedAtMs,
    route: input.route,
    runId: randomUUID(),
    shouldContinue: () => Date.now() - startedAtMs < softDeadlineMs,
    startedAt: new Date(startedAtMs).toISOString(),
  };
}
