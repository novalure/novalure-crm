function hasProfileFields(profile: unknown) {
  // Missing profiles are persisted as {} by the lead writer, not as null.
  return profile !== null && typeof profile === "object" && !Array.isArray(profile) && Object.keys(profile).length > 0;
}

/** Preserve seller-first legacy profile routing without treating empty JSON defaults as a profile. */
export function brokerEntityKindForLead(lead: { type?: unknown; sellerProfile?: unknown; buyerProfile?: unknown }): "seller" | "buyer" | null {
  const type = String(lead.type ?? "").normalize("NFC").toLowerCase().replaceAll("ä", "ae");
  if (hasProfileFields(lead.sellerProfile) || type.includes("verk") || type.includes("seller")) return "seller";
  if (hasProfileFields(lead.buyerProfile) || type.includes("kaeu") || type.includes("kauf") || type.includes("buyer")) return "buyer";
  return null;
}
