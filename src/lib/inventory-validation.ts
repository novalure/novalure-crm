export type InventoryOperation = "building" | "unit";

export type InventoryValidationField =
  | "areaSqm"
  | "buildingId"
  | "floor"
  | "floors"
  | "name"
  | "priceEuros"
  | "projectId"
  | "rooms"
  | "unitNumber";

export type InventoryValidationCode =
  | "area_invalid"
  | "building_invalid"
  | "floor_invalid"
  | "floors_invalid"
  | "name_required"
  | "name_too_long"
  | "price_invalid"
  | "project_invalid"
  | "project_required"
  | "rooms_invalid"
  | "unit_number_required"
  | "unit_number_too_long";

export type InventoryValidationError = {
  code: InventoryValidationCode;
  field: InventoryValidationField;
};

type InventoryValidationInput = Partial<Record<InventoryValidationField, unknown>>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function parseOptionalNumber(value: unknown) {
  if (value == null) return null;
  if (typeof value === "string" && cleanString(value) === "") return null;
  const parsed = typeof value === "number" ? value : Number(cleanString(value).replace(",", "."));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function parseEuroAmountToCents(value: unknown) {
  const euros = parseOptionalNumber(value);
  if (euros === null || !Number.isFinite(euros) || euros < 0) return null;

  const rawCents = euros * 100;
  const cents = Math.round(rawCents);
  if (!Number.isSafeInteger(cents) || Math.abs(rawCents - cents) > 1e-7) return null;
  return cents;
}

function numberError(
  input: InventoryValidationInput,
  field: Extract<InventoryValidationField, "areaSqm" | "floor" | "floors" | "rooms">,
  code: Extract<InventoryValidationCode, "area_invalid" | "floor_invalid" | "floors_invalid" | "price_invalid" | "rooms_invalid">,
  options: { integer?: boolean; max: number; min: number },
): InventoryValidationError | null {
  const parsed = parseOptionalNumber(input[field]);
  if (parsed === null) return null;
  if (
    !Number.isFinite(parsed) ||
    parsed < options.min ||
    parsed > options.max ||
    (options.integer && !Number.isInteger(parsed))
  ) {
    return { code, field };
  }
  return null;
}

export function validateInventoryInput(
  operation: InventoryOperation,
  input: InventoryValidationInput,
  options: { requireUuidIds?: boolean } = {},
): InventoryValidationError[] {
  const errors: InventoryValidationError[] = [];
  const projectId = cleanString(input.projectId);

  if (!projectId) {
    errors.push({ code: "project_required", field: "projectId" });
  } else if (options.requireUuidIds && !uuidPattern.test(projectId)) {
    errors.push({ code: "project_invalid", field: "projectId" });
  }

  if (operation === "building") {
    const name = cleanString(input.name);
    if (!name) errors.push({ code: "name_required", field: "name" });
    if (name.length > 160) errors.push({ code: "name_too_long", field: "name" });
    const floorsError = numberError(input, "floors", "floors_invalid", {
      integer: true,
      max: 300,
      min: 0,
    });
    if (floorsError) errors.push(floorsError);
    return errors;
  }

  const unitNumber = cleanString(input.unitNumber);
  if (!unitNumber) errors.push({ code: "unit_number_required", field: "unitNumber" });
  if (unitNumber.length > 80) errors.push({ code: "unit_number_too_long", field: "unitNumber" });

  const buildingId = cleanString(input.buildingId);
  if (
    (input.buildingId != null && typeof input.buildingId !== "string") ||
    (buildingId && options.requireUuidIds && !uuidPattern.test(buildingId))
  ) {
    errors.push({ code: "building_invalid", field: "buildingId" });
  }

  const numericErrors = [
    numberError(input, "floor", "floor_invalid", { integer: true, max: 300, min: -20 }),
    numberError(input, "rooms", "rooms_invalid", { max: 100, min: 0 }),
    numberError(input, "areaSqm", "area_invalid", { max: 1_000_000, min: 0 }),
  ];
  for (const error of numericErrors) {
    if (error) errors.push(error);
  }

  const rawPrice = parseOptionalNumber(input.priceEuros);
  if (
    rawPrice !== null &&
    (
      !Number.isFinite(rawPrice) ||
      rawPrice > 500_000_000 ||
      parseEuroAmountToCents(input.priceEuros) === null
    )
  ) {
    errors.push({ code: "price_invalid", field: "priceEuros" });
  }

  return errors;
}

const messages: Record<"de" | "en", Record<InventoryValidationCode, string>> = {
  de: {
    area_invalid: "Die Fläche muss eine gültige Zahl zwischen 0 und 1.000.000 sein.",
    building_invalid: "Das ausgewählte Gebäude ist ungültig.",
    floor_invalid: "Das Stockwerk muss eine ganze Zahl zwischen -20 und 300 sein.",
    floors_invalid: "Die Anzahl der Stockwerke muss eine ganze Zahl zwischen 0 und 300 sein.",
    name_required: "Der Gebäudename ist erforderlich.",
    name_too_long: "Der Gebäudename darf höchstens 160 Zeichen enthalten.",
    price_invalid: "Der Preis muss ein EUR-Betrag zwischen 0 und 500.000.000 mit höchstens zwei Dezimalstellen sein.",
    project_invalid: "Das ausgewählte Projekt ist ungültig.",
    project_required: "Bitte wählen Sie ein Projekt aus.",
    rooms_invalid: "Die Zimmeranzahl muss eine gültige Zahl zwischen 0 und 100 sein.",
    unit_number_required: "Die Einheitsnummer ist erforderlich.",
    unit_number_too_long: "Die Einheitsnummer darf höchstens 80 Zeichen enthalten.",
  },
  en: {
    area_invalid: "Area must be a valid number between 0 and 1,000,000.",
    building_invalid: "The selected building is invalid.",
    floor_invalid: "Floor must be a whole number between -20 and 300.",
    floors_invalid: "Floors must be a whole number between 0 and 300.",
    name_required: "Building name is required.",
    name_too_long: "Building name must not exceed 160 characters.",
    price_invalid: "Price must be a EUR amount between 0 and 500,000,000 with no more than two decimal places.",
    project_invalid: "The selected project is invalid.",
    project_required: "Select a project.",
    rooms_invalid: "Rooms must be a valid number between 0 and 100.",
    unit_number_required: "Unit number is required.",
    unit_number_too_long: "Unit number must not exceed 80 characters.",
  },
};

export function getInventoryValidationMessage(
  code: InventoryValidationCode,
  language: "de" | "en",
) {
  return messages[language][code];
}
