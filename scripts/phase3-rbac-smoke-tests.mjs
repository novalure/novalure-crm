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

test("specialized Novalure internal product roles are additive and scoped", () => {
  const productModel = readText("src/lib/product-model.ts");

  for (const role of ["novalureGrowth", "novalureServiceOps", "novalureAdmin"]) {
    assert.match(productModel, new RegExp(`\\| "${role}"`), `${role} is part of ProductRole`);
  }

  const growthBlock = productRoleBlock(productModel, "novalureGrowth");
  assert.match(growthBlock, /growth-workspace:operate/);
  assert.match(growthBlock, /pipeline:write/);
  assert.match(growthBlock, /newsletter:send/);
  assert.doesNotMatch(growthBlock, /settings:manage|bots:publish|managed-service:operate|customer-access:manage/);

  const serviceOpsBlock = productRoleBlock(productModel, "novalureServiceOps");
  assert.match(serviceOpsBlock, /managed-service:operate/);
  assert.match(serviceOpsBlock, /customer-access:read/);
  assert.doesNotMatch(serviceOpsBlock, /bots:publish|settings:manage|customer-access:manage/);

  const adminBlock = productRoleBlock(productModel, "novalureAdmin");
  const adminCapabilities = [...adminBlock.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(adminCapabilities, [
    "analytics:read",
    "bots:publish",
    "calendar:manage",
    "customer-access:manage",
    "customer-access:read",
    "funnels:publish",
    "knowledge:write",
    "managed-service:operate",
    "newsletter:send",
    "novalure:internal",
    "pipeline:write",
    "reservations:write",
    "settings:manage",
    "workspace:admin",
    "workspace:operate",
    "workspace:read",
  ]);
});

test("workspace-scoped sessions adopt an active target membership before authorization", () => {
  const session = readText("src/lib/auth/session.ts");

  assert.match(session, /export async function resolveWorkspaceScopedSession/);
  assert.match(session, /requestedWorkspaceId === originSession\.workspaceId/);
  assert.match(session, /if \(!canSwitchWorkspace\(originSession\)\)/);
  assert.match(session, /Managed-service workspace switch is forbidden/);
  assert.match(session, /wu\.workspace_id = \$1[\s\S]*wu\.status = 'active'/);
  assert.match(session, /Target workspace access requires explicit active membership/);
  assert.match(session, /userId: membership\.id/);
  assert.match(session, /role: access\.role/);
  assert.match(session, /permissions: access\.permissions/);
  assert.match(session, /productPermissions: access\.productPermissions/);
  assert.match(session, /productRole: access\.productRole/);

  const membershipIndex = session.indexOf("const membership = await findActiveMembershipForSession");
  const targetSessionIndex = session.indexOf("const targetSession: AppSession");
  const authorizationIndex = session.indexOf("authorizeWorkspaceScopedSession(targetSession, input)");
  assert.ok(membershipIndex >= 0 && membershipIndex < targetSessionIndex);
  assert.ok(targetSessionIndex < authorizationIndex);

  const auditStart = session.indexOf("async function auditCrossWorkspaceView");
  const auditEnd = session.indexOf("type WorkspaceScopeRequirement", auditStart);
  const auditBlock = session.slice(auditStart, auditEnd);
  assert.match(session, /workspace\.cross_workspace_view/);
  assert.doesNotMatch(auditBlock, /catch/);
  assert.match(session, /Workspace switch audit could not be persisted/);
});

test("workspace list is membership-backed and maps target roles and permissions", () => {
  const route = readText("src/app/api/workspaces/route.ts");
  const databaseListStart = route.indexOf("const listManagedWorkspaces");
  const databaseListEnd = route.indexOf("export async function PATCH", databaseListStart);
  const databaseList = route.slice(databaseListStart, databaseListEnd);

  assert.match(databaseList, /from workspace_users wu\s+join workspaces w on w\.id = wu\.workspace_id/);
  assert.match(databaseList, /where wu\.status = 'active'/);
  assert.match(databaseList, /wu\.id = \$1::uuid/);
  assert.match(databaseList, /\$2::boolean and lower\(wu\.email\) = lower\(\$3\)/);
  assert.match(databaseList, /wu\.role/);
  assert.match(databaseList, /wu\.product_role as "productRole"/);
  assert.match(databaseList, /resolveWorkspaceMembershipAccess/);
  assert.match(databaseList, /permissions: access\.permissions/);
  assert.match(databaseList, /productRole: access\.productRole/);
  assert.doesNotMatch(databaseList, /\$\d+::text as role/);
  assert.doesNotMatch(databaseList, /permissions: auth\.session\.permissions/);
});

test("core CRM writes enforce owner or project-scoped record access", () => {
  const repo = readText("src/lib/db/crm-write-repositories.ts");
  const contactAccess = readText("src/lib/contact-access.ts");
  const loaders = readText("src/lib/db/crm-loaders.ts");

  assert.match(repo, /function canManageWorkspaceRecords/);
  assert.match(repo, /function isOwnRecordOnlySession/);
  assert.match(repo, /session\.productRole === "broker_agent"/);
  assert.match(repo, /function isProjectScopedSalesSession/);
  assert.match(repo, /async function assertRecordWriteAccess/);
  assert.match(repo, /can_edit_deals as "canEditDeals"/);

  assert.match(repo, /entityLabel: "Deal"[\s\S]*existingOwnerUserId: existing\?\.ownerUserId/);
  assert.match(repo, /entityLabel: "Lead"[\s\S]*existingOwnerUserId: existing\?\.assignedToUserId/);
  assert.match(repo, /entityLabel: "Task"[\s\S]*existingOwnerUserId: existing\?\.ownerUserId/);
  assert.match(repo, /async function assertContactWriteAccess/);
  assert.match(repo, /canWriteContacts\(input\.session\)/);
  assert.match(repo, /owner_user_id as "ownerUserId"/);
  assert.match(contactAccess, /export function canViewAllWorkspaceContacts/);
  assert.match(contactAccess, /export function getContactVisibilityScope/);
  assert.match(contactAccess, /"customer_owner"/);
  assert.match(contactAccess, /"workspace_admin"/);
  assert.match(loaders, /loadContacts\(scopedWorkspaceId, contactScope\)/);
  assert.match(loaders, /filters\.push\("c\.workspace_id = \$1"\)/);
  assert.match(loaders, /c\.owner_user_id = \$\$\{params\.length\}/);
  assert.match(repo, /owner_user_id as "ownerUserId"/);
});

test("write routes require server-side technical permission and product access gates", () => {
  const dealsRoute = readText("src/app/api/crm/deals/route.ts");
  const stageRoute = readText("src/app/api/crm/deals/[dealId]/stage/route.ts");
  const leadsRoute = readText("src/app/api/crm/leads/route.ts");
  const contactsRoute = readText("src/app/api/crm/contacts/route.ts");
  const tasksRoute = readText("src/app/api/crm/tasks/route.ts");
  const newsletterRoute = readText("src/app/api/newsletter/send/route.ts");

  for (const route of [dealsRoute, stageRoute, leadsRoute]) {
    assert.match(route, /resolveWorkspaceScopedSession\(request, \{ permission: "crm:write", capability: "pipeline:write" \}\)/);
  }

  const contactWriteGuards = contactsRoute.match(
    /resolveWorkspaceScopedSession\(request, \{ permission: "crm:write" \}\)/g,
  ) ?? [];
  assert.equal(contactWriteGuards.length, 2, "contact POST and PATCH both require crm:write");
  assert.match(contactsRoute, /upsertContactRecord/);
  assert.match(tasksRoute, /resolveWorkspaceScopedSession\(request, \{ permission: "crm:write", capability: "workspace:operate" \}\)/);
  assert.match(newsletterRoute, /requirePermissionAndProductCapability\(request, "newsletter:send", "newsletter:send"\)/);
  assert.match(newsletterRoute, /evaluateOutboundConsent/);
});

test("read-only assistants are rejected before every contact mutation repository call", () => {
  const contactsRoute = readText("src/app/api/crm/contacts/route.ts");
  const permissions = readText("src/lib/auth/permissions.ts");
  const assistantPermissions = permissions.match(/assistant:\s*\[([^\]]*)\]/)?.[1] ?? "";
  const agentPermissions = permissions.match(/agent:\s*\[([^\]]*)\]/)?.[1] ?? "";
  const adminPermissions = permissions.match(/admin:\s*\[([\s\S]*?)\],\s*agent:/)?.[1] ?? "";

  assert.doesNotMatch(assistantPermissions, /crm:write/);
  assert.match(agentPermissions, /crm:write/);
  assert.match(adminPermissions, /crm:write/);

  const post = contactsRoute.slice(
    contactsRoute.indexOf("export async function POST"),
    contactsRoute.indexOf("export async function PATCH"),
  );
  const patch = contactsRoute.slice(
    contactsRoute.indexOf("export async function PATCH"),
    contactsRoute.indexOf("export async function DELETE"),
  );
  for (const [name, handler] of [["POST", post], ["PATCH", patch]]) {
    const guard = handler.indexOf('permission: "crm:write"');
    const rejection = handler.indexOf("if (!auth.ok) return auth.response");
    assert.ok(guard >= 0 && guard < rejection, `${name} requires crm:write before rejecting`);
    for (const repositoryCall of ["upsertContactRecord({", "archiveContactRecord({"]) {
      const call = handler.indexOf(repositoryCall);
      if (call >= 0) assert.ok(rejection < call, `${name} rejects before ${repositoryCall}`);
    }
  }
});
