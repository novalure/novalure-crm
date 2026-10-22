"use client";

import { useState } from "react";
import type { BookingPropertyLocation } from "@/lib/booking/property-locations";
import type { LanguageCode } from "@/lib/language-runtime";
import { csrfFetch } from "@/lib/security/csrf-client";

const field = "min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 focus:outline-2 focus:outline-offset-2 focus:outline-blue-600 disabled:bg-slate-100";
const secondary = "inline-flex min-h-11 items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-45 focus:outline-2 focus:outline-offset-2 focus:outline-blue-600";

export function BookingPropertySelector({ language, disabled, propertyId, selectedAddress, onSelect }: { language: LanguageCode; disabled: boolean; propertyId: string; selectedAddress: string; onSelect: (property: BookingPropertyLocation | null) => void }) {
  const de = language === "de";
  const [search, setSearch] = useState("");
  const [properties, setProperties] = useState<BookingPropertyLocation[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  async function load() {
    setLoading(true); setError("");
    try {
      const response = await csrfFetch(`/api/booking/property-locations?q=${encodeURIComponent(search.trim())}`, { cache: "no-store" });
      const result = await response.json() as { error?: string; properties?: BookingPropertyLocation[] };
      if (!response.ok) {
        setError(result.error === "PROPERTY_MODULE_REQUIRED" || result.error === "PROPERTY_LOCATION_FORBIDDEN" ? de ? "Die Objektauswahl benötigt ein freigegebenes Immobilienmodul und die passende Berechtigung." : "Property selection requires the enabled property module and appropriate permission." : de ? "Die Objektadressen konnten nicht geladen werden. Bitte erneut versuchen." : "Property addresses could not be loaded. Please try again.");
        return;
      }
      setProperties(result.properties ?? []);
    } catch { setError(de ? "Die Objektadressen konnten nicht geladen werden. Bitte erneut versuchen." : "Property addresses could not be loaded. Please try again."); }
    finally { setLoading(false); }
  }
  return <details className="rounded-lg border border-slate-200 bg-white p-3" open={propertyId ? true : undefined}>
    <summary className="cursor-pointer text-sm font-semibold">{de ? "Objektadresse aus dem CRM verwenden (optional)" : "Use a property address from CRM (optional)"}</summary>
    <p className="mt-2 text-xs text-slate-600">{de ? "Für Besichtigungen wird die freigegebene, gespeicherte Objektadresse verwendet und vor der Buchung erneut geprüft." : "Viewings use the authorized stored property address, which is checked again before booking."}</p>
    <div className="mt-3 grid items-end gap-2 sm:grid-cols-[1fr_auto]"><label className="grid gap-1 text-sm">{de ? "Objekt suchen (Titel oder Adresse)" : "Find property (title or address)"}<input className={field} value={search} maxLength={120} disabled={disabled || loading} onChange={event => setSearch(event.target.value)} /></label><button type="button" className={secondary} disabled={disabled || loading} onClick={() => void load()}>{loading ? de ? "Wird geladen …" : "Loading …" : de ? "Objekte laden" : "Load properties"}</button></div>
    {error ? <p role="alert" className="mt-3 text-sm text-red-800">{error}</p> : null}
    {properties !== null || propertyId ? <label className="mt-3 grid gap-1 text-sm">{de ? "Objekt für die Besichtigung" : "Property for the viewing"}<select className={field} disabled={disabled || loading} value={propertyId} onChange={event => { const selected = properties?.find(item => item.id === event.target.value); if (!event.target.value) onSelect(null); else if (selected) onSelect(selected); }}><option value="">{de ? "Manuell bestätigte Kundenadresse" : "Manually confirmed customer address"}</option>{propertyId && !properties?.some(item => item.id === propertyId) ? <option value={propertyId}>{de ? "Ausgewähltes Objekt" : "Selected property"} · {selectedAddress}</option> : null}{properties?.map(property => <option key={property.id} value={property.id}>{property.title} · {property.address}</option>)}</select></label> : null}
    {properties?.length === 0 ? <p role="status" className="mt-2 text-sm text-slate-600">{de ? "Keine passenden freigegebenen Objekte mit gültiger Adresse gefunden." : "No matching authorized properties with a valid address were found."}</p> : null}
  </details>;
}
