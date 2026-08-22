import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("Resend readiness requires an explicit production key and sender and never queues a mock", async () => {
  const resend = await source("src/lib/integrations/resend.ts");
  const sendFunction = resend.slice(resend.indexOf("export async function sendNewsletterEmail"));

  assert.doesNotMatch(resend, /NOVALURE_EMAIL_FROM|onboarding@resend\.dev/);
  assert.match(resend, /normalizeApiKey[\s\S]*\^re_/);
  assert.match(resend, /process\.env\.RESEND_FROM/);
  assert.match(resend, /mailbox\.endsWith\("@resend\.dev"\)/);
  assert.match(resend, /const configured = reason === null/);
  assert.match(
    sendFunction,
    /if \(!providerStatus\.configured \|\| !apiKey\)[\s\S]*status: "failed"[\s\S]*errorCode: "configuration"/,
  );
  assert.doesNotMatch(sendFunction, /status:\s*"queued"|provider:\s*"mock"/);
  assert.match(sendFunction, /AbortSignal\.timeout\(PROVIDER_TIMEOUT_MS\)/);
  assert.match(sendFunction, /normalizeIdempotencyKey[\s\S]*"Idempotency-Key"/);
  assert.match(sendFunction, /if \(!messageId\)[\s\S]*status: "failed"/);
  assert.match(sendFunction, /const requestedFrom = String\(input\.from \?\? ""\)\.trim\(\)/);
  assert.match(sendFunction, /const from = providerStatus\.from/);
  assert.match(sendFunction, /requestedFrom && requestedFrom !== providerStatus\.from/);
  assert.doesNotMatch(sendFunction, /const from = input\.from/);
});

test("provider failures are classified without exposing provider response or exception text", async () => {
  const resend = await source("src/lib/integrations/resend.ts");

  assert.match(resend, /status === 401 \|\| status === 403[\s\S]*provider_auth/);
  assert.match(resend, /status === 429[\s\S]*provider_rate_limit/);
  assert.match(resend, /status >= 500[\s\S]*temporarily unavailable/);
  assert.doesNotMatch(resend, /data\.message|error instanceof Error \? error\.message|Resend returned/);
  assert.match(resend, /error\.name === "AbortError" \|\| error\.name === "TimeoutError"/);
  assert.match(resend, /createHash\("sha256"\)\.update\(key\)/);
});

test("meeting test route permits only the explicit QA allowlist and returns masked external truth", async () => {
  const route = await source("src/app/api/meetings/notifications/route.ts");
  const auditStart = route.indexOf("await writeAuditLog");
  const auditEnd = route.indexOf("return NextResponse.json", auditStart);
  const auditBlock = route.slice(auditStart, auditEnd);

  assert.match(route, /process\.env\.NOVALURE_QA_EMAIL_ALLOWLIST/);
  assert.doesNotMatch(route, /process\.env\.NOVALURE_QA_EMAIL\b|QA_LOGIN_EMAIL|evaluateOutboundConsent/);
  assert.match(route, /entries\.length > MAX_QA_RECIPIENTS/);
  assert.match(route, /if \(!qaAllowlist\)[\s\S]*status: 503/);
  assert.match(route, /if \(!qaAllowlist\.has\(to\)\)[\s\S]*status: 403/);
  assert.match(route, /!provider\.configured \|\| !provider\.external/);
  assert.match(route, /!hasDatabaseUrl\(\) \|\| !isUuid\(auth\.session\.workspaceId\)/);
  assert.match(route, /buildQaIdempotencyKey[\s\S]*QA_IDEMPOTENCY_WINDOW_MS/);
  assert.doesNotMatch(route, /body\.idempotencyKey/);
  assert.match(route, /recipientHash: qaRecipientHash/);
  assert.doesNotMatch(auditBlock, /\bto\b|recipientEmail/);
  assert.match(route, /recipient: maskEmail\(to\)/);
  assert.match(route, /external: result\.status === "sent"/);
  assert.match(route, /status: result\.status === "sent" \? 200 : 502/);
});

test("calendar UI requires a dedicated QA address and confirms only an external sent result", async () => {
  const calendar = await source("src/components/calendar-command-center.tsx");
  const sendStart = calendar.indexOf("const sendMeetingTestNotification");
  const sendEnd = calendar.indexOf("const updateMeetingAutomation", sendStart);
  const sendFunction = calendar.slice(sendStart, sendEnd);

  assert.match(calendar, /const \[meetingTestRecipient, setMeetingTestRecipient\] = useState\(""\)/);
  assert.match(calendar, /data-external-email-test="true"/);
  assert.match(calendar, /NOVALURE_QA_EMAIL_ALLOWLIST/);
  assert.match(sendFunction, /const to = meetingTestRecipient\.trim\(\)/);
  assert.doesNotMatch(sendFunction, /selectedEvent\?\.contact\?\.email|users\[0\]|idempotencyKey/);
  assert.match(sendFunction, /result\.external !== true \|\| status !== "sent"/);
  assert.match(sendFunction, /setMeetingNotificationStatus\("sent"\)/);
  assert.doesNotMatch(sendFunction, /queued|testMailQueued|preparingTestMail/);
});

test("meeting runner bounds batches and never marks non-sent provider results as sent", async () => {
  const runner = await source("src/lib/meetings/notification-runner.ts");
  const repository = await source("src/lib/db/meeting-repositories.ts");

  assert.match(runner, /const MAX_NOTIFICATION_BATCH = 25/);
  assert.match(runner, /new Set\(input\.jobIds \?\? \[\]\)[\s\S]*slice\(0, MAX_NOTIFICATION_BATCH\)/);
  assert.match(runner, /Math\.max\(1, Math\.min\(MAX_NOTIFICATION_BATCH/);
  assert.match(runner, /if \(emailResult\.status !== "sent"\)/);
  assert.match(runner, /markMeetingNotificationJobFailed\([\s\S]*emailResult\.errorCode/);
  assert.match(repository, /attempt_count < max_attempts/);
  assert.match(repository, /attempt_count >= max_attempts then 'dead_letter'/);
});

test("all operational sendNewsletterEmail callers already treat failed delivery compatibly", async () => {
  const [bot, passwordReset, customerAccess, settingsAccess, newsletter] = await Promise.all([
    source("src/lib/bots/provider-actions.ts"),
    source("src/lib/auth/password-reset.ts"),
    source("src/lib/db/customer-access-repositories.ts"),
    source("src/lib/db/settings-access-repositories.ts"),
    source("src/app/api/newsletter/send/route.ts"),
  ]);

  assert.match(bot, /sendNewsletterEmail\([\s\S]*result\.status === "failed" \? "failed"/);
  assert.match(passwordReset, /sendNewsletterEmail\([\s\S]*delivery\.status === "failed" \? "failure"/);
  assert.match(customerAccess, /sendNewsletterEmail\([\s\S]*delivery\.status === "failed" \? "failure"/);
  assert.match(settingsAccess, /sendNewsletterEmail\([\s\S]*delivery\.status === "failed" \? "failure"/);
  assert.match(newsletter, /const hasFailedSend = sends\.some\(\(send\) => send\.status === "failed"\)/);
  assert.match(newsletter, /status: hasFailedSend \? 502 : 200/);
});
