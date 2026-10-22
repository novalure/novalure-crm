import { publicBookingAction, publicBookingOptions } from "../_http";
export async function POST(request:Request){return publicBookingAction(request,"status");}
export const OPTIONS=publicBookingOptions;
