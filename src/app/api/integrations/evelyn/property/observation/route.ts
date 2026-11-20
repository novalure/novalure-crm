import { handlePropertyObservation } from "@/lib/crm-property-observation-handler";

export const runtime = "nodejs";

/** Closed unless a separately configured workload and exact stored grant exist. */
export async function POST(request: Request) {
  return handlePropertyObservation(request);
}
