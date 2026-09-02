import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  tenantQuery,
  withTenantTransaction,
} from "../src/lib/db/tenant-client.ts";
import { runTenantHardeningInventory } from "./tenant-hardening-inventory.mjs";

const firstScope = Object.freeze({
  actorId: "00000000-0000-4000-8000-000000000011",
  workspaceId: "00000000-0000-4000-8000-000000000001",
});
const secondScope = Object.freeze({
  actorId: "00000000-0000-4000-8000-000000000022",
  workspaceId: "00000000-0000-4000-8000-000000000002",
});

function result(rows = []) {
  return { rows };
}

class ReusedPoolClient {
  active = false;
  context = {};
  queries = [];
  releaseCalls = [];

  async query(query, params = []) {
    const normalized = query.replace(/\s+/g, " ").trim().toLowerCase();
    this.queries.push({ params: [...params], query: normalized });

    if (normalized === "begin") {
      assert.equal(this.active, false, "pool connection must not already have a transaction");
      this.active = true;
      return result();
    }
    if (normalized === "commit" || normalized === "rollback") {
      this.active = false;
      this.context = {};
      return result();
    }
    if (normalized.includes("set_config('app.tenant_id'")) {
      assert.equal(this.active, true);
      this.context = { actorId: params[1], workspaceId: params[0] };
      return result([{ ...this.context }]);
    }
    if (normalized.includes("current_setting('app.tenant_id'")) {
      assert.equal(this.active, true);
      return result([{ ...this.context }]);
    }
    if (normalized === "select $1::text as value") {
      return result([{ value: params[0] }]);
    }

    return result();
  }

  release(error) {
    this.releaseCalls.push(Boolean(error));
  }
}

function reusedPool(client = new ReusedPoolClient()) {
  return {
    client,
    connectCalls: 0,
    async connect() {
      this.connectCalls += 1;
      return client;
    },
  };
}

test("tenant transactions bind actor and workspace locally and clear them before pool reuse", async () => {
  const pool = reusedPool();
  let escapedTransaction;

  const first = await withTenantTransaction(
    firstScope,
    async (transaction) => {
      escapedTransaction = transaction;
      return transaction.queryOne(`
        select
          current_setting('app.tenant_id', true) as "workspaceId",
          current_setting('app.actor_id', true) as "actorId"
      `);
    },
    { pool },
  );
  assert.deepEqual(first, firstScope);
  assert.deepEqual(pool.client.context, {});

  const second = await withTenantTransaction(
    secondScope,
    (transaction) => transaction.queryOne(`
      select
        current_setting('app.tenant_id', true) as "workspaceId",
        current_setting('app.actor_id', true) as "actorId"
    `),
    { pool },
  );
  assert.deepEqual(second, secondScope);
  assert.equal(pool.connectCalls, 2);
  assert.deepEqual(pool.client.releaseCalls, [false, false]);
  assert.deepEqual(pool.client.context, {});
  await assert.rejects(() => escapedTransaction.query("select 1"), /no longer active/);
});

test("tenantQuery has no unscoped fallback and uses the transaction-bound client", async () => {
  const pool = reusedPool();
  const rows = await tenantQuery(
    firstScope,
    "select $1::text as value",
    ["tenant-bound"],
    { pool },
  );
  assert.deepEqual(rows, [{ value: "tenant-bound" }]);
  assert.deepEqual(
    pool.client.queries.map(({ query }) => query),
    [
      "begin",
      "select set_config('app.tenant_id', $1, true) as \"workspaceid\", set_config('app.actor_id', $2, true) as \"actorid\"",
      "select $1::text as value",
      "commit",
    ],
  );
});

test("invalid scope is rejected before pool checkout", async () => {
  const pool = reusedPool();
  await assert.rejects(
    () => withTenantTransaction({ ...firstScope, workspaceId: "" }, async () => undefined, { pool }),
    /valid workspaceId/,
  );
  await assert.rejects(
    () => withTenantTransaction({ ...firstScope, actorId: "service" }, async () => undefined, { pool }),
    /valid actorId/,
  );
  assert.equal(pool.connectCalls, 0);
});

