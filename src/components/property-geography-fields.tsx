"use client";

import { createPropertyGeography, propertyCountries, propertyCountryDefaults, type PropertyGeography } from "@/lib/property-country";

type Props = { geography: PropertyGeography | null; region: string; language: string; disabled?: boolean; onChange: (geography: PropertyGeography) => void };
const inputClass = "mt-1 min-h-11 min-w-0 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-slate-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700";
export function PropertyGeographyFields({ geography, region, language, disabled, onChange }: Props) {
  const de = language === "de";
  const update = (patch: Partial<PropertyGeography>) => { if (geography) onChange({ ...geography, ...patch, source: "explicit" }); };
  return <fieldset disabled={disabled} className="mt-4 min-w-0 rounded-xl border border-slate-200 p-4">
    <legend className="px-1 font-semibold text-slate-950">{de ? "Objektland und Darstellung" : "Property country and presentation"}</legend>
    <div className="grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <label className="text-sm font-medium text-slate-700">{de ? "Objektland *" : "Property country *"}
        <select className={inputClass} name="propertyCountry" required value={geography?.countryCode ?? ""} onChange={(event) => {
          const country = propertyCountries.find((item) => item === event.target.value);
          if (country) onChange(createPropertyGeography(country, geography?.countryCode === country || !geography ? region : ""));
        }}>
          <option value="" disabled>{de ? "Land auswählen" : "Choose country"}</option>
          {propertyCountries.map((country) => <option key={country} value={country}>{country} · {propertyCountryDefaults[country].name}</option>)}
        </select>
      </label>
      <label className="text-sm font-medium text-slate-700">{geography ? propertyCountryDefaults[geography.countryCode].regionLabel : (de ? "Region" : "Region")}
        <input className={inputClass} name="propertyRegion" maxLength={200} value={region} disabled={!geography} onChange={(event) => update({ region: event.target.value })} />
      </label>
      <label className="text-sm font-medium text-slate-700">{de ? "Sprache des Inhalts" : "Content language"}
        <select className={inputClass} name="propertyContentLanguage" value={geography?.contentLanguage ?? ""} disabled={!geography} onChange={(event) => update({ contentLanguage: event.target.value as PropertyGeography["contentLanguage"] })}>
          {!geography ? <option value="">—</option> : null}<option value="de">Deutsch</option><option value="en">English</option><option value="es">Español</option>
        </select>
      </label>
      <label className="text-sm font-medium text-slate-700">{de ? "Zahlen- und Datumsformat" : "Number and date format"}
        <select className={inputClass} name="propertyDisplayLocale" value={geography?.displayLocale ?? ""} disabled={!geography} onChange={(event) => update({ displayLocale: event.target.value as PropertyGeography["displayLocale"] })}>
          {!geography ? <option value="">—</option> : null}{["de-AT", "de-DE", "es-ES", "en-IE", "de", "en", "es"].map((locale) => <option key={locale}>{locale}</option>)}
        </select>
      </label>
      <label className="text-sm font-medium text-slate-700">{de ? "Terminzeitzone" : "Booking timezone"}
        <select className={inputClass} name="propertyBookingTimezone" value={geography?.bookingTimezone ?? ""} disabled={!geography} onChange={(event) => update({ bookingTimezone: event.target.value })}>
          {!geography ? <option value="">—</option> : null}
          {geography && !["Europe/Vienna", "Europe/Berlin", "Europe/Madrid", "Atlantic/Canary", "Europe/Dublin", "UTC"].includes(geography.bookingTimezone) ? <option>{geography.bookingTimezone}</option> : null}
          {["Europe/Vienna", "Europe/Berlin", "Europe/Madrid", "Atlantic/Canary", "Europe/Dublin", "UTC"].map((zone) => <option key={zone}>{zone}</option>)}
        </select>
      </label>
      <label className="text-sm font-medium text-slate-700">{de ? "Währung" : "Currency"}<input className={inputClass} value="EUR" readOnly /></label>
    </div>
    <p className="mt-3 text-sm text-slate-600">{de ? "Das Objektland bestimmt die Länderprüfung. Sprache und Zahlenformat ändern es nicht. Beim Länderwechsel werden Region und Energieangaben im Entwurf geleert; bitte anhand des passenden Ausweises neu erfassen." : "The property country determines country checks. Language and number formatting do not change it. Changing country clears the region and certificate fields in the draft; enter them again from the correct certificate."}</p>
    {geography?.source === "legacy_at_region" ? <p role="status" className="mt-2 text-sm text-amber-900">{de ? "Österreich wurde aus dem vorhandenen österreichischen Bundesland abgeleitet. Bitte bei der nächsten Speicherung bestätigen." : "Austria was inferred from the existing Austrian region. Confirm it on the next save."}</p> : null}
  </fieldset>;
}
