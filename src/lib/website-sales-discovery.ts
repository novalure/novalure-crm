import { z } from "zod";

export const websiteSalesDiscoveryContract = "website-sales-discovery-v1" as const;
const text = z.string().trim().min(1).max(1000).refine(value => !/[\p{Cc}\p{Cf}]/u.test(value));
const sourceUrl = z.url().max(2048).refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash
    && ![...url.searchParams.keys()].some(key => /token|secret|password|auth|session|signature|api.?key/i.test(key));
});
export const websiteSalesDiscoveryCandidateSchema = z.strictObject({
  candidateId: z.uuid(), countryCode: z.literal("IE"), companyName: text.max(240), locationLabel: text,
  address: text.min(5), domain: z.string().trim().toLowerCase().max(253).refine(value => {
    try { const url = new URL(`https://${value}`); return url.hostname === value && value.includes(".") && !url.port && url.pathname === "/" && !url.search && !url.hash && !url.username; } catch { return false; }
  }).nullable(),
  sourceReferences: z.array(z.strictObject({ sourceId: text.max(100), sourceUrl, contentDigest: z.hash("sha256"), quote: text.max(1000),
    observedAt: z.iso.datetime({ offset: true }), validUntil: z.iso.datetime({ offset: true }) })).min(1).max(12),
  contacts: z.array(z.strictObject({ name: text.max(240), email: z.email().trim().toLowerCase().max(254),
    phone: text.max(60).nullable().optional(), sourceReferenceId: text.max(100) })).max(4),
}).superRefine((value, ctx) => {
  const ids = new Set(value.sourceReferences.map(source => source.sourceId));
  if (ids.size !== value.sourceReferences.length) ctx.addIssue({ code: "custom", message: "Duplicate source IDs" });
  if (!value.sourceReferences.some(source => [value.companyName, value.address, value.locationLabel].every(field => source.quote.includes(field))))
    ctx.addIssue({ code: "custom", message: "Identity facts require one exact source excerpt" });
  if (value.domain && !value.sourceReferences.some(source => source.quote.toLowerCase().includes(value.domain!)))
    ctx.addIssue({ code: "custom", message: "Domain requires a public source excerpt" });
  for (const contact of value.contacts) {
    const source = value.sourceReferences.find(item => item.sourceId === contact.sourceReferenceId);
    if (!source || !source.quote.includes(contact.name) || !source.quote.toLowerCase().includes(contact.email) || contact.phone && !source.quote.includes(contact.phone))
      ctx.addIssue({ code: "custom", message: "Contact requires its own public source excerpt" });
  }
});
export function normalizeDiscoveryText(value: string): string { return value.normalize("NFKC").toLocaleLowerCase("en-IE").replace(/[^\p{L}\p{N}]+/gu, " ").trim(); }
export function normalizeDiscoveryAddress(value: string): string { return value.normalize("NFKC").toLocaleLowerCase("en-IE").replace(/\s+/g, " ").trim(); }
export type WebsiteSalesDiscoveryCandidate = z.infer<typeof websiteSalesDiscoveryCandidateSchema>;
export type WebsiteSalesDiscoveryIdentity = { workspaceId: string; projectId: string; companyId: string; locationId: string };
export type WebsiteSalesDiscoveryMatch = {
  contractVersion: typeof websiteSalesDiscoveryContract; workspaceId: string; projectId: string; candidateDigest: string; matchDigest: string;
  status: "MATCH" | "AMBIGUOUS" | "NEW"; reasons: string[];
  companies: { companyId: string; name: string; version: number; reasons: string[] }[];
  locations: { companyId: string; locationId: string; address: string; version: number }[];
  contacts: { companyId: string | null; contactId: string; name: string; email: string | null; version: number }[];
  existingLeads: { leadId: string; contactId: string; status: string; source: string }[];
  identity: WebsiteSalesDiscoveryIdentity | null; contactId: string | null; canContact: false;
};
export const websiteSalesDiscoveryDecisionSchema = z.strictObject({ companyId: z.uuid().nullable(), locationId: z.uuid().nullable(),
  contactId: z.uuid().nullable(), createCompany: z.boolean(), createContact: z.boolean(), reviewed: z.boolean(), reason: text.min(10) });
export const websiteSalesDiscoveryMatchRequestSchema = z.strictObject({ contractVersion: z.literal(websiteSalesDiscoveryContract),
  operation: z.literal("match"), projectId: z.uuid(), candidate: websiteSalesDiscoveryCandidateSchema });
export const websiteSalesDiscoveryRegisterSchema = z.strictObject({ contractVersion: z.literal(websiteSalesDiscoveryContract),
  operation: z.enum(["register", "reconcile"]), projectId: z.uuid(), candidate: websiteSalesDiscoveryCandidateSchema,
  expectedMatchDigest: z.hash("sha256"), decision: websiteSalesDiscoveryDecisionSchema,
  idempotencyKey: z.uuidv4(), correlationId: z.uuid() });
export type WebsiteSalesDiscoveryRegister = z.infer<typeof websiteSalesDiscoveryRegisterSchema>;
export type WebsiteSalesDiscoveryReceipt = {
  candidateDigest: string; identity: WebsiteSalesDiscoveryIdentity; contactId: string | null; locationVersion: number;
  candidate: WebsiteSalesDiscoveryCandidate; decision: z.infer<typeof websiteSalesDiscoveryDecisionSchema>;
  existingLeads: WebsiteSalesDiscoveryMatch["existingLeads"]; canContact: false;
};