test("callback failures roll back and transaction/context control statements are blocked", async () => {
  const pool = reusedPool();
  await assert.rejects(
    () => withTenantTransaction(firstScope, async () => {
      throw new Error("callback failed");
    }, { pool }),
    /callback failed/,
  );
  await assert.rejects(
    () => withTenantTransaction(firstScope, (transaction) => transaction.query("commit"), { pool }),
    /cannot change transaction/,
  );
  await assert.rejects(
    () => withTenantTransaction(
      firstScope,
      (transaction) => transaction.query("select 1; reset app.tenant_id"),
      { pool },
    ),
    /exactly one SQL statement/,
  );
  await assert.rejects(
    () => withTenantTransaction(
      firstScope,
      (transaction) => transaction.query("select set_config('app.tenant_id', $1, true)", [secondScope.workspaceId]),
      { pool },
    ),
    /cannot change transaction/,
  );
  assert.equal(pool.client.queries.filter(({ query }) => query === "rollback").length, 4);
  assert.deepEqual(pool.client.context, {});
});

test("context verification mismatch fails closed and rolls back", async () => {
  const client = new ReusedPoolClient();
  const originalQuery = client.query.bind(client);
  client.query = async (query, params = []) => {
    const response = await originalQuery(query, params);
    if (query.includes("set_config('app.tenant_id'")) {
      return result([{ actorId: secondScope.actorId, workspaceId: params[0] }]);
    }
    return response;
  };
  const pool = reusedPool(client);

  await assert.rejects(
    () => withTenantTransaction(firstScope, async () => undefined, { pool }),
    /could not be verified/,
  );
  assert.equal(client.queries.at(-1).query, "rollback");
  assert.deepEqual(client.context, {});
});

