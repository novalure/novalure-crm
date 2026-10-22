import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import test from "node:test";
import { defaultBookingCommunication, renderBookingEmail, validateBookingCommunication, validateBookingEmailTemplate, type BookingEmailValues } from "../src/lib/booking/templates";
import { bookingMailBindings, normalizeBookingRecipient } from "../src/lib/booking/messages";
import { bookingActionFormNonce, createBookingActionToken, verifyBookingActionForm, verifyBookingActionToken } from "../src/lib/booking/message-actions";
import { nextBookingMailDeliveryStatus, verifyBookingMailWebhook } from "../src/lib/booking/message-webhooks";
import { sendTransactionalEmail } from "../src/lib/integrations/resend";

const values: BookingEmailValues = { customerName: "Alex Example", firstName: "Alex", companyName: "Example & Co", employeeName: "Sam", bookingType: "Consultation", date: "24.10.2026", time: "10:00", timeZone: "Europe/Vienna", duration: "45", location: "Example Street 1", videoUrl: "https://meet.google.com/abc-defg-hij", preparationNote: "", rescheduleUrl: "https://example.invalid/reschedule", cancelUrl: "https://example.invalid/cancel" };
test("all four DE/EN templates render channel-specific contents without raw tokens", () => {
  for (const language of ["de", "en"] as const) for (const kind of ["confirmation", "reminder", "reschedule", "cancellation"] as const) for (const bookingKind of ["phone", "teams", "meet", "office", "onsite"] as const) {
    const rendered = renderBookingEmail({ template: defaultBookingCommunication.templates[language][kind], language, bookingKind, values });
    assert.ok(!rendered.text.includes("{{"));
    assert.match(rendered.html, new RegExp(`<html lang="${language}">`));
    if (kind !== "cancellation") {
      assert.equal(rendered.text.includes(values.videoUrl!), bookingKind === "teams" || bookingKind === "meet");
      assert.equal(rendered.text.includes(values.location!), bookingKind === "onsite" || bookingKind === "office");
    }
  }
});
test("template values are escaped as text; subject header injection is rejected", () => {
  const rendered = renderBookingEmail({ template: defaultBookingCommunication.templates.en.confirmation, language: "en", bookingKind: "phone", values: { ...values, firstName: '<img src=x onerror="alert(1)">' } });
  assert.ok(!rendered.html.includes('<img src=x'));
  assert.ok(rendered.html.includes("&lt;img"));
  assert.throws(() => renderBookingEmail({ template: { ...defaultBookingCommunication.templates.en.confirmation, subject: "{{customerName}}" }, language: "en", bookingKind: "phone", values: { ...values, customerName: "Alex\r\nBcc: victim@example.invalid" } }), /INVALID_TEMPLATE_SUBJECT/);
});
test("unknown placeholders, scripts, executable template syntax and logo protocols are refused", () => {
  for (const patch of [{ body: "{{privateCalendarDescription}}" }, { body: "<script>alert(1)</script>" }, { body: "{{constructor}}" }, { body: "{% include secret %}" }, { logoUrl: "javascript:alert(1)" }, { logoUrl: "https://user:pass@example.invalid/a.png" }, { arbitraryCode: "x" }]) {
    assert.throws(() => validateBookingEmailTemplate({ ...defaultBookingCommunication.templates.en.confirmation, ...patch }));
  }
});
test("missing real video and action values block delivery rather than inventing links", () => {
  assert.throws(() => renderBookingEmail({ template: defaultBookingCommunication.templates.en.confirmation, language: "en", bookingKind: "meet", values: { ...values, videoUrl: "" } }), /TEMPLATE_VALUE_MISSING:videoUrl/);
  assert.throws(() => renderBookingEmail({ template: defaultBookingCommunication.templates.en.confirmation, language: "en", bookingKind: "phone", values: { ...values, cancelUrl: "" } }), /TEMPLATE_VALUE_MISSING:cancelUrl/);
});
test("communication settings validate reminder identity, offset and strict nested schema", () => {
  assert.deepEqual(validateBookingCommunication(structuredClone(defaultBookingCommunication)), defaultBookingCommunication);
  for (const minutesBefore of [0, -1, 0.5, 50000]) assert.throws(() => validateBookingCommunication({ ...structuredClone(defaultBookingCommunication), reminders: [{ id: "x", enabled: true, template: "reminder", minutesBefore }] }));
  assert.throws(() => validateBookingCommunication({ ...structuredClone(defaultBookingCommunication), reminders: [{ id: "x", enabled: true, template: "reminder", minutesBefore: 60 }, { id: "x", enabled: true, template: "reminder", minutesBefore: 30 }] }));
  assert.throws(() => validateBookingCommunication({ ...structuredClone(defaultBookingCommunication), templates: { ...defaultBookingCommunication.templates, fr: {} } }));
});
test("recipient and frozen communication language are validated separately from UI language", () => {
  assert.deepEqual(normalizeBookingRecipient({ recipientEmail: "HELLO@NOVALURE.EU", recipientName: " Alex ", communicationLanguage: "en" }), { recipientEmail: "hello@novalure.eu", recipientName: "Alex", communicationLanguage: "en" });
  assert.throws(() => normalizeBookingRecipient({ recipientEmail: "a@example.invalid\r\nBcc:x@example.invalid" }));
  assert.throws(() => normalizeBookingRecipient({ communicationLanguage: "fr" }));
});
test("QA bindings refuse production and any unapproved recipient", () => {
  const binding = { workspaceId: "a1d180a7-34ea-4f9d-a979-50b3f979667b", userId: "bb131845-c1fa-4c2b-9854-94bba2c28586", recipientEmail: "hello@novalure.eu" };
  const env = { NODE_ENV: "test" as const, BOOKING_MESSAGES_ENABLED: "1", VERCEL_ENV: "preview", BOOKING_MAIL_TEST_BINDINGS_JSON: JSON.stringify([binding, binding, { ...binding, recipientEmail: "customer@example.invalid" }]) };
  assert.deepEqual(bookingMailBindings(env), [binding]);
  assert.deepEqual(bookingMailBindings({ ...env, VERCEL_ENV: "production" }), []);
});
test("bounded customer action tokens bind purpose, owner, booking version and expiry", () => {
  const previous = process.env.NOVALURE_SESSION_SECRET;
  process.env.NOVALURE_SESSION_SECRET = "booking-actions-test-material-".repeat(3);
  try {
    const now = Date.parse("2026-10-22T08:00:00Z"), payload = { workspaceId: "a1d180a7-34ea-4f9d-a979-50b3f979667b", organizerId: "bb131845-c1fa-4c2b-9854-94bba2c28586", bookingId: "31131845-c1fa-4c2b-9854-94bba2c28586", version: 3, purpose: "cancel" as const, recipientHash: "a".repeat(64), expiresAt: now + 3600_000 };
    const token = createBookingActionToken(payload);
    assert.deepEqual(verifyBookingActionToken(token, now), payload);
    assert.throws(() => verifyBookingActionToken(`${token.slice(0, -4)}abcd`, now));
    assert.throws(() => verifyBookingActionToken(token, payload.expiresAt));
    assert.throws(() => verifyBookingActionToken(createBookingActionToken({ ...payload, expiresAt: now + 8 * 86400_000 }), now));
  } finally { if (previous === undefined) delete process.env.NOVALURE_SESSION_SECRET; else process.env.NOVALURE_SESSION_SECRET = previous; }
});
test("customer mutation requires explicit same-origin form confirmation", () => {
  const saved = { secret: process.env.NOVALURE_SESSION_SECRET, origin: process.env.NOVALURE_APP_ORIGIN };
  process.env.NOVALURE_SESSION_SECRET = "booking-actions-test-material-".repeat(3);
  process.env.NOVALURE_APP_ORIGIN = "https://qa.example.invalid";
  try {
    const token = "bounded-token", nonce = bookingActionFormNonce(token);
    verifyBookingActionForm(new Request("https://qa.example.invalid/booking/manage/x", { method: "POST", headers: { origin: "https://qa.example.invalid" } }), token, nonce);
    assert.throws(() => verifyBookingActionForm(new Request("https://qa.example.invalid/booking/manage/x", { method: "POST", headers: { origin: "https://attacker.invalid" } }), token, nonce));
    assert.throws(() => verifyBookingActionForm(new Request("https://qa.example.invalid/booking/manage/x", { method: "POST", headers: { origin: "https://qa.example.invalid" } }), token, ""));
  } finally {
    if (saved.secret === undefined) delete process.env.NOVALURE_SESSION_SECRET; else process.env.NOVALURE_SESSION_SECRET = saved.secret;
    if (saved.origin === undefined) delete process.env.NOVALURE_APP_ORIGIN; else process.env.NOVALURE_APP_ORIGIN = saved.origin;
  }
});
test("webhook authentication uses raw body, bounded timestamps and authenticated message tags", () => {
  const now = Date.parse("2026-10-22T08:00:00Z"), timestamp = String(now / 1000), secret = Buffer.from("webhook-test-material-with-32-bytes").toString("base64"), id = "msg_test_event";
  const body = JSON.stringify({ type: "email.delivered", created_at: new Date(now).toISOString(), data: { email_id: "mail_test_id", tags: { booking_job_id: "31131845-c1fa-4c2b-9854-94bba2c28586" } } });
  const signature = createHmac("sha256", Buffer.from(secret, "base64")).update(`${id}.${timestamp}.${body}`).digest("base64");
  const headers = new Headers({ "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` });
  assert.equal(verifyBookingMailWebhook(body, headers, `whsec_${secret}`, now)?.jobId, "31131845-c1fa-4c2b-9854-94bba2c28586");
  assert.throws(() => verifyBookingMailWebhook(`${body} `, headers, `whsec_${secret}`, now));
  assert.throws(() => verifyBookingMailWebhook(body, headers, `whsec_${secret}`, now + 6 * 60_000));
});
test("Svix provider signing keys accept valid 24-byte keys and preserve larger keys", () => {
  const now = Date.parse("2026-10-22T08:00:00Z"), timestamp = String(now / 1000), id = "msg_provider_key_sizes";
  const body = JSON.stringify({ type: "email.delivered", created_at: new Date(now).toISOString(), data: { email_id: "mail_provider_key_sizes" } });
  // Standard Webhooks specifies 24–64 random bytes for HMAC signing secrets.
  // Resend's 32-character base64 secret component decodes to 24 bytes.
  for (const length of [24, 32, 64]) {
    const key = randomBytes(length), encoded = key.toString("base64");
    const signature = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
    const headers = new Headers({ "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` });
    for (const serialized of [encoded, encoded.replace(/=+$/, "")]) {
      assert.equal(verifyBookingMailWebhook(body, headers, `whsec_${serialized}`, now)?.messageId, "mail_provider_key_sizes");
    }
  }
});
test("24-byte Svix keys still reject altered payloads, metadata, signatures and truncated keys", () => {
  const now = Date.parse("2026-10-22T08:00:00Z"), timestamp = String(now / 1000), id = "msg_provider_key_tamper";
  const key = randomBytes(24), secret = `whsec_${key.toString("base64")}`;
  const body = JSON.stringify({ type: "email.delivered", created_at: new Date(now).toISOString(), data: { email_id: "mail_provider_key_tamper" } });
  const mac = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest();
  const headers = new Headers({ "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${mac.toString("base64")}` });
  assert.throws(() => verifyBookingMailWebhook(`${body} `, headers, secret, now), /MAIL_WEBHOOK_UNAUTHORIZED/);
  for (const [name, value] of [["svix-id", `${id}_changed`], ["svix-timestamp", String(now / 1000 + 1)], ["svix-signature", ""], ["svix-signature", `v1,${mac.subarray(0, 31).toString("base64")}`], ["svix-signature", `v1,${randomBytes(32).toString("base64")}`]]) {
    const altered = new Headers(headers); altered.set(name, value);
    assert.throws(() => verifyBookingMailWebhook(body, altered, secret, now), /MAIL_WEBHOOK_UNAUTHORIZED/);
  }
  assert.throws(() => verifyBookingMailWebhook(body, headers, `whsec_${randomBytes(24).toString("base64")}`, now), /MAIL_WEBHOOK_UNAUTHORIZED/);
  assert.throws(() => verifyBookingMailWebhook(body, headers, secret, now + 6 * 60_000), /MAIL_WEBHOOK_UNAUTHORIZED/);
  // Even a matching MAC cannot make an undersized, truncated secret valid.
  const shortKey = key.subarray(0, 23), shortSecret = `whsec_${shortKey.toString("base64")}`;
  const shortHeaders = new Headers(headers);
  shortHeaders.set("svix-signature", `v1,${createHmac("sha256", shortKey).update(`${id}.${timestamp}.${body}`).digest("base64")}`);
  assert.throws(() => verifyBookingMailWebhook(body, shortHeaders, shortSecret, now), /MAIL_WEBHOOK_UNAUTHORIZED/);
});
test("webhook refuses empty, short and noncanonical signing keys even with a matching MAC", () => {
  const now = Date.parse("2026-10-22T08:00:00Z"), timestamp = String(now / 1000), id = "msg_bad_configuration";
  const body = JSON.stringify({ type: "email.sent", created_at: new Date(now).toISOString(), data: { email_id: "mail_test" } });
  for (const encoded of ["", Buffer.from("short-known-key").toString("base64"), `${Buffer.alloc(32, 1).toString("base64")}!`, `${Buffer.alloc(32, 1).toString("base64")}\n`]) {
    const signature = createHmac("sha256", Buffer.from(encoded, "base64")).update(`${id}.${timestamp}.${body}`).digest("base64");
    const headers = new Headers({ "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` });
    assert.throws(() => verifyBookingMailWebhook(body, headers, `whsec_${encoded}`, now), /MAIL_WEBHOOK_UNAUTHORIZED/);
  }
});
test("late provider acceptance does not regress delivered or failed states", () => {
  assert.equal(nextBookingMailDeliveryStatus("delivered", "email.sent"), "delivered");
  assert.equal(nextBookingMailDeliveryStatus("failed", "email.sent"), "failed");
  assert.equal(nextBookingMailDeliveryStatus("uncertain", "email.delivered"), "delivered");
  assert.equal(nextBookingMailDeliveryStatus("delivered", "email.bounced"), "failed");
});
test("transactional adapter distinguishes acceptance, rejection, rate limits and unknown outcomes", async () => {
  const saved = { key: process.env.RESEND_API_KEY, from: process.env.RESEND_FROM };
  process.env.RESEND_API_KEY = "not-a-real-key"; process.env.RESEND_FROM = "QA <qa@example.invalid>";
  const input = { to: "hello@novalure.eu", subject: "Test", html: "<p>Test</p>", text: "Test", idempotencyKey: "stable-test", bookingJobId: "31131845-c1fa-4c2b-9854-94bba2c28586" };
  try {
    let payload: Record<string, unknown> = {};
    const accepted = await sendTransactionalEmail(input, async (_request, options) => { payload = JSON.parse(String(options?.body)); return Response.json({ id: "mail-test" }); });
    assert.deepEqual(accepted, { outcome: "accepted", messageId: "mail-test" });
    assert.deepEqual(payload.tags, [{ name: "booking_job_id", value: input.bookingJobId }]);
    assert.equal((await sendTransactionalEmail(input, async () => new Response("", { status: 429 }))).outcome, "retryable");
    assert.equal((await sendTransactionalEmail(input, async () => new Response("", { status: 403 }))).outcome, "rejected");
    assert.equal((await sendTransactionalEmail(input, async () => new Response("", { status: 503 }))).outcome, "uncertain");
    assert.equal((await sendTransactionalEmail(input, async () => { throw new Error("network response lost"); })).outcome, "uncertain");
    delete process.env.RESEND_API_KEY;
    assert.equal((await sendTransactionalEmail(input)).outcome, "unconfigured");
  } finally {
    if (saved.key === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = saved.key;
    if (saved.from === undefined) delete process.env.RESEND_FROM; else process.env.RESEND_FROM = saved.from;
  }
});
