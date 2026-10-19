import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { applySalesSchema, LocalSalesPool, startLocalSalesDb } from "./lib/local-sales-db.mjs";
import type { AppSession } from "../src/lib/auth/session";
import { getRolePermissions } from "../src/lib/auth/permissions";
import { getProductRoleCapabilities } from "../src/lib/product-model";
import { withCrmRead, type TenantTransactionOptions } from "../src/lib/crm-command";
import { withTenantTransaction, type TenantPool } from "../src/lib/db/tenant-client";
import { deleteDatabaseMedia } from "../src/lib/media-lifecycle";
import { findWorkspaceMediaAsset, type MediaAsset } from "../src/lib/media-store";
import { createKnowledgeArea, createKnowledgeSource, loadKnowledgeCenter } from "../src/lib/knowledge-center/repository";

const workspaceId = "8b8d996e-5b6a-4a9d-9a8e-0b91c6b89101";
const serviceActorId = "6122a6da-e7f4-47fa-bc55-e296bb01af62";
const ownerId = randomUUID();
const owner: AppSession = { authenticated:true,source:"database",workspaceId,userId:ownerId,
  workspaceName:"SYNTHETIC predecessor workspace",name:"SYNTHETIC owner",email:"knowledge-predecessor@example.invalid",
  role:"owner",productRole:"novalureAdmin",permissions:getRolePermissions("owner"),productPermissions:getProductRoleCapabilities("novalureAdmin") };
const sqlCode = (code: string) => (error: unknown) => (error as {code?:string}).code === code;
const checksum = (sql: string) => createHash("sha256").update(sql.replace(/\r\n/g,"\n")).digest("hex");
const normalizeAsset = (row: Record<string,unknown>) => ({...row,storageAccess:row.storage_access,isPublic:row.is_public}) as unknown as MediaAsset;