test("060 prepares only the five-table pilot with NOT VALID tenant FKs and append-only audit", async () => {
  const sql = await readFile(new URL("../migrations/060_tenant_rls_pilot_prepare.sql", import.meta.url), "utf8");
  const constraintNames = [
    "contacts_workspace_project_fk",
    "contacts_workspace_organization_fk",
    "contacts_workspace_owner_fk",
    "contacts_workspace_archived_by_fk",
    "leads_workspace_project_fk",
    "leads_workspace_contact_fk",
    "leads_workspace_assignee_fk",
    "deals_workspace_project_fk",
    "deals_workspace_contact_fk",
    "deals_workspace_organization_fk",
    "deals_workspace_owner_fk",
    "deals_workspace_lead_fk",
    "audit_logs_workspace_actor_fk",
    "audit_logs_workspace_project_fk",
    "audit_logs_workspace_deal_fk",
  ];

  for (const constraintName of constraintNames) {
    assert.match(sql, new RegExp(`['"]${constraintName}['"]`));
  }
  assert.equal((sql.match(/initially deferred not valid/gi) ?? []).length, 15);
  assert.match(sql, /array\['projects', 'contacts', 'leads', 'deals'\]/);
  assert.match(sql, /using\s*\([\s\S]*current_setting\('app\.tenant_id', true\)/i);
  assert.match(sql, /with check\s*\([\s\S]*current_setting\('app\.actor_id', true\)/i);
  assert.doesNotMatch(sql, /enable row level security/i);
  assert.match(sql, /before update or delete or truncate on audit_logs/i);
  assert.match(sql, /audit_logs is append-only/i);
  assert.match(sql, /revoke update, delete, truncate on audit_logs from public/i);
  assert.match(sql, /nologin[\s\S]*nobypassrls/i);
});

test("061 validates only durable relationships, gates provider roles, applies minimal grants, and activates only the pilot", async () => {
  const sql = await readFile(
    new URL("../migrations/061_validate_and_activate_tenant_rls_pilot.sql", import.meta.url),
    "utf8",
  );
  assert.equal((sql.match(/validate constraint [a-z0-9_]+;/gi) ?? []).length, 13);
  assert.match(sql, /Project\/deal IDs in audit_logs are immutable snapshots/i);
  assert.doesNotMatch(sql, /validate constraint audit_logs_workspace_project_fk/i);
  assert.doesNotMatch(sql, /validate constraint audit_logs_workspace_deal_fk/i);
  assert.match(sql, /validate constraint audit_logs_workspace_actor_fk/i);
  assert.equal((sql.match(/enable row level security;/gi) ?? []).length, 5);
  assert.equal((sql.match(/force row level security;/gi) ?? []).length, 5);
  for (const tableName of ["projects", "contacts", "leads", "deals", "audit_logs"]) {
    assert.match(sql, new RegExp(`alter table ${tableName} enable row level security`, "i"));
    assert.match(sql, new RegExp(`alter table ${tableName} force row level security`, "i"));
  }
  assert.match(sql, /exactly one fixed novalure_app membership/i);
  assert.match(sql, /shobj_description\(tenant_role_oid, 'pg_authid'\)/i);
  assert.match(sql, /novalure-tenant-cutover:/i);
  assert.match(sql, /rolbypassrls/i);
  assert.match(
    sql,
    /membership\.roleid = application_role_oid[\s\S]*membership\.member = tenant_role_oid/i,
  );
  assert.match(
    sql,
    /membership\.member = application_role_oid[\s\S]*membership\.roleid <> tenant_role_oid/i,
  );
  assert.doesNotMatch(sql, /pg_has_role/i);
  assert.match(
    sql,
    /pg_database database_row[\s\S]*database_row\.datdba in \(application_role_oid, tenant_role_oid\)/i,
  );
  assert.match(
    sql,
    /relation\.relowner not in \([\s\S]*pg_database_owner[\s\S]*database_row\.datdba/i,
  );
  assert.match(
    sql,
    /namespace\.nspowner not in \([\s\S]*pg_database_owner[\s\S]*database_row\.datdba/i,
  );
  assert.match(sql, /policy\.polroles <> array\[tenant_role_oid\]::oid\[\]/i);
  assert.match(sql, /policy\.polcmd <> expected\.command/i);
  assert.match(sql, /not policy\.polpermissive/i);
  assert.match(sql, /pg_get_expr\(policy\.polqual, policy\.polrelid, false\)/i);
  assert.match(sql, /trigger_row\.tgtype = 58/i);
  assert.match(sql, /trigger_row\.tgenabled = 'O'/i);
  assert.match(sql, /trigger_row\.tgfoid = 'public\.reject_audit_logs_mutation\(\)'::regprocedure/i);
  assert.match(sql, /pilot tables must retain a trusted database owner/i);
  assert.match(sql, /grant_entry\.grantee <> relation\.relowner/i);
  assert.match(sql, /when grant_entry\.grantee = tenant_role_oid/i);
  assert.doesNotMatch(sql, /else false/i);
  assert.match(
    sql,
    /aclexplode\(attribute\.attacl\) grant_entry[\s\S]*novalure_app can reach an unexpected pilot column ACL/i,
  );
  assert.match(sql, /grant select, insert on table audit_logs/i);
  assert.doesNotMatch(sql, /grant[^;]*(?:update|delete)[^;]*audit_logs/i);
  assert.match(sql, /revoke all on table projects, contacts, leads, deals, audit_logs from public/i);
  assert.match(sql, /revoke all on table projects, contacts, leads, deals, audit_logs from novalure_app/i);
  assert.match(sql, /revoke create on schema public from public/i);
  assert.match(sql, /revoke create on schema public from novalure_app/i);
  assert.match(sql, /revoke create on schema public from novalure_tenant_app/i);
  assert.match(sql, /namespace\.nspacl[\s\S]*public schema ACL or owner exceeds/i);
  assert.match(sql, /grant_entry\.grantee not in \(0, application_role_oid, tenant_role_oid\)/i);
  assert.match(sql, /role_row\.rolname = 'pg_database_owner'/i);
  assert.match(sql, /pg_attribute attribute[\s\S]*attribute\.attacl/i);
  assert.match(sql, /missing a required pilot table privilege/i);
});

test("062 verifies the exact audit guard before and after its transactional maintenance window", async () => {
  const sql = await readFile(
    new URL("../migrations/062_private_media_contract_cutover.sql", import.meta.url),
    "utf8",
  );
  assert.equal((sql.match(/trigger_row\.tgtype = 58/gi) ?? []).length, 2);
  assert.equal((sql.match(/trigger_row\.tgenabled = 'O'/gi) ?? []).length, 2);
  assert.equal((sql.match(/trigger_row\.tgfoid = 'public\.reject_audit_logs_mutation\(\)'::regprocedure/gi) ?? []).length, 2);
});

test("static inventory covers nullable tenants, FK/index gaps, QA row mismatches, roles, audit, and ledger", async () => {
  const source = await readFile(new URL("./tenant-hardening-inventory.mjs", import.meta.url), "utf8");
  assert.match(source, /workspaceNullable/);
  assert.match(source, /nullRows/);
  assert.match(source, /pg_constraint/);
  assert.match(source, /mismatchRows/);
  assert.match(source, /workspaceFkLeadingIndex/);
  assert.match(source, /pg_auth_members/);
  assert.match(source, /appendOnlyGuardEnabled/);
  assert.match(source, /unsafeInheritedLoginMembers/);
  assert.match(source, /applicationTableAclBoundaryViolation/);
  assert.match(source, /applicationColumnAclBoundaryViolation/);
  assert.match(source, /applicationReachableOwner/);
  assert.match(source, /unexpectedApplicationRoleReachability/);
  assert.match(source, /pilotPoliciesExact/);
  assert.match(source, /tgtype = 58/);
  assert.match(source, /membership\.roleid = application_role\.oid/);
  assert.match(source, /membership\.member = tenant_role\.oid/);
  assert.match(source, /applicationOwnsCurrentDatabase/);
  assert.match(source, /schemaAclBoundaryExact/);
  assert.match(source, /grant_entry\.grantee not in \(0, application_role\.oid, tenant_role\.oid\)/);
  assert.match(source, /role_row\.rolname = 'pg_database_owner'/);
  assert.match(source, /database_row\.datdba in \(application_role\.oid, tenant_role\.oid\)/);
  assert.doesNotMatch(source, /pg_has_role/);
  assert.match(source, /novalure_schema_migrations/);
  assert.match(source, /begin read only/i);
  assert.match(source, /assertQaTarget/);

  const originalLog = console.log;
  console.log = () => undefined;
  try {
    const inventory = await runTenantHardeningInventory(["node", "tenant-hardening-inventory"]);
    assert.equal(inventory.static.evidence, "repository_static");
    assert.ok(inventory.static.summary.registryTables >= 100);
    assert.ok(inventory.static.summary.explicitWorkspaceNullable >= 1);
    assert.ok(inventory.static.summary.tenantForeignKeys >= 100);
    assert.ok(inventory.static.summary.tenantForeignKeyGaps >= 1);
    assert.ok(inventory.static.summary.workspaceLeadingIndexGaps >= 1);
    assert.deepEqual(inventory.static.pilotTables, [
      "projects",
      "contacts",
      "leads",
      "deals",
      "audit_logs",
    ]);
  } finally {
    console.log = originalLog;
  }
});

test("local 049/052 snapshots remain byte-stable while 049 ledger recovery is blocked", async () => {
  const qaLedger049Hash = "174f9fa7a82faec8d92eab581c0ca87a3cce7042198279bcf5628f93dd9987eb";
  const protectedMigrations = [
    [
      "../migrations/049_property_inventory_tenant_guards.sql",
      "ffd4be362a4a25a324067c0621a3de8438d0da97d02acf41159b6e8f7eed942b",
    ],
    [
      "../migrations/052_validate_property_inventory_tenant_guards.sql",
      "a8f10a4f62e10da8e4c099383decc3805520a1d755e1c8c2a2994f297aeb0233",
    ],
  ];
  for (const [path, expectedHash] of protectedMigrations) {
    const contents = await readFile(new URL(path, import.meta.url), "utf8");
    const localHash = createHash("sha256").update(contents).digest("hex");
    assert.equal(localHash, expectedHash);
    if (path.includes("049_")) {
      assert.notEqual(
        localHash,
        qaLedger049Hash,
        "known 049 drift must be resolved by restoring the applied bytes, never by rewriting the ledger",
      );
    }
  }

  const route = await readFile(
    new URL("../src/app/api/system/database/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /from public\.novalure_schema_migration_checksums/i);
  assert.match(route, /order by version asc/i);
  assert.match(route, /checksum/);
  assert.doesNotMatch(route, /060_tenant_rls_pilot_prepare/);
});
