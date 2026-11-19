import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/** Synthetic prerequisites only; executes original094/095 SQL and records only actually executed files. */
export async function applyMarketingFormFixture(db) {
  const address = (await db.admin.query("select host(inet_server_addr()) as host")).rows[0]?.host;
  if (address !== "127.0.0.1" || !/^sales_qa_[0-9a-f]+$/.test(db.role ?? "") || !/[\\/]sales-pg-[^\\/]+$/.test(db.directory ?? "")) throw new Error("Marketing form fixture requires its disposable loopback database");
  await db.admin.query("insert into workspaces(id,name,operating_model) values('8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101','SYNTHETIC Form cutover prerequisite','novalure_internal') on conflict(id) do nothing");
  await db.admin.query("insert into projects(id,workspace_id,name,type) values('f7d83c6b-d08d-4d73-b822-1f1c0b4733d2','8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101','SYNTHETIC Form prerequisite project','Test') on conflict(id) do nothing");
  await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values('6122a6da-e7f4-47fa-bc55-e296bb01af62','8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101','SYNTHETIC Existing operator','synthetic-form-operator@example.invalid','agent','novalure_operator','active') on conflict(id) do nothing");
  for (const name of ["094_website_sales_ingestion.sql", "095_form_tenant_isolation.sql"]) {
    const sql = await readFile(new URL(`../../migrations/${name}`, import.meta.url), "utf8");
    await db.admin.query(sql);
    await db.admin.query("insert into novalure_schema_migrations(version,name,checksum) values($1,$2,$3)", [name.replace(/\.sql$/, ""), name, createHash("sha256").update(sql).digest("hex")]);
  }
}
