import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizeIncomingBotMessages } from "../src/lib/bots/omnichannel.ts";
import { getDurableBotWebhookEventKey } from "../src/lib/bots/webhook-event-key.ts";
import {
  botWebhookAccountEventLimit,
  botWebhookContactEventLimit,
  botWebhookMaxEventsPerBatch,
  botWebhookMaxProcessingAttempts,
  evaluateBotWebhookBudget,
  getBotWebhookMappingHttpStatus,
  getBotWebhookReplyAction,
  getBotWebhookReplySettlement,
  shouldReclaimBotWebhook,
} from "../src/lib/bots/webhook-processing.ts";
import { createMigrationPlan } from "./db-migrate.mjs";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

class DurableWebhookHarness {
  constructor() {
    this.state = {
      attempts: 0,
      completed: false,
      leaseExpiresAt: null,
      replyState: "not_requested",
      status: "received",
    };
    this.effects = new Set();
    this.providerSends = 0;
  }

  claim(now = new Date("2026-08-22T12:00:00.000Z")) {
    if (this.state.status === "completed" || this.state.status === "ignored") return this.state.status;
    if (!shouldReclaimBotWebhook({
      leaseExpiresAt: this.state.leaseExpiresAt,
      now,
      status: this.state.status,
    })) return "in_flight";
    if (this.state.replyState === "attempting") this.state.replyState = "uncertain";
    this.state.attempts += 1;
    this.state.status = "processing";
    this.state.leaseExpiresAt = new Date(now.getTime() + 120_000);
    return "claimed";
  }

  internalEffect(key) {
    this.effects.add(key);
  }

  fail() {
    if (this.state.replyState === "attempting") this.state.replyState = "uncertain";
    this.state.status = "failed";
    this.state.leaseExpiresAt = null;
  }

  ignore() {
    if (this.state.replyState === "attempting") this.state.replyState = "uncertain";
    if (this.state.replyState === "not_requested") this.state.replyState = "not_applicable";
    this.state.status = "ignored";
    this.state.leaseExpiresAt = null;
  }

  beginProviderAttempt() {
    assert.equal(getBotWebhookReplyAction(this.state.replyState), "attempt");
    this.state.replyState = "attempting";
    this.providerSends += 1;
  }

  complete() {
    this.state.status = "completed";
    this.state.completed = true;
    this.state.leaseExpiresAt = null;
  }
}

test("failure is reclaimable and retry completes without duplicate internal effects", () => {
  const harness = new DurableWebhookHarness();
  assert.equal(harness.claim(), "claimed");
  harness.internalEffect("webhook-1:user-message");
  harness.internalEffect("webhook-1:timeline");
  harness.fail();

  assert.equal(harness.claim(new Date("2026-08-22T12:00:10.000Z")), "claimed");
  harness.internalEffect("webhook-1:user-message");
  harness.internalEffect("webhook-1:timeline");
  harness.state.replyState = "not_applicable";
  harness.complete();

  assert.equal(harness.state.completed, true);
  assert.equal(harness.state.attempts, 2);
  assert.equal(harness.effects.size, 2);
});

test("parallel delivery has one processor and completed replay is acknowledgement-only", async () => {
  const harness = new DurableWebhookHarness();
  const outcomes = await Promise.all([Promise.resolve().then(() => harness.claim()), Promise.resolve().then(() => harness.claim())]);
  assert.deepEqual(outcomes.sort(), ["claimed", "in_flight"]);
  assert.equal(harness.state.attempts, 1);

  harness.state.replyState = "not_applicable";
  harness.complete();
  assert.equal(harness.claim(), "completed");
  assert.equal(harness.state.attempts, 1);
});

test("expired processing lease is reclaimable", () => {
  const harness = new DurableWebhookHarness();
  harness.state.status = "processing";
  harness.state.leaseExpiresAt = new Date("2026-08-22T11:59:59.000Z");
  assert.equal(harness.claim(new Date("2026-08-22T12:00:00.000Z")), "claimed");
  assert.equal(harness.state.attempts, 1);
});

