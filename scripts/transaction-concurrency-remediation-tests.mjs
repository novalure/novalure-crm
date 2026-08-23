import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import {
  buildPublicContactIdentityLocks,
  publicContactIdentityLockNamespace,
} from "../src/lib/security/public-contact-identity.ts";
import { resolveContactIdentityMutation } from "../src/lib/contact-identity-mutation.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const nodeRequire = createRequire(import.meta.url);

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

test("manual and public contact writes share ordered identity locks and contact writes use CAS", async () => {
  const [contactsRoute, writes] = await Promise.all([
    source("src/app/api/crm/contacts/route.ts"),
    source("src/lib/db/crm-write-repositories.ts"),
  ]);
  assert.equal(publicContactIdentityLockNamespace, "public_contact_identity");
  assert.deepEqual(
    buildPublicContactIdentityLocks({
      email: " QA@Example.test ",
      fallback: "unused",
      phone: "+43 660 123",
    }),
    ["email:qa@example.test", "phone:+43660123"],
  );
  assert.match(writes, /publicContactIdentityLockNamespace, identityLock/);
  assert.match(writes, /hashtextextended\(\$1::text \|\| ':' \|\| \$2::text \|\| ':' \|\| \$3::text/);
  assert.match(writes, /lower\(btrim\(email\)\) = \$2::text/);
  assert.match(writes, /regexp_replace\(coalesce\(phone, ''\), '\[\^0-9\+\]', '', 'g'\) = \$3::text/);
  assert.match(writes, /c\.archived_at is null[\s\S]*c\.updated_at = \$14::timestamptz/);
  assert.match(writes, /archived_at is null[\s\S]*updated_at = \$5::timestamptz/);
  assert.match(contactsRoute, /normalizedReason\.includes\("conflict"\)\) return 409/);
});

test("CRM repositories retain textual PostgreSQL CAS tokens and strict timestamp equality", async () => {
  const [tasksRoute, writes] = await Promise.all([
    source("src/app/api/crm/tasks/route.ts"),
    source("src/lib/db/crm-write-repositories.ts"),
  ]);
  const contactSelect = writes.slice(writes.indexOf("const contactSelectSql"), writes.indexOf("const leadReturningSql"));
  const leadSelect = writes.slice(writes.indexOf("const leadReturningSql"), writes.indexOf("const dealSelectSql"));
  const dealSelect = writes.slice(writes.indexOf("const dealSelectSql"), writes.indexOf("const dealUpdateSql"));
  const taskSelect = writes.slice(writes.indexOf("const taskSelectSql"));

  assert.match(contactSelect, /c\.updated_at::text as "updatedAt"/);
  assert.match(leadSelect, /updated_at::text as "updatedAt"/);
  assert.match(dealSelect, /d\.updated_at::text as "updatedAt"/);
  assert.match(taskSelect, /t\.updated_at::text as "updatedAt"/);

  const dealUpdate = writes.slice(writes.indexOf("export async function upsertDealRecord"), writes.indexOf("export async function upsertTaskRecord"));
  const taskUpdate = writes.slice(writes.indexOf("export async function upsertTaskRecord"), writes.indexOf("export async function listNoteRecords"));
  const leadUpdate = writes.slice(writes.indexOf("export async function upsertLeadRecord"), writes.indexOf("export async function upsertContactRecord"));
  const contactUpdate = writes.slice(writes.indexOf("export async function upsertContactRecord"), writes.indexOf("export async function archiveContactRecord"));
  const contactArchive = writes.slice(writes.indexOf("export async function archiveContactRecord"), writes.indexOf("export async function upsertFunnelRecord"));

  assert.match(dealUpdate, /updated_at = \$21::timestamptz/);
  assert.match(taskUpdate, /updated_at = \$12::timestamptz/);
  assert.match(leadUpdate, /updated_at = \$26::timestamptz/);
  assert.match(contactUpdate, /c\.updated_at = \$14::timestamptz/);
  assert.match(contactArchive, /updated_at = \$5::timestamptz/);
  assert.doesNotMatch(`${dealUpdate}\n${taskUpdate}\n${leadUpdate}\n${contactUpdate}\n${contactArchive}`, /date_trunc|interval\s+'/i);
  assert.match(taskUpdate, /JSON\.stringify\(taskMetadata\),\s*existing\.updatedAt,/);
  assert.doesNotMatch(taskUpdate, /updated_at = \$26::timestamptz/);
  assert.match(taskUpdate, /existing \? "Concurrent task update conflict" : "Task could not be saved"/);
  assert.match(tasksRoute, /normalizedReason\.includes\("conflict"\)\) return 409/);
});

