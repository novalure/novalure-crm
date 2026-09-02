export type MatchingCriterion = Readonly<{
  actual: string;
  criterion: string;
  expected: string;
  hard: boolean;
  matched: boolean;
  reason: string;
  weight: number;
}>;

export type SearchProfileForMatching = Readonly<{
  accessibility: string | null;
  areaFromSqm: number | null;
  areaToSqm: number | null;
  budgetFromMinor: bigint | null;
  budgetToMinor: bigint | null;
  desiredLocation: string | null;
  equipment: readonly string[];
  exclusionCriteria: readonly string[];
  id: string;
  intentType: string;
  municipality: string | null;
  mustHaveCriteria: readonly string[];
  niceToHaveCriteria: readonly string[];
  objectType: string | null;
  postalCode: string | null;
  radiusKm: number | null;
  region: string | null;
  roomsFrom: number | null;
  roomsTo: number | null;
  subObjectType: string | null;
  targetYieldBasisPoints: number | null;
  yearBuiltFrom: number | null;
  yearBuiltTo: number | null;
}>;

export type MatchCandidate = Readonly<{
  accessibility: boolean | null;
  areaSqm: number | null;
  availability: "available" | "reserved_same" | "reserved_other" | "blocked" | "sold";
  equipment: readonly string[];
  id: string;
  intentType: string | null;
  municipality: string | null;
  objectType: string | null;
  postalCode: string | null;
  priceMinor: bigint | null;
  region: string | null;
  rooms: number | null;
  searchableText: string;
  subObjectType: string | null;
  targetKind: "listing" | "unit";
  yieldBasisPoints: number | null;
  yearBuilt: number | null;
}>;

export type MatchEvaluation = Readonly<{
  availability: MatchCandidate["availability"];
  eligible: boolean;
  matchedCriteria: readonly MatchingCriterion[];
  score: number;
  targetId: string;
  targetKind: MatchCandidate["targetKind"];
  violatedCriteria: readonly MatchingCriterion[];
}>;

const weights = Object.freeze({
  accessibility: 5,
  area: 12,
  equipment: 8,
  intent: 8,
  location: 18,
  objectType: 10,
  price: 20,
  rooms: 8,
  subObjectType: 4,
  yield: 4,
  yearBuilt: 3,
});

export const brokerMatchingAlgorithmVersion = "broker-match-v2";

