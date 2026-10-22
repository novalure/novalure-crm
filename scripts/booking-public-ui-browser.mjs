// LOCAL_UI_WITH_SYNTHETIC_HTTP: actual React components and embed loader in
// Chromium. This is not authentication, database, provider or hosted acceptance.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
import { bookingEmbedScript, buildBookingEmbedCode } from "../src/lib/booking/embed-runtime.ts";
import { bookingFrameAncestors } from "../src/lib/booking/public-frame-policy.ts";

const classification = "LOCAL_UI_WITH_SYNTHETIC_HTTP";
const root = resolve(import.meta.dirname, "..");
const fixture = await mkdtemp(join(tmpdir(), "booking-public-ui-"));
const publicId = "synthetic_booking_publication";
const typeId = "00000000-0000-4000-8000-000000000001";
const nextAt = "2027-02-15T11:00:00.000Z";
let browser, bookingServer, parentServer, forbiddenServer;
let passes = 0;
const errors = [];
const blocked = [];

function installSyntheticBooking() {
  const config = window.syntheticPublication;
  const calls = [];
  let booking = null, failOnce = new URL(location.href).searchParams.get("scenario") === "unknown";
  let admin = { publication: { ...config, enabled: true, assignments: [{ id: config.types[0].id, organizerId: "synthetic-employee", kind: "phone", provider: "google" }] }, revision: 1, employees: [{ id: "synthetic-employee", name: "SYNTHETIC employee" }], readiness: { canPublish: true, assignments: [{ id: config.types[0].id, calendar: true, maps: true, mail: true, ready: true, errors: [] }] }, bookingUrl: location.origin + "/appointments/" + config.publicId, embedOrigin: location.origin };
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  window.syntheticBooking = { inspect: () => ({ calls: structuredClone(calls), booking: structuredClone(booking), admin: structuredClone(admin) }) };
  window.fetch = async (input, init = {}) => {
    const url = new URL(String(input), location.href);
    if (url.origin !== location.origin) throw new Error("External fixture fetch denied");
    const method = init.method || "GET", body = init.body ? JSON.parse(init.body) : null;
    if (url.pathname === "/api/auth/csrf") return json({ csrfToken: "SYNTHETIC-CSRF-NOT-AUTHENTICATION" });
    const action = url.pathname.split("/").at(-1);
    calls.push({ action, method, body, credentials: init.credentials, authorization: new Headers(init.headers).get("authorization") });
    if (url.pathname === "/api/booking/publication") {
      if (method === "PUT") {
        if (body.expectedRevision !== admin.revision) return json({ error: "BOOKING_PUBLICATION_CONFLICT" }, 409);
        admin.publication = body.publication; admin.revision++;
        if (admin.publication.title === "SYNTHETIC activation failure" && admin.publication.enabled) {
          admin.publication.enabled = false; admin.readiness.canPublish = false;
          admin.readiness.assignments[0].ready = false; admin.readiness.assignments[0].mail = false;
          return json({ error: "PUBLICATION_NOT_READY" }, 409);
        }
      }
      return json(admin);
    }
    if (action === config.publicId) return json(config);
    if (action === "sessions") return json({ token: "SYNTHETIC-SESSION-NOT-AUTHENTICATION", expiresAt: "2099-01-01T00:00:00.000Z", publication: config });
    if (action === "availability") return json({ slots: [{ startsAt: "2027-02-15T09:00:00.000Z", endsAt: "2027-02-15T09:30:00.000Z" }, { startsAt: "2027-02-15T11:00:00.000Z", endsAt: "2027-02-15T11:30:00.000Z" }], timeZone: "Europe/Vienna", durationMinutes: 30, requestFallback: false, travelIssues: [] });
    if (action === "hold") {
      booking = { id: "00000000-0000-4000-8000-000000000002", state: "held", kind: config.types[0].kind, startsAt: body.startsAt, endsAt: new Date(Date.parse(body.startsAt) + 1_800_000).toISOString(), timeZone: "Europe/Vienna", videoUrl: null, videoStatus: "not_requested", notificationStatus: "not_requested", location: body.location || config.types[0].location };
      if (failOnce) { failOnce = false; throw new TypeError("Synthetic response lost after server reservation"); }
      return json({ booking });
    }
    if (action === "status") return json({ booking });
    if (action === "confirm") { booking.state = "confirmed"; booking.videoStatus = "pending"; booking.notificationStatus = "sent"; return json({ booking }); }
    if (action === "reschedule") { booking.startsAt = body.startsAt; booking.endsAt = new Date(Date.parse(body.startsAt) + 1_800_000).toISOString(); return json({ booking }); }
    if (action === "cancel") { booking.state = "cancelled"; return json({ booking }); }
    throw new Error("Unexpected synthetic action");
  };
}