test("Task route maps only controlled CAS misses to 409", async () => {
  let repositoryWrite = async () => ({ persisted: false, reason: "Concurrent task update conflict" });
  const route = await loadCommonJsTypeScript("src/app/api/crm/tasks/route.ts", {
    "next/server": {
      NextResponse: {
        json(body, init = {}) {
          return { body, status: init.status ?? 200 };
        },
      },
    },
    "@/lib/auth/session": {
      resolveWorkspaceScopedSession: async () => ({ ok: true, session: {} }),
    },
    "@/lib/db/crm-write-repositories": {
      upsertTaskRecord: (...args) => repositoryWrite(...args),
    },
  });
  const request = { json: async () => ({ task: { title: "CAS regression" } }) };

  assert.equal((await route.PATCH(request)).status, 409);

  repositoryWrite = async () => ({ persisted: false, reason: "Task could not be saved" });
  assert.equal((await route.POST(request)).status, 503);

  repositoryWrite = async () => ({ persisted: false, reason: "DATABASE_URL is not configured" });
  assert.equal((await route.POST(request)).status, 503);

  repositoryWrite = async () => {
    throw new Error("database transport failed");
  };
  await assert.rejects(() => route.POST(request), /database transport failed/);
});

test("sparse Contact PATCH retains identity while explicit empty fields clear only the requested channel", async () => {
  assert.deepEqual(
    resolveContactIdentityMutation({
      currentEmail: "owner@example.test",
      currentPhone: "+43 660 123",
      patch: { intent: "updated" },
    }),
    {
      email: "owner@example.test",
      emailProvided: false,
      phone: "+43 660 123",
      phoneProvided: false,
    },
  );
  assert.deepEqual(
    resolveContactIdentityMutation({
      currentEmail: "owner@example.test",
      currentPhone: "+43 660 123",
      patch: { email: "" },
    }),
    {
      email: "",
      emailProvided: true,
      phone: "+43 660 123",
      phoneProvided: false,
    },
  );
  assert.deepEqual(
    resolveContactIdentityMutation({
      currentEmail: "owner@example.test",
      currentPhone: "+43 660 123",
      patch: { phone: null },
    }),
    {
      email: "owner@example.test",
      emailProvided: false,
      phone: "",
      phoneProvided: true,
    },
  );

  const writes = await source("src/lib/db/crm-write-repositories.ts");
  assert.match(writes, /resolveContactIdentityMutation\(\{[\s\S]*currentEmail: existing\?\.email[\s\S]*patch: input\.contact/);
  assert.match(writes, /normalizePublicContactEmail\(email\)[\s\S]*normalizePublicContactPhone\(phone\)/);
  assert.match(writes, /buildPublicContactIdentityLocks\(\{[\s\S]*email: normalizedEmail[\s\S]*phone: normalizedPhone/);
  assert.match(writes, /cleanString\(input\.contact\.consent\) \|\| existing\.consent,[\s\S]*email,[\s\S]*phone,/);
});

test("contact archive, audit, and analytics commit in one tenant transaction", async () => {
  const writes = await source("src/lib/db/crm-write-repositories.ts");
  const start = writes.indexOf("const persistArchive = async (transaction: TenantTransaction)");
  const transaction = writes.indexOf("const persistedArchive = await withTenantTransaction(", start);
  const end = writes.indexOf("export async function upsertFunnelDraft", start);
  assert.ok(start >= 0 && transaction > start && end > transaction);
  const block = writes.slice(start, end);
  assert.match(block, /writeAuditLog\([\s\S]*transaction,/);
  assert.match(block, /recordAnalyticsEvent\([\s\S]*transaction,/);
  assert.doesNotMatch(block.slice(transaction), /await Promise\.all\(\[[\s\S]*writeAuditLog/);
});

test("both funnel editors reject stale content under the row lock", async () => {
  const [blueprintRoute, designer, crmLoader, crmRoute, store, writes] = await Promise.all([
    source("src/app/api/funnels/[funnelId]/blueprint/route.ts"),
    source("src/components/funnel-blueprint-designer.tsx"),
    source("src/lib/db/crm-loaders.ts"),
    source("src/app/api/crm/funnels/route.ts"),
    source("src/lib/funnel-store.ts"),
    source("src/lib/db/crm-write-repositories.ts"),
  ]);
  assert.match(blueprintRoute, /expectedBlueprintRevision/);
  assert.match(blueprintRoute, /includes\("conflict"\) \? 409/);
  assert.match(designer, /JSON\.stringify\(\{ blueprint, expectedBlueprintRevision, label:/);
  assert.match(crmLoader, /updated_at as "updatedAt"/);
  assert.match(crmLoader, /tracking->'blueprintRevision'/);
  assert.match(crmRoute, /normalizedReason\.includes\("conflict"\)\) return 409/);
  const lock = store.indexOf("for update of f");
  const compare = store.indexOf("expectedBlueprintRevision !== readBlueprintRevision", lock);
  const update = store.indexOf("update funnels", compare);
  assert.ok(lock >= 0 && lock < compare && compare < update);
  assert.match(store.slice(compare, update + 1_400), /blueprintRevision/);
  assert.match(store.slice(compare, update + 900), /publicationRevision/);
  assert.match(store, /writeAuditLog\(\{[\s\S]*action: auditAction[\s\S]*transaction,/);
  assert.match(store, /"funnel\.version_restored"/);
  assert.match(writes, /tracking->'blueprintRevision'[\s\S]*for update/);
  assert.match(writes, /expectedBlueprintRevision !== currentBlueprintRevision[\s\S]*Concurrent funnel update conflict/);
  const crmUpdate = writes.slice(
    writes.indexOf("update funnels", writes.indexOf("export async function upsertFunnelDraft")),
    writes.indexOf("returning", writes.indexOf("update funnels", writes.indexOf("export async function upsertFunnelDraft"))),
  );
  assert.doesNotMatch(crmUpdate, /\b(?:visits|leads_count|conversion_rate)\s*=/);
});

test("funnel content revision survives metric timestamps and parallel saves have one winner", async () => {
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const actorId = "22222222-2222-4222-8222-222222222222";
  const projectId = "33333333-3333-4333-8333-333333333333";
  const funnelId = "44444444-4444-4444-8444-444444444444";
  const blueprint = {
    audience: "Käufer",
    crmHandover: {},
    entryChannel: "Website",
    goal: "Lead generieren",
    id: funnelId,
    name: "CAS QA",
    pages: [],
    projectId,
    schemaVersion: 1,
    status: "entwurf",
    tracking: { consentMode: "explicit" },
    workspaceId,
  };
  const state = {
    audits: [],
    failAudit: false,
    nextTimestamp: 1,
    row: {
      audience: blueprint.audience,
      blueprint: {
        blueprint,
        schemaVersion: 1,
        updatedAt: "1999-01-01T00:00:00.000Z",
        versions: [],
      },
      entryChannel: blueprint.entryChannel,
      goal: blueprint.goal,
      id: funnelId,
      name: blueprint.name,
      ownerUserId: actorId,
      projectId,
      status: blueprint.status,
      tracking: { blueprintRevision: 0, publicationRevision: 0 },
      updatedAt: "2026-08-22T10:00:00.000Z",
      workspaceId,
      workspaceName: "QA",
    },
  };
  let queue = Promise.resolve();

  const transaction = {
    async execute() {},
    async query() { return []; },
    async queryOne(sql, params = []) {
      if (/from funnels f[\s\S]*for update of f/u.test(sql)) {
        return structuredClone(state.row);
      }
      if (/select id[\s\S]*from projects/u.test(sql)) return { id: projectId };
      if (/update funnels/u.test(sql)) {
        const timestamp = `2026-08-22T10:00:0${state.nextTimestamp}.000Z`;
        state.nextTimestamp += 1;
        const incomingTracking = JSON.parse(params[10]);
        state.row = {
          ...state.row,
          blueprint: JSON.parse(params[9]),
          tracking: {
            ...state.row.tracking,
            ...incomingTracking,
            blueprintRevision: state.row.tracking.blueprintRevision + 1,
            publicationRevision: state.row.tracking.publicationRevision + 1,
          },
          updatedAt: timestamp,
        };
        return structuredClone(state.row);
      }
      if (/insert into audit_logs/u.test(sql)) {
        if (state.failAudit) throw new Error("forced audit failure");
        state.audits.push(params);
        return { id: "55555555-5555-4555-8555-555555555555" };
      }
      throw new Error(`Unexpected SQL in funnel CAS harness: ${sql}`);
    },
  };
  async function withTenantTransaction(_scope, callback) {
    const previous = queue;
    let release;
    queue = new Promise((resolve) => { release = resolve; });
    await previous;
    const snapshot = structuredClone({ audits: state.audits, nextTimestamp: state.nextTimestamp, row: state.row });
    try {
      return await callback(transaction);
    } catch (error) {
      state.audits = snapshot.audits;
      state.nextTimestamp = snapshot.nextTimestamp;
      state.row = snapshot.row;
      throw error;
    } finally {
      release();
    }
  }

  const store = await loadCommonJsTypeScript("src/lib/funnel-store.ts", {
    "@/lib/db/client": {
      hasDatabaseUrl: () => true,
      queryOne: async () => structuredClone(state.row),
    },
    "@/lib/db/tenant-client": { withTenantTransaction },
    "@/lib/db/runtime-repositories": {
      writeAuditLog: async ({ action, transaction: auditTransaction }) => {
        await auditTransaction.queryOne("insert into audit_logs (action) values ($1) returning id", [action]);
      },
    },
    "@/lib/funnel-builder-adapter": { buildFunnelBlueprint: () => blueprint },
    "@/lib/funnel-live-preflight": { assertFunnelLivePreflight() {} },
    "@/lib/funnel-schema": { funnelSchemaVersion: 1 },
    "@/lib/launch-scope": { evaluateLaunchScope: () => ({ allowed: true }) },
  });
  const session = { userId: actorId, workspaceId };

  const loaded = await store.getStoredFunnel(funnelId, workspaceId);
  assert.equal(loaded.updatedAt, state.row.updatedAt);
  assert.notEqual(loaded.updatedAt, state.row.blueprint.updatedAt);
  assert.equal(loaded.blueprintRevision, 0);

  // Runtime submissions and token rotations may touch updated_at, but they do
  // not change the content revision used by either editor.
  state.row.updatedAt = "2026-08-22T10:30:00.000Z";
  const first = await store.saveStoredFunnel(blueprint, "first", session, loaded.blueprintRevision);
  assert.equal(first.blueprintRevision, 1);
  const second = await store.saveStoredFunnel(blueprint, "second", session, first.blueprintRevision);
  assert.equal(second.blueprintRevision, 2);

  const settled = await Promise.allSettled([
    store.saveStoredFunnel(blueprint, "parallel-a", session, second.blueprintRevision),
    store.saveStoredFunnel(blueprint, "parallel-b", session, second.blueprintRevision),
  ]);
  assert.equal(settled.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(settled.filter((item) => item.status === "rejected").length, 1);
  assert.match(settled.find((item) => item.status === "rejected").reason.message, /conflict/i);
  assert.equal(state.audits.length, 3);

  const beforeFailedAudit = structuredClone(state.row);
  state.failAudit = true;
  await assert.rejects(
    store.saveStoredFunnel(
      blueprint,
      "audit-failure",
      session,
      beforeFailedAudit.tracking.blueprintRevision,
    ),
    /forced audit failure/,
  );
  assert.deepEqual(state.row, beforeFailedAudit);
  assert.equal(state.audits.length, 3);
});

test("transaction-bound audit and analytics helpers rethrow instead of hiding rollback failures", async () => {
  const [analytics, runtime, speed] = await Promise.all([
    source("src/lib/db/analytics-event-repositories.ts"),
    source("src/lib/db/runtime-repositories.ts"),
    source("src/lib/db/speed-to-lead-repositories.ts"),
  ]);
  assert.match(runtime, /transaction\?: TenantTransaction/);
  assert.match(runtime, /input\.transaction\.queryOne\(query, params\)/);
  assert.match(analytics, /if \(input\.transaction\) throw error/);
  assert.match(speed, /if \(input\.transaction\) throw error/);
});
