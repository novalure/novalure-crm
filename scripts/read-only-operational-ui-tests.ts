import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskCommandCenter } from "../src/components/task-command-center";
import { CalendarCommandCenter } from "../src/components/calendar-command-center";
import { getCalendarCommandCenterCopy, getTaskCommandCenterCopy } from "../src/lib/i18n";
import type { Task } from "../src/lib/crm-types";

const actor = "00000000-0000-4000-8000-000000000001";
const task: Task = { id: "00000000-0000-4000-8000-000000000002", workspaceId: "workspace", projectId: "project", project: "SYNTHETIC project", title: "SYNTHETIC task", due: "2030-01-01", priority: "Normal", status: "open", ownerUserId: actor };

function button(html: string, label: string) {
  return [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]).find(value => value.replace(/<[^>]*>/g, "").trim() === label);
}

function calendar(language: "de" | "en", permissions: Partial<Parameters<typeof CalendarCommandCenter>[0]> = {}) {
  return renderToStaticMarkup(createElement(CalendarCommandCenter, {
    canWriteEvents: false, canManageMeetingSettings: false, canSyncCalendars: false, canSendNotifications: false,
    activeProjectId: null, contacts: [], events: [], language, leads: [], projectLabel: "SYNTHETIC workspace", projects: [],
    sessionUserId: actor, sessionUserName: "SYNTHETIC viewer", tasks: [], users: [], workspaceId: "workspace", sessionWorkspaceId: "workspace",
    ...permissions,
  }));
}

test("read-only task views disable mutation buttons and retain search and navigation in both languages", () => {
  for (const language of ["de", "en"] as const) {
    const text = getTaskCommandCenterCopy(language);
    const props = { canWriteTasks: false, canPrepareFollowUps: false, activeProjectId: null, contacts: [], language, leads: [], projectLabel: "SYNTHETIC workspace", projects: [], sessionUserId: actor, sessionUserName: "SYNTHETIC viewer", tasks: [task], users: [] };
    const html = renderToStaticMarkup(createElement(TaskCommandCenter, props));
    assert.ok(html.includes(text.readOnlyHint));
    assert.match(html, /data-task-readonly/);
    for (const label of [text.newTask, text.markDone, text.prepareFollowUp]) assert.match(button(html, label) ?? "", /disabled=""/, label);
    assert.doesNotMatch(button(html, `${text.all} · 1`) ?? "disabled", /disabled/);
    const search = html.match(/<input[^>]*type="search"[^>]*>/)?.[0];
    assert.ok(search);
    assert.doesNotMatch(search, /disabled/);
    const writer = renderToStaticMarkup(createElement(TaskCommandCenter, { ...props, canWriteTasks: true, canPrepareFollowUps: true }));
    assert.doesNotMatch(button(writer, text.newTask) ?? "disabled", /disabled/);
    assert.doesNotMatch(writer, /Microsoft 365 ready|Microsoft 365 bereit/);
  }
});

test("calendar event editing and calendar administration retain their distinct permissions", () => {
  for (const language of ["de", "en"] as const) {
    const text = getCalendarCommandCenterCopy(language);
    const calendarProviderTitle = text.calendarProviders.find(provider => provider.id === "microsoft")!.title;
    const viewer = calendar(language);
    assert.ok(viewer.includes(text.readOnlyHint));
    assert.match(viewer, /data-calendar-readonly/);
    assert.match(button(viewer, text.newEvent) ?? "", /disabled=""/);
    assert.match(button(viewer, text.setup.savePage) ?? "", /disabled=""/);
    assert.match(button(viewer, text.calendarSetup.connect(calendarProviderTitle)) ?? "", /disabled=""/);
    assert.doesNotMatch(viewer.match(/<input[^>]*type="search"[^>]*>/)?.[0] ?? "disabled", /disabled/);
    assert.doesNotMatch(button(viewer, `${text.today} · 0`) ?? "disabled", /disabled/);

    const agent = calendar(language, { canWriteEvents: true });
    assert.doesNotMatch(button(agent, text.newEvent) ?? "disabled", /disabled/);
    assert.match(button(agent, text.setup.savePage) ?? "", /disabled=""/);
    assert.match(button(agent, text.calendarSetup.connect(calendarProviderTitle)) ?? "", /disabled=""/);

    const manager = calendar(language, { canWriteEvents: true, canManageMeetingSettings: true });
    assert.doesNotMatch(button(manager, text.setup.savePage) ?? 'disabled=""', /disabled=""/);
    assert.match(button(manager, text.calendarSetup.connect(calendarProviderTitle)) ?? "", /disabled=""/);
  }
});

