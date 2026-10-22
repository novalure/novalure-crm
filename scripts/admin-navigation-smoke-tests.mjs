#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const [
  workspace,
  auditPanel,
  systemPanel,
  governancePanel,
  auditRoute,
  auditRepository,
] = await Promise.all([
  read("src/components/crm-workspace.tsx"),
  read("src/components/admin/audit-log-panel.tsx"),
  read("src/components/admin/system-releases-panel.tsx"),
  read("src/components/admin/governance-compliance-panel.tsx"),
  read("src/app/api/admin/audit-logs/route.ts"),
  read("src/lib/db/admin-repositories.ts"),
]);

test("three admin entries have distinct stable hashes and dedicated panels", () => {
  assert.match(workspace, /auditLog: "audit-log"/);
  assert.match(workspace, /governanceCompliance: "governance-compliance"/);
  assert.match(workspace, /systemReleases: "system-releases"/);
  assert.match(workspace, /readInitialNavigationEntry\(storedPreset, sessionProductRole\)/);
  assert.match(workspace, /readInitialNavigationEntry\(normalizedActivePreset, sessionProductRole\)/);
  assert.match(workspace, /<AuditLogPanel language=\{language\}/);
  assert.match(workspace, /<GovernanceCompliancePanel language=\{language\}/);
  assert.match(workspace, /<SystemReleasesPanel language=\{language\}/);
});

test("admin navigation restores browser history and gates restricted roles", () => {
  assert.match(workspace, /window\.history\.pushState/);
  assert.match(workspace, /addEventListener\("popstate", syncSectionFromHash\)/);
  assert.match(workspace, /canAccessRestrictedAdminEntry/);
  assert.match(workspace, /productRole === "platform_admin" \|\| productRole === "novalureAdmin"/);
});

test("active navigation and central language updates control the browser title, language and breadcrumb", async () => {
  const { default: ts } = await import("typescript");
  const source = ts.createSourceFile("crm-workspace.tsx", workspace, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const effects = [];
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "useEffect" &&
      ts.isArrowFunction(node.arguments[0]) && /document\.title\s*=/.test(node.arguments[0].body.getText(source))) effects.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(effects.length, 1, "One effect owns document title and language synchronization");
  const [callback, dependencies] = effects[0].arguments;
  assert(ts.isArrayLiteralExpression(dependencies));
  const names = dependencies.elements.map(node => node.getText(source));
  assert(names.includes("activeAreaLabel"), "Navigation changes must rerun synchronization");
  assert(names.includes("language"), "A saved language change must rerun synchronization even when the area label is unchanged");
  assert(!names.includes("languageHydrated"), "The central account preference must not wait for a second browser-language state");

  const events = [];
  const browser = {
    activeAreaLabel: "CRM", language: "de",
    document: { title: "", documentElement: { lang: "" } },
    window: { dispatchEvent(event) { events.push({ type: event.type, language: event.detail.language }); return true; } },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
  };
  const executable = ts.transpileModule(`(${callback.getText(source)})();`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(executable, browser, { timeout: 1000 });
  assert.equal(browser.document.title, "CRM | Novalure CRM");
  assert.equal(browser.document.documentElement.lang, "de");
  browser.language = "en";
  runInNewContext(executable, browser, { timeout: 1000 });
  assert.equal(browser.document.title, "CRM | Novalure CRM");
  assert.equal(browser.document.documentElement.lang, "en");
  browser.activeAreaLabel = "Calendar";
  runInNewContext(executable, browser, { timeout: 1000 });
  assert.equal(browser.document.title, "Calendar | Novalure CRM");
  assert.deepEqual(events, [
    { type: "novalure:language-change", language: "de" },
    { type: "novalure:language-change", language: "en" },
    { type: "novalure:language-change", language: "en" },
  ]);
  assert.match(workspace, /<nav aria-label=\{contextCopy\.label\}[^>]+data-crm-breadcrumb>/);
  assert.match(workspace, /aria-current=\{index === breadcrumbItems\.length - 1 \? "page" : undefined\}/);
});

test("audit log is read-only, workspace-bound, filtered and paginated", () => {
  assert.match(auditRoute, /export async function GET/);
  assert.doesNotMatch(auditRoute, /export async function (?:POST|PUT|PATCH|DELETE)/);
  assert.match(auditRoute, /auditReaderRoles/);
  assert.match(auditRoute, /auditExporterRoles/);
  assert.match(auditRoute, /format === "csv" && !canExportAudit/);
  assert.match(auditRepository, /where al\.workspace_id = \$1::uuid/);
  assert.match(auditRepository, /limit \$5/);
  assert.match(auditRepository, /offset \$6/);
  assert.match(auditPanel, /setPage\(1\)/);
  assert.match(auditPanel, /Filter zurücksetzen/);
  assert.match(auditPanel, /payload\.canExport/);
});

test("system and governance panels distinguish code evidence from operational gates", () => {
  assert.match(systemPanel, /\/api\/system\/database/);
  assert.match(systemPanel, /Restore, Tenant-Isolation, Providerkonfiguration/);
  assert.match(governancePanel, /Code-erzwungen/);
  assert.match(governancePanel, /Betrieblich offen/);
});
