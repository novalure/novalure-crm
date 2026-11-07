import type { Metadata } from "next";
import { lookupPublicCustomerRequest } from "@/lib/lead-customer-request-repository";
import { CustomerRequestForm } from "@/components/customer-request-form";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const metadata:Metadata={title:"Kundenformular · Novalure",robots:{index:false,follow:false,noarchive:true},referrer:"no-referrer"};
export default async function CustomerRequestPage({params}:{params:Promise<{token:string}>}){
 const {token}=await params;let info:Awaited<ReturnType<typeof lookupPublicCustomerRequest>>=null;
 try{info=await lookupPublicCustomerRequest(token);}catch{/* Invalid or unavailable capabilities show the same neutral page. */}
 if(!info)return <main className="mx-auto max-w-xl px-6 py-16"><h1 className="text-2xl font-semibold">Link nicht verfügbar · Link unavailable · Enlace no disponible</h1><p className="mt-5 text-stone-600">Bitte wenden Sie sich an Ihren Ansprechpartner. / Please contact your adviser. / Póngase en contacto con su asesor.</p></main>;
 // Only blank-form configuration crosses the client boundary. Existing lead data and internal identifiers do not.
 return <CustomerRequestForm token={token} purpose={info.purpose} language={info.language} controller={info.controller} privacyUrl={info.privacyUrl} submitted={info.submitted}/>;
}
