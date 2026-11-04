import { readAiCreditSnapshot, requestAiBooking } from "@/lib/ai-billing/repository";
import { aiBillingErrorResponse, aiBillingJson, readAiBookingRequest, requireAiBillingSession } from "@/lib/ai-billing/http";
import { CrmCommandError } from "@/lib/crm-command";

export async function GET(request: Request) {
  try {
    const auth = await requireAiBillingSession(request, "crm:read");
    if (!auth.ok) return auth.response;
    return aiBillingJson(await readAiCreditSnapshot(auth.session));
  } catch (error) { return aiBillingErrorResponse(error); }
}

/** Records a reviewable booking request. It does not charge or activate a plan. */
export async function POST(request: Request) {
  try {
    const auth = await requireAiBillingSession(request, "crm:read");
    if (!auth.ok) return auth.response;
    const input = await readAiBookingRequest(request);
    if (input.kind !== "website" && !auth.session.permissions.includes("settings:manage")) {
      throw new CrmCommandError("AI_BILLING_FORBIDDEN", "Only the company owner can request AI packages", 403);
    }
    return aiBillingJson(await requestAiBooking(auth.session, input), 201);
  } catch (error) { return aiBillingErrorResponse(error); }
}
