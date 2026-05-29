import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

function readText(path) {
  return fs.readFileSync(path, "utf8");
}

function navigationPresetBlock(source, preset) {
  const match = source.match(new RegExp(`${preset}: \\{[\\s\\S]*?navigationEntries: (\\[[\\s\\S]*?\\]),`));
  return match?.[1] ?? "";
}

test("all CRM navigation presets expose contacts", () => {
  const workspace = readText("src/components/crm-workspace.tsx");

  for (const preset of [
    "novalureInternal",
    "realEstateBroker",
    "propertyDeveloper",
    "managedService",
    "hybridRealEstate",
    "sales",
    "salesLead",
    "marketing",
    "assistant",
    "management",
    "newUser",
    "admin",
  ]) {
    assert.match(navigationPresetBlock(workspace, preset), /"contacts"/, `${preset} exposes contacts`);
  }
});

test("contact owner migration is additive and indexed", () => {
  const migration = readText("migrations/029_contact_owner_scope.sql");
  const databaseRoute = readText("src/app/api/system/database/route.ts");

  assert.match(migration, /add column if not exists owner_user_id uuid references workspace_users/);
  assert.match(migration, /lead_owner\.assigned_to_user_id/);
  assert.match(migration, /deal_owner\.owner_user_id/);
  assert.match(migration, /contacts_workspace_owner_active_idx/);
  assert.match(databaseRoute, /029_contact_owner_scope\.sql/);
});

test("contact data is scoped server-side by session visibility", () => {
  const coreRoute = readText("src/app/api/crm/core/route.ts");
  const page = readText("src/app/page.tsx");
  const loaders = readText("src/lib/db/crm-loaders.ts");
  const contactAccess = readText("src/lib/contact-access.ts");

  assert.match(coreRoute, /getCoreCrmData\(auth\.session\.workspaceId, \{ session: auth\.session \}\)/);
  assert.match(page, /getCoreCrmData\(session\.workspaceId, \{ session \}\)/);
  assert.match(loaders, /getContactVisibilityScope\(options\.session\)/);
  assert.match(loaders, /c\.owner_user_id = \$\$\{params\.length\}/);
  assert.match(contactAccess, /return actor\.userId \? \{ kind: "own", userId: actor\.userId \} : \{ kind: "none" \}/);
});

test("contact writes persist and enforce owner assignment", () => {
  const route = readText("src/app/api/crm/contacts/route.ts");
  const repo = readText("src/lib/db/crm-write-repositories.ts");
  const commandCenter = readText("src/components/contact-command-center.tsx");

  assert.match(route, /permission: "crm:read"/);
  assert.match(repo, /canWriteContacts\(input\.session\)/);
  assert.match(repo, /canAssignContactOwner\(input\.session\)/);
  assert.match(repo, /Contact can only be changed by the assigned owner/);
  assert.match(repo, /owner_user_id = \$5::uuid/);
  assert.match(commandCenter, /canAssignOwner/);
  assert.match(commandCenter, /ownerUserId/);
});