test("CRM gates honor server grants, target memberships, and the home-only boundary of unscoped actions", () => {
  const source = readFileSync(new URL("../src/components/crm-workspace.tsx", import.meta.url), "utf8");
  const ast = ts.createSourceFile("crm-workspace", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const gateNames = ["canOperateWorkspace", "canPrepareTaskFollowUps", "canManageMeetingSettings", "canSyncCalendars", "canSendMeetingNotifications", "canWritePipeline"];
  const declarations: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && gateNames.includes(node.name.text)) declarations.push(`const ${node.getText(ast)};`);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(declarations.length, gateNames.length);
  const run = (input: Record<string, unknown>) => vm.runInNewContext(`${declarations.join("\n")}\n({${gateNames.join(",")}})`, input);
  // The server grants newsletter:send to Growth in addition to its technical agent role.
  const origin = { isSignedInWorkspace: true, sessionPermissions: ["crm:write", "newsletter:send"], sessionProductPermissions: ["workspace:operate"], activeWorkspace: { permissions: ["crm:write"], productPermissions: ["pipeline:write"] } };
  const growth = run(origin);
  assert.equal(growth.canOperateWorkspace, true);
  assert.equal(growth.canSendMeetingNotifications, true);
  assert.equal(growth.canSyncCalendars, false);
  assert.equal(growth.canManageMeetingSettings, false);

  const managed = run({ ...origin, isSignedInWorkspace: false });
  assert.equal(managed.canWritePipeline, true, "The scoped pipeline supports an authorized target membership");
  for (const name of gateNames.filter(name => name !== "canWritePipeline")) assert.equal(managed[name], false, name);
  assert.equal(run({ ...origin, activeWorkspace: { permissions: ["crm:read"], productPermissions: [] } }).canWritePipeline, false);
  assert.equal(run({ ...origin, activeWorkspace: {} }).canWritePipeline, false, "Missing target membership grants fail closed");
  assert.equal(run({ ...origin, sessionPermissions: ["crm:read"] }).canOperateWorkspace, false);

  const page = readFileSync(new URL("../src/app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /sessionPermissions=\{session\.permissions\}/);
  assert.match(page, /sessionProductPermissions=\{session\.productPermissions\}/);
  assert.match(source, /canWrite=\{canWritePipeline\}/);
  for (const field of ["permissions", "productPermissions", "role"]) {
    assert.ok(source.includes(`${field}: activeWorkspace.${field}`), `Workspace fallback preserves ${field}`);
    assert.ok(source.includes(`current.${field}`) && source.includes(`nextWorkspace.${field}`), `Workspace refresh notices ${field} changes`);
  }
});

test("read-only operational action handlers return before any transport or local mutation", async () => {
  const paths: Array<[string, string[], Record<string, boolean>]> = [
    ["task-command-center", ["createTask", "toggleTask", "prepareTaskFollowUp"], { canWriteTasks: false, canPrepareFollowUps: false }],
    ["calendar-command-center", ["createCalendarEvent", "saveMeetingSettings", "sendMeetingTestNotification", "connectCalendarProvider", "connectMeetingProvider", "disconnectCalendarProvider", "syncLiveTeamsMeeting", "confirmBooking", "retryNotification"], { isHomeWorkspace: true, canWriteEvents: false, canManageMeetingSettings: false, canSyncCalendars: false, canSendNotifications: false }],
  ];
  for (const [name, actions, gates] of paths) {
    const source = readFileSync(new URL(`../src/components/${name}.tsx`, import.meta.url), "utf8");
    const ast = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const functions = new Map<string, string>();
    function visit(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && actions.includes(node.name.text)) functions.set(node.name.text, `const ${node.getText(ast)};`);
      if (ts.isFunctionDeclaration(node) && node.name && actions.includes(node.name.text)) functions.set(node.name.text, node.getText(ast));
      ts.forEachChild(node, visit);
    }
    visit(ast);
    for (const action of actions) {
      const snippet = functions.get(action);
      assert.ok(snippet, action);
      const compiled = ts.transpileModule(snippet, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
      const run = vm.runInNewContext(`${compiled}\n${action}`, { ...gates, csrfFetch() { assert.fail("A read-only action reached the transport"); } });
      await run();
    }
  }
});
