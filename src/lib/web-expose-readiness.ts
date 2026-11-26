import type { CountryPublicationCheck } from "@/lib/property-country";

/** These checks describe readiness; publication must still enforce them on the server. */
export function webExposeLegalReadiness(input: { controller: string; privacyUrl: string; legalUrl: string }) {
  const secureUrl = (value: string) => {
    try {
      const url = new URL(value.trim());
      return url.protocol === "https:" && !url.username && !url.password ? url.toString() : "";
    } catch { return ""; }
  };
  const privacyUrl = secureUrl(input.privacyUrl);
  const legalUrl = secureUrl(input.legalUrl);
  const checks: CountryPublicationCheck[] = [
    { id: "EXPOSE-CONTROLLER", ruleVersion: "web-expose-1", status: input.controller.trim() ? "ready" : "missing", message: "Verantwortlichen Anbieter für die Veröffentlichung angeben.", source: "" },
    { id: "EXPOSE-PRIVACY", ruleVersion: "web-expose-1", status: privacyUrl ? "ready" : "missing", message: "Gültigen HTTPS-Link zu den Datenschutzhinweisen angeben.", source: "" },
    { id: "EXPOSE-LEGAL", ruleVersion: "web-expose-1", status: legalUrl ? "ready" : "missing", message: "Gültigen HTTPS-Link zu Impressum oder Anbieterinformationen angeben.", source: "" },
  ];
  return { privacyUrl, legalUrl, checks };
}
