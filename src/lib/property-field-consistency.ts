import type { PropertyDraft } from "./property-draft-store";
import { parsePropertyEuroCents } from "./property-money";

type CoreField = "postalCode" | "region" | "areaSqm" | "rooms" | "yearBuilt" | "objectType" | "subObjectType" | "availableFromText" | "price" | "rentPrice";
type FieldBinding = { core: CoreField; aliases: readonly string[]; numeric?: boolean; money?: boolean };

// Storage keys are deliberately independent of translated labels. Keep both
// historical umlaut slugs and the aliases understood by the repository.
const bindings: readonly FieldBinding[] = [
  { core: "postalCode", aliases: ["location.plz"] },
  { core: "region", aliases: ["location.bundesland"] },
  { core: "areaSqm", aliases: ["areas.wohnfl_che", "areas.wohnflaeche"], numeric: true },
  { core: "rooms", aliases: ["rooms.zimmer"], numeric: true },
  { core: "yearBuilt", aliases: ["construction.baujahr"], numeric: true },
  { core: "objectType", aliases: ["classification.objektart"] },
  { core: "subObjectType", aliases: ["classification.unterobjektart"] },
  // The legacy detail was free text (e.g. "nach Vereinbarung"), not a date.
  // Keep it linked to the free-text availability rather than coercing it.
  { core: "availableFromText", aliases: ["construction.beziehbar_ab"] },
  { core: "price", aliases: ["costs.kaufpreis"], money: true },
  { core: "rentPrice", aliases: ["costs.mietpreis_brutto"], money: true },
];
const streetAliases = ["location.stra_e", "location.strasse"];