function normalize(value: string | null | undefined) {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

function inRange(value: number | bigint | null, from: number | bigint | null, to: number | bigint | null) {
  if (value === null) return false;
  if (from !== null && value < from) return false;
  if (to !== null && value > to) return false;
  return true;
}

function addCriterion(
  rows: MatchingCriterion[],
  input: Omit<MatchingCriterion, "matched"> & { matched: boolean },
) {
  rows.push(Object.freeze(input));
}

function intentMatches(expected: string, actual: string | null) {
  const normalizedExpected = normalize(expected);
  const normalizedActual = normalize(actual);
  if (!normalizedActual) return false;
  if (["purchase", "sale", "buy"].includes(normalizedExpected)) {
    return ["purchase", "sale", "buy", "sale or rent", "sale and rent"].includes(normalizedActual);
  }
  if (["rent", "lease"].includes(normalizedExpected)) {
    return ["rent", "lease", "sale or rent", "sale and rent"].includes(normalizedActual);
  }
  return normalizedActual === normalizedExpected;
}

export function evaluateBrokerMatch(profile: SearchProfileForMatching, candidate: MatchCandidate): MatchEvaluation {
  const criteria: MatchingCriterion[] = [];

  if (profile.intentType) {
    addCriterion(criteria, {
      actual: candidate.intentType ?? "unknown",
      criterion: "intent",
      expected: profile.intentType,
      hard: false,
      matched: intentMatches(profile.intentType, candidate.intentType),
      reason: candidate.intentType
        ? "Marketing intent was compared with the search profile."
        : "Marketing intent is missing on the listing.",
      weight: weights.intent,
    });
  }
  if (profile.objectType) {
    addCriterion(criteria, {
      actual: candidate.objectType ?? "unknown",
      criterion: "object_type",
      expected: profile.objectType,
      hard: false,
      matched: normalize(candidate.objectType) === normalize(profile.objectType),
      reason: "Object type matches.",
      weight: weights.objectType,
    });
  }
  if (profile.subObjectType) {
    addCriterion(criteria, {
      actual: candidate.subObjectType ?? "unknown",
      criterion: "sub_object_type",
      expected: profile.subObjectType,
      hard: false,
      matched: normalize(candidate.subObjectType) === normalize(profile.subObjectType),
      reason: "Sub-object type matches.",
      weight: weights.subObjectType,
    });
  }
  if (profile.budgetFromMinor !== null || profile.budgetToMinor !== null) {
    addCriterion(criteria, {
      actual: candidate.priceMinor?.toString() ?? "unknown",
      criterion: "price",
      expected: `${profile.budgetFromMinor?.toString() ?? "0"}-${profile.budgetToMinor?.toString() ?? "unbounded"}`,
      hard: false,
      matched: inRange(candidate.priceMinor, profile.budgetFromMinor, profile.budgetToMinor),
      reason: "Price is within the configured range.",
      weight: weights.price,
    });
  }
  if (profile.areaFromSqm !== null || profile.areaToSqm !== null) {
    addCriterion(criteria, {
      actual: candidate.areaSqm?.toString() ?? "unknown",
      criterion: "area",
      expected: `${profile.areaFromSqm ?? 0}-${profile.areaToSqm ?? "unbounded"}`,
      hard: false,
      matched: inRange(candidate.areaSqm, profile.areaFromSqm, profile.areaToSqm),
      reason: "Area is within the configured range.",
      weight: weights.area,
    });
  }
  if (profile.roomsFrom !== null || profile.roomsTo !== null) {
    addCriterion(criteria, {
      actual: candidate.rooms?.toString() ?? "unknown",
      criterion: "rooms",
      expected: `${profile.roomsFrom ?? 0}-${profile.roomsTo ?? "unbounded"}`,
      hard: false,
      matched: inRange(candidate.rooms, profile.roomsFrom, profile.roomsTo),
      reason: "Room count is within the configured range.",
      weight: weights.rooms,
    });
  }

  const expectedLocations = [profile.region, profile.municipality, profile.postalCode, profile.desiredLocation]
    .filter(Boolean)
    .map(normalize);
  if (expectedLocations.length > 0) {
    const actualLocations = [candidate.region, candidate.municipality, candidate.postalCode].filter(Boolean).map(normalize);
    const actualLocationText = actualLocations.join(" ");
    addCriterion(criteria, {
      actual: actualLocations.join(", ") || "unknown",
      criterion: "location",
      expected: expectedLocations.join(", "),
      hard: false,
      matched: expectedLocations.every((expected) => expected.split(" ").every((token) => actualLocationText.includes(token))),
      reason: "Configured region, municipality and postal code match.",
      weight: weights.location,
    });
  }
  if (profile.yearBuiltFrom !== null || profile.yearBuiltTo !== null) {
    addCriterion(criteria, {
      actual: candidate.yearBuilt?.toString() ?? "unknown",
      criterion: "year_built",
      expected: `${profile.yearBuiltFrom ?? 0}-${profile.yearBuiltTo ?? "unbounded"}`,
      hard: false,
      matched: inRange(candidate.yearBuilt, profile.yearBuiltFrom, profile.yearBuiltTo),
      reason: "Year built is within the configured range.",
      weight: weights.yearBuilt,
    });
  }
  if (profile.equipment.length > 0) {
    const actualEquipment = candidate.equipment.map(normalize);
    const missing = profile.equipment.filter((item) => !actualEquipment.includes(normalize(item)));
    addCriterion(criteria, {
      actual: candidate.equipment.join(", ") || "none",
      criterion: "equipment",
      expected: profile.equipment.join(", "),
      hard: true,
      matched: missing.length === 0,
      reason: missing.length === 0 ? "All required equipment is present." : `Missing equipment: ${missing.join(", ")}.`,
      weight: weights.equipment,
    });
  }
  if (profile.accessibility && profile.accessibility !== "none") {
    addCriterion(criteria, {
      actual: candidate.accessibility === null ? "unknown" : String(candidate.accessibility),
      criterion: "accessibility",
      expected: profile.accessibility,
      hard: profile.accessibility === "required",
      matched: candidate.accessibility === true,
      reason: candidate.accessibility === null
        ? "Accessibility is not documented on the listing."
        : "Accessibility was compared with the search profile.",
      weight: weights.accessibility,
    });
  }
  if (profile.targetYieldBasisPoints !== null) {
    addCriterion(criteria, {
      actual: candidate.yieldBasisPoints?.toString() ?? "unknown",
      criterion: "yield",
      expected: `>=${profile.targetYieldBasisPoints}`,
      hard: false,
      matched: candidate.yieldBasisPoints !== null && candidate.yieldBasisPoints >= profile.targetYieldBasisPoints,
      reason: "Yield meets the configured minimum.",
      weight: weights.yield,
    });
  }
  if (profile.radiusKm !== null && profile.radiusKm !== undefined) {
    addCriterion(criteria, {
      actual: "geocoded distance unavailable",
      criterion: "radius",
      expected: `<=${profile.radiusKm} km`,
      hard: true,
      matched: false,
      reason: "Radius matching is fail-closed until both profile and property have verified coordinates.",
      weight: 1,
    });
  }

  const haystack = normalize([
    candidate.objectType,
    candidate.subObjectType,
    candidate.region,
    candidate.municipality,
    candidate.postalCode,
    candidate.searchableText,
    ...candidate.equipment,
  ].filter(Boolean).join(" "));
  const exclusionHits = profile.exclusionCriteria.filter((item) => haystack.includes(normalize(item)));
  for (const requirement of profile.mustHaveCriteria ?? []) {
    const normalizedRequirement = normalize(requirement);
    const matched = Boolean(normalizedRequirement) && haystack.includes(normalizedRequirement);
    addCriterion(criteria, {
      actual: matched ? requirement : "not found",
      criterion: "must_have",
      expected: requirement,
      hard: true,
      matched,
      reason: matched
        ? `Required criterion is present: ${requirement}.`
        : `Required criterion is missing: ${requirement}.`,
      weight: 12,
    });
  }
  for (const preference of profile.niceToHaveCriteria ?? []) {
    const normalizedPreference = normalize(preference);
    const matched = Boolean(normalizedPreference) && haystack.includes(normalizedPreference);
    addCriterion(criteria, {
      actual: matched ? preference : "not found",
      criterion: "nice_to_have",
      expected: preference,
      hard: false,
      matched,
      reason: matched
        ? `Preferred criterion is present: ${preference}.`
        : `Preferred criterion is missing: ${preference}.`,
      weight: 3,
    });
  }
  for (const exclusion of exclusionHits) {
    addCriterion(criteria, {
      actual: exclusion,
      criterion: "exclusion",
      expected: "must not match",
      hard: true,
      matched: false,
      reason: `Exclusion criterion matched: ${exclusion}.`,
      weight: 100,
    });
  }

  const ordinaryCriteria = criteria.filter((criterion) => criterion.criterion !== "exclusion");
  const applicableWeight = ordinaryCriteria.reduce((sum, criterion) => sum + criterion.weight, 0);
  const matchedWeight = ordinaryCriteria.filter((criterion) => criterion.matched).reduce((sum, criterion) => sum + criterion.weight, 0);
  const score = exclusionHits.length > 0 ? 0 : applicableWeight === 0 ? 0 : Math.round((matchedWeight / applicableWeight) * 100);
  const hardFailure = criteria.some((criterion) => criterion.hard && !criterion.matched);
  const eligible = !hardFailure && ["available", "reserved_same"].includes(candidate.availability);

  return Object.freeze({
    availability: candidate.availability,
    eligible,
    matchedCriteria: criteria.filter((criterion) => criterion.matched),
    score,
    targetId: candidate.id,
    targetKind: candidate.targetKind,
    violatedCriteria: criteria.filter((criterion) => !criterion.matched),
  });
}
