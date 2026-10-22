import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";
import { request } from "@playwright/test";

// Bounded QA timer for protected Preview only. Durable due jobs and all sending
// decisions remain in the existing meeting-reminders worker and database.
const [targetFile, scheduleFile, outputFile] = process.argv.slice(2);
assert.ok(targetFile && scheduleFile && outputFile, "QA_SCHEDULER_ARGUMENTS_REQUIRED");
let client;
try {
  const target = JSON.parse(await readFile(targetFile, "utf8"));
  const schedule = JSON.parse(await readFile(scheduleFile, "utf8"));
  const origin = new URL(target.url).origin;
  const url = new URL(origin);
  assert.equal(url.protocol, "https:");
  assert.match(url.hostname, /^novalure-booking-qa-20261021-[a-z0-9-]+-novalure\.vercel\.app$/);
  assert.equal(new URL(target.shareUrl).origin, origin);
  assert.equal(schedule.projectId, "prj_buPu5QHu3Cz1GXZJzid8QVRiSqZD");
  const dueAt = Date.parse(schedule.scheduledFor);
  const startedAt = Date.now();
  assert.ok(Number.isFinite(dueAt) && dueAt > startedAt + 5_000 && dueAt < startedAt + 10 * 60_000, "QA_SCHEDULE_MUST_BE_NEAR_FUTURE");
  const secrets = JSON.parse(await readFile(".npm-cache/qa/booking-preview/security-env.json", "utf8"));
  assert.ok(typeof secrets.CRON_SECRET === "string" && secrets.CRON_SECRET.length >= 32);
  client = await request.newContext({ baseURL: origin, timeout: 30_000, proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined });
  await client.get(target.shareUrl);
  const identityResponse = await client.get("/api/version");
  assert.equal(identityResponse.status(), 200, "QA_PREVIEW_ACCESS_REQUIRED");
  const identity = await identityResponse.json();
  assert.equal(identity.gitSha, target.sourceSha);
  assert.equal(identity.deploymentId, target.deploymentId);
  assert.equal(identity.branch, "codex/universal-booking");
  const invocations = [];
  for (const scheduledFor of [dueAt, dueAt + 10_000]) {
    while (Date.now() < scheduledFor) await wait(Math.min(1000, scheduledFor - Date.now()));
    const triggeredAt = new Date().toISOString();
    const response = await client.get("/api/cron/meeting-reminders", { headers: { authorization: `Bearer ${secrets.CRON_SECRET}`, "x-novalure-booking-qa": "1" } });
    assert.equal(response.status(), 200, "QA_WORKER_REQUEST_FAILED");
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.notEqual(body.paused, true);
    assert.ok(body.booking && typeof body.booking === "object", "QA_BOOKING_WORKER_NOT_ACTIVE");
    const counts = Object.fromEntries(Object.entries(body.booking).filter(([key, value]) => ["checked", "accepted", "failed", "uncertain", "skipped"].includes(key) && typeof value === "number"));
    invocations.push({ scheduledFor: new Date(scheduledFor).toISOString(), triggeredAt, counts });
  }
  const report = { projectId: schedule.projectId, deploymentId: target.deploymentId, sourceSha: target.sourceSha,
    startedAt: new Date(startedAt).toISOString(), jobId: schedule.jobId, mode: "autonomous-bounded-qa-timer", invocations,
    durableWorker: "/api/cron/meeting-reminders", productionAccess: 0 };
  await writeFile(outputFile, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report));
} catch {
  console.error("QA_REMINDER_SCHEDULE_FAILED");
  process.exitCode = 1;
} finally {
  await client?.dispose();
}
