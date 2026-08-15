import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

function readText(path) {
  return fs.readFileSync(path, "utf8");
}

test("deal pipeline page constrains outer layout while keeping boards internally scrollable", () => {
  const component = readText("src/components/deal-pipeline-workspace.tsx");

  assert.match(component, /<section className="grid min-w-0 max-w-full gap-4 overflow-hidden">/);
  assert.match(component, /<section className="grid min-w-0 max-w-full gap-4 2xl:grid-cols-\[minmax\(0,1fr\)_380px\]">/);
  assert.match(component, /<div className="mt-4 max-w-full overflow-x-auto">/);
  assert.match(component, /<div className="max-w-full overflow-x-auto">/);
  assert.match(component, /minWidth: `\$\{Math\.max\(workStageTitles\.length, 1\) \* 210\}px`/);
});

test("primary pipeline actions fit narrow screens before switching to desktop width", () => {
  const component = readText("src/components/deal-pipeline-workspace.tsx");

  assert.match(component, /className="w-full rounded-md border border-stone-300[\s\S]*?sm:w-auto"/);
  assert.match(component, /className="w-full rounded-md bg-slate-950[\s\S]*?sm:w-auto"/);
  assert.match(component, /className="mt-4 w-full rounded-md bg-slate-950[\s\S]*?sm:w-auto"/);
});

test("lead inbox and task command centers constrain narrow layouts", () => {
  const leadInbox = readText("src/components/lead-inbox.tsx");
  const tasks = readText("src/components/task-command-center.tsx");

  assert.match(leadInbox, /<section className="grid min-w-0 max-w-full gap-4 overflow-hidden">/);
  assert.match(leadInbox, /<section className="grid min-w-0 max-w-full gap-4 2xl:grid-cols-\[minmax\(0,1fr\)_420px\]">/);
  assert.match(leadInbox, /lg:grid-cols-\[minmax\(0,1fr\)_220px\]/);
  assert.match(tasks, /<section className="grid min-w-0 max-w-full gap-4 overflow-hidden">/);
  assert.match(tasks, /<section className="grid min-w-0 max-w-full gap-4 xl:grid-cols-\[minmax\(0,1fr\)_360px\]">/);
  assert.match(tasks, /className="w-full rounded-md bg-slate-950[\s\S]*?sm:w-auto"/);
});

test("mobile dashboard exposes the daily lead, task and appointment actions", () => {
  const mobile = readText("src/components/mobile-daily-work.tsx");
  const workspace = readText("src/components/crm-workspace.tsx");

  assert.match(mobile, /export function MobileDailyWork/);
  assert.match(mobile, /onOpenSection\("leadInbox"\)/);
  assert.match(mobile, /onOpenSection\("tasks"\)/);
  assert.match(mobile, /onOpenSection\("calendar"\)/);
  assert.match(workspace, /<MobileDailyWork/);
  assert.match(workspace, /panels=\{normalizedActivePreset\.mobilePanels\}/);
});

test("settings command center keeps wide role tables inside local scroll containers", () => {
  const workspace = readText("src/components/crm-workspace.tsx");

  assert.match(workspace, /function SettingsCommandCenter/);
  assert.match(workspace, /<section className="grid min-w-0 max-w-full gap-4 overflow-hidden">/);
  assert.match(workspace, /<div className="mt-4 max-w-full overflow-x-auto">/);
  assert.match(workspace, /<table className="min-w-\[760px\] text-left text-sm">/);
  assert.match(workspace, /lg:grid-cols-\[minmax\(0,1fr\)_minmax\(0,0\.85fr\)\]/);
});

test("responsive premium shell prevents body overflow and exposes a real mobile drawer", () => {
  const workspace = readText("src/components/crm-workspace.tsx");
  const globals = readText("src/app/globals.css");
  const theme = readText("src/styles/crm-theme.css");

  assert.match(workspace, /<main className="crm-app min-h-screen max-w-full overflow-hidden/);
  assert.match(workspace, /data-crm-shell/);
  assert.match(workspace, /data-crm-mobile-trigger/);
  assert.match(workspace, /data-crm-mobile-drawer/);
  assert.match(workspace, /aria-modal="true"/);
  assert.match(workspace, /mobileNavigationRef/);
  assert.match(workspace, /inert=\{mobileNavigationOpen \? true : undefined\}/);
  assert.match(workspace, /window\.matchMedia\("\(min-width: 1181px\)"\)/);
  assert.match(workspace, /<h1[^>]+data-crm-header-title/);
  assert.match(workspace, /focusableSelector/);
  assert.match(workspace, /previouslyFocused\?\.focus\(\)/);
  assert.match(theme, /@media \(max-width: 640px\)/);
  assert.match(theme, /\[data-crm-mobile-overlay\]/);
  assert.match(globals, /body\s*\{[\s\S]*?max-width:\s*100%;[\s\S]*?overflow-x:\s*hidden;/);
  assert.match(globals, /html\s*\{[\s\S]*?max-width:\s*100%;[\s\S]*?overflow-x:\s*hidden;/);
  assert.match(globals, /overflow-wrap:\s*anywhere/);
});