export function propertyDetailFieldKey(sectionId: string, stableLabel: string) {
  return `${sectionId}.${stableLabel.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}

export function getPropertyDetailBinding(sectionId: string, stableLabel: string) {
  const key = propertyDetailFieldKey(sectionId, stableLabel);
  return bindings.find((binding) => binding.aliases.includes(key));
}

function firstValue(values: Array<string | undefined>) {
  return values.find((value) => value?.trim()) ?? "";
}

function inputSafeDecimalEuro(value: string) {
  const cents = parsePropertyEuroCents(value);
  // Preserve invalid/negative inputs for validation; never mask them as zero.
  if (cents === null) return value;
  const whole = BigInt(cents) / BigInt(100);
  const fraction = BigInt(cents) % BigInt(100);
  return fraction === BigInt(0) ? String(whole) : `${whole}.${String(fraction).padStart(2, "0")}`;
}

function selectedBindingValue(draft: PropertyDraft, binding: FieldBinding) {
  return firstValue([draft[binding.core], ...binding.aliases.map((key) => draft.fieldValues[key])]);
}

export function getPropertyCoreFieldValue(draft: PropertyDraft, core: CoreField): string {
  const binding = bindings.find((item) => item.core === core)!;
  const value = selectedBindingValue(draft, binding);
  if (binding.money) {
    // Keep controlled primary inputs untouched while typing (e.g. "1.", "1.0").
    // Only legacy fallback values need conversion to a native-input spelling.
    return draft[core]?.trim() ? draft[core] : inputSafeDecimalEuro(value);
  }
  // Native number inputs require a decimal point even when a legacy draft used
  // a German decimal comma. This changes spelling, never monetary units.
  if (!binding.numeric || !/^\+?(?:\d+(?:[.,]\d+)?|[.,]\d+)$/.test(value.trim())) return value;
  const decimal = value.trim().replace(/^\+/, "").replace(",", ".");
  return decimal.startsWith(".") ? `0${decimal}` : decimal;
}

export function getPropertyDetailFieldValue(draft: PropertyDraft, sectionId: string, stableLabel: string): string {
  const binding = getPropertyDetailBinding(sectionId, stableLabel);
  if (binding) return getPropertyCoreFieldValue(draft, binding.core);
  const key = propertyDetailFieldKey(sectionId, stableLabel);
  return streetAliases.includes(key)
    ? firstValue(streetAliases.map((alias) => draft.fieldValues[alias]))
    : draft.fieldValues[key] ?? "";
}

function setAliases(fields: Record<string, string>, aliases: readonly string[], value: string) {
  return { ...fields, ...Object.fromEntries(aliases.map((key) => [key, value])) };
}

export function updatePropertyDraftField<Key extends keyof PropertyDraft>(draft: PropertyDraft, key: Key, value: PropertyDraft[Key]): PropertyDraft {
  const binding = bindings.find((item) => item.core === key);
  return {
    ...draft,
    [key]: value,
    // Explicitly clearing a core value must clear its old aliases too, so a
    // stale legacy value cannot reappear through the fallback on the next render.
    ...(binding && typeof value === "string" ? { fieldValues: setAliases(draft.fieldValues, binding.aliases, value) } : {}),
  };
}

export function updatePropertyDetailField(draft: PropertyDraft, sectionId: string, stableLabel: string, value: string): PropertyDraft {
  const binding = getPropertyDetailBinding(sectionId, stableLabel);
  if (binding) return updatePropertyDraftField(draft, binding.core, value);
  const key = propertyDetailFieldKey(sectionId, stableLabel);
  return { ...draft, fieldValues: setAliases(draft.fieldValues, streetAliases.includes(key) ? streetAliases : [key], value) };
}

function comparisonValue(value: string, numeric?: boolean, money?: boolean) {
  const trimmed = value.trim();
  if (money) {
    const cents = parsePropertyEuroCents(value);
    return cents === null ? `invalid:${trimmed}` : `cents:${cents}`;
  }
  // Compare decimal spellings only. Do not guess EUR/cents, percentages or
  // thousands separators, and leave actual numeric validation to the parser.
  if (numeric && /^\+?(?:\d+(?:[.,]\d+)?|[.,]\d+)$/.test(trimmed)) {
    const [whole, fraction = ""] = trimmed.replace(/^\+/, "").replace(",", ".").split(".");
    const integerPart = whole.replace(/^0+/, "") || "0";
    const decimalPart = fraction.replace(/0+$/, "");
    return `${integerPart}${decimalPart ? `.${decimalPart}` : ""}`;
  }
  return trimmed;
}

export type PropertyFieldConflict = { fieldKey: string; value: string; alternatives: string[] };

export function getPropertyFieldConflicts(draft: PropertyDraft): PropertyFieldConflict[] {
  const groups = [
    ...bindings.map((binding) => ({ aliases: binding.aliases, numeric: binding.numeric, money: binding.money, values: [draft[binding.core], ...binding.aliases.map((key) => draft.fieldValues[key])] })),
    { aliases: streetAliases, numeric: false, money: false, values: streetAliases.map((key) => draft.fieldValues[key]) },
  ];
  return groups.flatMap(({ aliases, numeric, money, values }) => {
    const value = firstValue(values);
    const alternatives = [...new Set(values.filter((item): item is string => Boolean(item?.trim()) && comparisonValue(item!, numeric, money) !== comparisonValue(value, numeric, money)))];
    return alternatives.length ? [{ fieldKey: aliases[0], value, alternatives }] : [];
  });
}

/** Build the create payload without replacing the in-memory draft snapshot.
 * Legacy-only values remain visible and are promoted into their canonical core
 * fields. Conflicting values require an explicit choice in the form first. */
export function normalizePropertyDraftFields(draft: PropertyDraft): PropertyDraft {
  if (getPropertyFieldConflicts(draft).length) throw new Error("Property field conflicts must be resolved before saving");
  const next = { ...draft, fieldValues: { ...draft.fieldValues } };
  for (const binding of bindings) {
    const value = binding.money ? inputSafeDecimalEuro(selectedBindingValue(draft, binding)) : getPropertyCoreFieldValue(draft, binding.core);
    next[binding.core] = value;
    next.fieldValues = setAliases(next.fieldValues, binding.aliases, value);
  }
  // A structured street is not a full address. Never split or overwrite the
  // user's full address, city, house number or distinct usable/total areas.
  if (streetAliases.some((key) => Object.hasOwn(draft.fieldValues, key))) {
    next.fieldValues = setAliases(next.fieldValues, streetAliases, firstValue(streetAliases.map((key) => draft.fieldValues[key])));
  }
  return next;
}

export function getPropertyFieldConsistencyCopy(language: string) {
  return language === "de" ? {
    linkedHint: "Verknüpfte Werte werden oben in den Stammdaten gepflegt und hier nur angezeigt. Ändere sie dort; es gibt nur einen gespeicherten Wert.",
    linked: "Mit Stammdaten verknüpft",
    addressHint: "Die vollständige Adresse oben ist die maßgebliche Anzeigeadresse. Straße, Hausnummer und Ort in den Details sind ergänzende strukturierte Angaben; sie werden nicht automatisch aus der Adresse abgeleitet.",
    postalCode: "Postleitzahl",
    region: "Bundesland / Region",
    missing: "Noch nicht angegeben",
    conflict: "Abweichender älterer Detailwert:",
    resolve: "Angezeigten Wert übernehmen",
    conflictNotice: "Bitte löse zuerst die abweichenden Werte unter Recht, Datenschutz & Detailfelder. Du kannst den Stammdatenwert ändern oder ausdrücklich übernehmen; es wird nichts still überschrieben.",
    supplemental: "Zusatzangabe",
    costHint: "Ergänzende Vertragsangaben, z. B. Berechnungsgrundlage oder Prozentsatz. Die gespeicherten Netto-, Umsatzsteuer- und Bruttobeträge werden oben unter Preise / Kosten gepflegt; diese Zusatzangabe wird nicht als Betrag verrechnet.",
  } : {
    linkedHint: "Linked values are edited in the core fields above and are shown here for reference. Edit them there; only one value is saved.",
    linked: "Linked to core fields",
    addressHint: "The full address above is the authoritative display address. Street, house number and city in the details are additional structured information; they are not automatically derived from it.",
    postalCode: "Postal code",
    region: "Federal state / region",
    missing: "Not provided yet",
    conflict: "Different older detail value:",
    resolve: "Use the displayed value",
    conflictNotice: "Resolve the differing values in the additional property details first. Edit the core value or explicitly accept it; nothing is silently overwritten.",
    supplemental: "Additional information",
    costHint: "Additional contract information, such as a calculation basis or percentage. Saved net, VAT and gross amounts are maintained under Prices / Costs above; this information is not calculated as an amount.",
  };
}

export function isSupplementalPropertyCostField(sectionId: string, stableLabel: string) {
  return (sectionId === "costs" && ["Betriebskosten", "Heizkosten", "Sonstige Kosten", "Kaution", "Provision Miete", "Provision Kauf", "Grunderwerbsteuer", "Grundbucheintragung", "Vertragserrichtung", "Vergebührung"].includes(stableLabel)) ||
    (sectionId === "investment" && stableLabel === "Reparaturrücklage");
}
