import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";

// Local real React components and session store, synthetic HTTP only.
// This suite does not attest provider access, actual OAuth, API/SQL or live use.
const w = "11111111-1111-4111-8111-111111111111", otherW = "44444444-4444-4444-8444-444444444444";
const actor = "22222222-2222-4222-8222-222222222222", otherActor = "55555555-5555-4555-8555-555555555555";
const eventId = "33333333-3333-4333-8333-333333333333", projectId = "66666666-6666-4666-8666-666666666666";
const otherProjectId = "99999999-9999-4999-8999-999999999999";
const compiled = await build({ stdin: { contents: `
import React from'react';import{createRoot}from'react-dom/client';
import{PersonalCalendarWorkspace}from'./src/components/personal-calendar-workspace';
import{usePersonalCalendarSessionStore}from'./src/lib/personal-calendar-client-store';
const root=createRoot(document.getElementById('root'));let visible=true,workspaceId='${w}',sessionUserId='${actor}',activeProjectId='${projectId}';
function Harness(){const store=usePersonalCalendarSessionStore(sessionUserId);window.calendarStore=store;return visible?<PersonalCalendarWorkspace workspaceId={workspaceId} sessionUserId={sessionUserId} language="de" activeProjectId={activeProjectId} projects={[{id:activeProjectId,name:'SYNTHETIC project'}]} store={store}/>:<p>Section closed</p>}
const render=()=>root.render(<React.StrictMode><Harness/></React.StrictMode>);window.showCalendar=value=>{visible=value;render()};window.scopeCalendar=(workspace,user)=>{workspaceId=workspace;sessionUserId=user;render()};window.filterCalendar=id=>{activeProjectId=id;render()};render();`, resolveDir: process.cwd(), loader: "tsx" }, bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"test"' }, logLevel: "silent" });
const server = createServer((request, response) => {
  response.setHeader("content-type", request.url === "/bundle.js" ? "application/javascript" : "text/html");
  response.end(request.url === "/bundle.js" ? compiled.outputFiles[0].text : '<!doctype html><html><body><main id="root"></main><script src="/bundle.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ channel: process.env.CRM_QA_BROWSER_CHANNEL || "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, timezoneId: "Europe/Vienna" });
const page = await context.newPage(), errors = [], results = [], requests = [];
let events = [], behaviour = "synced", requestGate = null, currentActor = actor, connectionConnected = true;
const connections = () => ["microsoft", "google"].map(provider => ({ id: provider === "microsoft" ? "77777777-7777-4777-8777-777777777777" : "88888888-8888-4888-8888-888888888888", userId: currentActor, provider, connected: connectionConnected, status: connectionConnected ? "connected" : "disconnected", accountLabel: `${provider}@example.invalid`, revision: 1, writeCalendarId: "writer", conflictCalendarIds: ["read-only"], calendars: [{ id: "writer", name: "SYNTHETIC writable calendar", canRead: true, canWrite: true, protectedReadOnly: false }, { id: "read-only", name: "SYNTHETIC protected calendar", canRead: true, canWrite: false, protectedReadOnly: true }] }));
const draft = { title: "SYNTHETIC calendar event", startsAt: "2026-11-15T09:00:00.000Z", endsAt: "2026-11-15T10:00:00.000Z", timeZone: "Europe/Vienna", location: "SYNTHETIC test room", projectId, attendees: [] };
function record(value = draft, changes = {}) {
  return { id: eventId, origin: "personal_standalone", provider: "microsoft", event: value, version: 1, state: "synced", providerEventId: "SYNTHETIC-provider-event", providerEtag: "SYNTHETIC-etag-1", remoteSnapshot: { verifiedAt: "2026-11-04T12:00:00Z", eventId: "SYNTHETIC-provider-event", etag: "SYNTHETIC-etag-1", cancelled: false, ...value }, errorCode: null, canEdit: true, canCancel: true, canImport: false, ...changes };
}
page.on("pageerror", error => errors.push(error.message));
await context.route("**/api/**", async route => {
  const request = route.request(), url = new URL(request.url());
  if (url.pathname === "/api/auth/csrf") return route.fulfill({ json: { csrfToken: "SYNTHETIC-CSRF" } });
  assert.equal(url.pathname, "/api/crm/personal-calendar");
  assert.ok([w, otherW].includes(url.searchParams.get("workspaceId")));
  const targetActor = url.searchParams.get("workspaceId") === otherW ? otherActor : currentActor;
  if (request.method() === "GET") return route.fulfill({ json: { workspaceId: url.searchParams.get("workspaceId"), actorId: targetActor, events, connections: connections().map(connection => ({ ...connection, userId: targetActor })), recurrence: { creationSupported: false, busyInstancesRead: true } } });
  assert.equal(request.method(), "POST");
  const body = request.postDataJSON(); requests.push({ workspaceId: url.searchParams.get("workspaceId"), body });
  if (requestGate) await requestGate;
  if (behaviour === "network") { behaviour = "synced"; return route.abort("failed"); }
  if (behaviour === "malformed") { behaviour = "synced"; return route.fulfill({ json: { ok: true } }); }
  if (behaviour === "invalid") { behaviour = "synced"; return route.fulfill({ status: 400, json: { error: "personal_calendar_invalid_event", notStarted: true } }); }
  if (behaviour === "denied") { behaviour = "synced"; return route.fulfill({ status: 403, json: { error: "personal_calendar_forbidden" } }); }
  if (["refresh_calendars", "select_calendar"].includes(body.action)) return route.fulfill({ json: { connection: { ...connections().find(connection => connection.provider === body.provider), userId: targetActor } } });
  let event = body.action === "create" ? record(body.event) : events.find(event => event.id === body.eventId);
  if (body.action === "update") {
    if (body.expectedVersion !== event.version) return route.fulfill({ status: 409, json: { error: "personal_calendar_version_conflict", notStarted: true } });
    event = record(body.event, { version: event.version + 1 });
  }
  if (body.action === "cancel") event = { ...event, state: "cancelled", canEdit: false, canCancel: false, version: event.version + 1, remoteSnapshot: event.providerEventId ? { ...event.remoteSnapshot, cancelled: true } : null };
  if (body.action === "import_remote") event = event.remoteSnapshot.cancelled ? { ...event, version: event.version + 1, state: "cancelled", canEdit: false, canImport: false } : record({ ...event.event, title: event.remoteSnapshot.title }, { version: event.version + 1 });
  if (behaviour === "processing") { event = { ...event, state: "processing", canEdit: false, providerEventId: null, remoteSnapshot: null }; behaviour = "synced"; }
  if (behaviour === "unverified") { event = { ...event, remoteSnapshot: null }; behaviour = "synced"; }
  events = [event]; return route.fulfill({ json: { event } });
});
const form = page.locator("form");
const title = () => form.getByRole("textbox", { name: "Titel", exact: true });
async function open(seed = [], ready = true, connected = true) {
  events = seed; requests.length = 0; behaviour = "synced"; requestGate = null; currentActor = actor; connectionConnected = connected;
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await expect(page.getByRole("heading", { name: "Persönlicher Kalender", exact: true })).toBeVisible();
  if (ready) await expect(form.getByRole("button", { name: "Termin prüfen und anlegen", exact: true })).toBeEnabled();
}
async function fill() {
  await title().fill("SYNTHETIC calendar event");
  await form.getByLabel("Beginn", { exact: true }).fill("2026-11-15T10:00");
  await form.getByLabel("Ende", { exact: true }).fill("2026-11-15T11:00");
}
const create = () => form.getByRole("button", { name: "Termin prüfen und anlegen", exact: true }).click();
async function remount() { await page.evaluate(() => window.showCalendar(false)); await expect(page.getByText("Section closed")).toBeVisible(); await page.evaluate(() => window.showCalendar(true)); await expect(title()).toBeVisible(); }
async function step(name, run) { await run(); results.push({ name, status: "PASS" }); console.log("PASS " + name); }
try {
  await step("scoped personal connection selection excludes protected writers and states honest series scope", async () => {
    await open(); assert.equal(await page.locator('a[href^="/api/crm/personal-calendar/connect/"]').count(), 2);
    for (const select of await page.getByRole("combobox", { name: "Schreibkalender", exact: true }).all()) { assert.equal(await select.getByRole("option", { name: "SYNTHETIC protected calendar", exact: true }).count(), 0); }
    await expect(page.getByText(/Serientermine werden hier nicht angelegt/)).toBeVisible();
  });
  await step("a location-only draft is protected on unload while a fully reverted form is clean", async () => {
    await open(); const isProtected = () => page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })));
    assert.equal(await isProtected(), false); await form.getByRole("textbox", { name: "Ort", exact: true }).fill("SYNTHETIC location-only draft"); assert.equal(await isProtected(), true);
    await remount(); await expect(form.getByRole("textbox", { name: "Ort", exact: true })).toHaveValue("SYNTHETIC location-only draft"); await form.getByRole("textbox", { name: "Ort", exact: true }).fill(""); assert.equal(await isProtected(), false);
  });
  await step("create sends explicit zone-correct UTC, provider, project and stable command ID; verified readback alone confirms", async () => {
    await open(); await fill(); await create(); await expect(title()).toHaveValue("");
    assert.equal(requests.length, 1); const { body, workspaceId } = requests[0]; assert.equal(workspaceId, w); assert.equal(body.expectedActorId, actor); assert.equal(body.provider, "microsoft"); assert.equal(body.event.startsAt, "2026-11-15T09:00:00.000Z"); assert.equal(body.event.projectId, projectId); assert.equal(body.event.timeZone, "Europe/Vienna"); assert.match(body.idempotencyKey, /^[\da-f-]{36}$/);
    await expect(page.getByText("Beim Anbieter nachgewiesen", { exact: true })).toBeVisible();
  });
  await step("managed workspace uses the resolved member rather than the home login actor", async () => {
    await open(); await page.evaluate(({ workspace, actor }) => window.scopeCalendar(workspace, actor), { workspace: otherW, actor }); await expect(title()).toBeEnabled(); await fill(); await create(); await expect(title()).toHaveValue("");
    assert.equal(requests[0].workspaceId, otherW); assert.equal(requests[0].body.expectedActorId, otherActor);
  });
  await step("lost or malformed response survives real section unmount with identical explicit replay", async () => {
    for (const problem of ["network", "malformed", "unverified"]) {
      await open(); await fill(); behaviour = problem; await create();
      await expect(page.getByRole("button", { name: "Denselben Vorgang erneut prüfen", exact: true })).toBeEnabled(); await expect(title()).toBeDisabled();
      const original = requests[0]; await remount(); await expect(title()).toHaveValue("SYNTHETIC calendar event"); assert.equal(requests.length, 1);
      await page.getByRole("button", { name: "Denselben Vorgang erneut prüfen", exact: true }).click(); await expect(title()).toHaveValue(""); assert.deepEqual(requests[1], original);
    }
  });
  await step("delayed double submission across remount sends one operation and late success clears only its scope", async () => {
    await open(); await fill(); let release; requestGate = new Promise(resolve => { release = resolve; });
    await form.evaluate(node => { node.requestSubmit(); node.requestSubmit(); }); await expect.poll(() => requests.length).toBe(1); await remount();
    await form.evaluate(node => node.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))); assert.equal(requests.length, 1);
    await page.evaluate(({ workspace, actor }) => window.scopeCalendar(workspace, actor), { workspace: otherW, actor });
    await expect(title()).toHaveValue(""); release(); requestGate = null; await expect(title()).toBeEnabled(); await expect(title()).toHaveValue(""); assert.equal(requests.length, 1);
  });
  await step("late success after same-scope section remount refreshes the active event list automatically", async () => {
    await open(); await fill(); let release; requestGate = new Promise(resolve => { release = resolve; }); await create(); await expect.poll(() => requests.length).toBe(1); await remount();
    await expect(page.getByRole("heading", { name: "SYNTHETIC calendar event", exact: true })).toHaveCount(0);
    release(); requestGate = null; await expect(page.getByRole("heading", { name: "SYNTHETIC calendar event", exact: true })).toBeVisible(); await expect(title()).toHaveValue(""); assert.equal(requests.length, 1);
  });
  await step("a stale project selection cannot be silently retargeted by a new project filter", async () => {
    await open(); await fill(); await page.evaluate(id => window.filterCalendar(id), otherProjectId);
    await create(); assert.equal(requests.length, 0); await expect(page.getByText(/Das gewählte Projekt liegt nicht im aktuellen Filter/)).toBeVisible();
    await form.getByRole("combobox", { name: "Projekt", exact: true }).selectOption(otherProjectId); await create(); await expect(title()).toHaveValue(""); assert.equal(requests[0].body.event.projectId, otherProjectId);
  });
  await step("processing journal result is not success and permits only status reconciliation", async () => {
    await open(); await fill(); behaviour = "processing"; await create(); await expect(title()).toHaveValue("");
    await expect(page.getByText("In Bearbeitung", { exact: true })).toBeVisible(); await expect(page.getByText("Beim Anbieter nachgewiesen", { exact: true })).toHaveCount(0); await expect(title()).toBeDisabled();
    assert.equal(requests.length, 1); await expect(page.getByRole("button", { name: "Beim Anbieter abgleichen", exact: true })).toBeEnabled();
  });
  await step("terminal validation keeps editable inputs but retires the failed intent", async () => {
    await open(); await fill(); behaviour = "invalid"; await create(); await expect(title()).toBeEnabled(); await title().fill("SYNTHETIC corrected"); await create(); await expect(title()).toHaveValue(""); assert.notEqual(requests[0].body.idempotencyKey, requests[1].body.idempotencyKey);
  });
  await step("a permission denial after an unknown result cannot retire the original replay key", async () => {
    await open(); await fill(); behaviour = "network"; await create(); const retry = page.getByRole("button", { name: "Denselben Vorgang erneut prüfen", exact: true }); await expect(retry).toBeEnabled();
    behaviour = "denied"; await retry.click(); await expect(retry).toBeEnabled(); await expect(title()).toBeDisabled();
    await retry.click(); await expect(title()).toHaveValue(""); assert.equal(requests.length, 3); assert.deepEqual(requests[0], requests[1]); assert.deepEqual(requests[1], requests[2]);
  });
  await step("first permission denial without proof of non-start retains the exact command across remount", async () => {
    await open(); await fill(); behaviour = "denied"; await create();
    const retry = page.getByRole("button", { name: "Denselben Vorgang erneut prüfen", exact: true });
    await expect(retry).toBeEnabled(); await expect(title()).toBeDisabled();
    const original = requests[0]; await remount(); await expect(title()).toHaveValue("SYNTHETIC calendar event"); assert.equal(requests.length, 1);
    await retry.click(); await expect(title()).toHaveValue(""); assert.equal(requests.length, 2); assert.deepEqual(requests[1], original);
  });
  await step("editing preserves original optimistic version and attendee names, explicit invitation and cancellation confirmation", async () => {
    await open([record({ ...draft, attendees: [{ email: "recipient@example.invalid", name: "SYNTHETIC recipient" }] })]);
    await page.getByRole("button", { name: "Bearbeiten", exact: true }).click(); await title().fill("SYNTHETIC edited");
    await form.getByRole("checkbox").check(); await form.getByRole("button", { name: "Änderung prüfen und speichern", exact: true }).click(); await expect(title()).toHaveValue("");
    assert.equal(requests[0].body.expectedVersion, 1); assert.equal(requests[0].body.invitationsConfirmed, true); assert.equal(requests[0].body.event.attendees[0].name, "SYNTHETIC recipient");
    await expect(page.getByRole("button", { name: "Termin absagen", exact: true })).toBeDisabled(); await page.getByRole("checkbox", { name: "Absagebenachrichtigung an die oben genannten Empfänger bestätigen.", exact: true }).check();
    await page.getByRole("button", { name: "Termin absagen", exact: true }).click(); await expect(page.getByText("Absage nachgewiesen", { exact: true })).toBeVisible(); assert.equal(requests[1].body.invitationsConfirmed, true);
  });
  await step("removing every attendee retains confirmation of the previous recipient union", async () => {
    await open([record({ ...draft, attendees: [{ email: "recipient@example.invalid", name: "SYNTHETIC recipient" }] })]);
    await page.getByRole("button", { name: "Bearbeiten", exact: true }).click();
    await form.getByRole("textbox", { name: "Empfänger: eine E-Mail-Adresse pro Zeile, höchstens zehn", exact: true }).fill("");
    await expect(form.getByText(/Benachrichtigungen können bisherige und neue Teilnehmer erreichen:.*recipient@example.invalid/)).toBeVisible();
    const save = form.getByRole("button", { name: "Änderung prüfen und speichern", exact: true });
    await save.click(); assert.equal(requests.length, 0);
    await form.getByRole("checkbox").check(); await save.click(); await expect(title()).toHaveValue("");
    assert.deepEqual(requests[0].body.event.attendees, []); assert.equal(requests[0].body.invitationsConfirmed, true);
  });
  await step("text-only edit preserves provider seconds and milliseconds including a DST fold and locks project binding", async () => {
    for (const [startsAt, endsAt] of [["2026-11-15T09:00:30.123Z", "2026-11-15T09:30:45.456Z"], ["2026-10-25T01:30:30.123Z", "2026-10-25T03:00:45.456Z"]]) {
      await open([record({ ...draft, startsAt, endsAt })]); await page.getByRole("button", { name: "Bearbeiten", exact: true }).click(); await title().fill("SYNTHETIC text-only edit");
      await expect(form.getByRole("combobox", { name: "Projekt", exact: true })).toBeDisabled();
      await form.getByRole("button", { name: "Änderung prüfen und speichern", exact: true }).click(); await expect(title()).toHaveValue("");
      assert.equal(requests[0].body.event.startsAt, startsAt); assert.equal(requests[0].body.event.endsAt, endsAt); assert.equal(requests[0].body.event.projectId, projectId);
    }
  });
  await step("external conflict is compared and imported only explicitly with the reviewed ETag", async () => {
    const conflict = record(draft, { state: "conflict", canEdit: false, canImport: true }); conflict.remoteSnapshot = { ...conflict.remoteSnapshot, title: "SYNTHETIC externally changed", etag: "SYNTHETIC-reviewed-etag" };
    await open([conflict]); await expect(page.getByText("SYNTHETIC externally changed", { exact: true })).toBeVisible(); await expect(page.getByRole("button", { name: "Bearbeiten", exact: true })).toBeDisabled(); assert.equal(requests.length, 0);
    await page.getByRole("button", { name: "Diesen geprüften Stand übernehmen", exact: true }).click(); await expect(page.getByText("Beim Anbieter nachgewiesen", { exact: true })).toBeVisible();
    assert.equal(requests[0].body.action, "import_remote"); assert.equal(requests[0].body.remoteEtag, "SYNTHETIC-reviewed-etag"); assert.equal(requests[0].body.event, undefined);
  });
  await step("a reviewed external cancellation can be imported with a null ETag without an outgoing write intent", async () => {
    const cancelled = record(draft, { state: "conflict", canEdit: false, canImport: true }); cancelled.remoteSnapshot = { ...cancelled.remoteSnapshot, cancelled: true, etag: null };
    await open([cancelled]); await page.getByRole("button", { name: "Externe Absage übernehmen", exact: true }).click();
    await expect(page.getByText("Absage nachgewiesen", { exact: true })).toBeVisible(); assert.equal(requests[0].body.action, "import_remote"); assert.equal(requests[0].body.remoteEtag, null); assert.equal(requests[0].body.invitationsConfirmed, false);
  });
  await step("definitively rejected local create can be discarded without a connection or cancellation invitation", async () => {
    await open([record({ ...draft, attendees: [{ email: "recipient@example.invalid", name: "SYNTHETIC recipient" }] }, { state: "failed", canEdit: false, canCancel: true, providerEventId: null, providerEtag: null, remoteSnapshot: null })], false, false);
    await page.getByRole("button", { name: "Lokalen Entwurf verwerfen", exact: true }).click(); await expect(page.getByText("Lokaler Entwurf verworfen", { exact: true })).toBeVisible();
    assert.equal(requests[0].body.action, "cancel"); assert.equal(requests[0].body.invitationsConfirmed, false); await expect(page.getByText("Absage nachgewiesen", { exact: true })).toHaveCount(0);
  });
  await step("reloading changed data never upgrades an open edit's optimistic version", async () => {
    await open([record()]); await page.getByRole("button", { name: "Bearbeiten", exact: true }).click(); await title().fill("SYNTHETIC old form edited");
    events = [record({ ...draft, title: "SYNTHETIC newer server event" }, { version: 2 })]; await page.getByRole("button", { name: "Ansicht aktualisieren", exact: true }).click(); await expect(page.getByRole("heading", { name: "SYNTHETIC newer server event", exact: true })).toBeVisible();
    await form.getByRole("button", { name: "Änderung prüfen und speichern", exact: true }).click(); await expect(title()).toBeEnabled(); assert.equal(requests[0].body.expectedVersion, 1); assert.equal(events[0].version, 2); await expect(title()).toHaveValue("SYNTHETIC old form edited");
  });
  await step("invalid DST gap is blocked and repeated autumn time requires an explicit occurrence", async () => {
    await open(); await fill(); await form.getByLabel("Beginn", { exact: true }).fill("2027-03-28T02:30"); await form.getByLabel("Ende", { exact: true }).fill("2027-03-28T04:00"); await create(); assert.equal(requests.length, 0);
    await form.getByLabel("Beginn", { exact: true }).fill("2026-10-25T02:30"); await form.getByLabel("Ende", { exact: true }).fill("2026-10-25T04:00");
    const choice = form.getByRole("combobox", { name: "Beginn: doppelte Uhrzeit auswählen", exact: true }); await expect(choice).toBeVisible(); await create(); assert.equal(requests.length, 0);
    await choice.selectOption("2026-10-25T01:30:00.000Z"); await create(); await expect(title()).toHaveValue(""); assert.equal(requests[0].body.event.startsAt, "2026-10-25T01:30:00.000Z");
  });
  await step("identity changes discard prior private inputs and pending keys without browser storage", async () => {
    await open(); await fill(); behaviour = "network"; await create(); await expect(title()).toBeDisabled(); currentActor = otherActor;
    await page.evaluate(({ workspace, actor }) => window.scopeCalendar(workspace, actor), { workspace: w, actor: otherActor }); await expect(title()).toHaveValue(""); await expect(page.getByRole("button", { name: "Denselben Vorgang erneut prüfen", exact: true })).toHaveCount(0);
    assert.deepEqual(await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) })), { local: [], session: [] });
  });
  await step("late previous-user success cannot erase the current user's newer form", async () => {
    await open(); await fill(); let release; requestGate = new Promise(resolve => { release = resolve; }); await create(); await expect.poll(() => requests.length).toBe(1);
    currentActor = otherActor; await page.evaluate(({ workspace, actor }) => window.scopeCalendar(workspace, actor), { workspace: w, actor: otherActor }); await expect(title()).toHaveValue(""); await title().fill("SYNTHETIC current user draft");
    release(); requestGate = null; await expect(title()).toHaveValue("SYNTHETIC current user draft"); assert.equal(requests.length, 1);
  });
  await step("booking or unknown provenance is rejected rather than offered as standalone editable data", async () => {
    await open([{ ...record(), origin: "booking" }], false); await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("button", { name: "Bearbeiten", exact: true })).toHaveCount(0); await expect(page.getByRole("button", { name: "Diesen geprüften Stand übernehmen", exact: true })).toHaveCount(0);
  });
  assert.deepEqual(errors, []);
} finally {
  const output = path.resolve(".npm-cache/qa/personal-calendar-ui"); await mkdir(output, { recursive: true });
  await writeFile(path.join(output, "results.json"), JSON.stringify({ realComponents: true, syntheticHttp: true, providerCalls: 0, databaseIntegration: false, results, browserErrors: errors }, null, 2));
  await context.close(); await browser.close(); await new Promise(resolve => server.close(resolve));
}
