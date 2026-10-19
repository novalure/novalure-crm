import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { CalendarCommandCenter } from "../src/components/calendar-command-center.tsx";
import { getCalendarCommandCenterCopy } from "../src/lib/i18n.ts";

const source = await readFile(new URL("../src/components/calendar-command-center.tsx", import.meta.url), "utf8");
const loaderSource = source.slice(source.indexOf("async function loadOAuthStatus()"), source.indexOf("    loadOAuthStatus();"));
const compiledLoader = ts.transpileModule(loaderSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

async function runLoader(response, { rejects = false, cancelled = false, workspaceId = "home" } = {}) {
  const changes = {};
  const loader = vm.runInNewContext(`${compiledLoader}\nloadOAuthStatus`, {
    cancelled,
    workspaceId,
    sessionWorkspaceId: "home",
    fetch: async (url, options) => {
      assert.equal(url, workspaceId === "home" ? "/api/meetings/oauth/status" : `/api/meetings/oauth/status?workspaceId=${encodeURIComponent(workspaceId)}`);
      assert.equal(options.cache, "no-store");
      if (rejects) throw new Error("Network failure");
      return response;
    },
    getCalendarProviderFromSearchParam: () => null,
    mergeOAuthConnectionStatus: (current, status) => ({ ...current, connected: status.connected }),
    normalizeCalendarIntegrationSelection: value => value,
    setCalendarIntegrations: update => { changes.integrations = update({ google: {}, microsoft: {} }); },
    setOAuthStatus: status => { changes.status = status; },
  });
  await loader();
  return changes;
}

test("calendar initially renders an unknown connection state in both languages", () => {
  for (const language of ["de", "en"]) {
    const html = renderToStaticMarkup(createElement(CalendarCommandCenter, {
      activeProjectId: null, contacts: [], events: [], language, leads: [],
      projectLabel: "Actual workspace", projects: [], sessionUserId: "", sessionUserName: "", tasks: [], users: [],
      workspaceId: "home", sessionWorkspaceId: "home",
    }));
    assert.match(html, language === "de" ? /Verbindungsstatus wird geladen/ : /Loading connection status/);
    assert.doesNotMatch(html, language === "de" ? />Nicht verbunden</ : />Not connected</);
  }
});

test("managed workspace reads use the selected workspace and expose read-only connections", async () => {
  const result = await runLoader({ ok: true, json: async () => ({ source: "database", google: { connected: true }, microsoft: { connected: false } }) }, { workspaceId: "managed-workspace" });
  assert.equal(result.status, "ready");
  assert.equal(result.integrations.google.connected, true);
  const html = renderToStaticMarkup(createElement(CalendarCommandCenter, {
    activeProjectId: null, contacts: [], events: [], language: "en", leads: [],
    projectLabel: "Managed workspace", projects: [], sessionUserId: "", sessionUserName: "", tasks: [], users: [],
    workspaceId: "managed-workspace", sessionWorkspaceId: "home", workspacePublicKey: "origin-public-key",
  }));
  assert.match(html, /Calendar connections are read-only here/);
  assert.doesNotMatch(html, /id="calendar-default-provider"/);
  assert.ok(!/<button[^>]*>Connect (?:Microsoft|Google)/.test(html), "managed context must hide OAuth start buttons");
  assert.match(html, /<button[^>]*disabled=""[^>]*>Sync with Microsoft/);
  assert.match(html, /Bookings, notifications and sharing links are unavailable/);
  assert.doesNotMatch(html, /origin-public-key|id="calendar-share-output"/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Create appointment/);
  const copy = getCalendarCommandCenterCopy("en");
  assert.ok(!html.includes(copy.bookingOverview.noRequests));
  assert.ok(!html.includes(copy.bookingOverview.noMessages));
  const bookingTab = (html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? []).find(button => button.includes(copy.bookings));
  assert.ok(bookingTab?.includes("–"), "foreign booking count must be unavailable rather than a confirmed zero");
});

test("managed workspace context cannot invoke origin-workspace connection or settings writers", async () => {
  const ast = ts.createSourceFile("calendar.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = new Set(["connectCalendarProvider", "connectMeetingProvider", "disconnectCalendarProvider", "syncLiveTeamsMeeting", "saveMeetingSettings", "sendMeetingTestNotification", "createCalendarEvent", "copyShareArtifact", "confirmBooking", "retryNotification"]);
  const functions = [];
  function visit(node) {
    if (ts.isVariableDeclaration(node) && names.has(node.name.getText(ast))) functions.push({ name: node.name.getText(ast), declaration: `const ${node.name.getText(ast)} = ${node.initializer.getText(ast)}` });
    if (ts.isFunctionDeclaration(node) && node.name && names.has(node.name.getText(ast))) functions.push({ name: node.name.getText(ast), declaration: node.getText(ast) });
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(functions.length, names.size);
  for (const { name, declaration } of functions) {
    const compiled = ts.transpileModule(declaration, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const handler = vm.runInNewContext(`${compiled}\n${name}`, { isHomeWorkspace: false });
    // No origin-only dependencies are provided: every writer must return first.
    await handler("google");
  }
});

test("managed workspace booking overview never fetches origin-workspace records", async () => {
  const ast = ts.createSourceFile("calendar.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration;
  function visit(node) {
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name?.getText(ast) === "loadMeetingBookingOverview") declaration = node.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(declaration);
  let status;
  const compiled = ts.transpileModule(declaration, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const loader = vm.runInNewContext(`${compiled}\nloadMeetingBookingOverview`, {
    isHomeWorkspace: false,
    setMeetingBookingOverviewStatus: value => { status = value; },
    fetch: () => { throw new Error("Origin workspace read must not run"); },
  });
  await loader();
  assert.equal(status, "unavailable");
});

test("a successful disconnected status remains a verified ready result", async () => {
  const result = await runLoader({ ok: true, json: async () => ({ source: "database", google: { connected: false }, microsoft: { connected: false } }) });
  assert.equal(result.status, "ready");
  assert.equal(result.integrations.google.connected, false);
  assert.equal(result.integrations.microsoft.connected, false);
});

test("failed or malformed OAuth sources remain unavailable without replacing connection state", async () => {
  for (const [response, options] of [
    [{ ok: false, json: async () => ({}) }, {}],
    [null, { rejects: true }],
    [{ ok: true, json: async () => ({}) }, {}],
    [{ ok: true, json: async () => ({ google: { connected: false } }) }, {}],
    [{ ok: true, json: async () => ({ google: { connected: false }, microsoft: { connected: false } }) }, {}],
    [{ ok: true, json: async () => ({ source: "fallback", google: { connected: false }, microsoft: { connected: false } }) }, {}],
  ]) assert.deepEqual(await runLoader(response, options), { status: "error" });
});

test("OAuth responses after unmount do not mutate connection state", async () => {
  assert.deepEqual(await runLoader({ ok: false, json: async () => ({}) }, { cancelled: true }), {});
});
