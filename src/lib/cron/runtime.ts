import { randomUUID, timingSafeEqual } from "node:crypto";

const DEFAULT_SOFT_DEADLINE_MS = 45_000;
const CRON_ROUTE_NAMES = [
  "google-alerts",
  "meeting-reminders",
  "property-exports",
  "property-reservations",
  "teams-alerts",
] as const;

type CronRouteName = (typeof CRON_ROUTE_NAMES)[number];
type CronSuccessOutcome = "completed" | "paused";
type CronTerminalEvent = "novalure.cron.failed" | "novalure.cron.succeeded";

const cronRouteNames = new Set<string>(CRON_ROUTE_NAMES);

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

function emitCronEvent(input: {
  durationMs: number;
  event: "novalure.cron.failed" | "novalure.cron.started" | "novalure.cron.succeeded";
  invocationId: string;
  level: "error" | "info";
  outcome: "completed" | "failed" | "paused" | "started";
  route: CronRouteName;
}) {
  const record = {
    component: "cron_queue",
    durationMs: Math.max(0, Math.trunc(input.durationMs)),
    event: input.event,
    invocationId: input.invocationId,
    level: input.level,
    outcome: input.outcome,
    route: input.route,
    schemaVersion: 1,
  };

  try {
    if (input.level === "error") {
      console.error(JSON.stringify(record));
    } else {
      console.log(JSON.stringify(record));
    }
  } catch {
    // Telemetry must never affect the cron worker's business outcome.
  }
}

export function createCronRun(input: { route: CronRouteName; softDeadlineMs?: number }) {
  if (!cronRouteNames.has(input.route)) {
    throw new Error("Unsupported cron route");
  }

  const startedAtMs = Date.now();
  const softDeadlineMs = Math.max(5_000, Math.min(55_000, input.softDeadlineMs ?? DEFAULT_SOFT_DEADLINE_MS));
  const runId = randomUUID();
  let terminalEventEmitted = false;
  const durationMs = () => Date.now() - startedAtMs;

  emitCronEvent({
    durationMs: 0,
    event: "novalure.cron.started",
    invocationId: runId,
    level: "info",
    outcome: "started",
    route: input.route,
  });

  function emitTerminalEvent(event: CronTerminalEvent, outcome: CronSuccessOutcome | "failed") {
    if (terminalEventEmitted) return false;
    terminalEventEmitted = true;
    emitCronEvent({
      durationMs: durationMs(),
      event,
      invocationId: runId,
      level: event === "novalure.cron.failed" ? "error" : "info",
      outcome,
      route: input.route,
    });
    return true;
  }

  return {
    durationMs,
    fail: () => emitTerminalEvent("novalure.cron.failed", "failed"),
    route: input.route,
    runId,
    shouldContinue: () => Date.now() - startedAtMs < softDeadlineMs,
    startedAt: new Date(startedAtMs).toISOString(),
    succeed: (outcome: CronSuccessOutcome = "completed") => {
      if (outcome !== "completed" && outcome !== "paused") {
        throw new Error("Unsupported cron success outcome");
      }
      return emitTerminalEvent("novalure.cron.succeeded", outcome);
    },
  };
}
