import {handleNewsletterCron} from '@/lib/newsletter-scheduler';
export const runtime='nodejs';
export const maxDuration=300;
export async function GET(request:Request){return handleNewsletterCron(request);}
