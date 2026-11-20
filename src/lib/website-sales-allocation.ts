import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppSession } from "./auth/session";
import { crmPayloadDigest, CrmCommandError, type TenantTransaction } from "./crm-command";

export const salesAllocationProofSchema=z.strictObject({allocationId:z.uuid(),version:z.number().int().positive().safe(),leaseToken:z.uuid()});
export type SalesAllocationProof=z.infer<typeof salesAllocationProofSchema>;
type Scope={projectId:string;companyId:string;locationId:string};
type StageCommand={target:"workflow"|"studio"|"lifecycle"|"autonomy";request:Record<string,unknown>};
export function salesStageCommand(target:StageCommand["target"],request:Record<string,unknown>):StageCommand{
 const original={...request};delete original.allocationProof;return{target,request:original};
}
function deny(code:string):never{throw new CrmCommandError(code,code,409);}
export type SalesAllocationFence={replayed:boolean;assertCurrent():Promise<void>;record(commandId:string):Promise<void>};
export async function withSalesAllocationFence<T extends {commandId:string}>(tx:TenantTransaction,session:AppSession,scope:Scope,target:StageCommand["target"],raw:Record<string,unknown>,run:()=>Promise<T>):Promise<T>{
 const fence=await prepareSalesAllocationFence(tx,session,scope,target,raw);const result=await run();if(fence){await fence.record(result.commandId);await fence.assertCurrent();}return result;
}

/** Only an actual canonical write transaction calls this. A managed resource cannot opt out by omitting JSON metadata. */
export async function prepareSalesAllocationFence(tx:TenantTransaction,session:AppSession,scope:Scope,target:StageCommand["target"],raw:Record<string,unknown>):Promise<SalesAllocationFence|null>{
 if(!session.serviceIdentity)return null;
 // A stop only removes authority. It must remain possible after an opt-out or expired allocation.
 if(target==="workflow"&&raw.operation==="stop"||target==="lifecycle"&&raw.operation==="ingest_reply"||target==="autonomy"&&raw.operation==="stop_conversation")return null;
 const available=await tx.queryOne<{available:boolean}>("select to_regclass('public.crm_website_sales_ops_resource_controls') is not null as available");
 if(!available?.available){if(raw.allocationProof!==undefined)deny("SALES_ALLOCATION_SCHEMA_REQUIRED");return null;}
 await tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))",[`website-sales-operations:${session.workspaceId}:${scope.projectId}`]);
 const managed=await tx.queryOne(`select 1 from crm_website_sales_ops_resource_controls where workspace_id=$1 and project_id=$2 and company_id=$3 and location_id=$4 and require_allocation`,[session.workspaceId,scope.projectId,scope.companyId,scope.locationId]);
 if(!managed&&raw.allocationProof===undefined)return null;
 if(raw.allocationProof===undefined)deny("SALES_ALLOCATION_REQUIRED");
 const parsed=salesAllocationProofSchema.safeParse(raw.allocationProof);if(!parsed.success)deny("SALES_ALLOCATION_PROOF_INVALID");const proof=parsed.data;
 const stage=salesStageCommand(target,raw),digest=crmPayloadDigest(stage);
 const row=await tx.queryOne<{id:string;version:number;status:string;leaseToken:string|null;claimedBy:string|null;sealedDigest:string|null;stageOperationId:string|null;workflowId:string;stage:string;decision:Record<string,unknown>;current:boolean}>(`select a.id,a.version,a.status,a.lease_token as "leaseToken",a.claimed_by as "claimedBy",a.sealed_digest as "sealedDigest",a.stage_operation_id as "stageOperationId",a.workflow_id as "workflowId",a.stage,a.decision,a.expires_at>clock_timestamp() and p.window_end>clock_timestamp() as current
  from crm_website_sales_ops_allocations a join crm_website_sales_ops_portfolios p on p.workspace_id=a.workspace_id and p.id=a.portfolio_id
  where a.workspace_id=$1 and a.id=$2 and a.project_id=$3 and a.company_id=$4 and a.location_id=$5 for update of a`,[session.workspaceId,proof.allocationId,scope.projectId,scope.companyId,scope.locationId]);
 if(!row||row.leaseToken!==proof.leaseToken||row.claimedBy!==session.userId||row.sealedDigest!==digest||row.stageOperationId!==raw.idempotencyKey)deny("SALES_ALLOCATION_BINDING_DENIED");
 const effect=await tx.queryOne<{commandId:string;version:number}>(`select command_id as "commandId",allocation_version as version from crm_website_sales_ops_effects where workspace_id=$1 and allocation_id=$2 and sealed_digest=$3 and idempotency_key=$4`,[session.workspaceId,row.id,digest,raw.idempotencyKey]);
 if(effect&&Number(effect.version)!==proof.version)deny("SALES_ALLOCATION_BINDING_DENIED");
 if(!effect&&(row.status!=="CLAIMED"||Number(row.version)!==proof.version||!row.current))deny("SALES_ALLOCATION_EXPIRED_OR_SETTLED");
 const assertCurrent=async()=>{
  if(effect)return;
  if(row.stage==="CONVERSATION"){
   const sourceId=row.decision.dialogSourceId;if(typeof sourceId!=="string")deny("ALLOCATION_DIALOG_SOURCE_DENIED");
   const {readCurrentSalesConversationTopic}=await import("./db/website-sales-conversation-source");
   const topic=await readCurrentSalesConversationTopic(tx,session,scope,sourceId);if(!topic||topic.sourceHash!==row.decision.dialogSourceHash)deny("ALLOCATION_DIALOG_SOURCE_CHANGED");
  }
  const current=await tx.queryOne<{allowed:boolean}>(`select a.status='CLAIMED' and a.version=$3 and a.lease_token=$4 and a.claimed_by=$5 and a.expires_at>clock_timestamp() and p.window_end>clock_timestamp() as allowed
   from crm_website_sales_ops_allocations a join crm_website_sales_ops_portfolios p on p.workspace_id=a.workspace_id and p.id=a.portfolio_id where a.workspace_id=$1 and a.id=$2`,[session.workspaceId,row.id,proof.version,proof.leaseToken,session.userId]);
  if(current?.allowed!==true)deny("SALES_ALLOCATION_EXPIRED_OR_SETTLED");
 };
 await assertCurrent();
 return{replayed:!!effect,assertCurrent,record:async(commandId:string)=>{
  await assertCurrent();if(effect){if(effect.commandId!==commandId)deny("SALES_ALLOCATION_EFFECT_CONFLICT");return;}
  await tx.execute(`insert into crm_website_sales_ops_effects(id,workspace_id,project_id,company_id,location_id,workflow_id,allocation_id,allocation_version,command_id,idempotency_key,sealed_digest,created_by)
   values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[randomUUID(),session.workspaceId,scope.projectId,scope.companyId,scope.locationId,row.workflowId,row.id,proof.version,commandId,raw.idempotencyKey,digest,session.userId]);
 }};
}
