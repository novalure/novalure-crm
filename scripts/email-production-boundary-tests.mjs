import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

async function importTranspiled(sourceText) {
  const output = ts.transpileModule(sourceText, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;

  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}#${crypto.randomUUID()}`);
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("Resend adapter dynamically blocks every unapproved purpose before fetch while preserving account mail", async () => {
  const resendSource = (await source("src/lib/integrations/resend.ts")).replace(
    'import { evaluateLaunchScope } from "@/lib/launch-scope";',
    "const evaluateLaunchScope = () => ({ allowed: false });",
  );
  const resend = await importTranspiled(resendSource);
  const originalApiKey = process.env.RESEND_API_KEY;
  const originalFrom = process.env.RESEND_FROM;
  const originalFetch = globalThis.fetch;
  let providerRequests = 0;

  process.env.RESEND_API_KEY = "re_testkey123";
  process.env.RESEND_FROM = "Novalure <noreply@example.com>";
  globalThis.fetch = async () => {
    providerRequests += 1;
    return new Response(JSON.stringify({ id: "msg_test" }), {
      headers: { "content-type": "application/json" },
      status: 200,
    });
  };

  try {
    for (const purpose of ["newsletter", "meeting_notification", "meeting_qa_test", "bot_document", undefined]) {
      const result = await resend.sendNewsletterEmail({
        html: "<p>test</p>",
        purpose,
        subject: "Test",
        to: "recipient@example.com",
      });
      assert.equal(result.status, "failed");
      assert.equal(result.errorCode, "launch_off");
    }
    assert.equal(providerRequests, 0);

    const accountMail = await resend.sendNewsletterEmail({
      html: "<p>reset</p>",
      purpose: "password_reset",
      subject: "Reset",
      to: "recipient@example.com",
    });
    assert.equal(accountMail.status, "sent");
    assert.equal(providerRequests, 1);
    assert.equal(resend.isEmailDeliveryPurposeLaunchEnabled("workspace_invitation"), true);
    assert.equal(resend.isEmailDeliveryPurposeLaunchEnabled("unknown"), false);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv("RESEND_API_KEY", originalApiKey);
    restoreEnv("RESEND_FROM", originalFrom);
  }
});

test("bot provider adapter dynamically blocks email and Meta delivery before any provider request", async () => {
  const providerSource = (await source("src/lib/bots/provider-actions.ts"))
    .replace(
      'import { sendNewsletterEmail } from "@/lib/integrations/resend";',
      'let emailCalls = 0; async function sendNewsletterEmail() { emailCalls += 1; return { provider: "resend", status: "sent" }; } export function getTestEmailCalls() { return emailCalls; }',
    )
    .replace('import type { BotChannelAccountCredentials } from "@/lib/db/runtime-repositories";', "")
    .replace(
      'import { evaluateLaunchScope } from "@/lib/launch-scope";',
      "const evaluateLaunchScope = () => ({ allowed: false });",
    )
    .replace(
      'import { getBotRuntimeControls } from "@/lib/bots/policy";',
      "const getBotRuntimeControls = () => ({ killSwitch: false, requireHumanApproval: false, testMode: false });",
    );
  const provider = await importTranspiled(providerSource);
  const originalFetch = globalThis.fetch;
  let providerRequests = 0;
  globalThis.fetch = async () => {
    providerRequests += 1;
    throw new Error("provider must not be reached");
  };

  try {
    const document = await provider.sendBotDocument({
      channel: "WhatsApp",
      documentName: "Expose.pdf",
      documentUrl: "https://example.com/expose.pdf",
      idempotencyKey: "test-document",
      recipientEmail: "recipient@example.com",
      recipientPhone: "+43123456789",
    });
    const channelReply = await provider.sendBotChannelReply({
      channel: "Instagram",
      idempotencyKey: "test-reply",
      message: "Hello",
      recipientPhone: "recipient-id",
    });

    assert.equal(document.error, "bot_provider_delivery_launch_off");
    assert.equal(document.status, "failed");
    assert.equal(channelReply.error, "bot_provider_delivery_launch_off");
    assert.equal(channelReply.status, "blocked");
    assert.equal(provider.getTestEmailCalls(), 0);
    assert.equal(providerRequests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("request controls can only tighten bot environment safety controls", async () => {
  const policy = await importTranspiled(await source("src/lib/bots/policy.ts"));

  for (const input of [{ killSwitch: false }, {}, { killSwitch: true }]) {
    assert.equal(
      policy.getBotRuntimeControls(input, { NOVALURE_BOT_KILL_SWITCH: "true" }).killSwitch,
      true,
    );
  }
  assert.equal(
    policy.getBotRuntimeControls({ killSwitch: true }, { NOVALURE_BOT_KILL_SWITCH: "false" }).killSwitch,
    true,
  );
  assert.equal(
    policy.getBotRuntimeControls({}, {
      NOVALURE_BOT_KILL_SWITCH: "false",
      NOVALURE_BOT_NOT_AUS: "true",
    }).killSwitch,
    true,
  );

  for (const input of [{ testMode: false }, {}, { testMode: true }]) {
    assert.equal(
      policy.getBotRuntimeControls(input, { NOVALURE_BOT_TEST_MODE: "true" }).testMode,
      true,
    );
  }
  assert.equal(
    policy.getBotRuntimeControls({ testMode: true }, { NOVALURE_BOT_TEST_MODE: "false" }).testMode,
    true,
  );

  for (const input of [{ requireHumanApproval: false }, {}, { requireHumanApproval: true }]) {
    assert.equal(
      policy.getBotRuntimeControls(input, { NOVALURE_BOT_REQUIRE_HUMAN_APPROVAL: "true" }).requireHumanApproval,
      true,
    );
  }
  assert.equal(
    policy.getBotRuntimeControls(
      { requireHumanApproval: true },
      { NOVALURE_BOT_REQUIRE_HUMAN_APPROVAL: "false" },
    ).requireHumanApproval,
    true,
  );

  assert.equal(
    policy.getBotRuntimeControls({ strictKnowledge: false }, { NOVALURE_BOT_STRICT_KNOWLEDGE: "true" }).strictKnowledge,
    true,
  );
  assert.equal(
    policy.getBotRuntimeControls({ strictKnowledge: true }, { NOVALURE_BOT_STRICT_KNOWLEDGE: "false" }).strictKnowledge,
    true,
  );
  assert.equal(
    policy.getBotRuntimeControls({ strictKnowledge: false }, { NOVALURE_BOT_STRICT_KNOWLEDGE: "false" }).strictKnowledge,
    false,
  );
  assert.equal(policy.getBotRuntimeControls({ strictKnowledge: false }, {}).strictKnowledge, true);
});

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
  const launchGuard = route.indexOf('evaluateLaunchScope("customerCommunicationProviderMutation")');

  assert.ok(launchGuard >= 0);
  assert.ok(launchGuard < route.indexOf("requirePermission(request"));
  assert.ok(launchGuard < route.indexOf("request.json()"));
  assert.ok(launchGuard < route.indexOf("sendNewsletterEmail({"));
  assert.ok(launchGuard < route.indexOf("insertNewsletterSend({"));
  assert.match(route, /customer_communication_provider_launch_off/);

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
  const runnerGuard = runner.indexOf('evaluateLaunchScope("customerCommunicationProviderMutation")');

  assert.ok(runnerGuard >= 0);
  for (const effect of [
    "listDueMeetingNotificationJobs(limit)",
    "claimMeetingNotificationJob({",
    "sendNewsletterEmail({",
    "markMeetingNotificationJobSent({",
  ]) {
    assert.ok(runnerGuard < runner.indexOf(effect), `runner launch guard must precede ${effect}`);
  }

  assert.match(runner, /const MAX_NOTIFICATION_BATCH = 25/);
  assert.match(runner, /new Set\(input\.jobIds \?\? \[\]\)[\s\S]*slice\(0, MAX_NOTIFICATION_BATCH\)/);
  assert.match(runner, /Math\.max\(1, Math\.min\(MAX_NOTIFICATION_BATCH/);
  assert.match(runner, /if \(emailResult\.status !== "sent"\)/);
  assert.match(runner, /markMeetingNotificationJobFailed\([\s\S]*emailResult\.errorCode/);
  assert.match(repository, /attempt_count < max_attempts/);
  assert.match(repository, /attempt_count >= max_attempts then 'dead_letter'/);

  for (const start of [
    "async function queueMeetingNotificationJob",
    "export async function retryMeetingNotificationJob",
    "export async function claimMeetingNotificationJob",
    "export async function markMeetingNotificationJobSent",
  ]) {
    const startIndex = repository.indexOf(start);
    const section = repository.slice(startIndex, startIndex + 5_000);
    const guard = section.indexOf('evaluateLaunchScope("customerCommunicationProviderMutation")');
    assert.ok(guard >= 0, `${start} must enforce customer provider launch scope`);
    assert.ok(guard < section.indexOf("queryOne"), `${start} must fail before database mutation`);
  }
});

test("cron, retry, bot routes and autonomous bot delivery fail before queue or send state", async () => {
  const [cron, retry, botDocuments, botActions, botRuntime, botProvider, runtimeRepository] = await Promise.all([
    source("src/app/api/cron/meeting-reminders/route.ts"),
    source("src/app/api/meetings/notifications/[notificationId]/retry/route.ts"),
    source("src/app/api/bots/documents/route.ts"),
    source("src/app/api/bots/actions/route.ts"),
    source("src/lib/bots/chat-runtime.ts"),
    source("src/lib/bots/provider-actions.ts"),
    source("src/lib/db/runtime-repositories.ts"),
  ]);

  const cronGuard = cron.indexOf('evaluateLaunchScope("customerCommunicationProviderMutation")');
  assert.ok(cronGuard >= 0 && cronGuard < cron.indexOf("createCronRun({"));
  assert.ok(cronGuard < cron.indexOf("processDueMeetingNotifications({"));

  const retryGuard = retry.indexOf('evaluateLaunchScope("customerCommunicationProviderMutation")');
  assert.ok(retryGuard >= 0 && retryGuard < retry.indexOf("retryMeetingNotificationJob({"));
  assert.ok(retryGuard < retry.indexOf("processDueMeetingNotifications({"));

  const documentPost = botDocuments.slice(botDocuments.indexOf("export async function POST"));
  const documentGuard = documentPost.indexOf('evaluateLaunchScope("customerCommunicationProviderMutation")');
  assert.ok(documentGuard >= 0 && documentGuard < documentPost.indexOf("requirePermission(request"));
  assert.ok(documentGuard < documentPost.indexOf("insertBotDocumentSend({"));
  assert.ok(documentGuard < documentPost.indexOf("sendBotDocument({"));

  const markSent = botActions.slice(botActions.indexOf('if (type === "document_send" && action === "mark_sent")'));
  const actionGuard = markSent.indexOf('evaluateLaunchScope("customerCommunicationProviderMutation")');
  assert.ok(actionGuard >= 0 && actionGuard < markSent.indexOf("queryOne<BotDocumentSendRow>"));
  assert.ok(actionGuard < markSent.indexOf("sendBotDocument({"));
  assert.doesNotMatch(botActions, /manualActionControls|requireHumanApproval:\s*false/);

  const recordDelivery = botRuntime.slice(botRuntime.indexOf("async function recordDocumentDelivery"));
  const runtimeGuard = recordDelivery.indexOf('evaluateLaunchScope("customerCommunicationProviderMutation")');
  assert.ok(runtimeGuard >= 0 && runtimeGuard < recordDelivery.indexOf("insertBotDocumentSend({"));
  assert.ok(runtimeGuard < recordDelivery.indexOf("sendBotDocument({"));

  for (const start of ["export async function sendBotDocument", "export async function sendBotChannelReply"]) {
    const section = botProvider.slice(botProvider.indexOf(start));
    const guard = section.indexOf('evaluateLaunchScope("customerCommunicationProviderMutation")');
    const firstProviderEffect = ["sendNewsletterEmail({", "sendWhatsApp", "sendMetaMessagingText", "fetch("]
      .map((marker) => section.indexOf(marker))
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)[0];
    assert.ok(guard >= 0 && guard < firstProviderEffect, `${start} must guard before provider effects`);
    assert.match(section, /getBotRuntimeControls\(\)/);
  }

  for (const start of ["export async function insertBotDocumentSend", "export async function updateBotDocumentSendDelivery"]) {
    const section = runtimeRepository.slice(runtimeRepository.indexOf(start), runtimeRepository.indexOf("export async function", runtimeRepository.indexOf(start) + start.length));
    const guard = section.indexOf('evaluateLaunchScope("customerCommunicationProviderMutation")');
    assert.ok(guard >= 0 && guard < section.indexOf("canPersist()"), `${start} must guard queued/sent state before DB access`);
    assert.ok(guard < section.indexOf("queryOne<IdRow>"), `${start} must guard before DB mutation`);
  }

  const newsletterLedger = runtimeRepository.slice(runtimeRepository.indexOf("export async function insertNewsletterSend"));
  assert.match(newsletterLedger, /deliveryPurpose: "bot_document" \| "meeting_qa_test" \| "newsletter"/);
  assert.ok(newsletterLedger.indexOf('evaluateLaunchScope("newsletterDelivery")') < newsletterLedger.indexOf("canPersist()"));
  assert.ok(newsletterLedger.indexOf('evaluateLaunchScope("customerCommunicationProviderMutation")') < newsletterLedger.indexOf("canPersist()"));

  assert.match(botDocuments, /insertNewsletterSend\([\s\S]*deliveryPurpose: "bot_document"/);
  assert.match(botActions, /insertNewsletterSend\([\s\S]*deliveryPurpose: "bot_document"/);
  assert.match(botRuntime, /insertNewsletterSend\([\s\S]*deliveryPurpose: "bot_document"/);
});

test("all operational sendNewsletterEmail callers declare purpose and treat failed delivery compatibly", async () => {
  const [bot, passwordReset, customerAccess, settingsAccess, newsletter, meetingRunner, meetingQa] = await Promise.all([
    source("src/lib/bots/provider-actions.ts"),
    source("src/lib/auth/password-reset.ts"),
    source("src/lib/db/customer-access-repositories.ts"),
    source("src/lib/db/settings-access-repositories.ts"),
    source("src/app/api/newsletter/send/route.ts"),
    source("src/lib/meetings/notification-runner.ts"),
    source("src/app/api/meetings/notifications/route.ts"),
  ]);

  assert.match(bot, /sendNewsletterEmail\([\s\S]*purpose: "bot_document"/);
  assert.match(bot, /sendNewsletterEmail\([\s\S]*result\.status === "failed" \? "failed"/);
  assert.match(passwordReset, /sendNewsletterEmail\([\s\S]*purpose: "password_reset"/);
  assert.match(passwordReset, /sendNewsletterEmail\([\s\S]*delivery\.status === "failed" \? "failure"/);
  assert.match(customerAccess, /sendNewsletterEmail\([\s\S]*purpose: "workspace_invitation"/);
  assert.match(customerAccess, /sendNewsletterEmail\([\s\S]*delivery\.status === "failed" \? "failure"/);
  assert.match(settingsAccess, /sendNewsletterEmail\([\s\S]*purpose: "password_reset"/);
  assert.match(settingsAccess, /sendNewsletterEmail\([\s\S]*delivery\.status === "failed" \? "failure"/);
  assert.match(newsletter, /sendNewsletterEmail\([\s\S]*purpose: "newsletter"/);
  assert.match(newsletter, /const hasFailedSend = sends\.some\(\(send\) => send\.status === "failed"\)/);
  assert.match(newsletter, /status: hasFailedSend \? 502 : 200/);
  assert.match(meetingRunner, /sendNewsletterEmail\([\s\S]*purpose: "meeting_notification"/);
  assert.match(meetingQa, /sendNewsletterEmail\([\s\S]*purpose: "meeting_qa_test"/);
});
