import {publicWebExposePdfResponse} from '@/lib/web-expose-pdf';

export const runtime='nodejs';
export const maxDuration=60;
export async function GET(_request:Request,context:{params:Promise<{token:string}>}){
 const {token}=await context.params;
 return publicWebExposePdfResponse(token);
}
