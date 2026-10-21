import type { LanguageCode } from "@/lib/i18n";

type LocalizedLabel = { de: string; en: string; es: string };
type KnowledgeField = {
  key: string;
  label: LocalizedLabel;
  multiline?: boolean;
};
export type KnowledgeTemplate = {
  id: string;
  label: LocalizedLabel;
  fields: KnowledgeField[];
  dynamicCrm?: boolean;
};
export type StructuredKnowledgeRow = {
  id: string;
  key: string;
  value: string;
  originalKey?: string;
  originalValue?: string | number | boolean | null;
  custom?: boolean;
};

const field = (
  key: string,
  de: string,
  en: string,
  es: string,
  multiline = false,
): KnowledgeField => ({
  key,
  label: { de, en, es },
  ...(multiline ? { multiline } : {}),
});
const companyName = field(
  "companyName",
  "Unternehmensname",
  "Company name",
  "Nombre de la empresa",
);
const description = field(
  "description",
  "Beschreibung",
  "Description",
  "Descripción",
  true,
);
const address = field(
  "address",
  "Anschrift / Standort",
  "Address / location",
  "Dirección / ubicación",
  true,
);
const email = field("email", "E-Mail", "Email", "Correo electrónico");
const phone = field("phone", "Telefon", "Phone", "Teléfono");
const crmProject = field(
  "crmProjectReference",
  "Zugehöriges CRM-Projekt",
  "Related CRM project",
  "Proyecto CRM relacionado",
);
const floorArea = field(
  "floorArea",
  "Fläche mit Einheit",
  "Floor area including unit",
  "Superficie con unidad",
);
const rooms = field("rooms", "Zimmer", "Rooms", "Habitaciones");
const equipment = field(
  "equipment",
  "Ausstattung",
  "Equipment & amenities",
  "Equipamiento",
  true,
);
const energy = field(
  "energyInformation",
  "Energieinformationen",
  "Energy information",
  "Información energética",
  true,
);
const price = field(
  "priceInformation",
  "Preisinformation und Gültigkeit",
  "Price information and validity",
  "Información de precios y vigencia",
  true,
);
const availability = field(
  "availabilityInformation",
  "Verfügbarkeit und Stand der Prüfung",
  "Availability and date checked",
  "Disponibilidad y fecha de verificación",
  true,
);

/** Blank field metadata only; never seeds customer records or business values. */
export const knowledgeTemplates: readonly KnowledgeTemplate[] = [
  {
    id: "company",
    label: { de: "Unternehmen", en: "Company", es: "Empresa" },
    fields: [
      companyName,
      field("industry", "Branche", "Industry", "Sector"),
      description,
      field("website", "Website", "Website", "Sitio web"),
    ],
  },
  {
    id: "contact",
    label: { de: "Kontakt", en: "Contact", es: "Contacto" },
    fields: [
      companyName,
      field(
        "contactName",
        "Ansprechperson",
        "Contact person",
        "Persona de contacto",
      ),
      email,
      phone,
      address,
    ],
  },
  {
    id: "opening_hours",
    label: { de: "Öffnungszeiten", en: "Opening hours", es: "Horarios" },
    fields: [
      field("monday", "Montag", "Monday", "Lunes"),
      field("tuesday", "Dienstag", "Tuesday", "Martes"),
      field("wednesday", "Mittwoch", "Wednesday", "Miércoles"),
      field("thursday", "Donnerstag", "Thursday", "Jueves"),
      field("friday", "Freitag", "Friday", "Viernes"),
      field("saturday", "Samstag", "Saturday", "Sábado"),
      field("sunday", "Sonntag", "Sunday", "Domingo"),
      field(
        "holidayRules",
        "Feiertage und Ausnahmen",
        "Holidays and exceptions",
        "Festivos y excepciones",
        true,
      ),
      field("timezone", "Zeitzone", "Time zone", "Zona horaria"),
    ],
  },
  {
    id: "services",
    label: {
      de: "Leistungen & Terminregeln",
      en: "Services & booking rules",
      es: "Servicios y reservas",
    },
    fields: [
      field("serviceName", "Leistung", "Service", "Servicio"),
      description,
      field(
        "serviceScope",
        "Leistungsumfang",
        "Scope of service",
        "Alcance del servicio",
        true,
      ),
      field(
        "pricingNotes",
        "Preishinweise und Gültigkeit",
        "Pricing notes and validity",
        "Notas de precios y vigencia",
        true,
      ),
      field(
        "bookingRules",
        "Termin- und Buchungsregeln",
        "Appointment and booking rules",
        "Reglas de citas y reservas",
        true,
      ),
    ],
  },
  {
    id: "developer_project",
    label: {
      de: "Bauträger: Bauprojekt",
      en: "Developer: construction project",
      es: "Promotor: proyecto de construcción",
    },
    fields: [
      crmProject,
      field(
        "projectName",
        "Projektname",
        "Project name",
        "Nombre del proyecto",
      ),
      address,
      description,
      field(
        "constructionSpecification",
        "Baubeschreibung",
        "Construction specification",
        "Memoria de construcción",
        true,
      ),
      equipment,
      energy,
      field(
        "salesContact",
        "Vertriebskontakt",
        "Sales contact",
        "Contacto comercial",
      ),
    ],
  },
  {
    id: "developer_unit",
    label: {
      de: "Bauträger: Wohnung / Einheit",
      en: "Developer: apartment / unit",
      es: "Promotor: vivienda / unidad",
    },
    dynamicCrm: true,
    fields: [
      crmProject,
      field(
        "crmUnitReference",
        "Zugehörige CRM-Einheit",
        "Related CRM unit",
        "Unidad CRM relacionada",
      ),
      description,
      field("floor", "Geschoss", "Floor", "Planta"),
      floorArea,
      rooms,
      field(
        "floorPlanReference",
        "Grundriss / Dokumentverweis",
        "Floor plan / document reference",
        "Plano / referencia de documento",
      ),
      equipment,
      energy,
      price,
      availability,
    ],
  },
  {
    id: "broker_listing",
    label: {
      de: "Makler: Immobilienangebot",
      en: "Broker: property listing",
      es: "Agente: oferta inmobiliaria",
    },
    dynamicCrm: true,
    fields: [
      field(
        "crmListingReference",
        "Zugehöriges CRM-Objekt",
        "Related CRM property",
        "Inmueble CRM relacionado",
      ),
      field(
        "propertyType",
        "Immobilienart",
        "Property type",
        "Tipo de inmueble",
      ),
      address,
      description,
      floorArea,
      rooms,
      equipment,
      energy,
      price,
      field(
        "rentalInformation",
        "Mietinformationen und Gültigkeit",
        "Rental information and validity",
        "Información de alquiler y vigencia",
        true,
      ),
      availability,
      field(
        "viewingInstructions",
        "Besichtigungshinweise",
        "Viewing instructions",
        "Indicaciones para visitas",
        true,
      ),
      field(
        "marketingDocuments",
        "Vermarktungsunterlagen / Dokumentverweise",
        "Marketing documents / references",
        "Documentos comerciales / referencias",
        true,
      ),
    ],
  },
];

