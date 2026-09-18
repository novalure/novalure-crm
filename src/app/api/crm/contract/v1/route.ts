import { handleCrmContractRequest } from "@/lib/crm-service-contract";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) { return handleCrmContractRequest(request); }
