import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

function readText(path) {
  return fs.readFileSync(path, "utf8");
}

test("project creation no longer creates session-only projects", () => {
  const workspace = readText("src/components/crm-workspace.tsx");

  assert.doesNotMatch(workspace, /sessionProjects|setSessionProjects|project_session_/);
  assert.match(workspace, /fetch\("\/api\/crm\/projects"/);
  assert.match(workspace, /setLiveCoreData/);
  assert.match(workspace, /await refreshCoreData\(\)/);
});

test("lead creation refreshes the persistent core source after server writes", () => {
  const leadInbox = readText("src/components/lead-inbox.tsx");
  const workspace = readText("src/components/crm-workspace.tsx");

  assert.match(leadInbox, /onLeadsChanged/);
  assert.match(leadInbox, /refreshPersistedLeads/);
  assert.match(leadInbox, /clearPersistedLeadLocalState/);
  assert.match(workspace, /onLeadsChanged=\{refreshCoreData\}/);
});

test("project wizard copy no longer signals prototype-only persistence", () => {
  const i18n = readText("src/lib/i18n.ts");

  assert.doesNotMatch(i18n, /Project ".*prepared for this session|Persistenz per API|f.r diese Sitzung vorbereitet/);
  assert.match(i18n, /prepare: "Create project"/);
  assert.match(i18n, /prepare: "Projekt anlegen"/);
  assert.match(i18n, /saveError: "Project could not be saved in the database\."/);
  assert.match(i18n, /saveError: "Projekt konnte nicht in der Datenbank gespeichert werden\."/);
});
