import { getPublicBookingPublication } from "@/lib/booking/publication";
import { publicBookingFailure, publicBookingJson } from "../_http";
export async function GET(request:Request,context:{params:Promise<{publicId:string}>}){try{return publicBookingJson(request,await getPublicBookingPublication((await context.params).publicId));}catch(error){return publicBookingFailure(request,error);}}
