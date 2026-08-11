import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  areQueueWorkersPaused,
  createCronRun,
  isCronAuthorized,
} from "../src/lib/cron/runtime.ts";

test("cron authorization fails closed unless an explicit local-only override is set", () => {
  const request = new Request("https://crm.example/api/cron/test");
  assert.equal(isCronAuthorized(request, { NODE_ENV: "production" }), false);
  assert.equal(isCronAuthorized(request, { NODE_ENV: "development" }), false);
  assert.equal(
    isCronAuthorized(request, {
      NODE_ENV: "development",
      NOVALURE_ALLOW_UNAUTHENTICATED_CRON_LOCAL: "1",
    }),
    true,
  );

  const authorized = new Request("https://crm.example/api/cron/test", {
    headers: { authorization: "Bearer a-long-random-cron-secret" },
  });
  assert.equal(isCronAuthorized(authorized, { CRON_SECRET: "a-long-random-cron-secret" }), true);
  assert.equal(isCronAuthorized(authorized, { CRON_SECRET: "wrong-secret" }), false);
});

test("worker kill switch pauses claims without mutating queue state", () => {
  assert.equal(areQueueWorkersPaused({ NOVALURE_WORKERS_PAUSED: "1" }), true);
  assert.equal(areQueueWorkersPaused({ NOVALURE_WORKERS_PAUSED: "0" }), false);
});

test("cron run exposes a bounded soft deadline and run metadata", () => {
  const run = createCronRun({ route: "test", softDeadlineMs: 5_000 });
  assert.equal(run.route, "test");
  assert.match(run.runId, /^[0-9a-f-]{36}$/i);
  assert.equal(run.shouldContinue(), true);
  assert.ok(run.durationMs() >= 0);
});

test("production schedules are staggered and workers use shared guards", async () => {
  const vercel = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.deepEqual(
    vercel.crons.map((entry) => [entry.path, entry.schedule]),
    [
      ["/api/cron/meeting-reminders", "2 * * * *"],
      ["/api/cron/teams-alerts", "4,19,34,49 * * * *"],
      ["/api/cron/google-alerts", "9,24,39,54 * * * *"],
      ["/api/cron/property-reservations", "7 * * * *"],
    ],
  );

  for (const route of vercel.crons) {
    const source = await readFile(new URL(`../src/app${route.path}/route.ts`, import.meta.url), "utf8");
    assert.match(source, /isCronAuthorized/);
    assert.match(source, /areQueueWorkersPaused/);
    assert.match(source, /runId/);
    assert.doesNotMatch(source, /VERCEL_ENV\s*!==\s*["']production["']/);
  }
});
