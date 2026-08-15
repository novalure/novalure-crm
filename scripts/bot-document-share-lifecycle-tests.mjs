import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [actionsRoute, documentsRoute, chatRuntime, mediaStore] = await Promise.all([
  readFile(new URL("../src/app/api/bots/actions/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/app/api/bots/documents/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/lib/bots/chat-runtime.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/lib/media-store.ts", import.meta.url), "utf8"),
]);

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("final bot policy and consent decisions happen before a delivery share is published", () => {
  const manualSend = section(
    actionsRoute,
    'if (type === "document_send" && action === "mark_sent")',
    'if (type === "meeting_booking"',
  );
  assert.ok(manualSend.indexOf("evaluateBotAction({") < manualSend.indexOf("publishWorkspaceMedia("));
  assert.ok(manualSend.indexOf("evaluateOutboundConsent({") < manualSend.indexOf("publishWorkspaceMedia("));

  const apiSend = documentsRoute.slice(documentsRoute.indexOf("export async function POST"));
  assert.ok(apiSend.indexOf("evaluateBotAction({") < apiSend.indexOf("publishWorkspaceMedia("));
  assert.ok(apiSend.indexOf("evaluateOutboundConsent({") < apiSend.indexOf("publishWorkspaceMedia("));

  const chatPolicy = section(chatRuntime, "const documentDecision = wantsDocument", "if (documentDecision) policyDecisions.push");
  assert.doesNotMatch(chatPolicy, /publishWorkspaceMedia\(/);
  const chatDelivery = section(chatRuntime, "async function recordDocumentDelivery", "export async function runBotChat");
  assert.match(chatDelivery, /claimDocumentDeliveryAttempt\([\s\S]*publishWorkspaceMedia\(/);
});

test("all delivery entry points use an atomic sent/in-flight claim and attempt-bound finalization", () => {
  for (const source of [actionsRoute, documentsRoute, chatRuntime]) {
    assert.match(source, /set status = 'sending',[\s\S]*status not in \('sent', 'sending'\)/);
    assert.match(source, /coalesce\(metadata->>'deliveryAttemptState', ''\) <> 'in_flight'/);
    assert.match(source, /status = 'sending'[\s\S]*metadata->>'deliveryAttemptId' = \$3/);
    assert.match(source, /idempotencyKey: `bot-document-send:\$\{[^}]+\}`/);
    assert.doesNotMatch(source, /idempotencyKey:[^\n]*deliveryAttemptId/);
  }

  assert.match(actionsRoute, /existingDocumentSend\.status === "sent"[\s\S]*replay: true/);
  assert.match(actionsRoute, /existingDocumentSend\.status === "sending"[\s\S]*already in flight/);
});

test("share identity, short expiry, and attempt state are persisted without token leakage", () => {
  assert.match(mediaStore, /botDocumentAttemptShareTtlSeconds = 5 \* 60/);
  assert.match(mediaStore, /botDocumentMediaShareTtlSeconds = 24 \* 60 \* 60/);
  assert.match(mediaStore, /Math\.max\(5 \* 60, Math\.min\(7 \* 24 \* 60 \* 60/);
  assert.match(mediaStore, /returning asset_id, expires_at as "expiresAt", id as "publicShareId"/);

  for (const source of [actionsRoute, documentsRoute, chatRuntime]) {
    assert.match(source, /publicShareExpiresAt: .*\.publicShareExpiresAt/);
    assert.match(source, /publicShareId: .*\.publicShareId/);
    assert.match(source, /deliveryAttemptState: "in_flight"/);
    assert.match(source, /deliveryAttemptState: .*"sent".*"failed"/);
    assert.match(source, /deliveryErrorCode: "provider_exception"/);
    assert.doesNotMatch(source, /deliveryError:/);
    assert.doesNotMatch(source, /metadata:[\s\S]{0,200}publicToken/);
  }
});

test("provider exceptions and every non-sent result revoke only their own share", () => {
  assert.match(mediaStore, /export async function revokeWorkspaceMediaShare/);
  assert.match(mediaStore, /where id = \$3[\s\S]*and asset_id = \$1[\s\S]*and workspace_id = \$2/);
  assert.match(mediaStore, /active_share\.id <> \$3/);

  for (const source of [actionsRoute, documentsRoute, chatRuntime]) {
    assert.match(source, /try \{[\s\S]*sendBotDocument\([\s\S]*\} catch \{[\s\S]*revokeDocumentAttemptShare\(/);
    assert.match(source, /delivery\.status (?:=== "sent" \? null :|!== "sent" \?)[\s\S]*revokeDocumentAttemptShare\(/);
    assert.doesNotMatch(source, /revokeWorkspaceMediaShare\([\s\S]{0,160}\.catch\(\(\) => undefined\)/);
    assert.match(source, /publicShareRevocationState/);
    assert.match(source, /publicShareRevokedAt/);
  }
});

test("attempt shares are short-lived and the same share is extended only after sent", () => {
  assert.match(mediaStore, /export async function extendWorkspaceMediaShare/);
  assert.match(mediaStore, /set expires_at = greatest[\s\S]*where id = \$3/);

  for (const source of [actionsRoute, documentsRoute, chatRuntime]) {
    assert.match(source, /publishWorkspaceMedia\([\s\S]{0,260}expiresInSeconds: botDocumentAttemptShareTtlSeconds/);
    assert.match(source, /const sentAt = delivery\.status === "sent"[\s\S]*extendSentDocumentShare\(/);
    assert.match(source, /extendWorkspaceMediaShare\([\s\S]{0,260}botDocumentMediaShareTtlSeconds/);
  }
});

test("publication is claim-gated so parallel replays cannot accumulate delivery shares", () => {
  for (const source of [actionsRoute, documentsRoute, chatRuntime]) {
    const delivery = section(source, "const claimed = await claimDocumentDeliveryAttempt", "let delivery:");
    assert.ok(delivery.indexOf("if (!claimed)") < delivery.indexOf("publishWorkspaceMedia("));
    assert.equal((delivery.match(/publishWorkspaceMedia\(/g) ?? []).length, 1);
  }
});