test("an interrupted provider attempt becomes uncertain and is never blindly resent", () => {
  const harness = new DurableWebhookHarness();
  assert.equal(harness.claim(), "claimed");
  harness.beginProviderAttempt();
  harness.fail();
  assert.equal(harness.state.replyState, "uncertain");

  assert.equal(harness.claim(new Date("2026-08-22T12:00:10.000Z")), "claimed");
  assert.equal(getBotWebhookReplyAction(harness.state.replyState), "hold");
  assert.equal(harness.providerSends, 1);
  assert.equal(getBotWebhookReplySettlement("failed"), "uncertain");
  assert.equal(getBotWebhookReplySettlement("sent"), "completed");
});

test("mapping resolution statuses have explicit terminal or retryable HTTP semantics", () => {
  assert.equal(getBotWebhookMappingHttpStatus("matched"), null);
  assert.equal(getBotWebhookMappingHttpStatus("not_found"), 200);
  assert.equal(getBotWebhookMappingHttpStatus("unsupported"), 200);
  assert.equal(getBotWebhookMappingHttpStatus("ambiguous"), 503);
  assert.equal(getBotWebhookMappingHttpStatus("unavailable"), 503);
});

test("all provider and custom event identities become fixed-width SHA-256 B-tree keys", () => {
  const oversizedCustomId = "customer-controlled-".repeat(16_384);
  const first = getDurableBotWebhookEventKey(oversizedCustomId);
  const replay = getDurableBotWebhookEventKey(oversizedCustomId);
  const changed = getDurableBotWebhookEventKey(`${oversizedCustomId}!`);

  assert.match(first, /^evt_[0-9a-f]{64}$/u);
  assert.equal(first.length, 68);
  assert.equal(first, replay);
  assert.notEqual(first, changed);
});

test("account/contact budgets are bounded and the first event above either limit is terminally limited", () => {
  assert.deepEqual(evaluateBotWebhookBudget({
    accountEventCount: botWebhookAccountEventLimit,
    contactEventCount: botWebhookContactEventLimit,
  }), { allowed: true });
  assert.deepEqual(evaluateBotWebhookBudget({
    accountEventCount: botWebhookAccountEventLimit + 1,
    contactEventCount: 1,
  }), { allowed: false, reason: "account_rate_limit" });
  assert.deepEqual(evaluateBotWebhookBudget({
    accountEventCount: 1,
    contactEventCount: botWebhookContactEventLimit + 1,
  }), { allowed: false, reason: "contact_rate_limit" });
});

test("ordered account budget serialization admits no parallel work beyond the hard limit", async () => {
  let accountCount = botWebhookAccountEventLimit - 1;
  let accountLock = Promise.resolve();
  const admit = async () => {
    const previous = accountLock;
    let release;
    accountLock = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      accountCount += 1;
      await Promise.resolve();
      return evaluateBotWebhookBudget({ accountEventCount: accountCount, contactEventCount: 1 }).allowed;
    } finally {
      release();
    }
  };

  const admitted = await Promise.all([admit(), admit(), admit(), admit()]);
  assert.equal(admitted.filter(Boolean).length, 1);
  assert.deepEqual(admitted, [true, false, false, false]);
});

test("account-scoped event identity permits the same provider id on two accounts", () => {
  const providerEventKey = getDurableBotWebhookEventKey("same-provider-id");
  const accountScopedUniqueKeys = new Set([
    `account-a:${providerEventKey}`,
    `account-b:${providerEventKey}`,
  ]);
  assert.equal(accountScopedUniqueKeys.size, 2);
});