const reservedKeys = new Set(["__proto__", "prototype", "constructor"]);
const isEditableValue = (
  value: unknown,
): value is string | number | boolean | null =>
  value === null || ["string", "number", "boolean"].includes(typeof value);
export const knowledgeLabel = (
  label: LocalizedLabel,
  language: LanguageCode | "es",
) => label[language];
export function knowledgeField(key: string) {
  return knowledgeTemplates
    .flatMap((template) => template.fields)
    .find((item) => item.key === key);
}
export function knowledgeFieldLabel(
  key: string,
  language: LanguageCode | "es",
) {
  return (
    knowledgeField(key)?.label[language] ??
    key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ")
  );
}

export function createStructuredKnowledgeRows(
  data: Record<string, unknown>,
): StructuredKnowledgeRow[] {
  return Object.entries(data)
    .filter(([key, value]) => !reservedKeys.has(key) && isEditableValue(value))
    .map(([key, value]) => ({
      id: `saved:${key}`,
      key,
      value: value === null ? "" : String(value),
      originalKey: key,
      originalValue: value as string | number | boolean | null,
      custom: !knowledgeField(key),
    }));
}

export function addKnowledgeTemplateFields(
  rows: StructuredKnowledgeRow[],
  data: Record<string, unknown>,
  templateId: string,
): StructuredKnowledgeRow[] {
  const template = knowledgeTemplates.find((item) => item.id === templateId);
  const keys = new Set([...rows.map((row) => row.key), ...Object.keys(data)]);
  return [
    ...rows,
    ...(template?.fields
      .filter((item) => !keys.has(item.key))
      .map((item) => ({
        id: `template:${item.key}`,
        key: item.key,
        value: "",
      })) ?? []),
  ];
}

/** Retains unedited scalar types and all unknown/nested values; removal is explicit. */
export function serializeStructuredKnowledge(
  data: Record<string, unknown>,
  rows: StructuredKnowledgeRow[],
  removedKeys: string[] = [],
): Record<string, unknown> {
  const entries = new Map(Object.entries(data));
  removedKeys.forEach((key) => entries.delete(key));
  const keys = new Set<string>();
  for (const row of rows) {
    const key = row.key.trim();
    if (
      (!key && row.value.trim()) ||
      key.length > 160 ||
      reservedKeys.has(key) ||
      (key && keys.has(key)) ||
      (Object.hasOwn(data, key) &&
        row.originalKey !== key &&
        !removedKeys.includes(key))
    )
      throw new Error("INVALID_FIELD");
    if (!key) continue;
    keys.add(key);
    if (row.originalKey && row.originalKey !== key)
      entries.delete(row.originalKey);
    const unchanged =
      row.originalKey === key &&
      row.value ===
        (row.originalValue === null ? "" : String(row.originalValue));
    if (unchanged) entries.set(key, row.originalValue);
    else if (row.value.trim()) entries.set(key, row.value.trim());
    else entries.delete(key);
  }
  return Object.fromEntries(entries);
}

export function structuredKnowledgeSummary(
  value: unknown,
  language: LanguageCode | "es",
  depth = 0,
): string {
  if (value === null || value === undefined) return "—";
  if (depth >= 4 && typeof value === "object") return "…";
  if (Array.isArray(value))
    return value
      .slice(0, 30)
      .map((item) => structuredKnowledgeSummary(item, language, depth + 1))
      .join(" · ");
  if (typeof value === "object")
    return Object.entries(value)
      .slice(0, 30)
      .map(
        ([key, item]) =>
          `${knowledgeFieldLabel(key, language)}: ${structuredKnowledgeSummary(item, language, depth + 1)}`,
      )
      .join(" · ");
  return String(value).slice(0, 2000);
}