test("unchanged 101 upgrades the actual 091–096 → standalone100 predecessor with rollback and media compatibility", {timeout:180000}, async t => {
  const cluster = await startLocalSalesDb();
  let admin: InstanceType<typeof LocalSalesPool> | undefined;
  let bootstrap: InstanceType<typeof LocalSalesPool> | undefined;
  let runtime: InstanceType<typeof LocalSalesPool> | undefined;
  try {
    // All identities and databases below exist only in this disposable cluster.
    // These names satisfy 091's actual identity guard without editing its SQL.
    await cluster.admin.query("create role neondb_owner login nosuperuser bypassrls createdb createrole");
    await cluster.admin.query("create role qa_schema_bootstrap login superuser");
    await cluster.admin.query("create database neondb owner neondb_owner");
    await cluster.admin.query("alter role novalure_app login inherit");
    admin = new LocalSalesPool({host:"127.0.0.1",port:cluster.port,user:"neondb_owner",database:"neondb",max:4});
    bootstrap = new LocalSalesPool({host:"127.0.0.1",port:cluster.port,user:"qa_schema_bootstrap",database:"neondb",max:4});
    runtime = new LocalSalesPool({host:"127.0.0.1",port:cluster.port,user:"novalure_app",database:"neondb",max:4});
    const fixture = {...cluster,admin:bootstrap,pool:runtime,role:"novalure_app"};
    const options: TenantTransactionOptions = {pool:runtime as unknown as TenantPool};
    // Same historical fixture limitations as the existing Studio suite: vector
    // column/index substitution and manual062 omission. No customer data clone.
    await applySalesSchema(fixture,{maxMigrationNumber:90});
    // Bootstrap roles under the local cluster administrator: PostgreSQL18
    // otherwise grants a CREATEROLE creator automatic ADMIN membership, which
    // historical061 correctly rejects for a privileged migration owner.
    await bootstrap.query("reassign owned by qa_schema_bootstrap to neondb_owner");
    await cluster.admin.query("alter role novalure_app noinherit");
    await cluster.admin.query("grant novalure_tenant_app to novalure_app with inherit true,set false,admin false");
    const apply = async (filename: string) => {
      const sql = await readFile(`migrations/${filename}`,"utf8");
      const connection = await admin!.connect();
      try {
        await connection.query("begin");
        await connection.query(sql);
        await connection.query("insert into novalure_schema_migrations(version,name,checksum) values($1,$2,$3)",
          [filename.slice(0,-4),filename,checksum(sql)]);
        await connection.query("commit");
      } catch (error) {
        await connection.query("rollback");
        throw new Error(`Unchanged predecessor migration ${filename} failed`,{cause:error});
      } finally {connection.release();}
    };
    for (const filename of ["091_production_runtime_forced_rls_cutover.sql","092_crm_production_machine_identity.sql",
      "093_crm_machine_internal_context.sql","094_website_sales_ingestion.sql","095_form_tenant_isolation.sql",
      "096_public_integration_gateway.sql","100_studio_enquiry_production.sql"]) await apply(filename);

    await t.test("actual identity guards and machine-chain verification passed without Preview097–099",async()=>{
      const identity=(await runtime!.query("select current_database() as database,current_user as role,rolsuper,rolbypassrls from pg_roles where rolname=current_user")).rows[0];
      assert.deepEqual(identity,{database:"neondb",role:"novalure_app",rolsuper:false,rolbypassrls:false});
      assert.equal((await admin!.query("select count(*)::int as count from novalure_schema_migrations where version~'^(091|092|093|094|095|096|100)_'")).rows[0].count,7);
      assert.equal((await admin!.query("select count(*)::int as count from novalure_schema_migrations where version~'^(097|098|099)_'")).rows[0].count,0);
      assert.equal((await admin!.query("select to_regclass('public.studio_sales_bookings') is null as absent")).rows[0].absent,true);
      const principal=(await admin!.query("select data_context,auth_type from crm_service_principals where identity_id='EVELYN_CRM_SERVICE_IDENTITY'")).rows[0];
      assert.deepEqual(principal,{data_context:"NOVALURE_INTERNAL",auth_type:"VERCEL_OIDC"});
      assert.equal((await admin!.query("select has_table_privilege('novalure_app','public.company_profiles','SELECT') as allowed")).rows[0].allowed,false);
    });

    const sourceSql=await readFile("migrations/101_knowledge_center.sql","utf8");
    const priorCounters=(await admin.query(`select pg_get_function_result('public.crm_media_reference_counts(uuid)'::regprocedure) as legacy,
      pg_get_function_result('public.crm_studio_media_reference_counts(uuid)'::regprocedure) as studio`)).rows[0];
    await t.test("101 DDL and checksum ledger roll back together on a failed transaction",async()=>{
      const connection=await admin!.connect();
      try {
        await connection.query("begin");await connection.query(sourceSql);
        await connection.query("insert into novalure_schema_migrations(version,name,checksum) values('101_knowledge_center','101_knowledge_center.sql',$1)",[checksum(sourceSql)]);
        await assert.rejects(connection.query("select 1/0"),sqlCode("22012"));
        await connection.query("rollback");
      } finally {connection.release();}
      assert.equal((await admin!.query("select to_regclass('public.knowledge_source_versions') is null as absent")).rows[0].absent,true);
      assert.equal((await admin!.query("select count(*)::int as count from novalure_schema_migrations where version='101_knowledge_center'")).rows[0].count,0);
    });
    await apply("101_knowledge_center.sql");
    await t.test("101 commits its exact normalized checksum while preserving both existing media contracts",async()=>{
      assert.equal((await admin!.query("select checksum from novalure_schema_migrations where version='101_knowledge_center'")).rows[0].checksum,checksum(sourceSql));
      const counters=(await admin!.query(`select pg_get_function_result('public.crm_media_reference_counts(uuid)'::regprocedure) as legacy,
        pg_get_function_result('public.crm_studio_media_reference_counts(uuid)'::regprocedure) as studio`)).rows[0];
      assert.deepEqual(counters,priorCounters);
      assert.match((await admin!.query("select pg_get_function_result('public.crm_knowledge_media_reference_counts(uuid)'::regprocedure) as result")).rows[0].result,/knowledge_count integer/);
      const protectedRows=(await admin!.query("select relname,relrowsecurity,relforcerowsecurity from pg_class where relname=any(array['knowledge_sources','knowledge_chunks','knowledge_areas','knowledge_source_versions','knowledge_area_grants','knowledge_center_entitlements','knowledge_query_usage'])")).rows;
      assert.equal(protectedRows.length,7);assert.ok(protectedRows.every(row=>row.relrowsecurity&&row.relforcerowsecurity));
      assert.equal((await runtime!.query("select count(*)::int as count from knowledge_sources")).rows[0].count,0);
    });
    await apply("102_knowledge_document_processing.sql");
    await apply("103_knowledge_assistant_service.sql");
    await t.test("102–103 extend the actual predecessor without activating an assistant", async () => {
      for (const filename of ["102_knowledge_document_processing.sql", "103_knowledge_assistant_service.sql"]) {
        const row = (await admin!.query("select checksum from novalure_schema_migrations where version=$1", [filename.slice(0, -4)])).rows[0];
        assert.equal(row.checksum, checksum(await readFile(`migrations/${filename}`, "utf8")));
      }
      assert.equal((await admin!.query("select count(*)::int as count from knowledge_assistant_service_bindings")).rows[0].count, 0);
      assert.equal((await runtime!.query("select has_table_privilege(current_user,'public.knowledge_assistant_service_bindings','SELECT') as allowed")).rows[0].allowed, false);
      assert.deepEqual((await admin!.query("select relrowsecurity,relforcerowsecurity from pg_class where oid='public.knowledge_assistant_service_bindings'::regclass")).rows[0], { relrowsecurity: true, relforcerowsecurity: true });
    });
    await admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'SYNTHETIC predecessor owner',$3,'owner','novalureAdmin','active')",[ownerId,workspaceId,owner.email]);
    await t.test("real non-owner runtime cannot self-provision a contract",async()=>{
      assert.equal((await loadKnowledgeCenter(owner,options)).available,false);
      await assert.rejects(withTenantTransaction({workspaceId,actorId:ownerId},tx=>tx.execute(
        "insert into knowledge_center_entitlements(workspace_id,enabled) values($1,false)",[workspaceId]),options),sqlCode("42501"));
    });
    await admin.query(`insert into knowledge_center_entitlements(workspace_id,enabled,max_sources,max_storage_bytes,max_queries_per_month,contract_reference,limits)
      values($1,true,20,10000000,100,'SYNTHETIC-LOCAL-ONLY','{"maxAreas":20,"maxWebsites":20,"maxScansPerMonth":20,"maxUsers":20,"maxAssistants":20}')`,[workspaceId]);
    const area=await createKnowledgeArea(owner,{name:"SYNTHETIC predecessor area",kind:"company"},options);
    const documentId=randomUUID(), ordinaryId=randomUUID(),studioAssetId=randomUUID();
    const insertAsset=async(assetId:string,folder:string,studioOperation:string|null=null)=>{
      await withCrmRead(owner,tx=>tx.execute(`insert into media_assets(id,workspace_id,name,original_name,folder,mime_type,size_bytes,url,relative_path,storage_provider,storage_access,studio_enquiry_operation_id)
        values($1,$2,'SYNTHETIC local asset','fixture.pdf',$3,'application/pdf',40,$4,$5,$6,'private',$7)`,
        [assetId,workspaceId,folder,`/api/media/files/${assetId}`,`${workspaceId}/${assetId}.pdf`,studioOperation?"vercel-blob":"local",studioOperation]),options);
    };
    await insertAsset(documentId,`knowledge-private-${ownerId}`);await insertAsset(ordinaryId,"media-uploads");
    await t.test("source binding and immutable private-media guards work after the real100 schema",async()=>{
      const source=await createKnowledgeSource(owner,{areaId:area.id,type:"file",name:"SYNTHETIC protected document",mediaAssetId:documentId},options);
      assert.equal(source.version?.mediaAssetId,documentId);
      await withCrmRead(owner,async()=>assert.equal(await findWorkspaceMediaAsset(documentId,workspaceId),null),options);
      await assert.rejects(withCrmRead(owner,tx=>tx.execute("update media_assets set is_public=true where id=$1",[documentId]),options),sqlCode("42501"));
      await assert.rejects(withCrmRead(owner,tx=>tx.execute("insert into media_asset_shares(asset_id,workspace_id,token_hash,scope,expires_at) values($1,$2,$3,'public-download',now()+interval '1 hour')",[documentId,workspaceId,"a".repeat(64)]),options),sqlCode("42501"));
      const counts=await withCrmRead(owner,tx=>tx.queryOne<{knowledge_count:number}>("select * from crm_knowledge_media_reference_counts($1)",[documentId]),options);
      assert.equal(counts?.knowledge_count,1);
    });
    await t.test("ordinary private deletion still succeeds through actual100+101 definer counters",async()=>{
      let deletedFiles=0;
      const deleted=await deleteDatabaseMedia({assetId:ordinaryId,workspaceId,actorId:ownerId,assetSelect:"ma.*",normalizeAsset,
        deleteFile:async()=>{deletedFiles++;},pool:runtime as unknown as TenantPool});
      assert.equal(deleted?.id,ordinaryId);assert.equal(deletedFiles,1);
      assert.equal((await admin!.query("select count(*)::int as count from media_assets where id=$1",[ordinaryId])).rows[0].count,0);
    });
    await t.test("Studio-confirmed media retains its independent protection after101",async()=>{
      const operationId=randomUUID(),snapshot=JSON.stringify({schemaVersion:"studio-enquiry-snapshot-v1",syntheticTest:true});
      await admin!.query(`insert into studio_enquiry_transfers(operation_id,workspace_id,revision,payload_hash,snapshot_text,targets,reference)
        values($1,$2,1,$3,$4,'[]','NL-ABCDEF01')`,[operationId,workspaceId,checksum(snapshot),snapshot]);
      await insertAsset(studioAssetId,"studio-enquiry-synthetic",operationId);
      let deletedFiles=0;
      await assert.rejects(deleteDatabaseMedia({assetId:studioAssetId,workspaceId,actorId:ownerId,assetSelect:"ma.*",normalizeAsset,
        deleteFile:async()=>{deletedFiles++;},pool:runtime as unknown as TenantPool}),/protected lifecycle/);
      assert.equal(deletedFiles,0);
      const service=(await admin!.query("select product_role from workspace_users where id=$1",[serviceActorId])).rows[0];
      assert.equal(service.product_role,"novalure_operator");
    });
  } finally {
    await Promise.allSettled([runtime?.end(),admin?.end(),bootstrap?.end()]);
    await cluster.stop();
  }
});
