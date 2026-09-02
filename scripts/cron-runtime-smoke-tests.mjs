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
  const run = createCronRun({ route: "meeting-reminders", softDeadlineMs: 5_000 });
  assert.equal(run.route, "meeting-reminders");
  assert.match(run.runId, /^[0-9a-f-]{36}$/i);
  assert.equal(run.shouldContinue(), true);
  assert.ok(run.durationMs() >= 0);
  assert.equal(run.succeed(), true);
  assert.equal(run.succeed(), false);
  assert.equal(run.fail(), false);
});

test("cron observability emits correlated redacted start, success, and failure events", { concurrency: false }, (t) => {
  const lines = [];
  t.mock.method(console, "log", (line) => lines.push(String(line)));
  t.mock.method(console, "error", (line) => lines.push(String(line)));

  const successfulRun = createCronRun({ route: "property-reservations" });
  successfulRun.succeed("paused");

  const secret = "franz@example.test?token=do-not-log";
  const failedRun = createCronRun({ route: "teams-alerts" });
  failedRun.fail(new Error(secret));

  const records = lines.map((line) => JSON.parse(line));
  assert.deepEqual(
    records.map((record) => record.event),
    [
      "novalure.cron.started",
      "novalure.cron.succeeded",
      "novalure.cron.started",
      "novalure.cron.failed",
    ],
  );
  assert.equal(records[0].invocationId, records[1].invocationId);
  assert.equal(records[2].invocationId, records[3].invocationId);
  assert.notEqual(records[0].invocationId, records[2].invocationId);
  assert.equal(records[1].outcome, "paused");
  assert.equal(records[3].outcome, "failed");
  assert.equal(records[3].level, "error");
  assert.ok(records.every((record) => Number.isInteger(record.durationMs) && record.durationMs >= 0));
  assert.ok(
    records.every(
      (record) =>
        JSON.stringify(Object.keys(record).sort()) ===
        JSON.stringify(
          [
            "component",
            "durationMs",
            "event",
            "invocationId",
            "level",
            "outcome",
            "route",
            "schemaVersion",
          ].sort(),
        ),
    ),
  );
  assert.doesNotMatch(JSON.stringify(records), /franz@example\.test|do-not-log|token=/i);
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
      ["/api/cron/property-exports", "12 * * * *"],
    ],
  );

  for (const route of vercel.crons) {
    const source = await readFile(new URL(`../src/app${route.path}/route.ts`, import.meta.url), "utf8");
    assert.match(source, /isCronAuthorized/);
    assert.match(source, /areQueueWorkersPaused/);
    assert.match(source, /runId/);
    assert.match(source, /run\.succeed\(/);
    assert.match(source, /run\.fail\(\)/);
    assert.match(source, /catch \(error\)/);
    assert.match(source, /throw error/);
    assert.doesNotMatch(source, /VERCEL_ENV\s*!==\s*["']production["']/);
  }
});

test("cron event implementation cannot ingest request or error details", async () => {
  const runtime = await readFile(new URL("../src/lib/cron/runtime.ts", import.meta.url), "utf8");
  const observability = runtime.slice(runtime.indexOf("function emitCronEvent"));

  assert.match(observability, /const CRON_ROUTE_NAMES|cronRouteNames/);
  assert.doesNotMatch(observability, /request\.url|request\.headers|\.message|\.stack|payload|email/i);
  assert.doesNotMatch(observability, /console\.(?:log|error)\([^\n]*error/i);
});

test("Google workspace scans avoid parallel database bursts while durable workers stay leased", async () => {
  const google = await readFile(
    new URL("../src/lib/db/google-notification-repositories.ts", import.meta.url),
    "utf8",
  );
  const scheduledStart = google.indexOf("export async function queueScheduledCriticalGoogleAlerts");
  const scheduledEnd = google.indexOf("export async function reconcileGoogleNotificationJob", scheduledStart);
  const scheduledWorker = google.slice(scheduledStart, scheduledEnd);

  assert.ok(scheduledStart >= 0 && scheduledEnd > scheduledStart);
  assert.doesNotMatch(scheduledWorker, /Promise\.all/);
  assert.match(scheduledWorker, /await queueGoogleLeadSlaOverdueAlerts/);
  assert.match(scheduledWorker, /await queueGoogleCustomerAccessRiskAlerts/);
  assert.match(google, /for update skip locked/i);
  assert.match(google, /lease_expires_at = now\(\) \+ interval '45 seconds'/i);
});
