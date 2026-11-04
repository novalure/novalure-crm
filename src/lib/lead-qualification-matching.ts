/** Explainable property fit only; no personal, demographic or creditworthiness score. */
import {leadObjectiveFeatureLabels,leadPurchaseWindowExpired,type LeadFeatureRules,type LeadObjectiveFeature,type LeadPurchaseWindow} from './lead-qualification-plan';
export const leadMatchAlgorithmVersion = "property-fit-2";
export type LeadMatchProfile = { countryCode: string; location: string; propertyType: string; budgetFromCents: number; budgetToCents: number; areaSqm: number | null; rooms: number | null; useCase: "Eigennutzung" | "Anlage" | null; manualCriteria?: string[];purchaseWindow?:LeadPurchaseWindow|null;featureRules?:LeadFeatureRules;requirementsReviewed?:boolean };
export type LeadMatchProperty = { id: string; title: string; countryCode: string; region: string; city: string; propertyType: string; priceCents: number | null; areaSqm: number | null; rooms: number | null; marketingType: string; usageType: string; available: boolean;features?:Partial<Record<LeadObjectiveFeature,boolean|null>> };
export type LeadMatchReason = { criterion: string; result: "match" | "mismatch" | "unknown" | "not_requested"; points: number; possible: number; explanation: string };
export type LeadMatchResult = { score: number; coverage: number; eligible: boolean; reasons: LeadMatchReason[] };
const folded = (value: string) => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim().toLocaleLowerCase();
export function evaluateLeadPropertyMatch(profile: LeadMatchProfile, property: LeadMatchProperty): LeadMatchResult {
  const reasons: LeadMatchReason[] = [];
  const add = (criterion: string, result: LeadMatchReason["result"], possible: number, explanation: string) => reasons.push({ criterion, result, points: result === "match" ? possible : 0, possible: result === "not_requested" ? 0 : possible, explanation });
  const budgetValid = Number.isSafeInteger(profile.budgetFromCents) && Number.isSafeInteger(profile.budgetToCents) && profile.budgetFromCents >= 0 && profile.budgetToCents > 0 && profile.budgetFromCents <= profile.budgetToCents;
  const country = !!profile.countryCode && !!property.countryCode && profile.countryCode === property.countryCode;
  add("country", !profile.countryCode || !property.countryCode ? "unknown" : country ? "match" : "mismatch", 10, country ? "Land stimmt überein." : "Land fehlt oder stimmt nicht überein.");
  add("budget", !budgetValid || property.priceCents === null || property.priceCents <= 0 ? "unknown" : property.priceCents >= profile.budgetFromCents && property.priceCents <= profile.budgetToCents ? "match" : "mismatch", 30, "Gespeicherter Kaufpreis im angegebenen Budget; Miete wird nicht mit Kaufbudget verglichen.");
  add("property_type", !profile.propertyType || !property.propertyType ? "unknown" : folded(profile.propertyType) === folded(property.propertyType) ? "match" : "mismatch", 25, "Objektart wird exakt verglichen.");
  const locations = profile.location.split(",").map(folded).filter(Boolean), locationMatch = locations.some((location) => [property.region, property.city].map(folded).includes(location));
  add("location", !locations.length || (!property.region && !property.city) ? "unknown" : locationMatch ? "match" : "mismatch", 15, "Gewünschte Orte/Regionen werden nach normalisierter Schreibweise exakt verglichen; keine erfundenen Entfernungen.");
  add("area", !profile.areaSqm ? "not_requested" : !property.areaSqm ? "unknown" : property.areaSqm >= profile.areaSqm ? "match" : "mismatch", 10, "Gespeicherte Fläche mindestens so groß wie gewünscht.");
  add("rooms", !profile.rooms ? "not_requested" : !property.rooms ? "unknown" : property.rooms >= profile.rooms ? "match" : "mismatch", 10, "Zimmerzahl mindestens so groß wie gewünscht.");
  for(const[feature,rule]of Object.entries(profile.featureRules??{}) as[LeadObjectiveFeature,'must'|'exclude'][]){const actual=property.features?.[feature],matches=actual===(rule==='must');add(`feature_${feature}`,actual===null||actual===undefined?'unknown':matches?'match':'mismatch',10,`${leadObjectiveFeatureLabels[feature]}: ${rule==='must'?'muss vorhanden sein':'muss ausgeschlossen sein'}. ${actual===undefined||actual===null?'Quelldaten fehlen; keine Annahme aus einem Standardwert.':actual?'Im Objekt ausdrücklich vorhanden.':'Im Objekt ausdrücklich nicht vorhanden.'}`);}
  const possible = reasons.reduce((sum, reason) => sum + reason.possible, 0), points = reasons.reduce((sum, reason) => sum + reason.points, 0), known = reasons.filter((reason) => reason.result !== "unknown").reduce((sum, reason) => sum + reason.possible, 0);
  const score = possible ? Math.round(points * 100 / possible) : 0, coverage = possible ? Math.round(known * 100 / possible) : 0;
  const coreMatches = reasons.filter((reason) => ["country", "budget", "property_type", "location"].includes(reason.criterion)).every((reason) => reason.result === "match");
  const available = property.available && ["sale", "sale_or_rent"].includes(property.marketingType);
  const manualReview = !!profile.manualCriteria?.length;
  const hardFeatures=reasons.filter(reason=>reason.criterion.startsWith('feature_')).every(reason=>reason.result==='match');
  const expired=leadPurchaseWindowExpired(profile);
  if(profile.purchaseWindow)add('purchase_window',expired?'mismatch':'not_requested',0,expired?'Das Kaufzeitfenster ist abgelaufen; erneut abstimmen.':`Geplanter Kaufabschluss ${profile.purchaseWindow.from} bis ${profile.purchaseWindow.to}. Übergabe und konkrete Verfügbarkeit gesondert prüfen.`);
  if (manualReview) add("manual_criteria", "unknown", 0, `Freitext-Musskriterien manuell prüfen: ${profile.manualCriteria!.join("; ")}`);
  if (!available) add("availability", "mismatch", 0, "Objekt ist nicht für einen verfügbaren Kauf vorgemerkt.");
  if (profile.useCase) add("use", "not_requested", 0, `Gewünschte Nutzung: ${profile.useCase}. Die baurechtliche Zulässigkeit wird durch diesen Vorschlag nicht bestätigt.`);
  return { score, coverage, eligible: available && coreMatches && hardFeatures && !expired && !manualReview && coverage >= 80 && score >= 80, reasons };
}
