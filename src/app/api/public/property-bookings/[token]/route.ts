import {getPublicPropertyBookingOffers} from '@/lib/property-booking-repository';
export const runtime='nodejs';
export async function GET(_request:Request,context:{params:Promise<{token:string}>}){
 const headers={'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow, noarchive'};
 try{return Response.json({offers:await getPublicPropertyBookingOffers((await context.params).token)},{headers});}catch{return Response.json({error:'temporarily_unavailable'},{status:503,headers});}
}
