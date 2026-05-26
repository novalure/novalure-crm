import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

function readText(path) {
  return fs.readFileSync(path, "utf8");
}

function productRoleBlock(source, role) {
  const match = source.match(new RegExp(`${role}: \\[([\\s\\S]*?)\\],`));
  return match?.[1] ?? "";
}

test("read-only product roles do not carry write capabilities", () => {
  const productModel = readText("src/lib/product-model.ts");

  for (const role of ["viewer", "external_partner"]) {
    const block = productRoleBlock(productModel, role);
    assert.match(block, /workspace:read/);
    assert.doesNotMatch(block, /pipeline:write|newsletter:send|settings:manage|bots:publish|knowledge:write/);
  }
});

test("workspace-scoped sessions deny tenant switching unless managed-service rights are present", () => {
  const session = readText("src/lib/auth/session.ts");

  assert.match(session, /export async function resolveWorkspaceScopedSession/);
  assert.match(session, /requestedWorkspaceId === auth\.session\.workspaceId/);
  assert.match(session, /if \(!canSwitchWorkspace\(auth\.session\)\)/);
  assert.match(session, /Managed-service workspace switch is forbidden/);
  assert.match(session, /wu\.id = \$1\s+and wu\.workspace_id = \$2/s);
});

test("core CRM writes enforce owner or project-scoped record access", () => {
  const repo = readText("src/lib/db/crm-write-repositories.ts");

  assert.match(repo, /function canManageWorkspaceRecords/);
  assert.match(repo, /function isOwnRecordOnlySession/);
  assert.match(repo, /session\.productRole === "broker_agent"/);
  assert.match(repo, /function isProjectScopedSalesSession/);
  assert.match(repo, /async function assertRecordWriteAccess/);
  assert.match(repo, /can_edit_deals as "canEditDeals"/);

  assert.match(repo, /entityLabel: "Deal"[\s\S]*existingOwnerUserId: existing\?\.ownerUserId/);
  assert.match(repo, /entityLabel: "Lead"[\s\S]*existingOwnerUserId: existing\?\.assignedToUserId/);
  assert.match(repo, /entityLabel: "Task"[\s\S]*existingOwnerUserId: existing\?\.ownerUserId/);
  assert.match(repo, /owner_user_id as "ownerUserId"/);
});

test("write routes require both technical permission and product capability", () => {
  const dealsRoute = readText("src/app/api/crm/deals/route.ts");
  const stageRoute = readText("src/app/api/crm/deals/[dealId]/stage/route.ts");
  const leadsRoute = readText("src/app/api/crm/leads/route.ts");
  const contactsRoute = readText("src/app/api/crm/contacts/route.ts");
  const tasksRoute = readText("src/app/api/crm/tasks/route.ts");
  const newsletterRoute = readText("src/app/api/newsletter/send/route.ts");

  for (const route of [dealsRoute, stageRoute, leadsRoute, contactsRoute]) {
    assert.match(route, /resolveWorkspaceScopedSession\(request, \{ permission: "crm:write", capability: "pipeline:write" \}\)/);
  }

  assert.match(tasksRoute, /resolveWorkspaceScopedSession\(request, \{ permission: "crm:write", capability: "workspace:operate" \}\)/);
  assert.match(newsletterRoute, /requirePermissionAndProductCapability\(request, "newsletter:send", "newsletter:send"\)/);
  assert.match(newsletterRoute, /evaluateOutboundConsent/);
});
