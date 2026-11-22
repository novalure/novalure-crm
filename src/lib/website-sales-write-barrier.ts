"use client";
type Area = "workflow" | "studio" | "lifecycle" | "autonomy" | "conversation" | "enablement";
const prefixes = { workflow: "novalure.website-sales.pending.v1", studio: "novalure.website-studio.pending.v1", lifecycle: "novalure.website-sales-lifecycle.pending.v1", autonomy: "novalure.website-sales-operations.pending.v1", conversation: "novalure.website-sales-conversation.pending.v1", enablement:'novalure.website-sales-enablement.pending.v1' } as const;
/** One unresolved Sales write blocks new writes in the other Sales areas. */
export function assertSalesWriteBarrier(area: Area, workspaceId: string, actorId: string): void {
  if (typeof window === "undefined") throw Error("SALES_RECOVERY_STORAGE_UNAVAILABLE");
  for (const other of Object.keys(prefixes) as Area[]) {
    if (other !== area && window.sessionStorage.getItem(`${prefixes[other]}:${actorId}:${workspaceId}`) !== null)
      throw Error("SALES_OTHER_WRITE_RECONCILIATION_REQUIRED");
  }
}
