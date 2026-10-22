import { startBookingChannelSession } from "@/lib/booking/channels";
import { publicBookingBody, publicBookingFailure, publicBookingJson, publicBookingOptions } from "../_http";
export async function POST(request:Request){try{return publicBookingJson(request,await startBookingChannelSession(request,await publicBookingBody(request)));}catch(error){return publicBookingFailure(request,error);}}
export const OPTIONS=publicBookingOptions;