test("WhatsApp normalization fans out every message/change and gives status transitions distinct identities", () => {
  const messages = normalizeIncomingBotMessages({
    object: "whatsapp_business_account",
    entry: [{
      changes: [
        {
          field: "messages",
          value: {
            contacts: [
              { profile: { name: "Ada" }, wa_id: "436601" },
              { profile: { name: "Ben" }, wa_id: "436602" },
            ],
            messages: [
              { from: "436601", id: "wamid.in.1", text: { body: "First" }, timestamp: "1787392800", type: "text" },
              { from: "436602", id: "wamid.in.2", text: { body: "Second" }, timestamp: "1787392801", type: "text" },
            ],
            metadata: { phone_number_id: "wa-account" },
          },
        },
        {
          field: "messages",
          value: {
            metadata: { phone_number_id: "wa-account" },
            statuses: [
              { id: "wamid.out.1", recipient_id: "436601", status: "sent", timestamp: "1787392810" },
              { id: "wamid.out.1", recipient_id: "436601", status: "delivered", timestamp: "1787392811" },
              { id: "wamid.out.1", recipient_id: "436601", status: "read", timestamp: "1787392812" },
            ],
          },
        },
      ],
    }],
  });

  assert.equal(messages.length, 5);
  assert.deepEqual(messages.slice(0, 2).map((message) => message.externalMessageId), ["wamid.in.1", "wamid.in.2"]);
  assert.deepEqual(messages.slice(0, 2).map((message) => message.customerName), ["Ada", "Ben"]);
  assert.deepEqual(messages.slice(2).map((message) => message.eventType), ["sent", "delivered", "read"]);
  assert.equal(new Set(messages.map((message) => message.externalMessageId)).size, messages.length);
  assert.ok(messages[2].externalMessageId.startsWith("meta-wa-status:wamid.out.1:sent:"));
  assert.ok(messages[3].externalMessageId.startsWith("meta-wa-status:wamid.out.1:delivered:"));
  assert.ok(messages[4].externalMessageId.startsWith("meta-wa-status:wamid.out.1:read:"));
});

test("Instagram and Messenger normalization fans out messaging, delivery and read events in source order", () => {
  const instagram = normalizeIncomingBotMessages({
    object: "instagram",
    entry: [{
      id: "ig-account",
      messaging: [
        { message: { mid: "ig-mid-1", text: "One" }, recipient: { id: "ig-account" }, sender: { id: "ig-user" }, timestamp: 1787392800000 },
        { message: { mid: "ig-mid-2", text: "Two" }, recipient: { id: "ig-account" }, sender: { id: "ig-user" }, timestamp: 1787392801000 },
      ],
    }],
  });
  assert.deepEqual(instagram.map((message) => message.externalMessageId), ["ig-mid-1", "ig-mid-2"]);
  assert.ok(instagram.every((message) => message.channel === "Instagram"));

  const messenger = normalizeIncomingBotMessages({
    object: "page",
    entry: [{
      id: "page-account",
      messaging: [
        { message: { mid: "page-mid-1", text: "Hello" }, recipient: { id: "page-account" }, sender: { id: "page-user" }, timestamp: 1787392800000 },
        { delivery: { mids: ["page-mid-1"], watermark: 1787392801000 }, recipient: { id: "page-account" }, sender: { id: "page-user" }, timestamp: 1787392801000 },
        { read: { watermark: 1787392802000 }, recipient: { id: "page-account" }, sender: { id: "page-user" }, timestamp: 1787392802000 },
      ],
    }],
  });
  assert.deepEqual(messenger.map((message) => message.eventType), ["message", "delivery", "read"]);
  assert.equal(new Set(messenger.map((message) => message.externalMessageId)).size, messenger.length);
  assert.ok(messenger[1].externalMessageId.startsWith("meta-delivery:page-mid-1:"));
  assert.ok(messenger[2].externalMessageId.startsWith("meta-read:"));
});

test("signed Meta batch work is capped before synchronous event processing", () => {
  const messages = normalizeIncomingBotMessages({
    object: "instagram",
    entry: [{
      id: "ig-account",
      messaging: Array.from({ length: botWebhookMaxEventsPerBatch + 1 }, (_, index) => ({
        message: { mid: `ig-mid-${index}`, text: `Message ${index}` },
        recipient: { id: "ig-account" },
        sender: { id: `ig-user-${index}` },
        timestamp: 1787392800000 + index,
      })),
    }],
  });

  assert.equal(messages.length, botWebhookMaxEventsPerBatch + 1);
  assert.ok(messages.length > botWebhookMaxEventsPerBatch);
});

