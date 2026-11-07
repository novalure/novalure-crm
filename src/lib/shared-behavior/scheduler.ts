import "server-only";
import pg from "pg";
import { areQueueWorkersPaused, isCronAuthorized } from "../cron/runtime";
import { createBehaviorLifecycle, runScheduledBehaviorLearning } from "./lifecycle";
import { parseBehaviorSelection } from "./catalog";

type PublisherPool = ConstructorParameters<typeof pg.Pool>[0];
type PoolFactory = (options: PublisherPool) => pg.Pool;

/** Called from the existing daily cron. No new schedule; tenant pools never become publishers. */
export async function dispatchScheduledBehaviorLearning(request: Request, env: NodeJS.ProcessEnv = process.env,
  makePool: PoolFactory = options => new pg.Pool(options)) {
  if (env.NOVALURE_SHARED_LEARNING_ENABLED !== "1") return { status: "disabled" as const };
  // Local development's permissive cron option is never sufficient for this publisher.
  if (request.method !== "GET" || !env.CRON_SECRET?.trim() || !isCronAuthorized(request, env)) return { status: "unauthorized" as const };
  if (areQueueWorkersPaused(env)) return { status: "paused" as const };
  let pool: pg.Pool | undefined;
  try {
    const selection = parseBehaviorSelection(JSON.parse(env.NOVALURE_SHARED_LEARNING_SELECTION ?? "null"));
    const connectionString = env.BEHAVIOR_PUBLISHER_DATABASE_URL;
    if (!connectionString) return { status: "unconfigured" as const };
    pool = makePool({ connectionString, max: 2, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
    const current = await createBehaviorLifecycle(pool).inspect();
    const result = await runScheduledBehaviorLearning(pool, { enabled: true, selection, expectedRevision: current.head.revision });
    // Only categorical monitor metadata; never include selection, evaluation contents or SQL errors.
    return { status: result.status, ...("runId" in result ? { runId: result.runId } : {}) };
  } catch { return { status: "failed" as const }; }
  finally {
    try { await pool?.end(); }
    catch { return { status: "failed" as const }; }
  }
}
