import { getTrustedAppOrigin } from "@/lib/auth/app-origin";
import { bookingBootstrapRows } from "@/lib/booking/publication";
import { bookingBody } from "../../booking/_http";
import { dispatchBookingChannelAction, type BookingChannelAction } from "@/lib/booking/channels";
import { BookingError } from "@/lib/booking/types";
export { bookingBody as publicBookingBody };
export function publicBookingJson(request:Request,body:unknown,status=200){const origin=request.headers.get("origin");return Response.json(body,{status,headers:{"cache-control":"private, no-store","referrer-policy":"no-referrer","vary":"Origin",...(origin?{"access-control-allow-origin":origin}:{}),"access-control-allow-methods":"POST, OPTIONS","access-control-allow-headers":"authorization, content-type"}});}
export function publicBookingFailure(request:Request,error:unknown){return publicBookingJson(request,{error:error instanceof BookingError?error.code:"booking_unavailable"},error instanceof BookingError?error.status:503);}
export async function publicBookingAction(request:Request,action:BookingChannelAction){try{const auth=request.headers.get("authorization");if(!auth?.startsWith("Bearer "))throw new BookingError("BOOKING_SESSION_INVALID",401);return publicBookingJson(request,await dispatchBookingChannelAction(auth.slice(7),action,await bookingBody(request),request));}catch(error){return publicBookingFailure(request,error);}}
export async function publicBookingOptions(request:Request){
  const origin=request.headers.get("origin");if(!origin||origin.length>300)return new Response(null,{status:403});
  let allowed=origin===new URL(getTrustedAppOrigin()).origin;
  if(!allowed)try{allowed=(await bookingBootstrapRows<{allowed:boolean}>("select booking_channel_origin_allowed($1) as allowed",[origin]))[0]?.allowed===true;}catch{return new Response(null,{status:503});}
  if(!allowed)return new Response(null,{status:403});
  return new Response(null,{status:204,headers:{"cache-control":"no-store","vary":"Origin","access-control-allow-origin":origin,"access-control-allow-methods":"POST, OPTIONS","access-control-allow-headers":"authorization, content-type","access-control-max-age":"300"}});
}
