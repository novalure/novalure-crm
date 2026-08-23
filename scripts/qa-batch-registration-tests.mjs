import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      return {
        shortCircuit: true,
        url: pathToFileURL(path.resolve(repositoryRoot, "src", `${specifier.slice(2)}.ts`)).href,
      };
    }
    return nextResolve(specifier, context);
  },
});

const workspaceA = "11111111-1111-4111-8111-111111111111";
const workspaceB = "22222222-2222-4222-8222-222222222222";
const productionWorkspace = "33333333-3333-4333-8333-333333333333";
const actorId = "44444444-4444-4444-8444-444444444444";
const batchId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const contactId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const consentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const dealId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const read = (name) => readFile(new URL(`../${name}`, import.meta.url), "utf8");

const runtime = await import("../src/lib/qa-batch-runtime.ts");
const runtimeIdentity = await import("../src/lib/qa-runtime-identity.ts");
const repository = await import("../src/lib/db/qa-batch-registration-repository.ts");
const targetGuard = await import("../src/lib/db/qa-runtime-target-guard.ts");
const { withTenantTransaction } = await import("../src/lib/db/tenant-client.ts");

const runtimeDatabaseEnvironment = {
  NOVALURE_PRODUCTION_BRANCH_ID: "br-production-main-1234",
  NOVALURE_PRODUCTION_PROJECT_ID: "production-project-1234",
  NOVALURE_QA_BRANCH_ID: "br-lucky-heart-alrm9dlw",
  NOVALURE_QA_DATABASE_NAME: "neondb",
  NOVALURE_QA_DATABASE_ROLE: "novalure_app",
  NOVALURE_QA_PROJECT_ID: "weathered-term-98273025",
};
const runtimeTargetRow = {
  branchId: runtimeDatabaseEnvironment.NOVALURE_QA_BRANCH_ID,
  databaseName: runtimeDatabaseEnvironment.NOVALURE_QA_DATABASE_NAME,
  projectId: runtimeDatabaseEnvironment.NOVALURE_QA_PROJECT_ID,
  role: runtimeDatabaseEnvironment.NOVALURE_QA_DATABASE_ROLE,
};
Object.assign(process.env, runtimeDatabaseEnvironment);

function previewEnvironment(overrides = {}) {
  return {
    NOVALURE_PRODUCTION_WORKSPACE_IDS: productionWorkspace,
    ...runtimeDatabaseEnvironment,
    NOVALURE_QA_BATCH_REGISTRATION_ENABLED: "true",
    NOVALURE_QA_RESET_WORKSPACE_IDS: `${workspaceA},${workspaceB}`,
    VERCEL_DEPLOYMENT_ID: "dpl_7Gw5ZMBpQA8h9GF832KGp7nwbuh3",
    VERCEL_ENV: "preview",
    VERCEL_GIT_COMMIT_REF: "codex/go-live-remediation-20260822",
    VERCEL_GIT_COMMIT_SHA: "a".repeat(40),
    VERCEL_URL: "candidate-abc123-novalure.vercel.app",
    ...overrides,
  };
}

function session(overrides = {}) {
  return {
    productRole: "customer_owner",
    source: "cookie",
    userId: actorId,
    workspaceId: workspaceA,
    ...overrides,
  };
}

function requestWithBatch(id = batchId) {
  return new Request("https://candidate.example.test/api/crm/contacts", {
    headers: { "x-novalure-qa-batch-id": id },
    method: "POST",
  });
}