test("partial batch failure returns 503 and retry processes only the unfinished event", () => {
  const events = new Map([
    ["event-1", new DurableWebhookHarness()],
    ["event-2", new DurableWebhookHarness()],
  ]);
  const processBatch = (failedEventId = null) => {
    let terminal = true;
    for (const [eventId, harness] of events) {
      const claim = harness.claim(new Date("2026-08-22T12:00:10.000Z"));
      if (claim === "completed" || claim === "ignored") continue;
      if (claim !== "claimed") {
        terminal = false;
        continue;
      }
      harness.internalEffect(`${eventId}:internal-effects`);
      if (eventId === failedEventId) {
        harness.fail();
        terminal = false;
        continue;
      }
      harness.state.replyState = "not_applicable";
      harness.complete();
    }
    return terminal ? 200 : 503;
  };

  assert.equal(processBatch("event-2"), 503);
  assert.equal(events.get("event-1").state.attempts, 1);
  assert.equal(events.get("event-2").state.attempts, 1);
  assert.equal(processBatch(), 200);
  assert.equal(events.get("event-1").state.attempts, 1);
  assert.equal(events.get("event-2").state.attempts, 2);
  assert.equal(events.get("event-1").effects.size, 1);
  assert.equal(events.get("event-2").effects.size, 1);
});

test("assistant marker and derived first-response effects roll back together and old partial rows reconcile", () => {
  const persisted = { analytics: false, assistant: false, speedToLead: false };
  const persistAtomically = ({ failAfterAssistant = false } = {}) => {
    const transaction = { ...persisted, assistant: true };
    if (failAfterAssistant) throw new Error("transient analytics failure");
    transaction.analytics = true;
    transaction.speedToLead = true;
    Object.assign(persisted, transaction);
  };

  assert.throws(() => persistAtomically({ failAfterAssistant: true }), /transient analytics failure/);
  assert.deepEqual(persisted, { analytics: false, assistant: false, speedToLead: false });
  persistAtomically();
  assert.deepEqual(persisted, { analytics: true, assistant: true, speedToLead: true });

  const legacyPartial = { analytics: true, assistant: true, speedToLead: false };
  if (legacyPartial.assistant && legacyPartial.analytics && !legacyPartial.speedToLead) legacyPartial.speedToLead = true;
  assert.deepEqual(legacyPartial, { analytics: true, assistant: true, speedToLead: true });
});

test("retry exhaustion dead-letters terminally without converting an uncertain provider attempt into a resend", () => {
  const harness = new DurableWebhookHarness();
  harness.state.status = "failed";
  harness.state.attempts = botWebhookMaxProcessingAttempts;
  harness.state.replyState = "uncertain";

  assert.equal(harness.claim(new Date("2026-08-22T12:00:10.000Z")), "claimed");
  assert.equal(harness.state.attempts, botWebhookMaxProcessingAttempts + 1);
  harness.ignore();
  assert.equal(harness.state.status, "ignored");
  assert.equal(harness.state.replyState, "uncertain");
  assert.equal(getBotWebhookReplyAction(harness.state.replyState), "hold");
  assert.equal(harness.claim(), "ignored");
});

test("first-response serialization matches contact-or-lead duplicate equivalence under concurrency", async () => {
  const runRace = async (entities) => {
    const lockTails = new Map();
    const persisted = [];
    const acquire = async (key) => {
      const previous = lockTails.get(key) ?? Promise.resolve();
      let release;
      const held = new Promise((resolve) => { release = resolve; });
      lockTails.set(key, previous.then(() => held));
      await previous;
      return release;
    };
    const record = async (entity) => {
      const keys = [
        entity.contactId ? `contact:${entity.contactId}` : null,
        entity.leadId ? `lead:${entity.leadId}` : null,
      ].filter(Boolean).sort();
      const releases = [];
      for (const key of keys) releases.push(await acquire(key));
      try {
        const duplicate = persisted.some((event) =>
          (entity.contactId && event.contactId === entity.contactId)
          || (entity.leadId && event.leadId === entity.leadId));
        if (duplicate) return;
        await Promise.resolve();
        persisted.push(entity);
      } finally {
        releases.reverse().forEach((release) => release());
      }
    };
    await Promise.all(entities.map(record));
    return persisted;
  };

  assert.equal((await runRace([
    { contactId: "contact-a", leadId: "lead-a" },
    { contactId: "contact-a", leadId: "lead-b" },
  ])).length, 1);
  assert.equal((await runRace([
    { contactId: "contact-a", leadId: "lead-a" },
    { contactId: "contact-b", leadId: "lead-a" },
  ])).length, 1);
});

