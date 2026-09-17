import { createHash, randomBytes, randomUUID } from "node:crypto";
/** Synthetic-only fixture for an ephemeral loopback PostgreSQL cluster. */
export async function seedSalesBrowser(db) {
 const workspaceId=randomUUID(), userId=randomUUID(), projectId=randomUUID(), pipelineId=randomUUID(), developerId=randomUUID(), developerContactId=randomUUID();
 const cookie="v2."+randomBytes(32).toString("base64url");
 await db.admin.query("insert into workspaces(id,name,operating_model,customer_type,setup_state) values($1,'SYNTHETIC SALES QA','novalure_internal','novalure_internal',$2::jsonb)",[workspaceId,JSON.stringify({salesApprovalUserId:userId})]);
 const user=await db.admin.query("insert into workspace_users(id,workspace_id,name,email,role,product_role,status) values($1,$2,'Synthetic sales owner',$3,'owner','novalureAdmin','active') returning auth_identity_id",[userId,workspaceId,`synthetic-sales-${userId.replaceAll("-","")}@example.invalid`]);
 await db.admin.query("update auth_identities set credential_state='active' where id=$1",[user.rows[0].auth_identity_id]);
 await db.admin.query("insert into auth_sessions(token_hash,auth_identity_id,workspace_user_id,workspace_id,expires_at,mfa_verified_at) values($1,$2,$3,$4,now()+interval '8 hours',now())",[createHash('sha256').update(cookie).digest('hex'),user.rows[0].auth_identity_id,userId,workspaceId]);
 await db.admin.query("insert into projects(id,workspace_id,name,type,customer_type,default_operating_model) values($1,$2,'SYNTHETIC Sales Project','Bauträger','property_developer','novalure_internal')",[projectId,workspaceId]);
 await db.admin.query("insert into crm_pipelines(id,workspace_id,project_id,key,name,purpose,is_default) values($1,$2,$3,'synthetic-sales','SYNTHETIC Sales','sales',true)",[pipelineId,workspaceId,projectId]);
 for(const [position,name] of ['Neu','Qualifizieren','Angebot','Gewonnen','Verloren'].entries())await db.admin.query("insert into crm_pipeline_stages(pipeline_id,workspace_id,project_id,key,name,position,category,probability) values($1,$2,$3,$4,$5,$6,$7,$8)",[pipelineId,workspaceId,projectId,'synthetic-'+position,name,position,position===3?'won':position===4?'lost':'work',position===3?100:50]);
 await db.admin.query("update projects set default_pipeline_id=$2 where id=$1",[projectId,pipelineId]);
 await db.admin.query("insert into organizations(id,workspace_id,project_id,name,type) values($1,$2,$3,'SYNTHETIC Developer','Bauträger')",[developerId,workspaceId,projectId]);
 await db.admin.query("insert into contacts(id,workspace_id,project_id,organization_id,owner_user_id,name,email,role) values($1,$2,$3,$4,$5,'Synthetic developer representative','synthetic-developer@example.invalid','Bauträger')",[developerContactId,workspaceId,projectId,developerId,userId]);
 await db.admin.query("update workspace_users set onboarding_completed_at=now() where id=$1",[userId]);
 // Authentication/bootstrap reads only; all business permissions come from tested sales migrations.
 await db.admin.query(`grant select on auth_identities to ${db.role}`);
 await db.admin.query(`grant update(last_seen_at) on auth_sessions to ${db.role}`);
 await db.admin.query(`grant select,insert,delete on csrf_token_consumptions to ${db.role}`);
 return {workspaceId,userId,projectId,pipelineId,developerId,developerContactId,cookie};
}