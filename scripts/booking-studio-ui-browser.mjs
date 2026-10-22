// LOCAL_STUDIO_UI_WITH_SYNTHETIC_HTTP. Exercises the actual sibling Studio
// booking controller/CSS; no database, authentication, provider or remote requests.
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";

const repository = resolve(import.meta.dirname, "..");
const studio = resolve(process.env.BOOKING_STUDIO_REPOSITORY || resolve(repository, "../novalure-web-design"));
const [source, css] = await Promise.all([readFile(resolve(studio, "public/studio-booking.js")), readFile(resolve(studio, "public/studio-chat.css"))]);
const classification = "LOCAL_STUDIO_UI_WITH_SYNTHETIC_HTTP";
const states = new Map(), pageErrors = [], external = [];
const at = "2027-02-15T09:00:00.000Z", nextAt = "2027-02-15T11:00:00.000Z";
const publication = { publicId: "synthetic_studio_publication", title: "SYNTHETIC Studio booking", language: "en", types: [{ id: "synthetic_type", kind: "onsite", durationMinutes: 30, timeZone: "Europe/Vienna", locationRequired: true, location: "" }] };
let browser, passed = 0;
function stateFor(key) { if (!states.has(key)) states.set(key, { calls: [], booking: null, holdKey: null, token: "SYNTHETIC-BOOKING-TOKEN-NOT-AUTHENTICATION", lost: false }); return states.get(key); }
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/studio-chat.css"><style>body{font:16px system-ui;margin:0}</style><div id="studio-chat-root"><section class="studio-chat-panel"><header class="studio-chat-head"><h1>SYNTHETIC Studio enquiry</h1></header><div id="work" class="studio-chat-work"></div></section></div><script type="module">import {openStudioBooking} from '/studio-booking.js';const work=document.getElementById('work'),operation={state:'transmitted',snapshot:{brief:{values:{name:'SYNTHETIC visitor',email:'synthetic@example.com'}}}};const open=()=>openStudioBooking(work,operation,()=>{const again=document.createElement('button');again.textContent='Open saved booking';again.onclick=open;work.replaceChildren(again);});window.openBooking=open;open();</script></html>`;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": url.pathname.endsWith(".js") ? "text/javascript" : url.pathname.endsWith(".css") ? "text/css" : "text/html", "cache-control": "no-store" }); res.end(url.pathname.endsWith(".js") ? source : url.pathname.endsWith(".css") ? css : html); return;
  }
  if (url.pathname !== "/api/studio-booking") { res.writeHead(404); res.end(); return; }
  const scenario = new URL(req.headers.referer || "http://127.0.0.1").searchParams.get("scenario") || "normal";
  const state = stateFor(scenario), chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString());
  assert.equal(input.contractVersion, "booking-tools-v1");
  const { operation, payload } = input; state.calls.push({ operation, payload });
  let result;
  if (operation === "publication") result = { publication, ...(state.holdKey ? { resume: { token: state.token, idempotencyKey: state.holdKey, bookingId: state.booking.id } } : {}) };
  else if (operation === "session") result = { token: state.token, expiresAt: "2099-01-01T00:00:00.000Z", publication };
  else if (operation === "availability") result = { slots: [{ startsAt: at, endsAt: "2027-02-15T09:30:00.000Z" }, { startsAt: nextAt, endsAt: "2027-02-15T11:30:00.000Z" }], timeZone: "Europe/Vienna", durationMinutes: 30 };
  else if (operation === "hold") {
    state.holdKey = payload.idempotencyKey;
    state.booking = { id: "00000000-0000-4000-8000-000000000003", state: "held", kind: "onsite", startsAt: payload.startsAt, endsAt: new Date(Date.parse(payload.startsAt) + 1_800_000).toISOString(), timeZone: "Europe/Vienna", location: payload.location, videoUrl: null, videoStatus: "not_requested", notificationStatus: "pending" };
    result = { booking: state.booking };
  } else if (operation === "confirm") {
    assert.equal(payload.consent, true); assert.deepEqual(payload.summary, { startsAt: state.booking.startsAt, timeZone: state.booking.timeZone, kind: state.booking.kind, location: state.booking.location });
    state.booking.state = "confirmed";
    if (scenario.startsWith("unknown") && !state.lost) { state.lost = true; res.writeHead(503, { "content-type": "application/json" }); res.end(JSON.stringify({ code: "outcome_unknown" })); return; }
    result = { booking: state.booking };
  } else if (operation === "status") result = { booking: state.booking };
  else if (operation === "reschedule") { assert.equal(payload.consent, true); state.booking.startsAt = payload.startsAt; result = { booking: state.booking }; }
  else if (operation === "cancel") { assert.equal(payload.consent, true); state.booking.state = "cancelled"; result = { booking: state.booking }; }
  else { res.writeHead(400); res.end(); return; }
  res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(result));
});
try {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], ...(process.env.CRM_QA_CHROMIUM_PATH ? { executablePath: process.env.CRM_QA_CHROMIUM_PATH } : existsSync("/usr/bin/chromium") ? { executablePath: "/usr/bin/chromium" } : {}) });
  async function scenario(name, callback, mobile = false) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 1000 }, serviceWorkers: "block" });
    await context.route("**/*", route => { if (new URL(route.request().url()).origin === origin) return route.continue(); external.push("Blocked external request"); return route.abort(); });
    const page = await context.newPage(); page.setDefaultTimeout(10_000); page.on("pageerror", () => pageErrors.push("Studio page error"));
    try { await page.goto(`${origin}/?scenario=${name}`); await expect(page.getByRole("heading", { name: "Book a consultation", exact: true })).toBeVisible(); await callback(page, stateFor(name)); passed++; console.log(`PASS ${name}`); } finally { await context.close(); }
  }
  async function select(page, state) {
    await page.getByLabel("Appointment date", { exact: true }).fill("2027-02-15");
    await page.getByRole("button", { name: "Find available times", exact: true }).click();
    await expect(page.getByText("Confirm the visit address before checking travel and availability.", { exact: true })).toBeVisible();
    assert.equal(state.calls.filter(c => c.operation === "availability").length, 0);
    await page.getByLabel("Visit address", { exact: true }).fill("SYNTHETIC complete visit address"); await page.getByRole("checkbox", { name: "I confirm this complete, unambiguous visit address.", exact: true }).check();
    await page.getByRole("button", { name: "Find available times", exact: true }).click();
    await expect(page.getByText("Choose one of the times returned by the booking service.", { exact: true })).toBeVisible();
    const slot = page.getByRole("button", { name: /15 Feb 2027.*10:00.*Europe\/Vienna/ }); await slot.click();
    await expect(page.getByText("Time selected; no appointment has been booked.", { exact: true })).toBeVisible(); assert.equal(state.booking, null);
    await page.getByRole("button", { name: "Review this appointment", exact: true }).click();
    await expect(page.getByRole("button", { name: "Confirm this appointment", exact: true })).toBeDisabled();
    assert.equal(state.booking.state, "held"); assert.equal(state.calls.filter(c => c.operation === "confirm").length, 0);
    await expect(page.locator("dl")).toContainText("Europe/Vienna"); await expect(page.locator("dl")).toContainText("Visit at your address"); await expect(page.locator("dl")).toContainText("SYNTHETIC complete visit address");
  }
  async function confirm(page) { await page.getByRole("checkbox", { name: "I agree to book this exact date, time, time zone, appointment type and place.", exact: true }).check(); await page.getByRole("button", { name: "Confirm this appointment", exact: true }).click(); }
  await scenario("contact_step_hidden_until_service_slot_selected", async page => {
    await expect(page.getByLabel("Your name", { exact: true })).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Review this appointment", exact: true })).not.toBeVisible();
  });
  await scenario("desktop_complete_lifecycle", async (page, state) => {
    await select(page, state); await confirm(page); await expect(page.getByText("Your appointment is confirmed by the booking service.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Reschedule this appointment", exact: true }).click(); await page.getByRole("button", { name: "Find replacement times", exact: true }).click();
    await page.getByRole("button", { name: /Monday.*15 February 2027.*12:00.*Europe\/Vienna/ }).click();
    await expect(page.getByRole("button", { name: "Confirm reschedule", exact: true })).toBeDisabled();
    await page.getByRole("checkbox", { name: "I agree to reschedule this appointment to the exact date, time, time zone, type and place shown.", exact: true }).check(); await page.getByRole("button", { name: "Confirm reschedule", exact: true }).click();
    await expect(page.getByText("Your appointment is confirmed by the booking service.", { exact: true })).toBeVisible(); assert.equal(state.booking.startsAt, nextAt); assert.equal(state.calls.filter(c => c.operation === "availability").at(-1).payload.bookingId, state.booking.id);
    await page.getByRole("button", { name: "Cancel this appointment", exact: true }).click(); await expect(page.getByRole("button", { name: "Confirm cancellation", exact: true })).toBeDisabled();
    await page.getByRole("checkbox", { name: "I agree to cancel this exact appointment.", exact: true }).check(); await page.getByRole("button", { name: "Confirm cancellation", exact: true }).click(); await expect(page.getByText("Your appointment has been cancelled by the booking service.", { exact: true })).toBeVisible();
  });
  await scenario("mobile_explicit_confirmation", async (page, state) => {
    await select(page, state); await confirm(page); await expect(page.getByText("Your appointment is confirmed by the booking service.", { exact: true })).toBeVisible();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }, true);
  await scenario("unknown_confirm_status_and_reopen", async (page, state) => {
    await select(page, state); await confirm(page); await expect(page.getByText("Booking outcome is awaiting verification.", { exact: true })).toBeVisible();
    assert.equal(state.calls.filter(c => c.operation === "confirm").length, 1);
    await page.getByRole("button", { name: "Check this same booking", exact: true }).click(); await expect(page.getByText("Your appointment is confirmed by the booking service.", { exact: true })).toBeVisible();
    assert.equal(state.calls.filter(c => c.operation === "confirm").length, 1);
    await page.getByRole("button", { name: "Back to your enquiry", exact: true }).click(); await page.getByRole("button", { name: "Open saved booking", exact: true }).click(); await expect(page.getByText("Your appointment is confirmed by the booking service.", { exact: true })).toBeVisible();
    assert.equal(state.calls.filter(c => c.operation === "hold").length, 1); assert.equal(state.calls.filter(c => c.operation === "confirm").length, 1);
  });
  await scenario("changed_address_requires_new_explicit_confirmation", async (page, state) => {
    await page.getByLabel("Visit address", { exact: true }).fill("SYNTHETIC first complete address"); await page.getByRole("checkbox", { name: "I confirm this complete, unambiguous visit address.", exact: true }).check();
    await page.getByLabel("Visit address", { exact: true }).fill("SYNTHETIC different complete address"); await page.getByLabel("Appointment date", { exact: true }).focus();
    await expect(page.getByRole("checkbox", { name: "I confirm this complete, unambiguous visit address.", exact: true })).not.toBeChecked();
    await page.getByRole("button", { name: "Find available times", exact: true }).click(); assert.equal(state.calls.filter(c => c.operation === "availability").length, 0);
  });
  assert.deepEqual(pageErrors, []); assert.deepEqual(external, []);
  const result = { classification, passed, pageErrors: pageErrors.length, externalRequests: external.length };
  const resultPath = resolve(repository, ".npm-cache/qa/booking-studio-ui/result.json"); await mkdir(dirname(resultPath), { recursive: true }); await writeFile(resultPath, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 }); console.log(JSON.stringify(result));
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
