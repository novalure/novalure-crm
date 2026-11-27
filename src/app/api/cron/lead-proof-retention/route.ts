import {handleProofRetentionCron} from '@/lib/lead-proof-retention-scheduler';
export const runtime='nodejs';
export const maxDuration=60;
export async function GET(request:Request){return handleProofRetentionCron(request);}
