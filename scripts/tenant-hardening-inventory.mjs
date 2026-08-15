#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Pool } from "@neondatabase/serverless";
import { assertQaTarget } from "./qa-target-guard.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const migrationsDir = join(repoRoot, "migrations");
const pilotTables = Object.freeze(["projects", "contacts", "leads", "deals", "audit_logs"]);
const expectedPilotMigrations = Object.freeze([
  "060_tenant_rls_pilot_prepare",
  "061_validate_and_activate_tenant_rls_pilot",
]);

function parseArgs(argv) {
  const args = new Set(argv.slice(2));
  const cutoverArg = argv.slice(2).find((arg) => arg.startsWith("--cutover-ref="));
  const unknown = [...args].filter(
    (arg) =>
      !["--qa", "--strict", "--pilot-ready", "--activation-ready"].includes(arg) &&
      !arg.startsWith("--cutover-ref="),
  );
  if (unknown.length) throw new Error(`Unknown arguments: ${unknown.join(", ")}`);

  const cutoverRef = cutoverArg?.slice("--cutover-ref=".length).trim() ?? "";
  if (cutoverRef && !/^[A-Za-z0-9._:@/-]{8,160}$/.test(cutoverRef)) {
    throw new Error("--cutover-ref must be an immutable 8-160 character deployment reference");
  }

  const qa = args.has("--qa");
  if (!qa && (args.has("--strict") || args.has("--pilot-ready") || args.has("--activation-ready"))) {
    throw new Error("Readiness gates require --qa catalog and row-level evidence");
  }

  return {
    activationReady: args.has("--activation-ready"),
    cutoverAttested: Boolean(cutoverRef),
    cutoverRef,
    pilotReady: args.has("--pilot-ready"),
    qa,
    strict: args.has("--strict"),
  };
}

