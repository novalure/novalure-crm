import type { PropertyReservation } from "@/lib/crm-types";

/** Terminal history must neither trigger nor hide the current deal's deadline warning. */
export function findOpenDealReservation(
  reservations: readonly PropertyReservation[], projectId: string, dealId: string, contactId?: string,
) {
  return reservations.find(item => item.projectId === projectId
    && ["requested", "hold", "reserved"].includes(item.status)
    && (item.dealId === dealId || (contactId !== undefined && item.contactId === contactId)));
}