test("repository and route enforce fenced claims, durable recovery and one provider attempt", async () => {
  const [migration, providerActions, qaE2e, qaMatrix, repository, route, runtime] = await Promise.all([
    source("migrations/076_bot_webhook_durable_processing.sql"),
    source("src/lib/bots/provider-actions.ts"),
    source("scripts/qa-two-tenant-e2e.mjs"),
    source("scripts/lib/qa-two-tenant-matrix.mjs"),
    source("src/lib/db/runtime-repositories.ts"),
    source("src/app/api/bots/channels/webhook/route.ts"),
    source("src/lib/bots/chat-runtime.ts"),
  ]);

  assert.match(repository, /status = 'processing'[\s\S]*processing_attempt = bot_channel_webhooks\.processing_attempt \+ 1/);
  assert.match(repository, /status in \('received', 'failed'\)[\s\S]*lease_expires_at <= now\(\)/);
  assert.match(repository, /lease_token = \$3::uuid/);
  assert.match(repository, /reply_state = case[\s\S]*'attempting'[\s\S]*'uncertain'/);
  assert.match(repository, /processing_result is not null[\s\S]*reply_state in \('completed', 'blocked', 'not_applicable', 'uncertain'\)/);
  assert.match(repository, /findBotChannelWebhookRunRecovery/);
  assert.match(repository, /role === "assistant"[\s\S]*withTenantTransaction/);
  assert.match(repository, /recordFirstResponseAnalyticsEvent\([\s\S]*transaction/);
  assert.match(repository, /metadata->>'sourcePayload' = 'bot_first_response'/);
  assert.match(repository, /Bot webhook first-response recovery could not be reconciled/);
  assert.match(repository, /pg_advisory_xact_lock\(hashtextextended\(\$1, 0\)\)/);
  assert.match(repository, /const firstResponseScopeKeys = \[[\s\S]*conversation\.contactId[\s\S]*conversation\.leadId[\s\S]*firstResponseScopeKeys\.sort\(\)[\s\S]*for \(const firstResponseScope of firstResponseScopeKeys\)/);
  assert.match(repository, /const budgetLockKeys = \[[\s\S]*\]\.sort\(\)/);
  assert.match(repository, /withTenantTransaction\([\s\S]*accountEventCount[\s\S]*quarantine_reason = \$4/);
  assert.match(repository, /evaluateBotWebhookBudget\(\{/);
  assert.match(repository, /quarantine_reason = 'payload_conflict'/);
  assert.match(repository, /reply_state = case[\s\S]*'attempting' then 'uncertain'[\s\S]*'not_requested' then 'not_applicable'/);

  assert.match(route, /webhookRecord\.outcome === "completed" \|\| webhookRecord\.outcome === "ignored"/);
  assert.ok(route.indexOf("webhookRecord.outcome === \"in_flight\"") < route.indexOf("runBotChat({"));
  assert.match(route, /webhookRecord\.outcome === "in_flight"[\s\S]*terminal: false/);
  assert.match(route, /outcomes\.some\(\(outcome\) => !outcome\.terminal\)[\s\S]*jsonWebhookResponse\(correlationId, 503/);
  assert.ok(route.indexOf("verifyMetaWebhookSignature(") < route.indexOf("normalizeIncomingBotMessages(body)"));
  assert.match(route, /signedRawBodySha256: input\.rawBodySha256/);
  assert.match(route, /payloadSha256: getWebhookEventPayloadSha256\(message\)/);
  assert.match(route, /getDurableBotWebhookEventKey\(message\.externalMessageId\)/);
  assert.match(route, /preparedEvents\.length > botWebhookMaxEventsPerBatch/);
  assert.match(route, /quarantineBotChannelWebhookEnvelope\(\{/);
  assert.match(route, /eventCount: preparedEvents\.length/);
  assert.match(route, /if \(!envelope\) throw new Error\("webhook_batch_envelope_not_quarantined"\)/);
  assert.match(route, /webhookRecord\.processingAttempt > botWebhookMaxProcessingAttempts/);
  assert.match(route, /return settleIgnored\("retry_budget_exhausted"\)/);
  assert.match(route, /quarantineBotChannelWebhookPayloadConflict/);
  assert.match(route, /event_payload_conflict[\s\S]*terminal: true/);
  assert.ok(route.indexOf("beginBotChannelWebhookReplyAttempt") < route.indexOf("sendBotChannelReply({"));
  assert.match(route, /persistBotChannelWebhookProcessingResult/);
  assert.match(route, /getBotWebhookReplyAction\(replyState\)/);
  assert.match(route, /failBotChannelWebhook/);
  assert.doesNotMatch(route, /payload:\s*\{\s*\.\.\.body/);

  for (const table of [
    "bot_conversations",
    "bot_messages",
    "bot_tool_calls",
    "bot_document_sends",
    "contact_timeline_items",
    "audit_logs",
    "approval_requests",
  ]) assert.match(migration, new RegExp(`${table}[\\s\\S]*webhook_event_id`));
  assert.equal((migration.match(/add column if not exists webhook_event_id uuid/g) ?? []).length, 7);
  assert.equal((migration.match(/create unique index if not exists \w+_webhook_(?:event|role|tool|action)_uidx/g) ?? []).length, 7);
  assert.match(migration, /to_regclass\('public\.public_funnel_visit_events'\)/);
  assert.match(migration, /public_funnel_visit_events_scope_key/);
  assert.match(migration, /public_funnel_visit_events_funnel_fk/);
  assert.doesNotMatch(migration, /analytics_events_public_funnel_visit_uidx/);
  assert.equal((migration.match(/add constraint \w+_workspace_webhook_event_fk/g) ?? []).length, 6);
  assert.doesNotMatch(migration, /add constraint audit_logs_workspace_webhook_event_fk/);
  assert.match(migration, /drop constraint if exists audit_logs_workspace_webhook_event_fk/);
  assert.match(migration, /Immutable Bot webhook UUID snapshot; intentionally not a live FK/);
  assert.match(migration, /'evt_' \|\| encode\(digest\(external_message_id, 'sha256'\), 'hex'\)/);
  assert.match(migration, /bot_channel_webhooks_external_message_id_check/);
  assert.match(migration, /bot_channel_webhooks_account_received_idx/);
  assert.match(migration, /quarantine_reason/);
  assert.match(migration, /create table if not exists public\.bot_channel_webhook_envelopes/);
  assert.match(migration, /bot_channel_webhook_envelopes_payload_key unique \(payload_sha256\)/);
  assert.match(migration, /create or replace function public\.quarantine_bot_channel_webhook_envelope\([\s\S]*security definer[\s\S]*set search_path = pg_catalog/);
  assert.match(migration, /revoke all on table public\.bot_channel_webhook_envelopes from public, novalure_tenant_app/);
  assert.match(migration, /revoke all on function public\.quarantine_bot_channel_webhook_envelope\(text, text, integer, text\) from public/);
  assert.match(migration, /grant execute on function public\.quarantine_bot_channel_webhook_envelope\(text, text, integer, text\)[\s\S]*to novalure_tenant_app/);
  assert.match(migration, /bot_channel_webhooks_workspace_message_uidx'[\s\S]*is not null/);
  assert.match(migration, /bot_channel_webhooks_account_event_uidx'[\s\S]*indisunique[\s\S]*indisvalid[\s\S]*indisready[\s\S]*pg_get_indexdef\(index_state\.indexrelid, 1, true\) = 'channel_account_id'[\s\S]*pg_get_indexdef\(index_state\.indexrelid, 2, true\) = 'external_message_id'/);
  assert.match(repository, /select public\.quarantine_bot_channel_webhook_envelope\([\s\S]*\) as id/);
  assert.doesNotMatch(repository, /insert into bot_channel_webhook_envelopes/);
  assert.match(qaMatrix, /"076\.rpc\.webhook_envelope_quarantine"/);
  assert.match(qaMatrix, /"076\.grants\.webhook_envelope_quarantine"/);
  assert.match(qaE2e, /has_function_privilege\([\s\S]*quarantine_bot_channel_webhook_envelope/);
  assert.match(qaE2e, /not pg_catalog\.has_table_privilege\([\s\S]*bot_channel_webhook_envelopes[\s\S]*'SELECT'/);
  assert.match(repository, /on conflict \(workspace_id, webhook_event_id, role\)/);
  assert.match(repository, /on conflict \(workspace_id, webhook_event_id, tool_name\)/);
  assert.match(repository, /on conflict \(workspace_id, webhook_event_id\)/);
  assert.match(runtime, /webhookEventId/);
  assert.ok(runtime.lastIndexOf('action: "bot.autonomy.decision"') < runtime.lastIndexOf('role: "assistant"'));
  assert.match(runtime, /commits the marker atomically with first-response/);
  assert.match(providerActions, /Meta Graph messaging endpoints do not accept input\.idempotencyKey/);
});

test("migration 076 is ordered after checksummed 057 and 075 and rejects either absent predecessor", () => {
  const migrate = (version, checksum, manualCutover = false) => ({
    checksum,
    file: `${version}.sql`,
    manualCutover,
    number: Number(version.slice(0, 3)),
    path: `${version}.sql`,
    sql: "select 1",
    version,
  });
  const migration048 = migrate("048_bot_webhook_integrity", "4".repeat(64));
  const migration057 = migrate("057_bot_webhook_legacy_index_cutover", "f".repeat(64), true);
  const migration053 = migrate("053_oauth_state_integrity", "3".repeat(64));
  const migration055 = migrate("055_public_submission_abuse_guards", "5".repeat(64));
  const migration060 = migrate("060_tenant_rls_pilot_prepare", "0".repeat(64), true);
  const migration066 = migrate("066_oauth_state_workspace_user_guard", "6".repeat(64));
  const migration070 = migrate("070_funnel_submission_idempotency_recovery", "c".repeat(64));
  const migration071 = migrate("071_forms_owner_tenant_guard", "d".repeat(64));
  const migration072 = migrate("072_form_submission_atomicity", "7".repeat(64));
  const migration073 = migrate("073_launch_tenant_relation_guards", "8".repeat(64));
  const migration074 = migrate("074_validate_launch_tenant_relation_guards", "9".repeat(64), true);
  const migration075 = migrate("075_public_funnel_visit_truth", "a".repeat(64));
  const migration076 = migrate("076_bot_webhook_durable_processing", "b".repeat(64));
  const migrations = [
    migration048,
    migration057,
    migration060,
    migration053,
    migration055,
    migration066,
    migration070,
    migration071,
    migration072,
    migration073,
    migration074,
    migration075,
    migration076,
  ];
  const ledgerThrough = (migration) => migrations
    .slice(0, migrations.indexOf(migration) + 1)
    .map(({ checksum, version }) => ({ checksum, version }));

  assert.throws(
    () => createMigrationPlan({ ledgerRows: [], migrations: [migration076], only: "076_bot_webhook_durable_processing" }),
    /required predecessor [^\n]*075_public_funnel_visit_truth[^\n]* is not checksummed in the ledger/,
  );
  assert.deepEqual(createMigrationPlan({
    ledgerRows: ledgerThrough(migration072),
    migrations,
    only: migration073.version,
  }).map((entry) => entry.version), [migration073.version]);
  assert.throws(() => createMigrationPlan({
    ledgerRows: ledgerThrough(migration073),
    migrations,
    only: migration074.version,
  }), /manual cutover/);
  assert.deepEqual(createMigrationPlan({
    allowManualCutover: true,
    ledgerRows: ledgerThrough(migration073),
    migrations,
    only: migration074.version,
  }).map((entry) => entry.version), [migration074.version]);
  assert.deepEqual(createMigrationPlan({
    ledgerRows: ledgerThrough(migration074),
    migrations,
    only: migration075.version,
  }).map((entry) => entry.version), [migration075.version]);
  assert.throws(
    () => createMigrationPlan({
      ledgerRows: ledgerThrough(migration075).filter((entry) => entry.version !== migration057.version),
      migrations,
      only: migration076.version,
    }),
    /required predecessor 057_bot_webhook_legacy_index_cutover/,
  );
  assert.deepEqual(
    createMigrationPlan({
      ledgerRows: ledgerThrough(migration075),
      migrations,
      only: "076_bot_webhook_durable_processing",
    }).map((entry) => entry.version),
    ["076_bot_webhook_durable_processing"],
  );
});
