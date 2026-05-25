export type PublicLegalLinkKey =
  | "imprint"
  | "privacy"
  | "cookies"
  | "terms"
  | "dataDeletion"
  | "meta";

export const companyLegalDetails = {
  businessName: "Novalure CLG",
  companyName: "Novalure CLG",
  companyNumber: "796735",
  email: "hello@novalure.eu",
  legalForm: "A company limited by guarantee incorporated under the laws of Ireland",
  phone: "+353 (0)89 269 5248",
  registeredOffice: "20 Harcourt Street, Dublin 2, D02 H364, Ireland",
  registeredPlace: "Dublin, Ireland",
  registeredWith: "Companies Registration Office (CRO), Ireland",
} as const;

export const publicSiteOrigin = "https://www.novalure-crm.app";

export const publicLegalLinks: { href: string; key: PublicLegalLinkKey }[] = [
  { href: "/imprint", key: "imprint" },
  { href: "/privacy", key: "privacy" },
  { href: "/cookies", key: "cookies" },
  { href: "/terms", key: "terms" },
  { href: "/data-deletion", key: "dataDeletion" },
  { href: "/meta", key: "meta" },
];
