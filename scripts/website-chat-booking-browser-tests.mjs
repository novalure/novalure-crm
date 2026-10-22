// LOCAL_BROWSER_WITH_SIMULATED_CHAT_HTTP_NOT_PROVIDER_OR_PRODUCTION_ACCEPTANCE
// Executes the shipped widget/CSS. Every non-loopback request is intercepted;
// no model, database, OAuth or calendar provider is contacted by this test.
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { chromium, expect } from "@playwright/test";

const classification = "LOCAL_BROWSER_WITH_SIMULATED_CHAT_HTTP_NOT_PROVIDER_OR_PRODUCTION_ACCEPTANCE";
const [script, css] = await Promise.all([readFile(new URL("../public/chat/widget.js", import.meta.url), "utf8"), readFile(new URL("../public/chat/widget.css", import.meta.url), "utf8")]);
const api = "https://synthetic-crm.example.invalid", typeId = "11111111-1111-4111-8111-111111111111", bookingId = "22222222-2222-4222-8222-222222222222";
const siteKey = ["nov_pk", "SyntheticPublicRouting", "AbCdEfGhIjKlMnOpQrStUvWx"].join("_");
const chatToken = "SYNTHETIC-chat-credential-kept-only-in-memory", bookingToken = "B".repeat(43);
const starts = ["2030-11-11T09:00:00.000Z", "2030-11-11T10:00:00.000Z"];
const server = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic chat booking contract</title><script src="${api}/chat/widget.js" data-site-key="${siteKey}" defer></script></html>`); });
server.listen(0, "127.0.0.1"); await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
let browser, passed = 0;
try {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], ...(process.env.CRM_QA_CHROMIUM_PATH ? { executablePath: process.env.CRM_QA_CHROMIUM_PATH } : {}) });
  async function scenario(name, check, { kind = "phone", width = 1365, language = "en", publicationLanguage = language } = {}) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block" }), page = await context.newPage();
    const calls = [], errors = [], counts = { session: 0, availability: 0, hold: 0, confirm: 0, status: 0, reschedule: 0, cancel: 0 };
    let row = null;
    const type = { id: typeId, kind, timeZone: "Europe/Vienna", durationMinutes: 30, locationRequired: kind === "onsite", location: "" };
    const record = (state, startsAt = starts[0], location = "") => ({ id: bookingId, state, kind, startsAt, endsAt: new Date(Date.parse(startsAt) + 1800000).toISOString(), timeZone: type.timeZone, location, videoUrl: null, videoStatus: ["teams", "meet"].includes(kind) ? "pending" : "none", notificationStatus: "not_requested" });
    page.on("pageerror", () => errors.push("unexpected browser exception"));
    await context.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === origin) return route.continue();
      if (url.origin !== api) { errors.push("foreign network request"); return route.abort(); }
      if (url.pathname === "/chat/widget.js") return route.fulfill({ status: 200, contentType: "text/javascript", body: script });
      if (url.pathname === "/chat/widget.css") return route.fulfill({ status: 200, contentType: "text/css", body: css });
      const headers = { "content-type": "application/json", "access-control-allow-origin": origin, "access-control-allow-methods": "POST,OPTIONS", "access-control-allow-headers": "content-type,x-novalure-site-key,x-novalure-session-token,idempotency-key" };
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      assert.equal(request.method(), "POST"); assert.equal(request.headers()["x-novalure-site-key"], siteKey); assert.equal(request.headers().cookie, undefined);
      assert.equal(url.searchParams.get("site_key"), siteKey); assert.equal(url.href.includes(chatToken), false); assert.equal(url.href.includes(bookingToken), false);
      const body = request.postDataJSON(); calls.push({ path: url.pathname, body });
      const reply = value => route.fulfill({ status: 200, headers, body: JSON.stringify(value) });
      if (url.pathname.endsWith("/sessions")) return reply({ status: "active", mode: name === "training" ? "training" : "real_customer", sessionId: "33333333-3333-4333-8333-333333333333", sessionToken: chatToken, widget: { language }, ...(name === "disabled" || name === "training" ? {} : { bookingAvailable: true }) });
      assert.equal(request.headers()["x-novalure-session-token"], chatToken);
      if (url.pathname.endsWith("/answers")) return reply({ contractVersion: "website-answer-v1", answerStatus: "grounded", answer: "SYNTHETIC approved answer", citations: [] });
      assert.equal(url.pathname, "/api/public/integrations/chat/booking");
      if (body.operation === "configuration") {
        assert.deepEqual(Object.keys(body).sort(), ["operation", "sessionId"]);
        if (name === "revoked") return route.fulfill({ status: 404, headers, body: JSON.stringify({ error: "integration_not_found" }) });
        return reply({ title: "SYNTHETIC booking", language: publicationLanguage, types: [type] });
      }
      assert.ok(body.operation in counts); counts[body.operation]++;
      if (body.operation === "session") { assert.equal(body.typeId, typeId); assert.equal(body.language, publicationLanguage === "de" || publicationLanguage === "en" ? publicationLanguage : language === "de" ? "de" : "en"); return reply({ token: bookingToken }); }
      assert.equal(body.token, bookingToken);
      if (body.operation === "availability") return reply({ slots: starts.map(startsAt => ({ startsAt, endsAt: record("held", startsAt).endsAt })), timeZone: type.timeZone, durationMinutes: 30 });
      if (body.operation === "hold") {
        row = record("held", body.startsAt, body.location || "");
        assert.equal(typeof body.idempotencyKey, "string"); assert.equal(body.recipientEmail, "synthetic@example.invalid");
        if (kind === "onsite") assert.equal(body.locationConfirmed, true);
        if (name === "unknown-hold") return route.abort("failed");
      }
      if (["confirm", "reschedule", "cancel"].includes(body.operation)) {
        assert.equal(body.consent, true); assert.equal(body.bookingId, bookingId);
        assert.deepEqual(body.summary, { startsAt: body.operation === "reschedule" ? body.startsAt : row.startsAt, timeZone: row.timeZone, kind, location: row.location });
        if (body.operation === "confirm") { row = { ...row, state: "confirmed", ...(name === "video-unavailable" ? { videoStatus: "unavailable" } : {}) }; if (name === "unknown-confirm") return route.abort("failed"); }
        if (body.operation === "reschedule") { if (name === "unknown-reschedule" && counts.reschedule === 1) return route.abort("failed"); if (name === "rejected-reschedule" && counts.reschedule === 1) return route.fulfill({ status: 409, headers, body: JSON.stringify({ error: "SLOT_UNAVAILABLE" }) }); row = record("confirmed", body.startsAt, row.location); }
        if (body.operation === "cancel") row = { ...row, state: "cancelled" };
      }
      if (body.operation === "status" && name === "video") row = { ...row, videoUrl: "https://teams.example.invalid/own-synthetic-meeting", videoStatus: "ready" };
      if (body.operation === "status" && !body.bookingId) assert.equal(body.idempotencyKey, calls.find(call => call.body.operation === "hold").body.idempotencyKey);
      return reply({ booking: row });
    });
    try {
      await page.goto(origin); const launch = page.getByRole("button", { name: "Ask a question", exact: true }); await expect(launch).toBeVisible();
      assert.equal(calls.length, 0); await launch.click(); assert.equal(calls.length, 0, "opening the widget does not create a session or booking");
      await page.getByLabel("Your question", { exact: true }).fill("SYNTHETIC question"); await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect(page.getByRole("log")).toContainText("SYNTHETIC approved answer");
      await check({ page, calls, counts, type });
      assert.deepEqual(errors, []); assert.equal(await page.evaluate(([a, b]) => { const host = document.querySelector("[data-novalure-chat-host]"); return document.documentElement.innerHTML.includes(a) || host.shadowRoot.innerHTML.includes(a) || host.shadowRoot.innerHTML.includes(b); }, [chatToken, bookingToken]), false);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      passed++;
    } finally { await context.close(); }
  }
  async function choose({ page, counts, type }, language = "en", launcherLanguage = language) {
    const de = language === "de";
    await page.getByRole("button", { name: launcherLanguage === "de" ? "Termin buchen" : "Book an appointment", exact: true }).click();
    assert.equal(counts.session + counts.hold + counts.confirm, 0, "configuration and field selection cannot reserve a time");
    await page.getByLabel(de ? "Datum" : "Date", { exact: true }).fill("2030-11-11");
    if (type.locationRequired) {
      const availability = page.getByRole("button", { name: de ? "Freie Zeiten anzeigen" : "Show available times", exact: true }); await expect(availability).toBeDisabled();
      await page.getByLabel(de ? "Vollständige Besuchsadresse" : "Full visit address", { exact: true }).fill("SYNTHETIC confirmed visit address");
      await expect(availability).toBeDisabled(); await page.getByLabel(de ? "Ich bestätige diese eindeutige Adresse für den Besuch." : "I confirm this unambiguous address for the visit.", { exact: true }).check();
    }
    await page.getByRole("button", { name: de ? "Freie Zeiten anzeigen" : "Show available times", exact: true }).click();
    await expect(page.getByLabel(de ? "Freie Startzeit auswählen" : "Choose an available start time", { exact: true })).toBeEnabled();
    await page.getByLabel(de ? "Freie Startzeit auswählen" : "Choose an available start time", { exact: true }).selectOption(starts[0]);
    await page.getByLabel(de ? "Ihr Name" : "Your name", { exact: true }).fill("SYNTHETIC visitor"); await page.getByLabel(de ? "Ihre E-Mail-Adresse" : "Your email address", { exact: true }).fill("synthetic@example.invalid");
    await expect(page.getByRole("region", { name: de ? "Ihre Auswahl" : "Your selection", exact: true })).toContainText(type.timeZone);
    assert.equal(counts.hold + counts.confirm, 0);
    const confirm = page.getByRole("button", { name: de ? "Termin verbindlich buchen" : "Confirm appointment booking", exact: true }); await expect(confirm).toBeDisabled();
    await page.getByLabel(de ? "Ich möchte diesen Termin zu den angezeigten Angaben verbindlich buchen." : "I want to book this appointment with the details shown.", { exact: true }).check();
    return confirm;
  }
  for (const name of ["disabled", "training"]) await scenario(name, async ({ page, counts }) => { await expect(page.getByRole("button", { name: "Book an appointment", exact: true })).toBeHidden(); assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 0); });
  await scenario("phone-lifecycle", async state => {
    const confirm = await choose(state); await confirm.dblclick(); await expect(state.page.getByText("Your appointment is confirmed.", { exact: true })).toBeVisible();
    assert.equal(state.counts.hold, 1); assert.equal(state.counts.confirm, 1);
    await state.page.getByRole("button", { name: "Reschedule appointment", exact: true }).click();
    await state.page.getByLabel("Date", { exact: true }).fill("2030-11-12"); await state.page.getByRole("button", { name: "Show available times", exact: true }).click();
    await state.page.getByLabel("Choose an available start time", { exact: true }).selectOption(starts[1]);
    await state.page.getByLabel("I want to reschedule my appointment to the selected time.", { exact: true }).check(); await state.page.getByRole("button", { name: "Confirm rescheduling", exact: true }).click();
    await expect(state.page.getByText("Your appointment has been rescheduled.", { exact: true })).toBeVisible(); assert.equal(state.counts.reschedule, 1);
    await state.page.getByRole("button", { name: "Cancel appointment", exact: true }).click(); await expect(state.page.getByRole("button", { name: "Confirm cancellation", exact: true })).toBeDisabled();
    await state.page.getByLabel("I want to cancel this appointment.", { exact: true }).check(); await state.page.getByRole("button", { name: "Confirm cancellation", exact: true }).click();
    await expect(state.page.getByText("Your appointment has been cancelled.", { exact: true })).toBeVisible(); assert.equal(state.counts.cancel, 1);
    await expect(state.page.getByLabel("Appointment type", { exact: true })).toBeDisabled();
    await state.page.getByRole("button", { name: "Start a new appointment selection", exact: true }).click(); await expect(state.page.getByLabel("Appointment type", { exact: true })).toBeEnabled(); assert.equal(state.counts.hold, 1, "explicitly starting a new selection makes no booking");
  });
  await scenario("onsite-mobile-de", async state => { const confirm = await choose(state, "de"); await expect(state.page.getByRole("region", { name: "Ihre Auswahl", exact: true })).toContainText("SYNTHETIC confirmed visit address"); await confirm.click(); await expect(state.page.getByText("Ihr Termin ist bestätigt.", { exact: true })).toBeVisible(); await state.page.keyboard.press("Escape"); await expect(state.page.getByRole("button", { name: "Frage stellen", exact: true })).toBeFocused(); }, { kind: "onsite", width: 390, language: "de" });
  for (const name of ["unknown-hold", "unknown-confirm"]) await scenario(name, async state => {
    const confirm = await choose(state); await confirm.click(); await expect(state.page.getByText("The outcome is not final yet. Check its status; do not create a second booking.", { exact: true })).toBeVisible();
    assert.equal(state.counts.hold, 1); await expect(confirm).toBeHidden();
    await state.page.getByRole("button", { name: "Check booking status", exact: true }).click();
    if (name === "unknown-hold") { await expect(confirm).toBeVisible(); await confirm.click(); }
    await expect(state.page.getByText("Your appointment is confirmed.", { exact: true })).toBeVisible(); assert.equal(state.counts.hold, 1); assert.equal(state.counts.confirm, 1); assert.equal(state.counts.status, 1);
  });
  await scenario("revoked", async ({ page, counts }) => { await page.getByRole("button", { name: "Book an appointment", exact: true }).click(); await expect(page.getByRole("log")).toContainText("Appointment booking is currently unavailable. You can continue using the chat."); assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 0); await expect(page.getByLabel("Your question", { exact: true })).toBeEnabled(); });
  await scenario("contact-consent", async state => {
    const confirm = await choose(state); await expect(confirm).toBeEnabled();
    await state.page.getByLabel("Your email address", { exact: true }).fill("other-synthetic@example.invalid"); await expect(confirm).toBeDisabled();
    await expect(state.page.getByRole("region", { name: "Your selection", exact: true })).toContainText("other-synthetic@example.invalid"); assert.equal(state.counts.hold, 0);
  });
  await scenario("unknown-reschedule", async state => {
    await (await choose(state)).click(); await expect(state.page.getByText("Your appointment is confirmed.", { exact: true })).toBeVisible();
    await state.page.getByRole("button", { name: "Reschedule appointment", exact: true }).click(); await state.page.getByLabel("Date", { exact: true }).fill("2030-11-12");
    await state.page.getByRole("button", { name: "Show available times", exact: true }).click(); await state.page.getByLabel("Choose an available start time", { exact: true }).selectOption(starts[1]);
    await state.page.getByLabel("I want to reschedule my appointment to the selected time.", { exact: true }).check(); await state.page.getByRole("button", { name: "Confirm rescheduling", exact: true }).click();
    await expect(state.page.getByText("The outcome is not final yet. Check its status; do not create a second booking.", { exact: true })).toBeVisible();
    await state.page.getByRole("button", { name: "Check booking status", exact: true }).click(); await expect(state.page.getByText(/The requested change is not confirmed/)).toBeVisible();
    await expect(state.page.getByText("Your appointment has been rescheduled.", { exact: true })).toHaveCount(0);
    await expect(state.page.getByLabel("Date", { exact: true })).toBeDisabled(); await expect(state.page.getByLabel("Choose an available start time", { exact: true })).toBeDisabled(); await expect(state.page.getByRole("button", { name: "Show available times", exact: true })).toBeHidden();
    await expect(state.page.getByRole("button", { name: "Confirm rescheduling", exact: true })).toBeDisabled();
    await state.page.getByLabel("I want to reschedule my appointment to the selected time.", { exact: true }).check(); await state.page.getByRole("button", { name: "Confirm rescheduling", exact: true }).click();
    await expect(state.page.getByText("Your appointment has been rescheduled.", { exact: true })).toBeVisible();
    const changes = state.calls.filter(call => call.body.operation === "reschedule"); assert.equal(changes.length, 2); assert.equal(changes[0].body.idempotencyKey, changes[1].body.idempotencyKey); assert.equal(state.counts.hold, 1);
  });
  await scenario("video", async state => {
    await (await choose(state)).click(); await expect(state.page.getByText("The provider is still preparing your video link. Check the booking status again.", { exact: true })).toBeVisible();
    await state.page.getByRole("button", { name: "Check booking status", exact: true }).click(); const link = state.page.getByRole("link", { name: "Join video meeting", exact: true });
    await expect(link).toHaveAttribute("href", "https://teams.example.invalid/own-synthetic-meeting"); await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  }, { kind: "teams" });
  await scenario("video-unavailable", async state => { await (await choose(state)).click(); await expect(state.page.getByText("Your video link is currently unavailable. Check the booking status or contact the team.", { exact: true })).toBeVisible(); await expect(state.page.getByText("The provider is still preparing your video link. Check the booking status again.", { exact: true })).toHaveCount(0); await expect(state.page.getByRole("link", { name: "Join video meeting", exact: true })).toHaveCount(0); }, { kind: "meet" });
  await scenario("rejected-reschedule", async state => {
    await (await choose(state)).click(); await expect(state.page.getByText("Your appointment is confirmed.", { exact: true })).toBeVisible();
    await state.page.getByRole("button", { name: "Reschedule appointment", exact: true }).click(); await state.page.getByLabel("Date", { exact: true }).fill("2030-11-12");
    await state.page.getByRole("button", { name: "Show available times", exact: true }).click(); await state.page.getByLabel("Choose an available start time", { exact: true }).selectOption(starts[1]);
    await state.page.getByLabel("I want to reschedule my appointment to the selected time.", { exact: true }).check(); await state.page.getByRole("button", { name: "Confirm rescheduling", exact: true }).click();
    await expect(state.page.getByText("This action could not be completed. Check the booking status or contact the team directly.", { exact: true })).toBeVisible();
    await expect(state.page.getByLabel("Date", { exact: true })).toBeEnabled(); await expect(state.page.getByRole("button", { name: "Show available times", exact: true })).toBeVisible();
    await expect(state.page.getByText("Your appointment has been rescheduled.", { exact: true })).toHaveCount(0); assert.equal(state.counts.hold, 1);
  });
  await scenario("fixed-publication-language", async state => { await (await choose(state, "de", "en")).click(); await expect(state.page.getByText("Ihr Termin ist bestätigt.", { exact: true })).toBeVisible(); }, { publicationLanguage: "de" });
  console.log(JSON.stringify({ classification, passed, directProviderCalls: 0, modelCalls: 0, productionCalls: 0 }));
} finally { await browser?.close(); server.close(); await once(server, "close"); }
