import { handleCrmQaWriteContract } from '@/lib/crm-qa-write-contract';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function POST(request:Request){return handleCrmQaWriteContract(request);}
