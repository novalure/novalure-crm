import { handleAutonomousCrmAccess } from "@/lib/crm-autonomous-access";
import { handleAutonomousCrmModules } from "@/lib/crm-autonomous-modules";
import { autonomousModuleContract,autonomousModuleMaximumBytes } from "@/lib/crm-autonomous-module-contract";
import { readKnowledgeJson } from "@/lib/knowledge-center/http";

export async function POST(request:Request){
  try{
    const body=await readKnowledgeJson(request.clone(),["contractVersion","operation","correlationId","idempotencyKey","expectedVersion","patch"],autonomousModuleMaximumBytes);
    return body.contractVersion===autonomousModuleContract?handleAutonomousCrmModules(request):handleAutonomousCrmAccess(request);
  }catch{return Response.json({code:"INVALID_REQUEST"},{status:400,headers:{"Cache-Control":"private, no-store"}});}
}
