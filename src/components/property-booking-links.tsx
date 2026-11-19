"use client";
import {useEffect,useState} from 'react';
import type {PropertyBookingPublicOffer} from '@/lib/property-booking';
export function PropertyBookingLinks({token,language}:{token:string;language:'de'|'en'|'es'}){
 const [offers,setOffers]=useState<PropertyBookingPublicOffer[]>([]);
 useEffect(()=>{let cancelled=false;void fetch(`/api/public/property-bookings/${encodeURIComponent(token)}`,{cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer'}).then(async response=>{if(!response.ok)return;const data=await response.json();if(!cancelled&&Array.isArray(data.offers))setOffers(data.offers);}).catch(()=>undefined);return()=>{cancelled=true;};},[token]);
 if(!offers.length)return null;const label=language==='de'?'Besichtigung anfragen':language==='es'?'Solicitar visita':'Request a viewing';
 return <section aria-label={label} className="space-y-3 rounded-2xl border border-stone-200 bg-white p-5"><h2 className="text-xl font-semibold">{label}</h2><p className="text-sm text-stone-600">{language==='de'?'Freigegebene Einheiten auswählen. Die Anfrage wird vor der fachlichen Terminbestätigung persönlich geprüft.':language==='es'?'Seleccione una unidad disponible. Un asesor revisará la solicitud antes de confirmar la visita.':'Choose an offered unit. An adviser reviews the request before confirming the viewing.'}</p><div className="flex flex-wrap gap-3">{offers.map(offer=><a key={offer.offerId} href={`${offer.path}&lang=${language}`} rel="noreferrer" className="inline-flex min-h-12 items-center rounded-xl bg-slate-950 px-5 py-3 text-sm font-medium text-white">{label} · {offer.unitNumber}</a>)}</div></section>;
}
