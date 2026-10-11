"use client";

import { useId } from "react";
import { parsePropertyEuroCents } from "@/lib/property-money";
import { calculatePurchaseAncillaryCents, DEFAULT_PURCHASE_ANCILLARY_RATE, parsePurchaseAncillaryRate } from "@/lib/property-purchase-costs";

export type PurchaseCostsPatch = { purchaseAncillaryMode?: "percentage" | "manual"; purchaseAncillaryRate?: string; purchaseAncillaryCosts?: string };
type Props = {
  language: string; price: string; marketingType: string; mode: "percentage" | "manual"; rate: string;
  manualAmount: string; disabled?: boolean; onChange: (patch: PurchaseCostsPatch) => void;
};
const inputClass = "mt-1 min-h-11 min-w-0 w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-slate-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700 disabled:cursor-not-allowed disabled:opacity-60";

export function PropertyPurchaseCostsInput({ language, price, marketingType, mode, rate, manualAmount, disabled, onChange }: Props) {
  const id = useId();
  const de = language === "de";
  const priceCents = parsePropertyEuroCents(price);
  const rateBps = parsePurchaseAncillaryRate(rate);
  const amount = mode === "percentage"
    ? priceCents !== null && rateBps !== null ? calculatePurchaseAncillaryCents(priceCents, rateBps) : null
    : parsePropertyEuroCents(manualAmount);
  const euro = (cents: number) => new Intl.NumberFormat(de ? "de-AT" : "en-GB", { style: "currency", currency: "EUR", minimumFractionDigits: 2 }).format(cents / 100);
  if (marketingType === "rent") return <p className="mt-4 text-sm text-stone-700" role="status">{de
    ? "Kaufnebenkosten sind bei reiner Vermietung nicht anwendbar. Es wird kein Prozentsatz auf die Miete berechnet."
    : "Purchase ancillary costs do not apply to rental-only properties. No percentage is applied to rent."}</p>;
  return <fieldset disabled={disabled} className="mt-4 min-w-0 rounded-xl border border-stone-200 bg-stone-50 p-4" aria-describedby={id + "-help"}>
    <legend className="px-1 text-base font-semibold text-slate-950">{de ? "Kaufnebenkosten · Österreich" : "Purchase ancillary costs · Austria"}</legend>
    <div className="grid min-w-0 gap-4 sm:grid-cols-2">
      <label className="min-w-0 text-sm font-medium text-stone-700">{de ? "Berechnung" : "Calculation"}
        <select className={inputClass} name="purchaseAncillaryMode" value={mode} onChange={(event) => onChange({ purchaseAncillaryMode: event.target.value as Props["mode"] })}>
          <option value="percentage">{de ? "Automatisch (%)" : "Automatic (%)"}</option>
          <option value="manual">{de ? "Manueller Betrag" : "Manual amount"}</option>
        </select>
      </label>
      {mode === "percentage" ? <label className="min-w-0 text-sm font-medium text-stone-700">{de ? "Prozentsatz vom Kaufpreis (%)" : "Percentage of purchase price (%)"}
        <input className={inputClass} name="purchaseAncillaryRate" type="text" inputMode="decimal" required pattern="(?:0|[1-9][0-9]?)(?:[.,][0-9]{1,2})?|100(?:[.,]0{1,2})?" maxLength={6} value={rate}
          aria-invalid={rateBps === null || undefined} aria-describedby={id + "-rate-help"}
          onChange={(event) => onChange({ purchaseAncillaryRate: event.target.value })} />
        <span id={id + "-rate-help"} className="mt-1 block text-xs">{de ? "0–100 %, maximal 2 Dezimalstellen. Standard: 4,6 %." : "0–100%, up to 2 decimals. Default: 4.6%."}</span>
      </label> : <label className="min-w-0 text-sm font-medium text-stone-700">{de ? "Kaufnebenkosten manuell (EUR)" : "Manual ancillary costs (EUR)"}
        <input className={inputClass} name="purchaseAncillaryCosts" type="text" inputMode="decimal" pattern="[0-9]+(?:[.,][0-9]{1,2})?" value={manualAmount}
          onChange={(event) => onChange({ purchaseAncillaryCosts: event.target.value })} />
      </label>}
    </div>
    <p className="mt-3 break-words text-sm text-stone-700">{de ? "Berechnungsbasis: aktueller Angebotspreis (Kauf), nicht Marktwert oder öffentlicher Preis. Änderungen werden erst mit dem Objekt gespeichert." : "Calculation basis: current asking purchase price, not market valuation or public price. Changes are stored when you save the property."}</p>
    <output className="mt-2 block break-words text-lg font-semibold text-slate-950" aria-live="polite" aria-atomic="true" aria-label={de ? "Kaufnebenkosten Ergebnis" : "Ancillary costs result"}>
      {amount === null ? (de ? "— Bitte gültigen Kaufpreis und Prozentsatz bzw. Betrag eingeben." : "— Enter a valid purchase price and percentage or amount.") : euro(amount)}
    </output>
    {mode === "percentage" ? <button type="button" className="mt-3 min-h-11 rounded-full border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
      onClick={() => onChange({ purchaseAncillaryRate: DEFAULT_PURCHASE_ANCILLARY_RATE })}>{de ? "Standard 4,6 % einsetzen" : "Use default 4.6%"}</button> : null}
    <p id={id + "-help"} className="mt-3 break-words text-sm leading-6 text-stone-700">{de
      ? "Standardfall entgeltlicher Kauf in Österreich: 3,5 % Grunderwerbsteuer + 1,1 % Eigentumseintragung = 4,6 %. Nur diese Basis wird vorbelegt, keine vollständige Nebenkostensumme. Makler, Vertrag, Beglaubigung, Eingabengebühr und Finanzierung sind nicht enthalten. Pfandrechte haben eine andere Bemessungsgrundlage. Sonderfälle, andere Länder und Befreiungen bitte fachlich prüfen; keine automatische Befreiung. Ein geänderter Prozentsatz ist deine individuelle Kalkulation, kein gesetzlicher Pauschalsatz. Einzelpositionen werden nicht zusätzlich in diesen Betrag eingerechnet."
      : "Standard paid purchase in Austria: 3.5% transfer tax + 1.1% ownership registration = 4.6%. This is a preset base, not all ancillary costs. Brokerage, contracts, certification, filing and finance costs are excluded. Liens use a different assessment basis. Obtain advice for exceptions, other countries and exemptions; exemptions are not applied automatically. An edited rate is your own estimate, not a statutory flat rate. Individual cost items are not added to this amount."}</p>
    <a className="mt-2 inline-flex min-h-11 items-center text-sm font-medium text-slate-800 underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2" href="https://www.oesterreich.gv.at/de/lebenslagen/Ich-will-ein-neues-Zuhause-erwerben/eine-wohnung-kaufen" target="_blank" rel="noreferrer">{de ? "Amtliche Grundlage · geprüft 10.09.2026 (neuer Tab)" : "Official source · checked 10 Sep 2026 (new tab)"}</a>
  </fieldset>;
}
