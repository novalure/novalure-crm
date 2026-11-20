import {ZodError} from "zod";
import {CrmCommandError,crmCommandErrorResponse,crmRequestMetadata} from "./crm-command";
import {KnowledgeCenterError} from "./knowledge-center/policy";
import {readKnowledgeJson} from "./knowledge-center/http";
import {WebsiteSalesOperationsError} from "./website-sales-operations-contracts";
import {parseSalesOperationsCommand} from "./db/website-sales-operations-repositories";
export async function salesOperationsBody(request:Request){
 const body=await readKnowledgeJson(request,["contractVersion","operation","projectId","companyId","locationId","expectedVersion","idempotencyKey","correlationId","payload","allocationProof"],131072);
 const meta=crmRequestMetadata(request,body);if(body.idempotencyKey!==meta.idempotencyKey||body.correlationId!==meta.correlationId)throw new CrmCommandError("METADATA_MISMATCH","Exact original metadata required");
 return parseSalesOperationsCommand(body);
}
export function salesOperationsError(error:unknown){
 if(error instanceof KnowledgeCenterError)return Response.json({code:error.code},{status:error.status,headers:{"Cache-Control":"private, no-store"}});
 return crmCommandErrorResponse(error instanceof ZodError?new CrmCommandError("INVALID_OPERATIONS_PAYLOAD","Invalid operations payload",400):error instanceof WebsiteSalesOperationsError?new CrmCommandError(error.code,error.code,409):error);
}