function loadEnvFile(path) {
  if (!existsSync(path)) return;

  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const separator = line.indexOf("=");
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function readMigrations() {
  return readdirSync(migrationsDir)
    .filter((name) => /^\d{3}_.+\.sql$/.test(name))
    .sort()
    .map((name) => {
      const content = readFileSync(join(migrationsDir, name), "utf8").replace(/\r\n/g, "\n");
      return {
        checksum: createHash("sha256").update(content).digest("hex"),
        content,
        file: name,
        version: name.replace(/\.sql$/, ""),
      };
    });
}

function readRegistryTables() {
  const source = readFileSync(join(repoRoot, "src/lib/db/schema.ts"), "utf8");
  const registry = source.match(/export const crmTables = \[([\s\S]*?)\]\s+as const/);
  if (!registry) throw new Error("crmTables registry could not be parsed");
  return [...registry[1].matchAll(/["']([a-z][a-z0-9_]*)["']/g)].map((match) => match[1]);
}

function staticInventory(migrations) {
  const registryTables = readRegistryTables();
  const allSql = migrations.map((migration) => migration.content).join("\n");
  const createBodies = new Map();
  const createPattern = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z][a-z0-9_]*)\s*\(/gi;

  for (const match of allSql.matchAll(createPattern)) {
    const bodyStart = (match.index ?? 0) + match[0].length;
    const bodyEnd = allSql.indexOf(");", bodyStart);
    if (bodyEnd !== -1 && !createBodies.has(match[1])) {
      createBodies.set(match[1], allSql.slice(bodyStart, bodyEnd));
    }
  }

  const tableNames = [...new Set([...registryTables, ...createBodies.keys()])].sort();
  let tables = tableNames.map((tableName) => {
    const createBody = createBodies.get(tableName) ?? "";
    const createWorkspace = createBody.match(/\bworkspace_id\s+(?:uuid|text)\b([^,\n]*)/i);
    const alteredWorkspace = new RegExp(
      `alter\\s+table\\s+(?:if\\s+exists\\s+)?${tableName}\\b[^;]{0,800}?add\\s+column(?:\\s+if\\s+not\\s+exists)?\\s+workspace_id\\s+(?:uuid|text)\\b([^;]*)`,
      "i",
    ).exec(allSql);
    const declaration = createWorkspace?.[0] ?? alteredWorkspace?.[0] ?? "";
    const hasWorkspaceId = Boolean(declaration);

    let classification = "indirect_or_global_review";
    if (tableName === "workspaces") classification = "tenant_root";
    else if (tableName === "novalure_schema_migrations") classification = "control_plane";
    else if (hasWorkspaceId) classification = "explicit_workspace";

    return {
      classification,
      creationEvidence: createBodies.has(tableName),
      registered: registryTables.includes(tableName),
      tableName,
      workspaceId: hasWorkspaceId
        ? { declared: true, nullable: !/\bnot\s+null\b/i.test(declaration) }
        : { declared: false, nullable: null },
    };
  });

  const tableByName = new Map(tables.map((table) => [table.tableName, table]));
  const references = [];
  const addReferences = (childTable, definition) => {
    const patterns = [
      /\b([a-z][a-z0-9_]*)\s+(?:uuid|text)\b[^,\n]*?\breferences\s+([a-z][a-z0-9_]*)\s*\(\s*id\s*\)/gi,
      /\bforeign\s+key\s*\(\s*([a-z][a-z0-9_]*)\s*\)\s*references\s+([a-z][a-z0-9_]*)\s*\(\s*id\s*\)/gi,
    ];
    for (const pattern of patterns) {
      for (const match of definition.matchAll(pattern)) {
        references.push({ childColumn: match[1], childTable, parentTable: match[2] });
      }
    }
  };
  for (const [tableName, body] of createBodies) addReferences(tableName, body);
  for (const match of allSql.matchAll(
    /alter\s+table\s+(?:if\s+exists\s+)?([a-z][a-z0-9_]*)\b([^;]*);/gi,
  )) {
    addReferences(match[1], match[2]);
  }

  const tenantReferences = [...new Map(
    references
      .filter((reference) =>
        reference.childColumn !== "workspace_id"
          && tableByName.get(reference.childTable)?.workspaceId.declared
          && tableByName.get(reference.parentTable)?.workspaceId.declared,
      )
      .map((reference) => [
        `${reference.childTable}.${reference.childColumn}->${reference.parentTable}.id`,
        reference,
      ]),
  ).values()].map((reference) => {
    const compositeDefinition =
      `foreign\\s+key\\s*\\(\\s*workspace_id\\s*,\\s*${reference.childColumn}\\s*\\)\\s*` +
      `references\\s+${reference.parentTable}\\s*\\(\\s*workspace_id\\s*,\\s*id\\s*\\)`;
    const inlineCompositePattern = new RegExp(compositeDefinition, "i");
    const alterCompositePattern = new RegExp(
      `alter\\s+table\\s+${reference.childTable}\\b[^;]{0,1600}?${compositeDefinition}`,
      "i",
    );
    const declaredCompositePattern = new RegExp(
      `\\(\\s*'${reference.childTable}'\\s*,\\s*'[^']+'\\s*,\\s*'${compositeDefinition}`,
      "i",
    );
    const indexPattern = new RegExp(
      `\\bon\\s+${reference.childTable}\\s*\\(\\s*workspace_id\\s*,\\s*${reference.childColumn}\\b`,
      "i",
    );
    return {
      ...reference,
      compositeConstraintEvidence:
        inlineCompositePattern.test(createBodies.get(reference.childTable) ?? "")
        || alterCompositePattern.test(allSql)
        || declaredCompositePattern.test(allSql),
      workspaceFkLeadingIndexEvidence: indexPattern.test(allSql),
    };
  });

  tables = tables.map((table) => ({
    ...table,
    workspaceLeadingIndexEvidence: table.workspaceId.declared
      ? new RegExp(`\\bon\\s+${table.tableName}\\s*\\(\\s*workspace_id\\b`, "i").test(allSql)
      : null,
  }));

  const byClass = Object.fromEntries(
    [...new Set(tables.map((table) => table.classification))].map((classification) => [
      classification,
      tables.filter((table) => table.classification === classification).length,
    ]),
  );

  return {
    evidence: "repository_static",
    migrationFiles: migrations.length,
    pilotTables,
    summary: {
      byClass,
      explicitWorkspaceNullable: tables.filter(
        (table) => table.workspaceId.declared && table.workspaceId.nullable,
      ).length,
      registryTables: registryTables.length,
      tenantForeignKeyGaps: tenantReferences.filter(
        (reference) => !reference.compositeConstraintEvidence,
      ).length,
      tenantForeignKeys: tenantReferences.length,
      unregisteredCreatedTables: [...createBodies.keys()].filter(
        (tableName) => !registryTables.includes(tableName),
      ).length,
      workspaceLeadingIndexGaps: tables.filter(
        (table) => table.workspaceId.declared && !table.workspaceLeadingIndexEvidence,
      ).length,
      withoutCreationEvidence: tables.filter((table) => !table.creationEvidence).length,
    },
    foreignKeys: tenantReferences,
    tables,
    unregisteredCreatedTables: [...createBodies.keys()]
      .filter((tableName) => !registryTables.includes(tableName))
      .sort(),
  };
}

function quoteIdentifier(value) {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error("Unsafe catalog identifier");
  return `"${value}"`;
}

async function readTenantTables(client) {
  const result = await client.query(`
    select
      relation.relname as "tableName",
      not workspace_column.attnotnull as "workspaceNullable",
      relation.relrowsecurity as "rlsEnabled",
      relation.relforcerowsecurity as "rlsForced",
      exists (
        select 1
        from pg_index tenant_index
        where tenant_index.indrelid = relation.oid
          and tenant_index.indisvalid
          and tenant_index.indisready
          and tenant_index.indkey[0] = workspace_column.attnum
      ) as "workspaceLeadingIndex"
    from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    join pg_attribute workspace_column
      on workspace_column.attrelid = relation.oid
      and workspace_column.attname = 'workspace_id'
      and not workspace_column.attisdropped
    where namespace.nspname = 'public'
      and relation.relkind in ('r', 'p')
    order by relation.relname
  `);
  return result.rows;
}

async function addNullCounts(client, tenantTables) {
  if (!tenantTables.length) return [];
  const query = tenantTables
    .map(({ tableName }) => {
      const table = quoteIdentifier(tableName);
      return `select '${tableName}'::text as "tableName", count(*) filter (where workspace_id is null)::text as "nullRows" from ${table}`;
    })
    .join("\nunion all\n");
  const counts = new Map((await client.query(query)).rows.map((row) => [row.tableName, row.nullRows]));
  return tenantTables.map((table) => ({ ...table, nullRows: counts.get(table.tableName) ?? "0" }));
}

async function readTenantForeignKeys(client) {
  const result = await client.query(`
    with legacy_fk as (
      select
        foreign_key.conname,
        child.oid as child_oid,
        child.relname as child_table,
        child_column.attnum as child_column_attnum,
        child_column.attname as child_column,
        child_workspace.attnum as child_workspace_attnum,
        parent.oid as parent_oid,
        parent.relname as parent_table,
        parent_column.attnum as parent_column_attnum,
        parent_column.attname as parent_column,
        parent_workspace.attnum as parent_workspace_attnum
      from pg_constraint foreign_key
      join pg_class child on child.oid = foreign_key.conrelid
      join pg_namespace child_namespace on child_namespace.oid = child.relnamespace
      join pg_class parent on parent.oid = foreign_key.confrelid
      join pg_namespace parent_namespace on parent_namespace.oid = parent.relnamespace
      join pg_attribute child_column
        on child_column.attrelid = child.oid
        and child_column.attnum = foreign_key.conkey[1]
      join pg_attribute parent_column
        on parent_column.attrelid = parent.oid
        and parent_column.attnum = foreign_key.confkey[1]
      join pg_attribute child_workspace
        on child_workspace.attrelid = child.oid
        and child_workspace.attname = 'workspace_id'
        and not child_workspace.attisdropped
      join pg_attribute parent_workspace
        on parent_workspace.attrelid = parent.oid
        and parent_workspace.attname = 'workspace_id'
        and not parent_workspace.attisdropped
      where foreign_key.contype = 'f'
        and cardinality(foreign_key.conkey) = 1
        and child_namespace.nspname = 'public'
        and parent_namespace.nspname = 'public'
    )
    select
      legacy_fk.conname as "legacyConstraint",
      legacy_fk.child_table as "childTable",
      legacy_fk.child_column as "childColumn",
      legacy_fk.parent_table as "parentTable",
      legacy_fk.parent_column as "parentColumn",
      coalesce(tenant_constraint.present, false) as "tenantConstraintPresent",
      coalesce(tenant_constraint.validated, false) as "tenantConstraintValidated",
      exists (
        select 1
        from pg_index child_index
        where child_index.indrelid = legacy_fk.child_oid
          and child_index.indisvalid
          and child_index.indisready
          and child_index.indkey[0] = legacy_fk.child_workspace_attnum
          and child_index.indkey[1] = legacy_fk.child_column_attnum
      ) as "workspaceFkLeadingIndex"
    from legacy_fk
    left join lateral (
      select true as present, bool_or(scoped_fk.convalidated) as validated
      from pg_constraint scoped_fk
      where scoped_fk.contype = 'f'
        and scoped_fk.conrelid = legacy_fk.child_oid
        and scoped_fk.confrelid = legacy_fk.parent_oid
        and scoped_fk.conkey = array[
          legacy_fk.child_workspace_attnum,
          legacy_fk.child_column_attnum
        ]::smallint[]
        and scoped_fk.confkey = array[
          legacy_fk.parent_workspace_attnum,
          legacy_fk.parent_column_attnum
        ]::smallint[]
      having count(*) > 0
    ) tenant_constraint on true
    order by legacy_fk.child_table, legacy_fk.child_column, legacy_fk.conname
  `);
  return result.rows;
}

async function addMismatchCounts(client, foreignKeys) {
  if (!foreignKeys.length) return [];
  const query = foreignKeys
    .map((foreignKey, index) => {
      const childTable = quoteIdentifier(foreignKey.childTable);
      const childColumn = quoteIdentifier(foreignKey.childColumn);
      const parentTable = quoteIdentifier(foreignKey.parentTable);
      const parentColumn = quoteIdentifier(foreignKey.parentColumn);
      return `
        select ${index}::integer as "rowIndex", count(*)::text as "mismatchRows"
        from ${childTable} child_row
        join ${parentTable} parent_row
          on parent_row.${parentColumn} = child_row.${childColumn}
        where child_row.${childColumn} is not null
          and child_row.workspace_id is distinct from parent_row.workspace_id
      `;
    })
    .join("\nunion all\n");
  const counts = new Map(
    (await client.query(query)).rows.map((row) => [Number(row.rowIndex), row.mismatchRows]),
  );
  return foreignKeys.map((foreignKey, index) => ({
    ...foreignKey,
    mismatchRows: counts.get(index) ?? "0",
  }));
}

async function readRoleEvidence(client, cutoverRef) {
  const roleResult = await client.query(`
    with tenant_role as (
      select * from pg_roles where rolname = 'novalure_tenant_app'
    ), direct_members as (
      select
        member_role.*,
        pg_has_role(member_role.oid, tenant_role.oid, 'USAGE') as membership_inherited
      from pg_auth_members membership
      join tenant_role on tenant_role.oid = membership.roleid
      join pg_roles member_role on member_role.oid = membership.member
    )
    select
      exists(select 1 from tenant_role) as "roleExists",
      coalesce((select
        not rolcanlogin and not rolsuper and not rolcreatedb and not rolcreaterole
          and not rolreplication and not rolbypassrls
        from tenant_role), false) as "roleSafe",
      coalesce((select
        shobj_description(oid, 'pg_authid') ~ '^novalure-tenant-cutover:[A-Za-z0-9._:@/-]{8,160}$'
        from tenant_role), false) as "cutoverMarkerPresent",
      coalesce((select
        shobj_description(oid, 'pg_authid') = 'novalure-tenant-cutover:' || $2
        from tenant_role), false) as "cutoverMarkerMatches",
      (select count(*)::integer from direct_members
        where rolcanlogin and membership_inherited and not rolsuper and not rolcreatedb
          and not rolcreaterole and not rolreplication and not rolbypassrls
      ) as "safeLoginMembers",
      (select count(*)::integer from direct_members
        where not rolcanlogin or not membership_inherited or rolsuper or rolcreatedb
          or rolcreaterole or rolreplication or rolbypassrls
      ) as "unsafeDirectMembers",
      exists (
        select 1
        from pg_class relation
        join pg_namespace namespace on namespace.oid = relation.relnamespace
        join direct_members on direct_members.oid = relation.relowner
        where namespace.nspname = 'public'
          and relation.relname = any($1::text[])
      ) as "memberOwnsPilotTable"
  `, [pilotTables, cutoverRef]);

  const privileges = await client.query(`
    with tenant_role as (
      select oid from pg_roles where rolname = 'novalure_tenant_app'
    )
    select
      pilot.table_name as "tableName",
      coalesce(has_table_privilege((select oid from tenant_role), to_regclass('public.' || pilot.table_name), 'SELECT'), false) as "select",
      coalesce(has_table_privilege((select oid from tenant_role), to_regclass('public.' || pilot.table_name), 'INSERT'), false) as "insert",
      coalesce(has_table_privilege((select oid from tenant_role), to_regclass('public.' || pilot.table_name), 'UPDATE'), false) as "update",
      coalesce(has_table_privilege((select oid from tenant_role), to_regclass('public.' || pilot.table_name), 'DELETE'), false) as "delete"
    from unnest($1::text[]) as pilot(table_name)
    order by pilot.table_name
  `, [pilotTables]);

  return { ...roleResult.rows[0], privileges: privileges.rows };
}

async function readAuditEvidence(client) {
  const result = await client.query(`
    select
      exists (
        select 1 from pg_trigger
        where tgrelid = 'audit_logs'::regclass
          and tgname = 'audit_logs_append_only_guard'
          and tgenabled <> 'D'
          and not tgisinternal
      ) as "appendOnlyGuardEnabled",
      (select count(*)::integer from pg_policies
        where schemaname = 'public' and tablename = 'audit_logs'
          and policyname in ('audit_logs_tenant_select_policy', 'audit_logs_tenant_insert_policy')
      ) as "tenantPolicyCount",
      (select count(*)::integer from pg_policies
        where schemaname = 'public'
          and tablename in ('projects', 'contacts', 'leads', 'deals')
          and policyname = tablename || '_tenant_actor_policy'
      ) as "coreTenantPolicyCount"
  `);
  return result.rows[0];
}

async function readLedgerEvidence(client, migrations) {
  const exists = Boolean((await client.query(
    "select to_regclass('public.novalure_schema_migrations') is not null as present",
  )).rows[0]?.present);
  const expected = migrations.filter((migration) => expectedPilotMigrations.includes(migration.version));
  if (!exists) {
    return {
      exists: false,
      expected: expected.map(({ checksum, version }) => ({ checksum, version })),
      rows: [],
    };
  }

  const result = await client.query(`
    select version, name, checksum, applied_at as "appliedAt"
    from novalure_schema_migrations
    where version = any($1::text[])
    order by version
  `, [expectedPilotMigrations]);
  return {
    exists: true,
    expected: expected.map(({ checksum, version }) => ({ checksum, version })),
    rows: result.rows,
  };
}

function ledgerMatches(ledger, version) {
  const expected = ledger.expected.find((row) => row.version === version);
  const actual = ledger.rows.find((row) => row.version === version);
  return Boolean(expected && actual && expected.checksum === actual.checksum);
}

function evaluateGates({ audit, cutoverAttested, foreignKeys, ledger, roles, tenantTables }) {
  const pilotTenantTables = tenantTables.filter((table) => pilotTables.includes(table.tableName));
  const pilotForeignKeys = foreignKeys.filter((foreignKey) =>
    pilotTables.includes(foreignKey.childTable),
  );
  const zero = (value) => BigInt(value) === 0n;
  const minimalGrants = roles.privileges.every((privilege) => {
    if (!privilege.select || !privilege.insert) return false;
    if (privilege.tableName === "audit_logs") return !privilege.update && !privilege.delete;
    return privilege.update && privilege.delete;
  });

  const checks = {
    activationLedgerExact: ledgerMatches(ledger, expectedPilotMigrations[1]),
    actorCutoverAttested: cutoverAttested && roles.cutoverMarkerMatches,
    appendOnlyAudit: audit.appendOnlyGuardEnabled,
    compositePilotForeignKeysPresent: pilotForeignKeys.length === 15 && pilotForeignKeys.every(
      (foreignKey) => foreignKey.tenantConstraintPresent,
    ),
    compositePilotForeignKeysValidated: pilotForeignKeys.length === 15 && pilotForeignKeys.every(
      (foreignKey) => foreignKey.tenantConstraintValidated,
    ),
    minimalPilotGrants: minimalGrants,
    noPilotMismatchRows: pilotForeignKeys.every((foreignKey) => zero(foreignKey.mismatchRows)),
    noPilotNullWorkspaceRows: pilotTenantTables.every((table) => zero(table.nullRows)),
    pilotPoliciesPresent: audit.tenantPolicyCount === 2 && audit.coreTenantPolicyCount === 4,
    pilotRlsForced: pilotTenantTables.length === pilotTables.length && pilotTenantTables.every(
      (table) => table.rlsEnabled && table.rlsForced,
    ),
    prepareLedgerExact: ledgerMatches(ledger, expectedPilotMigrations[0]),
    safeApplicationRole: roles.roleExists && roles.roleSafe && roles.safeLoginMembers > 0
      && roles.unsafeDirectMembers === 0 && !roles.memberOwnsPilotTable,
    workspaceLeadingPilotIndexes: pilotTenantTables.every(
      (table) => table.workspaceLeadingIndex,
    ) && pilotForeignKeys.every((foreignKey) => foreignKey.workspaceFkLeadingIndex),
  };
  const preActivationNames = [
    "actorCutoverAttested",
    "appendOnlyAudit",
    "compositePilotForeignKeysPresent",
    "noPilotMismatchRows",
    "noPilotNullWorkspaceRows",
    "pilotPoliciesPresent",
    "prepareLedgerExact",
    "safeApplicationRole",
    "workspaceLeadingPilotIndexes",
  ];
  const activationNames = [
    "activationLedgerExact",
    "appendOnlyAudit",
    "compositePilotForeignKeysValidated",
    "minimalPilotGrants",
    "noPilotMismatchRows",
    "noPilotNullWorkspaceRows",
    "pilotRlsForced",
    "safeApplicationRole",
    "workspaceLeadingPilotIndexes",
  ];

  return {
    activationReady: activationNames.every((name) => checks[name]),
    checks,
    fullInventoryReady:
      tenantTables.every((table) => !table.workspaceNullable && zero(table.nullRows) && table.workspaceLeadingIndex)
      && foreignKeys.every((foreignKey) =>
        foreignKey.tenantConstraintPresent
          && foreignKey.tenantConstraintValidated
          && foreignKey.workspaceFkLeadingIndex
          && zero(foreignKey.mismatchRows),
      ),
    preActivationReady: preActivationNames.every((name) => checks[name]),
  };
}

async function qaInventory(migrations, cutoverRef) {
  loadEnvFile(join(repoRoot, ".env.local"));
  const target = await assertQaTarget();
  const pool = new Pool({ allowExitOnIdle: true, connectionString: target.databaseUrl, max: 1 });
  const client = await pool.connect();

  try {
    await client.query("begin read only");
    const tenantTables = await addNullCounts(client, await readTenantTables(client));
    const foreignKeys = await addMismatchCounts(client, await readTenantForeignKeys(client));
    const roles = await readRoleEvidence(client, cutoverRef);
    const audit = await readAuditEvidence(client);
    const ledger = await readLedgerEvidence(client, migrations);
    const gates = evaluateGates({
      audit,
      cutoverAttested: Boolean(cutoverRef),
      foreignKeys,
      ledger,
      roles,
      tenantTables,
    });
    await client.query("rollback");

    return {
      audit,
      evidence: "qa_catalog_and_aggregated_rows_read_only",
      foreignKeys,
      gates,
      ledger,
      roles,
      tenantTables,
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

export async function runTenantHardeningInventory(argv = process.argv) {
  const options = parseArgs(argv);
  const migrations = readMigrations();
  const result = { static: staticInventory(migrations) };

  if (options.qa) {
    result.qa = await qaInventory(migrations, options.cutoverRef);
    if (options.strict && !result.qa.gates.fullInventoryReady) process.exitCode = 2;
    if (options.pilotReady && !result.qa.gates.preActivationReady) process.exitCode = 2;
    if (options.activationReady && !result.qa.gates.activationReady) process.exitCode = 2;
  }

  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runTenantHardeningInventory();
}
