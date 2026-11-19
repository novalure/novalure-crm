import { readFile, stat } from "node:fs/promises";
import pg from "pg";
import { createBehaviorLifecycle, runScheduledBehaviorLearning } from "../src/lib/shared-behavior/lifecycle";
import { exactBehaviorObject, SharedBehaviorError } from "../src/lib/shared-behavior/catalog";

/** Explicit publisher-only operator surface; no tenant/Production credential fallback. */
async function main() {
  const [command, configPath] = process.argv.slice(2);
  if (!command || !["inspect", "propose", "evaluate", "publish", "rollback", "scheduled"].includes(command)) throw new SharedBehaviorError("INVALID_MANAGEMENT_COMMAND");
  const connectionString = process.env.BEHAVIOR_PUBLISHER_DATABASE_URL;
  if (!connectionString) throw new SharedBehaviorError("PUBLISHER_CONNECTION_REQUIRED");
  let value: Record<string, unknown> = {};
  if (command !== "inspect") {
    if (!configPath || (await stat(configPath)).size > 4096) throw new SharedBehaviorError("BOUNDED_CONFIG_REQUIRED");
    value = JSON.parse(await readFile(configPath, "utf8"));
  } else if (configPath) throw new SharedBehaviorError("INVALID_MANAGEMENT_ARGUMENTS");
  const pool = new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
  try {
    const lifecycle = createBehaviorLifecycle(pool);
    if (command === "inspect") return await lifecycle.inspect();
    if (command === "scheduled") {
      const input = exactBehaviorObject(value, ["enabled", "selection"]);
      if (typeof input.enabled !== "boolean") throw new SharedBehaviorError("INVALID_SCHEDULE_FLAG");
      if (!input.enabled) return { status: "disabled" };
      // Fresh head each invocation. A publication yesterday cannot make today's config stale.
      const current = await lifecycle.inspect();
      return await runScheduledBehaviorLearning(pool, { enabled: true, selection: input.selection, expectedRevision: current.head.revision });
    }
    if (command === "propose") {
      const input = exactBehaviorObject(value, ["selection", "expectedRevision"]);
      return await lifecycle.propose(input.selection, input.expectedRevision as number);
    }
    if (command === "evaluate") {
      const input = exactBehaviorObject(value, ["candidateId"]);
      return await lifecycle.evaluate(input.candidateId as string);
    }
    if (command === "publish") {
      const input = exactBehaviorObject(value, ["candidateId", "expectedRevision"]);
      return await lifecycle.publish(input.candidateId as string, input.expectedRevision as number);
    }
    const input = exactBehaviorObject(value, ["version", "expectedRevision"]);
    return await lifecycle.rollback(input.version as number, input.expectedRevision as number);
  } finally { await pool.end(); }
}
main().then(result => {
  console.log(JSON.stringify(result));
  if (result && "status" in result && result.status === "failed") process.exitCode = 1;
}).catch(error => {
  // SQL, provider messages, configuration contents and URLs must never enter logs.
  console.error(JSON.stringify({ status: "failed", code: error instanceof SharedBehaviorError ? error.code : "LEARNING_MANAGEMENT_FAILED" }));
  process.exitCode = 1;
});
