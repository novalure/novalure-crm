#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  assert.match(workspace, /readInitialNavigationEntry\(storedPreset\)/);
  assert.match(workspace, /readInitialNavigationEntry\(normalizedActivePreset\)/);
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

test("active navigation controls the browser title and semantic breadcrumb", () => {
  assert.match(workspace, /document\.title = `\$\{activeAreaLabel\} \| Novalure CRM`/);
  assert.match(workspace, /\[activeAreaLabel, language, languageHydrated\]/);
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
  assert.match(governancePanel, /Im Code implementiert/);
  assert.match(governancePanel, /QA-Nachweis ausstehend/);
  assert.match(governancePanel, /data-governance-runtime-evidence="unavailable"/);
  assert.doesNotMatch(governancePanel, /QA-verifiziert|emerald-/);
  assert.match(governancePanel, /Betrieblich offen/);
});
