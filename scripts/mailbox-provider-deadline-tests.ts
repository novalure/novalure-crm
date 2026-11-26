import test from "node:test";
import assert from "node:assert/strict";
import { mailboxProviderJson, MailboxProviderError } from "../src/lib/integrations/mailbox-provider";
import { fetchMailboxKnownContent } from "../src/lib/integrations/mailbox-sync-provider";

const microsoft = "https://graph.microsoft.com/v1.0/me";
const google = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const token = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

test("Microsoft and Gmail provider replies retain status, retry and body limits", async () => {
  for (const url of [microsoft, google]) {
    const received = await mailboxProviderJson(url, {}, async (_url, init) => {
      assert.equal(init.redirect, "error"); assert.equal(init.cache, "no-store"); assert.ok(init.signal);
      return new Response(JSON.stringify({ id: "synthetic" }));
    });
    assert.deepEqual(received, { id: "synthetic" });
  }
  for (const [status, url, code] of [[401, microsoft, "MAIL_AUTHORIZATION_REQUIRED"], [403, microsoft, "MAIL_AUTHORIZATION_REQUIRED"], [404, microsoft, "MAIL_PROVIDER_NOT_FOUND"], [410, microsoft, "MAIL_CHECKPOINT_EXPIRED"], [400, token, "MAIL_REAUTH_REQUIRED"], [500, microsoft, "MAIL_PROVIDER_UNAVAILABLE"]] as const) {
    await assert.rejects(mailboxProviderJson(url, {}, async () => new Response("{}", {status})), (error: unknown) => error instanceof MailboxProviderError && error.code === code && error.status === status);
  }
  await assert.rejects(mailboxProviderJson(microsoft, {}, async () => new Response("{}", {status: 429, headers: {"retry-after": "120"}})), (error: unknown) => error instanceof MailboxProviderError && error.code === "MAIL_PROVIDER_RATE_LIMIT" && error.status === 429 && error.retryAfterSeconds === 120);
  await assert.rejects(mailboxProviderJson(microsoft, {}, async () => new Response("12345"), 4), /MAIL_RESPONSE_TOO_LARGE/);
  await assert.rejects(mailboxProviderJson(microsoft, {}, async () => new Response("{}", {headers: {"content-length": "5"}}), 4), /MAIL_RESPONSE_TOO_LARGE/);
  await assert.rejects(mailboxProviderJson(microsoft, {}, async () => new Response("[]")), /MAIL_INVALID_RESPONSE/);
  await assert.rejects(mailboxProviderJson("https://example.invalid/me", {}, async () => new Response("{}")), /UNSAFE_PROVIDER_URL/);
});

test("provider request and whole body share a deadline; cancellation never hangs", {timeout: 15_000}, async () => {
  let cancelled = 0;
  const hangingCancel = () => { cancelled++; return new Promise<void>(() => {}); };
  let finishHeaders!: (response: Response) => void;
  const stalledHeaders = mailboxProviderJson(microsoft, {}, async () => new Promise<Response>(resolve => { finishHeaders = resolve; }));
  const stalledBody = mailboxProviderJson(google, {}, async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("{")); }, cancel: hangingCancel,
  })));
  let dripTimer!: ReturnType<typeof setInterval>, drips = 0;
  const dripping = mailboxProviderJson(microsoft, {}, async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { dripTimer = setInterval(() => { drips++; controller.enqueue(new Uint8Array([32])); }, 20); },
    cancel() { clearInterval(dripTimer); return hangingCancel(); },
  })));
  await Promise.all([stalledHeaders, stalledBody, dripping].map(promise => assert.rejects(promise, /MAIL_PROVIDER_UNAVAILABLE/)));
  assert.ok(drips > 1); assert.equal(cancelled, 2);
  let lateCancelled = 0;
  finishHeaders(new Response(new ReadableStream<Uint8Array>({ cancel() { lateCancelled++; } })));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(lateCancelled, 1);

  await assert.rejects(mailboxProviderJson(microsoft, {}, async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(5)); }, cancel: hangingCancel,
  })), 4), /MAIL_RESPONSE_TOO_LARGE/);
  await assert.rejects(mailboxProviderJson(microsoft, {}, async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array()); }, cancel: hangingCancel,
  }))), /MAIL_PROVIDER_UNAVAILABLE/);
  assert.equal(cancelled, 4);
});

test("a small, valid but highly fragmented Microsoft reply remains retryable", async () => {
  const data = new TextEncoder().encode(JSON.stringify({ synthetic: "x".repeat(8200) }));
  assert.ok(data.byteLength < 1_048_576);
  let offset = 0;
  const transport = async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === data.length) controller.close();
      else controller.enqueue(data.subarray(offset, ++offset));
    },
  }));
  await assert.rejects(fetchMailboxKnownContent("microsoft", "synthetic", "item", transport),
    (error: unknown) => error instanceof MailboxProviderError && error.code === "MAIL_PROVIDER_UNAVAILABLE");
});