function fakeTransaction(handler, targetRow = runtimeTargetRow) {
  const calls = [];
  const invoke = async (kind, sql, params = []) => {
    calls.push({ kind, params, sql });
    if (/current_setting\('neon\.project_id'/i.test(sql) && /current_database\(\)/i.test(sql)) {
      return targetRow;
    }
    return handler({ calls, kind, params, sql });
  };
  return {
    calls,
    transaction: {
      execute: (sql, params) => invoke("execute", sql, params),
      query: async (sql, params) => (await invoke("query", sql, params)) ?? [],
      queryOne: async (sql, params) => (await invoke("queryOne", sql, params)) ?? null,
    },
  };
}

test("QA batch header is accepted only for explicit isolated Preview configuration", () => {
  assert.equal(runtime.readQaBatchMutationHeader(requestWithBatch(), session(), previewEnvironment()), batchId);
  assert.equal(
    runtime.readQaBatchMutationHeader(new Request("https://candidate.example.test/api/crm/contacts"), session(), {}),
    null,
  );
  assert.throws(
    () => runtime.readQaBatchMutationHeader(requestWithBatch(), session(), previewEnvironment({ VERCEL_ENV: "production" })),
    (error) => error?.code === "QA_BATCH_PREVIEW_REQUIRED" && error.status === 403,
  );
  assert.throws(
    () => runtime.readQaBatchMutationHeader(requestWithBatch(), session({ source: "headers" }), previewEnvironment()),
    (error) => error?.code === "QA_BATCH_COOKIE_SESSION_REQUIRED",
  );
  assert.throws(
    () => runtime.readQaBatchMutationHeader(requestWithBatch(), session({ productRole: "viewer" }), previewEnvironment()),
    (error) => error?.code === "QA_BATCH_LAUNCH_SCOPE_DENIED",
  );
  assert.throws(
    () => runtime.readQaBatchMutationHeader(requestWithBatch(), session(), previewEnvironment({
      NOVALURE_PRODUCTION_WORKSPACE_IDS: workspaceA,
    })),
    (error) => error?.code === "QA_BATCH_ISOLATION_INVALID",
  );
  assert.throws(
    () => runtime.readQaBatchMutationHeader(requestWithBatch(), session(), previewEnvironment({
      NOVALURE_PRODUCTION_WORKSPACE_IDS: undefined,
    })),
    (error) => error?.code === "QA_BATCH_ISOLATION_INVALID",
  );
});

test("QA batch mutation guard rejects incomplete deployment identity even when Preview registration is enabled", () => {
  for (const [overrides, expectedCode] of [
    [{ VERCEL_DEPLOYMENT_ID: undefined }, "QA_BATCH_DEPLOYMENT_ID_INVALID"],
    [{ VERCEL_DEPLOYMENT_ID: "not-a-deployment" }, "QA_BATCH_DEPLOYMENT_ID_INVALID"],
    [{ VERCEL_URL: undefined }, "QA_BATCH_DEPLOYMENT_HOST_INVALID"],
    [{ VERCEL_URL: "www.novalure-crm.app" }, "QA_BATCH_DEPLOYMENT_HOST_INVALID"],
    [{ VERCEL_GIT_COMMIT_REF: undefined }, "QA_BATCH_GIT_BRANCH_INVALID"],
    [{ VERCEL_GIT_COMMIT_REF: "invalid\nbranch" }, "QA_BATCH_GIT_BRANCH_INVALID"],
  ]) {
    assert.throws(
      () => runtime.readQaBatchMutationHeader(requestWithBatch(), session(), previewEnvironment(overrides)),
      (error) => error?.code === expectedCode && error.status === 503,
      expectedCode,
    );
  }
});

test("runtime database identity attests exact target, RLS and least privilege without exposing raw identifiers", () => {
  const row = {
    databaseBranchId: "br-lucky-heart-alrm9dlw",
    databaseName: "neondb",
    databaseProjectId: "weathered-term-98273025",
    databaseRole: "novalure_app",
    leastPrivilege: true,
    rlsActive: true,
  };
  const evaluated = runtimeIdentity.evaluateQaRuntimeDatabaseIdentity(row);
  assert.deepEqual(Object.keys(evaluated).sort(), [
    "databaseBranchId",
    "databaseTargetDigest",
    "leastPrivilege",
    "rlsActive",
  ]);
  assert.match(evaluated.databaseTargetDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(runtimeIdentity.isQaRuntimeDatabaseIdentityReady(evaluated), true);
  assert.equal(runtimeIdentity.matchesQaRuntimeDatabaseTarget(evaluated, {
    branchId: row.databaseBranchId,
    databaseName: row.databaseName,
    projectId: row.databaseProjectId,
    role: row.databaseRole,
  }), true);
  assert.equal(runtimeIdentity.isQaRuntimeDatabaseIdentityReady(
    runtimeIdentity.evaluateQaRuntimeDatabaseIdentity({ ...row, leastPrivilege: false }),
  ), false);
  assert.equal(runtimeIdentity.isQaRuntimeDatabaseIdentityReady(
    runtimeIdentity.evaluateQaRuntimeDatabaseIdentity({ ...row, rlsActive: false }),
  ), false);
  assert.equal(runtimeIdentity.evaluateQaRuntimeDatabaseIdentity({ ...row, databaseRole: "neondb_owner" }), null);
  assert.match(runtimeIdentity.qaRuntimeDatabaseIdentitySql, /not role_state\.rolsuper/);
  assert.match(runtimeIdentity.qaRuntimeDatabaseIdentitySql, /not role_state\.rolbypassrls/);
  assert.match(runtimeIdentity.qaRuntimeDatabaseIdentitySql, /row_security_active\('public\.qa_reset_audit_events'::regclass\)/);
  assert.match(runtimeIdentity.qaRuntimeDatabaseIdentitySql, /has_table_privilege\([\s\S]*SELECT WITH GRANT OPTION/);
  assert.match(runtimeIdentity.qaRuntimeDatabaseIdentitySql, /INSERT WITH GRANT OPTION[\s\S]*has_any_column_privilege\(/);
});

test("same-transaction QA target guard blocks actual drift and Production branch overlap before DML", async () => {
  const drifted = fakeTransaction(() => null, {
    ...runtimeTargetRow,
    branchId: runtimeDatabaseEnvironment.NOVALURE_PRODUCTION_BRANCH_ID,
  });
  await assert.rejects(
    repository.registerQaBatchObjects(drifted.transaction, {
      actorId,
      batchId,
      objects: [{ id: contactId, type: "contacts" }],
      workspaceId: workspaceA,
    }),
    (error) => error?.code === "QA_BATCH_DATABASE_TARGET_MISMATCH" && error.status === 503,
  );
  assert.equal(drifted.calls.some((call) => /insert|update|delete/i.test(call.sql)), false);

  const isolated = fakeTransaction(() => null);
  await assert.rejects(
    targetGuard.assertQaRuntimeTargetInTransaction(isolated.transaction, {
      ...runtimeDatabaseEnvironment,
      NOVALURE_PRODUCTION_BRANCH_ID: runtimeDatabaseEnvironment.NOVALURE_QA_BRANCH_ID,
    }),
    (error) => error?.code === "QA_BATCH_DATABASE_ISOLATION_INVALID" && error.status === 503,
  );
  assert.equal(isolated.calls.length, 0);
});

test("registration commits every exact object and reports committed", async () => {
  let insertIndex = 0;
  const fixture = fakeTransaction(({ sql }) => {
    if (/insert into qa_batch_objects/i.test(sql)) return { id: `ledger-${insertIndex += 1}` };
    return null;
  });
  const status = await repository.registerQaBatchObjects(fixture.transaction, {
    actorId,
    batchId,
    objects: [
      { id: contactId, type: "contacts" },
      { id: consentId, type: "consent_records" },
    ],
    workspaceId: workspaceA,
  });
  assert.equal(status, "committed");
  const inserts = fixture.calls.filter((call) => /insert into qa_batch_objects/i.test(call.sql));
  assert.equal(inserts.length, 2);
  assert.deepEqual(inserts.map((call) => call.params[2]), ["contacts", "consent_records"]);
  assert.ok(inserts.every((call) => call.params[0] === workspaceA && call.params[1] === batchId));
});

test("batch registration is allowed before execute and sealed after execute", async () => {
  const beforeExecute = fakeTransaction(({ sql }) => {
    if (/from qa_batches batch/i.test(sql)) return { id: batchId };
    if (/from qa_reset_audit_events/i.test(sql)) return null;
    return null;
  });
  await assert.doesNotReject(() => repository.assertQaBatchForMutation(beforeExecute.transaction, {
    batchId,
    workspaceId: workspaceA,
  }));
  assert.ok(beforeExecute.calls.some((call) => /pg_advisory_xact_lock/i.test(call.sql)));

  const afterExecute = fakeTransaction(({ sql }) => {
    if (/from qa_batches batch/i.test(sql)) return { id: batchId };
    if (/from qa_reset_audit_events/i.test(sql)) return { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" };
    return null;
  });
  await assert.rejects(
    () => repository.assertQaBatchForMutation(afterExecute.transaction, { batchId, workspaceId: workspaceA }),
    (error) => error?.code === "QA_BATCH_SEALED" && error.status === 409,
  );
});

test("batch availability SQL passes the tenant single-statement guard", async () => {
  const calls = [];
  const releaseCalls = [];
  const client = {
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
      calls.push({ normalized, params: [...params], sql });

      if (["begin", "commit", "rollback"].includes(normalized)) return { rows: [] };
      if (normalized.includes("set_config('app.tenant_id'")) {
        return { rows: [{ actorId: params[1], workspaceId: params[0] }] };
      }
      if (normalized.includes("current_setting('neon.project_id'")) {
        return { rows: [runtimeTargetRow] };
      }
      if (normalized.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (normalized.includes("from qa_batches batch")) return { rows: [{ id: batchId }] };
      if (normalized.includes("from qa_reset_audit_events")) return { rows: [] };

      throw new Error(`Unexpected SQL in tenant guard regression test: ${normalized}`);
    },
    release(error) {
      releaseCalls.push(Boolean(error));
    },
  };
  const pool = { connect: async () => client };

  await assert.doesNotReject(() => withTenantTransaction(
    { actorId, workspaceId: workspaceA },
    (transaction) => repository.assertQaBatchForMutation(transaction, {
      batchId,
      workspaceId: workspaceA,
    }),
    { pool },
  ));

  const batchQuery = calls.find(({ normalized }) => normalized.includes("from qa_batches batch"));
  assert.ok(batchQuery, "the guarded QA batch query must reach the checked-out client");
  assert.match(batchQuery.sql, /for share of workspace/i);
  assert.equal(calls.at(-1).normalized, "commit");
  assert.deepEqual(releaseCalls, [false]);
});

test("registration delayed behind a parallel reset observes executed evidence and fails closed", async () => {
  let releaseFence;
  let resetCommitted = false;
  const fence = new Promise((resolve) => {
    releaseFence = resolve;
  });
  const delayedRegistration = fakeTransaction(async ({ sql }) => {
    if (/pg_advisory_xact_lock/i.test(sql)) {
      await fence;
      return null;
    }
    if (/from qa_batches batch/i.test(sql)) return { id: batchId };
    if (/from qa_reset_audit_events/i.test(sql)) {
      return resetCommitted ? { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" } : null;
    }
    return null;
  });

  const pending = repository.assertQaBatchForMutation(delayedRegistration.transaction, {
    batchId,
    workspaceId: workspaceA,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delayedRegistration.calls.filter((call) => /pg_advisory_xact_lock/i.test(call.sql)).length, 1);
  resetCommitted = true;
  releaseFence();
  await assert.rejects(
    () => pending,
    (error) => error?.code === "QA_BATCH_SEALED",
  );
  assert.equal(delayedRegistration.calls.some((call) => /insert into qa_batch_objects/i.test(call.sql)), false);
});

test("same-batch replay is already-registered and foreign ownership fails closed", async () => {
  const sameBatch = fakeTransaction(({ sql }) => {
    if (/insert into qa_batch_objects/i.test(sql)) return null;
    if (/from qa_batch_objects/i.test(sql)) return { batchId, workspaceId: workspaceA };
    return null;
  });
  assert.equal(await repository.registerQaBatchObjects(sameBatch.transaction, {
    actorId,
    batchId,
    objects: [{ id: contactId, type: "contacts" }],
    workspaceId: workspaceA,
  }), "already-registered");

  const foreignBatch = fakeTransaction(({ sql }) => {
    if (/insert into qa_batch_objects/i.test(sql)) return null;
    if (/from qa_batch_objects/i.test(sql)) return { batchId: workspaceB, workspaceId: workspaceA };
    return null;
  });
  await assert.rejects(
    () => repository.registerQaBatchObjects(foreignBatch.transaction, {
      actorId,
      batchId,
      objects: [{ id: contactId, type: "contacts" }],
      workspaceId: workspaceA,
    }),
    (error) => error?.code === "QA_BATCH_OBJECT_NOT_OWNED" && error.status === 409,
  );
});

test("anonymous Public descendants require fixture owner, transaction actor and batch creator equality", async () => {
  const owned = fakeTransaction(({ sql }) => {
    if (/from qa_batch_objects object/i.test(sql)) {
      return { actorId, batchId, transactionActorId: actorId };
    }
    return null;
  });
  assert.deepEqual(
    await repository.findActiveQaBatchForObject(owned.transaction, {
      object: { id: contactId, type: "forms" },
      workspaceId: workspaceA,
    }),
    { actorId, batchId },
  );

  const foreignActor = fakeTransaction(({ sql }) => {
    if (/from qa_batch_objects object/i.test(sql)) {
      return { actorId, batchId, transactionActorId: workspaceB };
    }
    return null;
  });
  await assert.rejects(
    repository.findActiveQaBatchForObject(foreignActor.transaction, {
      object: { id: contactId, type: "forms" },
      workspaceId: workspaceA,
    }),
    (error) => error?.code === "QA_BATCH_ACTOR_MISMATCH" && error.status === 409,
  );
  assert.match(foreignActor.calls.at(-1).sql, /current_setting\('app\.actor_id', true\)/u);
  assert.match(foreignActor.calls.at(-1).sql, /batch\.created_by_user_id/u);
});

test("pre-existing unregistered deal replay fails before any QA ledger insert", async () => {
  const fixture = fakeTransaction(({ sql }) => {
    if (/from qa_batch_objects/i.test(sql)) return null;
    if (/insert into qa_batch_objects/i.test(sql)) {
      throw new Error("ledger insert must be unreachable");
    }
    return null;
  });

  await assert.rejects(
    () => repository.registerQaBatchObjectsWithOwnershipGuard(fixture.transaction, {
      actorId,
      batchId,
      objects: [{ id: dealId, type: "deals" }],
      preExistingObjects: [{ id: dealId, type: "deals" }],
      workspaceId: workspaceA,
    }),
    (error) => error?.code === "QA_BATCH_OBJECT_NOT_OWNED" && error.status === 409,
  );
  assert.equal(
    fixture.calls.filter((call) => /insert into qa_batch_objects/i.test(call.sql)).length,
    0,
  );
});

test("parallel idempotency collisions against an unregistered baseline roll back with zero ledger rows", async () => {
  let ownershipReads = 0;
  let releaseOwnershipReads;
  const ownershipBarrier = new Promise((resolve) => {
    releaseOwnershipReads = resolve;
  });
  const createCollisionTransaction = () => fakeTransaction(async ({ sql }) => {
    if (/from qa_batch_objects/i.test(sql)) {
      ownershipReads += 1;
      if (ownershipReads === 2) releaseOwnershipReads();
      await ownershipBarrier;
      return null;
    }
    if (/insert into qa_batch_objects/i.test(sql)) {
      throw new Error("ledger insert must be unreachable");
    }
    return null;
  });
  const left = createCollisionTransaction();
  const right = createCollisionTransaction();
  const command = (fixture) => repository.registerQaBatchObjectsWithOwnershipGuard(
    fixture.transaction,
    {
      actorId,
      batchId,
      objects: [{ id: dealId, type: "deals" }],
      preExistingObjects: [{ id: dealId, type: "deals" }],
      workspaceId: workspaceA,
    },
  );

  const settled = await Promise.allSettled([command(left), command(right)]);
  assert.equal(settled.every((result) =>
    result.status === "rejected" && result.reason?.code === "QA_BATCH_OBJECT_NOT_OWNED"
  ), true);
  assert.equal(
    [...left.calls, ...right.calls]
      .filter((call) => /insert into qa_batch_objects/i.test(call.sql)).length,
    0,
  );
});

test("runtime routes and repositories enforce the atomic contract", async () => {
  const [capability, identity, contacts, deals, resetRoute, blueprint, writes, registration, resetRepository, guard] = await Promise.all([
    read("src/app/api/admin/qa-batch-capability/route.ts"),
    read("src/app/api/admin/qa-runtime-identity/route.ts"),
    read("src/app/api/crm/contacts/route.ts"),
    read("src/app/api/crm/deals/route.ts"),
    read("src/app/api/admin/qa-reset/route.ts"),
    read("src/app/api/funnels/[funnelId]/blueprint/route.ts"),
    read("src/lib/db/crm-write-repositories.ts"),
    read("src/lib/db/qa-batch-registration-repository.ts"),
    read("src/lib/db/qa-reset-repository.ts"),
    read("src/lib/db/qa-runtime-target-guard.ts"),
  ]);
  assert.match(capability, /atomicRegistration:\s*true/);
  assert.match(capability, /resolveQaBatchCapabilityConfig\(\)/);
  assert.match(capability, /canAdministerQaReset\(session\)/);
  assert.match(capability, /withTenantTransaction/);
  assert.match(capability, /has_table_privilege\(current_user, 'public\.qa_batch_objects', 'SELECT,INSERT'\)/);
  assert.match(capability, /databaseTargetDigest:/);
  assert.match(capability, /databaseLeastPrivilege:/);
  assert.match(capability, /databaseRlsActive:/);
  assert.match(capability, /searchParams\.get\("batchId"\)/);
  assert.match(capability, /batch\.created_by_user_id as "createdByUserId"/);
  assert.match(capability, /batch\.metadata->>'deploymentId' as "deploymentId"/);
  assert.match(capability, /batch\.metadata->>'purpose' as "purpose"/);
  assert.match(capability, /QA_BATCH_NOT_FRESH_OR_BOUND/);
  assert.match(capability, /publicRuntimeAtomicSurfaces: qaPublicRuntimeAtomicSurfaces/);
  assert.equal(runtime.qaBatchCapabilityVersion, 2);
  assert.deepEqual(runtime.qaPublicRuntimeAtomicSurfaces, {
    blueprint: true,
    formPublicSubmit: true,
    formUpsert: true,
    funnelCreate: true,
    funnelPublicSubmit: true,
    reset: true,
    tokenRotation: true,
  });
  assert.match(identity, /resolveQaBatchCapabilityConfig\(\)/);
  assert.match(identity, /queryOne<QaRuntimeDatabaseIdentityRow>\(qaRuntimeDatabaseIdentitySql\)/);
  assert.match(identity, /databaseTargetDigest:/);
  assert.match(identity, /databaseLeastPrivilege:/);
  assert.match(identity, /databaseRlsActive:/);
  assert.match(identity, /"Cache-Control": "private, no-store, max-age=0"/);
  assert.doesNotMatch(identity, /getRequestSession|withTenantTransaction|workspaceId|userId|tenantId|sessionScope/);
  assert.doesNotMatch(identity, /databaseProjectId|databaseBranchId|databaseName|databaseRole/);
  assert.match(identity, /matchesQaRuntimeDatabaseTarget\(databaseIdentity, config\.databaseTarget\)/);
  for (const route of [contacts, deals]) {
    assert.match(route, /readQaBatchMutationHeader\(request, auth\.session\)/);
    assert.match(route, /qaBatchSuccessHeaders\(qaBatchId, result\.qaBatchRegistration\)/);
  }
  assert.match(writes, /const persistContact = async \(transaction: TenantTransaction\)/);
  assert.match(writes, /upsertConsentFromContact\([\s\S]*transaction,/);
  assert.match(writes, /registerQaBatchObjects\(transaction,/);
  assert.match(writes, /const persistDeal = async \(transaction: TenantTransaction\)/);
  assert.match(writes, /insertDealStageHistory\([\s\S]*transaction,/);
  assert.match(writes, /type: "deal_stage_history"/);
  assert.match(writes, /assertQaBatchOwnsObject\(transaction,/);
  assert.match(writes, /registerQaBatchObjectsWithOwnershipGuard\(transaction,/);
  assert.match(writes, /preExistingObjects: existing \|\| idempotentReplay/);
  assert.match(resetRoute, /resolveQaBatchCapabilityConfig\(\)/);
  assert.match(guard, /current_setting\('neon\.project_id'/);
  assert.match(guard, /current_setting\('neon\.branch_id'/);
  assert.match(guard, /current_database\(\)/);
  assert.match(guard, /current_user as "role"/);
  assert.match(registration, /assertQaRuntimeTargetInTransaction\(transaction\)/);
  assert.equal((blueprint.match(/qaBatchRuntimeErrorResponse\(error\)/g) ?? []).length, 3);
  assert.match(blueprint, /return qaError;/);
  assert.ok(
    resetRepository.indexOf("await assertQaRuntimeTargetInTransaction(transaction)")
      < resetRepository.indexOf("await lockQaBatchFence(transaction, input.batchId)"),
  );
  const replayIndex = writes.indexOf("const idempotentReplay = !existing && row.wasInserted === false");
  const guardedRegistrationIndex = writes.indexOf("registerQaBatchObjectsWithOwnershipGuard(transaction", replayIndex);
  const returnIndex = writes.indexOf("return { idempotentReplay, qaBatchRegistration, row }", replayIndex);
  assert.ok(replayIndex >= 0 && replayIndex < guardedRegistrationIndex && guardedRegistrationIndex < returnIndex);
});
