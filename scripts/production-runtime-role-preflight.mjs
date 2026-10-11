import { neon } from "@neondatabase/serverless";
import { pathToFileURL } from "node:url";

const clean = (value) => (value || "").trim().replace(/^['"]|['"]$/g, "").replace(/^[A-Z0-9_]+=(?=postgres(?:ql)?:\/\/)/, "");

export async function runProductionRuntimeRolePreflight({ env = process.env, makeSql = neon } = {}) {
  if (env.VERCEL_ENV !== "production") return { status: "SKIPPED_NON_PRODUCTION" };
  const connectionString = clean(env.DATABASE_URL) || clean(env.POSTGRES_URL) || clean(env.POSTGRES_DATABASE_URL) || clean(env.POSTGRES_PRISMA_URL);
  if (!connectionString) throw new Error("Production runtime database is unavailable");
  const target = new URL(connectionString);
  if (!target.hostname.endsWith(".neon.tech")) throw new Error("Production runtime database provider is not authorized");
  const expectedRole = decodeURIComponent(target.username);
  const expectedDatabase = decodeURIComponent(target.pathname.replace(/^\//, ""));
  if (!expectedRole || !expectedDatabase) throw new Error("Production runtime database identity is incomplete");

  const sql = makeSql(connectionString);
  const [rows] = await sql.transaction([
    sql.query(`select current_user as role, current_database() as database,
      current_setting('transaction_read_only') as "readOnly",
      r.rolsuper as "superuser", r.rolcreaterole as "createRole", r.rolcreatedb as "createDatabase",
      r.rolreplication as replication, r.rolbypassrls as "bypassRls",
      has_database_privilege(current_user,current_database(),'CREATE') as "databaseCreate",
      has_schema_privilege(current_user,'public','CREATE') as "schemaCreate",
      pg_has_role(current_user,'pg_read_all_data','member') as "readAllData",
      pg_has_role(current_user,'pg_write_all_data','member') as "writeAllData"
      from pg_roles r where r.rolname=current_user`),
  ], { readOnly: true, fetchOptions: { signal: AbortSignal.timeout(20_000) } });
  const identity = rows[0];
  if (!identity || identity.role !== expectedRole || identity.database !== expectedDatabase || identity.readOnly !== "on") {
    throw new Error("Production runtime database self-identification did not match its configured target");
  }
  const elevated = ["superuser", "createRole", "createDatabase", "replication", "bypassRls", "databaseCreate", "schemaCreate", "readAllData", "writeAllData"];
  if (elevated.some((key) => identity[key] !== false)) throw new Error("Production runtime database role is not least privilege");
  return {
    status: "PASS_PRODUCTION_RUNTIME_ROLE",
    provider: "Neon",
    providerProjectId: env.POSTGRES_NEON_PROJECT_ID || null,
    database: identity.database,
    role: identity.role,
    readOnlyProof: true,
    elevatedPrivileges: 0,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(await runProductionRuntimeRolePreflight()));
  } catch (error) {
    const reason = error instanceof Error && [
      "Production runtime database is unavailable",
      "Production runtime database provider is not authorized",
      "Production runtime database identity is incomplete",
      "Production runtime database self-identification did not match its configured target",
      "Production runtime database role is not least privilege",
    ].includes(error.message) ? error.message : "Production runtime role query failed";
    console.error(`${reason}. No database writes were attempted.`);
    process.exitCode = 1;
  }
}
