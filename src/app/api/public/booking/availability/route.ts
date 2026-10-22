import { publicBookingAction, publicBookingOptions } from "../_http";
export async function POST(request:Request){return publicBookingAction(request,"availability");}
export const OPTIONS=publicBookingOptions;
