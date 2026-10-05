export const CRM_DIVISIONS = ["REAL_ESTATE_GROWTH", "WEB_DESIGN"] as const;

export type CrmDivision = (typeof CRM_DIVISIONS)[number];

export function isCrmDivision(value: unknown): value is CrmDivision {
  return typeof value === "string" && CRM_DIVISIONS.includes(value as CrmDivision);
}

export function requireCrmDivision(value: unknown): CrmDivision {
  if (!isCrmDivision(value)) throw new Error("INVALID_CRM_DIVISION");
  return value;
}
