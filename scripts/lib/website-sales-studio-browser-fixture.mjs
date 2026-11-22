import assert from "node:assert/strict";
import { generateKeyPairSync,randomBytes,randomUUID,createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { hashPassword } from "../../src/lib/auth/passwords.ts";
import { LocalSalesPool } from "./local-sales-db.mjs";
/** Disposable loopback fixture only. No auth session, MFA state, live recipient or provider is seeded. */
export async function seedWebsiteSalesStudioBrowser(db,account,{lifecycle=false,operations=false}={}){
 assert.equal(db.fixtureMode,"design-c-current-application-originals");assert.equal(db.database,"neondb");assert(/^sales_qa_[a-f0-9]+$/.test(db.role));assert(path.resolve(db.directory).startsWith(path.resolve(".npm-cache/qa")+path.sep));
 const extension=JSON.parse(await readFile("config/crm-candidate-fresh-website-sales-extension.json","utf8"));
 const includeLifecycle=lifecycle||operations;
 if(operations)assert.equal(extension.id,"WEBSITE_SALES_ENABLEMENT_208","Operations browser fixture requires its complete reviewed schema extension");
 const owner=new LocalSalesPool({host:"127.0.0.1",port:db.port,database:db.database,user:"neondb_owner"});
 const applied=[];try{for(const file of ["203_website_sales_machine.sql","204_website_sales_studio.sql",...(includeLifecycle?["205_website_sales_lifecycle.sql"]:[]),...(operations?["206_website_sales_operations.sql","207_website_sales_conversations.sql","208_website_sales_enablement.sql"]:[])]){
  const sql=await readFile(path.resolve("migrations",file),"utf8"),checksum=createHash("sha256").update(sql.replace(/\r\n/g,"\n")).digest("hex"),version=file.slice(0,-4),existing=(await owner.query("select checksum from novalure_schema_migrations where version=$1",[version])).rows[0];
  if(["WEBSITE_SALES_RUNTIME_STUDIO_LIFECYCLE_205","WEBSITE_SALES_OPERATIONS_CONVERSATIONS_207","WEBSITE_SALES_ENABLEMENT_208"].includes(extension.id)){const pinned=extension.forward.find(entry=>entry.path===`migrations/${file}`);assert(pinned,`Reviewed extension must pin ${file}`);assert.equal(pinned.sha256,checksum,`Browser fixture requires exact pinned ${file}`);}
  if(existing){assert.equal(existing.checksum,checksum,`Existing ${version} must match its original source`);continue;}
  const connection=await owner.connect();try{await connection.query("begin");await connection.query(sql);await connection.query("insert into novalure_schema_migrations(version,name,checksum) values($1,$2,$3)",[version,file.slice(4,-4),checksum]);await connection.query("commit");applied.push({file,checksum});}catch(error){await connection.query("rollback");throw error;}finally{connection.release();}
 }}finally{await owner.end();}
 async function actor(workspaceId,label){const userId=randomUUID(),email=`synthetic-studio-${userId.replaceAll("-","")}@example.invalid`,password=randomBytes(32).toString("base64url");const row=(await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status,onboarding_completed_at) values($1,$2,$3,$4,'owner','novalureAdmin','active',now()) returning auth_identity_id",[userId,workspaceId,label,email])).rows[0];await db.admin.query("update auth_identities set credential_state='active',password_hash=$2 where id=$1",[row.auth_identity_id,await hashPassword(password)]);return{workspaceId,userId,authIdentityId:row.auth_identity_id,email,password};}
 const qa=await actor(account.workspaceId,"SYNTHETIC independent Studio QA");
 const foreignWorkspaceId=randomUUID();await db.admin.query("insert into workspaces(id,name,operating_model,customer_type) values($1,'SYNTHETIC foreign Studio tenant','novalure_internal','novalure_internal')",[foreignWorkspaceId]);
 const foreignBuilder=await actor(foreignWorkspaceId,"SYNTHETIC foreign builder"),foreignQa=await actor(foreignWorkspaceId,"SYNTHETIC foreign independent QA");
 const projectId=randomUUID(),companyId=randomUUID(),contactId=randomUUID(),pipelineId=randomUUID();
 await db.admin.query("insert into projects(id,workspace_id,name,type,customer_type,default_operating_model,division) values($1,$2,'SYNTHETIC foreign Studio project','Website','general_company','novalure_internal','WEB_DESIGN')",[projectId,foreignWorkspaceId]);
 await db.admin.query("insert into crm_pipelines(id,workspace_id,project_id,key,name,purpose,is_default) values($1,$2,$3,'synthetic-foreign-studio','SYNTHETIC foreign pipeline','sales',true)",[pipelineId,foreignWorkspaceId,projectId]);
 await db.admin.query("insert into crm_pipeline_stages(pipeline_id,workspace_id,project_id,key,name,position,category) values($1,$2,$3,'qualify','Research qualified',1,'work')",[pipelineId,foreignWorkspaceId,projectId]);await db.admin.query("update projects set default_pipeline_id=$2 where id=$1",[projectId,pipelineId]);
 await db.admin.query("insert into organizations(id,workspace_id,project_id,name,type,division) values($1,$2,$3,'SYNTHETIC foreign Studio company','Unternehmen','WEB_DESIGN')",[companyId,foreignWorkspaceId,projectId]);
 await db.admin.query("insert into contacts(id,workspace_id,project_id,organization_id,owner_user_id,name,email,role) values($1,$2,$3,$4,$5,'SYNTHETIC foreign recipient','foreign-recipient@example.invalid','Ansprechpartner')",[contactId,foreignWorkspaceId,projectId,companyId,foreignBuilder.userId]);
 const keys=generateKeyPairSync("ed25519"),issuer="synthetic-loopback-independent-browser",keyId=randomUUID(),sourceRevision=execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim();assert(/^[0-9a-f]{40}$/.test(sourceRevision));
 const publicKeySpkiPem=keys.publicKey.export({type:"spki",format:"pem"}),publicKeys=[...account.websiteSales.projects.map(project=>({issuer,keyId,workspaceId:account.workspaceId,projectId:project.projectId,qaActorId:qa.userId,sourceRevision,publicKeySpkiPem})),{issuer,keyId,workspaceId:foreignWorkspaceId,projectId,qaActorId:foreignQa.userId,sourceRevision,publicKeySpkiPem}];
 return {websiteStudio:{syntheticOnly:true,applied,lifecycle:includeLifecycle,operations,qa,foreignBuilder,foreignQa,foreignProject:{projectId,companyId,contactId,pipelineId,city:"Foreign"},signer:{issuer,keyId,sourceRevision,privateKeyPem:keys.privateKey.export({type:"pkcs8",format:"pem"})},publicKeys}};
}
