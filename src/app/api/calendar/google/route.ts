import { requirePermissionAndProductCapability } from "@/lib/auth/session";
// Unjournaled workspace-primary writes are retired. Existing booking services
// retain their own scoped operations; standalone events use the personal ledger.
export async function POST(request: Request) {
  const auth=await requirePermissionAndProductCapability(request,"calendar:sync","calendar:manage");
  if(!auth.ok)return auth.response;
  return Response.json({ok:false,status:"not_started",error:"personal_calendar_workflow_required"},
    {status:409,headers:{"cache-control":"private, no-store"}});
}
