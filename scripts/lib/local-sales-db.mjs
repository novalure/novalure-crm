import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import pg from "pg";

const { Pool } = pg;
const workRoot = path.resolve(".");
const qaRoot = path.join(workRoot, ".npm-cache", "qa");
async function binaries() {
  const platform = process.platform === "win32" ? "windows" : process.platform;
  return import(`@embedded-postgres/${platform}-${process.arch}`);
}
async function run(file, args, directory) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: directory, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve(output) : reject(new Error(`Local PostgreSQL command failed (${code}): ${output.slice(-2000)}`)));
  });
}
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}
/** Entirely local, disposable synthetic cluster. No environment connection string is consumed. */
export async function startLocalSalesDb() {
  await mkdir(qaRoot, { recursive: true });
  const directory = await mkdtemp(path.join(qaRoot, "sales-pg-"));
  if (!directory.startsWith(qaRoot + path.sep)) throw new Error("Unsafe QA directory");
  const bin = await binaries();
  const port = await freePort();
  await run(bin.initdb, ["-D", directory, "--username=qa_admin", "--auth-local=trust", "--auth-host=trust", "--encoding=UTF8", "--locale=C"], workRoot);
  const logfile = path.join(directory, "postgres.log");
  const options = `-h 127.0.0.1 -p ${port}`;
  const role = `sales_qa_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let admin;
  let pool;
  let stopping;
  const stopCluster = () => run(bin.pg_ctl, ["-D", directory, "-m", "fast", "-t", "15", "-w", "stop"], workRoot);
  try {
    await run(bin.pg_ctl, ["-D", directory, "-l", logfile, "-o", options, "-t", "30", "-w", "start"], workRoot);
    admin = new Pool({ host: "127.0.0.1", port, user: "qa_admin", database: "postgres", max: 5, connectionTimeoutMillis: 5_000, query_timeout: 15_000 });
    await admin.query(`create role ${role} login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
    await admin.query("create role novalure_app nologin inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls");
    await admin.query(`grant novalure_app to ${role}`);
    pool = new Pool({ host: "127.0.0.1", port, user: role, database: "postgres", max: 8, connectionTimeoutMillis: 5_000 });
    return {
      admin, pool, port, role, directory,
      stop() {
        if (stopping) return stopping;
        stopping = (async () => {
          const results = await Promise.allSettled([pool.end(), admin.end()]);
          await stopCluster();
          const failed = results.find(result => result.status === "rejected");
          if (failed) throw failed.reason;
        })();
        return stopping;
      },
    };
  } catch (error) {
    // Provisioning failures must also stop this exact disposable cluster.
    await Promise.allSettled([pool?.end(), admin?.end()]);
    try { await stopCluster(); }
    catch (cleanupError) { console.error("Local PostgreSQL startup cleanup:", cleanupError.message); }
    throw error;
  }
}
/**
 * Historical schema bootstrap for sales tests. The optional RAG vector extension
 * is not shipped in the portable binary: ONLY that unrelated embedding column/index
 * is replaced. All other baseline SQL and ALL new sales migrations run unchanged.
 * Historical manual media cutover 062 is excluded: it conflicts with the existing
 * append-only audit trigger. Audit protection stays enabled. Rollbacks are not applied.
 * This is explicitly not a full historical, pgvector/RAG or production validation.
 */
export async function applySalesSchema(db, { includeSales = true } = {}) {
  const names = (await readdir("migrations")).filter(name => /^\d+.*\.sql$/.test(name)).sort();
  const applied = [];
  for (const name of names) {
    if (name.includes("_rollback") || name === "062_private_media_contract_cutover.sql") continue;
    const number = Number(name.slice(0, 3));
    if (!includeSales && number >= 80) continue;
    let sql = await readFile(path.join("migrations", name), "utf8");
    const originalHash = createHash("sha256").update(sql).digest("hex");
    if (number === 1) {
      sql = sql.replace("create extension if not exists vector;", "-- optional RAG extension omitted in sales-only local schema");
      sql = sql.replace("embedding vector(1536)", "embedding real[]");
      sql = sql.replace(/create index knowledge_chunks_embedding_idx\s+on knowledge_chunks using ivfflat \(embedding vector_cosine_ops\)\s+with \(lists = 100\);/i, "-- optional RAG index omitted");
    }
    if (number === 61) {
      await db.admin.query(`grant novalure_tenant_app to ${db.role}`);
      await db.admin.query("comment on role novalure_tenant_app is 'novalure-tenant-cutover:local-sales-synthetic-test'");
    }
    const client = await db.admin.connect();
    try {
      await client.query("begin");
      await client.query(sql);
      if (number >= 41) {
        await client.query("insert into novalure_schema_migrations(version,name,checksum) values($1,$2,$3) on conflict(version) do nothing", [name.replace(/\.sql$/, ""), name, originalHash]);
      }
      await client.query("commit");
      applied.push(name);
    } catch (error) {
      await client.query("rollback");
      throw new Error(`Local schema migration ${name} failed: ${error.message}`, { cause: error });
    } finally {
      client.release();
    }
  }
  await db.admin.query(`grant usage on schema public to ${db.role}`);
  await db.admin.query(`grant select on workspaces, workspace_users, project_pipeline_permissions to ${db.role}`);
  await writeFile(path.join(db.directory, "migration-evidence.json"), JSON.stringify({ mode: "local-sales-only", optionalRagExcluded: true, excluded: [{ migration: "062_private_media_contract_cutover.sql", reason: "Manual media cutover conflicts with append-only audit trigger; unchanged and excluded from sales fixture" }, { pattern: "*_rollback.sql", reason: "Rollback scripts are not forward migrations" }], applied }, null, 2));
  return applied;
}
