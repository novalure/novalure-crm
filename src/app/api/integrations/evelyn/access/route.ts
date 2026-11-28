import { handleAutonomousCrmAccess } from "@/lib/crm-autonomous-access";
import { handleAutonomousCrmModules } from "@/lib/crm-autonomous-modules";
import { autonomousModuleContract,autonomousModuleMaximumBytes } from "@/lib/crm-autonomous-module-contract";
import { readKnowledgeJson } from "@/lib/knowledge-center/http";
import { handleAutonomousCrmNonexecution } from "@/lib/crm-autonomous-nonexecution";

export async function POST(request:Request){
  if(request.headers.has("x-evelyn-close-without-effect")||request.headers.has("x-evelyn-recovery"))return handleAutonomousCrmNonexecution(request);
  try{
    const body=await readKnowledgeJson(request.clone(),["contractVersion","operation","correlationId","idempotencyKey","expectedVersion","patch"],autonomousModuleMaximumBytes);
    return body.contractVersion===autonomousModuleContract?handleAutonomousCrmModules(request):handleAutonomousCrmAccess(request);
  }catch{return Response.json({code:"INVALID_REQUEST"},{status:400,headers:{"Cache-Control":"private, no-store"}});}
}
