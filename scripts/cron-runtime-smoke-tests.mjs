import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import {
  areQueueWorkersPaused,
  createCronRun,
  isCronAuthorized,
} from "../src/lib/cron/runtime.ts";

function assertCronDelegation(entry, handler, relativeModule) {
  const path = `@/lib/${relativeModule.replace(/\.ts$/, "")}`;
  const file = ts.createSourceFile("route.ts", entry, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imports = file.statements.filter(ts.isImportDeclaration).filter(item => ts.isStringLiteral(item.moduleSpecifier) && item.moduleSpecifier.text === path);
  assert.equal(imports.length, 1);
  const names = imports[0].importClause?.namedBindings;
  assert.ok(names && ts.isNamedImports(names));
  assert.ok(names.elements.some(item => item.name.text === handler && !item.propertyName));
  const get = file.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === "GET");
  assert.ok(get && ts.isFunctionDeclaration(get) && get.modifiers?.some(item => item.kind === ts.SyntaxKind.ExportKeyword));
  assert.equal(get.body?.statements.length, 1);
  const statement = get.body?.statements[0];
  assert.ok(statement && ts.isReturnStatement(statement) && statement.expression && ts.isCallExpression(statement.expression));
  assert.ok(ts.isIdentifier(statement.expression.expression) && statement.expression.expression.text === handler);
  assert.equal(statement.expression.arguments.length, 1);
  assert.ok(ts.isIdentifier(statement.expression.arguments[0]) && statement.expression.arguments[0].text === "request");
}

test("delegated cron source is bound to the handler that is checked", () => {
  const entry = 'import {handleNewsletterCron} from "@/lib/newsletter-scheduler"; export async function GET(request) { return handleNewsletterCron(request); }';
  assert.doesNotThrow(() => assertCronDelegation(entry, "handleNewsletterCron", "newsletter-scheduler.ts"));
  assert.throws(() => assertCronDelegation(entry.replace("@/lib/newsletter-scheduler", "@/lib/unverified"), "handleNewsletterCron", "newsletter-scheduler.ts"));
  assert.throws(() => assertCronDelegation(entry.replace("return handleNewsletterCron", "return handleDifferentCron"), "handleNewsletterCron", "newsletter-scheduler.ts"));
  assert.throws(() => assertCronDelegation(`// ${entry}\n` + entry.replace("@/lib/newsletter-scheduler", "@/lib/unverified"), "handleNewsletterCron", "newsletter-scheduler.ts"));
  assert.throws(() => assertCronDelegation(entry.replace("return handleNewsletterCron", "const handleNewsletterCron = malicious; return handleNewsletterCron"), "handleNewsletterCron", "newsletter-scheduler.ts"));
});

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

test("production schedules pin the approved booking cadence and workers use shared guards", async () => {
  const vercel = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.deepEqual(
    vercel.crons.map((entry) => [entry.path, entry.schedule]),
    [
      ["/api/cron/newsletter", "*/5 * * * *"],
      ["/api/cron/notification-digests", "11,41 * * * *"],
      ["/api/cron/lead-proof-retention", "37 3 * * *"],
      ["/api/cron/web-expose-retention", "17 3 * * *"],
      ["/api/cron/automations", "*/5 * * * *"],
      ["/api/cron/meeting-reminders", "* * * * *"],
      ["/api/cron/teams-alerts", "4,19,34,49 * * * *"],
      ["/api/cron/google-alerts", "9,24,39,54 * * * *"],
      ["/api/cron/property-reservations", "7 * * * *"],
      ["/api/cron/knowledge-monitoring", "0 6 * * *"],
      ["/api/cron/mailbox-sync", "*/2 * * * *"],
    ],
  );

  for (const route of vercel.crons) {
    const entry = await readFile(new URL(`../src/app${route.path}/route.ts`, import.meta.url), "utf8");
    let source = entry;
    const delegates = {
      "/api/cron/newsletter": ["handleNewsletterCron", "newsletter-scheduler.ts"],
      "/api/cron/notification-digests": ["handleCrmNotificationEmailCron", "crm-notification-email-worker.ts"],
      "/api/cron/lead-proof-retention": ["handleProofRetentionCron", "lead-proof-retention-scheduler.ts"],
      "/api/cron/web-expose-retention": ["handleWebExposeRetentionCron", "web-expose-maintenance.ts"],
      "/api/cron/automations": ["handleAutomationCron", "automation/scheduler.ts"],
      "/api/cron/mailbox-sync": ["handleMailboxSyncCron", "crm-mailbox-sync-worker.ts"],
    };
    const delegated = delegates[route.path];
    if (delegated) {
      assertCronDelegation(entry, delegated[0], delegated[1]);
      source = await readFile(new URL(`../src/lib/${delegated[1]}`, import.meta.url), "utf8");
    }
    if (route.path === "/api/cron/knowledge-monitoring") {
      assert.match(entry, /import \{ handleKnowledgeMonitoringCron \} from "@\/lib\/knowledge-center\/monitoring-delegation"/);
      assert.match(entry, /return handleKnowledgeMonitoringCron\(request\)/);
      source = await readFile(new URL("../src/lib/knowledge-center/monitoring-delegation.ts", import.meta.url), "utf8");
      assert.match(source, /!env\.CRON_SECRET\?\.trim\(\) \|\| !isCronAuthorized\(request, env\)/);
    }
    assert.match(source, /isCronAuthorized/);
    assert.match(source, /areQueueWorkersPaused/);
    assert.match(source, /createCronRun/);
    assert.doesNotMatch(source, /VERCEL_ENV\s*!==\s*["']production["']/);
  }
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
