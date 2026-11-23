import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { LocalSalesPool } from "./local-sales-db.mjs";

/** Additive Sales fixture; the historical application migration manifest stays intact. */
export async function seedWebsiteSalesWorkbenchBrowser(db, account) {
  assert.equal(db.fixtureMode, "design-c-current-application-originals");
  assert.equal(db.database, "neondb");
  assert(path.resolve(db.directory).startsWith(path.resolve(".npm-cache/qa") + path.sep));
  assert(/^sales_qa_[a-f0-9]+$/.test(db.role));
  const extension = JSON.parse(await readFile("config/crm-candidate-fresh-website-sales-extension.json", "utf8"));
  const reviewedLengths = { WEBSITE_SALES_IRELAND_202: 1, WEBSITE_SALES_RUNTIME_STUDIO_LIFECYCLE_205: 4, WEBSITE_SALES_OPERATIONS_CONVERSATIONS_207: 6, WEBSITE_SALES_ENABLEMENT_208: 7, WEBSITE_SALES_COMMERCE_209: 8, WEBSITE_SALES_ADVISORY_210: 9 };
  assert(Object.hasOwn(reviewedLengths, extension.id));
  assert.equal(extension.forward.length, reviewedLengths[extension.id]);
  const entry = extension.forward.find(item => item.path === "migrations/202_website_sales_ireland.sql");
  assert(entry, "The reviewed extension must include the original Website Sales predecessor");
  assert.equal(entry.path, "migrations/202_website_sales_ireland.sql");
  const sql = await readFile(entry.path, "utf8");
  assert.equal(createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex"), entry.sha256);
  const owner = new LocalSalesPool({ host: "127.0.0.1", port: db.port, database: db.database, user: "neondb_owner" });
  const client = await owner.connect();
  try {
    const identity = (await client.query("select current_user as actor,rolsuper,rolbypassrls from pg_roles where rolname=current_user")).rows[0];
    assert.deepEqual(identity, { actor: "neondb_owner", rolsuper: false, rolbypassrls: true });
    const existing = (await client.query("select checksum from novalure_schema_migrations where version='202_website_sales_ireland'")).rows[0];
    if (existing) assert.equal(existing.checksum, entry.sha256, "Existing Website Sales migration must match the original pinned source");
    else {
      await client.query("begin");
      await client.query(sql);
      await client.query("insert into novalure_schema_migrations(version,name,checksum) values('202_website_sales_ireland','website_sales_ireland',$1)", [entry.sha256]);
      await client.query("commit");
    }
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally { client.release(); await owner.end(); }

  const projects = [];
  for (const city of ["Dublin", "Cork"]) {
    const projectId = randomUUID(), companyId = randomUUID(), contactId = randomUUID(), pipelineId = randomUUID();
    await db.admin.query("insert into projects(id,workspace_id,name,type,customer_type,default_operating_model,division) values($1,$2,$3,'Website','general_company','novalure_internal','WEB_DESIGN')", [projectId, account.workspaceId, `SYNTHETIC Website Sales ${city}`]);
    await db.admin.query("insert into crm_pipelines(id,workspace_id,project_id,key,name,purpose,is_default) values($1,$2,$3,$4,'SYNTHETIC Website Sales','sales',true)", [pipelineId, account.workspaceId, projectId, `synthetic-website-${city.toLowerCase()}`]);
    for (const [position, name] of ["Research intake", "Research qualified", "Offer draft", "Won", "Lost"].entries()) {
      await db.admin.query("insert into crm_pipeline_stages(pipeline_id,workspace_id,project_id,key,name,position,category,probability) values($1,$2,$3,$4,$5,$6,$7,$8)", [pipelineId, account.workspaceId, projectId, `synthetic-website-${position}`, name, position, position === 3 ? "won" : position === 4 ? "lost" : "work", position === 3 ? 100 : 25]);
    }
    await db.admin.query("update projects set default_pipeline_id=$2 where id=$1", [projectId, pipelineId]);
    await db.admin.query("insert into organizations(id,workspace_id,project_id,name,type,division) values($1,$2,$3,$4,'Unternehmen','WEB_DESIGN')", [companyId, account.workspaceId, projectId, `SYNTHETIC ${city} Company`]);
    await db.admin.query("insert into contacts(id,workspace_id,project_id,organization_id,owner_user_id,name,email,role) values($1,$2,$3,$4,$5,$6,$7,'Ansprechpartner')", [contactId, account.workspaceId, projectId, companyId, account.userId, `SYNTHETIC ${city} Contact`, `synthetic-${city.toLowerCase()}@example.invalid`]);
    projects.push({ projectId, companyId, contactId, pipelineId, city });
  }
  return { websiteSales: { syntheticOnly: true, originalMigration: entry, projects } };
}
