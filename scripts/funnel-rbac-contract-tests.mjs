import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const nodeRequire = createRequire(import.meta.url);
const workspaceId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const otherUserId = "33333333-3333-4333-8333-333333333333";
const projectId = "44444444-4444-4444-8444-444444444444";
const funnelId = "55555555-5555-4555-8555-555555555555";

async function source(name) {
  return readFile(path.join(repositoryRoot, name), "utf8");
}

async function loadCommonJsTypeScript(name, dependencyMocks = {}) {
  const input = await source(name);
  const { outputText } = ts.transpileModule(input, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: name,
  });
  const cjsModule = { exports: {} };
  vm.runInNewContext(outputText, {
    Buffer,
    exports: cjsModule.exports,
    module: cjsModule,
    process,
    require(specifier) {
      if (Object.hasOwn(dependencyMocks, specifier)) return dependencyMocks[specifier];
      if (specifier === "server-only") return {};
      if (specifier.startsWith("node:")) return nodeRequire(specifier);
      throw new Error(`Unexpected runtime import in ${name}: ${specifier}`);
    },
  }, { filename: name });
  return cjsModule.exports;
}

const contactAccess = await loadCommonJsTypeScript("src/lib/contact-access.ts");
const brokerAccess = await loadCommonJsTypeScript("src/lib/broker-flow/access-policy.ts");
const funnelAccess = await loadCommonJsTypeScript("src/lib/funnel-access.ts", {
  "@/lib/broker-flow/access-policy": brokerAccess,
  "@/lib/contact-access": contactAccess,
});

function session(overrides = {}) {
  return {
    productPermissions: ["crm:write", "funnels:publish"],
    productRole: "team_member",
    role: "agent",
    userId: actorId,
    workspaceId,
    ...overrides,
  };
}

function permissionHarness(allowed) {
  const calls = [];
  return {
    calls,
    transaction: {
      async queryOne(sql, params) {
        calls.push({ params, sql });
        return allowed ? { allowed: true } : null;
      },
    },
  };
}

test("funnel access allows managers and owners without consulting project permissions", async () => {
  for (const input of [
    {
      record: { ownerUserId: otherUserId, projectId },
      session: session({ productRole: "workspace_admin", role: "admin" }),
    },
    {
      record: { ownerUserId: actorId, projectId },
      session: session(),
    },
  ]) {
    const harness = permissionHarness(false);
    assert.equal(await funnelAccess.canAccessFunnelInTransaction({
      ...input,
      transaction: harness.transaction,
    }), true);
    assert.equal(harness.calls.length, 0);
  }
});

test("project-scoped funnel access requires an eligible role and a locked positive can_edit_deals grant", async () => {
  const granted = permissionHarness(true);
  assert.equal(await funnelAccess.canAccessFunnelInTransaction({
    record: { ownerUserId: otherUserId, projectId },
    session: session({ productRole: "developer_sales" }),
    transaction: granted.transaction,
  }), true);
  assert.equal(granted.calls.length, 1);
  assert.deepEqual(Array.from(granted.calls[0].params), [workspaceId, projectId, actorId]);
  assert.match(granted.calls[0].sql, /workspace_id = \$1::uuid[\s\S]*project_id = \$2::uuid[\s\S]*user_id = \$3::uuid/u);
  assert.match(granted.calls[0].sql, /can_edit_deals = true[\s\S]*for share of permission/u);

  const missingGrant = permissionHarness(false);
  assert.equal(await funnelAccess.canAccessFunnelInTransaction({
    record: { ownerUserId: otherUserId, projectId },
    session: session({ productRole: "project_sales_member" }),
    transaction: missingGrant.transaction,
  }), false);

  const ineligible = permissionHarness(true);
  assert.equal(await funnelAccess.canAccessFunnelInTransaction({
    record: { ownerUserId: otherUserId, projectId },
    session: session({ productRole: "team_member" }),
    transaction: ineligible.transaction,
  }), false);
  assert.equal(ineligible.calls.length, 0);
});

test("create target-project and owner assignment follow the same fail-closed boundary", async () => {
  const granted = permissionHarness(true);
  assert.equal(await funnelAccess.canCreateFunnelInProjectInTransaction({
    projectId,
    session: session({ productRole: "developer_sales" }),
    transaction: granted.transaction,
  }), true);
  assert.equal(await funnelAccess.canCreateFunnelInProjectInTransaction({
    projectId,
    session: session(),
    transaction: permissionHarness(true).transaction,
  }), false);

  assert.equal(funnelAccess.canAssignFunnelOwner({
    nextOwnerUserId: actorId,
    session: session(),
  }), true, "a non-manager may create a self-owned funnel");
  assert.equal(funnelAccess.canAssignFunnelOwner({
    nextOwnerUserId: otherUserId,
    session: session(),
  }), false, "a non-manager may not create for another owner");
  assert.equal(funnelAccess.canAssignFunnelOwner({
    currentOwnerUserId: actorId,
    nextOwnerUserId: actorId,
    session: session(),
  }), true);
  assert.equal(funnelAccess.canAssignFunnelOwner({
    currentOwnerUserId: null,
    nextOwnerUserId: actorId,
    session: session(),
  }), false, "claiming an existing unowned funnel is a reassignment");
  assert.equal(funnelAccess.canAssignFunnelOwner({
    currentOwnerUserId: actorId,
    nextOwnerUserId: otherUserId,
    session: session(),
  }), false);
  assert.equal(funnelAccess.canAssignFunnelOwner({
    currentOwnerUserId: actorId,
    nextOwnerUserId: otherUserId,
    session: session({ productRole: "workspace_admin", role: "admin" }),
  }), true);
});

