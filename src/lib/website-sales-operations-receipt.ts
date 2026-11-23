/** Execution acknowledgements carry the persisted effect IDs. Large fresh history is fetched separately.
 * Keep the stored canonical receipt and reconciliation projection unchanged. */
export function compactWebsiteSalesOperationsReceipt<T extends { data: unknown }>(result: T, keepCurrentData = false) {
  if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) throw Error("INVALID_OPERATIONS_EFFECT");
  const receipt = { ...result } as T & { currentData?: unknown }; if (!keepCurrentData) delete receipt.currentData;
  const data = { ...result.data } as Record<string, unknown>; delete data.plan;
  return { ...receipt, data };
}
