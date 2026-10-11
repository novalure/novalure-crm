/** Synthetic Website Sales submissions stay in operational records, but not business KPIs. */
export function isBusinessKpiRecord(record: { syntheticTest?: boolean }): boolean {
  return record.syntheticTest !== true;
}

/** Missing metadata remains eligible so historical and unrelated CRM records keep their counts. */
export const businessKpiSqlPredicate = "(metadata #>> '{websiteSales,syntheticTest}') is distinct from 'true'";
