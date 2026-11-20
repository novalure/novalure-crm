import { qualifyWebsiteProspect } from "./website-prospect";

/** Eligibility for one individual clarification; this never changes acquisition, pricing or demo readiness. */
export function websiteSalesConversationReadiness(prospect: unknown, savedLocationVersion: number, currentLocationVersion: number, now: string) {
  const assessment = qualifyWebsiteProspect(prospect, now);
  if (savedLocationVersion !== currentLocationVersion) return { eligible: false, clarificationOnly: false };
  if (assessment.status === "READY") return { eligible: true, clarificationOnly: false };
  const input = assessment.input;
  const clarificationOnly = input.path === "PLATFORM_PRIMARY" && input.identityStatus === "VERIFIED" && input.need === "EVIDENCED" && input.bookingRoute === "UNKNOWN"
    && assessment.reasons.includes("BOOKING_ROUTE_UNCHECKED") && assessment.reasons.every(reason => reason === "BOOKING_ROUTE_UNCHECKED" || reason === "EVIDENCE_REQUIRED:BOOKING_ROUTE");
  return { eligible: clarificationOnly, clarificationOnly };
}