async function listen(server) { server.listen(0, "127.0.0.1"); await once(server, "listening"); return `http://127.0.0.1:${server.address().port}`; }
function close(server) { return server ? new Promise(resolve => server.close(resolve)) : Promise.resolve(); }
const style = `<style>body{font:16px system-ui;margin:16px}button,input,select,textarea{font:inherit;max-width:100%;box-sizing:border-box;min-height:44px}button{padding:8px;margin:3px}label{display:block;margin:8px 0}fieldset{min-width:0;border:0;padding:0}input:not([type=checkbox]),select,textarea{display:block;width:100%}input[type=checkbox]{vertical-align:middle}section{margin:12px 0;padding:12px;border:1px solid #ddd}form{max-width:720px;margin:auto}p{overflow-wrap:anywhere}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}</style>`;

try {
  const entry = `import React from 'react'; import {createRoot} from 'react-dom/client';
    import {PublicBookingForm} from './src/components/public-booking-form.tsx';
    import {FormBookingField} from './src/components/form-booking-field.tsx';
    import {BookingPublicationPanel} from './src/components/booking-publication-panel.tsx';
    (${installSyntheticBooking.toString()})();
    const config=window.syntheticPublication, params=new URLSearchParams(location.search), language=params.get('lang')||'de';
    createRoot(document.getElementById('root')).render(location.pathname==='/admin'?<BookingPublicationPanel language={language}/>:location.pathname==='/form'?<form id="customer-form" onSubmit={event=>event.preventDefault()}><FormBookingField field={{id:'appointment',label:'Appointment',type:'booking',required:true,bookingRequired:true,bookingPublicId:config.publicId}} language={language}/><button type="submit">Send parent form</button></form>:<PublicBookingForm publicId={config.publicId} channel={params.get('channel')||'link'} initialLanguage={language} initialPublication={config}/>);`;
  await build({ stdin: { contents: entry, loader: "tsx", resolveDir: root, sourcefile: "synthetic-public-booking-ui.tsx" }, absWorkingDir: root, bundle: true, platform: "browser", format: "iife", jsx: "automatic", tsconfig: join(root, "tsconfig.json"), define: { "process.env.NODE_ENV": '"production"' }, outfile: join(fixture, "fixture.js"), logLevel: "silent" });
  const bundle = await readFile(join(fixture, "fixture.js"));
  let parentOrigin = "";
  const publication = () => ({ publicId, title: "SYNTHETIC booking", description: "SYNTHETIC UI fixture", appearance: "light", language: "auto", allowedOrigins: [parentOrigin], channels: { link: true, inline: true, popup: true, form: true, chat: false, voice: false }, types: [{ id: typeId, kind: "phone", durationMinutes: 30, timeZone: "Europe/Vienna", locationRequired: false, location: "" }] });
  bookingServer = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/fixture.js" || url.pathname === "/appointments/embed.js") { res.writeHead(200, { "content-type": "text/javascript" }); res.end(url.pathname === "/fixture.js" ? bundle : bookingEmbedScript); return; }
    if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
    const config = publication();
    if (url.searchParams.get("scenario") === "onsite") config.types[0] = { ...config.types[0], kind: "onsite", locationRequired: true };
    res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store", ...(url.pathname.startsWith("/appointments/") ? { "content-security-policy": bookingFrameAncestors(config.allowedOrigins, true) } : {}) });
    res.end(`<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic public booking</title>${style}<div id="root"></div><script>window.syntheticPublication=${JSON.stringify(config).replaceAll("<", "\\u003c")};</script><script src="/fixture.js"></script></html>`);
  });
  const bookingOrigin = await listen(bookingServer);
  function parentHtml(req, expectedOrigin) {
    const url = new URL(req.url, expectedOrigin), mode = url.searchParams.get("mode") || "inline";
    let embed = buildBookingEmbedCode({ origin: bookingOrigin, publicId, mode, language: url.searchParams.get("auto") ? "auto" : "en" });
    if (mode === "form") embed = `<iframe title="Embedded form booking" src="${bookingOrigin}/appointments/${publicId}?channel=form&embed=1&lang=en&parentOrigin=${encodeURIComponent(expectedOrigin)}&instanceId=synthetic_form_instance"></iframe><script>window.syntheticProof=null;const frame=document.querySelector('iframe');addEventListener('message',event=>{if(event.origin!==${JSON.stringify(bookingOrigin)}||event.source!==frame.contentWindow||event.data?.version!==1||event.data.instanceId!=='synthetic_form_instance')return;if(event.data.type==='novalure.booking.hello')frame.contentWindow.postMessage({type:'novalure.booking.initialize',version:1,instanceId:'synthetic_form_instance'},${JSON.stringify(bookingOrigin)});if(event.data.type==='novalure.booking.confirmed'&&event.data.publicId===${JSON.stringify(publicId)})window.syntheticProof={bookingId:event.data.bookingId,tokenPresent:typeof event.data.sessionToken==='string'&&event.data.sessionToken.length>20};if(event.data.type==='novalure.booking.cleared')window.syntheticProof=null;});</script>`;
    if (url.searchParams.get("wrongParent")) embed = `<iframe title="Wrong parent" src="${bookingOrigin}/appointments/${publicId}?channel=inline&embed=1&lang=en&parentOrigin=${encodeURIComponent("https://wrong.example.com")}&instanceId=synthetic_instance"></iframe>`;
    return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${style}${embed}</html>`;
  }
  parentServer = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(parentHtml(req, parentOrigin)); });
  parentOrigin = await listen(parentServer);
  forbiddenServer = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(parentHtml(req, "http://127.0.0.1")); });
  const forbiddenOrigin = await listen(forbiddenServer);
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], ...(process.env.CRM_QA_CHROMIUM_PATH ? { executablePath: process.env.CRM_QA_CHROMIUM_PATH } : existsSync("/usr/bin/chromium") ? { executablePath: "/usr/bin/chromium" } : {}) });

  async function scenario(name, run, { mobile = false } = {}) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 1000 }, serviceWorkers: "block" });
    await context.route("**/*", route => {
      if ([bookingOrigin, parentOrigin, forbiddenOrigin].includes(new URL(route.request().url()).origin)) return route.continue();
      blocked.push("Unexpected external browser request"); return route.abort();
    });
    const page = await context.newPage(); page.setDefaultTimeout(10_000); page.on("pageerror", () => errors.push("Synthetic fixture page error"));
    try { await run(page); passes++; console.log(`PASS ${name}`); } finally { await context.close(); }
  }
  const inspect = page => page.evaluate(() => window.syntheticBooking.inspect());
  async function selectTime(page, lang = "de") {
    await page.getByLabel(lang === "de" ? "Datum" : "Date", { exact: true }).fill("2027-02-15");
    await page.getByRole("button", { name: lang === "de" ? "Freie Zeiten anzeigen" : "Show available times", exact: true }).click();
    const slots = page.getByRole("group", { name: lang === "de" ? "Freie Startzeit auswählen" : "Choose an available start time", exact: true });
    await slots.getByRole("button").first().click();
    await page.getByLabel(lang === "de" ? "Ihr Name" : "Your name", { exact: true }).fill("SYNTHETIC visitor");
    await page.getByLabel(lang === "de" ? "Ihre E-Mail-Adresse" : "Your email address", { exact: true }).fill("synthetic@example.com");
  }
  async function confirm(page, lang = "de") {
    await page.getByRole("checkbox", { name: lang === "de" ? "Ich möchte diesen Termin zu den angezeigten Angaben verbindlich buchen." : "I want to book this appointment with the details shown.", exact: true }).check();
    await page.getByRole("button", { name: lang === "de" ? "Termin verbindlich buchen" : "Confirm appointment booking", exact: true }).click();
  }
  await scenario("DE selection has no mutation; explicit booking, pending link, reschedule and cancellation", async page => {
    await page.goto(`${bookingOrigin}/`); await selectTime(page);
    assert.deepEqual((await inspect(page)).calls.filter(call => ["hold", "confirm"].includes(call.action)), []);
    await expect(page.getByRole("button", { name: "Termin verbindlich buchen", exact: true })).toBeDisabled();
    await confirm(page);
    await expect(page.getByRole("heading", { name: "Bestätigt", exact: true })).toBeVisible();
    await expect(page.getByText("Ihr Videolink wird noch vom Anbieter erstellt. Sie können den Status erneut prüfen.", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "An Videokonferenz teilnehmen" })).toHaveCount(0);
    let state = await inspect(page); assert.equal(state.calls.filter(c => c.action === "hold").length, 1); assert.equal(state.calls.filter(c => c.action === "confirm").length, 1);
    assert.ok(state.calls.filter(c => ["sessions", "availability", "hold", "confirm"].includes(c.action)).every(c => c.credentials === "omit"));
    assert.equal(await page.evaluate(() => document.cookie), ""); assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    await page.getByRole("button", { name: "Termin umbuchen", exact: true }).click();
    await page.getByRole("button", { name: "Freie Zeiten anzeigen", exact: true }).click();
    await page.getByRole("group", { name: "Freie Startzeit auswählen", exact: true }).getByRole("button").last().click();
    await expect(page.getByRole("button", { name: "Umbuchung bestätigen", exact: true })).toBeDisabled();
    await page.getByRole("checkbox", { name: "Ich möchte meinen Termin auf die ausgewählte Zeit umbuchen.", exact: true }).check();
    await page.getByRole("button", { name: "Umbuchung bestätigen", exact: true }).click();
    await expect(page.getByText("Ihr Termin wurde umgebucht.", { exact: true })).toBeVisible();
    state = await inspect(page); assert.equal(state.booking.startsAt, nextAt); assert.equal(state.calls.filter(c => c.action === "availability").at(-1).body.bookingId, state.booking.id);
    await page.getByRole("button", { name: "Termin absagen", exact: true }).click();
    assert.equal((await inspect(page)).calls.filter(c => c.action === "cancel").length, 0);
    await page.getByRole("checkbox", { name: "Ich möchte diesen Termin absagen.", exact: true }).check();
    await page.getByRole("button", { name: "Absage bestätigen", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Abgesagt", exact: true })).toBeVisible();
  });
  await scenario("Unknown reservation result reconciles the same operation without a second hold", async page => {
    await page.goto(`${bookingOrigin}/?scenario=unknown`); await selectTime(page); await confirm(page);
    await expect(page.getByText("Das Ergebnis ist noch nicht abschließend bekannt. Bitte den Status prüfen; keine zweite Buchung anlegen.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Buchungsstatus prüfen", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Reserviert", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Reservierung verbindlich bestätigen", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Bestätigt", exact: true })).toBeVisible();
    const state = await inspect(page); assert.equal(state.calls.filter(c => c.action === "hold").length, 1); assert.equal(state.calls.filter(c => c.action === "status").at(-1).body.idempotencyKey, state.calls.find(c => c.action === "hold").body.idempotencyKey);
  });
  await scenario("EN mobile uses separate appointment time zone and rejects invalid contact", async page => {
    await page.goto(`${bookingOrigin}/?lang=en`); await selectTime(page, "en");
    await expect(page.getByText("Appointment time zone:", { exact: false })).toContainText("Europe/Vienna");
    await page.getByLabel("Your email address", { exact: true }).fill("invalid-address"); await confirm(page, "en");
    assert.equal((await inspect(page)).calls.filter(c => c.action === "hold").length, 0);
    await page.getByLabel("Your email address", { exact: true }).fill("synthetic@example.com"); await confirm(page, "en");
    await expect(page.getByRole("heading", { name: "Confirmed", exact: true })).toBeVisible();
  }, { mobile: true });
  await scenario("Onsite availability is blocked until explicit address confirmation", async page => {
    await page.goto(`${bookingOrigin}/?scenario=onsite`); await page.getByLabel("Datum", { exact: true }).fill("2027-02-15");
    await expect(page.getByRole("button", { name: "Freie Zeiten anzeigen", exact: true })).toBeDisabled();
    await page.getByLabel("Vollständige Besuchsadresse", { exact: true }).fill("SYNTHETIC approved visit address");
    await expect(page.getByRole("button", { name: "Freie Zeiten anzeigen", exact: true })).toBeDisabled();
    await page.getByRole("checkbox", { name: "Ich bestätige diese eindeutige Adresse für den Besuch.", exact: true }).check();
    await page.getByRole("button", { name: "Freie Zeiten anzeigen", exact: true }).click();
    await expect(page.getByRole("group", { name: "Freie Startzeit auswählen", exact: true })).toBeVisible();
    assert.equal((await inspect(page)).calls.find(c => c.action === "availability").body.locationConfirmed, true);
    await page.getByLabel("Vollständige Besuchsadresse", { exact: true }).fill("SYNTHETIC changed address");
    await expect(page.getByRole("checkbox", { name: "Ich bestätige diese eindeutige Adresse für den Besuch.", exact: true })).not.toBeChecked();
  });
  await scenario("React booking field has one parent form and emits proof only after confirmation", async page => {
    await page.goto(`${bookingOrigin}/form?lang=en`); await selectTime(page, "en");
    assert.equal(await page.locator("form").count(), 1); await expect(page.locator('input[name="booking_appointment_token"]')).toHaveValue("");
    await confirm(page, "en"); await expect(page.getByRole("heading", { name: "Confirmed", exact: true })).toBeVisible();
    await expect(page.locator('input[name="booking_appointment_id"]')).toHaveValue("00000000-0000-4000-8000-000000000002");
    await expect(page.locator('input[name="booking_appointment_token"]')).toHaveValue("SYNTHETIC-SESSION-NOT-AUTHENTICATION");
    assert.equal((await inspect(page)).calls.find(c => c.action === "sessions").body.channel, "form");
    await page.getByRole("button", { name: "Cancel appointment", exact: true }).click(); await page.getByRole("checkbox", { name: "I want to cancel this appointment.", exact: true }).check(); await page.getByRole("button", { name: "Confirm cancellation", exact: true }).click();
    await expect(page.locator('input[name="booking_appointment_token"]')).toHaveValue("");
  });
  await scenario("Publication persists config, generates saved artifacts and refreshes rejected activation revision", async page => {
    await page.goto(`${bookingOrigin}/admin?lang=en`);
    await page.getByLabel("Booking page name", { exact: true }).fill("SYNTHETIC changed title");
    await page.getByRole("button", { name: "Save publication", exact: true }).click();
    await expect(page.getByText("Publication saved and loaded again.", { exact: true })).toBeVisible();
    const state = await inspect(page); assert.equal(state.admin.revision, 2); assert.equal(state.admin.publication.title, "SYNTHETIC changed title");
    await expect(page.getByLabel("Inline embed code", { exact: true })).toContainText("/appointments/embed.js");
    await page.getByLabel("Booking page name", { exact: true }).fill("SYNTHETIC activation failure"); await page.getByRole("button", { name: "Save publication", exact: true }).click();
    await expect(page.getByRole("checkbox", { name: "Publish selected booking channels", exact: true })).not.toBeChecked();
    const after = await inspect(page); assert.equal(after.admin.revision, 3); assert.equal(after.calls.at(-1).method, "GET");
    await expect(page.getByRole("link", { name: "Open public preview & test booking", exact: true })).toHaveCount(0);
  });
  await scenario("Allowed inline parent completes exact handshake and rejects spoofed source, origin and instance", async page => {
    await page.goto(parentOrigin); const host = page.locator("[data-novalure-booking]"); await expect(host).toHaveAttribute("data-novalure-booking-ready", "1");
    const frame = page.frameLocator("iframe"); await expect(frame.getByLabel("Date", { exact: true })).toBeVisible();
    const before = await page.locator("iframe").evaluate(element => element.style.height);
    await page.evaluate(({ bookingOrigin }) => { const frame = document.querySelector("iframe"), instanceId = frame.getAttribute("data-novalure-booking-frame"); for (const [origin, source, id] of [["https://wrong.example.com", frame.contentWindow, instanceId], [bookingOrigin, window, instanceId], [bookingOrigin, frame.contentWindow, "wrong-instance"]]) window.dispatchEvent(new MessageEvent("message", { origin, source, data: { type: "novalure.booking.resize", version: 1, instanceId: id, height: 1777 } })); }, { bookingOrigin });
    assert.equal(await page.locator("iframe").evaluate(element => element.style.height), before);
    await selectTime(frame, "en"); await confirm(frame, "en"); await expect(frame.getByRole("heading", { name: "Confirmed", exact: true })).toBeVisible();
  });
  await scenario("Embedded form sends bounded booking proof only to its initialized parent and clears on cancel", async page => {
    await page.goto(`${parentOrigin}/?mode=form`); const frame = page.frameLocator("iframe");
    await selectTime(frame, "en"); assert.equal(await page.evaluate(() => window.syntheticProof), null);
    await confirm(frame, "en"); await expect(frame.getByRole("heading", { name: "Confirmed", exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.syntheticProof?.tokenPresent)).toBe(true);
    assert.equal(await page.evaluate(() => window.syntheticProof.bookingId), "00000000-0000-4000-8000-000000000002");
    await frame.getByRole("button", { name: "Cancel appointment", exact: true }).click(); await frame.getByRole("checkbox", { name: "I want to cancel this appointment.", exact: true }).check(); await frame.getByRole("button", { name: "Confirm cancellation", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.syntheticProof)).toBe(null);
  });
  await scenario("Popup opens accessibly and returns keyboard focus on close", async page => {
    await page.goto(`${parentOrigin}/?mode=popup&auto=1`); await page.getByRole("button", { name: "Book an appointment", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Book an appointment", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible(); await expect(page.getByRole("button", { name: "Book an appointment", exact: true })).toBeFocused();
  });
  await scenario("Approved actual parent with false declared origin cannot initialize the child", async page => {
    await page.goto(`${parentOrigin}/?wrongParent=1`); const frame = page.frameLocator("iframe");
    await expect(frame.getByText("This website is not approved to embed the booking form.", { exact: false })).toBeVisible();
    const child = page.frames().find(frame => frame.url().startsWith(bookingOrigin)); assert.ok(child);
    assert.equal((await inspect(child)).calls.filter(c => c.action === "sessions").length, 0);
  });
  await scenario("CSP blocks an unapproved actual parent before public session requests", async page => {
    await page.goto(forbiddenOrigin); await expect(page.locator("[data-novalure-booking]")).not.toHaveAttribute("data-novalure-booking-ready", "1");
    assert.equal(await page.locator('iframe').count(), 1);
    const child = page.frames().find(frame => frame.url().startsWith(bookingOrigin)); assert.equal(child, undefined);
  });
  assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
  const result = { classification, passed: passes, externalRequests: blocked.length, pageErrors: errors.length };
  const resultPath = resolve(root, ".npm-cache/qa/booking-public-ui/result.json");
  await mkdir(dirname(resultPath), { recursive: true }); await writeFile(resultPath, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(result));
} finally {
  await browser?.close(); await Promise.all([close(bookingServer), close(parentServer), close(forbiddenServer)]); await rm(fixture, { recursive: true, force: true });
}
