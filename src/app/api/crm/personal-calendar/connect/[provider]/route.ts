import { NextResponse } from "next/server";
import { resolveWorkspaceScopedSession } from "@/lib/auth/session";
import { getTrustedAppOrigin } from "@/lib/auth/app-origin";
import { bookingFailure, bookingJson } from "@/app/api/booking/_http";
import { BookingConnectionError, bookingMicrosoftAuthority, createBookingOAuthState } from "@/lib/booking/connections";
import { getOAuthAuthorizationUrl } from "@/lib/integrations/calendar-connections";
import { withBookingTransaction } from "@/lib/booking/repository";
export async function GET(request:Request,context:{params:Promise<{provider:string}>}) {
  const auth=await resolveWorkspaceScopedSession(request,{permission:"crm:write",capability:"calendar:manage"});
  if(!auth.ok)return auth.response;
  const {provider}=await context.params;
  if(provider!=="google"&&provider!=="microsoft")return bookingJson({error:"calendar_provider_invalid"},400);
  try{
    await withBookingTransaction(auth.session,async()=>undefined);
    const {state,codeChallenge}=await createBookingOAuthState({workspaceId:auth.session.workspaceId,actorId:auth.session.userId},provider,true);
    const origin=getTrustedAppOrigin();
    return NextResponse.redirect(getOAuthAuthorizationUrl({provider,state,codeChallenge,requestUrl:origin,trustedOrigin:origin,...(provider==="microsoft"?{microsoftAuthority:bookingMicrosoftAuthority()}:{})}));
  }catch(error){return error instanceof BookingConnectionError?bookingJson({error:error.code},error.status):bookingFailure(error);}
}