test("unauthorized publication status and rotation fail under their funnel row lock before mutation", async () => {
  const calls = [];
  const transaction = {
    async queryOne(sql, params = []) {
      calls.push({ params, sql });
      if (/from funnels/u.test(sql)) {
        return { id: funnelId, ownerUserId: otherUserId, projectId, tracking: { publicationRevision: 4 } };
      }
      throw new Error(`Unauthorized flow reached a write: ${sql}`);
    },
  };
  const repository = await loadCommonJsTypeScript(
    "src/lib/db/funnel-publish-token-repository.ts",
    {
      "@/lib/db/qa-batch-registration-repository": {
        assertQaBatchForMutation() { throw new Error("not used"); },
        assertQaBatchOwnsObject() { throw new Error("not used"); },
      },
      "@/lib/db/tenant-client": {
        withTenantTransaction: async (_scope, callback) => callback(transaction),
      },
      "@/lib/funnel-access": {
        canAccessFunnelInTransaction: async () => false,
      },
    },
  );
  const actorSession = session({ productRole: "developer_sales" });

  await assert.rejects(
    repository.rotateFunnelPublishTokenInTransaction({
      expectedRevision: 4,
      funnelId,
      idempotencyKey: "funnel-rbac-rotation-0001",
      session: actorSession,
      transaction,
      workspaceId,
    }),
    (error) => error.code === "FUNNEL_ACCESS_DENIED",
  );
  assert.match(calls.at(-1).sql, /for update/u);

  await assert.rejects(
    repository.getFunnelPublishTokenRotationStatus({ funnelId, session: actorSession }),
    (error) => error.code === "FUNNEL_ACCESS_DENIED",
  );
  assert.match(calls.at(-1).sql, /for share/u);
  assert.equal(calls.length, 2);
});

test("every authenticated funnel surface applies the common guard in its locked tenant transaction", async () => {
  const [accessSource, writes, store, blueprintRoute, previewPage, submissionRoute, tokenRepository, tokenHttp] = await Promise.all([
    source("src/lib/funnel-access.ts"),
    source("src/lib/db/crm-write-repositories.ts"),
    source("src/lib/funnel-store.ts"),
    source("src/app/api/funnels/[funnelId]/blueprint/route.ts"),
    source("src/app/preview/[funnelId]/page.tsx"),
    source("src/app/api/funnels/[funnelId]/submissions/route.ts"),
    source("src/lib/db/funnel-publish-token-repository.ts"),
    source("src/lib/funnel-publish-token-http.ts"),
  ]);

  assert.match(accessSource, /canViewAllWorkspaceContacts/u);
  assert.match(accessSource, /canUseBrokerProjectEditScope/u);
  assert.match(writes, /for update[\s\S]*canAccessFunnelInTransaction[\s\S]*canCreateFunnelInProjectInTransaction[\s\S]*canAssignFunnelOwner/u);
  assert.match(store, /for share of f/u);
  assert.match(store, /for update of f/u);
  assert.match(store, /getStoredFunnelForSession[\s\S]*canAccessFunnelInTransaction/u);
  assert.match(store, /update funnels[\s\S]*existingRow\.ownerUserId,/u);
  assert.doesNotMatch(store, /existingRow\.ownerUserId \?\? session\.userId/u);
  assert.match(store, /restoreStoredFunnelVersion[\s\S]*findFunnelDatabaseRowInTransaction[\s\S]*canAccessFunnelInTransaction[\s\S]*existingRow: row, transaction/u);
  const restore = store.slice(store.indexOf("export async function restoreStoredFunnelVersion"));
  const qaBatchLock = restore.indexOf("assertQaBatchForMutation");
  const funnelLock = restore.indexOf("findFunnelDatabaseRowInTransaction");
  assert.ok(
    qaBatchLock >= 0 && funnelLock > qaBatchLock,
    "restore must lock the QA batch ledger before the funnel row",
  );
  assert.match(restore, /restoredBlueprint[\s\S]*id: row\.id[\s\S]*workspaceId: row\.workspaceId/u);
  assert.match(blueprintRoute, /getStoredFunnelForSession\(funnelId, auth\.session\)/u);
  assert.doesNotMatch(blueprintRoute, /getStoredFunnel\(/u);
  assert.match(previewPage, /mode === "test"[\s\S]*getStoredFunnelForSession\(funnelId, session\)/u);
  assert.match(submissionRoute, /requirePermissionAndProductCapability\(request, "funnels:write", "funnels:publish"\)/u);
  assert.match(submissionRoute, /payload\.mode === "test" && auth[\s\S]*getStoredFunnelForSession\(funnelId, auth\.session\)/u);
  assert.match(submissionRoute, /: await getStoredFunnel\(funnelId\)/u);
  assert.match(tokenRepository, /findFunnelPublicationRow[\s\S]*"update"[\s\S]*canAccessFunnelInTransaction/u);
  assert.match(tokenRepository, /getFunnelPublishTokenRotationStatus[\s\S]*"share"[\s\S]*canAccessFunnelInTransaction/u);
  assert.match(tokenHttp, /FUNNEL_ACCESS_DENIED[\s\S]*FUNNEL_NOT_FOUND/u);
});
